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
    "RESET ROLE; DELETE FROM conuo_private.summary_jobs; DELETE FROM public.sources; DELETE FROM public.workspaces;",
  );
  const workspace = JSON.stringify({
    schemaVersion: 1,
    spaces: [],
    sources: [],
    notes: [],
    annotations: [],
    conversations: [],
    aiEnabled: true,
  });
  await db.query(
    "insert into public.workspaces(owner_id,data) values ($1,$3::jsonb),($2,$3::jsonb)",
    [ownerA, ownerB, workspace],
  );
  await db.exec("begin");
  await db.query(
    `insert into public.sources(owner_id,source_id,current_version_id,title,ai_allowed) values ($1,'source-a','v1','A',true),($2,'source-b','v1','B',true)`,
    [ownerA, ownerB],
  );
  await db.query(
    `insert into public.source_versions(owner_id,source_id,version_id,manifest,content_digest,text,status,kind) values ($1,'source-a','v1','{}',$3,'body','ready','markdown'),($1,'source-a','v2','{}',$3,'old','ready','markdown'),($2,'source-b','v1','{}',$3,'body','ready','markdown')`,
    [ownerA, ownerB, "a".repeat(64)],
  );
  await db.query(
    `insert into public.source_chunks(owner_id,source_id,version_id,chunk_id,position,ordinal,text,section,content_hash) values ($1,'source-a','v1','chunk-a',0,0,'原文','正文',$2),($3,'source-b','v1','chunk-b',0,0,'另一份','正文',$2)`,
    [ownerA, "b".repeat(64), ownerB],
  );
  await db.exec("commit");
});

afterAll(async () => {
  if (db && !db.closed) await db.close();
});

describe("source summary SQL boundary", () => {
  it("is idempotent, owner scoped, and cascades with a version", async () => {
    const first = await asOwner(ownerA, () =>
      db.query("select public.request_source_summary($1,$2) as result", ["source-a", "v1"]),
    );
    const second = await asOwner(ownerA, () =>
      db.query("select public.request_source_summary($1,$2) as result", ["source-a", "v1"]),
    );
    expect((first.rows[0] as { result: { state: string } }).result.state).toBe("queued");
    expect((second.rows[0] as { result: { state: string } }).result.state).toBe("queued");
    await expect(
      asOwner(ownerB, () =>
        db.query("select public.read_source_summaries($1,$2)", ["source-a", "v1"]),
      ),
    ).rejects.toBeTruthy();
    await db.query(
      "delete from public.source_versions where owner_id=$1 and source_id='source-a' and version_id='v2'",
      [ownerA],
    );
    const count = await db.query(
      "select count(*)::int as count from public.source_version_summaries where owner_id=$1",
      [ownerA],
    );
    expect(count.rows[0]).toEqual({ count: 0 });
  });

  it("cancels a claimed job after AI is disabled and enforces daily quota", async () => {
    await asOwner(ownerA, () =>
      db.query("select public.request_source_summary($1,$2)", ["source-a", "v1"]),
    );
    await db.query(
      "update public.workspaces set data=jsonb_set(data,'{aiEnabled}','false') where owner_id=$1",
      [ownerA],
    );
    const claimed = await asOwner(
      ownerA,
      () => db.query("select public.claim_summary_jobs($1,$2)", ["worker-a", 120]),
      "service_role",
    );
    expect(claimed.rows[0]).toMatchObject({ claim_summary_jobs: { jobs: [] } });
    await expect(
      asOwner(
        ownerA,
        () => db.query("select public.reserve_summary_section($1,$2)", [ownerA, 1]),
        "service_role",
      ),
    ).resolves.toBeTruthy();
    const denied = await asOwner(
      ownerA,
      () => db.query("select public.reserve_summary_section($1,$2)", [ownerA, 1]),
      "service_role",
    );
    expect(
      (denied.rows[0] as { reserve_summary_section: { allowed: boolean } }).reserve_summary_section
        .allowed,
    ).toBe(false);
  });
});
