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
    "RESET ROLE; DELETE FROM public.source_outlines; DELETE FROM public.sources; DELETE FROM public.workspaces;",
  );
  const workspace = JSON.stringify({
    schemaVersion: 1,
    spaces: [],
    sources: [],
    notes: [],
    annotations: [],
    conversations: [],
    aiEnabled: false,
  });
  await db.query(
    "insert into public.workspaces(owner_id,data) values ($1,$3::jsonb),($2,$3::jsonb)",
    [ownerA, ownerB, workspace],
  );
  await db.exec("BEGIN");
  await db.query(
    `insert into public.sources(owner_id,source_id,current_version_id,title,ai_allowed)
     values ($1,'source-a','v1','A',true),($2,'source-b','v1','B',true)`,
    [ownerA, ownerB],
  );
  await db.query(
    `insert into public.source_versions(owner_id,source_id,version_id,manifest,content_digest,text,status,kind)
     values ($1,'source-a','v1','{}',$3,'body','ready','markdown'),
            ($1,'source-a','v2','{}',$3,'old body','ready','markdown'),
            ($2,'source-b','v1','{}',$3,'body','ready','markdown')`,
    [ownerA, ownerB, "a".repeat(64)],
  );
  await db.exec("COMMIT");
});

afterAll(async () => {
  if (db && !db.closed) await db.close();
});

describe("source outline SQL boundary", () => {
  it("keeps outlines owner scoped, validates input, and denies anonymous access", async () => {
    const items = [{ title: "第一章", level: 1, page: 3 }];
    await asOwner(ownerA, () =>
      db.query("select public.save_source_outline($1,$2,$3,$4::jsonb)", [
        "source-a",
        "v1",
        "markdown-headings",
        JSON.stringify(items),
      ]),
    );
    const own = await asOwner(ownerA, () =>
      db.query("select public.read_source_outlines($1::jsonb) as outlines", [
        JSON.stringify([{ sourceId: "source-a", versionId: "v1" }]),
      ]),
    );
    expect((own.rows[0] as { outlines: unknown }).outlines).toMatchObject([
      { sourceId: "source-a", versionId: "v1", method: "markdown-headings", items },
    ]);
    await expect(
      asOwner(ownerB, () =>
        db.query("select public.save_source_outline($1,$2,$3,$4::jsonb)", [
          "source-a",
          "v1",
          "markdown-headings",
          JSON.stringify(items),
        ]),
      ),
    ).rejects.toBeTruthy();
    await expect(
      asOwner(ownerA, () =>
        db.query("select public.save_source_outline($1,$2,$3,$4::jsonb)", [
          "source-a",
          "missing",
          "markdown-headings",
          JSON.stringify(items),
        ]),
      ),
    ).rejects.toBeTruthy();
    await expect(
      asOwner(ownerA, () =>
        db.query("select public.save_source_outline($1,$2,$3,$4::jsonb)", [
          "source-a",
          "v1",
          "markdown-headings",
          JSON.stringify([{ title: "x", level: 1, extra: true }]),
        ]),
      ),
    ).rejects.toBeTruthy();
    await expect(
      asOwner(
        ownerA,
        () =>
          db.query("select public.read_source_outlines($1::jsonb)", [
            JSON.stringify([{ sourceId: "source-a", versionId: "v1" }]),
          ]),
        "anon",
      ),
    ).rejects.toBeTruthy();
  });

  it("cascades a historical version removal", async () => {
    await asOwner(ownerA, () =>
      db.query("select public.save_source_outline($1,$2,$3,$4::jsonb)", [
        "source-a",
        "v2",
        "pdf-outline",
        JSON.stringify([{ title: "旧章节", level: 1 }]),
      ]),
    );
    await db.query(
      "delete from public.source_versions where source_id='source-a' and version_id='v2'",
    );
    const result = await db.query(
      "select count(*)::int as count from public.source_outlines where version_id='v2'",
    );
    expect(result.rows[0]).toEqual({ count: 0 });
  });

  it("accepts the maximum outline page", async () => {
    await expect(
      asOwner(ownerA, () =>
        db.query("select public.save_source_outline($1,$2,$3,$4::jsonb)", [
          "source-a",
          "v1",
          "pdf-outline",
          JSON.stringify([{ title: "末页", level: 1, page: 100000 }]),
        ]),
      ),
    ).resolves.toBeTruthy();
  });
});
