import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let db: PGlite;
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const fingerprint = "a".repeat(64);
type Reservation = { status: string; errorCode?: string | null };

async function reserve(id: string, ttl?: number, fourArgs = false): Promise<Reservation> {
  const sql =
    fourArgs || ttl === undefined
      ? "SELECT public.reserve_ai_request($1::uuid, $2, $3, 50) AS reservation"
      : "SELECT public.reserve_ai_request($1::uuid, $2, $3, 50, $4::integer) AS reservation";
  const params =
    fourArgs || ttl === undefined ? [owner, id, fingerprint] : [owner, id, fingerprint, ttl];
  return (await db.query<{ reservation: Reservation }>(sql, params)).rows[0].reservation;
}

beforeAll(async () => {
  db = await PGlite.create("memory://");
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    INSERT INTO auth.users (id) VALUES ('${owner}');
    GRANT USAGE ON SCHEMA public TO service_role;
  `);
  const base = await readFile(
    new URL("../../../../../supabase/migrations/202609120002_ai_requests.sql", import.meta.url),
    "utf8",
  );
  await db.exec(base);
  await db.exec(`
    CREATE SCHEMA conuo_private;
    CREATE FUNCTION conuo_private.assert_account_access(uuid) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ BEGIN RETURN; END; $$;
  `);
  const ttl = await readFile(
    new URL(
      "../../../../../supabase/migrations/20260924000300_ai_request_ttl.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await db.exec(ttl);
}, 30_000);

beforeEach(async () => {
  await db.exec("TRUNCATE public.ai_requests;");
});

afterAll(async () => {
  await db?.close();
});

describe("AI request TTL migration", () => {
  it("keeps a running request until its explicit TTL rather than the two-minute fallback", async () => {
    await reserve("old-but-live", 330);
    await db.exec("UPDATE public.ai_requests SET created_at = now() - interval '3 minutes';");
    expect(await reserve("second")).toEqual({ status: "busy" });
  });

  it("expires a running request after its explicit TTL", async () => {
    await reserve("expired", 330);
    await db.exec("UPDATE public.ai_requests SET expires_at = now() - interval '1 second';");
    expect(await reserve("fresh")).toEqual({ status: "reserved" });
    expect(
      (
        await db.query<{ state: string; error_code: string }>(
          "SELECT state,error_code FROM public.ai_requests WHERE request_id='expired'",
        )
      ).rows,
    ).toEqual([{ state: "failed", error_code: "REQUEST_EXPIRED" }]);
  });

  it.each([59, 901])("rejects TTL %s outside the allowed range", async (ttl) => {
    await expect(reserve("invalid", ttl)).rejects.toMatchObject({ code: "22023" });
  });

  it("keeps the four argument call compatible through the default TTL", async () => {
    expect(await reserve("legacy", undefined, true)).toEqual({ status: "reserved" });
    const row = await db.query<{ expires_at: string }>(
      "SELECT expires_at FROM public.ai_requests WHERE request_id='legacy'",
    );
    expect(row.rows[0].expires_at).toBeTruthy();
  });
});
