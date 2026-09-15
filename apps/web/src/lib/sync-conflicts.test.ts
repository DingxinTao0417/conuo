import { describe, expect, it } from "vitest";
import {
  MAX_NOTE_CONFLICT_VERSIONS,
  applyReadingProgressSyncResolution,
  applySafeNoteSyncChanges,
  applyNoteSyncResolution,
  mergeReadingProgressConflict,
  planReadingProgressSyncConflicts,
  planNoteSyncConflicts,
  rebaseIndependentWorkspaceChanges,
  resolveNoteSyncConflict,
  type SafeNoteSyncChange,
} from "./sync-conflicts";
import type { Annotation, Note, NoteVersion, Source, WorkspaceData } from "./types";
import { workspaceSchema } from "./supabase/validation";
import { resolveRecoverableSourceAnnotationDraft } from "./recoverable-drafts";
import {
  discardRecoverableDraft,
  restoreSourceAndResolveDrafts,
  restoreSourceFromRecoverableDraft,
  saveRecoverableDraftAsNote,
} from "./recoverable-draft-actions";

const createdAt = "2026-09-13T08:00:00.000Z";
const resolvedAt = "2026-09-13T09:00:00.000Z";

function manualExcerptRef(selectionFingerprint = "1111111111111111") {
  return {
    sourceId: "source-a",
    versionId: "version-a",
    chunkId: "chunk-a",
    selectionFingerprint,
  };
}

function note(id: string, content: string, patch: Partial<Note> = {}): Note {
  return {
    id,
    spaceId: "space-a",
    title: `${id} title`,
    content,
    kind: "note",
    status: "accepted",
    citations: [],
    versions: [],
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    contentRevision: 0,
    ...patch,
  };
}

function version(id: string): NoteVersion {
  return {
    id,
    title: `old ${id}`,
    content: `old content ${id}`,
    savedAt: createdAt,
  };
}

function workspace(notes: Note[]): WorkspaceData {
  return {
    schemaVersion: 1,
    spaces: [],
    sources: [],
    notes,
    annotations: [],
    conversations: [],
    aiEnabled: true,
  };
}

function source(id: string, patch: Partial<Source> = {}): Source {
  return {
    id,
    versionId: `${id}-version`,
    title: `${id} title`,
    filename: `${id}.txt`,
    kind: "text",
    mime: "text/plain",
    size: 12,
    hash: `${id}-hash`,
    spaceIds: ["space-a"],
    tags: [],
    status: "ready",
    text: `${id} body`,
    chunks: [],
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    aiAllowed: true,
    starred: false,
    ...patch,
  };
}

function workspaceWithSources(sources: Source[]): WorkspaceData {
  return { ...workspace([]), sources };
}

describe("reading progress conflict plans", () => {
  it("keeps all three fields as atomic local and remote candidates without ordering by time", () => {
    const base = workspaceWithSources([
      source("source-a", {
        readPage: 1,
        readOffset: 10,
        lastReadAt: "2026-09-13T08:00:00.000Z",
      }),
      source("source-b", { readPage: 1, readOffset: 20 }),
    ]);
    const local = structuredClone(base);
    local.sources[0] = {
      ...local.sources[0],
      readPage: 9,
      readOffset: 90,
      lastReadAt: "2026-09-13T20:00:00.000Z",
    };
    local.sources[1] = {
      ...local.sources[1],
      readPage: 4,
      readOffset: 40,
      lastReadAt: "2026-09-13T07:00:00.000Z",
    };
    const remote = structuredClone(base);
    remote.sources[0] = {
      ...remote.sources[0],
      readPage: 3,
      readOffset: 300,
      lastReadAt: "2026-09-13T10:00:00.000Z",
    };

    const plan = planReadingProgressSyncConflicts(local, remote, base);

    expect(plan).toEqual({
      baseKnown: true,
      conflicts: [
        {
          id: "reading-progress-conflict:source-a",
          sourceId: "source-a",
          sourceTitle: "source-a title",
          sourceKind: "text",
          base: {
            readPage: 1,
            readOffset: 10,
            lastReadAt: "2026-09-13T08:00:00.000Z",
          },
          local: {
            readPage: 9,
            readOffset: 90,
            lastReadAt: "2026-09-13T20:00:00.000Z",
          },
          remote: {
            readPage: 3,
            readOffset: 300,
            lastReadAt: "2026-09-13T10:00:00.000Z",
          },
        },
      ],
      safeLocal: [
        {
          sourceId: "source-b",
          local: {
            readPage: 4,
            readOffset: 40,
            lastReadAt: "2026-09-13T07:00:00.000Z",
          },
          remote: { readPage: 1, readOffset: 20 },
        },
      ],
    });
    plan!.conflicts[0]!.local.readPage = 99;
    expect(local.sources[0].readPage).toBe(9);
  });

  it("requires an exact common base and rejects non-reading differences", () => {
    const base = workspaceWithSources([source("source-a", { readPage: 1 })]);
    const local = structuredClone(base);
    local.sources[0] = { ...local.sources[0], readPage: 2 };
    const remote = structuredClone(base);
    remote.sources[0] = { ...remote.sources[0], readPage: 3 };
    const changedTitle = structuredClone(remote);
    changedTitle.sources[0] = { ...changedTitle.sources[0], title: "changed remotely" };

    expect(planReadingProgressSyncConflicts(local, remote, null)).toBeNull();
    expect(planReadingProgressSyncConflicts(local, changedTitle, base)).toBeNull();

    const duplicateBase = workspaceWithSources([
      source("source-a", { readPage: 1 }),
      source("source-a", { readPage: 1 }),
    ]);
    const duplicateLocal = workspaceWithSources([
      source("source-a", { readPage: 2 }),
      source("source-a", { readPage: 2 }),
    ]);
    const duplicateRemote = workspaceWithSources([
      source("source-a", { readPage: 3 }),
      source("source-a", { readPage: 3 }),
    ]);
    expect(() =>
      planReadingProgressSyncConflicts(duplicateLocal, duplicateRemote, duplicateBase),
    ).toThrow(/标识重复/);
  });

  it("applies explicit choices and local-only changes without mixing snapshot fields", () => {
    const base = workspaceWithSources([
      source("source-a", { readPage: 1, readOffset: 10 }),
      source("source-b", { readPage: 1, readOffset: 20 }),
      source("source-c", { readPage: 1, readOffset: 30 }),
    ]);
    const local = structuredClone(base);
    local.sources[0] = {
      ...local.sources[0],
      readOffset: 90,
      lastReadAt: "2026-09-13T12:00:00.000Z",
    };
    delete local.sources[0].readPage;
    local.sources[1] = {
      ...local.sources[1],
      readPage: 7,
      readOffset: 70,
      lastReadAt: "2026-09-13T13:00:00.000Z",
    };
    local.sources[2] = {
      ...local.sources[2],
      readPage: 8,
      readOffset: 80,
      lastReadAt: "2026-09-13T14:00:00.000Z",
    };
    const remote = structuredClone(base);
    remote.sources[0] = {
      ...remote.sources[0],
      readPage: 3,
      readOffset: 300,
      lastReadAt: "2026-09-13T10:00:00.000Z",
    };
    remote.sources[1] = {
      ...remote.sources[1],
      readPage: 4,
      readOffset: 40,
      lastReadAt: "2026-09-13T11:00:00.000Z",
    };
    const plan = planReadingProgressSyncConflicts(local, remote, base)!;

    const resolved = applyReadingProgressSyncResolution(remote, plan, [
      { conflictId: "reading-progress-conflict:source-a", choice: "local" },
      { conflictId: "reading-progress-conflict:source-b", choice: "remote" },
    ]);

    expect(
      resolved.sources.map(({ readPage, readOffset, lastReadAt }) => ({
        readPage,
        readOffset,
        lastReadAt,
      })),
    ).toEqual([
      { readPage: undefined, readOffset: 90, lastReadAt: "2026-09-13T12:00:00.000Z" },
      { readPage: 4, readOffset: 40, lastReadAt: "2026-09-13T11:00:00.000Z" },
      { readPage: 8, readOffset: 80, lastReadAt: "2026-09-13T14:00:00.000Z" },
    ]);
    expect(remote.sources[0]).toMatchObject({ readPage: 3, readOffset: 300 });
  });

  it("retains both sides across a second CAS conflict and a strict schema round trip", () => {
    const base = workspaceWithSources([source("source-a", { readPage: 1, readOffset: 10 })]);
    const firstLocal = structuredClone(base);
    firstLocal.sources[0] = {
      ...firstLocal.sources[0],
      readPage: 9,
      readOffset: 900,
      lastReadAt: "2026-09-13T11:00:00.000Z",
    };
    const firstRemote = structuredClone(base);
    firstRemote.sources[0] = {
      ...firstRemote.sources[0],
      readPage: 4,
      readOffset: 400,
      lastReadAt: "2026-09-13T10:00:00.000Z",
    };
    const firstPlan = planReadingProgressSyncConflicts(firstLocal, firstRemote, base)!;
    const locallyResolved = applyReadingProgressSyncResolution(firstRemote, firstPlan, [
      { conflictId: "reading-progress-conflict:source-a", choice: "local" },
    ]);
    expect(locallyResolved.sources[0]).toMatchObject({
      readPage: 9,
      readOffset: 900,
      readingPositionAlternatives: [
        {
          origin: "remote",
          readPage: 4,
          readOffset: 400,
          lastReadAt: "2026-09-13T10:00:00.000Z",
        },
      ],
    });

    const newerRemote = structuredClone(firstRemote);
    newerRemote.sources[0] = {
      ...newerRemote.sources[0],
      readPage: 6,
      readOffset: 600,
      lastReadAt: "2026-09-13T12:00:00.000Z",
    };
    const retryPlan = planReadingProgressSyncConflicts(locallyResolved, newerRemote, firstRemote)!;
    expect(retryPlan.conflicts[0]?.localAlternatives).toEqual([
      {
        origin: "remote",
        readPage: 4,
        readOffset: 400,
        lastReadAt: "2026-09-13T10:00:00.000Z",
      },
    ]);

    const resolved = applyReadingProgressSyncResolution(newerRemote, retryPlan, [
      { conflictId: "reading-progress-conflict:source-a", choice: "remote" },
    ]);
    const roundTrip = workspaceSchema.parse(JSON.parse(JSON.stringify(resolved)));
    expect(roundTrip.sources[0]).toMatchObject({
      readPage: 6,
      readOffset: 600,
      lastReadAt: "2026-09-13T12:00:00.000Z",
      readingPositionAlternatives: [
        {
          origin: "local",
          readPage: 9,
          readOffset: 900,
          lastReadAt: "2026-09-13T11:00:00.000Z",
        },
        {
          origin: "remote",
          readPage: 4,
          readOffset: 400,
          lastReadAt: "2026-09-13T10:00:00.000Z",
        },
      ],
    });
  });

  it("deduplicates candidate snapshots, removes the active position, and caps history at eight", () => {
    const base = workspaceWithSources([source("source-a", { readPage: 1 })]);
    const local = structuredClone(base);
    local.sources[0] = {
      ...local.sources[0],
      readPage: 9,
      readingPositionAlternatives: [
        { origin: "previous", readPage: 9 },
        ...Array.from({ length: 7 }, (_, index) => ({
          origin: "previous" as const,
          readPage: index + 10,
        })),
      ],
    };
    const remote = structuredClone(base);
    remote.sources[0] = {
      ...remote.sources[0],
      readPage: 4,
      readingPositionAlternatives: [
        { origin: "previous", readPage: 10 },
        { origin: "previous", readPage: 4 },
      ],
    };
    const plan = planReadingProgressSyncConflicts(local, remote, base)!;

    const resolved = applyReadingProgressSyncResolution(remote, plan, [
      { conflictId: "reading-progress-conflict:source-a", choice: "local" },
    ]);

    expect(resolved.sources[0].readingPositionAlternatives).toHaveLength(8);
    expect(resolved.sources[0].readingPositionAlternatives?.[0]).toEqual({
      origin: "remote",
      readPage: 4,
    });
    expect(resolved.sources[0].readingPositionAlternatives).not.toContainEqual(
      expect.objectContaining({ readPage: 9 }),
    );
    expect(
      new Set(
        resolved.sources[0].readingPositionAlternatives?.map(
          ({ readPage, readOffset, lastReadAt }) =>
            JSON.stringify([readPage, readOffset, lastReadAt]),
        ),
      ).size,
    ).toBe(8);
  });

  it("rejects duplicate, unknown, and missing selections and a stale remote candidate", () => {
    const base = workspaceWithSources([source("source-a", { readPage: 1 })]);
    const local = workspaceWithSources([source("source-a", { readPage: 2 })]);
    const remote = workspaceWithSources([source("source-a", { readPage: 3 })]);
    const plan = planReadingProgressSyncConflicts(local, remote, base)!;
    const localChoice = {
      conflictId: "reading-progress-conflict:source-a",
      choice: "local" as const,
    };

    expect(() =>
      applyReadingProgressSyncResolution(remote, plan, [localChoice, localChoice]),
    ).toThrow(/只能选择一次/);
    expect(() =>
      applyReadingProgressSyncResolution(remote, plan, [
        { conflictId: "reading-progress-conflict:unknown", choice: "remote" },
      ]),
    ).toThrow(/列表已改变/);
    expect(() => applyReadingProgressSyncResolution(remote, plan, [])).toThrow(/请先选择/);
    const newerRemote = structuredClone(remote);
    newerRemote.sources[0] = { ...newerRemote.sources[0], readPage: 4 };
    expect(() => applyReadingProgressSyncResolution(newerRemote, plan, [localChoice])).toThrow(
      /云端阅读位置已改变/,
    );
  });

  it("rejects a complete resolution that exceeds the workspace limit", () => {
    const base = workspaceWithSources([source("source-a", { readPage: 1 })]);
    const local = workspaceWithSources([source("source-a", { readPage: 2 })]);
    const remote = workspaceWithSources([source("source-a", { readPage: 3 })]);
    const plan = planReadingProgressSyncConflicts(local, remote, base)!;

    expect(() =>
      applyReadingProgressSyncResolution(
        remote,
        plan,
        [{ conflictId: "reading-progress-conflict:source-a", choice: "remote" }],
        1,
      ),
    ).toThrow(/3 MiB/);
  });
});

describe("mergeReadingProgressConflict", () => {
  it("combines independent one-sided progress changes using the common base", () => {
    const base = workspaceWithSources([
      source("source-a", { readPage: 1, readOffset: 10 }),
      source("source-b", { readPage: 2, readOffset: 20 }),
    ]);
    const local = structuredClone(base);
    local.sources[0] = {
      ...local.sources[0],
      readPage: 4,
      readOffset: 40,
      lastReadAt: "2026-09-13T09:00:00.000Z",
    };
    const remote = structuredClone(base);
    remote.sources[1] = {
      ...remote.sources[1],
      readPage: 7,
      readOffset: 70,
      lastReadAt: "2026-09-13T10:00:00.000Z",
    };

    const merged = mergeReadingProgressConflict(local, remote, base);

    expect(
      merged?.sources.map(({ readPage, readOffset, lastReadAt }) => ({
        readPage,
        readOffset,
        lastReadAt,
      })),
    ).toEqual([
      { readPage: 4, readOffset: 40, lastReadAt: "2026-09-13T09:00:00.000Z" },
      { readPage: 7, readOffset: 70, lastReadAt: "2026-09-13T10:00:00.000Z" },
    ]);
  });

  it("does not use device timestamps to choose between two changed positions", () => {
    const base = workspaceWithSources([
      source("source-a", {
        readPage: 1,
        readOffset: 10,
        lastReadAt: "2026-09-13T08:00:00.000Z",
      }),
    ]);
    const local = workspaceWithSources([
      source("source-a", {
        readPage: 9,
        readOffset: 90,
        lastReadAt: "2026-09-13T11:00:00.000Z",
      }),
    ]);
    const remote = workspaceWithSources([
      source("source-a", {
        readPage: 3,
        readOffset: 300,
        lastReadAt: "2026-09-13T10:00:00.000Z",
      }),
    ]);

    expect(mergeReadingProgressConflict(local, remote, base)).toBeNull();
  });

  it("rejects substantive differences and leaves both inputs unchanged", () => {
    const local = workspaceWithSources([
      source("source-a", {
        readPage: 2,
        lastReadAt: "2026-09-13T09:00:00.000Z",
      }),
    ]);
    const remote = workspaceWithSources([
      source("source-a", {
        title: "remote title edit",
        readPage: 3,
        lastReadAt: "2026-09-13T10:00:00.000Z",
      }),
    ]);
    const localBefore = structuredClone(local);
    const remoteBefore = structuredClone(remote);

    expect(mergeReadingProgressConflict(local, remote)).toBeNull();
    expect(local).toEqual(localBefore);
    expect(remote).toEqual(remoteBefore);
  });

  it("does not guess when differing progress lacks an ordering signal", () => {
    const local = workspaceWithSources([source("source-a", { readPage: 2 })]);
    const remote = workspaceWithSources([source("source-a", { readPage: 3 })]);
    const tiedRemote = workspaceWithSources([
      source("source-a", {
        readPage: 3,
        lastReadAt: "2026-09-13T10:00:00.000Z",
      }),
    ]);
    const tiedLocal = workspaceWithSources([
      source("source-a", {
        readPage: 2,
        lastReadAt: "2026-09-13T10:00:00.000Z",
      }),
    ]);

    expect(mergeReadingProgressConflict(local, remote)).toBeNull();
    expect(mergeReadingProgressConflict(tiedLocal, tiedRemote)).toBeNull();
  });

  it("refuses an automatic merge that would exceed the workspace limit", () => {
    const base = workspaceWithSources([source("source-a")]);
    const local = workspaceWithSources([
      source("source-a", {
        readPage: 2,
        lastReadAt: "2026-09-13T11:00:00.000Z",
      }),
    ]);
    const remote = structuredClone(base);

    expect(mergeReadingProgressConflict(local, remote, base, 1)).toBeNull();
  });
});

function annotation(id: string, patch: Partial<Annotation> = {}): Annotation {
  return {
    id,
    sourceId: "source-a",
    versionId: "source-a-version",
    quote: `${id} quote`,
    note: `${id} note`,
    createdAt,
    ...patch,
  };
}

describe("rebaseIndependentWorkspaceChanges", () => {
  it("does not rebase an anchored annotation onto changed raw text under the same version ID", () => {
    const base = {
      ...workspaceWithSources([source("source-a", { text: "目标\n目标" })]),
      annotations: [annotation("anchored", { quote: "目标", textAnchor: { start: 3, end: 5 } })],
    };
    const local = structuredClone(base);
    local.annotations[0].note = "对第二处的离线理解";
    const remote = structuredClone(base);
    remote.sources[0].text = "目标\n变化";
    expect(rebaseIndependentWorkspaceChanges(local, remote, base)).toBeNull();
  });

  it("preserves the exact second-occurrence anchor in an offline-edit deletion recovery draft", () => {
    const deletedAt = "2026-09-13T10:00:00.000Z";
    const base = {
      ...workspaceWithSources([source("source-a", { text: "😀目标\n目标" })]),
      annotations: [annotation("anchored", { quote: "目标", textAnchor: { start: 5, end: 7 } })],
    };
    const local = structuredClone(base);
    local.annotations[0].note = "第二处离线新增的理解";
    const remote = structuredClone(base);
    remote.sources[0] = { ...remote.sources[0], deletedAt, updatedAt: deletedAt };
    const merged = rebaseIndependentWorkspaceChanges(local, remote, base);
    expect(merged?.sources[0].deletedAt).toBe(deletedAt);
    expect(merged?.annotations[0]).toEqual(local.annotations[0]);
    expect(merged?.recoverableDrafts?.[0]).toMatchObject({
      annotationId: "anchored",
      sourceVersionId: base.sources[0].versionId,
      quote: "目标",
      note: "第二处离线新增的理解",
      textAnchor: { start: 5, end: 7 },
    });
    expect(workspaceSchema.safeParse(merged).success).toBe(true);
  });

  it("preserves anchored offline note edits but rejects moving or removing the reviewed anchor", () => {
    const base = {
      ...workspaceWithSources([source("source-a", { text: "目标\n目标" })]),
      annotations: [annotation("anchored", { quote: "目标", textAnchor: { start: 3, end: 5 } })],
    };
    const local = structuredClone(base);
    local.annotations[0].note = "对第二处的离线理解";
    const merged = rebaseIndependentWorkspaceChanges(local, structuredClone(base), base);
    expect(merged?.annotations[0]).toEqual(local.annotations[0]);
    const moved = structuredClone(local);
    moved.annotations[0].textAnchor = { start: 0, end: 2 };
    expect(rebaseIndependentWorkspaceChanges(moved, base, base)).toBeNull();
    const removed = structuredClone(local);
    delete removed.annotations[0].textAnchor;
    expect(rebaseIndependentWorkspaceChanges(removed, base, base)).toBeNull();
  });

  it("keeps a remote soft deletion while retaining a recoverable local source edit", () => {
    const deletedAt = "2026-09-13T10:00:00.000Z";
    const base = workspaceWithSources([source("source-a")]);
    const local = structuredClone(base);
    local.sources[0] = {
      ...local.sources[0],
      versionId: "source-a-version-2",
      title: "local replacement",
      text: "recoverable local body",
      hash: "local-replacement-hash",
      updatedAt: "2026-09-13T09:30:00.000Z",
    };
    const remote = structuredClone(base);
    remote.sources[0] = { ...remote.sources[0], deletedAt, updatedAt: deletedAt };

    const merged = rebaseIndependentWorkspaceChanges(local, remote, base);

    expect(merged?.sources[0]).toMatchObject({
      versionId: "source-a-version-2",
      title: "local replacement",
      text: "recoverable local body",
      hash: "local-replacement-hash",
      deletedAt,
      updatedAt: deletedAt,
    });
    expect(local.sources[0].deletedAt).toBeNull();
    expect(remote.sources[0].title).toBe("source-a title");
    expect(merged?.recoverableDrafts).toEqual([]);
  });

  it("keeps a remote source tombstone and materializes a local offline annotation as a recoverable draft", () => {
    const deletedAt = "2026-09-13T10:00:00.000Z";
    const base = workspaceWithSources([source("source-a")]);
    const local = {
      ...structuredClone(base),
      annotations: [
        annotation("offline-annotation", {
          note: "我离线补充的理解",
          page: 2,
        }),
      ],
    };
    const remote = structuredClone(base);
    remote.sources[0] = { ...remote.sources[0], deletedAt, updatedAt: deletedAt };

    const merged = rebaseIndependentWorkspaceChanges(local, remote, base);

    expect(merged?.sources[0].deletedAt).toBe(deletedAt);
    expect(merged?.annotations).toEqual(local.annotations);
    expect(merged?.recoverableDrafts).toEqual([
      {
        id: `deleted-source-offline-annotation-${Date.parse(deletedAt).toString(36)}`,
        kind: "source-annotation",
        reason: "source-deleted-during-offline-edit",
        sourceId: "source-a",
        sourceVersionId: "source-a-version",
        sourceTitle: "source-a title",
        sourceDeletedAt: deletedAt,
        annotationId: "offline-annotation",
        annotationCreatedAt: createdAt,
        quote: "offline-annotation quote",
        note: "我离线补充的理解",
        page: 2,
        capturedAt: deletedAt,
      },
    ]);
    expect(workspaceSchema.safeParse(merged).success).toBe(true);
  });

  it("symmetrically rescues remotely edited annotation text when the local side deleted its source", () => {
    const deletedAt = "2026-09-13T10:00:00.000Z";
    const base = {
      ...workspaceWithSources([source("source-a")]),
      annotations: [annotation("annotation-a", { note: "原批注" })],
    };
    const local = structuredClone(base);
    local.sources[0] = { ...local.sources[0], deletedAt, updatedAt: deletedAt };
    const remote = structuredClone(base);
    remote.annotations[0] = { ...remote.annotations[0], note: "另一端离线修改后的批注" };

    const merged = rebaseIndependentWorkspaceChanges(local, remote, base);

    expect(merged?.sources[0].deletedAt).toBe(deletedAt);
    expect(merged?.annotations[0]).toEqual(remote.annotations[0]);
    expect(merged?.recoverableDrafts?.[0]).toMatchObject({
      sourceId: "source-a",
      sourceDeletedAt: deletedAt,
      annotationId: "annotation-a",
      annotationCreatedAt: createdAt,
      quote: "annotation-a quote",
      note: "另一端离线修改后的批注",
      capturedAt: deletedAt,
    });
    expect(workspaceSchema.safeParse(merged).success).toBe(true);
  });

  it("uses a stable recovery identity and does not duplicate the same draft on a CAS retry", () => {
    const deletedAt = "2026-09-13T10:00:00.000Z";
    const base = workspaceWithSources([source("source-a")]);
    const local = {
      ...structuredClone(base),
      annotations: [annotation("offline-annotation", { note: "离线新增文字" })],
    };
    const remote = structuredClone(base);
    remote.sources[0] = { ...remote.sources[0], deletedAt, updatedAt: deletedAt };

    const first = rebaseIndependentWorkspaceChanges(local, remote, base)!;
    const retry = rebaseIndependentWorkspaceChanges(local, first, base);

    expect(retry?.recoverableDrafts).toEqual(first.recoverableDrafts);
    expect(retry?.recoverableDrafts).toHaveLength(1);
  });

  it("treats a removed recovery record and its annotation as a resolved tombstone that stale devices cannot revive", () => {
    const deletedAt = "2026-09-13T10:00:00.000Z";
    const originalBase = workspaceWithSources([source("source-a")]);
    const offline = {
      ...structuredClone(originalBase),
      annotations: [annotation("offline-annotation", { note: "待另存的文字" })],
    };
    const deleted = structuredClone(originalBase);
    deleted.sources[0] = { ...deleted.sources[0], deletedAt, updatedAt: deletedAt };
    const withDraft = rebaseIndependentWorkspaceChanges(offline, deleted, originalBase)!;
    const resolvedElsewhere = {
      ...structuredClone(withDraft),
      annotations: [],
      recoverableDrafts: [],
      resolvedRecoverableDrafts: [
        resolveRecoverableSourceAnnotationDraft(withDraft.recoverableDrafts![0], "remove"),
      ],
    };

    const merged = rebaseIndependentWorkspaceChanges(withDraft, resolvedElsewhere, withDraft);

    expect(merged?.annotations).toEqual([]);
    expect(merged?.recoverableDrafts).toEqual([]);
    expect(merged?.resolvedRecoverableDrafts).toEqual(resolvedElsewhere.resolvedRecoverableDrafts);
    expect(workspaceSchema.safeParse(merged).success).toBe(true);
  });

  it("uses a durable resolution marker to stop a pre-conflict offline client from recreating handled text", () => {
    const deletedAt = "2026-09-13T10:00:00.000Z";
    const base = workspaceWithSources([source("source-a")]);
    const offline = {
      ...structuredClone(base),
      annotations: [annotation("offline-annotation", { note: "已经在别处处理的文字" })],
    };
    const initiallyDeleted = structuredClone(base);
    initiallyDeleted.sources[0] = {
      ...initiallyDeleted.sources[0],
      deletedAt,
      updatedAt: deletedAt,
    };
    const initialMerge = rebaseIndependentWorkspaceChanges(offline, initiallyDeleted, base)!;
    const handledRemotely: WorkspaceData = {
      ...structuredClone(initialMerge),
      annotations: [],
      recoverableDrafts: [],
      resolvedRecoverableDrafts: [
        resolveRecoverableSourceAnnotationDraft(initialMerge.recoverableDrafts![0], "remove"),
      ],
    };

    const staleReconnect = rebaseIndependentWorkspaceChanges(offline, handledRemotely, base);

    expect(staleReconnect?.sources[0].deletedAt).toBe(deletedAt);
    expect(staleReconnect?.annotations).toEqual([]);
    expect(staleReconnect?.recoverableDrafts).toEqual([]);
    expect(staleReconnect?.resolvedRecoverableDrafts).toEqual(
      handledRemotely.resolvedRecoverableDrafts,
    );
    expect(workspaceSchema.safeParse(staleReconnect).success).toBe(true);
  });

  it.each(["save", "discard"] as const)(
    "does not revive an annotation after a third device restores a source whose draft was handled with %s",
    (action) => {
      const deletedAt = "2026-09-13T10:00:00.000Z";
      const handledAt = "2026-09-13T11:00:00.000Z";
      const restoredAt = "2026-09-13T12:00:00.000Z";
      const base = workspaceWithSources([source("source-a")]);
      const offline = {
        ...structuredClone(base),
        annotations: [annotation("offline-annotation", { note: "已经处理过的离线文字" })],
      };
      const deleted = structuredClone(base);
      deleted.sources[0] = { ...deleted.sources[0], deletedAt, updatedAt: deletedAt };
      const withDraft = rebaseIndependentWorkspaceChanges(offline, deleted, base)!;
      const handled =
        action === "save"
          ? saveRecoverableDraftAsNote(
              withDraft,
              withDraft.recoverableDrafts![0].id,
              "recovered-note",
              handledAt,
            ).data
          : discardRecoverableDraft(withDraft, withDraft.recoverableDrafts![0].id);
      const restored = restoreSourceAndResolveDrafts(handled, "source-a", deletedAt, restoredAt);

      const staleReconnect = rebaseIndependentWorkspaceChanges(offline, restored, base);

      expect(staleReconnect?.sources[0]).toMatchObject({
        deletedAt: null,
        updatedAt: restoredAt,
      });
      expect(staleReconnect?.annotations).toEqual([]);
      expect(staleReconnect?.recoverableDrafts).toEqual([]);
      expect(staleReconnect?.resolvedRecoverableDrafts).toEqual([
        expect.objectContaining({
          annotationId: "offline-annotation",
          annotationDisposition: "remove",
        }),
      ]);
      expect(staleReconnect?.notes.map((item) => item.id)).toEqual(
        action === "save" ? ["recovered-note"] : [],
      );
      expect(workspaceSchema.safeParse(staleReconnect).success).toBe(true);
    },
  );

  it("keeps the annotation when source restoration resolved the draft", () => {
    const deletedAt = "2026-09-13T10:00:00.000Z";
    const restoredAt = "2026-09-13T12:00:00.000Z";
    const base = workspaceWithSources([source("source-a")]);
    const offline = {
      ...structuredClone(base),
      annotations: [annotation("offline-annotation", { note: "恢复资料后继续保留" })],
    };
    const deleted = structuredClone(base);
    deleted.sources[0] = { ...deleted.sources[0], deletedAt, updatedAt: deletedAt };
    const withDraft = rebaseIndependentWorkspaceChanges(offline, deleted, base)!;
    const restored = restoreSourceFromRecoverableDraft(
      withDraft,
      withDraft.recoverableDrafts![0].id,
      restoredAt,
    );

    const staleReconnect = rebaseIndependentWorkspaceChanges(offline, restored, base);

    expect(staleReconnect?.sources[0].deletedAt).toBeNull();
    expect(staleReconnect?.annotations).toEqual(offline.annotations);
    expect(staleReconnect?.recoverableDrafts).toEqual([]);
    expect(staleReconnect?.resolvedRecoverableDrafts).toEqual([
      expect.objectContaining({
        annotationId: "offline-annotation",
        annotationDisposition: "retain",
      }),
    ]);
    expect(workspaceSchema.safeParse(staleReconnect).success).toBe(true);
  });

  it("keeps restored annotations for legacy resolution markers without a disposition", () => {
    const deletedAt = "2026-09-13T10:00:00.000Z";
    const restoredAt = "2026-09-13T12:00:00.000Z";
    const base = workspaceWithSources([source("source-a")]);
    const offline = {
      ...structuredClone(base),
      annotations: [annotation("offline-annotation", { note: "旧标记下仍应保留" })],
    };
    const deleted = structuredClone(base);
    deleted.sources[0] = { ...deleted.sources[0], deletedAt, updatedAt: deletedAt };
    const withDraft = rebaseIndependentWorkspaceChanges(offline, deleted, base)!;
    const draft = withDraft.recoverableDrafts![0];
    const restoredWithLegacyMarker: WorkspaceData = {
      ...structuredClone(withDraft),
      sources: withDraft.sources.map((item) => ({
        ...item,
        deletedAt: null,
        updatedAt: restoredAt,
      })),
      recoverableDrafts: [],
      resolvedRecoverableDrafts: [
        {
          id: draft.id,
          sourceId: draft.sourceId,
          annotationId: draft.annotationId,
          sourceDeletedAt: draft.sourceDeletedAt,
        },
      ],
    };

    const staleReconnect = rebaseIndependentWorkspaceChanges(
      offline,
      restoredWithLegacyMarker,
      base,
    );

    expect(staleReconnect?.annotations).toEqual(offline.annotations);
    expect(staleReconnect?.resolvedRecoverableDrafts).toEqual(
      restoredWithLegacyMarker.resolvedRecoverableDrafts,
    );
    expect(workspaceSchema.safeParse(staleReconnect).success).toBe(true);
  });

  it("keeps resolution markers append-only and rejects same-ID context drift", () => {
    const deletedAt = "2026-09-13T10:00:00.000Z";
    const base = workspaceWithSources([]);
    const marker = {
      id: `deleted-source-offline-annotation-${Date.parse(deletedAt).toString(36)}`,
      sourceId: "source-a",
      annotationId: "offline-annotation",
      sourceDeletedAt: deletedAt,
    };
    const withMarker: WorkspaceData = {
      ...structuredClone(base),
      resolvedRecoverableDrafts: [marker],
    };
    const removedEverywhere = structuredClone(base);

    expect(
      rebaseIndependentWorkspaceChanges(removedEverywhere, removedEverywhere, withMarker)
        ?.resolvedRecoverableDrafts,
    ).toEqual([marker]);
    expect(
      rebaseIndependentWorkspaceChanges(
        { ...structuredClone(base), resolvedRecoverableDrafts: [marker] },
        {
          ...structuredClone(base),
          resolvedRecoverableDrafts: [{ ...marker, sourceId: "source-b" }],
        },
        base,
      ),
    ).toBeNull();
    expect(
      rebaseIndependentWorkspaceChanges(
        {
          ...structuredClone(base),
          resolvedRecoverableDrafts: [{ ...marker, annotationDisposition: "retain" }],
        },
        {
          ...structuredClone(base),
          resolvedRecoverableDrafts: [{ ...marker, annotationDisposition: "remove" }],
        },
        base,
      ),
    ).toBeNull();
  });

  it("rejects divergent immutable recovery records instead of overwriting either copy", () => {
    const deletedAt = "2026-09-13T10:00:00.000Z";
    const originalBase = workspaceWithSources([source("source-a")]);
    const offline = {
      ...structuredClone(originalBase),
      annotations: [annotation("offline-annotation", { note: "待恢复文字" })],
    };
    const deleted = structuredClone(originalBase);
    deleted.sources[0] = { ...deleted.sources[0], deletedAt, updatedAt: deletedAt };
    const withDraft = rebaseIndependentWorkspaceChanges(offline, deleted, originalBase)!;
    const base = { ...structuredClone(withDraft), recoverableDrafts: [] };
    const local = structuredClone(withDraft);
    const remote = structuredClone(withDraft);
    remote.recoverableDrafts![0] = {
      ...remote.recoverableDrafts![0],
      sourceTitle: "被另一端改写的上下文",
    };

    expect(rebaseIndependentWorkspaceChanges(local, remote, base)).toBeNull();
  });

  it("does not invent a recovery draft for an annotation without user-authored text", () => {
    const deletedAt = "2026-09-13T10:00:00.000Z";
    const base = workspaceWithSources([source("source-a")]);
    const local = {
      ...structuredClone(base),
      annotations: [annotation("highlight-only", { note: "" })],
    };
    const remote = structuredClone(base);
    remote.sources[0] = { ...remote.sources[0], deletedAt, updatedAt: deletedAt };

    const merged = rebaseIndependentWorkspaceChanges(local, remote, base);

    expect(merged?.annotations).toEqual(local.annotations);
    expect(merged?.recoverableDrafts).toEqual([]);
  });

  it("refuses a delete-versus-edit merge when deleting also changed parsing state", () => {
    const base = workspaceWithSources([source("source-a")]);
    const local = structuredClone(base);
    local.sources[0] = { ...local.sources[0], title: "offline title" };
    const remote = structuredClone(base);
    remote.sources[0] = {
      ...remote.sources[0],
      status: "failed",
      error: "cancelled",
      deletedAt: resolvedAt,
      updatedAt: resolvedAt,
    };

    expect(rebaseIndependentWorkspaceChanges(local, remote, base)).toBeNull();
  });

  it("never revives a physically purged remote source and rejects an edited stale copy", () => {
    const base = workspaceWithSources([source("source-a")]);
    const unchangedLocal = structuredClone(base);
    const editedLocal = structuredClone(base);
    editedLocal.sources[0] = { ...editedLocal.sources[0], text: "offline edit" };
    const remote = workspaceWithSources([]);

    expect(rebaseIndependentWorkspaceChanges(unchangedLocal, remote, base)?.sources).toEqual([]);
    expect(rebaseIndependentWorkspaceChanges(editedLocal, remote, base)).toBeNull();
  });

  it("rejects local references that would become orphaned by a remote physical purge", () => {
    const base = workspaceWithSources([source("source-a")]);
    const remote = workspaceWithSources([]);
    const withAnnotation = {
      ...structuredClone(base),
      annotations: [annotation("offline-annotation")],
    };
    const withCitedNote = {
      ...structuredClone(base),
      notes: [
        note("offline-note", "offline note", {
          citations: [
            {
              sourceId: "source-a",
              versionId: "source-a-version",
              chunkId: "chunk-a",
              title: "Source A",
              quote: "quoted text",
              section: "正文",
            },
          ],
        }),
      ],
    };

    expect(rebaseIndependentWorkspaceChanges(withAnnotation, remote, base)).toBeNull();
    expect(rebaseIndependentWorkspaceChanges(withCitedNote, remote, base)).toBeNull();
  });

  it("merges independent annotation additions, an edit, and a one-sided deletion by ID", () => {
    const base = {
      ...workspaceWithSources([source("source-a")]),
      annotations: [annotation("edit"), annotation("delete")],
    };
    const local = {
      ...structuredClone(base),
      annotations: [annotation("edit", { note: "local edit" }), annotation("local-add")],
    };
    const remote = {
      ...structuredClone(base),
      annotations: [annotation("edit"), annotation("delete"), annotation("remote-add")],
    };

    const merged = rebaseIndependentWorkspaceChanges(local, remote, base);

    expect(merged?.annotations.map((item) => [item.id, item.note])).toEqual([
      ["edit", "local edit"],
      ["remote-add", "remote-add note"],
      ["local-add", "local-add note"],
    ]);
  });

  it("rejects concurrent annotation edits, delete-versus-edit, and identity drift", () => {
    const base = {
      ...workspaceWithSources([source("source-a")]),
      annotations: [annotation("annotation-a")],
    };
    const localEdit = structuredClone(base);
    localEdit.annotations[0] = { ...localEdit.annotations[0], note: "local edit" };
    const remoteEdit = structuredClone(base);
    remoteEdit.annotations[0] = { ...remoteEdit.annotations[0], note: "remote edit" };
    const remoteDelete = { ...structuredClone(base), annotations: [] };
    const identityDrift = structuredClone(base);
    identityDrift.annotations[0] = {
      ...identityDrift.annotations[0],
      versionId: "different-version",
    };
    const quoteDrift = structuredClone(base);
    quoteDrift.annotations[0] = { ...quoteDrift.annotations[0], quote: "different quote" };

    expect(rebaseIndependentWorkspaceChanges(localEdit, remoteEdit, base)).toBeNull();
    expect(rebaseIndependentWorkspaceChanges(localEdit, remoteDelete, base)).toBeNull();
    expect(rebaseIndependentWorkspaceChanges(identityDrift, base, base)).toBeNull();
    expect(rebaseIndependentWorkspaceChanges(quoteDrift, base, base)).toBeNull();
  });

  it("applies independent safe notes but rejects a physical local note deletion", () => {
    const base = workspace([note("existing", "before")]);
    const local = workspace([
      note("existing", "local edit", { contentRevision: 1 }),
      note("local-add", "local addition"),
    ]);
    const remote = workspace([note("existing", "before"), note("remote-add", "remote addition")]);

    const merged = rebaseIndependentWorkspaceChanges(local, remote, base);
    expect(merged?.notes.map((item) => [item.id, item.content])).toEqual([
      ["existing", "local edit"],
      ["remote-add", "remote addition"],
      ["local-add", "local addition"],
    ]);
    expect(
      rebaseIndependentWorkspaceChanges(
        workspace([]),
        workspace([note("existing", "before")]),
        base,
      ),
    ).toBeNull();
  });

  it("requires a common base, unchanged unmanaged data, valid identities, and spare capacity", () => {
    const base = workspaceWithSources([source("source-a")]);
    const local = structuredClone(base);
    local.sources[0] = { ...local.sources[0], title: "local title" };
    const unrelated = structuredClone(base);
    unrelated.aiEnabled = false;
    const drifted = structuredClone(base);
    drifted.sources[0] = { ...drifted.sources[0], createdAt: resolvedAt };

    expect(rebaseIndependentWorkspaceChanges(local, base, null)).toBeNull();
    expect(rebaseIndependentWorkspaceChanges(unrelated, base, base)).toBeNull();
    expect(rebaseIndependentWorkspaceChanges(drifted, base, base)).toBeNull();
    expect(rebaseIndependentWorkspaceChanges(local, base, base, 1)).toBeNull();
  });
});

describe("planNoteSyncConflicts", () => {
  it("conservatively identifies different same-ID live notes without a common base", () => {
    const local = workspace([note("note-a", "local edit", { contentRevision: 1 })]);
    const remote = workspace([note("note-a", "remote edit", { contentRevision: 1 })]);

    const plan = planNoteSyncConflicts(local, remote);

    expect(plan).toMatchObject({ baseKnown: false, safe: [] });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      id: "note-conflict:note-a",
      noteId: "note-a",
      kind: "both-edited",
      localState: "live",
      remoteState: "live",
    });
    plan.conflicts[0].local!.content = "mutated plan";
    expect(local.notes[0].content).toBe("local edit");
  });

  it("marks one-sided changes and independent additions as safe with a common base", () => {
    const base = workspace([note("existing", "before")]);
    const local = workspace([
      note("existing", "local edit", { contentRevision: 1 }),
      note("local-add", "local addition"),
    ]);
    const remote = workspace([note("existing", "before"), note("remote-add", "remote addition")]);

    const plan = planNoteSyncConflicts(local, remote, base);

    expect(plan.conflicts).toEqual([]);
    expect(plan.safe).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          noteId: "existing",
          side: "local",
          reason: "local-change",
        }),
        expect.objectContaining({
          noteId: "local-add",
          side: "local",
          reason: "local-addition",
        }),
        expect.objectContaining({
          noteId: "remote-add",
          side: "remote",
          reason: "remote-addition",
        }),
      ]),
    );
  });

  it("does not treat a manual-excerpt identity change as an identical note", () => {
    const base = workspace([note("note-a", "same body")]);
    const local = workspace([
      note("note-a", "same body", { manualExcerptRefs: [manualExcerptRef()] }),
    ]);
    const remote = workspace([note("note-a", "same body")]);

    const plan = planNoteSyncConflicts(local, remote, base);

    expect(plan.conflicts).toEqual([]);
    expect(plan.safe).toEqual([
      expect.objectContaining({ noteId: "note-a", side: "local", reason: "local-change" }),
    ]);
  });

  it("identifies delete-versus-edit instead of treating the tombstone as a winner", () => {
    const base = workspace([note("note-a", "before")]);
    const local = workspace([note("note-a", "before", { deletedAt: resolvedAt })]);
    const remote = workspace([note("note-a", "remote edit", { contentRevision: 1 })]);

    const plan = planNoteSyncConflicts(local, remote, base);

    expect(plan.safe).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      kind: "delete-vs-edit",
      localState: "deleted",
      remoteState: "live",
    });
  });
});

describe("applySafeNoteSyncChanges", () => {
  it("rebases local-only replacements, additions, and soft deletions onto the latest remote data", () => {
    const base = workspace([note("replace", "before"), note("delete", "before")]);
    const local = workspace([
      note("replace", "local edit", { contentRevision: 1 }),
      note("delete", "before", { deletedAt: resolvedAt, contentRevision: 1 }),
      note("local-add", "new local note"),
    ]);
    const latestRemote = workspace([note("replace", "before"), note("delete", "before")]);
    const localChanges = planNoteSyncConflicts(local, latestRemote, base).safe.filter(
      (change) => change.side === "local",
    );

    expect(localChanges).toHaveLength(3);
    expect(localChanges.map((change) => change.reason)).toEqual([
      "local-deletion",
      "local-addition",
      "local-change",
    ]);

    const rebased = applySafeNoteSyncChanges(latestRemote, localChanges);

    expect(rebased.notes.find((item) => item.id === "replace")).toMatchObject({
      content: "local edit",
      contentRevision: 1,
    });
    expect(rebased.notes.find((item) => item.id === "delete")).toMatchObject({
      deletedAt: resolvedAt,
    });
    expect(rebased.notes.find((item) => item.id === "local-add")).toMatchObject({
      content: "new local note",
    });
    expect(latestRemote.notes).toHaveLength(2);
  });

  it("retains existing history when replacing the same note ID", () => {
    const incoming = note("note-a", "local body", { versions: [version("local-history")] });
    const remote = workspace([note("note-a", "before", { versions: [version("remote-history")] })]);
    const change: SafeNoteSyncChange = {
      noteId: "note-a",
      side: "local",
      reason: "local-change",
      note: incoming,
    };

    const result = applySafeNoteSyncChanges(remote, [change]);

    expect(result.notes[0].versions.map((item) => item.id)).toEqual([
      "local-history",
      "remote-history",
    ]);
  });

  it("rejects remote changes and physical deletions rather than guessing", () => {
    const remoteChange: SafeNoteSyncChange = {
      noteId: "note-a",
      side: "remote",
      reason: "remote-change",
      note: note("note-a", "remote body"),
    };
    const missingTombstone: SafeNoteSyncChange = {
      noteId: "note-a",
      side: "local",
      reason: "local-deletion",
      note: null,
    };

    expect(() => applySafeNoteSyncChanges(workspace([]), [remoteChange])).toThrow(/本地/);
    expect(() => applySafeNoteSyncChanges(workspace([]), [missingTombstone])).toThrow(/墓碑/);
  });

  it("reports capacity overflow instead of applying part of a safe rebase", () => {
    const change: SafeNoteSyncChange = {
      noteId: "note-a",
      side: "local",
      reason: "local-addition",
      note: note("note-a", "body"),
    };

    expect(() => applySafeNoteSyncChanges(workspace([]), [change], 1)).toThrow(/3 MiB/);
  });
});

describe("resolveNoteSyncConflict", () => {
  function liveConflict() {
    return planNoteSyncConflicts(
      workspace([note("note-a", "local body", { contentRevision: 1 })]),
      workspace([note("note-a", "remote body", { contentRevision: 1 })]),
    ).conflicts[0];
  }

  it("selects one live version while retaining the losing body as a NoteVersion", () => {
    const conflict = liveConflict();
    const resolution = resolveNoteSyncConflict(conflict, {
      choice: "local",
      at: resolvedAt,
      preservedVersionIds: { remote: "remote-conflict-v1" },
    });

    expect(resolution.preservedSnapshots).toEqual([]);
    expect(resolution.note).toMatchObject({
      id: "note-a",
      content: "local body",
      contentRevision: 2,
      updatedAt: resolvedAt,
      versions: [expect.objectContaining({ id: "remote-conflict-v1", content: "remote body" })],
    });
    expect(conflict.remote!.versions).toEqual([]);

    const original = workspace([note("note-a", "local body", { contentRevision: 1 })]);
    const applied = applyNoteSyncResolution(original, resolution);
    expect(applied.notes[0].content).toBe("local body");
    expect(original.notes[0].versions).toEqual([]);

    const remoteWithHistory = workspace([
      note("note-a", "remote body", {
        contentRevision: 1,
        versions: [version("remote-history")],
      }),
    ]);
    const retained = applyNoteSyncResolution(remoteWithHistory, resolution);
    expect(retained.notes[0].versions.map((item) => item.id)).toEqual([
      "remote-conflict-v1",
      "remote-history",
    ]);
  });

  it("keeps the losing side's manual-excerpt identities in the retained version", () => {
    const conflict = planNoteSyncConflicts(
      workspace([note("note-a", "local body", { contentRevision: 1 })]),
      workspace([
        note("note-a", "remote body", {
          contentRevision: 1,
          manualExcerptRefs: [manualExcerptRef("2222222222222222")],
        }),
      ]),
    ).conflicts[0]!;

    const resolution = resolveNoteSyncConflict(conflict, {
      choice: "local",
      at: resolvedAt,
      preservedVersionIds: { remote: "remote-excerpt-version" },
    });

    expect(resolution.note!.versions[0]).toMatchObject({
      id: "remote-excerpt-version",
      manualExcerptRefs: [manualExcerptRef("2222222222222222")],
    });
  });

  it("requires manual merging to retain both original live bodies", () => {
    const resolution = resolveNoteSyncConflict(liveConflict(), {
      choice: "manual",
      content: "my combined explanation",
      at: resolvedAt,
      preservedVersionIds: { local: "local-original", remote: "remote-original" },
    });

    expect(resolution.note).toMatchObject({
      content: "my combined explanation",
      contentRevision: 2,
    });
    expect(resolution.note!.versions.map((item) => [item.id, item.content])).toEqual([
      ["local-original", "local body"],
      ["remote-original", "remote body"],
    ]);
  });

  it("uses an explicit snapshot for a discarded tombstone and refuses to apply it invisibly", () => {
    const conflict = planNoteSyncConflicts(
      workspace([note("note-a", "local body", { contentRevision: 1 })]),
      workspace([note("note-a", "before", { deletedAt: resolvedAt })]),
      workspace([note("note-a", "before")]),
    ).conflicts[0];
    const resolution = resolveNoteSyncConflict(conflict, {
      choice: "local",
      at: resolvedAt,
      preservedSnapshotIds: { remote: "remote-deletion-snapshot" },
    });

    expect(resolution.note!.content).toBe("local body");
    expect(resolution.preservedSnapshots).toEqual([
      expect.objectContaining({
        id: "remote-deletion-snapshot",
        side: "remote",
        state: "deleted",
        note: expect.objectContaining({ id: "note-a", deletedAt: resolvedAt }),
      }),
    ]);
    expect(() => applyNoteSyncResolution(workspace([conflict.local!]), resolution)).toThrow(/快照/);
  });

  it("fails explicitly rather than trimming versions or overflowing the workspace", () => {
    const conflict = planNoteSyncConflicts(
      workspace([
        note("note-a", "local body", {
          contentRevision: 1,
          versions: Array.from({ length: MAX_NOTE_CONFLICT_VERSIONS }, (_, index) =>
            version(`existing-${index}`),
          ),
        }),
      ]),
      workspace([note("note-a", "remote body", { contentRevision: 1 })]),
    ).conflicts[0];

    expect(() =>
      resolveNoteSyncConflict(conflict, {
        choice: "local",
        at: resolvedAt,
        preservedVersionIds: { remote: "remote-conflict-v1" },
      }),
    ).toThrow(/上限/);

    const resolution = resolveNoteSyncConflict(liveConflict(), {
      choice: "local",
      at: resolvedAt,
      preservedVersionIds: { remote: "remote-conflict-v1" },
    });
    expect(() =>
      applyNoteSyncResolution(workspace([note("note-a", "local body")]), resolution, 1),
    ).toThrow(/3 MiB/);
  });
});
