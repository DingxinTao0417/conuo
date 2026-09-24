import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmptyWorkspace } from "../seed";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const migrationName = "20260920000300_business_conflict_response.sql";
const postConflictMigrationNames = new Set([
  "20260923000100_pdf_ink_cloud.sql",
  "20260923000200_pdf_ink_idempotent_reserve.sql",
  "20260923000300_pdf_ink_realtime.sql",
  "20260925000500_learning_foundation.sql",
]);
const migrations = new URL("../../../../../supabase/migrations/", import.meta.url);

type FunctionRow = {
  oid: string;
  schema: string;
  name: string;
  args: string;
  acl: string | null;
  source: string;
};

let db: PGlite;
let before: FunctionRow[];
let after: FunctionRow[];

async function functions(): Promise<FunctionRow[]> {
  return (
    await db.query<FunctionRow>(`
      select
        p.oid::text as oid,
        n.nspname as schema,
        p.proname as name,
        pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
        p.proacl::text as acl,
        p.prosrc as source
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'conuo_private') and p.prokind = 'f'
      order by p.oid
    `)
  ).rows;
}

beforeAll(async () => {
  db = await PGlite.create("memory://", { extensions: { vector } });
  try {
    await db.exec(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); INSERT INTO auth.users VALUES ('${owner}');
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
      CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      CREATE TABLE storage.objects(bucket_id text,name text,metadata jsonb not null default '{}'::jsonb); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array($1,'/') $$;
      GRANT USAGE ON SCHEMA storage TO anon,authenticated,service_role; GRANT SELECT,INSERT,DELETE ON storage.objects TO authenticated;
    `);
    const names = (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && !name.startsWith("._"))
      .sort();
    for (const name of names) {
      if (name === migrationName || postConflictMigrationNames.has(name)) continue;
      await db.exec(await readFile(new URL(name, migrations), "utf8"));
    }
    before = await functions();
    await db.exec(await readFile(new URL(migrationName, migrations), "utf8"));
    after = await functions();
  } catch (error) {
    await db.close();
    throw error;
  }
}, 30_000);

afterAll(async () => {
  if (db && !db.closed) await db.close();
});

describe("business conflict SQLSTATE migration", () => {
  it("rewrites exactly the audited 49 functions without replacing their identity or grants", () => {
    const changed = before.filter((item) => item.source.includes("'40001'"));
    expect(changed).toHaveLength(49);
    expect(after.filter((item) => item.source.includes("'40001'"))).toHaveLength(0);

    const byOid = new Map(after.map((item) => [item.oid, item]));
    for (const oldFunction of changed) {
      const current = byOid.get(oldFunction.oid);
      expect(current).toMatchObject({
        oid: oldFunction.oid,
        schema: oldFunction.schema,
        name: oldFunction.name,
        args: oldFunction.args,
        acl: oldFunction.acl,
      });
      expect(current?.source).toContain("'PT409'");
    }
  });

  it("returns a bounded conflict for a stale workspace revision", async () => {
    await db.exec(
      `SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${owner}',false);`,
    );
    try {
      const data = JSON.stringify(createEmptyWorkspace());
      await db.query("select public.save_workspace($1::jsonb,0)", [data]);
      await expect(
        db.query("select public.save_workspace($1::jsonb,0)", [data]),
      ).rejects.toMatchObject({
        code: "PT409",
      });
    } finally {
      await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false);");
    }
  });
});
