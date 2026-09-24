import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let db: PGlite;

async function asRole<T>(
  role: "anon" | "authenticated" | "service_role",
  action: () => Promise<T>,
) {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await action();
  } finally {
    await db.exec("RESET ROLE");
  }
}

beforeAll(async () => {
  db = await PGlite.create("memory://");
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${owner}');
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    CREATE SCHEMA conuo_private;
    GRANT USAGE ON SCHEMA conuo_private TO anon,authenticated,service_role;
  `);
  const migration = await readFile(
    new URL(
      "../../../../../supabase/migrations/20260924000200_ai_request_traces.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await db.exec(migration);
});

beforeEach(async () => {
  await db.exec("DELETE FROM conuo_private.ai_request_traces");
  await db.query("INSERT INTO auth.users(id) VALUES ($1) ON CONFLICT DO NOTHING", [owner]);
});

afterAll(async () => {
  if (db && !db.closed) await db.close();
});

describe("AI trace SQL boundary", () => {
  it("allows only service_role to record traces", async () => {
    await expect(
      asRole("authenticated", () =>
        db.query("SELECT public.record_ai_trace($1::uuid,$2::jsonb)", [
          owner,
          JSON.stringify({ route: "ask" }),
        ]),
      ),
    ).rejects.toBeTruthy();
    await asRole("service_role", () =>
      db.query("SELECT public.record_ai_trace($1::uuid,$2::jsonb)", [
        owner,
        JSON.stringify({ route: "ask", outcome: "completed", metrics: {} }),
      ]),
    );
    expect(
      (await db.query("SELECT count(*)::int AS count FROM conuo_private.ai_request_traces"))
        .rows[0],
    ).toEqual({ count: 1 });
  });

  it("deletes rows older than thirty days on the next write", async () => {
    await asRole("service_role", () =>
      db.query("SELECT public.record_ai_trace($1::uuid,$2::jsonb)", [
        owner,
        JSON.stringify({ route: "ask", outcome: "completed", metrics: {} }),
      ]),
    );
    await db.exec(
      "UPDATE conuo_private.ai_request_traces SET created_at = now() - interval '31 days'",
    );
    await asRole("service_role", () =>
      db.query("SELECT public.record_ai_trace($1::uuid,$2::jsonb)", [
        owner,
        JSON.stringify({ route: "ask", outcome: "completed", metrics: {} }),
      ]),
    );
    expect(
      (await db.query("SELECT count(*)::int AS count FROM conuo_private.ai_request_traces"))
        .rows[0],
    ).toEqual({ count: 1 });
  });

  it("rejects metrics larger than sixteen KiB", async () => {
    await expect(
      asRole("service_role", () =>
        db.query("SELECT public.record_ai_trace($1::uuid,$2::jsonb)", [
          owner,
          JSON.stringify({
            route: "ask",
            outcome: "completed",
            metrics: { value: "x".repeat(17_000) },
          }),
        ]),
      ),
    ).rejects.toBeTruthy();
  });
});
