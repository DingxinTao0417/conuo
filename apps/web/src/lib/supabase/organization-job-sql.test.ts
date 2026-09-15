import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bindOrganizationResult, buildOrganizationGrounding } from "../ai/organization";
import type { OrganizationRequest, OrganizationResult } from "../organization-types";
import type { Source, WorkspaceData } from "../types";

// These tests apply every migration to an isolated PostgreSQL-compatible engine.
// They exercise the public JSON audit projection and the private durable queue together.
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const now = "2026-09-14T12:00:00.000Z";
const jobId = "organization-task-1";

type Role = "anon" | "authenticated" | "service_role";
type Projection = {
  id: string;
  durable: true;
  request: OrganizationRequest;
  status: "queued" | "running" | "ready" | "failed" | "cancelled";
  result?: OrganizationResult;
  error?: string;
};
type Enqueued = { revision: number; job: Projection; created: boolean };
type Claimed = {
  jobs: Array<{
    jobId: string;
    ownerId: string;
    leaseToken: string;
    leaseUntil: string;
    hasResult: boolean;
    attempt: number;
  }>;
};
type JobContext = {
  jobId: string;
  ownerId: string;
  leaseToken: string;
  leaseUntil: string;
  request: OrganizationRequest;
  workspace: WorkspaceData;
  contextDigest: string;
  result: OrganizationResult | null;
};
type Published = { state: "succeeded" | "cancelled" | "pending_capacity"; revision?: number };
type Cancelled = { revision: number; job: Projection; cancelled: boolean };

let db: PGlite;

function readySource(): Source {
  const text = "学习率决定梯度下降每次更新的步长。步长过大可能导致损失振荡。";
  return {
    id: "source-organization",
    versionId: "version-organization",
    title: "学习率资料",
    filename: "learning-rate.md",
    kind: "markdown",
    mime: "text/markdown",
    size: new TextEncoder().encode(text).byteLength,
    hash: "a".repeat(64),
    spaceIds: ["library"],
    tags: [],
    status: "ready",
    coverage: { captureScope: "full", parseState: "complete" },
    text,
    chunks: [
      {
        id: "chunk-organization",
        sourceId: "source-organization",
        versionId: "version-organization",
        text,
        section: "学习率",
        order: 0,
      },
    ],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    aiAllowed: true,
    starred: false,
  };
}

function workspace(): WorkspaceData {
  return {
    schemaVersion: 1,
    spaces: [
      {
        id: "library",
        name: "Library",
        goal: "理解学习率",
        color: "blue",
        archived: false,
        createdAt: now,
      },
    ],
    sources: [readySource()],
    notes: [],
    annotations: [],
    conversations: [],
    aiEnabled: true,
    autoOrganize: true,
    semanticSearch: true,
  };
}

function request(data: WorkspaceData, id = jobId): OrganizationRequest {
  const source = data.sources[0]!;
  return {
    requestId: id,
    kind: "source",
    trigger: "automatic",
    spaceId: "library",
    sourceIds: [source.id],
    sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
  };
}

function generatedResult(data: WorkspaceData, value: OrganizationRequest): OrganizationResult {
  return bindOrganizationResult(
    JSON.stringify({
      status: "ready",
      kind: "source",
      summary: {
        title: "学习率摘要",
        paragraphs: [{ text: "学习率决定参数更新的步长。", evidenceIds: ["e1"], kind: "source" }],
      },
      tags: [{ label: "学习率", evidenceIds: ["e1"] }],
      topics: [{ label: "梯度下降", evidenceIds: ["e1"] }],
    }),
    buildOrganizationGrounding(data, value),
    value,
  );
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

async function enqueue(value: OrganizationRequest, revision: number, owner = ownerA) {
  return rpc<Enqueued>(
    "public.enqueue_organization_job($1::jsonb,$2::bigint)",
    [JSON.stringify(value), revision],
    owner,
  );
}

async function claim(worker = "organization-worker", limit = 1, leaseSeconds = 120) {
  return rpc<Claimed>(
    "public.claim_organization_jobs($1,$2::integer,$3::integer)",
    [worker, limit, leaseSeconds],
    null,
    "service_role",
  );
}

async function readContext(claimed: Claimed["jobs"][number]) {
  return rpc<JobContext>(
    "public.read_organization_job_context($1::uuid,$2,$3::uuid)",
    [claimed.ownerId, claimed.jobId, claimed.leaseToken],
    null,
    "service_role",
  );
}

async function heartbeat(claimed: Claimed["jobs"][number], leaseSeconds = 120) {
  return rpc<{ leaseUntil: string }>(
    "public.heartbeat_organization_job($1::uuid,$2,$3::uuid,$4::integer)",
    [claimed.ownerId, claimed.jobId, claimed.leaseToken, leaseSeconds],
    null,
    "service_role",
  );
}

async function stage(claimed: Claimed["jobs"][number], result: OrganizationResult) {
  return rpc<{ staged: boolean; resultDigest: string }>(
    "public.stage_organization_job_result($1::uuid,$2,$3::uuid,$4::jsonb)",
    [claimed.ownerId, claimed.jobId, claimed.leaseToken, JSON.stringify(result)],
    null,
    "service_role",
  );
}

async function publish(claimed: Claimed["jobs"][number]) {
  return rpc<Published>(
    "public.publish_organization_job($1::uuid,$2,$3::uuid)",
    [claimed.ownerId, claimed.jobId, claimed.leaseToken],
    null,
    "service_role",
  );
}

async function cancel(id: string, revision: number, owner = ownerA) {
  return rpc<Cancelled>("public.cancel_organization_job($1,$2::bigint)", [id, revision], owner);
}

async function savedWorkspace(owner = ownerA) {
  const result = await db.query<{ data: WorkspaceData; revision: number }>(
    "select data, revision from public.workspaces where owner_id=$1::uuid",
    [owner],
  );
  return result.rows[0]!;
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
      "20260914120700_organization_jobs.sql",
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
    "RESET ROLE; TRUNCATE public.workspaces CASCADE; TRUNCATE public.account_deletions CASCADE; TRUNCATE conuo_private.organization_jobs; TRUNCATE conuo_private.original_upload_intents; TRUNCATE public.embedding_usage; TRUNCATE storage.objects; INSERT INTO auth.users(id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') ON CONFLICT (id) DO NOTHING; UPDATE public.embedding_profiles SET fingerprint=null; SET TIME ZONE 'UTC';",
  );
});

afterAll(async () => {
  if (db && !db.closed) await db.close();
});

describe("durable organization jobs", () => {
  it("creates a private queued task and a durable JSON audit projection", async () => {
    const data = workspace();
    const value = request(data);
    expect(await save(data)).toBe(1);

    const queued = await enqueue(value, 1);

    expect(queued).toMatchObject({
      revision: 2,
      created: true,
      job: { id: jobId, durable: true, status: "queued", request: value },
    });
    expect(
      (
        await db.query(
          "select owner_id, job_id, state, attempt, result, error_code from conuo_private.organization_jobs",
        )
      ).rows,
    ).toEqual([
      {
        owner_id: ownerA,
        job_id: jobId,
        state: "queued",
        attempt: 0,
        result: null,
        error_code: null,
      },
    ]);
    expect((await savedWorkspace()).data.organizationJobs).toEqual([queued.job]);
  });

  it("claims, reads, stages, and publishes a reviewable ready result", async () => {
    const data = workspace();
    const value = request(data);
    const result = generatedResult(data, value);
    expect(await save(data)).toBe(1);
    expect((await enqueue(value, 1)).revision).toBe(2);

    const claimed = (await claim()).jobs[0]!;
    expect(claimed).toMatchObject({
      jobId,
      ownerId: ownerA,
      leaseToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
      leaseUntil: expect.any(String),
      hasResult: false,
      attempt: 1,
    });
    const context = await readContext(claimed);
    expect(context).toMatchObject({
      jobId,
      ownerId: ownerA,
      leaseToken: claimed.leaseToken,
      request: value,
      result: null,
    });
    expect(context.workspace.sources[0]).toMatchObject({ id: value.sourceIds[0], aiAllowed: true });
    expect(await heartbeat(claimed)).toMatchObject({ leaseUntil: expect.any(String) });
    expect(await stage(claimed, result)).toMatchObject({
      staged: true,
      resultDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await publish(claimed)).toEqual({ state: "succeeded", revision: 3 });

    const saved = await savedWorkspace();
    expect(saved).toMatchObject({ revision: 3 });
    expect(saved.data.organizationJobs).toEqual([
      expect.objectContaining({ id: jobId, durable: true, status: "ready", result }),
    ]);
    expect(
      (
        await db.query(
          "select state, attempt, result, published_revision from conuo_private.organization_jobs where owner_id=$1::uuid and job_id=$2",
          [ownerA, jobId],
        )
      ).rows,
    ).toEqual([{ state: "succeeded", attempt: 1, result, published_revision: 3 }]);
  });

  it("leases at most one active organization task per owner while still serving other owners", async () => {
    const data = workspace();
    const secondJobId = "organization-task-2";
    const otherOwnerJobId = "organization-task-owner-b";
    expect(await save(data)).toBe(1);
    expect(await save(data, 0, ownerB)).toBe(1);
    expect((await enqueue(request(data), 1)).revision).toBe(2);
    expect((await enqueue(request(data, secondJobId), 2)).revision).toBe(3);
    expect((await enqueue(request(data, otherOwnerJobId), 1, ownerB)).revision).toBe(2);

    const firstBatch = await claim("organization-worker-a", 5);
    expect(firstBatch.jobs).toHaveLength(2);
    expect(firstBatch.jobs.filter((job) => job.ownerId === ownerA)).toHaveLength(1);
    expect(firstBatch.jobs.filter((job) => job.ownerId === ownerB)).toHaveLength(1);

    // A separate worker cannot lease the owner's second queued item until the
    // first lease reaches a terminal state. The other owner's active task must
    // not block this owner once its own first task is cancelled.
    expect((await claim("organization-worker-b", 5)).jobs).toEqual([]);
    const firstOwnerJob = firstBatch.jobs.find((job) => job.ownerId === ownerA)!;
    expect((await cancel(firstOwnerJob.jobId, 3)).revision).toBe(4);
    expect(await claim("organization-worker-c", 5)).toMatchObject({
      jobs: [
        {
          ownerId: ownerA,
          jobId: firstOwnerJob.jobId === jobId ? secondJobId : jobId,
          attempt: 1,
        },
      ],
    });
  });

  it("cancels an active task when an ordinary save preserves its projection but changes context", async () => {
    const data = workspace();
    const value = request(data);
    expect(await save(data)).toBe(1);
    expect((await enqueue(value, 1)).revision).toBe(2);

    const current = await savedWorkspace();
    const changed = structuredClone(current.data);
    changed.spaces[0]!.goal = "修改后的学习目标";
    expect(await save(changed, current.revision)).toBe(3);

    const saved = await savedWorkspace();
    expect(saved.data.organizationJobs).toEqual([
      expect.objectContaining({
        id: jobId,
        durable: true,
        status: "cancelled",
        error: expect.any(String),
      }),
    ]);
    expect(
      (
        await db.query(
          "select state, error_code, result from conuo_private.organization_jobs where owner_id=$1::uuid and job_id=$2",
          [ownerA, jobId],
        )
      ).rows,
    ).toEqual([{ state: "cancelled", error_code: "ORGANIZATION_CONTEXT_CHANGED", result: null }]);
    expect((await claim()).jobs).toEqual([]);
  });

  it("rejects a stale ordinary save that tries to delete an active job projection", async () => {
    const data = workspace();
    const value = request(data);
    expect(await save(data)).toBe(1);
    expect((await enqueue(value, 1)).revision).toBe(2);

    const current = await savedWorkspace();
    const stale = structuredClone(current.data);
    stale.organizationJobs = [];
    await expect(save(stale, current.revision)).rejects.toMatchObject({ code: "40001" });
    expect((await savedWorkspace()).revision).toBe(2);
    expect(
      (
        await db.query(
          "select state from conuo_private.organization_jobs where owner_id=$1::uuid and job_id=$2",
          [ownerA, jobId],
        )
      ).rows,
    ).toEqual([{ state: "queued" }]);
  });

  it("lets the owner cancel a queued task and updates both durable records", async () => {
    const data = workspace();
    const value = request(data);
    expect(await save(data)).toBe(1);
    expect((await enqueue(value, 1)).revision).toBe(2);

    const cancelled = await cancel(jobId, 2);

    expect(cancelled).toMatchObject({
      revision: 3,
      cancelled: true,
      job: { id: jobId, durable: true, status: "cancelled", error: expect.any(String) },
    });
    expect((await savedWorkspace()).data.organizationJobs).toEqual([
      expect.objectContaining({ id: jobId, status: "cancelled" }),
    ]);
    expect(
      (
        await db.query(
          "select state, error_code from conuo_private.organization_jobs where owner_id=$1::uuid and job_id=$2",
          [ownerA, jobId],
        )
      ).rows,
    ).toEqual([{ state: "cancelled", error_code: "CANCELLED_BY_USER" }]);
  });
});
