import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Note, Source, WorkspaceData } from "../types";

// The lease RPCs run on the real migration chain. This covers the parse fence
// against actual source/note projections rather than a mocked snapshot store.
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sourceId = "source-a";
const versionId = "v1";
const now = "2026-09-13T12:00:00.000Z";
const later = "2026-09-13T12:01:00.000Z";

type Role = "anon" | "authenticated" | "service_role";
type Claim = {
  status: "claimed" | "busy";
  sourceId: string;
  versionId: string;
  leaseToken?: string;
  leaseUntil?: string;
  workspaceRevision: number;
};

let db: PGlite;

function parsingSource(id = sourceId, version = versionId): Source {
  return {
    id,
    versionId: version,
    title: `Parse lease source ${id}`,
    filename: "parse-source.md",
    kind: "markdown",
    mime: "text/markdown",
    size: 128,
    hash: "test-parse-source",
    spaceIds: ["library"],
    tags: [],
    status: "parsing",
    coverage: { captureScope: "full", parseState: "pending" },
    text: "",
    chunks: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    aiAllowed: true,
    starred: false,
    blobKey: `original:${id}:${version}`,
    storagePath: `${ownerA}/${version}/${id}.md`,
  };
}

function runningJob(id = sourceId, version = versionId) {
  return {
    id: `import-${id.length}-${id}-${version}`,
    sourceId: id,
    versionId: version,
    filename: "parse-source.md",
    spaceId: "library",
    stage: "parsing" as const,
    status: "running" as const,
    originalSaved: true,
    attempt: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function note(id = "lease-note"): Note {
  return {
    id,
    spaceId: "library",
    title: "Lease note",
    content: "A normal note written while another device parses a source.",
    kind: "note",
    status: "accepted",
    citations: [],
    versions: [],
    createdAt: later,
    updatedAt: later,
    deletedAt: null,
  };
}

function workspace(
  source = parsingSource(),
  jobs = [runningJob(source.id, source.versionId)],
): WorkspaceData {
  return {
    schemaVersion: 1,
    spaces: [
      { id: "library", name: "Library", goal: "", color: "blue", archived: false, createdAt: now },
    ],
    sources: [source],
    notes: [],
    annotations: [],
    conversations: [],
    aiEnabled: true,
    semanticSearch: true,
    importJobs: jobs,
  };
}

function successfulFinish(data: WorkspaceData): WorkspaceData {
  const next = structuredClone(data);
  const source = next.sources[0]!;
  const text = "This is the parsed content that must only be committed by the active lease.";
  source.status = "ready";
  source.coverage = { captureScope: "full", parseState: "complete" };
  source.text = text;
  source.chunks = [
    {
      id: "chunk-a",
      sourceId,
      versionId,
      text,
      section: "Parsed",
      page: 1,
      order: 0,
    },
  ];
  source.updatedAt = later;
  const job = next.importJobs![0]!;
  job.stage = "indexing";
  job.status = "completed";
  job.completedAt = later;
  job.updatedAt = later;
  return next;
}

function failedFinish(data: WorkspaceData): WorkspaceData {
  const next = structuredClone(data);
  const source = next.sources[0]!;
  source.status = "failed";
  source.coverage = { captureScope: "full", parseState: "failed" };
  source.text = "";
  source.chunks = [];
  source.error = "No readable text";
  source.updatedAt = later;
  const job = next.importJobs![0]!;
  job.stage = "parsing";
  job.status = "failed";
  job.error = "No readable text";
  job.updatedAt = later;
  return next;
}

function cancelledParse(data: WorkspaceData): WorkspaceData {
  const next = structuredClone(data);
  const source = next.sources[0]!;
  source.status = "saved";
  source.coverage = { captureScope: "full", parseState: "pending" };
  source.text = "";
  source.chunks = [];
  source.error = "Parsing cancelled; the original remains available for retry.";
  delete source.pageCount;
  delete source.parsedPages;
  source.updatedAt = later;
  const job = next.importJobs![0]!;
  job.stage = "parsing";
  job.status = "cancelled";
  delete job.error;
  job.cancelledAt = later;
  job.updatedAt = later;
  return next;
}

function retriedParse(data: WorkspaceData, status: "queued" | "running" = "queued"): WorkspaceData {
  const next = structuredClone(data);
  const source = next.sources[0]!;
  source.status = "parsing";
  source.coverage = { captureScope: "full", parseState: "pending" };
  source.text = "";
  source.chunks = [];
  delete source.error;
  delete source.pageCount;
  delete source.parsedPages;
  source.updatedAt = later;
  const job = next.importJobs![0]!;
  job.stage = "parsing";
  job.status = status;
  delete job.error;
  delete job.cancelledAt;
  delete job.completedAt;
  job.updatedAt = later;
  return next;
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

async function claim(owner = ownerA, leaseSeconds = 120) {
  return rpc<Claim>(
    "public.claim_import_parse($1,$2,$3)",
    [sourceId, versionId, leaseSeconds],
    owner,
  );
}

async function heartbeat(token: string, owner = ownerA, leaseSeconds = 120) {
  return rpc<{ leaseUntil: string }>(
    "public.heartbeat_import_parse($1,$2,$3,$4)",
    [sourceId, versionId, token, leaseSeconds],
    owner,
  );
}

async function release(token: string, owner = ownerA) {
  return rpc<{ released: boolean; alreadyReleased: boolean }>(
    "public.release_import_parse($1,$2,$3)",
    [sourceId, versionId, token],
    owner,
  );
}

async function finish(data: WorkspaceData, revision: number, token: string | null, owner = ownerA) {
  return rpc<{ revision: number }>(
    "public.finish_import_parse($1,$2,$3,$4::bigint,$5::jsonb)",
    [sourceId, versionId, token, revision, JSON.stringify(data)],
    owner,
  );
}

async function cancelParse(data: WorkspaceData, revision: number, owner = ownerA) {
  return rpc<{ revision: number }>(
    "public.cancel_import_parse($1,$2,$3::bigint,$4::jsonb)",
    [sourceId, versionId, revision, JSON.stringify(data)],
    owner,
  );
}

async function retryParse(data: WorkspaceData, revision: number, owner = ownerA) {
  return rpc<{ revision: number }>(
    "public.retry_import_parse($1,$2,$3::bigint,$4::jsonb)",
    [sourceId, versionId, revision, JSON.stringify(data)],
    owner,
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
      CREATE TABLE storage.objects(bucket_id text,name text);
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
    "RESET ROLE; TRUNCATE public.workspaces CASCADE; TRUNCATE public.account_deletions CASCADE; TRUNCATE public.embedding_usage; TRUNCATE storage.objects; INSERT INTO auth.users(id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') ON CONFLICT (id) DO NOTHING; UPDATE public.embedding_profiles SET fingerprint=null; SET TIME ZONE 'UTC';",
  );
});

afterAll(async () => {
  if (db && !db.closed) await db.close();
});

describe("import parse leases", () => {
  it("returns one claimant and one busy result for two same-owner claim attempts", async () => {
    expect(await save(workspace())).toBe(1);

    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [ownerA]);
    await db.exec("SET ROLE authenticated");
    let claims: Claim[];
    try {
      claims = await Promise.all(
        [0, 1].map(async () => {
          const result = await db.query<{ result: Claim }>(
            "SELECT public.claim_import_parse($1,$2,120) AS result",
            [sourceId, versionId],
          );
          return result.rows[0]!.result;
        }),
      );
    } finally {
      await db.exec("RESET ROLE");
    }

    expect(claims.map((item) => item.status).sort()).toEqual(["busy", "claimed"]);
    const claimed = claims.find((item) => item.status === "claimed")!;
    const busy = claims.find((item) => item.status === "busy")!;
    expect(claimed).toMatchObject({
      sourceId,
      versionId,
      workspaceRevision: 1,
      leaseToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
      leaseUntil: expect.any(String),
    });
    expect(busy).toMatchObject({
      sourceId,
      versionId,
      workspaceRevision: 1,
      leaseUntil: expect.any(String),
    });
    expect((await db.query("SELECT * FROM conuo_private.import_parse_leases")).rows).toHaveLength(
      1,
    );
  });

  it("fences stale and expired tokens, while heartbeat renews only the current token", async () => {
    const data = workspace();
    await save(data);
    const first = await claim();
    const token = first.leaseToken!;

    await expect(heartbeat("00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
      code: "40001",
    });
    expect(await heartbeat(token, ownerA, 60)).toMatchObject({ leaseUntil: expect.any(String) });

    await db.exec(
      "UPDATE conuo_private.import_parse_leases SET lease_until=clock_timestamp()-interval '1 second'",
    );
    await expect(heartbeat(token)).rejects.toMatchObject({ code: "40001" });
    const replacement = await claim();
    expect(replacement).toMatchObject({ status: "claimed", workspaceRevision: 1 });
    expect(replacement.leaseToken).not.toBe(token);
    await expect(finish(successfulFinish(data), 1, token)).rejects.toMatchObject({ code: "40001" });
    expect(await heartbeat(replacement.leaseToken!)).toMatchObject({
      leaseUntil: expect.any(String),
    });
  });

  it("allows unrelated saves but rejects terminal, cancellation, and deletion changes through save_workspace", async () => {
    const data = workspace();
    await save(data);
    const claimed = await claim();

    await expect(save(successfulFinish(data), 1)).rejects.toMatchObject({ code: "40001" });
    const cancelled = structuredClone(data);
    cancelled.importJobs![0]!.status = "cancelled";
    cancelled.importJobs![0]!.cancelledAt = later;
    await expect(save(cancelled, 1)).rejects.toMatchObject({ code: "40001" });
    const deleted = structuredClone(data);
    deleted.sources[0]!.deletedAt = later;
    await expect(save(deleted, 1)).rejects.toMatchObject({ code: "40001" });

    const reading = structuredClone(data);
    reading.sources[0]!.readPage = 1;
    reading.sources[0]!.readOffset = 0.5;
    reading.sources[0]!.lastReadAt = later;
    await expect(save(reading, 1)).rejects.toMatchObject({ code: "40001" });

    const unrelated = structuredClone(data);
    unrelated.spaces[0]!.name = "Renamed library";
    unrelated.notes = [note()];
    expect(await save(unrelated, 1)).toBe(2);
    expect(
      (
        await db.query("SELECT status,text FROM public.source_versions WHERE source_id=$1", [
          sourceId,
        ])
      ).rows,
    ).toEqual([{ status: "parsing", text: "" }]);
    expect(
      (await db.query("SELECT title FROM public.notes WHERE note_id='lease-note'")).rows,
    ).toEqual([{ title: "Lease note" }]);
    expect(
      (await db.query("SELECT count(*)::int AS count FROM conuo_private.import_parse_leases")).rows,
    ).toEqual([{ count: 1 }]);
    expect(claimed.leaseToken).toEqual(expect.any(String));
  });

  it("finishes atomically at the current revision, rebuilds the source projection, projects notes, and clears the lease", async () => {
    const initial = workspace();
    expect(await save(initial)).toBe(1);
    const claimed = await claim();
    const staleResult = successfulFinish(initial);
    staleResult.notes = [note("finish-note")];

    await expect(finish(staleResult, 2, claimed.leaseToken!)).rejects.toMatchObject({
      code: "40001",
    });
    expect(
      (await db.query("SELECT revision FROM public.workspaces WHERE owner_id=$1", [ownerA])).rows,
    ).toEqual([{ revision: 1 }]);
    expect((await db.query("SELECT * FROM conuo_private.import_parse_leases")).rows).toHaveLength(
      1,
    );

    const unrelated = structuredClone(initial);
    unrelated.spaces[0]!.goal = "Keep learning";
    expect(await save(unrelated, 1)).toBe(2);
    await expect(finish(staleResult, 1, claimed.leaseToken!)).rejects.toMatchObject({
      code: "40001",
    });

    const mergedResult = successfulFinish(unrelated);
    mergedResult.notes = [note("finish-note")];
    expect(await finish(mergedResult, 2, claimed.leaseToken!)).toEqual({ revision: 3 });
    expect((await db.query("SELECT * FROM conuo_private.import_parse_leases")).rows).toEqual([]);
    expect(
      (
        await db.query(
          "SELECT status,text FROM public.source_versions WHERE owner_id=$1 AND source_id=$2 AND version_id=$3",
          [ownerA, sourceId, versionId],
        )
      ).rows,
    ).toEqual([
      {
        status: "ready",
        text: "This is the parsed content that must only be committed by the active lease.",
      },
    ]);
    expect(
      (
        await db.query("SELECT chunk_id,text FROM public.source_chunks WHERE source_id=$1", [
          sourceId,
        ])
      ).rows,
    ).toEqual([
      {
        chunk_id: "chunk-a",
        text: "This is the parsed content that must only be committed by the active lease.",
      },
    ]);
    expect(
      (await db.query("SELECT note_id FROM public.notes WHERE note_id='finish-note'")).rows,
    ).toEqual([{ note_id: "finish-note" }]);
  });

  it("does not let a finishing parser replace immutable original or web source identity", async () => {
    const initial = workspace();
    await save(initial);
    const claimed = await claim();
    const validWebSnapshot = {
      originalUrl: "https://example.test/original",
      finalUrl: "https://example.test/final",
      capturedAt: later,
      method: "server" as const,
      scope: "article" as const,
      warnings: [],
    };
    const mutations: Array<[string, (source: Source) => void]> = [
      ["title", (source) => (source.title = "Tampered title")],
      ["hash", (source) => (source.hash = "tampered-hash")],
      ["filename", (source) => (source.filename = "tampered.txt")],
      ["mime", (source) => (source.mime = "text/plain")],
      ["kind", (source) => (source.kind = "text")],
      ["size", (source) => (source.size = 129)],
      ["blobKey", (source) => (source.blobKey = "original:tampered")],
      ["storagePath", (source) => (source.storagePath = `${ownerA}/v1/source-a.txt`)],
      ["url", (source) => (source.url = "https://example.test/tampered")],
      ["webSnapshot", (source) => (source.webSnapshot = validWebSnapshot)],
      ["originalMissing", (source) => (source.originalMissing = false)],
      ["versionCreatedAt", (source) => (source.versionCreatedAt = later)],
      ["createdAt", (source) => (source.createdAt = later)],
      [
        "coverage capture scope",
        (source) => (source.coverage = { captureScope: "manual", parseState: "complete" }),
      ],
    ];

    for (const [, mutate] of mutations) {
      const tampered = successfulFinish(initial);
      mutate(tampered.sources[0]!);
      await expect(finish(tampered, 1, claimed.leaseToken!)).rejects.toMatchObject({
        code: "40001",
        message: "Import parse source identity changed",
      });
    }

    const jobMutations: Array<(data: WorkspaceData) => void> = [
      (data) => (data.importJobs![0]!.id = "tampered-import-job"),
      (data) => (data.importJobs![0]!.filename = "tampered-import.md"),
      (data) => (data.importJobs![0]!.spaceId = "different-space"),
    ];
    for (const mutate of jobMutations) {
      const tampered = successfulFinish(initial);
      mutate(tampered);
      await expect(finish(tampered, 1, claimed.leaseToken!)).rejects.toMatchObject({
        code: "40001",
        message: "Import parse job identity changed",
      });
    }

    expect(await finish(successfulFinish(initial), 1, claimed.leaseToken!)).toEqual({
      revision: 2,
    });
    expect(
      (
        await db.query(
          "SELECT manifest,blob_key,storage_path FROM public.source_versions WHERE owner_id=$1 AND source_id=$2 AND version_id=$3",
          [ownerA, sourceId, versionId],
        )
      ).rows,
    ).toEqual([
      expect.objectContaining({
        blob_key: `original:${sourceId}:${versionId}`,
        storage_path: `${ownerA}/${versionId}/${sourceId}.md`,
      }),
    ]);
  });

  it("keeps the same immutable identity guard for cancellation and retry", async () => {
    const initial = workspace();
    await save(initial);
    await claim();

    const cancelled = cancelledParse(initial);
    const tamperedCancellation = structuredClone(cancelled);
    tamperedCancellation.sources[0]!.storagePath = `${ownerA}/${versionId}/${sourceId}.txt`;
    await expect(cancelParse(tamperedCancellation, 1)).rejects.toMatchObject({
      code: "40001",
      message: "Import parse source identity changed",
    });
    const cancellationJobMutations: Array<(data: WorkspaceData) => void> = [
      (data) => (data.importJobs![0]!.id = "tampered-cancel-job"),
      (data) => (data.importJobs![0]!.filename = "tampered-cancel.md"),
      (data) => (data.importJobs![0]!.spaceId = "different-space"),
    ];
    for (const mutate of cancellationJobMutations) {
      const tampered = structuredClone(cancelled);
      mutate(tampered);
      await expect(cancelParse(tampered, 1)).rejects.toMatchObject({
        code: "40001",
        message: "Import parse job identity changed",
      });
    }
    expect(await cancelParse(cancelled, 1)).toEqual({ revision: 2 });

    const retried = retriedParse(cancelled);
    const tamperedRetry = structuredClone(retried);
    tamperedRetry.sources[0]!.webSnapshot = {
      originalUrl: "https://example.test/original",
      finalUrl: "https://example.test/tampered",
      capturedAt: later,
      method: "server",
      scope: "article",
      warnings: [],
    };
    await expect(retryParse(tamperedRetry, 2)).rejects.toMatchObject({
      code: "40001",
      message: "Import parse source identity changed",
    });
    const retryJobMutations: Array<(data: WorkspaceData) => void> = [
      (data) => (data.importJobs![0]!.id = "tampered-retry-job"),
      (data) => (data.importJobs![0]!.filename = "tampered-retry.md"),
      (data) => (data.importJobs![0]!.spaceId = "different-space"),
    ];
    for (const mutate of retryJobMutations) {
      const tampered = structuredClone(retried);
      mutate(tampered);
      await expect(retryParse(tampered, 2)).rejects.toMatchObject({
        code: "40001",
        message: "Import parse job identity changed",
      });
    }
    expect(await retryParse(retried, 2)).toEqual({ revision: 3 });
  });

  it("normalizes legacy missing coverage for a controlled full-document finish", async () => {
    const legacy = workspace();
    Reflect.deleteProperty(legacy.sources[0]!, "coverage");
    expect(await save(legacy)).toBe(1);
    const claimed = await claim();

    expect(await finish(successfulFinish(legacy), 1, claimed.leaseToken!)).toEqual({ revision: 2 });
  });

  it("rejects malformed stored coverage with a controlled identity error", async () => {
    const initial = workspace();
    await save(initial);
    const claimed = await claim();

    for (const malformedCoverage of ["null", '"malformed"']) {
      // Directly corrupt only the stored snapshot to exercise the RPC's
      // defensive comparison path; normal save validation rejects this input.
      await db.query(
        "UPDATE public.workspaces SET data=jsonb_set(data,ARRAY['sources','0','coverage'],$1::jsonb) WHERE owner_id=$2",
        [malformedCoverage, ownerA],
      );
      await expect(finish(successfulFinish(initial), 1, claimed.leaseToken!)).rejects.toMatchObject(
        {
          code: "40001",
          message: "Import parse source identity changed",
        },
      );
    }
  });

  it("does not let one finishing lease overwrite another active parse pair in its full snapshot", async () => {
    const otherSourceId = "source-b";
    const otherVersionId = "v1";
    const initial = workspace(parsingSource(), [
      runningJob(),
      runningJob(otherSourceId, otherVersionId),
    ]);
    initial.sources.push(parsingSource(otherSourceId, otherVersionId));
    await save(initial);
    const first = await claim();
    const other = await rpc<Claim>("public.claim_import_parse($1,$2,120)", [
      otherSourceId,
      otherVersionId,
    ]);

    const staleBothFinished = successfulFinish(initial);
    const source = staleBothFinished.sources.find((item) => item.id === otherSourceId)!;
    const text = "A stale second parse must not be included in the first parser output.";
    source.status = "ready";
    source.coverage = { captureScope: "full", parseState: "complete" };
    source.text = text;
    source.chunks = [
      {
        id: "chunk-b",
        sourceId: otherSourceId,
        versionId: otherVersionId,
        text,
        section: "Parsed",
        page: 1,
        order: 0,
      },
    ];
    source.updatedAt = later;
    const job = staleBothFinished.importJobs!.find((item) => item.sourceId === otherSourceId)!;
    job.status = "completed";
    job.stage = "indexing";
    job.completedAt = later;
    job.updatedAt = later;

    await expect(finish(staleBothFinished, 1, first.leaseToken!)).rejects.toMatchObject({
      code: "40001",
    });
    expect(
      (
        await db.query(
          "SELECT source_id,status,text FROM public.source_versions WHERE owner_id=$1 ORDER BY source_id",
          [ownerA],
        )
      ).rows,
    ).toEqual([
      { source_id: sourceId, status: "parsing", text: "" },
      { source_id: otherSourceId, status: "parsing", text: "" },
    ]);
    expect((await db.query("SELECT * FROM conuo_private.import_parse_leases")).rows).toHaveLength(
      2,
    );
    expect(other.leaseToken).toEqual(expect.any(String));
  });

  it("accepts a failed terminal snapshot and clears its fence", async () => {
    const initial = workspace();
    await save(initial);
    const claimed = await claim();

    expect(await finish(failedFinish(initial), 1, claimed.leaseToken!)).toEqual({ revision: 2 });
    expect(
      (await db.query("SELECT status FROM public.source_versions WHERE source_id=$1", [sourceId]))
        .rows,
    ).toEqual([{ status: "failed" }]);
    expect((await db.query("SELECT * FROM conuo_private.import_parse_leases")).rows).toEqual([]);
  });

  it("lets any owner device cancel an active parse atomically and fences the old claimant", async () => {
    const initial = workspace();
    await save(initial);
    const claimed = await claim();
    const cancelled = cancelledParse(initial);

    await expect(cancelParse(successfulFinish(initial), 1)).rejects.toMatchObject({
      code: "40001",
    });
    await expect(cancelParse(cancelled, 2)).rejects.toMatchObject({ code: "40001" });
    await expect(cancelParse(cancelled, 1, ownerB)).rejects.toMatchObject({ code: "40001" });

    expect(await cancelParse(cancelled, 1)).toEqual({ revision: 2 });
    expect(
      (
        await db.query(
          "SELECT status,text FROM public.source_versions WHERE owner_id=$1 AND source_id=$2 AND version_id=$3",
          [ownerA, sourceId, versionId],
        )
      ).rows,
    ).toEqual([{ status: "saved", text: "" }]);
    expect(
      (
        await db.query(
          "SELECT data->'importJobs'->0->>'status' AS status FROM public.workspaces WHERE owner_id=$1",
          [ownerA],
        )
      ).rows,
    ).toEqual([{ status: "cancelled" }]);
    expect((await db.query("SELECT * FROM conuo_private.import_parse_leases")).rows).toEqual([]);

    // A completion already running on another device has no surviving token or
    // active target after the owner-authorized cancellation commits.
    await expect(finish(successfulFinish(initial), 1, claimed.leaseToken!)).rejects.toMatchObject({
      code: "40001",
    });
    await expect(heartbeat(claimed.leaseToken!)).rejects.toMatchObject({ code: "40001" });
    await expect(cancelParse(cancelled, 2)).rejects.toMatchObject({ code: "40001" });
  });

  it("uses controlled cancellation and retry to replace otherwise immutable parsing projections", async () => {
    const initial = workspace();
    await save(initial);
    const first = await claim();
    expect(await release(first.leaseToken!)).toEqual({ released: true, alreadyReleased: false });

    const cancelled = cancelledParse(initial);
    // Once no lease remains, a normal CAS save is no longer blocked by the
    // lease guard, but the canonical source-version projection remains immutable.
    await expect(save(cancelled, 1)).rejects.toMatchObject({ code: "22023" });
    expect(
      (await db.query("SELECT status FROM public.source_versions WHERE source_id=$1", [sourceId]))
        .rows,
    ).toEqual([{ status: "parsing" }]);

    expect(await cancelParse(cancelled, 1)).toEqual({ revision: 2 });
    const retried = retriedParse(cancelled);
    await expect(save(retried, 2)).rejects.toMatchObject({ code: "22023" });

    expect(await retryParse(retried, 2)).toEqual({ revision: 3 });
    expect(
      (
        await db.query(
          "SELECT status,text FROM public.source_versions WHERE owner_id=$1 AND source_id=$2 AND version_id=$3",
          [ownerA, sourceId, versionId],
        )
      ).rows,
    ).toEqual([{ status: "parsing", text: "" }]);
    expect(
      (
        await db.query(
          "SELECT data->'importJobs'->0->>'status' AS status FROM public.workspaces WHERE owner_id=$1",
          [ownerA],
        )
      ).rows,
    ).toEqual([{ status: "queued" }]);
    expect(await claim()).toMatchObject({ status: "claimed", workspaceRevision: 3 });
  });

  it("allows retries from failures and protects another active lease in cancel and retry snapshots", async () => {
    const otherSourceId = "source-b";
    const otherVersionId = "v1";
    const initial = workspace(parsingSource(), [
      runningJob(),
      runningJob(otherSourceId, otherVersionId),
    ]);
    initial.sources.push(parsingSource(otherSourceId, otherVersionId));
    await save(initial);
    await claim();
    const other = await rpc<Claim>("public.claim_import_parse($1,$2,120)", [
      otherSourceId,
      otherVersionId,
    ]);
    const cancelled = cancelledParse(initial);
    const changedDuringCancel = structuredClone(cancelled);
    changedDuringCancel.sources.find((source) => source.id === otherSourceId)!.title =
      "Stale other title";
    await expect(cancelParse(changedDuringCancel, 1)).rejects.toMatchObject({ code: "40001" });

    expect(await cancelParse(cancelled, 1)).toEqual({ revision: 2 });
    expect(
      (await db.query("SELECT source_id FROM conuo_private.import_parse_leases ORDER BY source_id"))
        .rows,
    ).toEqual([{ source_id: otherSourceId }]);

    const retried = retriedParse(cancelled, "running");
    const changedDuringRetry = structuredClone(retried);
    changedDuringRetry.importJobs!.find((job) => job.sourceId === otherSourceId)!.status = "queued";
    await expect(retryParse(changedDuringRetry, 2)).rejects.toMatchObject({ code: "40001" });
    expect(await retryParse(retried, 2)).toEqual({ revision: 3 });
    expect(other.leaseToken).toEqual(expect.any(String));

    // The failed path uses the same retry transition, without a parse lease.
    await db.exec("TRUNCATE public.workspaces CASCADE");
    const failedInitial = workspace();
    await save(failedInitial);
    const failedLease = await claim();
    const failed = failedFinish(failedInitial);
    expect(await finish(failed, 1, failedLease.leaseToken!)).toEqual({ revision: 2 });
    expect(await retryParse(retriedParse(failed), 2)).toEqual({ revision: 3 });
    await expect(retryParse(retriedParse(failed), 3, ownerB)).rejects.toMatchObject({
      code: "40001",
    });
  });

  it("makes release idempotent without allowing an old token to release or finish a newer lease", async () => {
    const data = workspace();
    await save(data);
    const first = await claim();
    const token = first.leaseToken!;

    expect(await release(token)).toEqual({ released: true, alreadyReleased: false });
    expect(await release(token)).toEqual({ released: true, alreadyReleased: true });
    await expect(finish(successfulFinish(data), 1, token)).rejects.toMatchObject({ code: "40001" });

    const second = await claim();
    await expect(release(token)).rejects.toMatchObject({ code: "40001" });
    expect(await release(second.leaseToken!)).toEqual({ released: true, alreadyReleased: false });

    const third = await claim();
    await db.exec(
      "UPDATE conuo_private.import_parse_leases SET lease_until=clock_timestamp()-interval '1 second'",
    );
    expect(await release(third.leaseToken!)).toEqual({ released: true, alreadyReleased: true });
  });

  it("rejects a source deletion or job cancellation before an old parser can finish", async () => {
    const data = workspace();
    await save(data);
    const first = await claim();
    await db.query(
      "UPDATE public.workspaces SET data=jsonb_set(data,ARRAY['sources','0','deletedAt'],to_jsonb($2::text),false),revision=revision+1 WHERE owner_id=$1::uuid",
      [ownerA, later],
    );
    await expect(finish(successfulFinish(data), 2, first.leaseToken!)).rejects.toMatchObject({
      code: "40001",
    });

    await db.exec("TRUNCATE public.workspaces CASCADE");
    await save(data);
    const second = await claim();
    await db.query(
      "UPDATE public.workspaces SET data=jsonb_set(data,ARRAY['importJobs','0','status'],'\"cancelled\"'::jsonb,false),revision=revision+1 WHERE owner_id=$1::uuid",
      [ownerA],
    );
    await expect(finish(successfulFinish(data), 2, second.leaseToken!)).rejects.toMatchObject({
      code: "40001",
    });
  });

  it("does not expose a lease or permit cross-owner control, and rejects malformed finish tokens", async () => {
    const data = workspace();
    await save(data);
    const claimed = await claim();

    await expect(claim(ownerB)).rejects.toMatchObject({ code: "40001" });
    await expect(heartbeat(claimed.leaseToken!, ownerB)).rejects.toMatchObject({ code: "40001" });
    await expect(
      asRole("authenticated", ownerB, () =>
        db.query("SELECT * FROM conuo_private.import_parse_leases"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(finish(successfulFinish(data), 1, "not-a-lease-token")).rejects.toMatchObject({
      code: "22023",
    });
    await expect(finish(successfulFinish(data), 1, null)).rejects.toMatchObject({ code: "22023" });
  });
});
