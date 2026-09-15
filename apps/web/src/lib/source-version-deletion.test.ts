import { describe, expect, it } from "vitest";
import type { ConceptRelation } from "./concept-relation-types";
import type { OrganizationJob } from "./organization-types";
import {
  archivedSourceVersionDeletionBlockers,
  deleteArchivedSourceVersion,
  previewArchivedSourceVersionDeletion,
} from "./source-version-deletion";
import { createEmptyWorkspace } from "./seed";
import { workspaceSchema } from "./supabase/validation";
import type { Citation, Source, WorkspaceData } from "./types";

const at = "2026-09-14T00:00:00.000Z";
const historicalCitation: Citation = {
  sourceId: "source-a",
  versionId: "version-old",
  chunkId: "old-chunk",
  title: "学习资料",
  quote: "旧版本中的证据",
  section: "正文",
};

function source(): Source {
  return {
    id: "source-a",
    versionId: "version-current",
    title: "学习资料",
    filename: "current.txt",
    kind: "text",
    mime: "text/plain",
    size: 12,
    hash: "a".repeat(64),
    spaceIds: [],
    tags: [],
    status: "ready",
    text: "当前版本正文",
    chunks: [
      {
        id: "current-chunk",
        sourceId: "source-a",
        versionId: "version-current",
        text: "当前版本正文",
        section: "正文",
        order: 0,
      },
    ],
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    aiAllowed: true,
    starred: false,
    versions: [
      {
        versionId: "version-old",
        title: "学习资料",
        filename: "old.txt",
        kind: "text",
        mime: "text/plain",
        size: 10,
        hash: "b".repeat(64),
        status: "ready",
        text: "旧版本中的证据",
        chunks: [
          {
            id: "old-chunk",
            sourceId: "source-a",
            versionId: "version-old",
            text: "旧版本中的证据",
            section: "正文",
            order: 0,
          },
        ],
        createdAt: at,
        archivedAt: at,
        blobKey: "original:source-a:version-old",
        storagePath: "owner-a/version-old/old.txt",
      },
    ],
  };
}

function workspace(): WorkspaceData {
  const data = createEmptyWorkspace();
  data.sources = [source()];
  data.annotations = [
    {
      id: "highlight-old",
      sourceId: "source-a",
      versionId: "version-old",
      quote: historicalCitation.quote,
      note: "",
      createdAt: at,
    },
  ];
  data.notes = [
    {
      id: "note-a",
      spaceId: "inbox",
      title: "我的笔记",
      content: "保留个人结论",
      kind: "note",
      status: "accepted",
      citations: [historicalCitation],
      versions: [],
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    },
  ];
  data.conversations = [
    {
      id: "conversation-a",
      spaceId: "inbox",
      title: "历史问答",
      scope: "sources",
      sourceIds: ["source-a"],
      resolved: false,
      updatedAt: at,
      messages: [
        {
          id: "answer-a",
          role: "assistant",
          content: "历史回答",
          citations: [historicalCitation],
          createdAt: at,
        },
      ],
    },
  ];
  data.importJobs = [
    {
      id: "import-old",
      sourceId: "source-a",
      versionId: "version-old",
      filename: "old.txt",
      spaceId: "",
      status: "completed",
      stage: "indexing",
      originalSaved: true,
      attempt: 1,
      createdAt: at,
      updatedAt: at,
    },
  ];
  data.organizationJobs = [
    {
      id: "organization-old",
      request: {
        requestId: "organization-old",
        kind: "source",
        trigger: "manual",
        spaceId: "inbox",
        sourceIds: ["source-a"],
        sourceVersions: [{ sourceId: "source-a", versionId: "version-old" }],
      },
      status: "ready",
      createdAt: at,
      updatedAt: at,
    } satisfies OrganizationJob,
  ];
  data.conceptRelations = [
    {
      id: "relation-old",
      spaceId: "inbox",
      type: "related",
      fromClaim: "A",
      toClaim: "B",
      fromCondition: "",
      toCondition: "",
      explanation: "关联",
      fromCitations: [historicalCitation],
      toCitations: [],
      from: {
        id: "knowledge-a",
        spaceId: "inbox",
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
        spaceId: "inbox",
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

describe("archived source version deletion", () => {
  it("removes only replaceable derived records while keeping authored citation history", () => {
    const data = workspace();
    const preview = previewArchivedSourceVersionDeletion(data, "source-a", "version-old");
    expect(preview).toMatchObject({
      annotations: 1,
      retainedNotes: 1,
      retainedNoteCitations: 1,
      retainedConversations: 1,
      retainedConversationCitations: 1,
      organizationJobs: 1,
      conceptRelations: 1,
      importJobs: 1,
      localOriginals: 1,
      cloudOriginals: 1,
    });

    const result = deleteArchivedSourceVersion(data, "source-a", "version-old");

    expect(result.data.sources[0].versions).toEqual([]);
    expect(result.data.annotations).toEqual([]);
    expect(result.data.importJobs).toEqual([]);
    expect(result.data.organizationJobs).toEqual([]);
    expect(result.data.conceptRelations).toEqual([]);
    expect(result.data.notes[0].citations).toEqual([historicalCitation]);
    expect(result.data.conversations[0].messages[0].citations).toEqual([historicalCitation]);
    expect(result.blobKeys).toEqual(["original:source-a:version-old"]);
    expect(result.storagePaths).toEqual(["owner-a/version-old/old.txt"]);
    expect(workspaceSchema.safeParse(result.data).success).toBe(true);
  });

  it("fails closed when saved content or in-flight work still references the version", () => {
    const data = workspace();
    data.annotations[0].note = "先另存这条笔记";
    data.organizationJobs![0].status = "running";
    data.importJobs![0].status = "queued";
    data.conceptRelations![0].origin = "manual";
    const before = structuredClone(data);

    expect(archivedSourceVersionDeletionBlockers(data, "source-a", "version-old")).toEqual({
      annotations: ["highlight-old"],
      conceptRelations: ["relation-old"],
      organizationJobs: ["organization-old"],
      importJobs: ["import-old"],
    });
    expect(() => deleteArchivedSourceVersion(data, "source-a", "version-old")).toThrow(
      /已保存内容|进行中的任务/,
    );
    expect(data).toEqual(before);
  });

  it.each(["version-current", "missing-version"])("rejects unavailable version %s", (versionId) => {
    const data = workspace();
    const before = structuredClone(data);
    expect(() => previewArchivedSourceVersionDeletion(data, "source-a", versionId)).toThrow();
    expect(data).toEqual(before);
  });
});
