import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Execute the unchanged migration in an ephemeral PostgreSQL WASM database.
// This covers SQL and role semantics on one connection, not deployed Supabase,
// PostgREST, or advisory-lock behavior across concurrent database connections.
let db: PGlite;
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);
const result = { mode: "model", content: "从资料中得到的回答。", citations: [] };
type Role = "anon" | "authenticated" | "service_role";
type Reservation = { status: string; result?: unknown; errorCode?: string | null };

async function asRole<T>(role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec("RESET ROLE");
  }
}

async function reserve(
  owner = ownerA,
  id = "request-1",
  fingerprint = fingerprintA,
  dailyLimit = 50,
): Promise<Reservation> {
  return asRole("service_role", async () => {
    const response = await db.query<{ reservation: Reservation }>(
      "SELECT public.reserve_ai_request($1::uuid, $2, $3, $4::integer) AS reservation",
      [owner, id, fingerprint, dailyLimit],
    );
    return response.rows[0].reservation;
  });
}

async function finish(owner = ownerA, id = "request-1", completed = true) {
  return asRole("service_role", () =>
    db.query(
      `UPDATE public.ai_requests SET state = $3, result = $4::jsonb, error_code = $5
       WHERE owner_id = $1 AND request_id = $2 AND state = 'running'
       RETURNING request_id`,
      [
        owner,
        id,
        completed ? "completed" : "failed",
        completed ? JSON.stringify(result) : null,
        completed ? null : "MODEL_TIMEOUT",
      ],
    ),
  );
}

beforeAll(async () => {
  db = await PGlite.create("memory://");
  // Supabase owns these roles/schema in production. No existing project is used.
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    INSERT INTO auth.users (id) VALUES ('${ownerA}'), ('${ownerB}');
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  `);
  const sql = await readFile(
    new URL("../../../../../supabase/migrations/202609120002_ai_requests.sql", import.meta.url),
    "utf8",
  );
  await db.exec(sql);
}, 30_000);

beforeEach(async () => {
  await db.exec("RESET ROLE; SET TIME ZONE 'UTC'; TRUNCATE public.ai_requests;");
});

afterAll(async () => {
  await db?.close();
});

describe("AI request migration on PostgreSQL (PGlite)", () => {
  it.each(["anon", "authenticated"] as const)(
    "denies %s direct table reads and writes",
    async (role) => {
      await reserve();
      await asRole(role, async () => {
        await expect(db.query("SELECT * FROM public.ai_requests")).rejects.toMatchObject({
          code: "42501",
        });
        await expect(
          db.query("UPDATE public.ai_requests SET state = 'failed'"),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(db.query("DELETE FROM public.ai_requests")).rejects.toMatchObject({
          code: "42501",
        });
        await expect(
          db.query(
            "INSERT INTO public.ai_requests(owner_id,request_id,fingerprint,state) VALUES ($1,'forged',$2,'running')",
            [ownerA, fingerprintA],
          ),
        ).rejects.toMatchObject({ code: "42501" });
      });
      expect((await db.query("SELECT * FROM public.ai_requests")).rows).toHaveLength(1);
    },
  );

  it.each(["anon", "authenticated"] as const)(
    "denies %s RPC execution even for a valid owner",
    async (role) => {
      await asRole(role, () =>
        expect(
          db.query("SELECT public.reserve_ai_request($1::uuid, 'forged', $2, 50)", [
            ownerA,
            fingerprintA,
          ]),
        ).rejects.toMatchObject({ code: "42501" }),
      );
      expect((await db.query("SELECT * FROM public.ai_requests")).rows).toHaveLength(0);
    },
  );

  it("keeps RLS enabled and lets only the privileged service role execute the reservation", async () => {
    const table = await db.query<{ relrowsecurity: boolean }>(
      "SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ai_requests'::regclass",
    );
    expect(table.rows[0].relrowsecurity).toBe(true);
    expect(await reserve()).toEqual({ status: "reserved" });
    const rows = await asRole("service_role", () =>
      db.query<{ owner_id: string; request_id: string; state: string }>(
        "SELECT owner_id, request_id, state FROM public.ai_requests",
      ),
    );
    expect(rows.rows).toEqual([{ owner_id: ownerA, request_id: "request-1", state: "running" }]);
  });

  it("keeps identical request IDs independent between owners", async () => {
    expect(await reserve(ownerA, "same-id", fingerprintA)).toEqual({ status: "reserved" });
    expect(await reserve(ownerB, "same-id", fingerprintB)).toEqual({ status: "reserved" });
    await finish(ownerA, "same-id");
    expect(await reserve(ownerA, "same-id", fingerprintA)).toMatchObject({
      status: "completed",
      result,
    });
    expect(await reserve(ownerB, "same-id", fingerprintB)).toMatchObject({
      status: "running",
      result: null,
    });
    const rows = await db.query(
      "SELECT owner_id FROM public.ai_requests WHERE request_id='same-id'",
    );
    expect(rows.rows).toHaveLength(2);
  });

  it("rejects changed fingerprints and prevents a second running request for the same owner", async () => {
    expect(await reserve()).toEqual({ status: "reserved" });
    expect(await reserve()).toMatchObject({ status: "running" });
    expect(await reserve(ownerA, "request-1", fingerprintB)).toEqual({ status: "mismatch" });
    expect(await reserve(ownerA, "request-2")).toEqual({ status: "busy" });
    expect((await db.query("SELECT * FROM public.ai_requests")).rows).toHaveLength(1);
  });

  it("returns completed cached content rather than creating another record", async () => {
    await reserve();
    expect((await finish()).rows).toEqual([{ request_id: "request-1" }]);
    expect(await reserve()).toEqual({ status: "completed", result, errorCode: null });
    expect((await db.query("SELECT * FROM public.ai_requests")).rows).toHaveLength(1);
    expect(await reserve(ownerA, "request-2")).toEqual({ status: "reserved" });
  });

  it("preserves failure for repeated IDs and refuses to complete another owner's request", async () => {
    await reserve();
    expect((await finish(ownerB)).rows).toHaveLength(0);
    await finish(ownerA, "request-1", false);
    expect(await reserve()).toEqual({ status: "failed", result: null, errorCode: "MODEL_TIMEOUT" });
    expect((await finish()).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM public.ai_requests")).rows).toHaveLength(1);
  });

  it("enforces a per-owner daily limit including failed attempts without charging a cached lookup", async () => {
    await reserve(ownerA, "first", fingerprintA, 2);
    await finish(ownerA, "first");
    await reserve(ownerA, "second", fingerprintA, 2);
    await finish(ownerA, "second", false);
    expect(await reserve(ownerA, "third", fingerprintA, 2)).toEqual({ status: "limited" });
    expect(await reserve(ownerA, "first", fingerprintA, 2)).toMatchObject({
      status: "completed",
      result,
    });
    expect(await reserve(ownerA, "second", fingerprintA, 2)).toMatchObject({ status: "failed" });
    expect(await reserve(ownerB, "third", fingerprintA, 2)).toEqual({ status: "reserved" });
    expect(
      (await db.query("SELECT * FROM public.ai_requests WHERE owner_id=$1", [ownerA])).rows,
    ).toHaveLength(2);
  });

  it.each(["Pacific/Kiritimati", "Etc/GMT+12"])(
    "counts from UTC midnight regardless of session timezone %s",
    async (zone) => {
      await db.query("SELECT set_config('TimeZone', $1, false)", [zone]);
      await db.query(
        `INSERT INTO public.ai_requests(owner_id,request_id,fingerprint,state,created_at)
      VALUES ($1,'yesterday',$2,'failed',(date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - interval '1 second'),
             ($1,'today',$2,'failed',date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
        [ownerA, fingerprintA],
      );
      expect(await reserve(ownerA, "blocked", fingerprintA, 1)).toEqual({ status: "limited" });
      expect(await reserve(ownerA, "allowed", fingerprintA, 2)).toEqual({ status: "reserved" });
    },
  );

  it("turns an expired running reservation into a failure before allowing a new ID", async () => {
    await reserve();
    await db.query(
      "UPDATE public.ai_requests SET created_at=now()-interval '3 minutes' WHERE owner_id=$1",
      [ownerA],
    );
    expect(await reserve()).toMatchObject({
      status: "failed",
      result: null,
      errorCode: "REQUEST_EXPIRED",
    });
    expect(await reserve(ownerA, "fresh")).toEqual({ status: "reserved" });
    expect(
      (await db.query("SELECT * FROM public.ai_requests WHERE request_id='request-1'")).rows,
    ).toHaveLength(1);
  });

  it("lazily removes expired cached content only for the reserving owner", async () => {
    await reserve(ownerA, "old-cache");
    await finish(ownerA, "old-cache");
    await reserve(ownerB, "other-cache");
    await finish(ownerB, "other-cache");
    await db.exec("UPDATE public.ai_requests SET created_at=now()-interval '25 hours'");
    // No timer has removed either cached body just because the dates are old.
    expect(
      (await db.query("SELECT * FROM public.ai_requests WHERE result IS NOT NULL")).rows,
    ).toHaveLength(2);
    expect(await reserve(ownerA, "old-cache")).toMatchObject({
      status: "failed",
      result: null,
      errorCode: "REQUEST_EXPIRED",
    });
    const other = await db.query<{ state: string; result: unknown }>(
      "SELECT state,result FROM public.ai_requests WHERE owner_id=$1",
      [ownerB],
    );
    expect(other.rows).toEqual([{ state: "completed", result }]);
  });

  it("purges metadata older than seven days only on that owner's next reservation", async () => {
    await db.query(
      `INSERT INTO public.ai_requests(owner_id,request_id,fingerprint,state,created_at)
      VALUES ($1,'purged-id',$3,'failed',now()-interval '8 days'),
             ($1,'kept-id',$3,'failed',now()-interval '6 days'),
             ($2,'other-old-id',$3,'failed',now()-interval '8 days')`,
      [ownerA, ownerB, fingerprintA],
    );
    expect((await db.query("SELECT * FROM public.ai_requests")).rows).toHaveLength(3);
    expect(await reserve(ownerA, "fresh")).toEqual({ status: "reserved" });
    const remaining = await db.query<{ request_id: string }>(
      "SELECT request_id FROM public.ai_requests ORDER BY request_id",
    );
    expect(remaining.rows.map((row) => row.request_id)).toEqual([
      "fresh",
      "kept-id",
      "other-old-id",
    ]);
    await finish(ownerA, "fresh", false);
    // The migration intentionally retains no permanent idempotency tombstone.
    expect(await reserve(ownerA, "purged-id", fingerprintB)).toEqual({ status: "reserved" });
  });

  it.each([
    [null, "request", fingerprintA, 50],
    [ownerA, "invalid id", fingerprintA, 50],
    [ownerA, "request", "not-a-hash", 50],
    [ownerA, "request", fingerprintA, 0],
    [ownerA, "request", fingerprintA, 501],
  ])("rejects invalid RPC arguments inside PostgreSQL %#", async (...params) => {
    await asRole("service_role", () =>
      expect(
        db.query("SELECT public.reserve_ai_request($1::uuid,$2,$3,$4::integer)", params),
      ).rejects.toMatchObject({ code: "22023" }),
    );
    expect((await db.query("SELECT * FROM public.ai_requests")).rows).toHaveLength(0);
  });

  it("enforces result shape/size and the owner foreign key in PostgreSQL", async () => {
    await reserve();
    await asRole("service_role", async () => {
      await expect(
        db.query("UPDATE public.ai_requests SET result='[]'::jsonb"),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        db.query("UPDATE public.ai_requests SET result=$1::jsonb", [
          JSON.stringify({ content: "x".repeat(262_144) }),
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        db.query("SELECT public.reserve_ai_request($1::uuid,'missing-owner',$2,50)", [
          "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          fingerprintA,
        ]),
      ).rejects.toMatchObject({ code: "23503" });
    });
  });
});
