import { reviseNote } from "./note-versions";
import { cancelImportJobsForRecycledSources } from "./import-queue";
import type { Space, WorkspaceData } from "./types";

/**
 * A learning space only owns its membership and space-scoped records. Sources
 * themselves are global library objects, so deleting a space must never make an
 * original disappear unless the user explicitly moves its exclusive copies to
 * the recycle bin.
 */
export interface SpaceDeletionImpact {
  space: Space;
  /** Current, readable sources that are also assigned to another space. */
  sharedSources: number;
  /** Current, readable sources that would otherwise become unassigned. */
  exclusiveSources: number;
  /** Already trashed sources whose restored membership will become Inbox. */
  recycleBinSources: number;
  /** Notes and knowledge pages that will be retained in the inbox. */
  notes: number;
  /** Already deleted notes whose restored location will become Inbox. */
  recycleBinNotes: number;
  /** Historical question threads that will be retained in the inbox. */
  conversations: number;
  /** Space-scoped generated suggestions that will be removed. */
  organizationJobs: number;
  /** Of the removed suggestions, ones that were still running or queued. */
  pendingOrganizationJobs: number;
  /** Space-scoped concept-relation records that will be removed. */
  conceptRelations: number;
}

export interface DeleteLearningSpaceOptions {
  /** Keep the default false: library sources become inbox items. */
  recycleExclusiveSources?: boolean;
  /** Allows one atomic, testable timestamp for the optional recycle operation. */
  now?: string;
}

export type SourceRecycleSkipReason = "missing" | "already-recycled";

export interface SourceRecycleSkip {
  sourceId: string;
  reason: SourceRecycleSkipReason;
}

export interface RecycleSourcesResult {
  data: WorkspaceData;
  /** Sources that were moved into the recoverable recycle bin. */
  recycledSourceIds: string[];
  /** Per-source outcome for selections that could not be moved. */
  skipped: SourceRecycleSkip[];
}

/**
 * Rename a learning space without ever replacing a meaningful name with an
 * empty or whitespace-only value. Returning the original object for rejected
 * edits keeps callers from publishing a malformed workspace snapshot.
 */
export function renameLearningSpace(
  data: WorkspaceData,
  spaceId: string,
  name: string,
): WorkspaceData {
  if (!name.trim()) return data;

  let changed = false;
  const spaces = data.spaces.map((space) => {
    if (space.id !== spaceId || space.name === name) return space;
    changed = true;
    return { ...space, name };
  });
  return changed ? { ...data, spaces } : data;
}

/**
 * Move selected library sources into the recoverable recycle bin. Pending
 * import jobs are cancelled before the updated workspace reaches a UI reader,
 * so a parser cannot look active while its source is unavailable.
 */
export function recycleSources(
  data: WorkspaceData,
  sourceIds: readonly string[],
  now = new Date().toISOString(),
): WorkspaceData {
  return recycleSourcesWithResult(data, sourceIds, now).data;
}

/**
 * Applies a bulk recycle selection against one current workspace snapshot.
 * Missing or already recycled sources are deliberately reported rather than
 * silently counted as successful, so a confirmation dialog can show precise
 * outcomes after concurrent local changes.
 */
export function recycleSourcesWithResult(
  data: WorkspaceData,
  sourceIds: readonly string[],
  now = new Date().toISOString(),
): RecycleSourcesResult {
  const requestedIds = [...new Set(sourceIds)];
  if (!requestedIds.length) return { data, recycledSourceIds: [], skipped: [] };
  const ids = new Set(requestedIds);
  const sourcesById = new Map(data.sources.map((source) => [source.id, source]));
  const recycledSourceIds: string[] = [];
  const skippedBySourceId = new Map<string, SourceRecycleSkipReason>();
  let changed = false;
  const sources = data.sources.map((source) => {
    if (!ids.has(source.id)) return source;
    if (source.deletedAt) {
      skippedBySourceId.set(source.id, "already-recycled");
      return source;
    }
    changed = true;
    recycledSourceIds.push(source.id);
    return { ...source, deletedAt: now, updatedAt: now };
  });
  for (const sourceId of requestedIds) {
    if (!sourcesById.has(sourceId)) skippedBySourceId.set(sourceId, "missing");
  }
  return {
    data: cancelImportJobsForRecycledSources(changed ? { ...data, sources } : data, now),
    recycledSourceIds,
    skipped: requestedIds.flatMap((sourceId) => {
      const reason = skippedBySourceId.get(sourceId);
      return reason ? [{ sourceId, reason }] : [];
    }),
  };
}

function existingSpace(data: WorkspaceData, spaceId: string): Space {
  const space = data.spaces.find((item) => item.id === spaceId);
  if (!space) throw new Error("这个学习空间已不存在，请刷新后重试。");
  return space;
}

function hasOnlyThisSpace(spaceIds: string[], spaceId: string): boolean {
  return spaceIds.includes(spaceId) && spaceIds.every((id) => id === spaceId);
}

/**
 * Captures every membership or derived record the deletion can alter. The UI
 * uses it as a confirmation precondition so a newly-added exclusive source
 * cannot be recycled under an out-of-date preview.
 */
export function learningSpaceDeletionFingerprint(data: WorkspaceData, spaceId: string): string {
  existingSpace(data, spaceId);
  const byId = <T extends { id: string }>(items: T[]) =>
    [...items].sort((left, right) => left.id.localeCompare(right.id));
  return JSON.stringify({
    spaceId,
    sources: byId(data.sources.filter((source) => source.spaceIds.includes(spaceId))).map(
      (source) => [source.id, source.versionId, source.deletedAt, [...source.spaceIds].sort()],
    ),
    notes: byId(data.notes.filter((note) => note.spaceId === spaceId)).map((note) => [
      note.id,
      note.deletedAt,
    ]),
    conversations: byId(
      data.conversations.filter((conversation) => conversation.spaceId === spaceId),
    ).map((conversation) => conversation.id),
    organizationJobs: byId(
      data.organizationJobs?.filter((job) => job.request.spaceId === spaceId) ?? [],
    ).map((job) => [job.id, job.status]),
    conceptRelations: byId(
      data.conceptRelations?.filter((relation) => relation.spaceId === spaceId) ?? [],
    ).map((relation) => relation.id),
  });
}

/** Build the deletion preview from the same snapshot that will be changed. */
export function previewLearningSpaceDeletion(
  data: WorkspaceData,
  spaceId: string,
): SpaceDeletionImpact {
  const space = existingSpace(data, spaceId);
  const scopedSources = data.sources.filter((source) => source.spaceIds.includes(spaceId));
  const currentSources = scopedSources.filter((source) => !source.deletedAt);
  const scopedNotes = data.notes.filter((note) => note.spaceId === spaceId);
  const jobs = data.organizationJobs?.filter((job) => job.request.spaceId === spaceId) ?? [];
  return {
    space,
    sharedSources: currentSources.filter((source) => !hasOnlyThisSpace(source.spaceIds, spaceId))
      .length,
    exclusiveSources: currentSources.filter((source) => hasOnlyThisSpace(source.spaceIds, spaceId))
      .length,
    recycleBinSources: scopedSources.filter((source) => !!source.deletedAt).length,
    notes: scopedNotes.filter((note) => !note.deletedAt).length,
    recycleBinNotes: scopedNotes.filter((note) => !!note.deletedAt).length,
    conversations: data.conversations.filter((conversation) => conversation.spaceId === spaceId)
      .length,
    organizationJobs: jobs.length,
    pendingOrganizationJobs: jobs.filter((job) => ["queued", "running"].includes(job.status))
      .length,
    conceptRelations:
      data.conceptRelations?.filter((relation) => relation.spaceId === spaceId).length ?? 0,
  };
}

/**
 * Remove one learning space while retaining user-owned library material. The
 * caller must show `previewLearningSpaceDeletion` and receive confirmation
 * before invoking this operation.
 */
export function deleteLearningSpace(
  data: WorkspaceData,
  spaceId: string,
  options: DeleteLearningSpaceOptions = {},
): WorkspaceData {
  existingSpace(data, spaceId);
  const recycleAt = options.now ?? new Date().toISOString();
  const recycleExclusiveSources = options.recycleExclusiveSources === true;

  const next: WorkspaceData = {
    ...data,
    spaces: data.spaces.filter((space) => space.id !== spaceId),
    // Strip the association from deleted sources too, so restoring one later
    // cannot resurrect a deleted space.
    sources: data.sources.map((source) => {
      if (!source.spaceIds.includes(spaceId)) return source;
      const spaceIds = source.spaceIds.filter((id) => id !== spaceId);
      const shouldRecycle =
        recycleExclusiveSources && !source.deletedAt && hasOnlyThisSpace(source.spaceIds, spaceId);
      return {
        ...source,
        spaceIds,
        ...(shouldRecycle ? { deletedAt: recycleAt, updatedAt: recycleAt } : {}),
      };
    }),
    // Current notes receive a versioned location change; already deleted notes
    // retain their historical edit metadata while becoming restorable inbox items.
    notes: data.notes.map((note) => {
      if (note.spaceId !== spaceId) return note;
      return note.deletedAt
        ? { ...note, spaceId: "inbox" }
        : reviseNote(note, { spaceId: "inbox" }, "always");
    }),
    // Conversations remain a user record but never preserve the deleted space
    // as a valid future AI scope.
    conversations: data.conversations.map((conversation) =>
      conversation.spaceId === spaceId ? { ...conversation, spaceId: "inbox" } : conversation,
    ),
    // Suggestions and relation records are space-scoped derived state. Their
    // removal also causes any in-flight organization request to fail its
    // context guard before it can publish a late result.
    ...(data.organizationJobs
      ? {
          organizationJobs: data.organizationJobs.filter((job) => job.request.spaceId !== spaceId),
        }
      : {}),
    ...(data.conceptRelations
      ? {
          conceptRelations: data.conceptRelations.filter(
            (relation) => relation.spaceId !== spaceId,
          ),
        }
      : {}),
  };
  return cancelImportJobsForRecycledSources(next, recycleAt);
}
