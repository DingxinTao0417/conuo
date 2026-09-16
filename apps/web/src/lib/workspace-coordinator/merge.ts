import type { WorkspaceData } from "../types";
import type { AnonymousWorkspaceMigrationState } from "./types";

export function noAnonymousWorkspaceMigration(): AnonymousWorkspaceMigrationState {
  return { kind: "none", canMigrate: false };
}

export function sameData(left: WorkspaceData, right: WorkspaceData): boolean {
  // JSONB and schema parsing may reorder object keys. Array order remains meaningful.
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function sameWorkspaceField(
  left: WorkspaceData,
  right: WorkspaceData,
  key: keyof WorkspaceData,
): boolean {
  return (
    hasOwn(left, key) === hasOwn(right, key) &&
    JSON.stringify(left[key]) === JSON.stringify(right[key])
  );
}

function sameOptionalRecord<T>(left: T | undefined, right: T | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Three-way merges identity collections without guessing through a true
 * two-sided conflict. Atomic imports normally add a fresh source/job while an
 * editor changes an unrelated record, so those independent changes combine.
 */
function mergeConcurrentRecords<T extends { id: string }>(
  current: T[],
  committed: T[],
  boundary: T[],
): T[] | null {
  const currentById = new Map(current.map((record) => [record.id, record]));
  const committedById = new Map(committed.map((record) => [record.id, record]));
  const boundaryById = new Map(boundary.map((record) => [record.id, record]));
  const ids = new Set([
    ...committed.map((record) => record.id),
    ...current.map((record) => record.id),
    ...boundary.map((record) => record.id),
  ]);
  const selected = new Map<string, T>();

  for (const id of ids) {
    const before = boundaryById.get(id);
    const local = currentById.get(id);
    const incoming = committedById.get(id);
    const localChanged = !sameOptionalRecord(local, before);
    const incomingChanged = !sameOptionalRecord(incoming, before);
    if (localChanged && incomingChanged && !sameOptionalRecord(local, incoming)) return null;
    const value = localChanged ? local : incomingChanged ? incoming : before;
    if (value) selected.set(id, value);
  }

  const ordered: T[] = [];
  for (const record of [...committed, ...current]) {
    const value = selected.get(record.id);
    if (!value || ordered.some((item) => item.id === record.id)) continue;
    ordered.push(value);
  }
  return ordered;
}

/**
 * Replays changes made by this page while an atomic import transaction waited,
 * while retaining independent fields already committed by another tab. A true
 * two-sided change is left unresolved so a stale full snapshot is never saved.
 */
export function mergeConcurrentWorkspace(
  current: WorkspaceData,
  committed: WorkspaceData,
  boundary: WorkspaceData,
): WorkspaceData | null {
  const mergedSources = mergeConcurrentRecords(
    current.sources,
    committed.sources,
    boundary.sources,
  );
  if (!mergedSources) return null;
  const mergedJobs = mergeConcurrentRecords(
    current.importJobs ?? [],
    committed.importJobs ?? [],
    boundary.importJobs ?? [],
  );
  if (!mergedJobs) return null;

  const merged = structuredClone(committed) as WorkspaceData;
  const mergedRecord = merged as unknown as Record<string, unknown>;
  const currentRecord = current as unknown as Record<string, unknown>;
  const keys = new Set<keyof WorkspaceData>([
    ...(Object.keys(boundary) as (keyof WorkspaceData)[]),
    ...(Object.keys(current) as (keyof WorkspaceData)[]),
    ...(Object.keys(committed) as (keyof WorkspaceData)[]),
  ]);
  keys.delete("sources");
  keys.delete("importJobs");

  for (const key of keys) {
    const localChanged = !sameWorkspaceField(current, boundary, key);
    const incomingChanged = !sameWorkspaceField(committed, boundary, key);
    if (localChanged && incomingChanged && !sameWorkspaceField(current, committed, key))
      return null;
    if (!localChanged) continue;
    if (hasOwn(current, key)) mergedRecord[key] = structuredClone(currentRecord[key]);
    else delete mergedRecord[key];
  }

  merged.sources = mergedSources;
  if (
    mergedJobs.length ||
    hasOwn(current, "importJobs") ||
    hasOwn(committed, "importJobs") ||
    hasOwn(boundary, "importJobs")
  )
    merged.importJobs = mergedJobs;
  else delete merged.importJobs;
  return merged;
}

export function sameDataOutsideNotes(left: WorkspaceData, right: WorkspaceData): boolean {
  const withoutNotes = (data: WorkspaceData) =>
    Object.fromEntries(Object.entries(data).filter(([key]) => key !== "notes"));
  return JSON.stringify(withoutNotes(left)) === JSON.stringify(withoutNotes(right));
}

/**
 * `createEmptyWorkspace()` always contains one default space, so a simple
 * `spaces.length` check would turn every fresh browser into a migration prompt.
 * Treat any user-visible material, non-default library configuration, or a
 * changed initial space as actual data that must never be silently replaced.
 */
export function hasMeaningfulWorkspaceContent(data: WorkspaceData): boolean {
  if (
    data.sources.length ||
    data.notes.length ||
    data.annotations.length ||
    data.conversations.length ||
    data.importJobs?.length ||
    data.organizationJobs?.length ||
    data.conceptRelations?.length ||
    data.aiEnabled !== true ||
    data.semanticSearch === true ||
    data.autoOrganize === true
  )
    return true;
  if (data.spaces.length !== 1) return true;
  const [space] = data.spaces;
  return (
    !space ||
    space.name !== "我的学习空间" ||
    !!space.goal.trim() ||
    space.color !== "#4B3FE3" ||
    space.archived
  );
}

export function anonymousMigrationSummary(
  kind: AnonymousWorkspaceMigrationState["kind"],
  data: WorkspaceData,
  message: string,
  canMigrate = false,
): AnonymousWorkspaceMigrationState {
  return {
    kind,
    canMigrate,
    message,
    sourceCount: data.sources.length,
    noteCount: data.notes.length,
  };
}

/**
 * Anonymous snapshots have no trustworthy cloud ownership. Retain their local
 * Blob references, but never carry a Storage path into a newly signed-in
 * account. The normal pump then uploads each available original under the
 * current account's canonical path.
 */
export function withoutAnonymousCloudPaths(data: WorkspaceData): WorkspaceData {
  const migrated = structuredClone(data);
  for (const source of migrated.sources) {
    delete source.storagePath;
    for (const version of source.versions ?? []) delete version.storagePath;
  }
  return migrated;
}
