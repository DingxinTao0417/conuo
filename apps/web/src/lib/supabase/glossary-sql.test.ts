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
  await db.exec("RESET ROLE; DELETE FROM public.workspaces;");
  const workspace = (spaceId: string) =>
    JSON.stringify({
      schemaVersion: 1,
      spaces: [
        {
          id: spaceId,
          name: spaceId,
          goal: "goal",
          color: "blue",
          archived: false,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      sources: [],
      notes: [],
      annotations: [],
      conversations: [],
      aiEnabled: true,
    });
  await db.query(
    "insert into public.workspaces(owner_id,data) values ($1,$3::jsonb),($2,$4::jsonb)",
    [ownerA, ownerB, workspace("space-a"), workspace("space-b")],
  );
  await db.exec("BEGIN");
  await db.query(
    `insert into public.sources(owner_id,source_id,current_version_id,title,space_ids,ai_allowed)
     values ($1,'source-a','v1','A',array['space-a'],true),($2,'source-b','v1','B',array['space-b'],true)`,
    [ownerA, ownerB],
  );
  await db.query(
    `insert into public.source_versions(owner_id,source_id,version_id,manifest,content_digest,text,status,kind)
     values ($1,'source-a','v1','{}',$3,'body','ready','markdown'),($2,'source-b','v1','{}',$3,'body','ready','markdown')`,
    [ownerA, ownerB, "a".repeat(64)],
  );
  await db.query(
    `insert into public.source_chunks(owner_id,source_id,version_id,chunk_id,position,ordinal,text,section,content_hash)
     values ($1,'source-a','v1','chunk-a',0,0,'body','第一章',$2)`,
    [ownerA, "b".repeat(64)],
  );
  await db.exec("COMMIT");
});

afterAll(async () => {
  if (db && !db.closed) await db.close();
});

describe("glossary SQL boundary", () => {
  it("keeps terms owner scoped and validates current source refs", async () => {
    const definition = JSON.stringify({
      text: "定义",
      chunkRefs: [{ sourceId: "source-a", versionId: "v1", chunkId: "chunk-a" }],
    });
    await expect(
      asOwner(ownerA, () =>
        db.query("select public.upsert_glossary_term($1,$2,$3,$4,$5::jsonb,$6,$7)", [
          "space-a",
          "term-a",
          "术语",
          ["alias"],
          definition,
          "accepted",
          "user",
        ]),
      ),
    ).resolves.toBeTruthy();
    const own = await asOwner(ownerA, () =>
      db.query("select public.list_glossary_terms($1) as terms", ["space-a"]),
    );
    expect((own.rows[0] as { terms: unknown }).terms).toMatchObject([
      { termId: "term-a", term: "术语", status: "accepted" },
    ]);
    await expect(
      asOwner(ownerB, () => db.query("select public.list_glossary_terms($1)", ["space-a"])),
    ).rejects.toBeTruthy();
    await expect(
      asOwner(ownerA, () =>
        db.query("select public.upsert_glossary_term($1,$2,$3,$4,$5::jsonb,$6,$7)", [
          "space-a",
          "term-b",
          "术语",
          [],
          JSON.stringify({
            text: "bad",
            chunkRefs: [{ sourceId: "source-a", versionId: "old", chunkId: "chunk-a" }],
          }),
          "accepted",
          "user",
        ]),
      ),
    ).rejects.toBeTruthy();
    await expect(
      asOwner(ownerA, () => db.query("select public.list_glossary_terms($1)", ["space-a"]), "anon"),
    ).rejects.toBeTruthy();
  });

  it("deletes terms when the owning space is removed", async () => {
    const definition = JSON.stringify({
      text: "定义",
      chunkRefs: [{ sourceId: "source-a", versionId: "v1", chunkId: "chunk-a" }],
    });
    await asOwner(ownerA, () =>
      db.query("select public.upsert_glossary_term($1,$2,$3,$4,$5::jsonb,$6,$7)", [
        "space-a",
        "term-a",
        "术语",
        [],
        definition,
        "accepted",
        "user",
      ]),
    );
    await db.query("delete from public.learning_spaces where owner_id=$1 and space_id='space-a'", [
      ownerA,
    ]);
    const rows = await db.query(
      "select count(*)::int as count from public.space_glossary_terms where owner_id=$1",
      [ownerA],
    );
    expect(rows.rows[0]).toEqual({ count: 0 });
  });
});
