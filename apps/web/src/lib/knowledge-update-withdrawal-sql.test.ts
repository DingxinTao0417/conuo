import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDemoWorkspace } from "./seed";
import {
  applyKnowledgeUpdate,
  ignoreKnowledgeChange,
  knowledgeBlocks,
  knowledgeUpdateReviewReason,
  snapshotKnowledgeNote,
} from "./knowledge-update";
import {
  previewKnowledgeUpdateWithdrawal,
  withdrawKnowledgeUpdate,
} from "./knowledge-update-withdrawal";
import { workspaceSchema } from "./supabase/validation";
import type { OrganizationJob } from "./organization-types";
import type { Citation, Note, WorkspaceData } from "./types";

// Ephemeral PostgreSQL executes every local migration and its actual projection
// triggers. This exercises neither hosted PostgREST nor real user/cloud data.
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const migrations = new URL("../../../../supabase/migrations/", import.meta.url);
let db: PGlite;
let migrationNames: string[];

function fixture() {
  const data = createDemoWorkspace();
  const citations: Citation[] = data.sources.flatMap((source) =>
    source.chunks.slice(0, 2).map((chunk) => ({
      sourceId: source.id,
      versionId: source.versionId,
      chunkId: chunk.id,
      title: source.title,
      quote: chunk.text,
      section: chunk.section,
    })),
  );
  const note: Note = {
    id: "withdrawal-sql-note",
    spaceId: data.spaces[0].id,
    title: "学习率",
    content: '<h2>基础解释。</h2>\n<p data-human="keep">人工原文。 [1]</p>\n<p>需核对的例子。</p>',
    citations: [citations[0]],
    kind: "knowledge",
    status: "accepted",
    aiGenerated: false,
    contentRevision: 2,
    versions: [],
    createdAt: data.sources[0].createdAt,
    updatedAt: data.sources[0].updatedAt,
    deletedAt: null,
  };
  const blocks = knowledgeBlocks(note.content);
  const job: OrganizationJob = {
    id: "withdrawal-sql-job",
    request: {
      requestId: "withdrawal-sql-job",
      kind: "update",
      trigger: "manual",
      spaceId: note.spaceId,
      sourceIds: data.sources.map((source) => source.id),
      sourceVersions: data.sources.map((source) => ({
        sourceId: source.id,
        versionId: source.versionId,
      })),
      targetNote: { id: note.id, revision: 2, updatedAt: note.updatedAt },
    },
    status: "ready",
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    result: {
      kind: "update",
      mode: "model",
      target: snapshotKnowledgeNote(note),
      coverage: "所选资料片段。",
      changes: [
        {
          id: "restore-a",
          type: "insert_after",
          blockId: "b2",
          before: blocks[1].html,
          after: "撤回的 AI 插入 A。",
          reason: "补充例子。",
          citations: [citations[1]],
        },
        {
          id: "keep-b",
          type: "replace",
          blockId: "b1",
          before: blocks[0].html,
          after: "保留的 AI 改写 B。",
          reason: "更新解释。",
          citations: [citations.at(-1)!],
        },
        {
          id: "remaining-c",
          type: "remove",
          blockId: "b3",
          before: blocks[2].html,
          after: "",
          reason: "建议删除。",
          citations: [citations[0]],
        },
      ],
    },
  };
  data.notes = [note];
  data.organizationJobs = [job];
  const applied = applyKnowledgeUpdate(data, job.id, [
    { changeId: "restore-a", text: "撤回的 AI 插入 A。" },
    { changeId: "keep-b", text: "保留的 AI 改写 B。" },
  ]);
  expect(workspaceSchema.safeParse(applied).success).toBe(true);
  return { applied, originalNote: note, jobId: job.id };
}

async function asOwner<T>(owner: string, action: () => Promise<T>): Promise<T> {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
  await db.exec("SET ROLE authenticated");
  try {
    return await action();
  } finally {
    await db.exec("RESET ROLE");
  }
}

async function save(data: WorkspaceData, revision = 0, owner = ownerA) {
  expect(workspaceSchema.safeParse(data).success).toBe(true);
  return asOwner(
    owner,
    async () =>
      (
        await db.query<{ revision: number }>(
          "select public.save_workspace($1::jsonb,$2::bigint) as revision",
          [JSON.stringify(data), revision],
        )
      ).rows[0]!.revision,
  );
}

async function reload(owner = ownerA) {
  return asOwner(
    owner,
    async () =>
      (
        await db.query<{ data: WorkspaceData; revision: number }>(
          "select data,revision from public.workspaces where owner_id=$1::uuid",
          [owner],
        )
      ).rows[0],
  );
}

async function assertProjection(note: Note, owner = ownerA) {
  await asOwner(owner, async () => {
    const notes = await db.query<{
      note_id: string;
      content: string;
      content_revision: number;
      citations: Citation[];
      ai_generated: boolean;
      status: string;
    }>("select * from public.notes where owner_id=$1::uuid and note_id=$2", [owner, note.id]);
    expect(notes.rows).toHaveLength(1);
    expect(notes.rows[0]).toMatchObject({
      note_id: note.id,
      content: note.content,
      content_revision: note.contentRevision,
      citations: note.citations,
      ai_generated: note.aiGenerated,
      status: note.status,
    });
    const versions = await db.query<{
      version_id: string;
      content: string;
      citations: Citation[];
      content_revision: number;
    }>(
      "select * from public.note_versions where owner_id=$1::uuid and note_id=$2 order by ordinal",
      [owner, note.id],
    );
    expect(
      versions.rows.map((row) => ({
        id: row.version_id,
        content: row.content,
        citations: row.citations,
        contentRevision: row.content_revision,
      })),
    ).toEqual(
      note.versions.map((version) => ({
        id: version.id,
        content: version.content,
        citations: version.citations,
        contentRevision: version.contentRevision,
      })),
    );
  });
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
      GRANT SELECT,INSERT,DELETE ON storage.objects TO authenticated;
    `);
    migrationNames = (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && !name.startsWith("._"))
      .sort();
    for (const name of migrationNames)
      await db.exec(await readFile(new URL(name, migrations), "utf8"));
  } catch (error) {
    await db.close();
    throw error;
  }
}, 30_000);

beforeEach(async () => {
  await db.exec(
    "RESET ROLE; TRUNCATE public.workspaces CASCADE; TRUNCATE public.account_deletions CASCADE; SET TIME ZONE 'UTC';",
  );
});

afterAll(async () => {
  if (db && !db.closed) await db.close();
});

describe("withdrawal receipts through ordinary PostgreSQL workspace saves", () => {
  it("executes every migration and round-trips an applied review before withdrawal", async () => {
    expect(migrationNames).toHaveLength(32);
    const { applied } = fixture();
    const revision = await save(applied);
    const saved = await reload();
    expect(saved).toEqual({ data: applied, revision });
    expect(workspaceSchema.safeParse(saved!.data).success).toBe(true);
    await assertProjection(applied.notes[0]);
    expect(await reload(ownerB)).toBeUndefined();
    await asOwner(ownerB, async () => {
      expect((await db.query("select * from public.notes")).rows).toEqual([]);
      expect((await db.query("select * from public.note_versions")).rows).toEqual([]);
    });
  });

  it("persists partial restore/keep receipt with exact current/history projections and freezes reload", async () => {
    const { applied, jobId, originalNote } = fixture();
    const revision = await save(applied);
    const plan = await previewKnowledgeUpdateWithdrawal(applied, jobId);
    expect(plan.reason).toBeUndefined();
    const withdrawn = await withdrawKnowledgeUpdate(applied, jobId, plan.fingerprint, [
      { changeId: "restore-a", action: "restore" },
      { changeId: "keep-b", action: "keep" },
    ]);
    expect(withdrawn.notes[0].content).not.toContain("撤回的 AI 插入 A。");
    expect(withdrawn.notes[0].content).toContain("保留的 AI 改写 B。");
    expect(withdrawn.notes[0].content).toContain('<p data-human="keep">人工原文。 [1]</p>');
    expect(withdrawn.notes[0].content).toContain("需核对的例子。");
    expect(withdrawn.notes[0].versions.map((version) => version.content)).toContain(
      originalNote.content,
    );
    expect(withdrawn.notes[0].versions.map((version) => version.content)).toContain(
      applied.notes[0].content,
    );
    const savedRevision = await save(withdrawn, revision);
    const saved = (await reload())!;
    expect(saved).toEqual({ data: withdrawn, revision: savedRevision });
    expect(workspaceSchema.safeParse(saved.data).success).toBe(true);
    const receipt = saved.data.organizationJobs![0].updateReview!.withdrawal!;
    expect(receipt).toMatchObject({
      fingerprint: plan.fingerprint,
      noteRevision: withdrawn.notes[0].contentRevision,
      restoredChangeIds: ["restore-a"],
      keptChangeIds: ["keep-b"],
    });
    expect(saved.data.organizationJobs![0].updateReview!.note).toEqual(
      applied.organizationJobs![0].updateReview!.note,
    );
    await assertProjection(saved.data.notes[0]);
    expect(knowledgeUpdateReviewReason(saved.data, saved.data.organizationJobs![0])).toContain(
      "撤回",
    );
    expect(() =>
      applyKnowledgeUpdate(saved.data, jobId, [{ changeId: "remaining-c", text: "" }]),
    ).toThrow(/撤回/);
    expect(() => ignoreKnowledgeChange(saved.data, jobId, "remaining-c")).toThrow(/撤回/);
    await expect(
      withdrawKnowledgeUpdate(saved.data, jobId, plan.fingerprint, [
        { changeId: "restore-a", action: "restore" },
        { changeId: "keep-b", action: "keep" },
      ]),
    ).rejects.toThrow(/撤回|封存/);
    const unrelated = { ...saved.data, autoOrganize: true };
    await save(unrelated, saved.revision);
    expect((await reload())!.data.organizationJobs![0].updateReview!.withdrawal).toEqual(receipt);
    await assertProjection(saved.data.notes[0]);
  });

  it("persists all-keep closure as a new note revision and full history even with identical body", async () => {
    const { applied, jobId } = fixture();
    const revision = await save(applied);
    const plan = await previewKnowledgeUpdateWithdrawal(applied, jobId);
    const kept = await withdrawKnowledgeUpdate(applied, jobId, plan.fingerprint, [
      { changeId: "restore-a", action: "keep" },
      { changeId: "keep-b", action: "keep" },
    ]);
    expect(kept.notes[0].content).toBe(applied.notes[0].content);
    expect(kept.notes[0].citations).toEqual(applied.notes[0].citations);
    expect(kept.notes[0].contentRevision).toBe(applied.notes[0].contentRevision! + 1);
    expect(kept.notes[0].versions).toHaveLength(applied.notes[0].versions.length + 1);
    await save(kept, revision);
    const saved = (await reload())!.data;
    expect(saved.organizationJobs![0].updateReview!.withdrawal).toMatchObject({
      restoredChangeIds: [],
      noteRevision: kept.notes[0].contentRevision,
    });
    expect([...saved.organizationJobs![0].updateReview!.withdrawal!.keptChangeIds].sort()).toEqual(
      ["restore-a", "keep-b"].sort(),
    );
    expect(saved.notes[0]).toEqual(kept.notes[0]);
    await assertProjection(saved.notes[0]);
    expect(() =>
      applyKnowledgeUpdate(saved, jobId, [{ changeId: "remaining-c", text: "" }]),
    ).toThrow(/撤回/);
  });
});
