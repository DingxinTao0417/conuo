import { describe, expect, it } from "vitest";
import {
  permanentSourceDeletionBlockers,
  permanentSourceDeletionFingerprint,
  permanentlyDeleteSource,
  previewPermanentSourceDeletion,
  previewPermanentSourceDeletionContent,
} from "./permanent-deletion";
import { createEmptyWorkspace } from "./seed";
import { workspaceSchema } from "./supabase/validation";
import type { ConceptRelation } from "./concept-relation-types";
import type { OrganizationJob } from "./organization-types";
import type { Source, WorkspaceData } from "./types";

const at = "2026-09-13T00:00:00.000Z";
const citation = {
  sourceId: "source-a",
  versionId: "version-a",
  chunkId: "chunk-a",
  title: "要删除的资料",
  quote: "可追踪引用",
  section: "正文",
};
const unrelatedCitation = {
  ...citation,
  sourceId: "source-b",
  versionId: "version-b",
  chunkId: "chunk-b",
};

function source(overrides: Partial<Source> = {}): Source {
  return {
    id: "source-a",
    versionId: "version-a",
    title: "要删除的资料",
    filename: "delete.txt",
    kind: "text",
    mime: "text/plain",
    size: 3,
    hash: "a".repeat(64),
    spaceIds: [],
    tags: [],
    status: "ready",
    text: "正文",
    chunks: [
      {
        id: "chunk-a",
        sourceId: "source-a",
        versionId: "version-a",
        text: "正文",
        section: "正文",
        order: 0,
      },
    ],
    createdAt: at,
    updatedAt: at,
    deletedAt: at,
    aiAllowed: false,
    starred: false,
    blobKey: "original:source-a:version-a",
    storagePath: "owner-a/version-a/source-a.txt",
    versions: [
      {
        versionId: "version-old",
        title: "旧资料",
        filename: "old.txt",
        kind: "text",
        mime: "text/plain",
        size: 3,
        hash: "b".repeat(64),
        status: "ready",
        text: "旧正文",
        chunks: [],
        createdAt: at,
        archivedAt: at,
        blobKey: "original:source-a:version-old",
        storagePath: "owner-a/version-old/source-a.txt",
      },
    ],
    ...overrides,
  };
}

function workspace(): WorkspaceData {
  const data = createEmptyWorkspace();
  data.sources = [source()];
  data.annotations = [
    {
      id: "annotation-a",
      sourceId: "source-a",
      versionId: "version-a",
      quote: "正文",
      note: "",
      createdAt: at,
    },
  ];
  data.notes = [
    {
      id: "note-a",
      spaceId: "inbox",
      title: "独立笔记",
      content: "用户写下的内容",
      kind: "note",
      status: "accepted",
      citations: [citation, unrelatedCitation],
      manualExcerptRefs: [
        {
          sourceId: "source-a",
          versionId: "version-a",
          chunkId: "chunk-a",
          selectionFingerprint: "1111111111111111",
        },
        {
          sourceId: "source-b",
          versionId: "version-b",
          chunkId: "chunk-b",
          selectionFingerprint: "2222222222222222",
        },
      ],
      versions: [
        {
          id: "note-version-a",
          title: "旧笔记",
          content: "旧内容",
          savedAt: at,
          citations: [citation, unrelatedCitation],
          manualExcerptRefs: [
            {
              sourceId: "source-a",
              versionId: "version-a",
              chunkId: "chunk-a",
              selectionFingerprint: "3333333333333333",
            },
            {
              sourceId: "source-b",
              versionId: "version-b",
              chunkId: "chunk-b",
              selectionFingerprint: "4444444444444444",
            },
          ],
        },
      ],
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    },
  ];
  data.conversations = [
    {
      id: "conversation-a",
      spaceId: "inbox",
      sourceId: "source-a",
      title: "历史问题",
      scope: "document-notes",
      sourceIds: ["source-a", "source-b"],
      messages: [
        { id: "question", role: "user", content: "问题", citations: [], createdAt: at },
        {
          id: "answer",
          role: "assistant",
          content: "回答",
          citations: [citation, unrelatedCitation],
          error: "回答连接中断。",
          attempt: {
            id: "answer-attempt",
            questionMessageId: "question",
            scopeSnapshot: {
              scope: "document-notes",
              sourceId: "source-a",
              sourceIds: ["source-a"],
              spaceId: "inbox",
              userContext: ["之前的问题"],
            },
            status: "failed",
          },
          noteEvidence: [
            {
              noteId: "note-a",
              spaceId: "inbox",
              sourceId: "source-a",
              sourceVersionId: "version-a",
              revision: 1,
              updatedAt: at,
              blockId: "block-a",
              title: "独立笔记",
              quote: "回答当时使用的个人笔记摘录。",
            },
          ],
          createdAt: at,
        },
      ],
      resolved: false,
      updatedAt: at,
    },
    {
      id: "comparison-conversation",
      spaceId: "inbox",
      title: "对照历史问题",
      scope: "sources",
      sourceIds: ["source-a", "source-b"],
      comparison: {
        leftSourceId: "source-a",
        leftVersionId: "version-a",
        rightSourceId: "source-b",
        rightVersionId: "version-b",
      },
      messages: [
        {
          id: "comparison-question",
          role: "user",
          content: "差异是什么？",
          citations: [],
          createdAt: at,
        },
      ],
      resolved: false,
      updatedAt: at,
    },
  ];
  data.importJobs = [
    {
      id: "source-a:version-a",
      sourceId: "source-a",
      versionId: "version-a",
      filename: "delete.txt",
      spaceId: "",
      stage: "indexing",
      status: "cancelled",
      originalSaved: true,
      attempt: 1,
      createdAt: at,
      updatedAt: at,
      cancelledAt: at,
    },
  ];
  data.organizationJobs = [
    {
      id: "organization-a",
      request: {
        requestId: "organization-a",
        kind: "source",
        trigger: "manual",
        spaceId: data.spaces[0].id,
        sourceIds: ["source-a"],
        sourceVersions: [{ sourceId: "source-a", versionId: "version-a" }],
      },
      status: "running",
      createdAt: at,
      updatedAt: at,
    } satisfies OrganizationJob,
  ];
  data.conceptRelations = [
    {
      id: "relation-a",
      spaceId: data.spaces[0].id,
      type: "related",
      fromClaim: "A",
      toClaim: "B",
      fromCondition: "",
      toCondition: "",
      explanation: "关联",
      fromCitations: [citation],
      toCitations: [],
      from: {
        id: "knowledge-a",
        spaceId: data.spaces[0].id,
        title: "A",
        content: "A",
        citations: [],
        status: "accepted",
        aiGenerated: false,
        revision: 0,
        updatedAt: at,
      },
      to: {
        id: "knowledge-b",
        spaceId: data.spaces[0].id,
        title: "B",
        content: "B",
        citations: [],
        status: "accepted",
        aiGenerated: false,
        revision: 0,
        updatedAt: at,
      },
      origin: "ai",
      revision: 0,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    } satisfies ConceptRelation,
  ];
  return data;
}

describe("permanent source deletion", () => {
  type AttachConversation = (conversation: WorkspaceData["conversations"][number]) => void;
  const conversationPaths: [string, AttachConversation][] = [
    [
      "primary source",
      (conversation) => {
        conversation.sourceId = "source-a";
      },
    ],
    [
      "selected sources",
      (conversation) => {
        conversation.sourceIds = ["source-a"];
      },
    ],
    [
      "comparison left",
      (conversation) => {
        conversation.comparison = {
          leftSourceId: "source-a",
          leftVersionId: "version-a",
          rightSourceId: "source-b",
          rightVersionId: "version-b",
        };
      },
    ],
    [
      "comparison right",
      (conversation) => {
        conversation.comparison = {
          leftSourceId: "source-b",
          leftVersionId: "version-b",
          rightSourceId: "source-a",
          rightVersionId: "version-old",
        };
      },
    ],
    [
      "message citations",
      (conversation) => {
        conversation.messages[1].citations = [citation];
      },
    ],
    [
      "personal note evidence",
      (conversation) => {
        conversation.messages[1].noteEvidence =
          workspace().conversations[0].messages[1].noteEvidence;
      },
    ],
    [
      "attempt primary",
      (conversation) => {
        conversation.messages[1].attempt!.scopeSnapshot.sourceId = "source-a";
      },
    ],
    [
      "attempt selected sources",
      (conversation) => {
        conversation.messages[1].attempt!.scopeSnapshot.sourceIds = ["source-a"];
      },
    ],
    [
      "attempt fixed versions",
      (conversation) => {
        conversation.messages[1].attempt!.scopeSnapshot.sourceVersions = [
          { sourceId: "source-a", versionId: "version-old" },
        ];
      },
    ],
    [
      "attempt comparison left",
      (conversation) => {
        conversation.messages[1].attempt!.scopeSnapshot.comparison = {
          leftSourceId: "source-a",
          leftVersionId: "version-old",
          rightSourceId: "source-b",
          rightVersionId: "version-b",
        };
      },
    ],
    [
      "attempt comparison right",
      (conversation) => {
        conversation.messages[1].attempt!.scopeSnapshot.comparison = {
          leftSourceId: "source-b",
          leftVersionId: "version-b",
          rightSourceId: "source-a",
          rightVersionId: "version-a",
        };
      },
    ],
  ];
  it.each(conversationPaths)(
    "finds a related thread from isolated structured %s and invalidates a retained matching attempt",
    (description, attach) => {
      const data = workspace();
      const conversation = structuredClone(data.conversations[0]);
      conversation.sourceId = undefined;
      conversation.sourceIds = ["source-b"];
      conversation.scope = "sources";
      conversation.messages[1].citations = [unrelatedCitation];
      conversation.messages[1].noteEvidence = [];
      conversation.messages[1].attempt!.scopeSnapshot = {
        scope: "sources",
        spaceId: "inbox",
        sourceIds: ["source-b"],
      };
      data.conversations = [conversation];
      attach(conversation);
      expect(
        previewPermanentSourceDeletionContent(data, "source-a").conversations,
        description,
      ).toEqual([{ id: "conversation-a", title: "历史问题", messages: 2 }]);
      expect(
        permanentlyDeleteSource(data, "source-a", {
          noteIds: [],
          conversationIds: ["conversation-a"],
        }).data.conversations,
      ).toEqual([]);
      if (description.startsWith("attempt"))
        expect(
          permanentlyDeleteSource(data, "source-a").data.conversations[0].messages[1].attempt
            ?.unavailableReason,
        ).toBe("source-purged");
    },
  );

  it("recognizes historical-only manual excerpts and rejects future invalid ID formats or malformed selection objects", () => {
    const data = workspace();
    data.notes[0].citations = [];
    data.notes[0].manualExcerptRefs = [];
    data.notes[0].versions[0].citations = [];
    expect(previewPermanentSourceDeletionContent(data, "source-a").notes).toHaveLength(1);
    const invalid: unknown[] = [
      null,
      {},
      { noteIds: [], conversationIds: [], extra: true },
      { noteIds: "note-a", conversationIds: [] },
      { noteIds: ["note.a"], conversationIds: [] },
      { noteIds: ["x".repeat(101)], conversationIds: [] },
      {
        noteIds: [],
        conversationIds: Array.from({ length: 5001 }, (_, index) => `thread_${index}`),
      },
    ];
    for (const selection of invalid)
      expect(() =>
        previewPermanentSourceDeletionContent(
          data,
          "source-a",
          selection as Parameters<typeof previewPermanentSourceDeletionContent>[2],
        ),
      ).toThrow(/选择/);
  });

  it("allows the entire existing note/conversation capacity without shrinking the valid selection range", () => {
    const data = workspace();
    data.notes = Array.from({ length: 10000 }, (_, index) => ({
      ...data.notes[0],
      id: `note_${index}`,
    }));
    data.conversations = Array.from({ length: 5000 }, (_, index) => ({
      ...data.conversations[0],
      id: `thread_${index}`,
    }));
    const selection = {
      noteIds: data.notes.map((note) => note.id),
      conversationIds: data.conversations.map((conversation) => conversation.id),
    };
    expect(previewPermanentSourceDeletion(data, "source-a", selection)).toMatchObject({
      removedNotes: 10000,
      removedNoteVersions: 20000,
      removedConversations: 5000,
      removedMessages: 10000,
      retainedNotes: 0,
      retainedConversations: 0,
    });
    expect(() =>
      previewPermanentSourceDeletionContent(data, "source-a", {
        ...selection,
        noteIds: [...selection.noteIds, "extra"],
      }),
    ).toThrow(/选择/);
  });

  it("ignores unrelated content changes and canonicalizes choice order while freezing selected endpoint job bodies", () => {
    const data = workspace();
    data.notes.push({
      ...structuredClone(data.notes[0]),
      id: "unrelated-note",
      citations: [],
      manualExcerptRefs: [],
      versions: [],
      content: "unrelated",
    });
    const selection = {
      noteIds: ["note-a"],
      conversationIds: ["comparison-conversation", "conversation-a"],
    };
    const before = permanentSourceDeletionFingerprint(data, "source-a", selection);
    expect(
      permanentSourceDeletionFingerprint(data, "source-a", {
        ...selection,
        conversationIds: [...selection.conversationIds].reverse(),
      }),
    ).toBe(before);
    data.notes[1].content = "changed unrelated";
    expect(permanentSourceDeletionFingerprint(data, "source-a", selection)).toBe(before);
    data.organizationJobs![0].request.topic = "new task body without timestamp change";
    expect(permanentSourceDeletionFingerprint(data, "source-a", selection)).not.toBe(before);
  });

  it("previews explicit related document choices with all retained versions and keeps them by default", () => {
    const data = workspace();
    const before = structuredClone(data);
    expect(previewPermanentSourceDeletionContent(data, "source-a")).toEqual({
      version: 1,
      notes: [{ id: "note-a", title: "独立笔记", kind: "note", versions: 2 }],
      conversations: [
        { id: "conversation-a", title: "历史问题", messages: 2 },
        { id: "comparison-conversation", title: "对照历史问题", messages: 1 },
      ],
      selection: { noteIds: [], conversationIds: [] },
    });
    expect(previewPermanentSourceDeletion(data, "source-a")).toMatchObject({
      removedNotes: 0,
      removedNoteVersions: 0,
      removedConversations: 0,
      removedMessages: 0,
    });
    expect(data).toEqual(before);
  });

  it("deletes only explicitly selected related documents, their complete histories and generated endpoint dependencies", () => {
    const data = workspace();
    const before = structuredClone(data);
    const original = data.notes[0];
    data.notes.push({
      ...structuredClone(original),
      id: "retained-note",
      title: "另存保留",
      content: "KEEP_USER_TEXT",
    });
    const extraJob = structuredClone(data.organizationJobs![0]);
    extraJob.id = "note-only-job";
    extraJob.request = {
      ...extraJob.request,
      requestId: extraJob.id,
      sourceIds: ["source-b"],
      sourceVersions: [{ sourceId: "source-b", versionId: "version-b" }],
      targetNote: { id: "note-a", revision: 0, updatedAt: at },
    };
    data.organizationJobs!.push(extraJob);
    const extraRelation = structuredClone(data.conceptRelations![0]);
    extraRelation.id = "note-only-relation";
    extraRelation.from.id = "note-a";
    extraRelation.fromCitations = [unrelatedCitation];
    data.conceptRelations!.push(extraRelation);
    const preparedInput = structuredClone(data);
    const selection = { noteIds: ["note-a"], conversationIds: ["conversation-a"] };
    const preview = previewPermanentSourceDeletion(data, "source-a", selection);
    expect(preview).toMatchObject({
      removedNotes: 1,
      removedNoteVersions: 2,
      removedConversations: 1,
      removedMessages: 2,
      retainedNotes: 1,
      retainedNoteCitations: 4,
      retainedConversations: 1,
      retainedConversationCitations: 0,
      organizationJobs: 2,
      conceptRelations: 2,
    });
    const result = permanentlyDeleteSource(data, "source-a", selection);
    expect(result.impact).toEqual(preview);
    expect(result.data.notes.map((note) => note.id)).toEqual(["retained-note"]);
    expect(result.data.notes[0].content).toBe("KEEP_USER_TEXT");
    expect(result.data.conversations.map((conversation) => conversation.id)).toEqual([
      "comparison-conversation",
    ]);
    expect(result.data.organizationJobs).toEqual([]);
    expect(result.data.conceptRelations).toEqual([]);
    expect(workspaceSchema.safeParse(result.data).success).toBe(true);
    expect(data).toEqual(preparedInput);
    expect(before.notes[0].versions[0].content).toBe("旧内容");
  });

  it("retains unselected conversation personal-note snapshots even if the selected saved note is removed", () => {
    const data = workspace();
    const frozen = structuredClone(data.conversations[0].messages[1].noteEvidence);
    const result = permanentlyDeleteSource(data, "source-a", {
      noteIds: ["note-a"],
      conversationIds: [],
    });
    expect(result.data.notes).toEqual([]);
    expect(result.data.conversations[0].messages[1].noteEvidence).toEqual(frozen);
    expect(result.data.conversations[0].messages[1].content).toBe("回答");
    expect(result.impact).toMatchObject({
      removedNotes: 1,
      retainedNotes: 0,
      retainedNoteCitations: 0,
      removedConversations: 0,
      retainedConversations: 2,
    });
  });

  it("requires manual endpoint relations to be handled first even without a direct source citation", () => {
    const data = workspace();
    data.conceptRelations![0].from.id = "note-a";
    data.conceptRelations![0].fromCitations = [unrelatedCitation];
    data.conceptRelations![0].origin = "manual";
    const selection = { noteIds: ["note-a"], conversationIds: [] };
    expect(permanentSourceDeletionBlockers(data, "source-a")).toEqual({
      annotations: [],
      conceptRelations: [],
    });
    expect(permanentSourceDeletionBlockers(data, "source-a", selection)).toEqual({
      annotations: [],
      conceptRelations: ["relation-a"],
    });
    expect(() => permanentlyDeleteSource(data, "source-a", selection)).toThrow("批注或手工关系");
    expect(data.notes).toHaveLength(1);
  });

  it.each([
    { noteIds: ["note-a", "note-a"], conversationIds: [] },
    { noteIds: ["unknown"], conversationIds: [] },
    { noteIds: [], conversationIds: ["unknown"] },
    { noteIds: [], conversationIds: ["conversation-a", "conversation-a"] },
    { noteIds: [" "], conversationIds: [] },
    { noteIds: ["x".repeat(201)], conversationIds: [] },
  ])("rejects invalid or stale selection without silently filtering it: %j", (selection) => {
    const data = workspace();
    for (const run of [
      previewPermanentSourceDeletionContent,
      previewPermanentSourceDeletion,
      permanentSourceDeletionBlockers,
      permanentSourceDeletionFingerprint,
      permanentlyDeleteSource,
    ])
      expect(() => run(data, "source-a", selection)).toThrow(/选择|关联|标识/);
    expect(data.sources).toHaveLength(1);
  });

  it("excludes unrelated documents containing source IDs only as user text", () => {
    const data = workspace();
    data.notes.push({
      ...structuredClone(data.notes[0]),
      id: "unrelated-note",
      content: "source-a",
      citations: [],
      manualExcerptRefs: [],
      versions: [],
    });
    data.conversations.push({
      ...structuredClone(data.conversations[0]),
      id: "unrelated-conversation",
      sourceId: undefined,
      sourceIds: [],
      messages: [
        { id: "text-only", role: "user", content: "source-a", citations: [], createdAt: at },
      ],
    });
    const content = previewPermanentSourceDeletionContent(data, "source-a");
    expect(content.notes.map((item) => item.id)).toEqual(["note-a"]);
    expect(content.conversations.map((item) => item.id)).toEqual([
      "conversation-a",
      "comparison-conversation",
    ]);
    expect(() =>
      permanentlyDeleteSource(data, "source-a", {
        noteIds: ["unrelated-note"],
        conversationIds: [],
      }),
    ).toThrow(/关联/);
  });

  it("invalidates reviewed confirmation on related text changes without relying on timestamps or counts", () => {
    const data = workspace();
    const selection = { noteIds: ["note-a"], conversationIds: ["conversation-a"] };
    const before = permanentSourceDeletionFingerprint(data, "source-a", selection);
    data.notes[0].versions[0].content = "changed saved history with same timestamp";
    expect(permanentSourceDeletionFingerprint(data, "source-a", selection)).not.toBe(before);
    const history = permanentSourceDeletionFingerprint(data, "source-a", selection);
    data.conversations[0].messages[1].content = "changed answer with same count and timestamp";
    expect(permanentSourceDeletionFingerprint(data, "source-a", selection)).not.toBe(history);
    const answer = permanentSourceDeletionFingerprint(data, "source-a", selection);
    data.annotations[0].quote = "changed quote";
    expect(permanentSourceDeletionFingerprint(data, "source-a", selection)).not.toBe(answer);
    const quote = permanentSourceDeletionFingerprint(data, "source-a", selection);
    expect(
      permanentSourceDeletionFingerprint(data, "source-a", { noteIds: [], conversationIds: [] }),
    ).not.toBe(quote);
  });

  it("removes traceable system records while retaining user text without deleted-source references", () => {
    const data = workspace();
    const preview = previewPermanentSourceDeletion(data, "source-a");
    const result = permanentlyDeleteSource(data, "source-a");

    expect(preview).toMatchObject({
      versions: 2,
      annotations: 1,
      blockingAnnotations: 0,
      retainedNotes: 1,
      retainedNoteCitations: 4,
      retainedConversations: 2,
      retainedConversationCitations: 2,
      organizationJobs: 1,
      pendingOrganizationJobs: 1,
      conceptRelations: 1,
      blockingConceptRelations: 0,
      importJobs: 1,
      localOriginals: 2,
      cloudOriginals: 2,
    });
    expect(result.blobKeys).toEqual([
      "original:source-a:version-a",
      "original:source-a:version-old",
    ]);
    expect(result.storagePaths).toEqual([
      "owner-a/version-a/source-a.txt",
      "owner-a/version-old/source-a.txt",
    ]);
    expect(result.data.sources).toEqual([]);
    expect(result.data.annotations).toEqual([]);
    expect(result.data.importJobs).toEqual([]);
    expect(result.data.organizationJobs).toEqual([]);
    expect(result.data.conceptRelations).toEqual([]);
    expect(result.data.notes[0].content).toBe("用户写下的内容");
    expect(result.data.notes[0].citations).toEqual([unrelatedCitation]);
    expect(result.data.notes[0].versions[0].citations).toEqual([unrelatedCitation]);
    expect(result.data.notes[0].manualExcerptRefs).toEqual([
      expect.objectContaining({ sourceId: "source-b", selectionFingerprint: "2222222222222222" }),
    ]);
    expect(result.data.notes[0].versions[0].manualExcerptRefs).toEqual([
      expect.objectContaining({ sourceId: "source-b", selectionFingerprint: "4444444444444444" }),
    ]);
    expect(result.data.conversations[0].messages[1].content).toBe("回答");
    expect(result.data.conversations[0].messages[1].citations).toEqual([unrelatedCitation]);
    expect(result.data.conversations[0].messages[1].noteEvidence).toEqual([
      expect.objectContaining({ sourceId: "source-a", sourceVersionId: "version-a" }),
    ]);
    expect(result.data.conversations[0].messages[1].attempt).toEqual({
      id: "answer-attempt",
      questionMessageId: "question",
      scopeSnapshot: {
        scope: "document-notes",
        sourceId: "source-a",
        sourceIds: ["source-a"],
        spaceId: "inbox",
        userContext: ["之前的问题"],
      },
      status: "failed",
      unavailableReason: "source-purged",
    });
    expect(result.data.conversations[0].sourceId).toBeUndefined();
    expect(result.data.conversations[0].sourceIds).toEqual(["source-b"]);
    expect(result.data.conversations[0].scope).toBe("sources");
    const comparison = result.data.conversations.find(
      (conversation) => conversation.id === "comparison-conversation",
    );
    expect(comparison).toMatchObject({
      sourceIds: ["source-a", "source-b"],
      comparison: {
        leftSourceId: "source-a",
        leftVersionId: "version-a",
        rightSourceId: "source-b",
        rightVersionId: "version-b",
      },
      messages: [{ role: "user", content: "差异是什么？" }],
    });
    expect(workspaceSchema.safeParse(result.data).success).toBe(true);
  });

  it("blocks an irreversible action when a user-authored annotation would be lost", () => {
    const data = workspace();
    data.annotations[0].note = "这是我自己的理解";

    expect(previewPermanentSourceDeletion(data, "source-a")).toMatchObject({
      annotations: 0,
      blockingAnnotations: 1,
    });
    expect(permanentSourceDeletionBlockers(data, "source-a")).toEqual({
      annotations: ["annotation-a"],
      conceptRelations: [],
    });
    expect(() => permanentlyDeleteSource(data, "source-a")).toThrow("批注或手工关系");
    expect(data.sources).toHaveLength(1);
  });

  it("blocks manually saved concept relations instead of silently dropping them", () => {
    const data = workspace();
    data.conceptRelations![0].origin = "manual";

    expect(previewPermanentSourceDeletion(data, "source-a")).toMatchObject({
      conceptRelations: 0,
      blockingConceptRelations: 1,
    });
    expect(permanentSourceDeletionBlockers(data, "source-a")).toEqual({
      annotations: [],
      conceptRelations: ["relation-a"],
    });
    expect(() => permanentlyDeleteSource(data, "source-a")).toThrow("批注或手工关系");
  });

  it("requires a recoverable deletion before an irreversible operation", () => {
    const data = workspace();
    data.sources[0].deletedAt = null;
    expect(() => previewPermanentSourceDeletion(data, "source-a")).toThrow("先将资料移入回收站");
  });

  it("changes the confirmation fingerprint when traceable impact changes", () => {
    const data = workspace();
    const before = permanentSourceDeletionFingerprint(data, "source-a");
    data.notes[0].citations.push({ ...citation, chunkId: "chunk-b" });
    expect(permanentSourceDeletionFingerprint(data, "source-a")).not.toBe(before);
  });
});
