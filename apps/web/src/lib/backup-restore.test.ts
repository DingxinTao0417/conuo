import { describe, expect, it } from "vitest";
import {
  archiveExcessRestoreSpaces,
  prepareBackupRestore,
  mergeBackupRestore,
} from "./backup-restore";
import type { PreparedBackup } from "./backup-types";
import type { Citation, Note, Source, SourceVersion, WorkspaceData } from "./types";
import type { OrganizationJob } from "./organization-types";
import {
  snapshotKnowledgeNote,
  knowledgeNoteKey,
  knowledgeBlocks,
  validateKnowledgeChanges,
  applyKnowledgeUpdate,
} from "./knowledge-update";
import { advanceImportJob, createImportJob, retryImportJob, startImportJob } from "./import-queue";
import { MAX_WORKSPACE_BYTES } from "./supabase/validation";
import {
  recoverableSourceAnnotationDraftId,
  createRecoverableSourceAnnotationDraft,
  resolveRecoverableSourceAnnotationDraft,
} from "./recoverable-drafts";

const now = "2026-09-12T12:00:00.000Z";
const originalKey = "old-blob-key";
function source(id = "source-a", versionId = "v2"): Source {
  return {
    id,
    versionId,
    title: id,
    filename: `${id}.txt`,
    kind: "text",
    mime: "text/plain",
    size: 2,
    hash: "a".repeat(64),
    spaceIds: ["library"],
    tags: ["tag"],
    tagsLocked: true,
    tagsRevision: 9,
    status: "ready",
    text: `Text of ${id}/${versionId}. #note/n1 is verbatim.`,
    chunks: [
      {
        id: "c0",
        sourceId: id,
        versionId,
        text: `Text of ${id}/${versionId}.`,
        section: "Body",
        order: 8,
      },
    ],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    aiAllowed: true,
    starred: true,
    readOffset: 20,
  };
}
function historical(value: Source): SourceVersion {
  return {
    versionId: value.versionId,
    title: value.title,
    filename: value.filename,
    kind: value.kind,
    mime: value.mime,
    size: value.size,
    hash: value.hash,
    status: value.status,
    text: value.text,
    chunks: value.chunks,
    createdAt: now,
    archivedAt: now,
  };
}
function citation(id = "source-a", versionId = "v2"): Citation {
  return {
    sourceId: id,
    versionId,
    chunkId: "c0",
    title: id,
    quote: `Text of ${id}/${versionId}.`,
    section: "Body",
  };
}
function note(id = "n1", citations = [citation()]): Note {
  return {
    id,
    spaceId: "library",
    title: id,
    content: `<p><a href="#source/source-a/version/v1">old</a></p>`,
    kind: "knowledge",
    status: "accepted",
    aiGenerated: true,
    contentRevision: 6,
    citations,
    versions: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}
function workspace(): WorkspaceData {
  return {
    schemaVersion: 1,
    aiEnabled: true,
    semanticSearch: true,
    autoOrganize: true,
    spaces: [
      {
        id: "library",
        name: "Library",
        goal: "goal",
        color: "purple",
        archived: true,
        createdAt: now,
      },
    ],
    sources: [],
    notes: [],
    annotations: [],
    conversations: [],
  };
}
function backup(data: WorkspaceData): PreparedBackup {
  return { data, originals: [], missingOriginals: [], fingerprint: "f".repeat(64) };
}
function fixture(): PreparedBackup {
  const data = workspace();
  const a = source(),
    b = source("source-b"),
    old = historical(source("source-a", "v1"));
  a.blobKey = originalKey;
  a.storagePath = "old-owner/v2/source-a.txt";
  old.blobKey = "old-history-key";
  old.storagePath = "old-owner/v1/source-a.txt";
  a.versions = [old];
  a.deletedAt = now;
  const first = note(),
    second = note("n2", [citation("source-b")]);
  first.manualExcerptRefs = [
    {
      sourceId: "source-a",
      versionId: "v2",
      chunkId: "c0",
      selectionFingerprint: "1111111111111111",
    },
  ];
  first.versions = [
    {
      id: "same-history-id",
      title: "old",
      content: "[old](#source/source-a/version/v1)",
      savedAt: now,
      citations: [citation("source-a", "v1")],
      status: "draft",
      aiGenerated: true,
      spaceId: "library",
      contentRevision: 2,
      manualExcerptRefs: [
        {
          sourceId: "source-a",
          versionId: "v1",
          chunkId: "c0",
          selectionFingerprint: "2222222222222222",
        },
      ],
    },
    { id: "same-history-id", title: "legacy", content: "literal #note/n1", savedAt: now },
  ];
  data.sources = [a, b];
  data.notes = [first, second];
  data.annotations = [
    {
      id: "a1",
      sourceId: a.id,
      versionId: "v1",
      quote: "kept quote",
      note: "#note/n1 literal",
      createdAt: now,
    },
  ];
  data.recoverableDrafts = [
    createRecoverableSourceAnnotationDraft(a, a.deletedAt!, data.annotations[0]),
  ];
  data.resolvedRecoverableDrafts = [
    resolveRecoverableSourceAnnotationDraft(
      {
        id: recoverableSourceAnnotationDraftId("handled-annotation", now),
        sourceId: a.id,
        annotationId: "handled-annotation",
        sourceDeletedAt: now,
      },
      "remove",
    ),
  ];
  data.conversations = [
    {
      id: "conv1",
      spaceId: "library",
      sourceIds: [a.id, b.id],
      title: "history",
      scope: "sources",
      comparison: {
        leftSourceId: a.id,
        leftVersionId: a.versionId,
        rightSourceId: b.id,
        rightVersionId: b.versionId,
      },
      resolved: true,
      updatedAt: now,
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "[saved](#note/n1)",
          citations: [citation("source-a", "v1")],
          noteEvidence: [
            {
              noteId: "n1",
              spaceId: "library",
              sourceId: "source-a",
              sourceVersionId: "v1",
              revision: 6,
              updatedAt: now,
              blockId: "block-1",
              title: "n1",
              quote: "恢复时必须一起重映射这条个人笔记依据。",
            },
          ],
          createdAt: now,
          mode: "model",
        },
      ],
    },
  ];
  const common = {
    trigger: "manual" as const,
    spaceId: "library",
    sourceIds: [a.id],
    sourceVersions: [{ sourceId: a.id, versionId: a.versionId }],
  };
  const target = { id: first.id, revision: first.contentRevision!, updatedAt: now };
  const compare = { id: second.id, revision: second.contentRevision!, updatedAt: now };
  const jobs: OrganizationJob[] = [
    {
      id: "js",
      request: { ...common, requestId: "js", kind: "source", trigger: "automatic" },
      status: "running",
      createdAt: now,
      updatedAt: now,
      result: {
        kind: "source",
        mode: "model",
        coverage: "coverage",
        summary: { title: "summary", content: "[note](#note/n1)", citations: [citation()] },
        tags: [{ label: "tag", citations: [citation()] }],
        topics: [{ label: "topic", citations: [citation()] }],
      },
      appliedTags: { added: ["tag"], before: [], after: ["tag"], revision: 9 },
    },
    {
      id: "jk",
      request: { ...common, requestId: "jk", kind: "knowledge" },
      status: "ready",
      createdAt: now,
      updatedAt: now,
      result: {
        kind: "knowledge",
        mode: "model",
        coverage: "coverage",
        pages: [{ title: "page", content: "[note](#note/n1)", citations: [citation()] }],
      },
      savedPages: [{ index: 0, noteId: first.id }],
      ignoredPages: [],
    },
    {
      id: "ju",
      request: { ...common, requestId: "ju", kind: "update", targetNote: target },
      status: "ready",
      createdAt: now,
      updatedAt: now,
      result: {
        kind: "update",
        mode: "model",
        coverage: "coverage",
        target: snapshotKnowledgeNote(first),
        changes: [
          {
            id: "change1",
            type: "replace",
            blockId: "b1",
            before: first.content,
            after: "plain #note/n1",
            reason: "why",
            citations: [citation()],
          },
          {
            id: "change2",
            type: "remove",
            blockId: "b2",
            before: "<p>remove</p>",
            after: "",
            reason: "why",
            citations: [citation()],
          },
        ],
      },
      updateReview: {
        note: snapshotKnowledgeNote(first),
        applied: [{ changeId: "change1", text: "plain #note/n1" }],
        ignored: ["change2"],
      },
    },
    {
      id: "jr",
      request: {
        ...common,
        requestId: "jr",
        kind: "relations",
        targetNote: target,
        compareNote: compare,
      },
      status: "queued",
      createdAt: now,
      updatedAt: now,
      result: {
        kind: "relations",
        mode: "model",
        target: snapshotKnowledgeNote(first),
        compare: snapshotKnowledgeNote(second),
        coverage: "coverage",
        relations: [
          {
            id: "p1",
            type: "conflict",
            fromClaim: "first",
            toClaim: "second",
            fromCondition: "condition A",
            toCondition: "condition B",
            explanation: "reason",
            fromCitations: [citation()],
            toCitations: [citation("source-b")],
          },
        ],
      },
      savedRelations: [{ proposalId: "p1", relationId: "r1" }],
      ignoredRelations: ["p2"],
    },
  ];
  data.organizationJobs = jobs;
  data.conceptRelations = [
    {
      id: "r1",
      spaceId: "library",
      type: "conflict",
      fromClaim: "first",
      toClaim: "second",
      fromCondition: "condition A",
      toCondition: "condition B",
      explanation: "reason",
      fromCitations: [citation()],
      toCitations: [citation("source-b")],
      from: snapshotKnowledgeNote(first),
      to: snapshotKnowledgeNote(second),
      origin: "ai",
      revision: 3,
      createdAt: now,
      updatedAt: now,
      deletedAt: now,
      jobId: "jr",
      proposalId: "p1",
    },
  ];
  return {
    ...backup(data),
    originals: [
      { sourceId: a.id, versionId: a.versionId, blob: new Blob(["v2"], { type: "text/plain" }) },
    ],
    missingOriginals: [
      { sourceId: a.id, versionId: "v1", title: "old original", reason: "not in archive" },
    ],
  };
}

describe("backup restore identity mapping", () => {
  it("rebinds a retained-version second-occurrence annotation while preserving verbatim text offsets", () => {
    const data = workspace();
    const current = source();
    const text = "😀 重复\r\n \n 重复\r\n ";
    const quote = " 重复\r\n ";
    const old = historical({ ...source("source-a", "v1"), text, chunks: [] });
    current.versions = [old];
    data.sources = [current];
    data.annotations = [
      {
        id: "a1",
        sourceId: current.id,
        versionId: old.versionId,
        quote,
        note: "保留第二处",
        createdAt: now,
        textAnchor: { start: text.lastIndexOf(quote), end: text.length },
      },
    ];
    const restored = prepareBackupRestore(backup(data)).data;
    expect(restored.sources[0].versions![0].text).toBe(text);
    expect(restored.annotations[0]).toMatchObject({
      sourceId: restored.sources[0].id,
      versionId: restored.sources[0].versions![0].versionId,
      quote,
      textAnchor: data.annotations[0].textAnchor,
    });
    expect(restored.annotations[0].sourceId).not.toBe(current.id);
    expect(restored.annotations[0].versionId).not.toBe(old.versionId);
  });

  it("preserves the complete graph and evidence while replacing scoped identities and original handles", () => {
    const input = fixture(),
      before = structuredClone(input.data);
    const plan = prepareBackupRestore(input),
      data = plan.data;
    const [a, b] = data.sources,
      old = a.versions![0],
      [first, second] = data.notes;
    expect(input.data).toEqual(before);
    expect(a.id).not.toBe("source-a");
    expect(a.versionId).not.toBe("v2");
    expect(a.versionId).not.toBe(b.versionId);
    expect(new Set([a.chunks[0].id, b.chunks[0].id, old.chunks[0].id]).size).toBe(3);
    expect(a.chunks[0]).toMatchObject({
      sourceId: a.id,
      versionId: a.versionId,
      text: before.sources[0].chunks[0].text,
      order: 8,
    });
    expect(a.text).toBe(before.sources[0].text);
    expect(a.deletedAt).toBe(now);
    expect(data.spaces[0].archived).toBe(true);
    expect(a.spaceIds).toEqual([data.spaces[0].id]);
    expect(a.tagsLocked).toBe(true);
    expect(a.tagsRevision).toBe(9);
    expect(a.readOffset).toBe(20);
    expect(data.aiEnabled).toBe(false);
    expect(data.autoOrganize).toBe(false);
    expect(data.semanticSearch).toBe(false);
    expect(data.sources.every((item) => !item.aiAllowed)).toBe(true);
    expect(a.storagePath).toBeUndefined();
    expect(old.storagePath).toBeUndefined();
    expect(a.blobKey).toBe(`original:${a.id}:${a.versionId}`);
    expect(old.blobKey).toBeUndefined();
    expect(old.originalMissing).toBe(true);
    expect(a.originalMissing).toBeUndefined();
    expect(plan.blobs).toEqual([
      { key: a.blobKey, sourceId: a.id, versionId: a.versionId, blob: input.originals[0].blob },
    ]);
    expect(plan.missingOriginals[0]).toMatchObject({
      sourceId: a.id,
      versionId: old.versionId,
      reason: "not in archive",
    });
    expect(first.citations[0]).toMatchObject({
      sourceId: a.id,
      versionId: a.versionId,
      chunkId: a.chunks[0].id,
      quote: citation().quote,
    });
    expect(first.versions[0].citations![0]).toMatchObject({
      sourceId: a.id,
      versionId: old.versionId,
      chunkId: old.chunks[0].id,
    });
    expect(first.manualExcerptRefs).toEqual([
      expect.objectContaining({
        sourceId: a.id,
        versionId: a.versionId,
        chunkId: a.chunks[0].id,
        selectionFingerprint: "1111111111111111",
      }),
    ]);
    expect(first.versions[0].manualExcerptRefs).toEqual([
      expect.objectContaining({
        sourceId: a.id,
        versionId: old.versionId,
        chunkId: old.chunks[0].id,
        selectionFingerprint: "2222222222222222",
      }),
    ]);
    expect(first.versions[1]).not.toHaveProperty("citations");
    expect(first.versions[0].id).not.toBe(first.versions[1].id);
    expect(first).toMatchObject({
      aiGenerated: true,
      status: "accepted",
      contentRevision: 6,
      updatedAt: now,
    });
    expect(first.versions[0]).toMatchObject({
      aiGenerated: true,
      status: "draft",
      contentRevision: 2,
      savedAt: now,
    });
    expect(first.content).toContain(`#source/${a.id}/version/${old.versionId}`);
    expect(data.annotations[0]).toMatchObject({
      sourceId: a.id,
      versionId: old.versionId,
      quote: "kept quote",
      note: "#note/n1 literal",
    });
    expect(data.recoverableDrafts).toHaveLength(1);
    expect(data.recoverableDrafts![0]).toMatchObject({
      id: recoverableSourceAnnotationDraftId(data.annotations[0].id, now),
      sourceId: a.id,
      sourceVersionId: old.versionId,
      sourceTitle: a.title,
      sourceDeletedAt: now,
      annotationId: data.annotations[0].id,
      annotationCreatedAt: data.annotations[0].createdAt,
      quote: data.annotations[0].quote,
      note: data.annotations[0].note,
      capturedAt: now,
    });
    expect(data.recoverableDrafts![0].id).not.toBe(before.recoverableDrafts![0].id);
    expect(data.recoverableDrafts![0].annotationId).not.toBe(
      before.recoverableDrafts![0].annotationId,
    );
    expect(data.resolvedRecoverableDrafts).toHaveLength(1);
    expect(data.resolvedRecoverableDrafts![0]).toMatchObject({
      id: recoverableSourceAnnotationDraftId(data.resolvedRecoverableDrafts![0].annotationId, now),
      sourceId: a.id,
      sourceDeletedAt: now,
      annotationDisposition: "remove",
    });
    expect(data.resolvedRecoverableDrafts![0].id).not.toBe(before.resolvedRecoverableDrafts![0].id);
    expect(data.resolvedRecoverableDrafts![0].annotationId).not.toBe(
      before.resolvedRecoverableDrafts![0].annotationId,
    );
    expect(data.conversations[0].sourceIds).toEqual([a.id, b.id]);
    expect(data.conversations[0].comparison).toEqual({
      leftSourceId: a.id,
      leftVersionId: a.versionId,
      rightSourceId: b.id,
      rightVersionId: b.versionId,
    });
    expect(data.conversations[0].messages[0]).toMatchObject({
      mode: "model",
      content: `[saved](#note/${first.id})`,
    });
    expect(data.conversations[0].messages[0].citations[0].versionId).toBe(old.versionId);
    expect(data.conversations[0].messages[0].noteEvidence).toEqual([
      expect.objectContaining({
        noteId: first.id,
        spaceId: data.spaces[0].id,
        sourceId: a.id,
        sourceVersionId: old.versionId,
      }),
    ]);
    expect(data.conceptRelations![0].to.id).toBe(second.id);
    expect(plan.counts).toEqual({
      spaces: 1,
      sources: 2,
      sourceVersions: 1,
      notes: 2,
      noteVersions: 2,
      conversations: 1,
      messages: 1,
      annotations: 1,
      recoverableDrafts: 1,
      organizationJobs: 4,
      conceptRelations: 1,
    });
  });

  it("remaps answer-attempt identity, question linkage, and frozen evidence scope", () => {
    const data = workspace();
    const original = source();
    const peer = source("source-b");
    data.sources = [original, peer];
    data.notes = [note("n1")];
    data.conversations = [
      {
        id: "conversation-attempt",
        spaceId: "library",
        sourceId: original.id,
        title: "失败后重试",
        scope: "selection",
        sourceIds: [original.id],
        resolved: false,
        updatedAt: now,
        messages: [
          {
            id: "question-attempt",
            role: "user",
            content: "请解释 [旧资料](#source/source-a/version/v2)",
            citations: [],
            createdAt: now,
          },
          {
            id: "answer-attempt",
            role: "assistant",
            content: "",
            citations: [],
            error: "回答未完成。",
            attempt: {
              id: "request-attempt",
              questionMessageId: "question-attempt",
              scopeSnapshot: {
                scope: "selection",
                sourceId: original.id,
                sourceIds: [original.id],
                spaceId: "library",
                selection: "[原选段](#source/source-a/version/v2)",
                userContext: ["参照 [旧笔记](#note/n1)"],
              },
              status: "failed",
            },
            createdAt: now,
          },
        ],
      },
      {
        id: "fixed-version-attempt",
        spaceId: "library",
        title: "固定版本失败后重试",
        scope: "sources",
        sourceIds: [original.id, peer.id],
        comparison: {
          leftSourceId: original.id,
          leftVersionId: original.versionId,
          rightSourceId: peer.id,
          rightVersionId: peer.versionId,
        },
        resolved: false,
        updatedAt: now,
        messages: [
          {
            id: "fixed-version-question",
            role: "user",
            content: "这份资料的结论是什么？",
            citations: [],
            createdAt: now,
          },
          {
            id: "fixed-version-answer",
            role: "assistant",
            content: "",
            citations: [],
            error: "回答未完成。",
            attempt: {
              id: "fixed-version-request",
              questionMessageId: "fixed-version-question",
              scopeSnapshot: {
                scope: "sources",
                sourceIds: [original.id, peer.id],
                sourceVersions: [
                  { sourceId: original.id, versionId: original.versionId },
                  { sourceId: peer.id, versionId: peer.versionId },
                ],
                comparison: {
                  leftSourceId: original.id,
                  leftVersionId: original.versionId,
                  rightSourceId: peer.id,
                  rightVersionId: peer.versionId,
                },
                spaceId: "library",
              },
              status: "failed",
            },
            createdAt: now,
          },
        ],
      },
    ];

    const restored = prepareBackupRestore(backup(data)).data;
    const [question, answer] = restored.conversations[0].messages;
    const attempt = answer.attempt!;
    expect(question.id).not.toBe("question-attempt");
    expect(attempt.id).not.toBe("request-attempt");
    expect(attempt.questionMessageId).toBe(question.id);
    expect(attempt.scopeSnapshot).toMatchObject({
      scope: "selection",
      sourceId: restored.sources[0].id,
      sourceIds: [restored.sources[0].id],
      spaceId: restored.spaces[0].id,
    });
    expect(attempt.scopeSnapshot.selection).toContain(
      `#source/${restored.sources[0].id}/version/${restored.sources[0].versionId}`,
    );
    expect(attempt.scopeSnapshot.userContext).toEqual([
      `参照 [旧笔记](#note/${restored.notes[0].id})`,
    ]);
    expect(attempt.status).toBe("failed");
    const fixedVersionConversation = restored.conversations.find(
      (conversation) => conversation.title === "固定版本失败后重试",
    )!;
    const fixedVersionAttempt = fixedVersionConversation.messages.find(
      (message) => message.role === "assistant",
    )!.attempt!;
    expect(fixedVersionAttempt.scopeSnapshot.sourceVersions).toEqual([
      {
        sourceId: restored.sources[0].id,
        versionId: restored.sources[0].versionId,
      },
      {
        sourceId: restored.sources[1].id,
        versionId: restored.sources[1].versionId,
      },
    ]);
    expect(fixedVersionAttempt.scopeSnapshot.comparison).toEqual(
      fixedVersionConversation.comparison,
    );
  });

  it("remaps each organization kind, reviewed change/proposal IDs and relation bases without losing AI origin", () => {
    const plan = prepareBackupRestore(fixture()),
      data = plan.data;
    const [sourceJob, pagesJob, updateJob, relationJob] = data.organizationJobs!;
    expect(sourceJob.status).toBe("cancelled");
    expect(relationJob.status).toBe("cancelled");
    expect(sourceJob.appliedTags).toEqual({
      added: ["tag"],
      before: [],
      after: ["tag"],
      revision: 9,
    });
    expect(data.organizationJobs!.every((job) => job.id === job.request.requestId)).toBe(true);
    expect(data.organizationJobs!.every((job) => job.restoredFromBackup === true)).toBe(true);
    expect(sourceJob.request.sourceVersions[0]).toEqual({
      sourceId: data.sources[0].id,
      versionId: data.sources[0].versionId,
    });
    expect(pagesJob.savedPages).toEqual([{ index: 0, noteId: data.notes[0].id }]);
    expect(updateJob.result?.kind).toBe("update");
    if (updateJob.result?.kind !== "update" || relationJob.result?.kind !== "relations")
      throw new Error("Fixture");
    expect(updateJob.request.targetNote!.id).toBe(data.notes[0].id);
    expect(updateJob.result.changes[0].id).toBe(updateJob.updateReview!.applied[0].changeId);
    expect(updateJob.result.changes[1].id).toBe(updateJob.updateReview!.ignored[0]);
    expect(updateJob.result.changes[0].blockId).toBe("b1");
    expect(updateJob.result.changes[0].before).toBe(data.notes[0].content);
    expect(updateJob.result.changes[0].after).toBe("plain #note/n1");
    expect(knowledgeNoteKey(updateJob.updateReview!.note)).toBe(knowledgeNoteKey(data.notes[0]));
    const relation = data.conceptRelations![0];
    expect(relation).toMatchObject({
      origin: "ai",
      deletedAt: now,
      revision: 3,
      jobId: relationJob.id,
    });
    expect(relation.proposalId).toBe(relationJob.result.relations[0].id);
    expect(relationJob.savedRelations).toEqual([
      { proposalId: relation.proposalId, relationId: relation.id },
    ]);
    expect(relationJob.ignoredRelations![0]).not.toBe("p2");
    expect(knowledgeNoteKey(relation.from)).toBe(knowledgeNoteKey(data.notes[0]));
    expect(knowledgeNoteKey(relation.to)).toBe(knowledgeNoteKey(data.notes[1]));
    expect(relationJob.request.compareNote!.id).toBe(data.notes[1].id);
  });

  it("maps absent source/version/chunk and note targets separately so they cannot bind existing content", () => {
    const data = workspace();
    data.sources = [source()];
    const absent = citation("outside", "v-missing"),
      missingVersion = citation("source-a", "v9");
    data.notes = [
      note("n1", [absent, missingVersion, { ...citation(), chunkId: "missing-chunk" }]),
    ];
    data.notes[0].content = "[missing](#note/absent) [old](#source/outside/version/v-missing)";
    const plan = prepareBackupRestore(backup(data)),
      restored = plan.data;
    expect(restored.notes[0].citations[0].sourceId).not.toBe("outside");
    expect(
      restored.sources.some((item) => item.id === restored.notes[0].citations[0].sourceId),
    ).toBe(false);
    expect(restored.notes[0].content).toContain(
      `#source/${restored.notes[0].citations[0].sourceId}/version/${restored.notes[0].citations[0].versionId}`,
    );
    expect(restored.notes[0].citations[1].sourceId).toBe(restored.sources[0].id);
    expect(restored.notes[0].citations[1].versionId).not.toBe(restored.sources[0].versionId);
    expect(restored.notes[0].citations[2].chunkId).not.toBe(restored.sources[0].chunks[0].id);
    const current = workspace();
    current.sources = [source("outside")];
    current.notes = [note("absent")];
    const merged = mergeBackupRestore(current, plan);
    expect(
      merged.sources.filter((item) => item.id === restored.notes[0].citations[0].sourceId),
    ).toHaveLength(0);
  });

  it("changes only parsed internal link destinations in HTML, Markdown and reference definitions", () => {
    const data = workspace();
    data.sources = [source()];
    data.notes = [note()];
    data.notes[0].content =
      `[inline](#note/n1 "title") [ref][r]\n\n[r]: <#source/source-a/version/v2> "old"\n\n` +
      `literal #note/n1 and \`[code](#note/n1)\`\n\n\`\`\`html\n<a href="#note/n1">code</a>\n\`\`\`\n\n` +
      `<p data-link='href="#note/n1"'><a title=">" href='&#35;note/n1'>go</a> <a href=#note/n1/relations>relations</a></p>\n` +
      `<pre><a href="#note/n1">literal HTML code</a></pre>\n\n[external](https://example.com/#note/n1)`;
    const plan = prepareBackupRestore(backup(data)),
      target = plan.data.notes[0],
      item = plan.data.sources[0];
    expect(target.content).toContain(`[inline](#note/${target.id} "title")`);
    expect(target.content).toContain(`[r]: <#source/${item.id}/version/${item.versionId}> "old"`);
    expect(target.content).toContain(`href='#note/${target.id}'`);
    expect(target.content).toContain(`href=#note/${target.id}/relations`);
    expect(target.content).toContain(`data-link='href="#note/n1"'`);
    expect(target.content).toContain("literal #note/n1 and `[code](#note/n1)`");
    expect(target.content).toContain('```html\n<a href="#note/n1">code</a>\n```');
    expect(target.content).toContain('<pre><a href="#note/n1">literal HTML code</a></pre>');
    expect(target.content).toContain("[external](https://example.com/#note/n1)");
  });

  it("retains missing-original markers with no old handles and clears them only for verified supplied originals", () => {
    const data = workspace(),
      item = source();
    item.originalMissing = true;
    data.sources = [item];
    const missing = prepareBackupRestore(backup(data));
    expect(missing.data.sources[0]).toMatchObject({ originalMissing: true });
    expect(missing.data.sources[0].blobKey).toBeUndefined();
    expect(missing.missingOriginals).toHaveLength(1);
    const present = prepareBackupRestore({
      ...backup(data),
      originals: [{ sourceId: item.id, versionId: item.versionId, blob: new Blob(["ok"]) }],
    });
    expect(present.data.sources[0].originalMissing).toBeUndefined();
    expect(present.missingOriginals).toEqual([]);
    expect(present.blobs).toHaveLength(1);
  });

  it("stops unfinished file imports safely while keeping only supplied originals retryable", () => {
    const data = workspace();
    const retained = source("pending-file");
    retained.status = "partial";
    retained.blobKey = "old-pending-original";
    retained.storagePath = "old-owner/pending-file.txt";
    retained.coverage = {
      captureScope: "full",
      parseState: "partial",
      unavailablePageRanges: [{ start: 2, end: 4 }],
    };
    const missing = source("missing-file");
    missing.status = "partial";
    missing.blobKey = "old-missing-original";
    missing.storagePath = "old-owner/missing-file.txt";
    missing.coverage = {
      captureScope: "full",
      parseState: "partial",
      unavailablePageRanges: [{ start: 1, end: 1 }],
    };
    const running = (item: Source) =>
      advanceImportJob(
        startImportJob(
          createImportJob({
            sourceId: item.id,
            versionId: item.versionId,
            filename: item.filename,
            spaceId: "library",
            at: now,
          }),
          now,
        ),
        "parsing",
        now,
      );
    data.sources = [retained, missing];
    data.importJobs = [running(retained), running(missing)];
    const plan = prepareBackupRestore({
      ...backup(data),
      originals: [{ sourceId: retained.id, versionId: retained.versionId, blob: new Blob(["ok"]) }],
    });
    const restored = plan.data.sources.find((item) => item.title === retained.title)!;
    const restoredJob = plan.data.importJobs!.find((item) => item.filename === retained.filename)!;
    expect(restored).toMatchObject({
      status: "saved",
      text: "",
      chunks: [],
      error: "从备份恢复时未继续解析。原文件已保存，可从导入记录重新解析。",
    });
    expect(restored.originalMissing).toBeUndefined();
    expect(restored.coverage).toEqual({ captureScope: "full", parseState: "pending" });
    expect(restored.blobKey).toBe(`original:${restored.id}:${restored.versionId}`);
    expect(restoredJob).toMatchObject({
      sourceId: restored.id,
      versionId: restored.versionId,
      status: "cancelled",
      stage: "parsing",
      originalSaved: true,
    });
    expect(retryImportJob(restoredJob, now)).toMatchObject({
      id: restoredJob.id,
      status: "queued",
      originalSaved: true,
    });
    expect(plan.data.importJobs).not.toContainEqual(
      expect.objectContaining({ status: expect.stringMatching(/^(queued|running)$/) }),
    );

    const restoredMissing = plan.data.sources.find((item) => item.title === missing.title)!;
    expect(restoredMissing).toMatchObject({
      status: "failed",
      text: "",
      chunks: [],
      originalMissing: true,
      error: "从备份恢复时未找到原文件，无法继续解析。请重新选择原文件后再导入。",
    });
    expect(restoredMissing.coverage).toEqual({ captureScope: "full", parseState: "failed" });
    expect(plan.data.importJobs!.some((item) => item.sourceId === restoredMissing.id)).toBe(false);
    expect(plan.missingOriginals).toContainEqual(
      expect.objectContaining({
        sourceId: restoredMissing.id,
        versionId: restoredMissing.versionId,
      }),
    );

    const merged = mergeBackupRestore(workspace(), plan);
    expect(merged.importJobs).toEqual(plan.data.importJobs);
    expect(merged.sources.find((item) => item.id === restoredMissing.id)).toMatchObject({
      status: "failed",
      originalMissing: true,
    });

    restoredJob.status = "queued";
    delete restoredJob.cancelledAt;
    expect(() => mergeBackupRestore(workspace(), plan)).toThrow(/文件导入/);
  });

  it("maps root-relative library/source/note links and unsupported conversation identities without silent cross-binding", () => {
    const input = fixture();
    input.data.notes[0].content =
      `[library](/#library/library) [note](./#note/n2/relations) ` +
      `[source](/#source/source-a/version/v1/extra) [conversation](#conversation/conv1) ` +
      `[invalid](#note/n1?bad) [inbox](#library/inbox)`;
    const plan = prepareBackupRestore(input),
      data = plan.data,
      text = data.notes[0].content;
    expect(text).toContain(`/#library/${data.spaces[0].id}`);
    expect(text).toContain(`./#note/${data.notes[1].id}/relations`);
    expect(text).toContain(
      `/#source/${data.sources[0].id}/version/${data.sources[0].versions![0].versionId}/extra`,
    );
    expect(text).toContain(`#conversation/${data.conversations[0].id}`);
    expect(text).toContain("[invalid](#backup-link-unavailable)");
    expect(text).toContain("[inbox](#library/inbox)");
    expect(plan.warnings.some((warning) => warning.includes("会话直达"))).toBe(false);
    expect(plan.warnings.some((warning) => warning.includes("标识无效"))).toBe(true);
  });

  it("link remapping preserves update block identity, leaves plain after text unchanged, and applies only the selected block", () => {
    const input = backup(workspace());
    input.data.spaces[0].archived = false;
    input.data.sources = [source()];
    const first = note(),
      second = note("n2");
    first.content = '<p>Before <a href="/#note/n2">linked note</a></p><ul><li>untouched</li></ul>';
    input.data.notes = [first, second];
    const before = knowledgeBlocks(first.content)[0].html;
    input.data.organizationJobs = [
      {
        id: "update",
        status: "ready",
        createdAt: now,
        updatedAt: now,
        request: {
          requestId: "update",
          kind: "update",
          trigger: "manual",
          spaceId: "library",
          sourceIds: ["source-a"],
          sourceVersions: [{ sourceId: "source-a", versionId: "v2" }],
          targetNote: { id: first.id, revision: 6, updatedAt: now },
        },
        result: {
          kind: "update",
          mode: "model",
          target: snapshotKnowledgeNote(first),
          coverage: "complete",
          changes: [
            {
              id: "change",
              type: "replace",
              blockId: "b1",
              before,
              after: "plain [unchanged](#note/n2)",
              reason: "test",
              citations: [citation()],
            },
          ],
        },
      },
    ];
    const plan = prepareBackupRestore(input),
      data = plan.data,
      job = data.organizationJobs![0];
    if (job.result?.kind !== "update") throw new Error("Fixture");
    expect(knowledgeBlocks(job.result.target.content).map((block) => block.id)).toEqual([
      "b1",
      "b2",
    ]);
    expect(job.result.changes[0].before).toBe(knowledgeBlocks(job.result.target.content)[0].html);
    expect(job.result.changes[0].after).toBe("plain [unchanged](#note/n2)");
    expect(validateKnowledgeChanges(job.result.target, job.result.changes)).toBe(true);
    const applied = applyKnowledgeUpdate(data, job.id, [
      { changeId: job.result.changes[0].id, text: job.result.changes[0].after },
    ]);
    expect(applied.notes[0].content).toContain("plain [unchanged](#note/n2)");
    expect(applied.notes[0].content).toContain("<ul><li>untouched</li></ul>");
    expect(applied.notes[0].aiGenerated).toBe(true);
    input.data.organizationJobs![0].result = {
      ...job.result,
      target: snapshotKnowledgeNote(first),
      changes: [
        { ...job.result.changes[0], before: "<p>wrong original</p>", citations: [citation()] },
      ],
    };
    const invalid = prepareBackupRestore(input).data.organizationJobs![0];
    if (invalid.result?.kind !== "update") throw new Error("Fixture");
    expect(validateKnowledgeChanges(invalid.result.target, invalid.result.changes)).toBe(false);
  });

  it("rejects a backup with inconsistent fixed cross-library source versions", () => {
    const data = workspace();
    data.conversations = [
      {
        id: "cross-library-history",
        spaceId: "all",
        title: "跨库资料",
        scope: "cross-library-sources",
        sourceIds: ["source-a"],
        resolved: false,
        updatedAt: now,
        messages: [
          {
            id: "cross-library-question-1",
            role: "user",
            content: "第一个问题",
            citations: [],
            createdAt: now,
          },
          {
            id: "cross-library-answer-1",
            role: "assistant",
            content: "第一个回答",
            citations: [],
            createdAt: now,
            attempt: {
              id: "cross-library-attempt-1",
              questionMessageId: "cross-library-question-1",
              scopeSnapshot: {
                scope: "cross-library-sources",
                sourceIds: ["source-a"],
                sourceVersions: [{ sourceId: "source-a", versionId: "v1" }],
                spaceId: "all",
              },
              status: "completed",
            },
          },
          {
            id: "cross-library-question-2",
            role: "user",
            content: "第二个问题",
            citations: [],
            createdAt: now,
          },
          {
            id: "cross-library-answer-2",
            role: "assistant",
            content: "第二个回答",
            citations: [],
            createdAt: now,
            attempt: {
              id: "cross-library-attempt-2",
              questionMessageId: "cross-library-question-2",
              scopeSnapshot: {
                scope: "cross-library-sources",
                sourceIds: ["source-a"],
                sourceVersions: [{ sourceId: "source-a", versionId: "v2" }],
                spaceId: "all",
              },
              status: "completed",
            },
          },
        ],
      },
    ];

    expect(() => prepareBackupRestore(backup(data))).toThrow(/数据格式无效/);
  });

  it("rejects a backup with an answer attempt from a different fixed comparison version", () => {
    const data = workspace();
    data.sources = [source("source-left", "version-left"), source("source-right", "version-right")];
    const comparison = {
      leftSourceId: "source-left",
      leftVersionId: "version-left",
      rightSourceId: "source-right",
      rightVersionId: "version-right",
    };
    const snapshot = {
      scope: "sources" as const,
      sourceIds: [comparison.leftSourceId, comparison.rightSourceId],
      sourceVersions: [
        { sourceId: comparison.leftSourceId, versionId: comparison.leftVersionId },
        { sourceId: comparison.rightSourceId, versionId: comparison.rightVersionId },
      ],
      comparison,
      spaceId: "library",
    };
    data.conversations = [
      {
        id: "comparison-history",
        spaceId: "library",
        title: "固定对照资料",
        scope: "sources",
        sourceIds: [...snapshot.sourceIds],
        comparison,
        resolved: false,
        updatedAt: now,
        messages: [
          {
            id: "comparison-question-1",
            role: "user",
            content: "第一个问题",
            citations: [],
            createdAt: now,
          },
          {
            id: "comparison-answer-1",
            role: "assistant",
            content: "第一个回答",
            citations: [],
            createdAt: now,
            attempt: {
              id: "comparison-attempt-1",
              questionMessageId: "comparison-question-1",
              scopeSnapshot: snapshot,
              status: "completed",
            },
          },
          {
            id: "comparison-question-2",
            role: "user",
            content: "第二个问题",
            citations: [],
            createdAt: now,
          },
          {
            id: "comparison-answer-2",
            role: "assistant",
            content: "第二个回答",
            citations: [],
            createdAt: now,
            attempt: {
              id: "comparison-attempt-2",
              questionMessageId: "comparison-question-2",
              scopeSnapshot: {
                ...snapshot,
                sourceVersions: [
                  { sourceId: comparison.leftSourceId, versionId: comparison.leftVersionId },
                  { sourceId: comparison.rightSourceId, versionId: "version-right-v2" },
                ],
                comparison: { ...comparison, rightVersionId: "version-right-v2" },
              },
              status: "completed",
            },
          },
        ],
      },
    ];

    expect(() => prepareBackupRestore(backup(data))).toThrow(/数据格式无效/);
  });

  it("rejects duplicate entities or source version/chunk identities and mismatched original manifests", () => {
    for (const damage of [
      "entity",
      "version",
      "chunk",
      "chunk-source",
      "chunk-text",
      "original",
      "missing",
    ] as const) {
      const input = fixture();
      if (damage === "entity") input.data.sources.push(structuredClone(input.data.sources[0]));
      if (damage === "version") input.data.sources[0].versions![0].versionId = "v2";
      if (damage === "chunk")
        input.data.sources[1].chunks.push(structuredClone(input.data.sources[1].chunks[0]));
      if (damage === "chunk-source") input.data.sources[1].chunks[0].sourceId = "wrong";
      if (damage === "chunk-text") input.data.sources[1].chunks[0].text = "not actually present";
      if (damage === "original") input.originals[0].versionId = "unknown";
      if (damage === "missing") input.missingOriginals[0].versionId = "v2";
      expect(() => prepareBackupRestore(input), damage).toThrow();
    }
  });
});

describe("backup restore merge", () => {
  it("archives only incoming active spaces that exceed the account quota", () => {
    const current = workspace();
    current.spaces[0].archived = false;
    const plan = prepareBackupRestore(fixture());
    plan.data.spaces[0].archived = false;
    plan.data.spaces.push({
      id: "extra-space",
      name: "另一个空间",
      goal: "",
      color: "#7865cf",
      archived: false,
      createdAt: now,
    });
    const archived = archiveExcessRestoreSpaces(current, plan, 1);
    expect(archived).toBe(2);
    expect(plan.archivedSpaceCount).toBe(2);
    expect(plan.data.spaces.every((space) => space.archived)).toBe(true);
    expect(plan.warnings.at(-1)).toContain("转为归档");
    expect(current.spaces[0].archived).toBe(false);
  });

  it("appends a complete copy, keeps globals and current edits, and is idempotent for one plan", () => {
    const current = workspace();
    current.sources = [source("existing")];
    const plan = prepareBackupRestore(fixture());
    const merged = mergeBackupRestore(current, plan);
    expect(merged.sources[0]).toBe(current.sources[0]);
    expect(current.sources).toHaveLength(1);
    expect(merged).toMatchObject({ aiEnabled: true, autoOrganize: true, semanticSearch: true });
    expect(merged.sources).toHaveLength(3);
    expect(merged.notes).toHaveLength(2);
    expect(merged.recoverableDrafts).toHaveLength(1);
    expect(merged.recoverableDrafts![0]).not.toBe(plan.data.recoverableDrafts![0]);
    expect(merged.resolvedRecoverableDrafts).toHaveLength(1);
    expect(merged.resolvedRecoverableDrafts![0]).not.toBe(plan.data.resolvedRecoverableDrafts![0]);
    expect(merged.sources[1]).not.toBe(plan.data.sources[0]);
    merged.notes[0].content = "edited after restore";
    expect(mergeBackupRestore(merged, plan)).toBe(merged);
    expect(merged.notes[0].content).toBe("edited after restore");
    const secondPlan = prepareBackupRestore(fixture());
    expect(secondPlan.id).not.toBe(plan.id);
    expect(mergeBackupRestore(merged, secondPlan).sources).toHaveLength(5);
  });
  it("rejects partially present copies instead of silently restoring deleted objects", () => {
    const plan = prepareBackupRestore(fixture()),
      current = mergeBackupRestore(workspace(), plan);
    current.sources = current.sources.filter((source) => source.id !== plan.data.sources[0].id);
    current.recoverableDrafts = current.recoverableDrafts?.filter(
      (draft) => draft.sourceId !== plan.data.sources[0].id,
    );
    current.resolvedRecoverableDrafts = current.resolvedRecoverableDrafts?.filter(
      (draft) => draft.sourceId !== plan.data.sources[0].id,
    );
    expect(() => mergeBackupRestore(current, plan)).toThrow(/部分/);
  });
  it("rejects capacity overflow without trimming any history or mutating the target", () => {
    const current = workspace();
    current.notes = [note("large")];
    current.notes[0].content = "x".repeat(MAX_WORKSPACE_BYTES - 1000);
    const before = structuredClone(current),
      plan = prepareBackupRestore(fixture());
    expect(() => mergeBackupRestore(current, plan)).toThrow(/3 MiB/);
    expect(current).toEqual(before);
    expect(plan.data.sources[0].versions).toHaveLength(1);
  });
  it("rejects plan tampering that re-enables work or reconnects foreign storage", () => {
    for (const kind of [
      "ai",
      "storage",
      "blob",
      "queue",
      "restored-job",
      "blob-list",
      "missing-list",
    ] as const) {
      const plan = prepareBackupRestore(fixture());
      if (kind === "ai") plan.data.sources[0].aiAllowed = true;
      if (kind === "storage")
        plan.data.sources[0].versions![0].storagePath = "other-owner/v1/file.pdf";
      if (kind === "blob") plan.blobs[0].key = originalKey;
      if (kind === "queue") plan.data.organizationJobs![0].status = "queued";
      if (kind === "restored-job") delete plan.data.organizationJobs![0].restoredFromBackup;
      if (kind === "blob-list") plan.blobs = [];
      if (kind === "missing-list") plan.missingOriginals = [];
      expect(() => mergeBackupRestore(workspace(), plan), kind).toThrow();
    }
  });

  it("does not share a supposedly new original key with an existing current or retained source", () => {
    const plan = prepareBackupRestore(fixture()),
      current = workspace();
    current.sources = [source("existing")];
    const old = historical(source("existing", "v1"));
    old.blobKey = plan.blobs[0].key;
    current.sources[0].versions = [old];
    expect(() => mergeBackupRestore(current, plan)).toThrow(/原件标识/);
  });
  it("an empty archive is a no-op while included inbox scope remains inbox", () => {
    const data = workspace();
    data.spaces = [];
    const plan = prepareBackupRestore(backup(data)),
      current = workspace();
    expect(mergeBackupRestore(current, plan)).toBe(current);
    data.sources = [source()];
    data.sources[0].spaceIds = [];
    data.notes = [note()];
    data.notes[0].spaceId = "inbox";
    const inbox = prepareBackupRestore(backup(data));
    expect(inbox.data.notes[0].spaceId).toBe("inbox");
  });
});
