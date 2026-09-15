import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Note, Source, WorkspaceData } from "../types";

// Real migrations and pgvector on one ephemeral PostgreSQL connection. This does not simulate
// PostgREST, Supabase Storage, provider quality, or cross-connection SKIP LOCKED contention.
let db: PGlite;
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const profile = "a".repeat(64);
const otherProfile = "b".repeat(64);
const now = "2026-09-12T12:00:00.000Z";
const later = "2026-09-12T12:01:00.000Z";
type Role = "authenticated" | "anon" | "service_role";
type Job = {
  jobId: string;
  ownerId: string;
  sourceId: string;
  versionId: string;
  leaseToken: string;
  cursor: number;
  totalChunks: number;
  attempt: number;
  state?: string;
};
type Batch = {
  jobId: string;
  ownerId: string;
  cursor: number;
  totalChunks: number;
  chunks: { chunkId: string; text: string; contentHash: string; ordinal: number }[];
};
type Hit = {
  source_id: string;
  version_id: string;
  chunk_id: string | null;
  title: string;
  text: string | null;
  ordinal: number | null;
  coverage_status: string;
  workspace_revision: number;
  distance?: number;
};
type SourcePurgePreview = {
  revision: number;
  fingerprint: string;
  impact: {
    source: { id: string; title: string; deletedAt: string };
    versions: number;
    annotations: number;
    blockingAnnotations: number;
    retainedNotes: number;
    retainedNoteCitations: number;
    retainedConversations: number;
    retainedConversationCitations: number;
    organizationJobs: number;
    pendingOrganizationJobs: number;
    conceptRelations: number;
    blockingConceptRelations: number;
    importJobs: number;
    localOriginals: number;
    cloudOriginals: number;
  };
  blockers: { annotations: string[]; conceptRelations: string[] };
};
type SourcePurgeResult = {
  revision: number;
  data: WorkspaceData;
  purgeId: string;
  cleanupPending: boolean;
};
type SourceVersionPurgePreview = {
  revision: number;
  fingerprint: string;
  impact: {
    source: { id: string; title: string };
    version: { versionId: string; filename: string; createdAt: string; archivedAt: string };
    annotations: number;
    blockingAnnotations: number;
    retainedNotes: number;
    retainedNoteCitations: number;
    retainedConversations: number;
    retainedConversationCitations: number;
    organizationJobs: number;
    blockingOrganizationJobs: number;
    conceptRelations: number;
    blockingConceptRelations: number;
    importJobs: number;
    blockingImportJobs: number;
    localOriginals: number;
    cloudOriginals: number;
  };
  blockers: {
    annotations: string[];
    conceptRelations: string[];
    organizationJobs: string[];
    importJobs: string[];
  };
};
type SourceVersionPurgeResult = SourcePurgeResult;
type SourcePurgeObjectLease = {
  purgeId: string;
  ownerId: string;
  storagePath: string;
  leaseToken: string;
  leaseUntil: string;
  attempt: number;
};
type AccountDeletionPreview = {
  state: string | null;
  sources: number;
  versions: number;
  notes: number;
  conversations: number;
  annotations: number;
  spaces: number;
  currentStorageObjects: number;
  pendingSourcePurgeObjects: number;
  totalStorageObjects: number;
};
type AccountDeletionPrepare = {
  deletionId: string;
  state: string;
  storageObjects: number;
  readyForAuthDeletion: boolean;
};
type AccountDeletionObjectLease = {
  deletionId: string;
  ownerId: string;
  bucketId: string;
  storagePath: string;
  leaseToken: string;
  leaseUntil: string;
  attempt: number;
};
type AccountAuthDeletionLease = {
  deletionId: string;
  ownerId: string;
  leaseToken: string;
  leaseUntil: string;
  attempt: number;
};
let backfilled = 0;
let backfilledLearningSpaces = 0;

function source(id = "source-a", versionId = "v1", count = 2): Source {
  const texts = Array.from(
    { length: count },
    (_, i) => `梯度 descent passage ${id} version ${versionId} part ${i}。`,
  );
  return {
    id,
    versionId,
    title: `资料 ${id}`,
    filename: "paper.md",
    kind: "markdown",
    mime: "text/markdown",
    size: 100,
    hash: "legacy-not-sha",
    spaceIds: ["library"],
    tags: ["数学"],
    status: "ready",
    text: texts.join("\n\n"),
    chunks: texts.map((text, i) => ({
      id: `c${i}`,
      sourceId: id,
      versionId,
      text,
      section: `章节 ${i}`,
      page: i + 1,
      order: i * 3,
    })),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    aiAllowed: true,
    starred: false,
  };
}
function workspace(sources = [source()], semantic = true): WorkspaceData {
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
    semanticSearch: semantic,
  } as WorkspaceData;
}
function note(id = "note-a", patch: Partial<Note> = {}): Note {
  return {
    id,
    spaceId: "library",
    title: `笔记 ${id}`,
    content: `这是 ${id} 的正文。`,
    kind: "note",
    status: "accepted",
    citations: [],
    versions: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...patch,
  };
}
function annotation(
  id = "annotation-a",
  patch: Partial<WorkspaceData["annotations"][number]> = {},
): WorkspaceData["annotations"][number] {
  return {
    id,
    sourceId: "source-a",
    versionId: "v1",
    quote: "梯度下降中的学习率",
    note: "需要继续复习。",
    page: 1,
    createdAt: now,
    ...patch,
  };
}
function conversation(
  id = "conversation-a",
  attemptId = "attempt-a",
): WorkspaceData["conversations"][number] {
  const questionId = `${id}-question`;
  return {
    id,
    spaceId: "library",
    sourceId: "source-a",
    title: `对话 ${id}`,
    scope: "document",
    sourceIds: ["source-a"],
    messages: [
      {
        id: questionId,
        role: "user",
        content: "学习率过高会怎样？",
        citations: [],
        createdAt: now,
      },
      {
        id: `${id}-answer`,
        role: "assistant",
        content: "可能导致训练振荡。",
        citations: [],
        noteEvidence: [],
        createdAt: now,
        mode: "extractive",
        attempt: {
          id: attemptId,
          questionMessageId: questionId,
          scopeSnapshot: {
            scope: "document",
            sourceId: "source-a",
            sourceIds: ["source-a"],
            spaceId: "library",
          },
          status: "completed",
        },
      },
    ],
    resolved: false,
    updatedAt: now,
  };
}
function archived(s: Source) {
  return {
    versionId: s.versionId,
    title: s.title,
    filename: s.filename,
    kind: s.kind,
    mime: s.mime,
    size: s.size,
    hash: s.hash,
    status: s.status,
    text: s.text,
    chunks: structuredClone(s.chunks),
    blobKey: s.blobKey,
    storagePath: s.storagePath,
    createdAt: s.createdAt,
    archivedAt: now,
  };
}
function recycledSource(id = "source-a", versionId = "v1", owner = ownerA): Source {
  const current = source(id, versionId);
  current.deletedAt = now;
  current.blobKey = `original:${id}:${versionId}`;
  current.storagePath = `${owner}/${versionId}/${id}.md`;
  const historical = archived(source(id, "v0"));
  historical.blobKey = `original:${id}:v0`;
  historical.storagePath = `${owner}/v0/${id}.md`;
  current.versions = [historical];
  return current;
}
function purgeCitation(sourceId = "source-a", versionId = "v1") {
  return {
    sourceId,
    versionId,
    chunkId: "c0",
    title: `资料 ${sourceId}`,
    quote: `梯度 descent passage ${sourceId} version ${versionId} part 0。`,
    section: "章节 0",
    page: 1,
  };
}
type ProjectedConceptRelation = NonNullable<WorkspaceData["conceptRelations"]>[number];
function conceptRelation(
  id = "relation-a",
  patch: Partial<ProjectedConceptRelation> = {},
): ProjectedConceptRelation {
  const citation = purgeCitation();
  return {
    id,
    spaceId: "library",
    type: "related",
    fromClaim: "学习率决定参数更新步长。",
    toClaim: "优化稳定性取决于更新步长。",
    fromCondition: "",
    toCondition: "",
    explanation: "两个知识点都涉及训练过程的稳定性。",
    fromCitations: [citation],
    toCitations: [],
    from: {
      id: "knowledge-a",
      spaceId: "library",
      title: "学习率",
      content: "学习率决定参数更新步长。",
      citations: [citation],
      status: "accepted",
      aiGenerated: false,
      revision: 1,
      updatedAt: now,
    },
    to: {
      id: "knowledge-b",
      spaceId: "library",
      title: "优化稳定性",
      content: "优化稳定性取决于更新步长。",
      citations: [],
      status: "accepted",
      aiGenerated: false,
      revision: 1,
      updatedAt: now,
    },
    origin: "manual",
    revision: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...patch,
  };
}
function vec(axis = 0): number[] {
  return Array.from({ length: 1536 }, (_, i) => (i === axis ? 1 : 0));
}

async function asRole<T>(role: Role, owner: string | null, run: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [owner ?? ""]);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec("RESET ROLE");
  }
}
async function rpc<T>(
  sql: string,
  params: unknown[] = [],
  role: Role = "service_role",
  owner: string | null = null,
): Promise<T> {
  return asRole(
    role,
    owner,
    async () => (await db.query<{ result: T }>(`SELECT ${sql} AS result`, params)).rows[0].result,
  );
}
async function save(data = workspace(), revision = 0, owner = ownerA) {
  return rpc<number>(
    "public.save_workspace($1::jsonb,$2::bigint)",
    [JSON.stringify(data), revision],
    "authenticated",
    owner,
  );
}
async function previewSourcePurge(sourceId = "source-a", owner = ownerA) {
  return rpc<SourcePurgePreview>(
    "public.preview_source_purge($1)",
    [sourceId],
    "authenticated",
    owner,
  );
}
async function requestSourcePurge(
  preview: Pick<SourcePurgePreview, "revision" | "fingerprint">,
  sourceId = "source-a",
  owner = ownerA,
) {
  return rpc<SourcePurgeResult>(
    "public.request_source_purge($1,$2::bigint,$3)",
    [sourceId, preview.revision, preview.fingerprint],
    "authenticated",
    owner,
  );
}
async function previewSourceVersionPurge(sourceId = "source-a", versionId = "v0", owner = ownerA) {
  return rpc<SourceVersionPurgePreview>(
    "public.preview_source_version_purge($1,$2)",
    [sourceId, versionId],
    "authenticated",
    owner,
  );
}
async function requestSourceVersionPurge(
  preview: Pick<SourceVersionPurgePreview, "revision" | "fingerprint">,
  sourceId = "source-a",
  versionId = "v0",
  owner = ownerA,
) {
  return rpc<SourceVersionPurgeResult>(
    "public.request_source_version_purge($1,$2,$3::bigint,$4)",
    [sourceId, versionId, preview.revision, preview.fingerprint],
    "authenticated",
    owner,
  );
}
async function claimSourcePurgeObjects(worker = "purge-worker", limit = 1, leaseSeconds = 120) {
  return rpc<{ objects: SourcePurgeObjectLease[] }>("public.claim_source_purge_objects($1,$2,$3)", [
    worker,
    limit,
    leaseSeconds,
  ]);
}
async function heartbeatSourcePurgeObject(object: SourcePurgeObjectLease, leaseSeconds = 120) {
  return rpc<{ leaseUntil: string }>(
    "public.heartbeat_source_purge_object($1::uuid,$2,$3::uuid,$4)",
    [object.purgeId, object.storagePath, object.leaseToken, leaseSeconds],
  );
}
async function completeSourcePurgeObject(object: SourcePurgeObjectLease) {
  return rpc<{ state: string; purgeState: string; completedAt: string }>(
    "public.complete_source_purge_object($1::uuid,$2,$3::uuid)",
    [object.purgeId, object.storagePath, object.leaseToken],
  );
}
async function failSourcePurgeObject(
  object: SourcePurgeObjectLease,
  errorCode: string,
  retryable = true,
) {
  return rpc<{ state: string; purgeState: string; nextAttemptAt: string | null }>(
    "public.fail_source_purge_object($1::uuid,$2,$3::uuid,$4,$5)",
    [object.purgeId, object.storagePath, object.leaseToken, errorCode, retryable],
  );
}
async function previewAccountDeletion(owner = ownerA) {
  return rpc<AccountDeletionPreview>(
    "public.preview_account_deletion()",
    [],
    "authenticated",
    owner,
  );
}
async function accountDeletionAccessStatus(owner = ownerA) {
  return rpc<{ allowed: boolean; state: string | null }>(
    "public.account_deletion_access_status()",
    [],
    "authenticated",
    owner,
  );
}
async function prepareAccountDeletion(owner = ownerA) {
  return rpc<AccountDeletionPrepare>("public.prepare_account_deletion($1::uuid)", [owner]);
}
async function claimAccountDeletionObjects(
  worker = "account-worker",
  limit = 1,
  leaseSeconds = 120,
) {
  return rpc<{ objects: AccountDeletionObjectLease[] }>(
    "public.claim_account_deletion_objects($1,$2,$3)",
    [worker, limit, leaseSeconds],
  );
}
async function heartbeatAccountDeletionObject(
  object: AccountDeletionObjectLease,
  leaseSeconds = 120,
) {
  return rpc<{ leaseUntil: string }>(
    "public.heartbeat_account_deletion_object($1::uuid,$2,$3,$4::uuid,$5)",
    [object.deletionId, object.bucketId, object.storagePath, object.leaseToken, leaseSeconds],
  );
}
async function completeAccountDeletionObject(object: AccountDeletionObjectLease) {
  return rpc<{ state: string; deletionState: string; completedAt: string }>(
    "public.complete_account_deletion_object($1::uuid,$2,$3,$4::uuid)",
    [object.deletionId, object.bucketId, object.storagePath, object.leaseToken],
  );
}
async function failAccountDeletionObject(
  object: AccountDeletionObjectLease,
  errorCode: string,
  retryable = true,
) {
  return rpc<{ state: string; deletionState: string; nextAttemptAt: string | null }>(
    "public.fail_account_deletion_object($1::uuid,$2,$3,$4::uuid,$5,$6)",
    [
      object.deletionId,
      object.bucketId,
      object.storagePath,
      object.leaseToken,
      errorCode,
      retryable,
    ],
  );
}
async function claimReadyAccountAuthDeletions(
  worker = "account-worker",
  limit = 1,
  leaseSeconds = 60,
) {
  return rpc<{ deletions: AccountAuthDeletionLease[] }>(
    "public.claim_ready_account_auth_deletions($1,$2,$3)",
    [worker, limit, leaseSeconds],
  );
}
async function heartbeatAccountAuthDeletion(deletion: AccountAuthDeletionLease, leaseSeconds = 60) {
  return rpc<{ leaseUntil: string }>(
    "public.heartbeat_account_auth_deletion($1::uuid,$2::uuid,$3)",
    [deletion.deletionId, deletion.leaseToken, leaseSeconds],
  );
}
async function completeAccountAuthDeletion(deletion: AccountAuthDeletionLease) {
  return rpc<{ state: string; completedAt?: string; storageReopened: boolean }>(
    "public.complete_account_auth_deletion($1::uuid,$2::uuid)",
    [deletion.deletionId, deletion.leaseToken],
  );
}
async function failAccountAuthDeletion(
  deletion: AccountAuthDeletionLease,
  errorCode: string,
  retryable = true,
) {
  return rpc<{ state: string; nextAttemptAt: string | null }>(
    "public.fail_account_auth_deletion($1::uuid,$2::uuid,$3,$4)",
    [deletion.deletionId, deletion.leaseToken, errorCode, retryable],
  );
}
async function retryAccountDeletion(deletionId: string) {
  return rpc<{ state: string; retriedStorageObjects: number }>(
    "public.retry_account_deletion($1::uuid)",
    [deletionId],
  );
}
async function claim(fingerprint = profile, limit = 1) {
  return rpc<{ jobs: Job[] }>("public.claim_embedding_jobs('worker-1',$1,$2,120)", [
    fingerprint,
    limit,
  ]);
}
async function read(job: Job, limit = 32) {
  return rpc<Batch>("public.read_embedding_batch($1::uuid,$2::uuid,$3)", [
    job.jobId,
    job.leaseToken,
    limit,
  ]);
}
function rows(batch: Batch, axis = 0) {
  return batch.chunks.map((c) => ({
    chunkId: c.chunkId,
    contentHash: c.contentHash,
    embedding: vec(axis),
  }));
}
async function commit(job: Job, batch: Batch, values = rows(batch)) {
  return rpc<{ cursor: number; totalChunks: number; state: string }>(
    "public.commit_embedding_batch($1::uuid,$2::uuid,$3,$4::jsonb)",
    [job.jobId, job.leaseToken, batch.cursor, JSON.stringify(values)],
  );
}
async function finish(job: Job) {
  return rpc<{ state: string }>("public.finish_embedding_job($1::uuid,$2::uuid)", [
    job.jobId,
    job.leaseToken,
  ]);
}
async function control(job: Job, action: string, owner = ownerA) {
  return rpc<{ state: string }>(
    "public.control_embedding_job($1::uuid,$2)",
    [job.jobId, action],
    "authenticated",
    owner,
  );
}
async function lexical(
  query = "梯度",
  scope = "*",
  ai = false,
  owner = ownerA,
  ids: string[] | null = null,
) {
  return asRole(
    "authenticated",
    owner,
    async () =>
      (
        await db.query<Hit>("SELECT * FROM public.search_source_chunks($1,$2,$3::text[],$4,100)", [
          query,
          scope,
          ids,
          ai,
        ])
      ).rows,
  );
}
async function semantic(
  owner = ownerA,
  fingerprint = profile,
  scope = "*",
  axis = 0,
  ids: string[] | null = null,
) {
  return asRole(
    "authenticated",
    owner,
    async () =>
      (
        await db.query<Hit>(
          "SELECT * FROM public.semantic_source_chunks($1::jsonb,$2,$3,$4::text[],100)",
          [JSON.stringify(vec(axis)), scope, fingerprint, ids],
        )
      ).rows,
  );
}
async function status(owner = ownerA) {
  return rpc<{ jobs: Job[] }>("public.embedding_job_status()", [], "authenticated", owner);
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
    CREATE TABLE storage.objects(bucket_id text,name text);
    -- Hosted Supabase provisions RLS on this platform-owned table before app migrations.
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array($1,'/') $$;
    GRANT USAGE ON SCHEMA storage TO anon,authenticated,service_role;
    GRANT SELECT, INSERT, DELETE ON storage.objects TO authenticated;
  `);
  const migration = (name: string) =>
    readFile(new URL(`../../../../../supabase/migrations/${name}`, import.meta.url), "utf8");
  await db.exec(await migration("202609120001_workspace_foundation.sql"));
  await db.exec(await migration("202609120002_ai_requests.sql"));
  await save(workspace(), 0, ownerB);
  await db.exec(await migration("202609120003_source_retrieval.sql"));
  await db.exec(await migration("202609120004_source_purge.sql"));
  await db.exec(await migration("202609120005_source_purge_cleanup.sql"));
  await db.exec(await migration("202609120006_account_deletion.sql"));
  await db.exec(await migration("202609120007_account_deletion_embedding_fence.sql"));
  await db.exec(await migration("202609130001_document_notes_evidence.sql"));
  await db.exec(await migration("202609130002_answer_attempts.sql"));
  await db.exec(await migration("202609130003_manual_excerpt_references.sql"));
  await db.exec(await migration("20260913222422_normalized_notes_projection.sql"));
  await db.exec(await migration("20260913233000_import_parse_leases.sql"));
  await db.exec(await migration("20260914000100_normalized_conversations_projection.sql"));
  await db.exec(await migration("20260914000200_normalized_annotations_projection.sql"));
  await db.exec(await migration("20260914000300_normalized_concept_relations_projection.sql"));
  await db.exec(await migration("20260914000400_normalized_learning_spaces_projection.sql"));
  await db.exec(await migration("20260914000500_source_version_purge.sql"));
  await db.exec(await migration("20260914000600_fix_project_workspace_space_alias.sql"));
  await db.exec(await migration("20260914000700_fix_project_workspace_space_alias_scope.sql"));
  await db.exec(await migration("20260914000800_fast_workspace_saves.sql"));
  backfilled = (await db.query("SELECT * FROM public.source_chunks")).rows.length;
  backfilledLearningSpaces = (
    await db.query("SELECT * FROM public.learning_spaces WHERE owner_id=$1", [ownerB])
  ).rows.length;
}, 30_000);
beforeEach(async () => {
  await db.exec(
    "RESET ROLE; TRUNCATE public.workspaces CASCADE; TRUNCATE public.account_deletions CASCADE; TRUNCATE public.embedding_usage; TRUNCATE storage.objects; INSERT INTO auth.users(id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') ON CONFLICT (id) DO NOTHING; UPDATE public.embedding_profiles SET fingerprint=null; SET TIME ZONE 'UTC';",
  );
});

describe("fast workspace save projections", () => {
  it("keeps every blocking owner-lock caller behind the post-lock deletion fence", async () => {
    const { rows } = await db.query<{ definition: string }>(
      "SELECT pg_get_functiondef('conuo_private.owner_lock(uuid)'::regprocedure) AS definition",
    );
    const definition = rows[0]!.definition;
    const guard = "perform conuo_private.assert_account_access(p_owner);";
    const firstGuard = definition.indexOf(guard);
    const lock = definition.indexOf("pg_catalog.pg_advisory_xact_lock(");
    const secondGuard = definition.indexOf(guard, firstGuard + guard.length);

    expect(firstGuard).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(firstGuard);
    expect(secondGuard).toBeGreaterThan(lock);
    expect(definition).toContain("'conuo:source:' || p_owner::text");
  });

  it("skips every unchanged projection for reading progress and still projects source changes", async () => {
    const initial = workspace();
    initial.notes = [note()];
    initial.annotations = [annotation()];
    initial.conversations = [conversation()];
    initial.conceptRelations = [conceptRelation()];
    expect(await save(initial)).toBe(1);

    await db.exec(`
      DELETE FROM public.learning_spaces;
      DELETE FROM public.concept_relations;
      DELETE FROM public.annotations;
      DELETE FROM public.conversations;
      DELETE FROM public.notes;
      DELETE FROM public.sources;
    `);

    const reading = structuredClone(initial);
    reading.sources[0]!.readPage = 2;
    reading.sources[0]!.readOffset = 0.25;
    reading.sources[0]!.lastReadAt = later;
    expect(await save(reading, 1)).toBe(2);

    expect(
      (
        await db.query(`
          SELECT
            (SELECT count(*)::int FROM public.learning_spaces) AS spaces,
            (SELECT count(*)::int FROM public.concept_relations) AS relations,
            (SELECT count(*)::int FROM public.annotations) AS annotations,
            (SELECT count(*)::int FROM public.conversations) AS conversations,
            (SELECT count(*)::int FROM public.conversation_messages) AS messages,
            (SELECT count(*)::int FROM public.notes) AS notes,
            (SELECT count(*)::int FROM public.note_versions) AS note_versions,
            (SELECT count(*)::int FROM public.sources) AS sources,
            (SELECT count(*)::int FROM public.source_versions) AS source_versions,
            (SELECT count(*)::int FROM public.source_chunks) AS source_chunks,
            (SELECT count(*)::int FROM public.embedding_jobs) AS embedding_jobs
        `)
      ).rows,
    ).toEqual([
      {
        spaces: 0,
        relations: 0,
        annotations: 0,
        conversations: 0,
        messages: 0,
        notes: 0,
        note_versions: 0,
        sources: 0,
        source_versions: 0,
        source_chunks: 0,
        embedding_jobs: 0,
      },
    ]);
    expect(
      (
        await db.query(
          "SELECT revision,data #>> '{sources,0,lastReadAt}' AS last_read_at FROM public.workspaces WHERE owner_id=$1",
          [ownerA],
        )
      ).rows,
    ).toEqual([{ revision: 2, last_read_at: later }]);

    const changed = structuredClone(reading);
    changed.sources[0]!.title = "Changed source title";
    expect(await save(changed, 2)).toBe(3);
    expect(
      (await db.query("SELECT title FROM public.sources WHERE owner_id=$1", [ownerA])).rows,
    ).toEqual([{ title: "Changed source title" }]);
  });

  it("keeps legacy semanticSearch absence distinct from invalid JSON null", async () => {
    const legacy = workspace([]);
    delete legacy.semanticSearch;
    expect(await save(legacy)).toBe(1);

    const invalid = structuredClone(legacy) as unknown as Record<string, unknown>;
    invalid.semanticSearch = null;
    await expect(save(invalid as unknown as WorkspaceData, 1)).rejects.toMatchObject({
      code: "22023",
    });
    expect(
      (await db.query("SELECT revision FROM public.workspaces WHERE owner_id=$1", [ownerA])).rows,
    ).toEqual([{ revision: 1 }]);
  });
});

describe("normalized learning space projection", () => {
  it("preserves shelf order, isolates reads, and cascades with its workspace owner", async () => {
    expect(backfilledLearningSpaces).toBe(1);
    const data = workspace([]);
    data.spaces = [
      {
        id: "library",
        name: "机器学习",
        goal: "完成基础课程",
        color: "violet",
        archived: false,
        createdAt: now,
      },
      {
        id: "archive",
        name: "历史资料",
        goal: "",
        color: "slate",
        archived: true,
        createdAt: later,
      },
    ];
    await save(data);

    expect(
      (
        await asRole("authenticated", ownerA, async () =>
          db.query<{
            space_id: string;
            ordinal: number;
            name: string;
            goal: string;
            color: string;
            archived: boolean;
          }>(
            "SELECT space_id,ordinal,name,goal,color,archived FROM public.learning_spaces ORDER BY ordinal",
          ),
        )
      ).rows,
    ).toEqual([
      {
        space_id: "library",
        ordinal: 0,
        name: "机器学习",
        goal: "完成基础课程",
        color: "violet",
        archived: false,
      },
      {
        space_id: "archive",
        ordinal: 1,
        name: "历史资料",
        goal: "",
        color: "slate",
        archived: true,
      },
    ]);
    expect(
      (
        await asRole("authenticated", ownerB, async () =>
          db.query("SELECT space_id FROM public.learning_spaces"),
        )
      ).rows,
    ).toEqual([]);
    await expect(
      asRole("authenticated", ownerA, async () =>
        db.query("UPDATE public.learning_spaces SET name='forged' WHERE space_id='library'"),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await prepareAccountDeletion(ownerA);
    expect(
      (
        await asRole("authenticated", ownerA, async () =>
          db.query("SELECT space_id FROM public.learning_spaces"),
        )
      ).rows,
    ).toEqual([]);

    await db.query("DELETE FROM auth.users WHERE id=$1", [ownerA]);
    expect((await db.query("SELECT space_id FROM public.learning_spaces")).rows).toEqual([]);
  });

  it("updates shelf order and prunes spaces only after a successful compare-and-swap", async () => {
    const initial = workspace([]);
    initial.spaces.push({
      id: "second",
      name: "第二知识库",
      goal: "复习",
      color: "amber",
      archived: false,
      createdAt: later,
    });
    expect(await save(initial)).toBe(1);

    const changedIdentity = structuredClone(initial);
    changedIdentity.spaces[0]!.createdAt = later;
    await expect(save(changedIdentity, 1)).rejects.toMatchObject({ code: "22023" });

    const changed = structuredClone(initial);
    changed.spaces.reverse();
    changed.spaces[0]!.name = "第二知识库（归档）";
    changed.spaces[0]!.archived = true;
    expect(await save(changed, 1)).toBe(2);
    await expect(save(initial, 1)).rejects.toMatchObject({ code: "40001" });
    expect(
      (
        await db.query<{ space_id: string; ordinal: number; name: string; archived: boolean }>(
          "SELECT space_id,ordinal,name,archived FROM public.learning_spaces ORDER BY ordinal",
        )
      ).rows,
    ).toEqual([
      { space_id: "second", ordinal: 0, name: "第二知识库（归档）", archived: true },
      { space_id: "library", ordinal: 1, name: "Library", archived: false },
    ]);

    const pruned = structuredClone(changed);
    pruned.spaces = pruned.spaces.filter((space) => space.id !== "second");
    expect(await save(pruned, 2)).toBe(3);
    expect(
      (
        await db.query<{ space_id: string; ordinal: number }>(
          "SELECT space_id,ordinal FROM public.learning_spaces",
        )
      ).rows,
    ).toEqual([{ space_id: "library", ordinal: 0 }]);
  });

  it("rejects reserved or duplicate space identities without leaving partial projections", async () => {
    for (const invalidSpaces of [
      [{ ...workspace([]).spaces[0]!, id: "inbox" }],
      [workspace([]).spaces[0]!, workspace([]).spaces[0]!],
    ]) {
      const malformed = workspace([]);
      malformed.spaces = structuredClone(invalidSpaces);
      await expect(save(malformed)).rejects.toMatchObject({ code: "22023" });
      expect(
        (await db.query("SELECT owner_id FROM public.workspaces WHERE owner_id=$1", [ownerA])).rows,
      ).toEqual([]);
      expect((await db.query("SELECT space_id FROM public.learning_spaces")).rows).toEqual([]);
    }
  });
});

describe("normalized note projection", () => {
  it("preserves snapshot nullability, isolates reads, and cascades with its workspace owner", async () => {
    const data = workspace();
    data.notes = [
      note("note-a", {
        versions: [
          {
            id: "note-a-v1",
            title: "旧标题",
            content: "旧正文",
            savedAt: now,
          },
        ],
      }),
    ];
    await save(data);

    expect(
      (
        await db.query<{
          note_id: string;
          ai_generated: boolean | null;
          content_revision: string | null;
          citations: string;
          manual_excerpt_refs: string | null;
        }>(
          "SELECT note_id,ai_generated,content_revision::text,citations::text,manual_excerpt_refs::text FROM public.notes",
        )
      ).rows,
    ).toEqual([
      {
        note_id: "note-a",
        ai_generated: null,
        content_revision: null,
        citations: "[]",
        manual_excerpt_refs: null,
      },
    ]);
    expect(
      (
        await db.query<{
          version_id: string;
          ordinal: number;
          citations: string | null;
          ai_generated: boolean | null;
          manual_excerpt_refs: string | null;
        }>(
          "SELECT version_id,ordinal,citations::text,ai_generated,manual_excerpt_refs::text FROM public.note_versions",
        )
      ).rows,
    ).toEqual([
      {
        version_id: "note-a-v1",
        ordinal: 0,
        citations: null,
        ai_generated: null,
        manual_excerpt_refs: null,
      },
    ]);
    expect(
      (
        await asRole("authenticated", ownerA, async () =>
          db.query<{ note_id: string }>("SELECT note_id FROM public.notes"),
        )
      ).rows,
    ).toEqual([{ note_id: "note-a" }]);
    expect(
      (
        await asRole("authenticated", ownerB, async () =>
          db.query<{ note_id: string }>("SELECT note_id FROM public.notes"),
        )
      ).rows,
    ).toEqual([]);
    await expect(
      asRole("authenticated", ownerA, async () =>
        db.query("UPDATE public.notes SET title='forged' WHERE note_id='note-a'"),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await prepareAccountDeletion(ownerA);
    expect(
      (
        await asRole("authenticated", ownerA, async () =>
          db.query<{ note_id: string }>("SELECT note_id FROM public.notes"),
        )
      ).rows,
    ).toEqual([]);

    await db.query("DELETE FROM auth.users WHERE id=$1", [ownerA]);
    expect((await db.query("SELECT note_id FROM public.notes")).rows).toEqual([]);
    expect((await db.query("SELECT version_id FROM public.note_versions")).rows).toEqual([]);
  });

  it("updates and prunes only after a successful snapshot compare-and-swap", async () => {
    const initial = workspace();
    initial.notes = [
      note("note-a", {
        versions: [
          { id: "note-a-v1", title: "第一版", content: "第一版正文", savedAt: now },
          { id: "note-a-v2", title: "第二版", content: "第二版正文", savedAt: now },
        ],
      }),
    ];
    expect(await save(initial)).toBe(1);

    const changed = structuredClone(initial);
    changed.notes[0]!.content = "更新后的正文。";
    changed.notes[0]!.updatedAt = "2026-09-12T12:01:00.000Z";
    changed.notes[0]!.versions.reverse();
    expect(await save(changed, 1)).toBe(2);
    await expect(save(initial, 1)).rejects.toMatchObject({ code: "40001" });
    expect(
      (
        await db.query<{ content: string }>(
          "SELECT content FROM public.notes WHERE note_id='note-a'",
        )
      ).rows,
    ).toEqual([{ content: "更新后的正文。" }]);
    expect(
      (
        await db.query<{ version_id: string; ordinal: number }>(
          "SELECT version_id,ordinal FROM public.note_versions ORDER BY ordinal",
        )
      ).rows,
    ).toEqual([
      { version_id: "note-a-v2", ordinal: 0 },
      { version_id: "note-a-v1", ordinal: 1 },
    ]);

    const removed = structuredClone(changed);
    removed.notes = [];
    expect(await save(removed, 2)).toBe(3);
    expect((await db.query("SELECT note_id FROM public.notes")).rows).toEqual([]);
    expect((await db.query("SELECT version_id FROM public.note_versions")).rows).toEqual([]);
  });

  it("rejects malformed snapshot notes without leaving a partial workspace projection", async () => {
    const malformed = workspace();
    malformed.notes = [{ id: "missing-fields" } as Note];

    await expect(save(malformed)).rejects.toMatchObject({ code: "22023" });
    expect(
      (await db.query("SELECT owner_id FROM public.workspaces WHERE owner_id=$1", [ownerA])).rows,
    ).toEqual([]);
    expect((await db.query("SELECT note_id FROM public.notes")).rows).toEqual([]);
    expect((await db.query("SELECT version_id FROM public.note_versions")).rows).toEqual([]);
  });
});

describe("normalized conversation projection", () => {
  it("preserves ordered message evidence, isolates reads, and cascades with its owner", async () => {
    const data = workspace();
    data.conversations = [conversation()];
    await save(data);

    expect(
      (
        await db.query<{
          conversation_id: string;
          scope: string;
          source_ids: string;
          resolved: boolean;
        }>("SELECT conversation_id,scope,source_ids::text,resolved FROM public.conversations")
      ).rows,
    ).toEqual([
      {
        conversation_id: "conversation-a",
        scope: "document",
        source_ids: '["source-a"]',
        resolved: false,
      },
    ]);
    expect(
      (
        await db.query<{
          message_id: string;
          ordinal: number;
          note_evidence: string | null;
          attempt_id: string | null;
          question_message_id: string | null;
          attempt_status: string | null;
        }>(
          "SELECT message_id,ordinal,note_evidence::text,attempt_id,question_message_id,attempt_status FROM public.conversation_messages ORDER BY ordinal",
        )
      ).rows,
    ).toEqual([
      {
        message_id: "conversation-a-question",
        ordinal: 0,
        note_evidence: null,
        attempt_id: null,
        question_message_id: null,
        attempt_status: null,
      },
      {
        message_id: "conversation-a-answer",
        ordinal: 1,
        note_evidence: "[]",
        attempt_id: "attempt-a",
        question_message_id: "conversation-a-question",
        attempt_status: "completed",
      },
    ]);

    expect(
      (
        await asRole("authenticated", ownerA, async () =>
          db.query<{ conversation_id: string }>("SELECT conversation_id FROM public.conversations"),
        )
      ).rows,
    ).toEqual([{ conversation_id: "conversation-a" }]);
    expect(
      (
        await asRole("authenticated", ownerB, async () =>
          db.query<{ conversation_id: string }>("SELECT conversation_id FROM public.conversations"),
        )
      ).rows,
    ).toEqual([]);
    await expect(
      asRole("authenticated", ownerA, async () =>
        db.query(
          "UPDATE public.conversation_messages SET content='forged' WHERE message_id='conversation-a-answer'",
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await prepareAccountDeletion(ownerA);
    expect(
      (
        await asRole("authenticated", ownerA, async () =>
          db.query<{ conversation_id: string }>("SELECT conversation_id FROM public.conversations"),
        )
      ).rows,
    ).toEqual([]);

    await db.query("DELETE FROM auth.users WHERE id=$1", [ownerA]);
    expect((await db.query("SELECT conversation_id FROM public.conversations")).rows).toEqual([]);
    expect((await db.query("SELECT message_id FROM public.conversation_messages")).rows).toEqual(
      [],
    );
  });

  it("updates and prunes messages only after a successful snapshot compare-and-swap", async () => {
    const initial = workspace();
    initial.conversations = [conversation()];
    expect(await save(initial)).toBe(1);

    const changed = structuredClone(initial);
    changed.conversations[0]!.title = "更新后的对话";
    changed.conversations[0]!.resolved = true;
    changed.conversations[0]!.updatedAt = "2026-09-12T12:01:00.000Z";
    changed.conversations[0]!.messages[1]!.content = "更新后的回答。";
    expect(await save(changed, 1)).toBe(2);
    await expect(save(initial, 1)).rejects.toMatchObject({ code: "40001" });

    expect(
      (
        await db.query<{ title: string; resolved: boolean }>(
          "SELECT title,resolved FROM public.conversations WHERE conversation_id='conversation-a'",
        )
      ).rows,
    ).toEqual([{ title: "更新后的对话", resolved: true }]);
    expect(
      (
        await db.query<{ content: string }>(
          "SELECT content FROM public.conversation_messages WHERE message_id='conversation-a-answer'",
        )
      ).rows,
    ).toEqual([{ content: "更新后的回答。" }]);

    const withoutAnswer = structuredClone(changed);
    withoutAnswer.conversations[0]!.messages.splice(1, 1);
    expect(await save(withoutAnswer, 2)).toBe(3);
    expect(
      (
        await db.query<{ message_id: string }>(
          "SELECT message_id FROM public.conversation_messages ORDER BY ordinal",
        )
      ).rows,
    ).toEqual([{ message_id: "conversation-a-question" }]);

    const removed = structuredClone(withoutAnswer);
    removed.conversations = [];
    expect(await save(removed, 3)).toBe(4);
    expect((await db.query("SELECT conversation_id FROM public.conversations")).rows).toEqual([]);
    expect((await db.query("SELECT message_id FROM public.conversation_messages")).rows).toEqual(
      [],
    );
  });

  it("rejects duplicated answer attempts without leaving a partial projection", async () => {
    const malformed = workspace();
    malformed.conversations = [
      conversation("conversation-a", "reused-attempt"),
      conversation("conversation-b", "reused-attempt"),
    ];

    await expect(save(malformed)).rejects.toMatchObject({ code: "22023" });
    expect(
      (await db.query("SELECT owner_id FROM public.workspaces WHERE owner_id=$1", [ownerA])).rows,
    ).toEqual([]);
    expect((await db.query("SELECT conversation_id FROM public.conversations")).rows).toEqual([]);
    expect((await db.query("SELECT message_id FROM public.conversation_messages")).rows).toEqual(
      [],
    );
  });
});

describe("normalized annotation projection", () => {
  it("preserves version-bound content, isolates reads, and cascades with its owner", async () => {
    const data = workspace();
    data.annotations = [annotation()];
    await save(data);

    expect(
      (
        await db.query<{
          annotation_id: string;
          source_id: string;
          version_id: string;
          quote: string;
          note: string;
          page: number | null;
        }>("SELECT annotation_id,source_id,version_id,quote,note,page FROM public.annotations")
      ).rows,
    ).toEqual([
      {
        annotation_id: "annotation-a",
        source_id: "source-a",
        version_id: "v1",
        quote: "梯度下降中的学习率",
        note: "需要继续复习。",
        page: 1,
      },
    ]);

    expect(
      (
        await asRole("authenticated", ownerA, async () =>
          db.query<{ annotation_id: string }>("SELECT annotation_id FROM public.annotations"),
        )
      ).rows,
    ).toEqual([{ annotation_id: "annotation-a" }]);
    expect(
      (
        await asRole("authenticated", ownerB, async () =>
          db.query<{ annotation_id: string }>("SELECT annotation_id FROM public.annotations"),
        )
      ).rows,
    ).toEqual([]);
    await expect(
      asRole("authenticated", ownerA, async () =>
        db.query("UPDATE public.annotations SET note='forged' WHERE annotation_id='annotation-a'"),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await prepareAccountDeletion(ownerA);
    expect(
      (
        await asRole("authenticated", ownerA, async () =>
          db.query<{ annotation_id: string }>("SELECT annotation_id FROM public.annotations"),
        )
      ).rows,
    ).toEqual([]);

    await db.query("DELETE FROM auth.users WHERE id=$1", [ownerA]);
    expect((await db.query("SELECT annotation_id FROM public.annotations")).rows).toEqual([]);
  });

  it("updates and prunes annotations only after a successful snapshot compare-and-swap", async () => {
    const initial = workspace();
    initial.annotations = [annotation()];
    expect(await save(initial)).toBe(1);

    const changed = structuredClone(initial);
    changed.annotations[0]!.note = "更新后的批注。";
    expect(await save(changed, 1)).toBe(2);
    await expect(save(initial, 1)).rejects.toMatchObject({ code: "40001" });

    expect(
      (
        await db.query<{ note: string; page: number | null }>(
          "SELECT note,page FROM public.annotations WHERE annotation_id='annotation-a'",
        )
      ).rows,
    ).toEqual([{ note: "更新后的批注。", page: 1 }]);

    const identityDrift = structuredClone(changed);
    identityDrift.annotations[0]!.quote = "被替换的原文身份";
    await expect(save(identityDrift, 2)).rejects.toMatchObject({
      code: "40001",
      message: expect.stringContaining("identity changed"),
    });
    expect(
      (
        await db.query<{ quote: string; note: string }>(
          "SELECT quote,note FROM public.annotations WHERE annotation_id='annotation-a'",
        )
      ).rows,
    ).toEqual([{ quote: "梯度下降中的学习率", note: "更新后的批注。" }]);

    const removed = structuredClone(changed);
    removed.annotations = [];
    expect(await save(removed, 2)).toBe(3);
    expect((await db.query("SELECT annotation_id FROM public.annotations")).rows).toEqual([]);
  });

  it("rejects duplicate annotation identities without leaving a partial projection", async () => {
    const malformed = workspace();
    malformed.annotations = [annotation("duplicate"), annotation("duplicate")];

    await expect(save(malformed)).rejects.toMatchObject({ code: "22023" });
    expect(
      (await db.query("SELECT owner_id FROM public.workspaces WHERE owner_id=$1", [ownerA])).rows,
    ).toEqual([]);
    expect((await db.query("SELECT annotation_id FROM public.annotations")).rows).toEqual([]);
  });
});

describe("normalized concept relation projection", () => {
  it("preserves endpoint baselines, isolates reads, and cascades with its owner", async () => {
    const data = workspace();
    data.conceptRelations = [conceptRelation()];
    await save(data);

    expect(
      (
        await db.query<{
          relation_id: string;
          relation_type: string;
          from_note_id: string;
          to_note_id: string;
          from_revision: number;
          origin: string;
          from_citations: ReturnType<typeof purgeCitation>[];
          deleted_at: string | null;
        }>(
          "SELECT relation_id,relation_type,from_note_id,to_note_id,from_revision,origin,from_citations,deleted_at::text FROM public.concept_relations",
        )
      ).rows,
    ).toEqual([
      {
        relation_id: "relation-a",
        relation_type: "related",
        from_note_id: "knowledge-a",
        to_note_id: "knowledge-b",
        from_revision: 1,
        origin: "manual",
        from_citations: [purgeCitation()],
        deleted_at: null,
      },
    ]);

    expect(
      (
        await asRole("authenticated", ownerA, async () =>
          db.query<{ relation_id: string }>("SELECT relation_id FROM public.concept_relations"),
        )
      ).rows,
    ).toEqual([{ relation_id: "relation-a" }]);
    expect(
      (
        await asRole("authenticated", ownerB, async () =>
          db.query<{ relation_id: string }>("SELECT relation_id FROM public.concept_relations"),
        )
      ).rows,
    ).toEqual([]);
    await expect(
      asRole("authenticated", ownerA, async () =>
        db.query(
          "UPDATE public.concept_relations SET explanation='forged' WHERE relation_id='relation-a'",
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await prepareAccountDeletion(ownerA);
    expect(
      (
        await asRole("authenticated", ownerA, async () =>
          db.query<{ relation_id: string }>("SELECT relation_id FROM public.concept_relations"),
        )
      ).rows,
    ).toEqual([]);
    await db.query("DELETE FROM auth.users WHERE id=$1", [ownerA]);
    expect((await db.query("SELECT relation_id FROM public.concept_relations")).rows).toEqual([]);
  });

  it("requires a consecutive relation revision and projects soft deletion, restoration, and pruning", async () => {
    const initial = workspace();
    initial.conceptRelations = [conceptRelation()];
    expect(await save(initial)).toBe(1);

    const changed = structuredClone(initial);
    changed.conceptRelations![0]!.fromClaim = "学习率控制每一步参数更新的幅度。";
    changed.conceptRelations![0]!.revision = 1;
    changed.conceptRelations![0]!.updatedAt = later;
    expect(await save(changed, 1)).toBe(2);
    await expect(save(initial, 1)).rejects.toMatchObject({ code: "40001" });

    const revisionJump = structuredClone(changed);
    revisionJump.conceptRelations![0]!.explanation = "跳过了关系版本。";
    revisionJump.conceptRelations![0]!.revision = 3;
    await expect(save(revisionJump, 2)).rejects.toMatchObject({
      code: "40001",
      message: expect.stringContaining("revision changed"),
    });
    expect(
      (
        await db.query<{ revision: number; from_claim: string }>(
          "SELECT revision,from_claim FROM public.concept_relations WHERE relation_id='relation-a'",
        )
      ).rows,
    ).toEqual([{ revision: 1, from_claim: "学习率控制每一步参数更新的幅度。" }]);

    const deleted = structuredClone(changed);
    deleted.conceptRelations![0]!.revision = 2;
    deleted.conceptRelations![0]!.updatedAt = "2026-09-12T12:02:00.000Z";
    deleted.conceptRelations![0]!.deletedAt = "2026-09-12T12:02:00.000Z";
    expect(await save(deleted, 2)).toBe(3);
    expect(
      (
        await db.query<{ revision: number; deleted: boolean }>(
          "SELECT revision,deleted_at IS NOT NULL AS deleted FROM public.concept_relations",
        )
      ).rows,
    ).toEqual([{ revision: 2, deleted: true }]);

    const restored = structuredClone(deleted);
    restored.conceptRelations![0]!.revision = 3;
    restored.conceptRelations![0]!.updatedAt = "2026-09-12T12:03:00.000Z";
    restored.conceptRelations![0]!.deletedAt = null;
    expect(await save(restored, 3)).toBe(4);
    expect(
      (
        await db.query<{ revision: number; deleted: boolean }>(
          "SELECT revision,deleted_at IS NOT NULL AS deleted FROM public.concept_relations",
        )
      ).rows,
    ).toEqual([{ revision: 3, deleted: false }]);

    const removed = structuredClone(restored);
    removed.conceptRelations = [];
    expect(await save(removed, 4)).toBe(5);
    expect((await db.query("SELECT relation_id FROM public.concept_relations")).rows).toEqual([]);
  });

  it("rejects a duplicate active symmetric pair without leaving a partial projection", async () => {
    const malformed = workspace();
    const first = conceptRelation("relation-a");
    malformed.conceptRelations = [
      first,
      conceptRelation("relation-b", { from: first.to, to: first.from }),
    ];

    await expect(save(malformed)).rejects.toMatchObject({ code: "22023" });
    expect(
      (await db.query("SELECT owner_id FROM public.workspaces WHERE owner_id=$1", [ownerA])).rows,
    ).toEqual([]);
    expect((await db.query("SELECT relation_id FROM public.concept_relations")).rows).toEqual([]);
  });

  it("keeps prerequisite directions distinct while rejecting incomplete conflict evidence", async () => {
    const data = workspace();
    const forward = conceptRelation("relation-forward", { type: "prerequisite" });
    data.conceptRelations = [
      forward,
      conceptRelation("relation-reverse", {
        type: "prerequisite",
        from: forward.to,
        to: forward.from,
      }),
      conceptRelation("relation-conflict", {
        type: "conflict",
        fromCondition: "学习率较小时",
        toCondition: "学习率过大时",
        toCitations: [purgeCitation("source-b", "v2")],
      }),
    ];
    expect(await save(data)).toBe(1);
    expect(
      (
        await db.query<{ relation_id: string }>(
          "SELECT relation_id FROM public.concept_relations ORDER BY relation_id",
        )
      ).rows,
    ).toEqual([
      { relation_id: "relation-conflict" },
      { relation_id: "relation-forward" },
      { relation_id: "relation-reverse" },
    ]);

    const malformed = workspace();
    malformed.conceptRelations = [
      conceptRelation("relation-conflict", {
        type: "conflict",
        fromCondition: "",
        toCondition: "训练稳定时",
      }),
    ];
    await expect(save(malformed, 0, ownerB)).rejects.toMatchObject({ code: "22023" });
    expect(
      (await db.query("SELECT owner_id FROM public.workspaces WHERE owner_id=$1", [ownerB])).rows,
    ).toEqual([]);
  });
});

describe("account deletion outbox and access block", () => {
  it("returns a count-only preview, captures canonical and orphan Storage paths, and blocks the account", async () => {
    const current = source("live");
    current.blobKey = "original:live:v1";
    current.storagePath = `${ownerA}/v1/live.md`;
    const recycled = recycledSource("old");
    const data = workspace([current, recycled]);
    data.notes = [note("note-a")];
    data.conversations = [conversation()];
    data.annotations = [annotation("annotation-live", { sourceId: "live" })];
    await save(data);
    await requestSourcePurge(await previewSourcePurge("old"), "old");
    await db.query(
      "INSERT INTO storage.objects(bucket_id,name) VALUES ('originals',$1),('attachments',$2),('originals',$3)",
      [`${ownerA}/orphan/interrupted.bin`, `${ownerA}/legacy/custom.bin`, `${ownerB}/v1/other.md`],
    );

    const preview = await previewAccountDeletion();
    expect(preview).toEqual({
      state: null,
      sources: 1,
      versions: 1,
      notes: 1,
      conversations: 1,
      annotations: 1,
      spaces: 1,
      currentStorageObjects: 1,
      pendingSourcePurgeObjects: 2,
      totalStorageObjects: 5,
    });
    expect(JSON.stringify(preview)).not.toContain("storagePath");
    expect(JSON.stringify(preview)).not.toContain("interrupted");
    await expect(
      rpc("public.prepare_account_deletion($1::uuid)", [ownerA], "authenticated", ownerA),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      rpc("public.claim_account_deletion_objects('untrusted')", [], "authenticated", ownerB),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      rpc("public.claim_ready_account_auth_deletions('untrusted')", [], "authenticated", ownerB),
    ).rejects.toMatchObject({ code: "42501" });
    expect((await claimAccountDeletionObjects()).objects).toEqual([]);

    const prepared = await prepareAccountDeletion();
    expect(prepared).toMatchObject({
      deletionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      state: "storage_pending",
      storageObjects: 5,
      readyForAuthDeletion: false,
    });
    expect((await claimSourcePurgeObjects()).objects).toEqual([]);
    expect(await prepareAccountDeletion()).toEqual(prepared);
    expect(await accountDeletionAccessStatus()).toEqual({
      allowed: false,
      state: "storage_pending",
    });
    expect(await previewAccountDeletion()).toMatchObject({ ...preview, state: "storage_pending" });
    await expect(save(workspace([source("blocked")]), 1)).rejects.toMatchObject({ code: "42501" });
    await expect(lexical("梯度")).rejects.toMatchObject({ code: "42501" });
    await expect(previewSourcePurge("live")).rejects.toMatchObject({ code: "42501" });
    expect(await accountDeletionAccessStatus(ownerB)).toEqual({ allowed: true, state: null });

    expect(
      (
        await db.query<{ bucket_id: string; storage_path: string }>(
          "SELECT bucket_id,storage_path FROM public.account_deletion_objects WHERE deletion_id=$1 ORDER BY bucket_id,storage_path",
          [prepared.deletionId],
        )
      ).rows,
    ).toEqual([
      { bucket_id: "attachments", storage_path: `${ownerA}/legacy/custom.bin` },
      { bucket_id: "originals", storage_path: `${ownerA}/orphan/interrupted.bin` },
      { bucket_id: "originals", storage_path: `${ownerA}/v0/old.md` },
      { bucket_id: "originals", storage_path: `${ownerA}/v1/live.md` },
      { bucket_id: "originals", storage_path: `${ownerA}/v1/old.md` },
    ]);
    // The restrictive policy applies to every bucket, not only originals.
    expect(
      (
        await asRole("authenticated", ownerA, async () =>
          db.query("SELECT name FROM storage.objects ORDER BY name"),
        )
      ).rows,
    ).toEqual([]);
    await expect(
      asRole("authenticated", ownerA, async () =>
        db.query("INSERT INTO storage.objects(bucket_id,name) VALUES ('attachments',$1)", [
          `${ownerA}/late/blocked.bin`,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("cancels an active embedding lease and rejects every later source-text read", async () => {
    await save(workspace([source("learning")]));
    const job = (await claim()).jobs[0]!;
    expect(job).toMatchObject({ ownerId: ownerA });

    await prepareAccountDeletion();
    expect(
      (
        await db.query<{
          state: string;
          cancel_reason: string;
          error_code: string;
          lease_token: string | null;
        }>(
          "SELECT state,cancel_reason,error_code,lease_token FROM public.embedding_jobs WHERE job_id=$1",
          [job.jobId],
        )
      ).rows,
    ).toEqual([
      {
        state: "cancelled",
        cancel_reason: "ineligible",
        error_code: "ACCOUNT_DELETION_PENDING",
        lease_token: null,
      },
    ]);
    expect((await claim()).jobs).toEqual([]);
    await expect(read(job, 1)).rejects.toMatchObject({ code: "42501" });
  });

  it("clears active model ledgers and rejects every later service-side reservation or completion", async () => {
    expect(
      await rpc<{ status: string }>("public.reserve_ai_request($1::uuid,$2,$3,$4)", [
        ownerA,
        "deletion-ledger",
        profile,
        50,
      ]),
    ).toEqual({ status: "reserved" });
    expect(
      await rpc<{ allowed: boolean }>("public.reserve_embedding_usage($1::uuid,$2,$3,$4)", [
        ownerA,
        "deletion-embedding",
        10,
        100,
      ]),
    ).toEqual({ allowed: true });

    await prepareAccountDeletion();
    expect(
      (
        await db.query<{ state: string; result: unknown; error_code: string }>(
          "SELECT state,result,error_code FROM public.ai_requests WHERE owner_id=$1 AND request_id='deletion-ledger'",
          [ownerA],
        )
      ).rows,
    ).toEqual([{ state: "failed", result: null, error_code: "ACCOUNT_DELETION_PENDING" }]);
    expect(
      (await db.query("SELECT * FROM public.embedding_usage WHERE owner_id=$1", [ownerA])).rows,
    ).toEqual([]);
    await expect(
      rpc("public.reserve_ai_request($1::uuid,'after-deletion',$2,50)", [ownerA, profile]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      rpc("public.reserve_embedding_usage($1::uuid,'after-deletion',10,100)", [ownerA]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      rpc("public.finish_ai_request($1::uuid,$2,$3::jsonb,null)", [
        ownerA,
        "deletion-ledger",
        JSON.stringify({ content: "late provider result" }),
      ]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("rechecks actual Storage before Auth deletion and requires external Auth confirmation", async () => {
    const firstPath = `${ownerA}/orphan/first.bin`;
    await db.query("INSERT INTO storage.objects(bucket_id,name) VALUES ('originals',$1)", [
      firstPath,
    ]);
    const prepared = await prepareAccountDeletion();
    const first = (await claimAccountDeletionObjects())["objects"][0]!;
    expect(first).toMatchObject({
      deletionId: prepared.deletionId,
      ownerId: ownerA,
      bucketId: "originals",
      storagePath: firstPath,
      attempt: 1,
      leaseToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(await heartbeatAccountDeletionObject(first, 15)).toMatchObject({
      leaseUntil: expect.any(String),
    });
    await expect(heartbeatAccountDeletionObject(first, 14)).rejects.toMatchObject({
      code: "22023",
    });
    // Completing an outbox row only acknowledges an external Storage operation. SQL never removes the object.
    expect(await completeAccountDeletionObject(first)).toMatchObject({
      state: "completed",
      deletionState: "ready_for_auth_deletion",
    });
    expect((await db.query("SELECT name FROM storage.objects")).rows).toEqual([
      { name: firstPath },
    ]);
    // The direct Storage recheck sees the still-present object, reopens the row, and withholds Auth deletion.
    expect((await claimReadyAccountAuthDeletions()).deletions).toEqual([]);
    expect(
      (
        await db.query("SELECT state FROM public.account_deletions WHERE deletion_id=$1", [
          prepared.deletionId,
        ])
      ).rows,
    ).toEqual([{ state: "storage_pending" }]);

    const reopened = (await claimAccountDeletionObjects())["objects"][0]!;
    expect(reopened).toMatchObject({ storagePath: firstPath, attempt: 1 });
    await db.query("DELETE FROM storage.objects WHERE bucket_id='originals' AND name=$1", [
      firstPath,
    ]);
    expect(await completeAccountDeletionObject(reopened)).toMatchObject({
      state: "completed",
      deletionState: "ready_for_auth_deletion",
    });
    const auth = (await claimReadyAccountAuthDeletions())["deletions"][0]!;
    expect(auth).toMatchObject({
      deletionId: prepared.deletionId,
      ownerId: ownerA,
      attempt: 1,
      leaseToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(await heartbeatAccountAuthDeletion(auth, 15)).toMatchObject({
      leaseUntil: expect.any(String),
    });
    await expect(heartbeatAccountAuthDeletion(auth, 14)).rejects.toMatchObject({ code: "22023" });
    await expect(completeAccountAuthDeletion(auth)).rejects.toMatchObject({ code: "40001" });
    await expect(failAccountAuthDeletion(auth, "https://secret")).rejects.toMatchObject({
      code: "22023",
    });
    expect(await failAccountAuthDeletion(auth, "AUTH_TIMEOUT")).toMatchObject({
      state: "ready_for_auth_deletion",
      nextAttemptAt: expect.any(String),
    });
    await db.query(
      "UPDATE public.account_deletions SET auth_next_attempt_at=clock_timestamp()-interval '1 second' WHERE deletion_id=$1",
      [prepared.deletionId],
    );
    const retry = (await claimReadyAccountAuthDeletions())["deletions"][0]!;
    expect(retry.leaseToken).not.toBe(auth.leaseToken);
    // This is the test's stand-in for the external Auth Admin delete. The SQL finalizer
    // refuses to claim completion until this authoritative identity row is absent.
    await db.query("DELETE FROM auth.users WHERE id=$1", [ownerA]);
    expect(await completeAccountAuthDeletion(retry)).toMatchObject({
      state: "completed",
      storageReopened: false,
      completedAt: expect.any(String),
    });
    expect(
      (
        await db.query("SELECT owner_id,state FROM public.account_deletions WHERE deletion_id=$1", [
          prepared.deletionId,
        ])
      ).rows,
    ).toEqual([{ owner_id: ownerA, state: "completed" }]);
  });

  it("bounds failed Storage leases and lets service code explicitly retry without unblocking the account", async () => {
    const path = `${ownerA}/orphan/retry.bin`;
    await db.query("INSERT INTO storage.objects(bucket_id,name) VALUES ('originals',$1)", [path]);
    const prepared = await prepareAccountDeletion();
    const first = (await claimAccountDeletionObjects())["objects"][0]!;
    await expect(failAccountDeletionObject(first, "contains a space")).rejects.toMatchObject({
      code: "22023",
    });
    expect(await failAccountDeletionObject(first, "ACCESS_DENIED", false)).toMatchObject({
      state: "failed",
      deletionState: "failed",
      nextAttemptAt: null,
    });
    expect((await claimAccountDeletionObjects()).objects).toEqual([]);
    expect(await retryAccountDeletion(prepared.deletionId)).toEqual({
      state: "storage_pending",
      retriedStorageObjects: 1,
    });
    expect(await accountDeletionAccessStatus()).toEqual({
      allowed: false,
      state: "storage_pending",
    });
    let retried = (await claimAccountDeletionObjects())["objects"][0]!;
    expect(retried).toMatchObject({ storagePath: path, attempt: 1 });
    await expect(
      completeAccountDeletionObject({ ...retried, bucketId: "forged" }),
    ).rejects.toMatchObject({ code: "40001" });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(retried.attempt).toBe(attempt);
      expect(await failAccountDeletionObject(retried, "STORAGE_TIMEOUT")).toMatchObject({
        state: attempt === 5 ? "failed" : "pending",
        deletionState: attempt === 5 ? "failed" : "storage_pending",
      });
      if (attempt < 5) {
        await db.query(
          "UPDATE public.account_deletion_objects SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE deletion_id=$1",
          [prepared.deletionId],
        );
        retried = (await claimAccountDeletionObjects())["objects"][0]!;
      }
    }
    expect(
      (
        await db.query(
          "SELECT state,attempts,last_error FROM public.account_deletion_objects WHERE deletion_id=$1",
          [prepared.deletionId],
        )
      ).rows,
    ).toEqual([{ state: "failed", attempts: 5, last_error: "STORAGE_TIMEOUT" }]);
  });
});
afterAll(async () => {
  await db?.close();
});

describe("canonical retrieval migration on PostgreSQL with pgvector", () => {
  it("backfills existing snapshots and installs a real cosine HNSW index", async () => {
    expect(backfilled).toBe(2);
    const result = await db.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname='chunk_embeddings_cosine'",
    );
    expect(result.rows[0].indexdef).toContain("USING hnsw");
    expect(
      (await db.query("SELECT extversion FROM pg_extension WHERE extname='vector'")).rows,
    ).toHaveLength(1);
  });
  it("atomically stores current and three retained versions, with exact source/chunk identity", async () => {
    const current = source("legacy-id", "v3");
    current.versions = [archived(source("legacy-id", "v2")), archived(source("legacy-id", "v1"))];
    const data = workspace([current]);
    expect(await save(data)).toBe(1);
    expect(
      (await db.query("SELECT version_id FROM public.source_versions ORDER BY version_id")).rows,
    ).toEqual([{ version_id: "v1" }, { version_id: "v2" }, { version_id: "v3" }]);
    expect((await lexical()).every((hit) => hit.version_id === "v3")).toBe(true);
    expect((await db.query("SELECT * FROM public.embedding_jobs")).rows).toHaveLength(1);
    expect(await lexical("v1")).toHaveLength(0);
  });
  it("keeps body digest immutable but allows title, tags, memberships and progress edits", async () => {
    const data = workspace();
    await save(data);
    data.sources[0].title = "新标题";
    data.sources[0].tags = ["新标签"];
    data.sources[0].readOffset = 42;
    data.sources[0].spaceIds = [];
    expect(await save(data, 1)).toBe(2);
    expect(await lexical("新标签", "inbox")).toHaveLength(1);
    const changed = structuredClone(data);
    changed.sources[0].text += "恶意修改";
    await expect(save(changed, 2)).rejects.toMatchObject({ code: "22023" });
    expect((await lexical("新标题"))[0]).toMatchObject({ title: "新标题", workspace_revision: 2 });
    expect((await db.query("SELECT revision FROM public.workspaces")).rows).toEqual([
      { revision: 2 },
    ]);
  });
  it("rejects CAS conflicts without projecting new contents or jobs", async () => {
    await save();
    await expect(save(workspace([source("other")]), 0)).rejects.toMatchObject({ code: "40001" });
    await expect(save(workspace([source("other")]), 9)).rejects.toMatchObject({ code: "40001" });
    expect((await db.query("SELECT source_id FROM public.sources")).rows).toEqual([
      { source_id: "source-a" },
    ]);
  });
  it("retains missing-original state in the immutable version manifest", async () => {
    const data = workspace();
    data.sources[0].originalMissing = true;
    delete data.sources[0].blobKey;
    delete data.sources[0].storagePath;
    await save(data);
    expect(
      (
        await db.query<{ manifest: { originalMissing?: boolean } }>(
          "SELECT manifest FROM public.source_versions WHERE version_id='v1'",
        )
      ).rows[0].manifest.originalMissing,
    ).toBe(true);
    delete data.sources[0].originalMissing;
    await expect(save(data, 1)).rejects.toMatchObject({ code: "22023" });
    const replacement = workspace([source("new-source", "new-version")]);
    expect(await save(replacement, 1)).toBe(2);
  });
  it("keeps explicit parser coverage in the immutable version manifest", async () => {
    const partial = source();
    partial.status = "partial";
    partial.pageCount = 3;
    partial.parsedPages = 2;
    partial.coverage = {
      captureScope: "full",
      parseState: "partial",
      unavailablePageRanges: [{ start: 3, end: 3 }],
    };
    const data = workspace([partial]);
    await save(data);
    expect(
      (
        await db.query<{ manifest: { coverage?: Source["coverage"] } }>(
          "SELECT manifest FROM public.source_versions WHERE version_id='v1'",
        )
      ).rows[0].manifest.coverage,
    ).toEqual(partial.coverage);
    data.sources[0].coverage = {
      captureScope: "full",
      parseState: "partial",
      unavailablePageRanges: [{ start: 2, end: 2 }],
    };
    await expect(save(data, 1)).rejects.toMatchObject({ code: "22023" });
  });
  it("rejects coverage that conflicts with the saved web capture scope", async () => {
    const selected = source();
    selected.kind = "web";
    selected.mime = "text/plain";
    selected.url = "https://example.com/article";
    selected.coverage = { captureScope: "selection", parseState: "complete" };
    selected.webSnapshot = {
      originalUrl: selected.url,
      finalUrl: selected.url,
      capturedAt: now,
      method: "server",
      scope: "article",
      warnings: [],
    };
    await expect(save(workspace([selected]))).rejects.toMatchObject({ code: "22023" });

    const incompleteArticle = source();
    incompleteArticle.kind = "web";
    incompleteArticle.mime = "text/plain";
    incompleteArticle.status = "partial";
    incompleteArticle.url = "https://example.com/article";
    incompleteArticle.coverage = { captureScope: "full", parseState: "partial" };
    incompleteArticle.webSnapshot = {
      originalUrl: incompleteArticle.url,
      finalUrl: incompleteArticle.url,
      capturedAt: now,
      method: "server",
      scope: "article",
      warnings: [],
    };
    await expect(save(workspace([incompleteArticle]))).rejects.toMatchObject({ code: "22023" });
  });
  it("rejects unavailable page ranges beyond the recorded PDF page count", async () => {
    const partial = source();
    partial.status = "partial";
    partial.pageCount = 1;
    partial.parsedPages = 0;
    partial.coverage = {
      captureScope: "full",
      parseState: "partial",
      unavailablePageRanges: [{ start: 2, end: 2 }],
    };
    await expect(save(workspace([partial]))).rejects.toMatchObject({ code: "22023" });
  });
  it("does not add coverage to legacy selected webpage manifests on an unrelated save", async () => {
    const selected = source();
    selected.kind = "web";
    selected.mime = "text/plain";
    selected.status = "partial";
    selected.url = "https://example.com/article";
    selected.webSnapshot = {
      originalUrl: selected.url,
      finalUrl: selected.url,
      capturedAt: now,
      method: "server",
      scope: "selection",
      warnings: [],
    };
    const data = workspace([selected]);
    await save(data);
    expect(
      (
        await db.query<{ has_coverage: boolean }>(
          "SELECT manifest ? 'coverage' AS has_coverage FROM public.source_versions WHERE version_id='v1'",
        )
      ).rows[0].has_coverage,
    ).toBe(false);
    data.sources[0].title = "新版资料标题";
    expect(await save(data, 1)).toBe(2);
  });
  it.each(["owner", "version", "extension"])(
    "rejects %s spoofing in any retained original path",
    async (mode) => {
      const s = source();
      const v = archived(source("source-a", "old"));
      v.storagePath =
        mode === "owner"
          ? `${ownerB}/old/source-a.md`
          : mode === "version"
            ? `${ownerA}/v1/source-a.md`
            : `${ownerA}/old/source-a.pdf`;
      s.versions = [v];
      await expect(save(workspace([s]))).rejects.toMatchObject({ code: "22023" });
      expect((await db.query("SELECT * FROM public.workspaces")).rows).toHaveLength(0);
    },
  );
  it("permits original path enrichment but rejects subsequent removal or rebinding", async () => {
    const data = workspace();
    await save(data);
    data.sources[0].storagePath = `${ownerA}/v1/source-a.md`;
    await save(data, 1);
    delete data.sources[0].storagePath;
    await expect(save(data, 2)).rejects.toMatchObject({ code: "22023" });
  });
  it.each(["sourceId", "versionId", "duplicate", "quote"])(
    "rejects invalid chunk %s atomically",
    async (mode) => {
      const s = source();
      if (mode === "sourceId") s.chunks[0].sourceId = "other";
      if (mode === "versionId") s.chunks[0].versionId = "old";
      if (mode === "duplicate") s.chunks[1].id = s.chunks[0].id;
      if (mode === "quote") s.chunks[0].text = "not in body";
      await expect(save(workspace([s]))).rejects.toMatchObject({ code: "22023" });
      expect((await db.query("SELECT * FROM public.sources")).rows).toHaveLength(0);
    },
  );
  it("keeps omitted versions unretained without substituting current text", async () => {
    const s = source("source-a", "v2");
    s.versions = [archived(source())];
    const data = workspace([s]);
    await save(data);
    delete data.sources[0].versions;
    await save(data, 1);
    const history = await db.query<{ retained: boolean; text: string }>(
      "SELECT retained,text FROM public.source_versions WHERE version_id='v1'",
    );
    expect(history.rows[0]).toEqual({ retained: false, text: source().text });
    expect((await lexical()).every((h) => h.version_id === "v2")).toBe(true);
  });
  it("enforces owner, current version, library, inbox, deleted and archived scope before returning hits", async () => {
    const a = source();
    const b = source("inbox");
    b.spaceIds = [];
    const data = workspace([a, b]);
    await save(data);
    await save(workspace([source("other-owner")]), 0, ownerB);
    expect(new Set((await lexical()).map((h) => h.source_id))).toEqual(
      new Set(["source-a", "inbox"]),
    );
    expect((await lexical("梯度", "library")).every((h) => h.source_id === "source-a")).toBe(true);
    expect((await lexical("梯度", "inbox")).every((h) => h.source_id === "inbox")).toBe(true);
    expect(await lexical("梯度", "*", false, ownerA, ["other-owner"])).toEqual([]);
    data.sources[0].deletedAt = now;
    data.sources[1].spaceIds = ["library"];
    data.spaces[0].archived = true;
    await save(data, 1);
    expect((await lexical()).map((hit) => hit.source_id)).toEqual(["inbox"]);
    expect(await lexical("梯度", "*", true)).toEqual([]);
    await expect(lexical("梯度", "library")).rejects.toMatchObject({ code: "22023" });
  });
  it("lexical search works with AI disabled and returns title-only metadata; AI never receives metadata rows", async () => {
    const s = source("link", "v1", 0);
    s.status = "link-only";
    s.title = "梯度链接";
    const data = workspace([source(), s], false);
    data.aiEnabled = false;
    await save(data);
    expect(await lexical()).toHaveLength(2);
    expect((await lexical()).find((h) => h.source_id === "link")).toMatchObject({
      chunk_id: null,
      text: null,
      coverage_status: "link-only",
    });
    expect(await lexical("梯度", "*", true)).toEqual([]);
    expect((await claim()).jobs).toEqual([]);
    data.aiEnabled = true;
    await save(data, 1);
    expect(await lexical("梯度", "*", true)).toHaveLength(2);
    expect((await claim()).jobs).toEqual([]);
  });
  it("recovers Chinese topic words inside questions and English content words without requiring the full query", async () => {
    const useful = source("useful", "v1", 1);
    useful.text = "学习率过高会造成振荡。Gradient descent may overshoot when its step is large.";
    useful.chunks[0].text = useful.text;
    const generic = source("generic", "v1", 1);
    generic.text = "学习是一项长期活动。What when how are generic words.";
    generic.chunks[0].text = generic.text;
    await save(workspace([useful, generic], false));
    for (const query of [
      "学习率",
      "学习率过高会怎样",
      "What happens when descent overshoots a minimum?",
    ]) {
      expect((await lexical(query, "*", true)).map((hit) => hit.source_id)).toEqual(["useful"]);
    }
    expect((await lexical("学习率" + " ".repeat(3997))).map((hit) => hit.source_id)).toEqual([
      "useful",
    ]);
    await expect(lexical("x".repeat(4001))).rejects.toMatchObject({ code: "22023" });
  });
  it("selects each source's best block before the ordinary limit while AI can retrieve multiple blocks", async () => {
    const many = source("a-many", "v1", 120);
    const other = source("z-other", "v1", 1);
    many.title = other.title = "same keyword";
    await save(workspace([many, other], false));
    expect((await lexical("keyword")).map((hit) => hit.source_id)).toEqual(["a-many", "z-other"]);
    expect(await lexical("keyword", "*", true)).toHaveLength(100);
    expect(await lexical("keyword", "*", true, ownerA, ["z-other"])).toHaveLength(1);
  });
  it("preserves a large legacy chunk and finds an English term past the bounded FTS window", async () => {
    const s = source("large", "v1", 1);
    s.text = Array.from({ length: 90_000 }, (_, i) => `term${i}`).join(" ") + " tailneedle";
    s.chunks[0].text = s.text;
    await save(workspace([s], false));
    const found = await lexical("Where can I find tailneedle?", "*", true);
    expect(found[0]?.text).toBe(s.text);
    expect(
      (await db.query<{ text: string }>("SELECT text FROM public.source_chunks")).rows[0].text,
    ).toBe(s.text);
  });
  it.each(["anon", "authenticated", "service_role"] as const)(
    "denies %s direct canonical/table and private-helper access",
    async (role) => {
      await save();
      await asRole(role, ownerA, async () => {
        for (const table of [
          "sources",
          "source_versions",
          "source_chunks",
          "chunk_embeddings",
          "embedding_jobs",
          "embedding_profiles",
          "embedding_usage",
          "source_tombstones",
          "source_purges",
          "source_purge_objects",
        ]) {
          await expect(db.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({
            code: "42501",
          });
          await expect(db.query(`DELETE FROM public.${table}`)).rejects.toMatchObject({
            code: "42501",
          });
        }
        await expect(
          db.query("SELECT conuo_private.project_workspace($1,$2)", [
            ownerA,
            JSON.stringify(workspace()),
          ]),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          db.query("SELECT conuo_private.workspace_retrieval_projection_input($1::jsonb)", [
            JSON.stringify(workspace()),
          ]),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          db.query("SELECT conuo_private.owner_lock($1::uuid)", [ownerA]),
        ).rejects.toMatchObject({ code: "42501" });
      });
    },
  );
  it.each(["anon", "authenticated"] as const)("denies %s worker RPC execution", async (role) => {
    await expect(
      rpc("public.claim_embedding_jobs('forged',$1)", [profile], role, ownerA),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      rpc("public.reserve_embedding_usage($1,'forged',1)", [ownerA], role, ownerA),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      rpc("public.claim_source_purge_objects('forged')", [], role, ownerA),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("requires signed-in scope for search and owner-only job control/status", async () => {
    await save();
    const job = (await claim()).jobs[0];
    expect((await status(ownerB)).jobs).toEqual([]);
    await expect(control(job, "cancel", ownerB)).rejects.toMatchObject({ code: "40001" });
    await expect(rpc("public.embedding_job_status()", [], "authenticated")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(rpc("public.search_source_chunks('梯度','*')", [], "anon")).rejects.toMatchObject({
      code: "42501",
    });
    expect((await status()).jobs[0]).toMatchObject({
      jobId: job.jobId,
      sourceId: "source-a",
      state: "running",
      attempt: 1,
      cursor: 0,
      totalChunks: 2,
    });
  });
  it("binds the first profile fingerprint and refuses mixed-model claims and queries", async () => {
    await save();
    expect((await status()).jobs[0]).toMatchObject({ profileFingerprint: null });
    expect((await claim()).jobs).toHaveLength(1);
    expect((await status()).jobs[0]).toMatchObject({ profileFingerprint: profile });
    await expect(claim(otherProfile)).rejects.toMatchObject({ code: "22023" });
    await expect(semantic(ownerA, otherProfile)).rejects.toMatchObject({ code: "22023" });
  });
  it("returns only current-version status while retaining history and current cancel/retry controls", async () => {
    const data = workspace();
    await save(data);
    const first = (await status()).jobs[0];
    const next = source("source-a", "v2");
    next.versions = [archived(data.sources[0])];
    data.sources[0] = next;
    await save(data, 1);

    const current = (await status()).jobs;
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ sourceId: "source-a", versionId: "v2", state: "queued" });
    expect(current[0].jobId).not.toBe(first.jobId);
    expect(
      (await db.query("SELECT version_id,state FROM public.embedding_jobs ORDER BY version_id"))
        .rows,
    ).toEqual([
      { version_id: "v1", state: "cancelled" },
      { version_id: "v2", state: "queued" },
    ]);
    expect(
      (await db.query("SELECT version_id FROM public.source_versions ORDER BY version_id")).rows,
    ).toEqual([{ version_id: "v1" }, { version_id: "v2" }]);

    expect(await control(current[0], "cancel")).toEqual({ state: "cancelled" });
    expect((await status()).jobs).toEqual([
      expect.objectContaining({ jobId: current[0].jobId, versionId: "v2", state: "cancelled" }),
    ]);
    expect(await control(current[0], "retry")).toEqual({ state: "queued" });
    expect((await status()).jobs).toEqual([
      expect.objectContaining({ jobId: current[0].jobId, versionId: "v2", state: "queued" }),
    ]);
    expect((await db.query("SELECT job_id FROM public.embedding_jobs")).rows).toHaveLength(2);
  });
  it("reads exact hashes and ordinals, stages batches, retries identically, and publishes only a completed job", async () => {
    await save();
    const job = (await claim()).jobs[0];
    const first = await read(job, 1);
    expect(first).toMatchObject({ ownerId: ownerA, cursor: 0, totalChunks: 2 });
    expect(first.chunks[0].contentHash).toBe(
      createHash("sha256").update(first.chunks[0].text).digest("hex"),
    );
    expect(await commit(job, first)).toEqual({ cursor: 1, totalChunks: 2, state: "running" });
    expect(await commit(job, first)).toEqual({ cursor: 1, totalChunks: 2, state: "running" });
    await expect(commit(job, first, rows(first, 1))).rejects.toMatchObject({ code: "40001" });
    expect(await semantic()).toEqual([]);
    await expect(finish(job)).rejects.toMatchObject({ code: "40001" });
    const second = await read(job);
    expect(second.chunks[0].ordinal).toBe(3);
    await commit(job, second, rows(second, 1));
    expect(await semantic()).toEqual([]);
    expect(await finish(job)).toEqual({ state: "succeeded" });
    expect(await finish(job)).toEqual({ state: "succeeded" });
    const hits = await semantic();
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ chunk_id: "c0", distance: 0 });
    expect(hits[1]).toMatchObject({ chunk_id: "c1", distance: 1 });
    expect(await semantic(ownerB)).toEqual([]);
    expect(await semantic(ownerA, profile, "*", 0, ["missing"])).toEqual([]);
  });
  it.each(["hash", "chunk", "dimensions", "zero", "nan", "extra"])(
    "rejects invalid %s batch rows without partially advancing",
    async (mode) => {
      await save();
      const job = (await claim()).jobs[0];
      const batch = await read(job);
      const values = rows(batch);
      if (mode === "hash") values[1].contentHash = "0".repeat(64);
      if (mode === "chunk") values[1].chunkId = "wrong";
      if (mode === "dimensions") values[1].embedding.pop();
      if (mode === "zero") values[1].embedding.fill(0);
      if (mode === "nan") values[1].embedding[0] = NaN;
      if (mode === "extra") Object.assign(values[1], { text: "forged" });
      await expect(commit(job, batch, values)).rejects.toMatchObject({ code: "22023" });
      expect((await read(job)).cursor).toBe(0);
      expect((await db.query("SELECT * FROM public.chunk_embeddings")).rows).toHaveLength(0);
    },
  );
  it("rejects a skipped cursor and a foreign/stale lease without reading source text", async () => {
    await save();
    const job = (await claim()).jobs[0];
    const batch = await read(job);
    await expect(commit(job, { ...batch, cursor: 1 })).rejects.toMatchObject({ code: "40001" });
    await expect(read({ ...job, leaseToken: ownerB })).rejects.toMatchObject({ code: "40001" });
    await db.exec("UPDATE public.embedding_jobs SET lease_until=now()-interval '1 second'");
    await expect(read(job)).rejects.toMatchObject({ code: "40001" });
    const next = (await claim()).jobs[0];
    expect(next.attempt).toBe(2);
    expect(next.leaseToken).not.toBe(job.leaseToken);
    await expect(commit(job, batch)).rejects.toMatchObject({ code: "40001" });
    expect((await read(next)).chunks).toHaveLength(2);
  });
  it.each(["ai", "semantic", "source", "delete", "archive", "version", "omit"])(
    "revokes %s at save and blocks late worker publication",
    async (reason) => {
      const data = workspace();
      await save(data);
      const job = (await claim()).jobs[0];
      const batch = await read(job);
      await commit(job, batch);
      await finish(job);
      expect(await semantic()).toHaveLength(2);
      if (reason === "ai") data.aiEnabled = false;
      if (reason === "semantic") Object.assign(data, { semanticSearch: false });
      if (reason === "source") data.sources[0].aiAllowed = false;
      if (reason === "delete") data.sources[0].deletedAt = now;
      if (reason === "archive") data.spaces[0].archived = true;
      if (reason === "version") {
        const next = source("source-a", "v2");
        next.versions = [archived(data.sources[0])];
        data.sources[0] = next;
      }
      if (reason === "omit") data.sources = [];
      await save(data, 1);
      expect(await semantic()).toEqual([]);
      await expect(finish(job)).rejects.toMatchObject({ code: "40001" });
    },
  );
  it("never revives user cancellation on unrelated saves; explicit owner retry creates a fresh generation", async () => {
    const data = workspace();
    await save(data);
    const job = (await claim()).jobs[0];
    await commit(job, await read(job, 1));
    expect(await control(job, "cancel")).toEqual({ state: "cancelled" });
    data.sources[0].title = "new title";
    await save(data, 1);
    expect((await claim()).jobs).toEqual([]);
    expect(await control(job, "retry")).toEqual({ state: "queued" });
    const retry = (await claim()).jobs[0];
    expect(retry.cursor).toBe(0);
    expect(retry.attempt).toBe(1);
    expect((await db.query("SELECT * FROM public.chunk_embeddings")).rows).toHaveLength(0);
    await expect(read(job)).rejects.toMatchObject({ code: "40001" });
  });
  it("requeues permission-cancelled work on explicit eligibility restoration, without exposing staged vectors", async () => {
    const data = workspace();
    await save(data);
    const job = (await claim()).jobs[0];
    await commit(job, await read(job, 1));
    data.sources[0].aiAllowed = false;
    await save(data, 1);
    data.sources[0].aiAllowed = true;
    await save(data, 2);
    const next = (await claim()).jobs[0];
    expect(next.cursor).toBe(1);
    expect(await semantic()).toEqual([]);
    await commit(next, await read(next));
    await finish(next);
    expect(await semantic()).toHaveLength(2);
  });
  it("persists retry backoff/cursor and limits abandoned lease attempts", async () => {
    await save();
    let job = (await claim()).jobs[0];
    await commit(job, await read(job, 1));
    expect(
      await rpc("public.fail_embedding_job($1::uuid,$2::uuid,'PROVIDER_TIMEOUT',true)", [
        job.jobId,
        job.leaseToken,
      ]),
    ).toMatchObject({ state: "queued" });
    expect((await claim()).jobs).toEqual([]);
    await db.exec("UPDATE public.embedding_jobs SET next_attempt_at=now()-interval '1 second'");
    job = (await claim()).jobs[0];
    expect(job.cursor).toBe(1);
    for (let i = 0; i < 4; i++) {
      await db.exec("UPDATE public.embedding_jobs SET lease_until=now()-interval '1 second'");
      const next = await claim();
      if (i < 3) job = next.jobs[0];
      else expect(next.jobs).toEqual([]);
    }
    expect((await status()).jobs[0]).toMatchObject({ state: "failed", attempt: 5 });
  });
  it("extends a live lease and rejects free-text error disclosure or invalid durations", async () => {
    await save();
    const job = (await claim()).jobs[0];
    expect(
      await rpc("public.heartbeat_embedding_job($1::uuid,$2::uuid,60)", [
        job.jobId,
        job.leaseToken,
      ]),
    ).toHaveProperty("leaseUntil");
    await expect(
      rpc("public.heartbeat_embedding_job($1::uuid,$2::uuid,999)", [job.jobId, job.leaseToken]),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      rpc("public.fail_embedding_job($1::uuid,$2::uuid,'https://secret',true)", [
        job.jobId,
        job.leaseToken,
      ]),
    ).rejects.toMatchObject({ code: "22023" });
  });
  it("atomically accounts Unicode character reservations, denies repeats and keeps owners and UTC days separate", async () => {
    const reserve = (owner: string, id: string, chars: number, limit = 10) =>
      rpc<{ allowed: boolean }>("public.reserve_embedding_usage($1::uuid,$2,$3,$4)", [
        owner,
        id,
        chars,
        limit,
      ]);
    expect(await reserve(ownerA, "first", 7)).toEqual({ allowed: true });
    expect(await reserve(ownerA, "first", 1)).toEqual({ allowed: false });
    expect(await reserve(ownerA, "overflow", 4)).toEqual({ allowed: false });
    expect(await reserve(ownerA, "last", 3)).toEqual({ allowed: true });
    expect(await reserve(ownerB, "first", 10)).toEqual({ allowed: true });
    await db.exec("SET TIME ZONE 'Etc/GMT+12'");
    const dates = await db.query<{ usage_date: string; utc_date: string }>(
      "SELECT DISTINCT usage_date::text, (now() AT TIME ZONE 'UTC')::date::text AS utc_date FROM public.embedding_usage",
    );
    expect(dates.rows[0].usage_date).toBe(dates.rows[0].utc_date);
    await db.exec("UPDATE public.embedding_usage SET usage_date=usage_date-1");
    expect(await reserve(ownerA, "new-day", 10)).toEqual({ allowed: true });
    expect(await reserve(ownerA, "first", 1)).toEqual({ allowed: false });
    await expect(reserve(ownerA, "bad", 0)).rejects.toMatchObject({ code: "22023" });
    await expect(reserve(ownerA, "bad", 200001)).rejects.toMatchObject({ code: "22023" });
    await expect(reserve(ownerA, "bad", 1, 10000001)).rejects.toMatchObject({ code: "22023" });
  });

  it("atomically purges a recycled source, strips retained references, and leaves Storage cleanup pending", async () => {
    const data = workspace([recycledSource()]);
    const citation = purgeCitation();
    data.annotations = [
      {
        id: "annotation-empty",
        sourceId: "source-a",
        versionId: "v1",
        quote: citation.quote,
        note: "   ",
        page: 1,
        createdAt: now,
      },
    ];
    data.notes = [
      {
        id: "note-a",
        spaceId: "library",
        title: "保留的笔记",
        content: "这是用户自己写下的正文。",
        kind: "note",
        status: "accepted",
        citations: [citation],
        manualExcerptRefs: [
          {
            sourceId: "source-a",
            versionId: "v1",
            chunkId: "chunk-a",
            selectionFingerprint: "1111111111111111",
          },
        ],
        versions: [
          {
            id: "note-a-v1",
            title: "旧笔记",
            content: "这也是用户自己写下的历史正文。",
            savedAt: now,
            citations: [citation],
            manualExcerptRefs: [
              {
                sourceId: "source-a",
                versionId: "v1",
                chunkId: "chunk-a",
                selectionFingerprint: "2222222222222222",
              },
            ],
            status: "accepted",
            spaceId: "library",
            contentRevision: 1,
          },
        ],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ];
    data.conversations = [
      {
        id: "conversation-a",
        spaceId: "library",
        sourceId: "source-a",
        title: "保留的问答",
        scope: "document-notes",
        sourceIds: ["source-a"],
        messages: [
          { id: "question-a", role: "user", content: "问题正文", citations: [], createdAt: now },
          {
            id: "answer-a",
            role: "assistant",
            content: "回答正文",
            citations: [citation],
            error: "回答连接中断。",
            attempt: {
              id: "answer-attempt-a",
              questionMessageId: "question-a",
              scopeSnapshot: {
                scope: "document-notes",
                sourceId: "source-a",
                sourceIds: ["source-a"],
                spaceId: "library",
                userContext: ["之前的问题"],
              },
              status: "failed",
            },
            noteEvidence: [
              {
                noteId: "note-a",
                spaceId: "library",
                sourceId: "source-a",
                sourceVersionId: "v1",
                revision: 1,
                updatedAt: now,
                blockId: "block-a",
                title: "保留的笔记",
                quote: "回答当时使用的个人笔记摘录。",
              },
            ],
            createdAt: now,
            mode: "model",
          },
        ],
        resolved: false,
        updatedAt: now,
      },
    ];
    data.importJobs = [
      {
        id: "import-8-source-a-v1",
        sourceId: "source-a",
        versionId: "v1",
        filename: "paper.md",
        spaceId: "library",
        stage: "indexing",
        status: "running",
        originalSaved: true,
        attempt: 1,
        createdAt: now,
        updatedAt: now,
      },
    ];
    data.organizationJobs = [
      {
        id: "organization-a",
        request: {
          requestId: "organization-a",
          kind: "source",
          trigger: "automatic",
          spaceId: "library",
          sourceIds: ["source-a"],
          sourceVersions: [{ sourceId: "source-a", versionId: "v1" }],
        },
        status: "running",
        createdAt: now,
        updatedAt: now,
      },
    ];
    data.conceptRelations = [
      {
        id: "relation-ai",
        spaceId: "library",
        type: "related",
        fromClaim: "A",
        toClaim: "B",
        fromCondition: "",
        toCondition: "",
        explanation: "AI 关系",
        fromCitations: [citation],
        toCitations: [],
        from: {
          id: "knowledge-a",
          spaceId: "library",
          title: "A",
          content: "A",
          citations: [],
          status: "accepted",
          aiGenerated: false,
          revision: 1,
          updatedAt: now,
        },
        to: {
          id: "knowledge-b",
          spaceId: "library",
          title: "B",
          content: "B",
          citations: [],
          status: "accepted",
          aiGenerated: false,
          revision: 1,
          updatedAt: now,
        },
        origin: "ai",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ];
    // Seed live content first so the purge has a real queued job and staged vector to cascade.
    data.sources[0].deletedAt = null;
    expect(await save(data)).toBe(1);
    const embeddingJob = (await claim()).jobs[0];
    await commit(embeddingJob, await read(embeddingJob, 1));
    data.sources[0].deletedAt = now;
    expect(await save(data, 1)).toBe(2);

    const preview = await previewSourcePurge();
    expect(preview).toMatchObject({
      revision: 2,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      impact: {
        source: {
          id: "source-a",
          title: "资料 source-a",
          deletedAt: expect.stringContaining("2026-09-12T12:00:00"),
        },
        versions: 2,
        annotations: 1,
        blockingAnnotations: 0,
        retainedNotes: 1,
        retainedNoteCitations: 2,
        retainedConversations: 1,
        retainedConversationCitations: 2,
        organizationJobs: 1,
        pendingOrganizationJobs: 1,
        conceptRelations: 1,
        blockingConceptRelations: 0,
        importJobs: 1,
        localOriginals: 2,
        cloudOriginals: 2,
        embeddingJobs: 1,
        embeddings: 1,
      },
      blockers: { annotations: [], conceptRelations: [] },
    });
    await db.query(
      "INSERT INTO public.ai_requests(owner_id,request_id,fingerprint,state,result) VALUES($1,'answer-cache',$2,'completed',$3::jsonb)",
      [ownerA, profile, JSON.stringify({ citations: [citation] })],
    );

    const result = await requestSourcePurge(preview);
    expect(result).toMatchObject({
      revision: 3,
      cleanupPending: true,
      purgeId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(result.data.sources).toEqual([]);
    expect(result.data.annotations).toEqual([]);
    expect(result.data.importJobs).toEqual([]);
    expect(result.data.organizationJobs).toEqual([]);
    expect(result.data.conceptRelations).toEqual([]);
    expect(result.data.notes[0]).toMatchObject({
      content: "这是用户自己写下的正文。",
      citations: [],
      manualExcerptRefs: [],
      versions: [
        expect.objectContaining({
          content: "这也是用户自己写下的历史正文。",
          citations: [],
          manualExcerptRefs: [],
        }),
      ],
    });
    expect(result.data.conversations[0]).toMatchObject({
      scope: "sources",
      sourceIds: [],
      messages: [
        expect.objectContaining({ content: "问题正文", citations: [] }),
        expect.objectContaining({
          content: "回答正文",
          citations: [],
          attempt: expect.objectContaining({
            id: "answer-attempt-a",
            questionMessageId: "question-a",
            unavailableReason: "source-purged",
            scopeSnapshot: expect.objectContaining({
              sourceId: "source-a",
              sourceIds: ["source-a"],
            }),
          }),
          noteEvidence: [expect.objectContaining({ sourceId: "source-a", sourceVersionId: "v1" })],
        }),
      ],
    });
    expect("sourceId" in result.data.conversations[0]).toBe(false);
    expect(
      (
        await db.query<{ citations: string; manual_excerpt_refs: string }>(
          "SELECT citations::text,manual_excerpt_refs::text FROM public.notes WHERE note_id='note-a'",
        )
      ).rows,
    ).toEqual([{ citations: "[]", manual_excerpt_refs: "[]" }]);
    expect(
      (
        await db.query<{ citations: string; manual_excerpt_refs: string }>(
          "SELECT citations::text,manual_excerpt_refs::text FROM public.note_versions WHERE version_id='note-a-v1'",
        )
      ).rows,
    ).toEqual([{ citations: "[]", manual_excerpt_refs: "[]" }]);
    expect((await db.query("SELECT * FROM public.sources")).rows).toEqual([]);
    expect((await db.query("SELECT * FROM public.source_versions")).rows).toEqual([]);
    expect((await db.query("SELECT * FROM public.source_chunks")).rows).toEqual([]);
    expect((await db.query("SELECT * FROM public.embedding_jobs")).rows).toEqual([]);
    expect((await db.query("SELECT * FROM public.chunk_embeddings")).rows).toEqual([]);
    expect(
      (await db.query("SELECT source_id,workspace_revision FROM public.source_tombstones")).rows,
    ).toEqual([{ source_id: "source-a", workspace_revision: 3 }]);
    expect(
      (
        await db.query<{ storage_path: string; state: string }>(
          "SELECT storage_path,state FROM public.source_purge_objects ORDER BY storage_path",
        )
      ).rows,
    ).toEqual([
      { storage_path: `${ownerA}/v0/source-a.md`, state: "pending" },
      { storage_path: `${ownerA}/v1/source-a.md`, state: "pending" },
    ]);
    expect(
      (await db.query("SELECT state FROM public.source_purges WHERE purge_id=$1", [result.purgeId]))
        .rows,
    ).toEqual([{ state: "pending" }]);
    expect(
      (
        await db.query(
          "SELECT state,result,error_code FROM public.ai_requests WHERE request_id='answer-cache'",
        )
      ).rows,
    ).toEqual([{ state: "failed", result: null, error_code: "SOURCE_PURGED" }]);

    await expect(save(data, result.revision)).rejects.toMatchObject({
      code: "40001",
      message: expect.stringContaining("permanently deleted"),
    });
    expect((await db.query("SELECT revision,data FROM public.workspaces")).rows[0]).toMatchObject({
      revision: 3,
      data: expect.objectContaining({ sources: [] }),
    });
  });

  it("allows a permanent purge only after the source has entered the recycle bin", async () => {
    const live = source();
    live.storagePath = `${ownerA}/v1/source-a.md`;
    await save(workspace([live]));
    await expect(previewSourcePurge()).rejects.toMatchObject({ code: "22023" });
    expect((await db.query("SELECT source_id FROM public.sources")).rows).toEqual([
      { source_id: "source-a" },
    ]);
    expect((await db.query("SELECT * FROM public.source_tombstones")).rows).toEqual([]);
  });

  it("rejects permanent deletion until saved annotations and manual evidence relations are resolved", async () => {
    const data = workspace([recycledSource()]);
    const citation = purgeCitation();
    data.annotations = [
      {
        id: "annotation-saved",
        sourceId: "source-a",
        versionId: "v1",
        quote: citation.quote,
        note: "用户保存的批注",
        page: 1,
        createdAt: now,
      },
    ];
    data.conceptRelations = [
      {
        id: "relation-manual",
        spaceId: "library",
        type: "related",
        fromClaim: "A",
        toClaim: "B",
        fromCondition: "",
        toCondition: "",
        explanation: "用户保存的关系",
        fromCitations: [citation],
        toCitations: [],
        from: {
          id: "knowledge-a",
          spaceId: "library",
          title: "A",
          content: "A",
          citations: [],
          status: "accepted",
          aiGenerated: false,
          revision: 1,
          updatedAt: now,
        },
        to: {
          id: "knowledge-b",
          spaceId: "library",
          title: "B",
          content: "B",
          citations: [],
          status: "accepted",
          aiGenerated: false,
          revision: 1,
          updatedAt: now,
        },
        origin: "manual",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ];
    await save(data);
    const preview = await previewSourcePurge();
    expect(preview.impact).toMatchObject({
      annotations: 0,
      blockingAnnotations: 1,
      conceptRelations: 0,
      blockingConceptRelations: 1,
    });
    expect(preview.blockers).toEqual({
      annotations: ["annotation-saved"],
      conceptRelations: ["relation-manual"],
    });
    await expect(requestSourcePurge(preview)).rejects.toMatchObject({ code: "P0001" });
    expect((await db.query("SELECT source_id FROM public.sources")).rows).toEqual([
      { source_id: "source-a" },
    ]);
    expect((await db.query("SELECT * FROM public.source_tombstones")).rows).toEqual([]);
    expect((await db.query("SELECT * FROM public.source_purge_objects")).rows).toEqual([]);
    expect((await db.query("SELECT revision FROM public.workspaces")).rows).toEqual([
      { revision: 1 },
    ]);
  });

  it("requires a current server fingerprint and revision before a purge can mutate data", async () => {
    await save(workspace([recycledSource()]));
    const preview = await previewSourcePurge();
    await db.exec("SET TIME ZONE 'Etc/GMT-9'");
    expect((await previewSourcePurge()).fingerprint).toBe(preview.fingerprint);
    await db.exec("SET TIME ZONE 'UTC'");
    await expect(
      rpc(
        "public.request_source_purge($1,$2::bigint,$3)",
        ["source-a", preview.revision, "0".repeat(64)],
        "authenticated",
        ownerA,
      ),
    ).rejects.toMatchObject({ code: "40001" });
    await expect(
      rpc(
        "public.request_source_purge($1,$2::bigint,$3)",
        ["source-a", preview.revision + 1, preview.fingerprint],
        "authenticated",
        ownerA,
      ),
    ).rejects.toMatchObject({ code: "40001" });
    expect((await db.query("SELECT source_id FROM public.sources")).rows).toEqual([
      { source_id: "source-a" },
    ]);
    expect((await db.query("SELECT * FROM public.source_tombstones")).rows).toEqual([]);
  });

  it("never exposes or deletes another account's source through purge RPCs", async () => {
    await save(workspace([recycledSource()]));
    await expect(previewSourcePurge("source-a", ownerB)).rejects.toMatchObject({ code: "22023" });
    await expect(
      rpc(
        "public.request_source_purge($1,$2::bigint,$3)",
        ["source-a", 1, "0".repeat(64)],
        "authenticated",
        ownerB,
      ),
    ).rejects.toMatchObject({ code: "22023" });
    expect((await db.query("SELECT owner_id,source_id FROM public.sources")).rows).toEqual([
      { owner_id: ownerA, source_id: "source-a" },
    ]);
    expect((await db.query("SELECT * FROM public.source_tombstones")).rows).toEqual([]);
  });

  it("leases only canonical purge paths, records completion, and never calls Storage from SQL", async () => {
    await save(workspace([recycledSource()]));
    const preview = await previewSourcePurge();
    const purge = await requestSourcePurge(preview);
    await db.query(
      "INSERT INTO storage.objects(bucket_id,name) VALUES ('originals',$1),('originals',$2)",
      [`${ownerA}/v0/source-a.md`, `${ownerA}/v1/source-a.md`],
    );

    const claimed = await claimSourcePurgeObjects("purge-worker", 2);
    expect(claimed.objects).toHaveLength(2);
    expect(claimed.objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          purgeId: purge.purgeId,
          ownerId: ownerA,
          storagePath: `${ownerA}/v0/source-a.md`,
          attempt: 1,
          leaseToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
        }),
        expect.objectContaining({
          purgeId: purge.purgeId,
          ownerId: ownerA,
          storagePath: `${ownerA}/v1/source-a.md`,
          attempt: 1,
          leaseToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
        }),
      ]),
    );
    expect(Object.keys(claimed.objects[0]!).sort()).toEqual([
      "attempt",
      "leaseToken",
      "leaseUntil",
      "ownerId",
      "purgeId",
      "storagePath",
    ]);
    expect(await heartbeatSourcePurgeObject(claimed.objects[0]!, 15)).toMatchObject({
      leaseUntil: expect.any(String),
    });
    await expect(heartbeatSourcePurgeObject(claimed.objects[0]!, 14)).rejects.toMatchObject({
      code: "22023",
    });

    expect(await completeSourcePurgeObject(claimed.objects[0]!)).toMatchObject({
      state: "completed",
      purgeState: "processing",
      completedAt: expect.any(String),
    });
    expect(await completeSourcePurgeObject(claimed.objects[1]!)).toMatchObject({
      state: "completed",
      purgeState: "completed",
      completedAt: expect.any(String),
    });
    expect(
      (
        await db.query(
          "SELECT state,attempts,lease_token,completed_at FROM public.source_purge_objects ORDER BY storage_path",
        )
      ).rows,
    ).toEqual([
      { state: "completed", attempts: 1, lease_token: null, completed_at: expect.any(Date) },
      { state: "completed", attempts: 1, lease_token: null, completed_at: expect.any(Date) },
    ]);
    expect(
      (
        await db.query(
          "SELECT state,completed_at,last_error FROM public.source_purges WHERE purge_id=$1",
          [purge.purgeId],
        )
      ).rows,
    ).toEqual([{ state: "completed", completed_at: expect.any(Date), last_error: null }]);
    // The privileged worker must remove these objects through Supabase Storage itself.
    // Completing an outbox entry is purely a database acknowledgement.
    expect(
      (await db.query("SELECT name FROM storage.objects WHERE bucket_id='originals' ORDER BY name"))
        .rows,
    ).toEqual([{ name: `${ownerA}/v0/source-a.md` }, { name: `${ownerA}/v1/source-a.md` }]);
  });

  it("retries a failed purge object with a fresh lease and rejects stale acknowledgements", async () => {
    const item = source();
    item.deletedAt = now;
    item.blobKey = "original:source-a:v1";
    item.storagePath = `${ownerA}/v1/source-a.md`;
    await save(workspace([item]));
    const purge = await requestSourcePurge(await previewSourcePurge());
    const first = (await claimSourcePurgeObjects())["objects"][0]!;
    expect(await failSourcePurgeObject(first, "STORAGE_TIMEOUT")).toMatchObject({
      state: "pending",
      purgeState: "pending",
      nextAttemptAt: expect.any(String),
    });
    expect((await claimSourcePurgeObjects()).objects).toEqual([]);
    await db.exec(
      "UPDATE public.source_purge_objects SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE purge_id='" +
        purge.purgeId +
        "'",
    );
    const retry = (await claimSourcePurgeObjects())["objects"][0]!;
    expect(retry).toMatchObject({ attempt: 2, storagePath: first.storagePath });
    expect(retry.leaseToken).not.toBe(first.leaseToken);
    await expect(completeSourcePurgeObject(first)).rejects.toMatchObject({ code: "40001" });
    await expect(failSourcePurgeObject(retry, "https://secret")).rejects.toMatchObject({
      code: "22023",
    });
    expect(await failSourcePurgeObject(retry, "ACCESS_DENIED", false)).toMatchObject({
      state: "failed",
      purgeState: "failed",
      nextAttemptAt: null,
    });
    expect(
      (await db.query("SELECT state,attempts,last_error FROM public.source_purge_objects")).rows,
    ).toEqual([{ state: "failed", attempts: 2, last_error: "ACCESS_DENIED" }]);
    expect(
      (
        await db.query("SELECT state,last_error FROM public.source_purges WHERE purge_id=$1", [
          purge.purgeId,
        ])
      ).rows,
    ).toEqual([{ state: "failed", last_error: "ACCESS_DENIED" }]);
  });

  it("reclaims expired leases only up to the bounded attempt limit", async () => {
    const item = source();
    item.deletedAt = now;
    item.blobKey = "original:source-a:v1";
    item.storagePath = `${ownerA}/v1/source-a.md`;
    await save(workspace([item]));
    const purge = await requestSourcePurge(await previewSourcePurge());
    let object = (await claimSourcePurgeObjects())["objects"][0]!;
    expect(object.attempt).toBe(1);
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await db.query(
        "UPDATE public.source_purge_objects SET lease_until=clock_timestamp()-interval '1 second' WHERE purge_id=$1",
        [purge.purgeId],
      );
      object = (await claimSourcePurgeObjects())["objects"][0]!;
      expect(object.attempt).toBe(attempt);
    }
    await db.query(
      "UPDATE public.source_purge_objects SET lease_until=clock_timestamp()-interval '1 second' WHERE purge_id=$1",
      [purge.purgeId],
    );
    expect((await claimSourcePurgeObjects()).objects).toEqual([]);
    expect(
      (await db.query("SELECT state,attempts,last_error FROM public.source_purge_objects")).rows,
    ).toEqual([{ state: "failed", attempts: 5, last_error: "LEASE_EXPIRED" }]);
    expect(
      (
        await db.query("SELECT state,last_error FROM public.source_purges WHERE purge_id=$1", [
          purge.purgeId,
        ])
      ).rows,
    ).toEqual([{ state: "failed", last_error: "LEASE_EXPIRED" }]);
  });

  it("keeps purge queue paths service-only while the worker can drain distinct owners", async () => {
    const ownerASource = source("owner-a");
    ownerASource.deletedAt = now;
    ownerASource.blobKey = "original:owner-a:v1";
    ownerASource.storagePath = `${ownerA}/v1/owner-a.md`;
    const ownerBSource = source("owner-b");
    ownerBSource.deletedAt = now;
    ownerBSource.blobKey = "original:owner-b:v1";
    ownerBSource.storagePath = `${ownerB}/v1/owner-b.md`;
    await save(workspace([ownerASource]), 0, ownerA);
    await save(workspace([ownerBSource]), 0, ownerB);
    await requestSourcePurge(await previewSourcePurge("owner-a", ownerA), "owner-a", ownerA);
    await requestSourcePurge(await previewSourcePurge("owner-b", ownerB), "owner-b", ownerB);

    await expect(
      rpc("public.claim_source_purge_objects('untrusted')", [], "authenticated", ownerA),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      rpc("public.claim_source_purge_objects('untrusted')", [], "anon", null),
    ).rejects.toMatchObject({ code: "42501" });
    // service_role is the internal worker boundary. It can see the exact path it must
    // delete, whereas an owner session has neither table access nor a queue RPC.
    const claimed = await claimSourcePurgeObjects("purge-worker", 10);
    expect(claimed.objects.map((object) => [object.ownerId, object.storagePath]).sort()).toEqual([
      [ownerA, `${ownerA}/v1/owner-a.md`],
      [ownerB, `${ownerB}/v1/owner-b.md`],
    ]);
  });

  it("purges one historical version atomically while preserving authored citation history", async () => {
    const current = source();
    current.blobKey = "original:source-a:v1";
    current.storagePath = `${ownerA}/v1/source-a.md`;
    const history = archived(source("source-a", "v0"));
    history.blobKey = "original:source-a:v0";
    history.storagePath = `${ownerA}/v0/source-a.md`;
    current.versions = [history];
    const data = workspace([current]);
    const oldCitation = purgeCitation("source-a", "v0");
    data.annotations = [
      {
        id: "highlight-old",
        sourceId: "source-a",
        versionId: "v0",
        quote: oldCitation.quote,
        note: "",
        createdAt: now,
      },
    ];
    data.notes = [note("note-old", { citations: [oldCitation] })];
    data.conversations = [conversation("conversation-old")];
    data.conversations[0].messages[1]!.citations = [oldCitation];
    data.importJobs = [
      {
        id: "import-old",
        sourceId: "source-a",
        versionId: "v0",
        filename: history.filename,
        spaceId: "library",
        stage: "indexing",
        status: "completed",
        originalSaved: true,
        attempt: 1,
        createdAt: now,
        updatedAt: now,
      },
    ];
    data.organizationJobs = [
      {
        id: "organization-old",
        request: {
          requestId: "organization-old",
          kind: "source",
          trigger: "manual",
          spaceId: "library",
          sourceIds: ["source-a"],
          sourceVersions: [{ sourceId: "source-a", versionId: "v0" }],
        },
        status: "ready",
        createdAt: now,
        updatedAt: now,
      },
    ];
    data.conceptRelations = [
      conceptRelation("relation-old", { origin: "ai", fromCitations: [oldCitation] }),
    ];
    await save(data);

    const preview = await previewSourceVersionPurge();
    expect(preview).toMatchObject({
      revision: 1,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      impact: {
        source: { id: "source-a", title: "资料 source-a" },
        version: { versionId: "v0", filename: "paper.md", createdAt: now, archivedAt: now },
        annotations: 1,
        blockingAnnotations: 0,
        retainedNotes: 1,
        retainedNoteCitations: 1,
        retainedConversations: 1,
        retainedConversationCitations: 1,
        organizationJobs: 1,
        blockingOrganizationJobs: 0,
        conceptRelations: 1,
        blockingConceptRelations: 0,
        importJobs: 1,
        blockingImportJobs: 0,
        localOriginals: 1,
        cloudOriginals: 1,
      },
      blockers: { annotations: [], conceptRelations: [], organizationJobs: [], importJobs: [] },
    });

    const result = await requestSourceVersionPurge(preview);
    expect(result).toMatchObject({ revision: 2, cleanupPending: true });
    expect(result.data.sources[0]).toMatchObject({ id: "source-a", versionId: "v1", versions: [] });
    expect(result.data.annotations).toEqual([]);
    expect(result.data.importJobs).toEqual([]);
    expect(result.data.organizationJobs).toEqual([]);
    expect(result.data.conceptRelations).toEqual([]);
    expect(result.data.notes[0].citations).toEqual([oldCitation]);
    expect(result.data.conversations[0].messages[1].citations).toEqual([oldCitation]);
    expect(
      (await db.query("SELECT version_id FROM public.source_versions ORDER BY version_id")).rows,
    ).toEqual([{ version_id: "v1" }]);
    expect(
      (await db.query("SELECT version_id FROM public.source_chunks ORDER BY version_id")).rows,
    ).toEqual([{ version_id: "v1" }, { version_id: "v1" }]);
    expect(
      (
        await db.query(
          "SELECT purge_scope,version_id,state FROM public.source_purges WHERE purge_id=$1",
          [result.purgeId],
        )
      ).rows,
    ).toEqual([{ purge_scope: "version", version_id: "v0", state: "pending" }]);
    expect(
      (
        await db.query(
          "SELECT storage_path,state FROM public.source_purge_objects WHERE purge_id=$1",
          [result.purgeId],
        )
      ).rows,
    ).toEqual([{ storage_path: `${ownerA}/v0/source-a.md`, state: "pending" }]);
  });

  it("blocks a historical version purge for saved content, active work, stale context, and other owners", async () => {
    const current = source();
    const history = archived(source("source-a", "v0"));
    current.versions = [history];
    const data = workspace([current]);
    const oldCitation = purgeCitation("source-a", "v0");
    data.annotations = [
      {
        id: "annotation-old",
        sourceId: "source-a",
        versionId: "v0",
        quote: oldCitation.quote,
        note: "保存",
        createdAt: now,
      },
    ];
    data.importJobs = [
      {
        id: "import-old",
        sourceId: "source-a",
        versionId: "v0",
        filename: history.filename,
        spaceId: "library",
        stage: "parsing",
        status: "running",
        originalSaved: true,
        attempt: 1,
        createdAt: now,
        updatedAt: now,
      },
    ];
    data.organizationJobs = [
      {
        id: "organization-old",
        request: {
          requestId: "organization-old",
          kind: "source",
          trigger: "manual",
          spaceId: "library",
          sourceIds: ["source-a"],
          sourceVersions: [{ sourceId: "source-a", versionId: "v0" }],
        },
        status: "running",
        createdAt: now,
        updatedAt: now,
      },
    ];
    data.conceptRelations = [conceptRelation("relation-old", { fromCitations: [oldCitation] })];
    await save(data);
    const preview = await previewSourceVersionPurge();
    expect(preview.blockers).toEqual({
      annotations: ["annotation-old"],
      conceptRelations: ["relation-old"],
      organizationJobs: ["organization-old"],
      importJobs: ["import-old"],
    });
    await expect(requestSourceVersionPurge(preview)).rejects.toMatchObject({ code: "P0001" });
    await expect(previewSourceVersionPurge("source-a", "v0", ownerB)).rejects.toMatchObject({
      code: "22023",
    });
    await expect(
      rpc(
        "public.request_source_version_purge($1,$2,$3::bigint,$4)",
        ["source-a", "v0", preview.revision + 1, preview.fingerprint],
        "authenticated",
        ownerA,
      ),
    ).rejects.toMatchObject({ code: "40001" });
    expect(
      (await db.query("SELECT version_id FROM public.source_versions ORDER BY version_id")).rows,
    ).toEqual([{ version_id: "v0" }, { version_id: "v1" }]);
  });
});
