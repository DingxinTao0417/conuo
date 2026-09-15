import { describe, expect, it } from "vitest";
import type { ConceptRelation } from "./concept-relation-types";
import {
  deleteLearningSpace,
  learningSpaceDeletionFingerprint,
  previewLearningSpaceDeletion,
  recycleSourcesWithResult,
  renameLearningSpace,
} from "./space-lifecycle";
import { advanceImportJob, createImportJob, startImportJob } from "./import-queue";
import { workspaceSchema } from "./supabase/validation";
import type { Source, WorkspaceData } from "./types";

const now = "2026-09-12T12:00:00.000Z";
const spaceA = {
  id: "space-a",
  name: "待删除空间",
  goal: "",
  color: "#000",
  archived: false,
  createdAt: now,
};
const spaceB = {
  id: "space-b",
  name: "保留空间",
  goal: "",
  color: "#111",
  archived: false,
  createdAt: now,
};

function source(
  id: string,
  spaceIds: string[],
  deletedAt: string | null = null,
  patch: Partial<Source> = {},
): Source {
  return {
    id,
    versionId: `${id}-v1`,
    title: id,
    filename: `${id}.txt`,
    kind: "text" as const,
    mime: "text/plain",
    size: 1,
    hash: "hash",
    spaceIds,
    tags: [],
    status: "ready" as const,
    text: id,
    chunks: [],
    createdAt: now,
    updatedAt: now,
    deletedAt,
    aiAllowed: true,
    starred: false,
    ...patch,
  };
}

function parsingImport(sourceId: string, versionId: string) {
  return advanceImportJob(
    startImportJob(
      createImportJob({
        sourceId,
        versionId,
        filename: `${sourceId}.txt`,
        spaceId: spaceA.id,
        at: now,
      }),
      now,
    ),
    "parsing",
    now,
  );
}

function note(id: string, spaceId: string, deletedAt: string | null = null) {
  return {
    id,
    spaceId,
    title: id,
    content: "内容",
    kind: "note" as const,
    status: "accepted" as const,
    citations: [],
    versions: [],
    createdAt: now,
    updatedAt: now,
    deletedAt,
  };
}

function workspace(): WorkspaceData {
  return {
    schemaVersion: 1,
    spaces: [spaceA, spaceB],
    sources: [
      source("exclusive", [spaceA.id]),
      source("shared", [spaceA.id, spaceB.id]),
      source("deleted-source", [spaceA.id], now),
    ],
    notes: [
      note("note-a", spaceA.id),
      note("note-b", spaceB.id),
      note("deleted-note", spaceA.id, now),
    ],
    annotations: [],
    conversations: [
      {
        id: "conversation-a",
        spaceId: spaceA.id,
        title: "问题",
        scope: "space",
        sourceIds: ["exclusive"],
        messages: [],
        resolved: false,
        updatedAt: now,
      },
      {
        id: "conversation-b",
        spaceId: spaceB.id,
        title: "保留问题",
        scope: "space",
        sourceIds: ["shared"],
        messages: [],
        resolved: false,
        updatedAt: now,
      },
    ],
    aiEnabled: true,
    organizationJobs: [
      {
        id: "job-a",
        request: {
          requestId: "job-a",
          kind: "source",
          trigger: "manual",
          spaceId: spaceA.id,
          sourceIds: ["exclusive"],
          sourceVersions: [{ sourceId: "exclusive", versionId: "exclusive-v1" }],
        },
        status: "running",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "job-b",
        request: {
          requestId: "job-b",
          kind: "source",
          trigger: "manual",
          spaceId: spaceB.id,
          sourceIds: ["shared"],
          sourceVersions: [{ sourceId: "shared", versionId: "shared-v1" }],
        },
        status: "ready",
        createdAt: now,
        updatedAt: now,
      },
    ],
    conceptRelations: [
      { id: "relation-a", spaceId: spaceA.id } as ConceptRelation,
      { id: "relation-b", spaceId: spaceB.id } as ConceptRelation,
    ],
  };
}

describe("learning-space deletion", () => {
  it("reports exact per-source results when a bulk recycle selection has changed", () => {
    const before = workspace();
    const original = before.sources.find((item) => item.id === "exclusive")!;
    original.blobKey = "local:exclusive-original";
    const result = recycleSourcesWithResult(
      before,
      ["exclusive", "deleted-source", "missing", "exclusive"],
      now,
    );

    expect(result.recycledSourceIds).toEqual(["exclusive"]);
    expect(result.skipped).toEqual([
      { sourceId: "deleted-source", reason: "already-recycled" },
      { sourceId: "missing", reason: "missing" },
    ]);
    expect(result.data.sources.find((item) => item.id === "exclusive")).toMatchObject({
      deletedAt: now,
      updatedAt: now,
    });
    expect(result.data.sources.find((item) => item.id === "exclusive")?.blobKey).toBe(
      "local:exclusive-original",
    );
    expect(original.deletedAt).toBeNull();
  });

  it("keeps an empty recycle selection as a no-op", () => {
    const before = workspace();
    expect(recycleSourcesWithResult(before, [], now)).toEqual({
      data: before,
      recycledSourceIds: [],
      skipped: [],
    });
  });

  it("renames only a named space and preserves the workspace for blank or missing targets", () => {
    const before = workspace();

    const renamed = renameLearningSpace(before, spaceA.id, "新的空间名称");
    expect(renamed).not.toBe(before);
    expect(renamed.spaces).toEqual([{ ...spaceA, name: "新的空间名称" }, spaceB]);
    expect(before.spaces[0]?.name).toBe(spaceA.name);
    expect(renameLearningSpace(before, spaceA.id, "   ")).toBe(before);
    expect(renameLearningSpace(before, "missing", "不会写入")).toBe(before);
  });

  it("previews the exact live and derived records that will be affected", () => {
    const impact = previewLearningSpaceDeletion(workspace(), spaceA.id);
    expect(impact).toMatchObject({
      space: spaceA,
      sharedSources: 1,
      exclusiveSources: 1,
      recycleBinSources: 1,
      notes: 1,
      recycleBinNotes: 1,
      conversations: 1,
      organizationJobs: 1,
      pendingOrganizationJobs: 1,
      conceptRelations: 1,
    });
  });

  it("retains library material by default and removes only the space-scoped state", () => {
    const before = workspace();
    const after = deleteLearningSpace(before, spaceA.id, { now });

    expect(after.spaces.map((space) => space.id)).toEqual([spaceB.id]);
    expect(after.sources.find((item) => item.id === "exclusive")).toMatchObject({
      spaceIds: [],
      deletedAt: null,
    });
    expect(after.sources.find((item) => item.id === "shared")?.spaceIds).toEqual([spaceB.id]);
    expect(after.sources.find((item) => item.id === "deleted-source")?.spaceIds).toEqual([]);
    expect(after.notes.find((item) => item.id === "note-a")).toMatchObject({
      spaceId: "inbox",
      contentRevision: 1,
    });
    expect(after.notes.find((item) => item.id === "note-a")?.versions).toHaveLength(1);
    expect(after.notes.find((item) => item.id === "deleted-note")?.spaceId).toBe("inbox");
    expect(after.conversations.find((item) => item.id === "conversation-a")?.spaceId).toBe("inbox");
    expect(after.organizationJobs?.map((job) => job.id)).toEqual(["job-b"]);
    expect(after.conceptRelations?.map((relation) => relation.id)).toEqual(["relation-b"]);
    expect(before.spaces).toHaveLength(2);
  });

  it("can move exclusively assigned sources to the recoverable recycle bin", () => {
    const after = deleteLearningSpace(workspace(), spaceA.id, {
      recycleExclusiveSources: true,
      now,
    });
    expect(after.sources.find((item) => item.id === "exclusive")).toMatchObject({
      spaceIds: [],
      deletedAt: now,
      updatedAt: now,
    });
    expect(after.sources.find((item) => item.id === "shared")).toMatchObject({
      spaceIds: [spaceB.id],
      deletedAt: null,
    });
  });

  it("cancels only recycled sources' parsing jobs while preserving their original handles", () => {
    const before = workspace();
    const exclusive = before.sources.find((item) => item.id === "exclusive")!;
    const shared = before.sources.find((item) => item.id === "shared")!;
    Object.assign(exclusive, {
      status: "parsing" as const,
      text: "尚未完成的专属资料",
      blobKey: "local:exclusive-current",
      storagePath: "account/originals/exclusive/current",
      versions: [
        {
          versionId: "exclusive-old",
          title: "exclusive 旧版",
          filename: "exclusive-old.txt",
          kind: "text" as const,
          mime: "text/plain",
          size: 1,
          hash: "exclusive-old-hash",
          status: "saved" as const,
          text: "",
          chunks: [],
          blobKey: "local:exclusive-old",
          storagePath: "account/originals/exclusive/old",
          createdAt: now,
          archivedAt: now,
        },
      ],
    });
    Object.assign(shared, { status: "parsing" as const, text: "仍属于保留空间的资料" });
    const exclusiveJob = parsingImport(exclusive.id, exclusive.versionId);
    const sharedJob = parsingImport(shared.id, shared.versionId);
    before.importJobs = [exclusiveJob, sharedJob];

    const after = deleteLearningSpace(before, spaceA.id, {
      recycleExclusiveSources: true,
      now,
    });

    expect(after.importJobs?.find((job) => job.id === exclusiveJob.id)).toMatchObject({
      status: "cancelled",
      originalSaved: true,
      sourceId: exclusive.id,
      versionId: exclusive.versionId,
    });
    expect(after.importJobs?.find((job) => job.id === sharedJob.id)?.status).toBe("running");
    expect(after.sources.find((item) => item.id === exclusive.id)).toMatchObject({
      deletedAt: now,
      status: "saved",
      text: "",
      chunks: [],
      blobKey: "local:exclusive-current",
      storagePath: "account/originals/exclusive/current",
      versions: exclusive.versions,
    });
    expect(after.sources.find((item) => item.id === shared.id)).toMatchObject({
      spaceIds: [spaceB.id],
      deletedAt: null,
      status: "parsing",
      text: "仍属于保留空间的资料",
    });
    expect(before.importJobs[0].status).toBe("running");
    expect(before.sources.find((item) => item.id === exclusive.id)?.status).toBe("parsing");
  });

  it("keeps a retained-inbox result valid for the cloud workspace contract", () => {
    const {
      organizationJobs: unusedJobs,
      conceptRelations: unusedRelations,
      ...withoutDerived
    } = workspace();
    void unusedJobs;
    void unusedRelations;
    const after = deleteLearningSpace(withoutDerived, spaceA.id, { now });
    expect(workspaceSchema.safeParse(after).success).toBe(true);
  });

  it("refuses to modify an already missing space", () => {
    expect(() => previewLearningSpaceDeletion(workspace(), "missing")).toThrow("已不存在");
    expect(() => deleteLearningSpace(workspace(), "missing")).toThrow("已不存在");
  });

  it("requires a fresh confirmation when affected membership changes", () => {
    const before = workspace();
    const fingerprint = learningSpaceDeletionFingerprint(before, spaceA.id);
    const after = {
      ...before,
      sources: [...before.sources, source("new-exclusive", [spaceA.id])],
    };
    expect(learningSpaceDeletionFingerprint(after, spaceA.id)).not.toBe(fingerprint);
  });
});
