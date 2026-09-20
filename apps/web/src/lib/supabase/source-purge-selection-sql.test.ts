import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Real ephemeral PostgreSQL executes the complete local migration chain. This
// does not simulate PostgREST, Storage cleanup, or multi-connection concurrency.
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const now = "2026-09-14T12:00:00.000Z";
const migrations = new URL("../../../../../supabase/migrations/", import.meta.url);
type Json = Record<string, unknown>;
type Preview = {
  revision: number;
  fingerprint: string;
  impact: Record<string, number>;
  blockers: { annotations: string[]; conceptRelations: string[] };
  contentSelection: {
    version: number;
    notes: { id: string; title: string; kind: string; versions: number }[];
    conversations: { id: string; title: string; messages: number }[];
    selection: { noteIds: string[]; conversationIds: string[] };
  };
};
let db: PGlite;

function source(id = "source-a", recycled = true) {
  return {
    id,
    versionId: "v1",
    title: id,
    filename: "study.md",
    kind: "markdown",
    mime: "text/markdown",
    size: 20,
    hash: "legacy",
    spaceIds: ["library"],
    tags: [],
    status: "ready",
    text: "Source body",
    chunks: [
      {
        id: "chunk-a",
        sourceId: id,
        versionId: "v1",
        text: "Source body",
        section: "正文",
        order: 0,
      },
    ],
    createdAt: now,
    updatedAt: now,
    deletedAt: recycled ? now : null,
    aiAllowed: true,
    starred: false,
  };
}
function citation(sourceId = "source-a") {
  return {
    sourceId,
    versionId: "v1",
    chunkId: "chunk-a",
    title: sourceId,
    quote: "Source body",
    section: "正文",
  };
}
function manualRef(sourceId = "source-a") {
  return {
    sourceId,
    versionId: "v1",
    chunkId: "chunk-a",
    selectionFingerprint: "1111111111111111",
  };
}
function note(id = "note-a", kind = "note", patch: Json = {}): Json {
  return {
    id,
    spaceId: "library",
    title: id,
    content: `private ${id} body`,
    kind,
    status: "accepted",
    citations: [citation()],
    versions: [
      {
        id: `${id}-v0`,
        title: `old ${id}`,
        content: `private ${id} history`,
        citations: [citation()],
        savedAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...patch,
  };
}
function conversation(id = "conversation-a", patch: Json = {}): Json {
  return {
    id,
    spaceId: "library",
    title: id,
    scope: "document",
    sourceId: "source-a",
    sourceIds: ["source-a"],
    resolved: false,
    updatedAt: now,
    messages: [
      {
        id: `${id}-question`,
        role: "user",
        content: "Question body",
        citations: [],
        createdAt: now,
      },
      {
        id: `${id}-answer`,
        role: "assistant",
        content: "Private answer body",
        citations: [citation()],
        noteEvidence: [
          { noteId: "note-a", sourceId: "source-a", quote: "Historical personal note body" },
        ],
        attempt: {
          id: `${id}-attempt`,
          questionMessageId: `${id}-question`,
          status: "completed",
          scopeSnapshot: {
            scope: "document",
            sourceId: "source-a",
            sourceIds: ["source-a"],
            spaceId: "library",
          },
        },
        createdAt: now,
      },
    ],
    ...patch,
  };
}
function workspace(notes = [note()], conversations = [conversation()]) {
  return {
    schemaVersion: 1,
    spaces: [
      { id: "library", name: "Library", goal: "", color: "blue", archived: false, createdAt: now },
    ],
    sources: [source(), source("source-b", false)],
    notes,
    conversations,
    annotations: [],
    aiEnabled: true,
  };
}
function relation(id = "relation-a", origin = "ai", patch: Json = {}): Json {
  const endpoint = (noteId: string) => ({
    id: noteId,
    spaceId: "library",
    title: noteId,
    content: "Frozen knowledge body",
    citations: [citation("source-b")],
    status: "accepted",
    aiGenerated: false,
    revision: 1,
    updatedAt: now,
  });
  return {
    id,
    spaceId: "library",
    type: "related",
    from: endpoint("note-a"),
    to: endpoint("knowledge-a"),
    fromClaim: "First claim",
    toClaim: "Second claim",
    fromCondition: "",
    toCondition: "",
    explanation: "Relationship body",
    fromCitations: [citation("source-b")],
    toCitations: [citation("source-b")],
    origin,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...patch,
  };
}
async function insertCompletedJob(id: string, request: Json, result: Json) {
  await db.query(
    "insert into conuo_private.organization_jobs(owner_id,job_id,request,request_digest,context_digest,model_request_id,state,result) values($1,$2,$3::jsonb,$4,$4,$2,'succeeded',$5::jsonb)",
    [ownerA, id, JSON.stringify(request), "0".repeat(64), JSON.stringify(result)],
  );
}
async function insertAiResult(
  id: string,
  result: Json | null,
  owner = ownerA,
  state = "completed",
) {
  await db.query(
    "insert into public.ai_requests(owner_id,request_id,fingerprint,state,result) values($1,$2,$3,$4,$5::jsonb)",
    [owner, id, "f".repeat(64), state, result === null ? null : JSON.stringify(result)],
  );
}
async function aiRows(owner = ownerA) {
  return (
    await db.query<{
      request_id: string;
      state: string;
      result: Json | null;
      error_code: string | null;
      created_at: string;
      fingerprint: string;
    }>(
      "select request_id,state,result,error_code,created_at,fingerprint from public.ai_requests where owner_id=$1 order by request_id",
      [owner],
    )
  ).rows;
}
async function asRole<T>(
  role: "anon" | "authenticated" | "service_role",
  owner: string | null,
  action: () => Promise<T>,
) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner ?? ""]);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await action();
  } finally {
    await db.exec("RESET ROLE");
  }
}
async function save(data: unknown, revision = 0, owner = ownerA) {
  return asRole(
    "authenticated",
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
async function preview(
  noteIds: unknown = [],
  conversationIds: unknown = [],
  owner = ownerA,
  legacy = false,
) {
  return asRole(
    "authenticated",
    owner,
    async () =>
      (
        await db.query<{ value: Preview }>(
          legacy
            ? "select public.preview_source_purge($1::text) as value"
            : "select public.preview_source_purge_selection($1::text,$2::text[],$3::text[]) as value",
          legacy ? ["source-a"] : ["source-a", noteIds, conversationIds],
        )
      ).rows[0]!.value,
  );
}
async function purge(p: Preview, owner = ownerA, legacy = false) {
  return asRole(
    "authenticated",
    owner,
    async () =>
      (
        await db.query<{
          value: {
            revision: number;
            data: ReturnType<typeof workspace>;
            cleanupPending: boolean;
            purgeId: string;
          };
        }>(
          legacy
            ? "select public.request_source_purge($1::text,$2::bigint,$3::text) as value"
            : "select public.request_source_purge_selection($1::text,$2::bigint,$3::text,$4::text[],$5::text[]) as value",
          legacy
            ? ["source-a", p.revision, p.fingerprint]
            : [
                "source-a",
                p.revision,
                p.fingerprint,
                p.contentSelection.selection.noteIds,
                p.contentSelection.selection.conversationIds,
              ],
        )
      ).rows[0]!.value,
  );
}
async function saved(owner = ownerA) {
  return (
    await db.query<{ data: ReturnType<typeof workspace>; revision: number }>(
      "select data,revision from public.workspaces where owner_id=$1::uuid",
      [owner],
    )
  ).rows[0]!;
}
beforeAll(async () => {
  db = await PGlite.create("memory://", { extensions: { vector } });
  try {
    await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); INSERT INTO auth.users VALUES ('${ownerA}'),('${ownerB}');
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
      CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      CREATE TABLE storage.objects(bucket_id text,name text,metadata jsonb not null default '{}'::jsonb); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array($1,'/') $$;
      GRANT USAGE ON SCHEMA storage TO anon,authenticated,service_role; GRANT SELECT,INSERT,DELETE ON storage.objects TO authenticated;`);
    for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort())
      await db.exec(await readFile(new URL(name, migrations), "utf8"));
    await db.exec("GRANT SELECT,UPDATE ON public.workspaces TO service_role;");
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

describe("optional saved-content source purge SQL", () => {
  it("includes current/history manual excerpt-only notes in the legacy default preview", async () => {
    const data = workspace(
      [
        note("manual", "knowledge", {
          citations: [],
          manualExcerptRefs: [manualRef()],
          versions: [
            {
              id: "manual-v0",
              title: "old",
              content: "history",
              savedAt: now,
              citations: [],
              manualExcerptRefs: [manualRef()],
            },
          ],
        }),
      ],
      [],
    );
    await save(data);
    const p = await preview([], [], ownerA, true);
    expect(p.impact.retainedNotes).toBe(1);
    expect(p.impact.retainedNoteCitations).toBe(2);
    expect(p.contentSelection).toEqual({
      version: 1,
      notes: [{ id: "manual", title: "manual", kind: "knowledge", versions: 2 }],
      conversations: [],
      selection: { noteIds: [], conversationIds: [] },
    });
  });

  it("permanently removes selected note bodies/history and conversation/messages without deleting unrelated content", async () => {
    const data = workspace(
      [
        note(),
        note("knowledge-a", "knowledge"),
        note("unrelated", "note", { citations: [], versions: [] }),
      ],
      [
        conversation(),
        conversation("retained"),
        conversation("unrelated-conversation", {
          sourceId: "source-b",
          sourceIds: ["source-b"],
          messages: [],
        }),
      ],
    );
    await save(data);
    const p = await preview(["note-a"], ["conversation-a"]);
    expect(p.impact).toMatchObject({
      removedNotes: 1,
      removedNoteVersions: 2,
      removedConversations: 1,
      removedMessages: 2,
      retainedNotes: 1,
      retainedConversations: 1,
    });
    const result = await purge(p);
    expect(result.data.notes.map((n) => n.id)).toEqual(["knowledge-a", "unrelated"]);
    expect(result.data.conversations.map((c) => c.id)).toEqual([
      "retained",
      "unrelated-conversation",
    ]);
    expect(JSON.stringify(result.data)).not.toContain("private note-a history");
    expect((result.data.conversations[0].messages as Json[])[1].noteEvidence).toEqual(
      (data.conversations[1].messages as Json[])[1].noteEvidence,
    );
    expect(
      (
        await db.query("select * from public.notes where owner_id=$1 and note_id='note-a'", [
          ownerA,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await db.query(
          "select * from public.note_versions where owner_id=$1 and note_id='note-a'",
          [ownerA],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await db.query(
          "select * from public.conversations where owner_id=$1 and conversation_id='conversation-a'",
          [ownerA],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await db.query(
          "select * from public.conversation_messages where owner_id=$1 and conversation_id='conversation-a'",
          [ownerA],
        )
      ).rows,
    ).toEqual([]);
    const restored = structuredClone(result.data);
    restored.notes.push(note("note-a", "knowledge", { citations: [], versions: [] }));
    await expect(save(restored, result.revision)).rejects.toMatchObject({ code: "PT409" });
    const restoredConversation = structuredClone(result.data);
    restoredConversation.conversations.push(
      conversation("conversation-a", {
        sourceId: "source-b",
        sourceIds: ["source-b"],
        messages: [],
      }),
    );
    await expect(save(restoredConversation, result.revision)).rejects.toMatchObject({
      code: "PT409",
    });
    expect((await saved()).revision).toBe(result.revision);
  });

  it("returns a bounded HTTP conflict code for stale saves without changing stored data", async () => {
    const data = workspace();
    await save(data);
    await expect(save(data, 0)).rejects.toMatchObject({ code: "PT409" });
    await expect(save(data, 9)).rejects.toMatchObject({ code: "PT409" });
    expect((await saved()).revision).toBe(1);
    expect(await save(data, 1)).toBe(2);
  });

  it("retains all saved content by default through both legacy RPCs", async () => {
    const data = workspace();
    await save(data);
    const p = await preview([], [], ownerA, true);
    expect(p.impact).toMatchObject({
      removedNotes: 0,
      removedNoteVersions: 0,
      removedConversations: 0,
      removedMessages: 0,
    });
    const result = await purge(p, ownerA, true);
    expect(result.data.notes[0].content).toBe(data.notes[0].content);
    expect((result.data.notes[0].versions as Json[])[0].content).toBe(
      (data.notes[0].versions as Json[])[0].content,
    );
    expect(result.data.conversations[0].messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: "Private answer body" })]),
    );
    expect((await db.query("select * from conuo_private.saved_content_tombstones")).rows).toEqual(
      [],
    );
  });

  it.each([
    [null, []],
    [[], null],
    [["note-a", "note-a"], []],
    [[], ["conversation-a", "conversation-a"]],
    [[""], []],
    [[" "], []],
    [["a".repeat(101)], []],
    [["note/a"], []],
    [[null], []],
    [[], [null]],
    [["missing-note"], []],
    [[], ["missing-conversation"]],
    [["unrelated"], []],
    [[], ["unrelated-conversation"]],
    [["foreign-note"], []],
    [[], ["foreign-conversation"]],
  ])(
    "rejects malformed, duplicate, unrelated or foreign selection %j / %j without mutating",
    async (noteIds, conversationIds) => {
      await save(
        workspace(
          [note(), note("unrelated", "note", { citations: [], versions: [] })],
          [
            conversation(),
            conversation("unrelated-conversation", {
              sourceId: "source-b",
              sourceIds: ["source-b"],
              messages: [],
            }),
          ],
        ),
      );
      await save(
        workspace([note("foreign-note")], [conversation("foreign-conversation")]),
        0,
        ownerB,
      );
      await expect(preview(noteIds, conversationIds)).rejects.toMatchObject({ code: "22023" });
      expect((await saved()).revision).toBe(1);
      expect((await db.query("select * from conuo_private.saved_content_tombstones")).rows).toEqual(
        [],
      );
    },
  );

  it("denies anonymous, unauthenticated and wrong-owner purge calls and private tombstone writes", async () => {
    await save(workspace());
    const p = await preview(["note-a"], ["conversation-a"]);
    await expect(
      asRole("anon", null, () =>
        db.query("select public.preview_source_purge_selection('source-a','{}','{}')"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asRole("authenticated", null, () =>
        db.query("select public.preview_source_purge_selection('source-a','{}','{}')"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(purge(p, ownerB)).rejects.toMatchObject({ code: "22023" });
    await expect(
      asRole("authenticated", ownerA, () =>
        db.query(
          "insert into conuo_private.saved_content_tombstones(owner_id,kind,content_id,purge_id,workspace_revision) values($1,'note','invented',$2,1)",
          [ownerA, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asRole("service_role", null, () =>
        db.query("select * from conuo_private.saved_content_tombstones"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect((await saved()).revision).toBe(1);
  });

  it("requires a fresh matching preview for a changed selection and stale CAS revision", async () => {
    const data = workspace([note(), note("knowledge-a", "knowledge")]);
    await save(data);
    const p = await preview(["note-a"]);
    const sameSelection = await preview(["note-a"]);
    expect(sameSelection.fingerprint).toBe(p.fingerprint);
    const alteredSelection = structuredClone(p);
    alteredSelection.contentSelection.selection.noteIds = ["knowledge-a"];
    await expect(purge(alteredSelection)).rejects.toMatchObject({ code: "PT409" });
    await save({ ...data, aiEnabled: false }, 1);
    await expect(purge(p)).rejects.toMatchObject({ code: "PT409" });
    expect((await saved()).revision).toBe(2);
    expect((await db.query("select * from public.source_purges")).rows).toEqual([]);
  });

  it("fingerprints full related note history, message bodies and job results even when IDs, counts and revision stay fixed", async () => {
    const data = {
      ...workspace(),
      organizationJobs: [
        {
          id: "job-a",
          request: {
            sourceIds: ["source-a"],
            sourceVersions: [{ sourceId: "source-a", versionId: "v1" }],
          },
          status: "ready",
          result: { body: "Before staged body" },
        },
      ],
    };
    await save(data);
    const p = await preview(["note-a"], ["conversation-a"]);
    const changes: ((value: typeof data) => void)[] = [
      (value) => {
        (value.notes[0].versions as Json[])[0].content = "Changed history body";
      },
      (value) => {
        (value.conversations[0].messages as Json[])[1].content = "Changed answer body";
      },
      (value) => {
        value.organizationJobs[0].result.body = "Changed staged body";
      },
    ];
    for (const change of changes) {
      const updated = structuredClone(data);
      change(updated);
      await db.query("update public.workspaces set data=$1::jsonb where owner_id=$2", [
        JSON.stringify(updated),
        ownerA,
      ]);
      const next = await preview(["note-a"], ["conversation-a"]);
      expect(next.revision).toBe(p.revision);
      expect(next.fingerprint).not.toBe(p.fingerprint);
      await expect(purge(p)).rejects.toMatchObject({ code: "PT409" });
    }
  });

  it("sorts selection before fingerprinting without changing the persisted order of unrelated notes", async () => {
    await save(
      workspace([
        note(),
        note("knowledge-a", "knowledge"),
        note("unrelated", "note", { citations: [], versions: [] }),
      ]),
    );
    const p = await preview(["note-a", "knowledge-a"]);
    const reverse = await preview(["knowledge-a", "note-a"]);
    expect(reverse).toEqual(p);
    expect(p.contentSelection.selection.noteIds).toEqual(["knowledge-a", "note-a"]);
    expect((await purge(reverse)).data.notes.map((n) => n.id)).toEqual(["unrelated"]);
  });

  it("clears structured note-only jobs and generated relations, including staged private results", async () => {
    const data = {
      ...workspace([note(), note("knowledge-a", "knowledge")], []),
      organizationJobs: [
        {
          id: "note-job",
          request: { sourceIds: ["source-b"], targetNote: { id: "note-a" } },
          status: "ready",
          result: { body: "structured result" },
        },
        {
          id: "unrelated-job",
          request: { sourceIds: ["source-b"] },
          status: "ready",
          result: { body: '{"targetNoteId":"note-a"}' },
        },
      ],
      conceptRelations: [relation()],
    };
    await save(data);
    await insertCompletedJob(
      "note-job",
      { sourceIds: ["source-b"] },
      { targetNoteId: "note-a", body: "Staged private note work" },
    );
    await insertCompletedJob(
      "unrelated-job",
      { sourceIds: ["source-b"] },
      { body: '{"targetNoteId":"note-a"}' },
    );
    const p = await preview(["note-a"]);
    expect(p.impact).toMatchObject({ organizationJobs: 1, conceptRelations: 1 });
    const result = await purge(p);
    expect((result.data as unknown as Json).organizationJobs).toEqual([data.organizationJobs[1]]);
    expect((result.data as unknown as Json).conceptRelations).toEqual([]);
    expect(
      (
        await db.query<{ job_id: string }>(
          "select job_id from conuo_private.organization_jobs where owner_id=$1 order by job_id",
          [ownerA],
        )
      ).rows.map((row) => row.job_id),
    ).toEqual(["unrelated-job"]);
    expect(
      (await db.query("select * from public.concept_relations where owner_id=$1", [ownerA])).rows,
    ).toEqual([]);
  });

  it("blocks a selected knowledge page's manual endpoint relation without removing unrelated relations", async () => {
    const data = {
      ...workspace([note(), note("knowledge-a", "knowledge")], []),
      conceptRelations: [relation("manual-relation", "manual")],
    };
    await save(data);
    const defaults = await preview();
    expect(defaults.blockers.conceptRelations).toEqual([]);
    const p = await preview(["note-a"]);
    expect(p.blockers.conceptRelations).toEqual(["manual-relation"]);
    await expect(purge(p)).rejects.toMatchObject({ code: "P0001" });
    expect((await saved()).data).toEqual(data);
    expect((await db.query("select * from conuo_private.saved_content_tombstones")).rows).toEqual(
      [],
    );
  });

  it("does not treat an explicitly source-kind endpoint with a colliding ID as a selected note", async () => {
    const item = relation();
    (item.from as Json).kind = "source";
    const data = {
      ...workspace([note(), note("knowledge-a", "knowledge")], []),
      conceptRelations: [item],
    };
    await save(data);
    const p = await preview(["note-a"]);
    expect(p.impact.conceptRelations).toBe(0);
    expect((await purge(p)).data as unknown as Json).toMatchObject({ conceptRelations: [item] });
  });

  it("preserves a comparison's fixed pair and frozen attempt versions while marking the purged scope unavailable", async () => {
    const pair = {
      leftSourceId: "source-a",
      leftVersionId: "v1",
      rightSourceId: "source-b",
      rightVersionId: "v1",
    };
    const c = conversation("comparison", {
      scope: "sources",
      sourceIds: ["source-a", "source-b"],
      comparison: pair,
    });
    delete c.sourceId;
    const answer = (c.messages as Json[])[1];
    (answer.attempt as Json).scopeSnapshot = {
      scope: "sources",
      sourceIds: ["source-a", "source-b"],
      sourceVersions: [
        { sourceId: "source-a", versionId: "v1" },
        { sourceId: "source-b", versionId: "v1" },
      ],
      comparison: pair,
      spaceId: "library",
    };
    await save(workspace([note()], [c]));
    const p = await preview();
    expect(p.contentSelection.conversations.map((v) => v.id)).toEqual(["comparison"]);
    const kept = (await purge(p)).data.conversations[0];
    expect(kept.comparison).toEqual(pair);
    expect(kept.sourceIds).toEqual(["source-a", "source-b"]);
    expect((kept.messages as Json[])[1].attempt as Json).toEqual({
      ...(answer.attempt as Json),
      unavailableReason: "source-purged",
    });
    expect(
      (
        await db.query<{ source_ids: unknown; comparison: unknown }>(
          "select source_ids,comparison from public.conversations where owner_id=$1",
          [ownerA],
        )
      ).rows[0],
    ).toEqual({ source_ids: ["source-a", "source-b"], comparison: pair });
  });

  it.each([
    { sourceId: "source-a" },
    { sourceIds: ["source-a"] },
    { sourceVersions: [{ sourceId: "source-a", versionId: "v1" }] },
    {
      comparison: {
        leftSourceId: "source-a",
        leftVersionId: "v1",
        rightSourceId: "source-b",
        rightVersionId: "v1",
      },
    },
  ])(
    "finds an attempt-only source dependency %j without requiring message citations",
    async (scopePatch) => {
      const c = conversation("attempt-only", { scope: "sources", sourceIds: [], messages: [] });
      delete c.sourceId;
      c.messages = [
        {
          id: "attempt-question",
          role: "user",
          content: "Question",
          citations: [],
          createdAt: now,
        },
        {
          id: "attempt-answer",
          role: "assistant",
          content: "Frozen answer",
          citations: [],
          attempt: {
            id: "attempt-only",
            questionMessageId: "attempt-question",
            status: "completed",
            scopeSnapshot: { scope: "sources", sourceIds: [], spaceId: "library", ...scopePatch },
          },
          createdAt: now,
        },
      ];
      await save(workspace([], [c]));
      const p = await preview();
      expect(p.contentSelection.conversations.map((v) => v.id)).toEqual(["attempt-only"]);
      expect(p.impact.retainedConversationCitations).toBe(0);
      const result = await purge(p);
      expect(
        ((result.data.conversations[0].messages as Json[])[1].attempt as Json).unavailableReason,
      ).toBe("source-purged");
    },
  );

  it("blocks direct service snapshot resurrection but allows a deliberate copy with a fresh ID and another owner's same ID", async () => {
    await save(workspace());
    const result = await purge(await preview(["note-a"], ["conversation-a"]));
    const resurrected = structuredClone(result.data);
    resurrected.notes.push(note("note-a", "knowledge", { citations: [], versions: [] }));
    await expect(
      asRole("service_role", null, () =>
        db.query("update public.workspaces set data=$1::jsonb where owner_id=$2", [
          JSON.stringify(resurrected),
          ownerA,
        ]),
      ),
    ).rejects.toMatchObject({ code: "PT409" });
    const newContent = structuredClone(result.data);
    newContent.notes.push(note("restored-copy", "knowledge", { citations: [], versions: [] }));
    newContent.conversations.push(
      conversation("restored-conversation", {
        sourceId: "source-b",
        sourceIds: ["source-b"],
        messages: [],
      }),
    );
    expect(await save(newContent, result.revision)).toBe(result.revision + 1);
    expect(await save(workspace(), 0, ownerB)).toBe(1);
    expect((await saved(ownerB)).data.notes[0].id).toBe("note-a");
  });

  it("keeps source-original cleanup pending and scoped to the canonical owner's immutable path", async () => {
    const data = workspace();
    const hash = "1".repeat(64);
    data.sources[0].hash = hash;
    const reservation = await asRole(
      "authenticated",
      ownerA,
      async () =>
        (
          await db.query<{
            value: { storagePath: string; intentId: string; reservationToken: string };
          }>(
            "select public.reserve_original_upload('source-a','v1','markdown',20,$1,'text/markdown') as value",
            [hash],
          )
        ).rows[0]!.value,
    );
    const path = reservation.storagePath;
    await asRole("authenticated", ownerA, () =>
      db.query(
        "insert into storage.objects(bucket_id,name,metadata) values('originals',$1,'{\"size\":20}'::jsonb)",
        [path],
      ),
    );
    await asRole("authenticated", ownerA, () =>
      db.query("select public.complete_original_upload($1::uuid,$2::uuid)", [
        reservation.intentId,
        reservation.reservationToken,
      ]),
    );
    (data.sources[0] as Json).storagePath = path;
    (data.sources[0] as Json).blobKey = "local-original";
    await save(data);
    const p = await preview(["note-a"]);
    expect(p.impact.storageObjects).toBe(1);
    const result = await purge(p);
    expect(result.cleanupPending).toBe(true);
    expect(
      (
        await db.query<{ storage_path: string }>(
          "select storage_path from public.source_purge_objects where purge_id=$1",
          [result.purgeId],
        )
      ).rows,
    ).toEqual([{ storage_path: path }]);
    expect(
      (
        await db.query<{ state: string }>(
          "select state from public.source_purges where purge_id=$1",
          [result.purgeId],
        )
      ).rows,
    ).toEqual([{ state: "pending" }]);
    expect(
      (
        await db.query(
          "select * from public.source_chunks where owner_id=$1 and source_id='source-a'",
          [ownerA],
        )
      ).rows,
    ).toEqual([]);
  });

  it("retains existing account-deletion denial and cascades saved-content tombstones with workspace removal", async () => {
    await save(workspace());
    await purge(await preview(["note-a"], ["conversation-a"]));
    expect(
      (
        await db.query("select * from conuo_private.saved_content_tombstones where owner_id=$1", [
          ownerA,
        ])
      ).rows,
    ).toHaveLength(2);
    await db.exec(`delete from public.workspaces where owner_id='${ownerA}';`);
    expect(
      (
        await db.query("select * from conuo_private.saved_content_tombstones where owner_id=$1", [
          ownerA,
        ])
      ).rows,
    ).toEqual([]);
    await save(workspace());
    await asRole("service_role", null, () =>
      db.query("select public.prepare_account_deletion($1::uuid)", [ownerA]),
    );
    await expect(preview()).rejects.toMatchObject({ code: "42501" });
  });

  it("binds a preview to its owner even when two owners have byte-identical snapshots and IDs", async () => {
    await save(workspace());
    await save(workspace(), 0, ownerB);
    const pA = await preview(["note-a"], ["conversation-a"]);
    const pB = await preview(["note-a"], ["conversation-a"], ownerB);
    expect(pA.fingerprint).not.toBe(pB.fingerprint);
    await expect(purge(pA, ownerB)).rejects.toMatchObject({ code: "PT409" });
    expect((await saved()).revision).toBe(1);
    expect((await saved(ownerB)).revision).toBe(1);
  });

  it("includes staged private results in impact and fingerprints before workspace publication", async () => {
    await save(workspace());
    await insertCompletedJob(
      "hidden-note-job",
      { sourceIds: ["source-b"] },
      { targetNoteId: "note-a", body: "Before private stage" },
    );
    const p = await preview(["note-a"]);
    expect(p.impact.organizationJobs).toBe(1);
    await db.query(
      "update conuo_private.organization_jobs set result=$1::jsonb where owner_id=$2 and job_id='hidden-note-job'",
      [JSON.stringify({ targetNoteId: "note-a", body: "After private stage" }), ownerA],
    );
    const next = await preview(["note-a"]);
    expect(next.revision).toBe(p.revision);
    expect(next.fingerprint).not.toBe(p.fingerprint);
    await expect(purge(p)).rejects.toMatchObject({ code: "PT409" });
    await purge(next);
    expect(
      (await db.query("select * from conuo_private.organization_jobs where owner_id=$1", [ownerA]))
        .rows,
    ).toEqual([]);
  });

  it("finds generated source references in frozen job results while preserving unrelated body strings", async () => {
    const data = {
      ...workspace([], []),
      organizationJobs: [
        {
          id: "historical-job",
          request: { sourceIds: ["source-b"] },
          status: "ready",
          result: { pages: [{ citations: [citation()] }] },
        },
        {
          id: "body-only-job",
          request: { sourceIds: ["source-b"] },
          status: "ready",
          result: { body: '{"sourceId":"source-a"}' },
        },
      ],
    };
    await save(data);
    const p = await preview();
    expect(p.impact.organizationJobs).toBe(1);
    expect((await purge(p)).data as unknown as Json).toMatchObject({
      organizationJobs: [data.organizationJobs[1]],
    });
  });

  it("scopes permanent identities to note versus conversation namespaces when their IDs overlap", async () => {
    await save(workspace([note("shared")], [conversation("shared")]));
    const result = await purge(await preview([], ["shared"]));
    expect(result.data.notes.map((n) => n.id)).toEqual(["shared"]);
    const edited = structuredClone(result.data);
    edited.notes[0].content = "Edited surviving shared note";
    expect(await save(edited, result.revision)).toBe(result.revision + 1);
    const resurrected = structuredClone(edited);
    resurrected.conversations.push(
      conversation("shared", { sourceId: "source-b", sourceIds: ["source-b"], messages: [] }),
    );
    await expect(save(resurrected, result.revision + 1)).rejects.toMatchObject({ code: "PT409" });
  });

  it("captures noteEvidence-only conversation candidates while keeping their historical body by default", async () => {
    const c = conversation("evidence-only", { sourceId: "source-b", sourceIds: ["source-b"] });
    const answer = (c.messages as Json[])[1];
    answer.citations = [];
    delete answer.attempt;
    await save(workspace([], [c]));
    const p = await preview();
    expect(p.contentSelection.conversations.map((v) => v.id)).toEqual(["evidence-only"]);
    expect(p.impact.retainedConversationCitations).toBe(1);
    const result = await purge(p);
    expect((result.data.conversations[0].messages as Json[])[1].noteEvidence).toEqual(
      answer.noteEvidence,
    );
  });

  it("preserves timezone-independent fingerprints including server-staged content", async () => {
    await save(workspace());
    await insertCompletedJob(
      "timezone-job",
      { targetNoteId: "note-a" },
      { body: "Private staged body" },
    );
    const utc = await preview(["note-a"]);
    await db.exec("SET TIME ZONE 'Asia/Shanghai'");
    expect((await preview(["note-a"])).fingerprint).toBe(utc.fingerprint);
  });

  it("rejects multidimensional arrays and oversized selections before any deletion", async () => {
    await save(workspace());
    await expect(
      asRole("authenticated", ownerA, () =>
        db.query(
          "select public.preview_source_purge_selection('source-a','{{note-a}}'::text[],'{}'::text[])",
        ),
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      preview(Array.from({ length: 10001 }, (_, index) => `note-${index}`)),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      preview(
        [],
        Array.from({ length: 5001 }, (_, index) => `conversation-${index}`),
      ),
    ).rejects.toMatchObject({ code: "22023" });
    expect((await saved()).revision).toBe(1);
  });

  it("rolls back selected saved-content deletion together with source annotations that still block purge", async () => {
    const data = {
      ...workspace(),
      annotations: [
        {
          id: "saved-annotation",
          sourceId: "source-a",
          versionId: "v1",
          quote: "Source body",
          note: "Saved personal annotation",
          createdAt: now,
        },
      ],
    };
    await save(data);
    const p = await preview(["note-a"], ["conversation-a"]);
    expect(p.blockers.annotations).toEqual(["saved-annotation"]);
    await expect(purge(p)).rejects.toMatchObject({ code: "P0001" });
    expect((await saved()).data).toEqual(data);
    expect((await db.query("select * from conuo_private.saved_content_tombstones")).rows).toEqual(
      [],
    );
    expect((await db.query("select * from public.source_tombstones")).rows).toEqual([]);
  });

  it("atomically rolls back tombstones, outboxes, private jobs and physical projections after a later database write failure", async () => {
    const data = workspace();
    await save(data);
    await insertCompletedJob(
      "atomic-job",
      { targetNoteId: "note-a" },
      { body: "Private staged content" },
    );
    const p = await preview(["note-a"], ["conversation-a"]);
    await db.exec(`create function public.test_reject_purge_write() returns trigger language plpgsql as $$ begin raise exception using errcode='P0001',message='Injected late database failure'; end; $$;
      create trigger test_reject_purge_write after update of data on public.workspaces for each row execute function public.test_reject_purge_write();`);
    try {
      await expect(purge(p)).rejects.toMatchObject({ code: "P0001" });
    } finally {
      await db.exec(
        "drop trigger test_reject_purge_write on public.workspaces; drop function public.test_reject_purge_write();",
      );
    }
    expect((await saved()).data).toEqual(data);
    expect((await saved()).revision).toBe(1);
    for (const table of [
      "public.source_tombstones",
      "public.source_purges",
      "public.source_purge_objects",
      "conuo_private.saved_content_tombstones",
    ])
      expect((await db.query(`select * from ${table}`)).rows).toEqual([]);
    expect(
      (await db.query("select * from conuo_private.organization_jobs where owner_id=$1", [ownerA]))
        .rows,
    ).toHaveLength(1);
    expect(
      (await db.query("select * from public.notes where owner_id=$1", [ownerA])).rows,
    ).toHaveLength(1);
    expect(
      (await db.query("select * from public.note_versions where owner_id=$1", [ownerA])).rows,
    ).toHaveLength(1);
    expect(
      (await db.query("select * from public.conversations where owner_id=$1", [ownerA])).rows,
    ).toHaveLength(1);
    expect(
      (await db.query("select * from public.conversation_messages where owner_id=$1", [ownerA]))
        .rows,
    ).toHaveLength(2);
  });

  it("preserves unrelated completed and foreign AI results while invalidating structured selected-note/source references and existing running work", async () => {
    await save(workspace());
    await insertAiResult("unrelated-result", {
      citations: [citation("source-b")],
      body: '{"sourceId":"source-a","noteId":"note-a"}',
    });
    await insertAiResult("source-result", { citations: [citation()] });
    await insertAiResult("note-result", {
      noteEvidence: [{ noteId: "note-a", quote: "Selected note cached text" }],
    });
    await insertAiResult("foreign-result", { citations: [citation()] }, ownerB);
    await insertAiResult("running-unprovenanced", null, ownerA, "running");
    const before = await aiRows();
    const foreignBefore = await aiRows(ownerB);
    await purge(await preview(["note-a"]));
    const after = await aiRows();
    expect(after.find((row) => row.request_id === "unrelated-result")).toEqual(
      before.find((row) => row.request_id === "unrelated-result"),
    );
    for (const id of ["source-result", "note-result", "running-unprovenanced"])
      expect(after.find((row) => row.request_id === id)).toMatchObject({
        state: "failed",
        result: null,
        error_code: "SOURCE_PURGED",
      });
    expect(
      after.map(({ request_id, created_at, fingerprint }) => ({
        request_id,
        created_at,
        fingerprint,
      })),
    ).toEqual(
      before.map(({ request_id, created_at, fingerprint }) => ({
        request_id,
        created_at,
        fingerprint,
      })),
    );
    expect(await aiRows(ownerB)).toEqual(foreignBefore);
    await expect(
      asRole("service_role", null, () =>
        db.query(
          "select public.finish_ai_request($1::uuid,'running-unprovenanced',$2::jsonb,null)",
          [ownerA, JSON.stringify({ citations: [citation()] })],
        ),
      ),
    ).rejects.toMatchObject({ code: "PT409" });
  });

  it("invalidates every selected conversation attempt ID including its latest B-only answer when A appears only in history, and refuses replay", async () => {
    const c = conversation("mixed-thread", { sourceId: "source-b", sourceIds: ["source-b"] });
    const messages = c.messages as Json[];
    messages.push(
      {
        id: "mixed-thread-b-question",
        role: "user",
        content: "B question",
        citations: [],
        createdAt: now,
      },
      {
        id: "mixed-thread-b-answer",
        role: "assistant",
        content: "Latest B answer",
        citations: [citation("source-b")],
        attempt: {
          id: "latest-b-request",
          questionMessageId: "mixed-thread-b-question",
          status: "completed",
          scopeSnapshot: {
            scope: "document",
            sourceId: "source-b",
            sourceIds: ["source-b"],
            spaceId: "library",
          },
        },
        createdAt: now,
      },
    );
    await save(workspace([], [c]));
    await insertAiResult("mixed-thread-attempt", { citations: [citation()] });
    await insertAiResult("latest-b-request", {
      citations: [citation("source-b")],
      content: "Latest B cached answer",
    });
    await insertAiResult("unrelated-b-request", {
      citations: [citation("source-b")],
      content: "Independent B cached answer",
    });
    const before = await aiRows();
    await purge(await preview([], ["mixed-thread"]));
    const after = await aiRows();
    expect(after.find((row) => row.request_id === "latest-b-request")).toMatchObject({
      state: "failed",
      result: null,
      error_code: "SOURCE_PURGED",
    });
    expect(after.find((row) => row.request_id === "unrelated-b-request")).toEqual(
      before.find((row) => row.request_id === "unrelated-b-request"),
    );
    const replay = await asRole(
      "service_role",
      null,
      async () =>
        (
          await db.query<{ value: Json }>(
            "select public.reserve_ai_request($1::uuid,'latest-b-request',$2,50) as value",
            [ownerA, "f".repeat(64)],
          )
        ).rows[0]!.value,
    );
    expect(replay).toMatchObject({ status: "failed", result: null, errorCode: "SOURCE_PURGED" });
    await expect(
      asRole("service_role", null, () =>
        db.query("select public.finish_ai_request($1::uuid,'latest-b-request',$2::jsonb,null)", [
          ownerA,
          JSON.stringify({ content: "Resurrected B answer" }),
        ]),
      ),
    ).rejects.toMatchObject({ code: "PT409" });
  });

  it("clears exact public organization requestId and private model_request_id caches while retaining unrelated completed work", async () => {
    const data = {
      ...workspace(),
      organizationJobs: [
        {
          id: "public-job-id",
          request: {
            requestId: "public-request-id",
            sourceIds: ["source-b"],
            targetNote: { id: "note-a" },
          },
          status: "ready",
        },
      ],
    };
    await save(data);
    await insertCompletedJob(
      "private-job-id",
      { sourceIds: ["source-b"] },
      { targetNoteId: "note-a", body: "Staged note update" },
    );
    await db.query(
      "update conuo_private.organization_jobs set model_request_id='private-model-request-id' where owner_id=$1 and job_id='private-job-id'",
      [ownerA],
    );
    await insertAiResult("public-request-id", { content: "Unstructured public-job cache" });
    await insertAiResult("private-model-request-id", {
      content: "Unstructured private-model cache",
    });
    await insertAiResult("unrelated-organization-id", { content: "Unrelated organization result" });
    const before = await aiRows();
    await purge(await preview(["note-a"]));
    const after = await aiRows();
    for (const id of ["public-request-id", "private-model-request-id"])
      expect(after.find((row) => row.request_id === id)).toMatchObject({
        state: "failed",
        result: null,
        error_code: "SOURCE_PURGED",
      });
    expect(after.find((row) => row.request_id === "unrelated-organization-id")).toEqual(
      before.find((row) => row.request_id === "unrelated-organization-id"),
    );
    await expect(
      asRole("service_role", null, () =>
        db.query(
          "select public.finish_ai_request($1::uuid,'private-model-request-id',$2::jsonb,null)",
          [ownerA, JSON.stringify({ content: "Replayed staged body" })],
        ),
      ),
    ).rejects.toMatchObject({ code: "PT409" });
  });
});
