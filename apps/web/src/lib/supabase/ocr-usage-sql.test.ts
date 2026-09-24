import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const migrations = new URL("../../../../../supabase/migrations/", import.meta.url);
let db: PGlite;

async function asOwner<T>(
  owner: string,
  role: "authenticated" | "service_role",
  action: () => Promise<T>,
) {
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
    "RESET ROLE; DELETE FROM conuo_private.ocr_usage; DELETE FROM public.sources; DELETE FROM public.workspaces;",
  );
});

afterAll(async () => {
  if (db && !db.closed) await db.close();
});

describe("OCR usage and derivation SQL", () => {
  it("persists derivation provenance in the immutable source manifest", async () => {
    const now = "2026-09-25T12:00:00.000Z";
    const source = {
      id: "scan-source",
      versionId: "ocr-v2",
      title: "扫描件",
      filename: "scan.pdf",
      kind: "pdf",
      mime: "application/pdf",
      size: 1,
      hash: "a".repeat(64),
      spaceIds: [],
      tags: [],
      status: "ready",
      coverage: { captureScope: "full", parseState: "complete" },
      text: "OCR 正文",
      chunks: [
        {
          id: "ocr-chunk",
          sourceId: "scan-source",
          versionId: "ocr-v2",
          text: "OCR 正文",
          section: "第 1 页",
          page: 1,
          order: 0,
        },
      ],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      aiAllowed: true,
      starred: false,
      pageCount: 1,
      parsedPages: 1,
      blobKey: "original:scan-source:ocr-v2",
      derivation: { method: "ocr-vlm-v1", fromVersionId: "scan-v1" },
    };
    const workspace = {
      schemaVersion: 1,
      spaces: [],
      sources: [source],
      notes: [],
      annotations: [],
      conversations: [],
      aiEnabled: true,
    };
    await asOwner(ownerA, "authenticated", () =>
      db.query("select public.save_workspace($1::jsonb,0)", [JSON.stringify(workspace)]),
    );
    const row = await db.query("select manifest from public.source_versions where owner_id=$1", [
      ownerA,
    ]);
    expect((row.rows[0] as { manifest?: unknown } | undefined)?.manifest).toMatchObject({
      derivation: { method: "ocr-vlm-v1", fromVersionId: "scan-v1" },
    });
  });

  it("enforces a daily page limit per owner and keeps owners isolated", async () => {
    const first = await asOwner(ownerA, "service_role", () =>
      db.query("select public.reserve_ocr_pages($1,$2,1,1) as result", [ownerA, "ocr-a-1"]),
    );
    const denied = await asOwner(ownerA, "service_role", () =>
      db.query("select public.reserve_ocr_pages($1,$2,1,1) as result", [ownerA, "ocr-a-2"]),
    );
    const otherOwner = await asOwner(ownerB, "service_role", () =>
      db.query("select public.reserve_ocr_pages($1,$2,1,1) as result", [ownerB, "ocr-b-1"]),
    );
    expect((first.rows[0] as { result?: unknown } | undefined)?.result).toEqual({ allowed: true });
    expect((denied.rows[0] as { result?: unknown } | undefined)?.result).toEqual({
      allowed: false,
    });
    expect((otherOwner.rows[0] as { result?: unknown } | undefined)?.result).toEqual({
      allowed: true,
    });
  });
});
