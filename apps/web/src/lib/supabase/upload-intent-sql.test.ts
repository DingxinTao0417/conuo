import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Source, WorkspaceData } from "../types";

// Exercise the upload reservation state machine against the real migration chain.
// PGlite stands in for PostgreSQL only; Storage byte writes themselves are represented
// by storage.objects metadata because the browser uploads directly to Supabase Storage.
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerB = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const now = "2026-09-14T12:00:00.000Z";
const sourceId = "source-upload";
const versionId = "v1";

type Role = "anon" | "authenticated" | "service_role";
type UploadReservation = {
  intentId: string;
  reservationToken?: string;
  reservationUntil?: string;
  status: "reserved" | "uploaded" | "committed";
  storagePath: string;
};
type UploadCompletion = {
  intentId: string;
  status: "uploaded" | "committed";
  storagePath: string;
};
type UploadCleanupLease = {
  attempt: number;
  intentId: string;
  leaseToken: string;
  leaseUntil: string;
  ownerId: string;
  storagePath: string;
};

let db: PGlite;

function extensionFor(kind: Source["kind"]) {
  switch (kind) {
    case "pdf":
      return "pdf";
    case "docx":
      return "docx";
    case "markdown":
      return "md";
    case "text":
      return "txt";
    case "web":
      return "html";
  }
}

function uploadSource(id = sourceId, version = versionId, patch: Partial<Source> = {}): Source {
  const kind = patch.kind ?? "markdown";
  const hash = id === sourceId ? "a".repeat(64) : "b".repeat(64);
  const size = 128;
  return {
    id,
    versionId: version,
    title: `Upload ${id}`,
    filename: `upload-${id}.${extensionFor(kind)}`,
    kind,
    mime: kind === "markdown" ? "text/markdown" : "text/plain",
    size,
    hash,
    spaceIds: ["library"],
    tags: [],
    status: "saved",
    coverage: { captureScope: "full", parseState: "pending" },
    text: "",
    chunks: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    aiAllowed: true,
    starred: false,
    blobKey: `original:${id}:${version}`,
    storagePath: `${ownerA}/${version}/${id}.${extensionFor(kind)}`,
    ...patch,
  };
}

function workspace(sources: Source[] = []): WorkspaceData {
  return {
    schemaVersion: 1,
    spaces: [
      { id: "library", name: "Library", goal: "", color: "blue", archived: false, createdAt: now },
    ],
    sources,
    notes: [],
    annotations: [],
    conversations: [],
    aiEnabled: true,
    semanticSearch: true,
  } as WorkspaceData;
}

async function asRole<T>(role: Role, owner: string | null, action: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [owner ?? ""]);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await action();
  } finally {
    await db.exec("RESET ROLE");
  }
}

async function rpc<T>(
  sql: string,
  params: unknown[] = [],
  owner: string | null = ownerA,
  role: Role = "authenticated",
): Promise<T> {
  return asRole(role, owner, async () => {
    const result = await db.query<{ result: T }>(`SELECT ${sql} AS result`, params);
    return result.rows[0]!.result;
  });
}

async function save(data: WorkspaceData, revision = 0, owner = ownerA) {
  return rpc<number>(
    "public.save_workspace($1::jsonb,$2::bigint)",
    [JSON.stringify(data), revision],
    owner,
  );
}

async function reserve(source: Source, expectedBytes = source.size): Promise<UploadReservation> {
  return rpc<UploadReservation>("public.reserve_original_upload($1,$2,$3,$4::bigint,$5,$6)", [
    source.id,
    source.versionId,
    source.kind,
    expectedBytes,
    source.hash,
    source.mime,
  ]);
}

async function complete(reservation: UploadReservation): Promise<UploadCompletion> {
  return rpc<UploadCompletion>("public.complete_original_upload($1::uuid,$2::uuid)", [
    reservation.intentId,
    reservation.reservationToken,
  ]);
}

async function insertOriginal(path: string, size: number, owner = ownerA) {
  return asRole("authenticated", owner, () =>
    db.query(
      "insert into storage.objects(bucket_id,name,metadata) values ('originals',$1,jsonb_build_object('size',$2::bigint))",
      [path, size],
    ),
  );
}

async function claimExpiredOriginalUploads(
  worker = "upload-cleanup",
  limit = 1,
  leaseSeconds = 120,
) {
  return rpc<{ intents: UploadCleanupLease[] }>(
    "public.claim_expired_original_upload_intents($1,$2,$3)",
    [worker, limit, leaseSeconds],
    null,
    "service_role",
  );
}

beforeAll(async () => {
  db = await PGlite.create("memory://", { extensions: { vector } });
  try {
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
      GRANT SELECT, INSERT, DELETE ON storage.objects TO authenticated;
    `);
    const migration = (name: string) =>
      readFile(new URL(`../../../../../supabase/migrations/${name}`, import.meta.url), "utf8");
    for (const name of [
      "202609120001_workspace_foundation.sql",
      "202609120002_ai_requests.sql",
      "202609120003_source_retrieval.sql",
      "202609120004_source_purge.sql",
      "202609120005_source_purge_cleanup.sql",
      "202609120006_account_deletion.sql",
      "202609120007_account_deletion_embedding_fence.sql",
      "202609130001_document_notes_evidence.sql",
      "202609130002_answer_attempts.sql",
      "202609130003_manual_excerpt_references.sql",
      "20260913222422_normalized_notes_projection.sql",
      "20260913233000_import_parse_leases.sql",
      "20260914000100_normalized_conversations_projection.sql",
      "20260914000200_normalized_annotations_projection.sql",
      "20260914000300_normalized_concept_relations_projection.sql",
      "20260914000400_normalized_learning_spaces_projection.sql",
      "20260914000500_source_version_purge.sql",
      "20260914000600_fix_project_workspace_space_alias.sql",
      "20260914000700_fix_project_workspace_space_alias_scope.sql",
      "20260914000800_fast_workspace_saves.sql",
      "20260914120601_upload_intents.sql",
      "20260920000100_storage_upload_preflight.sql",
    ]) {
      await db.exec(await migration(name));
    }
  } catch (error) {
    await db.close();
    throw error;
  }
}, 30_000);

beforeEach(async () => {
  await db.exec(
    "RESET ROLE; TRUNCATE public.workspaces CASCADE; TRUNCATE public.account_deletions CASCADE; TRUNCATE conuo_private.original_upload_intents; TRUNCATE public.embedding_usage; TRUNCATE storage.objects; INSERT INTO auth.users(id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),('bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb') ON CONFLICT (id) DO NOTHING; UPDATE public.embedding_profiles SET fingerprint=null; SET TIME ZONE 'UTC';",
  );
});

afterAll(async () => {
  if (db && !db.closed) await db.close();
});

describe("original upload intents", () => {
  it("accepts Storage's contentLength preflight only for the exact live owner reservation", async () => {
    const source = uploadSource();
    const reservation = await reserve(source);
    const allowed = (metadata: unknown, owner = ownerA) =>
      asRole("authenticated", owner, async () => {
        await db.exec("BEGIN");
        try {
          await db.query(
            "insert into storage.objects(bucket_id,name,metadata) values ('originals',$1,$2::jsonb)",
            [reservation.storagePath, JSON.stringify(metadata)],
          );
          return true;
        } catch (error) {
          if ((error as { code?: string }).code === "42501") return false;
          throw error;
        } finally {
          await db.exec("ROLLBACK");
        }
      });
    expect(await allowed({ mimetype: source.mime, contentLength: source.size })).toBe(true);
    expect(await allowed({ contentLength: source.size + 1 })).toBe(false);
    expect(await allowed({ contentLength: source.size }, ownerB)).toBe(false);
    expect(await allowed({})).toBe(false);
    expect(await allowed(null)).toBe(false);
    expect(await allowed({ size: "invalid", contentLength: source.size })).toBe(false);
    expect(await allowed({ size: source.size + 1, contentLength: source.size })).toBe(false);
    await db.query(
      "update conuo_private.original_upload_intents set reservation_until=clock_timestamp()-interval '1 second' where intent_id=$1::uuid",
      [reservation.intentId],
    );
    expect(await allowed({ contentLength: source.size })).toBe(false);
  });

  it("rejects direct originals writes that have no unexpired matching reservation", async () => {
    const source = uploadSource();

    await expect(insertOriginal(source.storagePath!, source.size)).rejects.toMatchObject({
      code: "42501",
    });
    expect((await db.query("select * from storage.objects")).rows).toEqual([]);
  });

  it("reuses an exact reservation but rejects an identity or size mismatch", async () => {
    const source = uploadSource();
    const first = await reserve(source);
    const again = await reserve(source);

    expect(first).toMatchObject({
      status: "reserved",
      intentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      reservationToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
      reservationUntil: expect.any(String),
      storagePath: source.storagePath,
    });
    expect(again).toMatchObject({
      status: "reserved",
      intentId: first.intentId,
      reservationToken: first.reservationToken,
      storagePath: first.storagePath,
    });
    await expect(reserve(source, source.size + 1)).rejects.toMatchObject({ code: "22023" });

    const intentRows = await db.query(
      "select intent_id, state, expected_bytes, storage_path from conuo_private.original_upload_intents",
    );
    expect(intentRows.rows).toEqual([
      {
        intent_id: first.intentId,
        state: "reserved",
        expected_bytes: source.size,
        storage_path: source.storagePath,
      },
    ]);
  });

  it("requires Storage metadata to match before completing an upload", async () => {
    const source = uploadSource();
    const reservation = await reserve(source);

    await expect(complete(reservation)).rejects.toMatchObject({ code: "22023" });
    await insertOriginal(reservation.storagePath, source.size);

    expect(await complete(reservation)).toMatchObject({
      intentId: reservation.intentId,
      status: "uploaded",
      storagePath: reservation.storagePath,
    });
    expect(await reserve(source)).toMatchObject({
      intentId: reservation.intentId,
      status: "uploaded",
      storagePath: reservation.storagePath,
    });
  });

  it("commits an uploaded original only with the successful workspace CAS", async () => {
    const source = uploadSource();
    const reservation = await reserve(source);
    await insertOriginal(reservation.storagePath, source.size);
    await complete(reservation);

    expect(await save(workspace([source]))).toBe(1);
    expect(
      (
        await db.query(
          "select state, committed_revision from conuo_private.original_upload_intents where intent_id=$1::uuid",
          [reservation.intentId],
        )
      ).rows,
    ).toEqual([{ state: "committed", committed_revision: 1 }]);
  });

  it("keeps a completed upload recoverable when its workspace CAS loses", async () => {
    expect(await save(workspace())).toBe(1);
    const source = uploadSource("source-cas");
    const reservation = await reserve(source);
    await insertOriginal(reservation.storagePath, source.size);
    await complete(reservation);

    await expect(save(workspace([source]), 0)).rejects.toMatchObject({ code: "40001" });
    expect(
      (
        await db.query(
          "select state, committed_revision from conuo_private.original_upload_intents where intent_id=$1::uuid",
          [reservation.intentId],
        )
      ).rows,
    ).toEqual([{ state: "uploaded", committed_revision: null }]);
  });

  it("makes expired uploaded originals available only through the service cleanup lease", async () => {
    const source = uploadSource();
    const reservation = await reserve(source);
    await insertOriginal(reservation.storagePath, source.size);
    await complete(reservation);
    await db.query(
      "update conuo_private.original_upload_intents set reservation_until=clock_timestamp()-interval '1 second' where intent_id=$1::uuid",
      [reservation.intentId],
    );

    const claimed = await claimExpiredOriginalUploads();
    expect(claimed.intents).toEqual([
      expect.objectContaining({
        intentId: reservation.intentId,
        ownerId: ownerA,
        storagePath: reservation.storagePath,
        leaseToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
        leaseUntil: expect.any(String),
        attempt: 1,
      }),
    ]);
    expect(
      (
        await db.query(
          "select state from conuo_private.original_upload_intents where intent_id=$1::uuid",
          [reservation.intentId],
        )
      ).rows,
    ).toEqual([{ state: "processing" }]);
  });
});
