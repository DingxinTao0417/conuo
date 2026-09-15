import type { WorkspaceData } from "./types";

export type SourceAssociationSkipReason = "missing" | "recycled" | "already-associated";

export interface SourceAssociationSkip {
  sourceId: string;
  reason: SourceAssociationSkipReason;
}

export interface SourceSpaceAssociationResult {
  data: WorkspaceData;
  /** Sources that gained at least one new learning-space association. */
  addedSourceIds: string[];
  /** Number of source-to-space associations added across the selected sources. */
  addedAssociations: number;
  /** Per-source outcome for selections that could not gain a new association. */
  skipped: SourceAssociationSkip[];
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Adds one or more active learning spaces to selected library sources in one
 * immutable workspace update. This never copies an original, removes an
 * existing association, or resurrects a recycled source.
 */
export function addSourcesToLearningSpaces(
  data: WorkspaceData,
  sourceIds: readonly string[],
  spaceIds: readonly string[],
  now = new Date().toISOString(),
): SourceSpaceAssociationResult {
  const requestedSources = unique(sourceIds);
  const requestedSpaces = unique(spaceIds);
  if (!requestedSources.length) throw new Error("请至少选择一份资料。");
  if (!requestedSpaces.length) throw new Error("请至少选择一个学习空间。");

  const activeSpaceIds = new Set(
    data.spaces.filter((space) => !space.archived).map((space) => space.id),
  );
  if (requestedSpaces.some((id) => !activeSpaceIds.has(id)))
    throw new Error("所选学习空间已不存在或已归档，请重新选择。");

  const requestedSourceIds = new Set(requestedSources);
  const sourcesById = new Map(data.sources.map((source) => [source.id, source]));
  const skippedBySourceId = new Map<string, SourceAssociationSkipReason>();
  const addedSourceIds: string[] = [];
  let addedAssociations = 0;

  const sources = data.sources.map((source) => {
    if (!requestedSourceIds.has(source.id)) return source;
    if (source.deletedAt) {
      skippedBySourceId.set(source.id, "recycled");
      return source;
    }
    const additions = requestedSpaces.filter((id) => !source.spaceIds.includes(id));
    if (!additions.length) {
      skippedBySourceId.set(source.id, "already-associated");
      return source;
    }
    addedSourceIds.push(source.id);
    addedAssociations += additions.length;
    return {
      ...source,
      spaceIds: unique([...source.spaceIds, ...additions]),
      updatedAt: now,
    };
  });

  for (const sourceId of requestedSources) {
    if (!sourcesById.has(sourceId)) skippedBySourceId.set(sourceId, "missing");
  }
  const skipped = requestedSources.flatMap((sourceId) => {
    const reason = skippedBySourceId.get(sourceId);
    return reason ? [{ sourceId, reason }] : [];
  });

  return {
    data: addedSourceIds.length ? { ...data, sources } : data,
    addedSourceIds,
    addedAssociations,
    skipped,
  };
}
