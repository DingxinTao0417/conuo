import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherOwner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const fingerprint = "a".repeat(64);
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

async function migration(name: string) {
  return readFile(new URL(`../../../../../supabase/migrations/${name}`, import.meta.url), "utf8");
}

beforeAll(async () => {
  db = await PGlite.create("memory://");
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${owner}'), ('${otherOwner}');
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    CREATE SCHEMA conuo_private;
    GRANT USAGE ON SCHEMA conuo_private TO anon, authenticated, service_role;
  `);
  await db.exec(await migration("202609120002_ai_requests.sql"));
  await db.exec(await migration("20260924000200_ai_request_traces.sql"));
  await db.exec(`
    CREATE FUNCTION conuo_private.assert_account_access(p_owner uuid)
    RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ BEGIN RETURN; END; $$;
  `);
  await db.exec(await migration("20260924000300_ai_request_ttl.sql"));
  await db.exec(await migration("20260926000200_ai_token_usage.sql"));
  await db.exec(await migration("20260927000200_ai_request_token_ledger.sql"));
}, 30_000);

beforeEach(async () => {
  await db.exec(
    "RESET ROLE; DELETE FROM conuo_private.ai_request_traces; DELETE FROM conuo_private.ai_token_usage_ledger; DELETE FROM public.ai_requests;",
  );
  await db.exec("SET TIME ZONE 'UTC'");
});

afterAll(async () => {
  if (db && !db.closed) await db.close();
});

describe("AI token usage SQL boundary", () => {
  it("aggregates request and token-only ledger rows, while ignoring optional traces", async () => {
    await asRole("service_role", async () => {
      await db.query("SELECT public.record_ai_trace($1::uuid,$2::jsonb)", [
        owner,
        JSON.stringify({
          route: "ask",
          outcome: "completed",
          metrics: { promptTokens: 120, completionTokens: 30 },
        }),
      ]);
      await db.query("SELECT public.record_ai_trace($1::uuid,$2::jsonb)", [
        otherOwner,
        JSON.stringify({
          route: "ask",
          outcome: "completed",
          metrics: { promptTokens: 900, completionTokens: 900 },
        }),
      ]);
    });
    await db.exec(
      "UPDATE conuo_private.ai_request_traces SET created_at = now() - interval '1 day' WHERE owner_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'",
    );
    await asRole("service_role", () =>
      db.query("SELECT public.reserve_ai_request($1::uuid,$2,$3,$4)", [
        owner,
        "request-ledger",
        fingerprint,
        50,
      ]),
    );
    await asRole("service_role", () =>
      db.query("SELECT public.finish_ai_request($1::uuid,$2,$3::jsonb,$4,$5::bigint,$6::bigint)", [
        owner,
        "request-ledger",
        JSON.stringify({ answer: "saved" }),
        null,
        10,
        20,
      ]),
    );
    await asRole("service_role", () =>
      db.query("SELECT public.record_ai_token_usage($1::uuid,$2,$3,$4::bigint,$5::bigint)", [
        owner,
        "ocr-current",
        "ocr",
        4,
        6,
      ]),
    );
    expect(
      (
        await asRole("service_role", () =>
          db.query<{ value: unknown }>("SELECT public.ai_token_usage_today($1::uuid) AS value", [
            owner,
          ]),
        )
      ).rows[0]!.value,
    ).toEqual({ promptTokens: 14, completionTokens: 26 });
    await expect(
      asRole("authenticated", () =>
        db.query("SELECT public.ai_token_usage_today($1::uuid)", [owner]),
      ),
    ).rejects.toBeTruthy();
  });

  it("enforces token_limited while retaining legacy four and five argument reservations", async () => {
    await asRole("service_role", () =>
      db.query("SELECT public.record_ai_token_usage($1::uuid,$2,$3,$4::bigint,$5::bigint)", [
        owner,
        "ocr-limit",
        "ocr",
        4,
        6,
      ]),
    );
    expect(
      (
        await asRole("service_role", () =>
          db.query<{ value: unknown }>(
            "SELECT public.reserve_ai_request($1::uuid,$2,$3,$4) AS value",
            [owner, "legacy-four", fingerprint, 50],
          ),
        )
      ).rows[0]!.value,
    ).toEqual({ status: "reserved" });
    await db.exec("DELETE FROM public.ai_requests");
    expect(
      (
        await asRole("service_role", () =>
          db.query<{ value: unknown }>(
            "SELECT public.reserve_ai_request($1::uuid,$2,$3,$4,$5,$6) AS value",
            [owner, "limited", "b".repeat(64), 50, 120, 10],
          ),
        )
      ).rows[0]!.value,
    ).toEqual({ status: "token_limited" });
    await db.exec("DELETE FROM public.ai_requests");
    expect(
      (
        await asRole("service_role", () =>
          db.query<{ value: unknown }>(
            "SELECT public.reserve_ai_request($1::uuid,$2,$3,$4,$5) AS value",
            [otherOwner, "legacy-five", fingerprint, 50, 120],
          ),
        )
      ).rows[0]!.value,
    ).toEqual({ status: "reserved" });
    await expect(
      asRole("service_role", () =>
        db.query("SELECT public.reserve_ai_request($1::uuid,$2,$3,$4,$5,$6)", [
          owner,
          "invalid",
          "c".repeat(64),
          50,
          120,
          100000001,
        ]),
      ),
    ).rejects.toBeTruthy();
    await expect(
      asRole("service_role", () =>
        db.query("SELECT public.record_ai_token_usage($1::uuid,$2,$3,$4::bigint,$5::bigint)", [
          owner,
          "invalid-token",
          "ocr",
          -1,
          0,
        ]),
      ),
    ).rejects.toBeTruthy();
    await expect(
      asRole("authenticated", () =>
        db.query(
          "SELECT public.finish_ai_request($1::uuid,$2,$3::jsonb,$4,$5::bigint,$6::bigint)",
          [otherOwner, "legacy-four", JSON.stringify({ answer: "forbidden" }), null, 1, 1],
        ),
      ),
    ).rejects.toBeTruthy();
  });
});
