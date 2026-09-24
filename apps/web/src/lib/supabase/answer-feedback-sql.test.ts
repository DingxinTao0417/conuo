import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const migrations = new URL("../../../../../supabase/migrations/", import.meta.url);
let db: PGlite;

async function asOwner<T>(owner: string, action: () => Promise<T>, role = "authenticated") {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await action();
  } finally {
    await db.exec("RESET ROLE");
  }
}

beforeAll(async () => {
  db = await PGlite.create("memory://", { extensions: { vector } });
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${ownerA}'),('${ownerB}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    CREATE TABLE storage.objects(bucket_id text,name text,metadata jsonb not null default '{}'::jsonb);
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array($1,'/') $$;
    GRANT USAGE ON SCHEMA storage TO anon,authenticated,service_role;
    GRANT SELECT,INSERT,DELETE ON storage.objects TO authenticated;
  `);
  const names = (await readdir(migrations))
    .filter((name) => name.endsWith(".sql") && !name.startsWith("._"))
    .sort();
  for (const name of names) await db.exec(await readFile(new URL(name, migrations), "utf8"));
}, 30_000);

beforeEach(async () => {
  await db.exec(
    "RESET ROLE; DELETE FROM public.answer_feedback; DELETE FROM public.account_deletions;",
  );
});

afterAll(async () => {
  if (db && !db.closed) await db.close();
});

const feedback = (overrides: Record<string, unknown> = {}) => ({
  requestId: "request-a",
  rating: "down",
  reasons: ["incorrect"],
  includeContent: false,
  ...overrides,
});

describe("answer feedback SQL boundary", () => {
  it("keeps feedback private to its owner and denies anonymous calls", async () => {
    await expect(
      asOwner(ownerA, () =>
        db.query("select public.submit_answer_feedback($1::jsonb)", [JSON.stringify(feedback())]),
      ),
    ).resolves.toBeTruthy();
    await expect(
      asOwner(ownerB, () => db.query("select * from public.answer_feedback")),
    ).rejects.toBeTruthy();
    await asOwner(ownerB, () =>
      db.query("select public.withdraw_answer_feedback($1)", ["request-a"]),
    );
    expect(
      (
        await asOwner(
          ownerA,
          () => db.query("select count(*)::int as count from public.answer_feedback"),
          "service_role",
        )
      ).rows[0],
    ).toEqual({ count: 1 });
    await expect(
      asOwner(
        ownerA,
        () =>
          db.query("select public.submit_answer_feedback($1::jsonb)", [
            JSON.stringify(feedback({ requestId: "bad" })),
          ]),
        "anon",
      ),
    ).rejects.toBeTruthy();
  });

  it("updates a duplicate request, rejects implicit content, and supports withdrawal", async () => {
    await asOwner(ownerA, () =>
      db.query("select public.submit_answer_feedback($1::jsonb)", [JSON.stringify(feedback())]),
    );
    await asOwner(ownerA, () =>
      db.query("select public.submit_answer_feedback($1::jsonb)", [
        JSON.stringify(feedback({ rating: "up", reasons: [] })),
      ]),
    );
    const row = await db.query(
      "select rating,reasons,question,answer from public.answer_feedback where owner_id=$1::uuid",
      [ownerA],
    );
    expect(row.rows).toEqual([{ rating: "up", reasons: [], question: null, answer: null }]);
    await expect(
      asOwner(ownerA, () =>
        db.query("select public.submit_answer_feedback($1::jsonb)", [
          JSON.stringify(feedback({ question: "隐式", answer: "内容" })),
        ]),
      ),
    ).rejects.toBeTruthy();
    await expect(
      asOwner(ownerA, () =>
        db.query("select public.submit_answer_feedback($1::jsonb)", [
          JSON.stringify(feedback({ reasons: ["forged"] })),
        ]),
      ),
    ).rejects.toBeTruthy();
    await asOwner(ownerA, () =>
      db.query("select public.withdraw_answer_feedback($1)", ["request-a"]),
    );
    expect(
      (await db.query("select count(*)::int as count from public.answer_feedback")).rows[0],
    ).toEqual({ count: 0 });
  });

  it("rejects feedback after an account deletion request", async () => {
    await db.query(
      "insert into public.account_deletions(deletion_id,owner_id,state) values (gen_random_uuid(),$1,'storage_pending')",
      [ownerA],
    );
    await expect(
      asOwner(ownerA, () =>
        db.query("select public.submit_answer_feedback($1::jsonb)", [JSON.stringify(feedback())]),
      ),
    ).rejects.toBeTruthy();
  });
});
