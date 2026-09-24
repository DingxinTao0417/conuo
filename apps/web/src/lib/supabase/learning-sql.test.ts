import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const migrations = new URL("../../../../../supabase/migrations/", import.meta.url);
let db: PGlite;

async function asOwner<T>(owner: string, role: "anon" | "authenticated", action: () => Promise<T>) {
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
    "RESET ROLE; DELETE FROM public.learning_items; DELETE FROM public.learning_settings;",
  );
});

afterAll(async () => {
  if (db && !db.closed) await db.close();
});

describe("learning foundation SQL", () => {
  it("denies anonymous access and isolates owners", async () => {
    await expect(
      asOwner(ownerA, "anon", () =>
        db.query("select * from public.list_learning_items('space-1', null, 100, null)"),
      ),
    ).rejects.toBeTruthy();
    await asOwner(ownerA, "authenticated", () =>
      db.query("select public.upsert_learning_items($1::jsonb)", [
        JSON.stringify([
          {
            itemId: "item-a",
            spaceId: "space-1",
            kind: "recall",
            prompt: "问题",
            answer: { text: "答案" },
            citations: [],
            origin: "user",
            status: "active",
            card: { due: "2026-09-24T12:00:00.000Z" },
            dueAt: "2026-09-24T12:00:00.000Z",
          },
        ]),
      ]),
    );
    const other = await asOwner(ownerB, "authenticated", () =>
      db.query("select * from public.list_learning_items('space-1', null, 100, null)"),
    );
    expect(other.rows).toHaveLength(0);
  });

  it("protects review versions, daily new quota, pause, soft delete, and purged citations", async () => {
    await asOwner(ownerA, "authenticated", () =>
      db.query("select public.upsert_learning_items($1::jsonb)", [
        JSON.stringify([
          {
            itemId: "item-b",
            spaceId: "space-1",
            kind: "recall",
            prompt: "第二题",
            answer: { text: "答案" },
            citations: [
              {
                sourceId: "source-1",
                versionId: "version-1",
                chunkId: "chunk-1",
                title: "资料",
                quote: "原文",
                section: "",
              },
            ],
            origin: "ai",
            originRef: { requestId: "request-1" },
            status: "active",
            card: { due: "2026-09-23T12:00:00.000Z", reps: 0, lapses: 0 },
            dueAt: "2026-09-23T12:00:00.000Z",
          },
          {
            itemId: "item-c",
            spaceId: "space-1",
            kind: "recall",
            prompt: "第三题",
            answer: { text: "答案" },
            citations: [],
            origin: "user",
            status: "active",
            card: { due: "2026-09-23T12:00:00.000Z", reps: 0, lapses: 0 },
            dueAt: "2026-09-23T12:00:00.000Z",
          },
        ]),
      ]),
    );
    await asOwner(ownerA, "authenticated", () =>
      db.query("select public.save_learning_settings($1::jsonb)", [
        JSON.stringify({ dailyNewLimit: 1, desiredRetention: 0.9, paused: false }),
      ]),
    );
    const quota = await asOwner(ownerA, "authenticated", () =>
      db.query("select * from public.due_review_items('space-1',100)"),
    );
    expect(quota.rows).toHaveLength(1);
    const first = await asOwner(ownerA, "authenticated", () =>
      db.query("select public.record_review($1,$2::jsonb,$3::jsonb,$4::timestamptz,$5)", [
        "item-b",
        JSON.stringify({ logId: "log-1", rating: 3 }),
        JSON.stringify({ due: "2026-09-25T12:00:00.000Z", reps: 1, lapses: 0 }),
        "2026-09-25T12:00:00.000Z",
        0,
      ]),
    );
    expect(first.rows).toHaveLength(1);
    await expect(
      asOwner(ownerA, "authenticated", () =>
        db.query("select public.record_review($1,$2::jsonb,$3::jsonb,$4::timestamptz,$5)", [
          "item-b",
          JSON.stringify({ logId: "log-2", rating: 3 }),
          JSON.stringify({ due: "2026-09-25T12:00:00.000Z", reps: 1, lapses: 0 }),
          "2026-09-25T12:00:00.000Z",
          0,
        ]),
      ),
    ).rejects.toBeTruthy();
    await asOwner(ownerA, "authenticated", () =>
      db.query("select public.save_learning_settings($1::jsonb)", [
        JSON.stringify({ dailyNewLimit: 20, desiredRetention: 0.9, paused: true }),
      ]),
    );
    const paused = await asOwner(ownerA, "authenticated", () =>
      db.query("select * from public.due_review_items('space-1',100)"),
    );
    expect(paused.rows).toHaveLength(0);
    await asOwner(ownerA, "authenticated", () =>
      db.query("select public.delete_learning_item('item-c')"),
    );
    const deleted = await asOwner(ownerA, "authenticated", () =>
      db.query("select * from public.list_learning_items('space-1', null, 100, null)"),
    );
    expect(deleted.rows.some((row) => (row as { itemId?: string }).itemId === "item-c")).toBe(
      false,
    );
    await db.query("insert into public.workspaces(owner_id,data) values ($1,$2::jsonb)", [
      ownerA,
      JSON.stringify({
        schemaVersion: 1,
        spaces: [],
        sources: [],
        notes: [],
        annotations: [],
        conversations: [],
        aiEnabled: false,
      }),
    ]);
    await db.query(
      "insert into public.source_purges(purge_id,owner_id,source_id,workspace_revision,state) values (gen_random_uuid(),$1,'source-1',1,'completed')",
      [ownerA],
    );
    const purged = await db.query(
      "select citations,origin_ref from public.learning_items where owner_id=$1 and item_id='item-b'",
      [ownerA],
    );
    expect(purged.rows[0]).toMatchObject({ citations: [], origin_ref: { sourcePurged: true } });
  });
});
