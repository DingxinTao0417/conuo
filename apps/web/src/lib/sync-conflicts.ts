import { MAX_WORKSPACE_BYTES } from "./supabase/validation";
import { createRecoverableSourceAnnotationDraft } from "./recoverable-drafts";
import { annotationTextAnchorMatches, sameAnnotationTextAnchor } from "./annotations";
import type {
  Annotation,
  Note,
  NoteVersion,
  ReadingPositionAlternative,
  RecoverableSourceAnnotationDraft,
  ResolvedRecoverableSourceAnnotationDraft,
  Source,
  WorkspaceData,
} from "./types";

/** The editor keeps at most this many recoverable historical note versions. */
export const MAX_NOTE_CONFLICT_VERSIONS = 30;

export type NoteSyncSide = "local" | "remote";
export type NoteSnapshotState = "live" | "deleted" | "missing";
export type NoteSyncConflictKind = "both-edited" | "delete-vs-edit" | "ambiguous";
export type NoteSyncSafeReason =
  | "identical"
  | "local-change"
  | "remote-change"
  | "local-addition"
  | "remote-addition"
  | "local-deletion"
  | "remote-deletion";

/**
 * A conflict contains detached note snapshots. It is intentionally not a
 * WorkspaceData field: the caller must decide where a user-visible conflict
 * record is persisted before replacing either side.
 */
export interface NoteSyncConflict {
  id: string;
  noteId: string;
  kind: NoteSyncConflictKind;
  local: Note | null;
  remote: Note | null;
  base: Note | null;
  localState: NoteSnapshotState;
  remoteState: NoteSnapshotState;
}

/** A non-conflicting record that can be copied into a rebase without guessing. */
export interface SafeNoteSyncChange {
  noteId: string;
  side: NoteSyncSide;
  reason: NoteSyncSafeReason;
  note: Note | null;
}

export interface NoteSyncPlan {
  baseKnown: boolean;
  conflicts: NoteSyncConflict[];
  safe: SafeNoteSyncChange[];
}

export type NoteConflictResolutionChoice = "local" | "remote" | "manual";

export interface NoteConflictResolutionInput {
  choice: NoteConflictResolutionChoice;
  /** Required only for manual body merging. Empty content is a valid user choice. */
  content?: string;
  at: string;
  /**
   * The caller provides IDs before persistence. This keeps the helper pure and
   * prevents retries from creating an invisible new history entry.
   */
  preservedVersionIds?: Partial<Record<NoteSyncSide, string>>;
  /** Required when the losing side is deleted or absent, since NoteVersion has no tombstone. */
  preservedSnapshotIds?: Partial<Record<NoteSyncSide, string>>;
  maxVersions?: number;
}

export interface NoteConflictSnapshot {
  id: string;
  conflictId: string;
  noteId: string;
  side: NoteSyncSide;
  state: Exclude<NoteSnapshotState, "live">;
  note: Note | null;
  capturedAt: string;
}

export interface NoteConflictResolution {
  conflictId: string;
  choice: NoteConflictResolutionChoice;
  /** Null is possible only when a user intentionally chooses a missing side. */
  note: Note | null;
  /** These are already appended to `note.versions` when `note` is present. */
  preservedVersions: NoteVersion[];
  /** The caller must durably save these before applying the resolution. */
  preservedSnapshots: NoteConflictSnapshot[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export type ReadingProgressSnapshot = Pick<Source, "readPage" | "readOffset" | "lastReadAt">;

export type ReadingProgressConflictChoice = "remote" | "local";

export interface ReadingProgressSyncSelection {
  conflictId: string;
  choice: ReadingProgressConflictChoice;
}

export interface ReadingProgressSyncConflict {
  id: string;
  sourceId: string;
  sourceTitle: string;
  sourceKind: Source["kind"];
  pageCount?: number;
  base: ReadingProgressSnapshot;
  local: ReadingProgressSnapshot;
  remote: ReadingProgressSnapshot;
  localAlternatives?: ReadingPositionAlternative[];
  remoteAlternatives?: ReadingPositionAlternative[];
}

export interface SafeLocalReadingProgressChange {
  sourceId: string;
  local: ReadingProgressSnapshot;
  /** Used to reject a plan applied to a different remote candidate. */
  remote: ReadingProgressSnapshot;
  localAlternatives?: ReadingPositionAlternative[];
  remoteAlternatives?: ReadingPositionAlternative[];
  /** Only candidate history changed locally; retain the remote current position. */
  keepRemoteProgress?: true;
}

export interface ReadingProgressSyncPlan {
  baseKnown: true;
  conflicts: ReadingProgressSyncConflict[];
  /** Local-only changes that must accompany the reviewed conflict choices. */
  safeLocal: SafeLocalReadingProgressChange[];
}

function readingProgress(source: Source): ReadingProgressSnapshot {
  return {
    ...(source.readPage !== undefined ? { readPage: source.readPage } : {}),
    ...(source.readOffset !== undefined ? { readOffset: source.readOffset } : {}),
    ...(source.lastReadAt !== undefined ? { lastReadAt: source.lastReadAt } : {}),
  };
}

function sameReadingProgress(
  left: ReadingProgressSnapshot,
  right: ReadingProgressSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasReadingProgress(progress: ReadingProgressSnapshot): boolean {
  return (
    progress.readPage !== undefined ||
    progress.readOffset !== undefined ||
    progress.lastReadAt !== undefined
  );
}

function readingPositionAlternative(
  origin: ReadingPositionAlternative["origin"],
  progress: ReadingProgressSnapshot,
): ReadingPositionAlternative {
  return { origin, ...clone(progress) };
}

function readingPositionAlternatives(source: Source): ReadingPositionAlternative[] {
  return (source.readingPositionAlternatives ?? []).map((alternative) => ({
    origin: alternative.origin,
    ...(alternative.readPage !== undefined ? { readPage: alternative.readPage } : {}),
    ...(alternative.readOffset !== undefined ? { readOffset: alternative.readOffset } : {}),
    ...(alternative.lastReadAt !== undefined ? { lastReadAt: alternative.lastReadAt } : {}),
  }));
}

function sameReadingPositionAlternatives(
  left: readonly ReadingPositionAlternative[] | undefined,
  right: readonly ReadingPositionAlternative[] | undefined,
): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

function assertReadingPositionAlternatives(
  alternatives: readonly ReadingPositionAlternative[] | undefined,
  label: string,
): void {
  if (!alternatives) return;
  if (alternatives.length > 8) throw new Error(`${label}阅读位置候选过多。`);
  const snapshots = new Set<string>();
  for (const alternative of alternatives) {
    if (!(["local", "remote", "previous"] as const).includes(alternative.origin))
      throw new Error(`${label}阅读位置候选来源无效。`);
    assertReadingProgressSnapshot(alternative, `${label}候选`);
    if (!hasReadingProgress(alternative)) throw new Error(`${label}阅读位置候选为空。`);
    const key = readingProgressKey(alternative);
    if (snapshots.has(key)) throw new Error(`${label}阅读位置候选重复。`);
    snapshots.add(key);
  }
}

function readingProgressKey(progress: ReadingProgressSnapshot): string {
  return JSON.stringify([
    progress.readPage ?? null,
    progress.readOffset ?? null,
    progress.lastReadAt ?? null,
  ]);
}

function mergeReadingPositionAlternatives(
  selected: ReadingProgressSnapshot,
  local: readonly ReadingPositionAlternative[] | undefined,
  remote: readonly ReadingPositionAlternative[] | undefined,
  losing?: { origin: "local" | "remote"; progress: ReadingProgressSnapshot },
): ReadingPositionAlternative[] {
  const selectedKey = readingProgressKey(selected);
  const seen = new Set<string>();
  const merged: ReadingPositionAlternative[] = [];
  const candidates = [
    ...(losing && hasReadingProgress(losing.progress)
      ? [readingPositionAlternative(losing.origin, losing.progress)]
      : []),
    ...(local ?? []),
    ...(remote ?? []),
  ];
  for (const candidate of candidates) {
    const key = readingProgressKey(candidate);
    if (key === selectedKey || seen.has(key)) continue;
    seen.add(key);
    merged.push(clone(candidate));
    if (merged.length === 8) break;
  }
  return merged;
}

function setReadingPositionAlternatives(
  source: Source,
  alternatives: readonly ReadingPositionAlternative[],
): void {
  if (alternatives.length) source.readingPositionAlternatives = clone([...alternatives]);
  else delete source.readingPositionAlternatives;
}

function withoutReadingProgress(data: WorkspaceData): WorkspaceData {
  const next = clone(data);
  for (const source of next.sources) {
    delete source.readPage;
    delete source.readOffset;
    delete source.lastReadAt;
    delete source.readingPositionAlternatives;
  }
  return next;
}

function setReadingProgress(source: Source, progress: ReadingProgressSnapshot): void {
  delete source.readPage;
  delete source.readOffset;
  delete source.lastReadAt;
  if (progress.readPage !== undefined) source.readPage = progress.readPage;
  if (progress.readOffset !== undefined) source.readOffset = progress.readOffset;
  if (progress.lastReadAt !== undefined) source.lastReadAt = progress.lastReadAt;
}

function assertReadingProgressSnapshot(progress: ReadingProgressSnapshot, label: string): void {
  if (
    progress.readPage !== undefined &&
    (!Number.isSafeInteger(progress.readPage) || progress.readPage < 1)
  )
    throw new Error(`${label}页码无效。`);
  if (
    progress.readOffset !== undefined &&
    (!Number.isFinite(progress.readOffset) || progress.readOffset < 0)
  )
    throw new Error(`${label}正文位置无效。`);
  if (progress.lastReadAt !== undefined && !Number.isFinite(Date.parse(progress.lastReadAt)))
    throw new Error(`${label}阅读时间无效。`);
}

/**
 * Describe a reading-only three-way merge without selecting a winner.
 *
 * A common base is mandatory. The three resume fields stay together as one
 * snapshot, and two independently changed snapshots always become a conflict;
 * `lastReadAt` is display metadata and is never an ordering signal.
 */
export function planReadingProgressSyncConflicts(
  local: WorkspaceData,
  remote: WorkspaceData,
  base: WorkspaceData | null | undefined,
): ReadingProgressSyncPlan | null {
  if (!base) return null;
  const comparableRemote = withoutReadingProgress(remote);
  if (
    JSON.stringify(withoutReadingProgress(local)) !== JSON.stringify(comparableRemote) ||
    JSON.stringify(withoutReadingProgress(base)) !== JSON.stringify(comparableRemote)
  )
    return null;

  const localById = recordMap(local.sources, "本地资料");
  const baseById = recordMap(base.sources, "基线资料");
  recordMap(remote.sources, "云端资料");
  const conflicts: ReadingProgressSyncConflict[] = [];
  const safeLocal: SafeLocalReadingProgressChange[] = [];

  for (const remoteSource of remote.sources) {
    const localSource = localById.get(remoteSource.id);
    const baseSource = baseById.get(remoteSource.id);
    if (!localSource || !baseSource) return null;
    const localProgress = readingProgress(localSource);
    const remoteProgress = readingProgress(remoteSource);
    const baseProgress = readingProgress(baseSource);
    const localAlternatives = readingPositionAlternatives(localSource);
    const remoteAlternatives = readingPositionAlternatives(remoteSource);
    const alternativePatch = {
      ...(localAlternatives.length ? { localAlternatives } : {}),
      ...(remoteAlternatives.length ? { remoteAlternatives } : {}),
    };
    if (sameReadingProgress(localProgress, remoteProgress)) {
      if (!sameReadingPositionAlternatives(localAlternatives, remoteAlternatives))
        safeLocal.push({
          sourceId: remoteSource.id,
          local: clone(localProgress),
          remote: clone(remoteProgress),
          ...alternativePatch,
        });
      continue;
    }

    const localChanged = !sameReadingProgress(localProgress, baseProgress);
    const remoteChanged = !sameReadingProgress(remoteProgress, baseProgress);
    if (localChanged && remoteChanged) {
      conflicts.push({
        id: `reading-progress-conflict:${remoteSource.id}`,
        sourceId: remoteSource.id,
        sourceTitle: remoteSource.title,
        sourceKind: remoteSource.kind,
        ...(remoteSource.pageCount !== undefined ? { pageCount: remoteSource.pageCount } : {}),
        base: clone(baseProgress),
        local: clone(localProgress),
        remote: clone(remoteProgress),
        ...alternativePatch,
      });
    } else if (localChanged) {
      safeLocal.push({
        sourceId: remoteSource.id,
        local: clone(localProgress),
        remote: clone(remoteProgress),
        ...alternativePatch,
      });
    } else if (
      remoteChanged &&
      !sameReadingPositionAlternatives(localAlternatives, remoteAlternatives)
    ) {
      safeLocal.push({
        sourceId: remoteSource.id,
        local: clone(localProgress),
        remote: clone(remoteProgress),
        ...alternativePatch,
        keepRemoteProgress: true,
      });
    } else if (!remoteChanged) {
      // Canonically constructed snapshots make this unreachable, but never
      // guess if legacy data compares inconsistently.
      return null;
    }
  }

  return { baseKnown: true, conflicts, safeLocal };
}

/** Apply explicit reading-position choices to the exact reviewed remote copy. */
export function applyReadingProgressSyncResolution(
  remote: WorkspaceData,
  plan: ReadingProgressSyncPlan,
  selections: readonly ReadingProgressSyncSelection[],
  maxWorkspaceBytes = MAX_WORKSPACE_BYTES,
): WorkspaceData {
  if (plan.baseKnown !== true) throw new Error("阅读位置冲突缺少共同基线。 ");

  const conflicts = new Map<string, ReadingProgressSyncConflict>();
  const conflictSourceIds = new Set<string>();
  for (const conflict of plan.conflicts) {
    if (!conflict.id.trim() || !conflict.sourceId.trim())
      throw new Error("阅读位置冲突缺少标识。 ");
    if (conflicts.has(conflict.id)) throw new Error("阅读位置冲突标识重复。 ");
    if (conflictSourceIds.has(conflict.sourceId))
      throw new Error("同一资料存在重复的阅读位置冲突。 ");
    assertReadingProgressSnapshot(conflict.base, "基线");
    assertReadingProgressSnapshot(conflict.local, "本机");
    assertReadingProgressSnapshot(conflict.remote, "云端");
    assertReadingPositionAlternatives(conflict.localAlternatives, "本机");
    assertReadingPositionAlternatives(conflict.remoteAlternatives, "云端");
    conflicts.set(conflict.id, conflict);
    conflictSourceIds.add(conflict.sourceId);
  }

  const choices = new Map<string, ReadingProgressConflictChoice>();
  for (const selection of selections) {
    if (choices.has(selection.conflictId)) throw new Error("同一阅读位置冲突只能选择一次。 ");
    if (!conflicts.has(selection.conflictId))
      throw new Error("阅读位置冲突列表已改变，请重新检查。 ");
    if (selection.choice !== "local" && selection.choice !== "remote")
      throw new Error("阅读位置冲突选择无效。 ");
    choices.set(selection.conflictId, selection.choice);
  }
  const unresolved = plan.conflicts.find((conflict) => !choices.has(conflict.id));
  if (unresolved) throw new Error(`请先选择资料「${unresolved.sourceTitle}」的阅读位置。`);

  const next = clone(remote);
  const sources = recordMap(next.sources, "云端资料");
  const safeSourceIds = new Set<string>();
  for (const change of plan.safeLocal) {
    if (!change.sourceId.trim()) throw new Error("本机阅读位置变更缺少资料标识。 ");
    if (safeSourceIds.has(change.sourceId) || conflictSourceIds.has(change.sourceId))
      throw new Error("同一资料存在重复的阅读位置变更。 ");
    safeSourceIds.add(change.sourceId);
    assertReadingProgressSnapshot(change.local, "本机");
    assertReadingProgressSnapshot(change.remote, "云端");
    assertReadingPositionAlternatives(change.localAlternatives, "本机");
    assertReadingPositionAlternatives(change.remoteAlternatives, "云端");
    const source = sources.get(change.sourceId);
    if (
      !source ||
      !sameReadingProgress(readingProgress(source), change.remote) ||
      !sameReadingPositionAlternatives(
        readingPositionAlternatives(source),
        change.remoteAlternatives,
      )
    )
      throw new Error("云端阅读位置已改变，请重新检查。 ");
    const selected = change.keepRemoteProgress ? change.remote : change.local;
    setReadingProgress(source, selected);
    setReadingPositionAlternatives(
      source,
      mergeReadingPositionAlternatives(
        selected,
        change.localAlternatives,
        change.remoteAlternatives,
      ),
    );
  }

  for (const conflict of plan.conflicts) {
    const source = sources.get(conflict.sourceId);
    if (
      !source ||
      source.title !== conflict.sourceTitle ||
      source.kind !== conflict.sourceKind ||
      source.pageCount !== conflict.pageCount ||
      !sameReadingProgress(readingProgress(source), conflict.remote) ||
      !sameReadingPositionAlternatives(
        readingPositionAlternatives(source),
        conflict.remoteAlternatives,
      )
    )
      throw new Error("云端阅读位置已改变，请重新检查。 ");
    const choice = choices.get(conflict.id);
    const selected = choice === "local" ? conflict.local : conflict.remote;
    const losing = choice === "local" ? conflict.remote : conflict.local;
    setReadingProgress(source, selected);
    setReadingPositionAlternatives(
      source,
      mergeReadingPositionAlternatives(
        selected,
        conflict.localAlternatives,
        conflict.remoteAlternatives,
        { origin: choice === "local" ? "remote" : "local", progress: losing },
      ),
    );
  }

  assertWorkspaceCapacity(next, maxWorkspaceBytes);
  return next;
}

/**
 * Merge a conflict that contains reading-resume metadata and nothing else.
 *
 * The three fields are selected as one snapshot so a page from one browser is
 * never paired with an offset from another. A compatible common base proves a
 * one-sided change. Device clocks cannot prove which of two independently
 * changed positions is authoritative, so any uncertainty remains in the
 * normal user-visible recovery flow.
 */
export function mergeReadingProgressConflict(
  local: WorkspaceData,
  remote: WorkspaceData,
  base?: WorkspaceData | null,
  maxWorkspaceBytes = MAX_WORKSPACE_BYTES,
): WorkspaceData | null {
  try {
    const plan = planReadingProgressSyncConflicts(local, remote, base);
    if (!plan || plan.conflicts.length) return null;
    return applyReadingProgressSyncResolution(remote, plan, [], maxWorkspaceBytes);
  } catch {
    return null;
  }
}

function sameRecord(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function recordMap<T extends { id: string }>(records: readonly T[], label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const record of records) {
    if (!record.id.trim()) throw new Error(`${label}缺少标识。`);
    if (result.has(record.id)) throw new Error(`${label}标识重复：${record.id}。`);
    result.set(record.id, record);
  }
  return result;
}

function sourceIdentityMatches(base: Source, candidate: Source): boolean {
  return candidate.id === base.id && candidate.createdAt === base.createdAt;
}

function isSimpleSourceSoftDeletion(base: Source, candidate: Source): boolean {
  if (
    base.deletedAt !== null ||
    candidate.deletedAt === null ||
    !Number.isFinite(Date.parse(candidate.deletedAt)) ||
    !Number.isFinite(Date.parse(candidate.updatedAt)) ||
    !sourceIdentityMatches(base, candidate)
  )
    return false;
  const expected = clone(base);
  expected.deletedAt = candidate.deletedAt;
  expected.updatedAt = candidate.updatedAt;
  return sameRecord(candidate, expected);
}

interface SourceSoftDeletionConflict {
  sourceId: string;
  sourceDeletedAt: string;
  editedSide: NoteSyncSide;
}

interface MergedSources {
  sources: Source[];
  softDeletionConflicts: SourceSoftDeletionConflict[];
}

function sourceSoftDeletionConflict(
  base: Source,
  local: Source,
  remote: Source,
): SourceSoftDeletionConflict | null {
  const localDeleted = isSimpleSourceSoftDeletion(base, local);
  const remoteDeleted = isSimpleSourceSoftDeletion(base, remote);
  if (localDeleted === remoteDeleted) return null;
  const deleted = localDeleted ? local : remote;
  const edited = localDeleted ? remote : local;
  if (edited.deletedAt !== base.deletedAt || !sourceIdentityMatches(base, edited)) return null;
  return {
    sourceId: base.id,
    sourceDeletedAt: deleted.deletedAt!,
    editedSide: localDeleted ? "remote" : "local",
  };
}

function mergeSourcesById(
  local: WorkspaceData,
  remote: WorkspaceData,
  base: WorkspaceData,
): MergedSources | null {
  const localById = recordMap(local.sources, "本地资料");
  const remoteById = recordMap(remote.sources, "云端资料");
  const baseById = recordMap(base.sources, "基线资料");
  const ids = new Set([...baseById.keys(), ...remoteById.keys(), ...localById.keys()]);
  const mergedById = new Map<string, Source>();
  const softDeletionConflicts: SourceSoftDeletionConflict[] = [];

  for (const id of ids) {
    const localSource = localById.get(id);
    const remoteSource = remoteById.get(id);
    const baseSource = baseById.get(id);

    if (!baseSource) {
      if (localSource && remoteSource) {
        if (!sameRecord(localSource, remoteSource)) return null;
        mergedById.set(id, clone(remoteSource));
      } else if (remoteSource) mergedById.set(id, clone(remoteSource));
      else if (localSource) mergedById.set(id, clone(localSource));
      continue;
    }

    if (localSource && !sourceIdentityMatches(baseSource, localSource)) return null;
    if (remoteSource && !sourceIdentityMatches(baseSource, remoteSource)) return null;
    if (!localSource && !remoteSource) continue;

    // Source removal should normally be represented by a tombstone. A stale
    // local copy may acknowledge a server-side purge only while still equal to
    // the base; a physical local removal is never replayed automatically.
    if (!localSource) return null;
    if (!remoteSource) {
      if (!sameRecord(localSource, baseSource)) return null;
      continue;
    }

    if (sameRecord(localSource, remoteSource)) {
      mergedById.set(id, clone(remoteSource));
      continue;
    }
    const localChanged = !sameRecord(localSource, baseSource);
    const remoteChanged = !sameRecord(remoteSource, baseSource);
    const deletionConflict = sourceSoftDeletionConflict(baseSource, localSource, remoteSource);
    if (localChanged !== remoteChanged) {
      mergedById.set(id, clone(localChanged ? localSource : remoteSource));
      if (deletionConflict) softDeletionConflicts.push(deletionConflict);
      continue;
    }
    if (!localChanged) return null;

    if (!deletionConflict) return null;
    const deleted = deletionConflict.editedSide === "local" ? remoteSource : localSource;
    const edited = deletionConflict.editedSide === "local" ? localSource : remoteSource;
    // Keep the independently edited payload recoverable underneath the
    // tombstone without making the source live again.
    const retained = clone(edited);
    retained.deletedAt = deleted.deletedAt;
    retained.updatedAt = deleted.updatedAt;
    mergedById.set(id, retained);
    softDeletionConflicts.push(deletionConflict);
  }

  const result: Source[] = [];
  for (const source of remote.sources) {
    const merged = mergedById.get(source.id);
    if (merged) result.push(merged);
  }
  for (const source of local.sources) {
    if (remoteById.has(source.id)) continue;
    const merged = mergedById.get(source.id);
    if (merged) result.push(merged);
  }
  return { sources: result, softDeletionConflicts };
}

function mergeRecoverableDraftsById(
  local: WorkspaceData,
  remote: WorkspaceData,
  base: WorkspaceData,
): RecoverableSourceAnnotationDraft[] | null {
  const localById = recordMap(local.recoverableDrafts ?? [], "本地可恢复草稿");
  const remoteById = recordMap(remote.recoverableDrafts ?? [], "云端可恢复草稿");
  const baseById = recordMap(base.recoverableDrafts ?? [], "基线可恢复草稿");
  const ids = new Set([...baseById.keys(), ...remoteById.keys(), ...localById.keys()]);
  const mergedById = new Map<string, RecoverableSourceAnnotationDraft>();

  for (const id of ids) {
    const localDraft = localById.get(id);
    const remoteDraft = remoteById.get(id);
    const baseDraft = baseById.get(id);
    if (!baseDraft) {
      if (localDraft && remoteDraft) {
        if (!sameRecord(localDraft, remoteDraft)) return null;
        mergedById.set(id, clone(remoteDraft));
      } else if (remoteDraft) mergedById.set(id, clone(remoteDraft));
      else if (localDraft) mergedById.set(id, clone(localDraft));
      continue;
    }

    // Recovery records are immutable. Removing one means the learner already
    // restored, saved, or discarded it; an unchanged stale device must not
    // resurrect that record on its next sync.
    if (localDraft && !sameRecord(localDraft, baseDraft)) return null;
    if (remoteDraft && !sameRecord(remoteDraft, baseDraft)) return null;
    if (localDraft && remoteDraft) mergedById.set(id, clone(baseDraft));
  }

  const result: RecoverableSourceAnnotationDraft[] = [];
  for (const draft of remote.recoverableDrafts ?? []) {
    const merged = mergedById.get(draft.id);
    if (merged) result.push(merged);
  }
  for (const draft of local.recoverableDrafts ?? []) {
    if (remoteById.has(draft.id)) continue;
    const merged = mergedById.get(draft.id);
    if (merged) result.push(merged);
  }
  return result;
}

function mergeResolvedRecoverableDraftsById(
  local: WorkspaceData,
  remote: WorkspaceData,
  base: WorkspaceData,
): ResolvedRecoverableSourceAnnotationDraft[] | null {
  const localById = recordMap(local.resolvedRecoverableDrafts ?? [], "本地已处理草稿标记");
  const remoteById = recordMap(remote.resolvedRecoverableDrafts ?? [], "云端已处理草稿标记");
  const baseById = recordMap(base.resolvedRecoverableDrafts ?? [], "基线已处理草稿标记");
  const ids = new Set([...baseById.keys(), ...remoteById.keys(), ...localById.keys()]);
  const mergedById = new Map<string, ResolvedRecoverableSourceAnnotationDraft>();

  for (const id of ids) {
    const candidates = [baseById.get(id), remoteById.get(id), localById.get(id)].filter(
      (candidate): candidate is ResolvedRecoverableSourceAnnotationDraft => Boolean(candidate),
    );
    const selected = candidates[0]!;
    if (candidates.some((candidate) => !sameRecord(candidate, selected))) return null;
    mergedById.set(id, clone(selected));
  }

  const result: ResolvedRecoverableSourceAnnotationDraft[] = [];
  const appended = new Set<string>();
  for (const records of [
    remote.resolvedRecoverableDrafts ?? [],
    local.resolvedRecoverableDrafts ?? [],
    base.resolvedRecoverableDrafts ?? [],
  ])
    for (const marker of records) {
      if (appended.has(marker.id)) continue;
      result.push(clone(mergedById.get(marker.id)!));
      appended.add(marker.id);
    }
  return result;
}

function changedAnnotationDrafts(
  conflict: SourceSoftDeletionConflict,
  local: WorkspaceData,
  remote: WorkspaceData,
  base: WorkspaceData,
  sources: readonly Source[],
): RecoverableSourceAnnotationDraft[] {
  const edited = conflict.editedSide === "local" ? local : remote;
  const baseById = recordMap(base.annotations, "基线标注");
  const source = sources.find((candidate) => candidate.id === conflict.sourceId);
  if (!source || source.deletedAt !== conflict.sourceDeletedAt)
    throw new Error("删除资料的合并结果已变化，不能生成可恢复草稿。");

  const result: RecoverableSourceAnnotationDraft[] = [];
  for (const annotation of edited.annotations) {
    if (annotation.sourceId !== conflict.sourceId || !annotation.note.trim()) continue;
    const baseAnnotation = baseById.get(annotation.id);
    if (baseAnnotation && annotation.note === baseAnnotation.note) continue;
    if (baseAnnotation && !annotationIdentityMatches(baseAnnotation, annotation))
      throw new Error("离线批注身份已变化，不能自动生成可恢复草稿。");
    result.push(
      createRecoverableSourceAnnotationDraft(source, conflict.sourceDeletedAt, annotation),
    );
  }
  return result;
}

function addGeneratedRecoverableDrafts(
  current: readonly RecoverableSourceAnnotationDraft[],
  generated: readonly RecoverableSourceAnnotationDraft[],
  resolved: readonly ResolvedRecoverableSourceAnnotationDraft[],
): RecoverableSourceAnnotationDraft[] | null {
  const resolvedIds = new Set(resolved.map((marker) => marker.id));
  const result = current.filter((draft) => !resolvedIds.has(draft.id)).map(clone);
  const byId = new Map(result.map((draft) => [draft.id, draft]));
  for (const draft of generated) {
    if (resolvedIds.has(draft.id)) continue;
    const existing = byId.get(draft.id);
    if (existing) {
      if (!sameRecord(existing, draft)) return null;
      continue;
    }
    const detached = clone(draft);
    result.push(detached);
    byId.set(detached.id, detached);
  }
  return result;
}

function removeAnnotationsHandledByRecoveryMarkers(
  annotations: readonly Annotation[],
  sources: readonly Source[],
  resolved: readonly ResolvedRecoverableSourceAnnotationDraft[],
): Annotation[] {
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  return annotations
    .filter((annotation) => {
      const source = sourcesById.get(annotation.sourceId);
      return !resolved.some(
        (marker) =>
          marker.annotationId === annotation.id &&
          marker.sourceId === annotation.sourceId &&
          (marker.annotationDisposition === "remove" ||
            (marker.annotationDisposition === undefined &&
              (!source || source.deletedAt === marker.sourceDeletedAt))),
      );
    })
    .map(clone);
}

function annotationIdentityMatches(base: Annotation, candidate: Annotation): boolean {
  return (
    candidate.id === base.id &&
    candidate.sourceId === base.sourceId &&
    candidate.versionId === base.versionId &&
    candidate.quote === base.quote &&
    candidate.page === base.page &&
    sameAnnotationTextAnchor(candidate.textAnchor, base.textAnchor) &&
    candidate.createdAt === base.createdAt
  );
}

function mergeAnnotationsById(
  local: WorkspaceData,
  remote: WorkspaceData,
  base: WorkspaceData,
): Annotation[] | null {
  const localById = recordMap(local.annotations, "本地标注");
  const remoteById = recordMap(remote.annotations, "云端标注");
  const baseById = recordMap(base.annotations, "基线标注");
  const ids = new Set([...baseById.keys(), ...remoteById.keys(), ...localById.keys()]);
  const mergedById = new Map<string, Annotation>();

  for (const id of ids) {
    const localAnnotation = localById.get(id);
    const remoteAnnotation = remoteById.get(id);
    const baseAnnotation = baseById.get(id);

    if (!baseAnnotation) {
      if (localAnnotation && remoteAnnotation) {
        if (!sameRecord(localAnnotation, remoteAnnotation)) return null;
        mergedById.set(id, clone(remoteAnnotation));
      } else if (remoteAnnotation) mergedById.set(id, clone(remoteAnnotation));
      else if (localAnnotation) mergedById.set(id, clone(localAnnotation));
      continue;
    }

    if (localAnnotation && !annotationIdentityMatches(baseAnnotation, localAnnotation)) return null;
    if (remoteAnnotation && !annotationIdentityMatches(baseAnnotation, remoteAnnotation))
      return null;
    if (!localAnnotation && !remoteAnnotation) continue;
    if (sameRecord(localAnnotation ?? null, remoteAnnotation ?? null)) {
      mergedById.set(id, clone(remoteAnnotation!));
      continue;
    }

    const localChanged = !sameRecord(localAnnotation ?? null, baseAnnotation);
    const remoteChanged = !sameRecord(remoteAnnotation ?? null, baseAnnotation);
    if (localChanged === remoteChanged) return null;
    const selected = localChanged ? localAnnotation : remoteAnnotation;
    if (selected) mergedById.set(id, clone(selected));
  }

  const result: Annotation[] = [];
  for (const annotation of remote.annotations) {
    const merged = mergedById.get(annotation.id);
    if (merged) result.push(merged);
  }
  for (const annotation of local.annotations) {
    if (remoteById.has(annotation.id)) continue;
    const merged = mergedById.get(annotation.id);
    if (merged) result.push(merged);
  }
  return result;
}

function withoutIndependentCollections(data: WorkspaceData): WorkspaceData {
  const comparable = { ...data };
  delete comparable.recoverableDrafts;
  delete comparable.resolvedRecoverableDrafts;
  return {
    ...comparable,
    sources: [],
    notes: [],
    annotations: [],
    recoverableDrafts: [],
    resolvedRecoverableDrafts: [],
  };
}

function sourceVersionExists(
  sources: readonly Source[],
  sourceId: string,
  versionId: string,
): boolean {
  const source = sources.find((candidate) => candidate.id === sourceId);
  return Boolean(
    source &&
    (source.versionId === versionId ||
      source.versions?.some((version) => version.versionId === versionId)),
  );
}

function noteReferencesAvailableSources(note: Note, sources: readonly Source[]): boolean {
  const snapshots = [note, ...note.versions];
  return snapshots.every(
    (snapshot) =>
      (snapshot.citations ?? []).every((citation) =>
        sourceVersionExists(sources, citation.sourceId, citation.versionId),
      ) &&
      (snapshot.manualExcerptRefs ?? []).every((reference) =>
        sourceVersionExists(sources, reference.sourceId, reference.versionId),
      ),
  );
}

function annotationReferencesAvailableSource(
  annotation: Annotation,
  sources: readonly Source[],
): boolean {
  if (annotation.textAnchor === undefined)
    return sourceVersionExists(sources, annotation.sourceId, annotation.versionId);
  const source = sources.find((candidate) => candidate.id === annotation.sourceId);
  const versions = source
    ? [source, ...(source.versions ?? [])].filter(
        (version) => version.versionId === annotation.versionId,
      )
    : [];
  return versions.length === 1 && annotationTextAnchorMatches(versions[0].text, annotation);
}

/**
 * Reapply independent object-level changes onto the latest cloud snapshot.
 *
 * The common base is mandatory. Collections without an explicit merge policy
 * must be unchanged on both sides, and every uncertain record-level case is
 * left to the existing user-visible conflict recovery flow.
 */
export function rebaseIndependentWorkspaceChanges(
  local: WorkspaceData,
  remote: WorkspaceData,
  base: WorkspaceData | null | undefined,
  maxWorkspaceBytes = MAX_WORKSPACE_BYTES,
): WorkspaceData | null {
  try {
    if (!base) return null;
    const comparableBase = withoutIndependentCollections(base);
    if (
      !sameRecord(withoutIndependentCollections(local), comparableBase) ||
      !sameRecord(withoutIndependentCollections(remote), comparableBase)
    )
      return null;

    const sourceMerge = mergeSourcesById(local, remote, base);
    const mergedAnnotations = mergeAnnotationsById(local, remote, base);
    const existingRecoverableDrafts = mergeRecoverableDraftsById(local, remote, base);
    const resolvedRecoverableDrafts = mergeResolvedRecoverableDraftsById(local, remote, base);
    if (
      !sourceMerge ||
      !mergedAnnotations ||
      !existingRecoverableDrafts ||
      !resolvedRecoverableDrafts
    )
      return null;
    const { sources } = sourceMerge;
    const generatedRecoverableDrafts = sourceMerge.softDeletionConflicts.flatMap((conflict) =>
      changedAnnotationDrafts(conflict, local, remote, base, sources),
    );
    const recoverableDrafts = addGeneratedRecoverableDrafts(
      existingRecoverableDrafts,
      generatedRecoverableDrafts,
      resolvedRecoverableDrafts,
    );
    if (!recoverableDrafts) return null;
    const annotations = removeAnnotationsHandledByRecoveryMarkers(
      mergedAnnotations,
      sources,
      resolvedRecoverableDrafts,
    );

    const notePlan = planNoteSyncConflicts(local, remote, base);
    if (notePlan.conflicts.length) return null;
    const localNoteChanges = notePlan.safe.filter(
      (change) => change.side === "local" && change.reason !== "identical",
    );
    if (localNoteChanges.some((change) => !change.note)) return null;
    const mergedNotes = applySafeNoteSyncChanges(remote, localNoteChanges, maxWorkspaceBytes).notes;
    if (
      annotations.some((annotation) => !annotationReferencesAvailableSource(annotation, sources)) ||
      localNoteChanges.some(
        (change) => change.note && !noteReferencesAvailableSources(change.note, sources),
      )
    )
      return null;
    const merged: WorkspaceData = {
      ...clone(remote),
      sources,
      annotations,
      recoverableDrafts,
      resolvedRecoverableDrafts,
      notes: mergedNotes,
    };
    assertWorkspaceCapacity(merged, maxWorkspaceBytes);
    return merged;
  } catch {
    return null;
  }
}

function requireText(value: string | undefined, label: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(`${label}不能为空。`);
  return normalized;
}

function requireTimestamp(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label}必须是有效时间。`);
  return value;
}

function noteState(note: Note | null): NoteSnapshotState {
  if (!note) return "missing";
  return note.deletedAt ? "deleted" : "live";
}

function comparableNote(note: Note | null): unknown {
  if (!note) return null;
  return {
    id: note.id,
    spaceId: note.spaceId,
    title: note.title,
    content: note.content,
    kind: note.kind,
    aiGenerated: note.aiGenerated ?? false,
    contentRevision: note.contentRevision ?? 0,
    status: note.status,
    citations: note.citations,
    manualExcerptRefs: note.manualExcerptRefs ?? [],
    versions: note.versions,
    createdAt: note.createdAt,
    deletedAt: note.deletedAt,
  };
}

function sameNote(left: Note | null, right: Note | null): boolean {
  return JSON.stringify(comparableNote(left)) === JSON.stringify(comparableNote(right));
}

function noteMap(data: WorkspaceData): Map<string, Note> {
  const result = new Map<string, Note>();
  for (const note of data.notes) {
    if (!note.id.trim()) throw new Error("笔记缺少标识，无法安全处理同步冲突。");
    if (result.has(note.id)) throw new Error(`笔记标识重复：${note.id}。`);
    result.set(note.id, note);
  }
  return result;
}

function safeReason(
  side: NoteSyncSide,
  note: Note | null,
  base: Note | null,
  identical = false,
): NoteSyncSafeReason {
  if (identical) return "identical";
  if (!base && note) return side === "local" ? "local-addition" : "remote-addition";
  if (noteState(note) !== "live") return side === "local" ? "local-deletion" : "remote-deletion";
  return side === "local" ? "local-change" : "remote-change";
}

function conflictKind(local: Note | null, remote: Note | null): NoteSyncConflictKind {
  if (noteState(local) === "live" && noteState(remote) === "live") return "both-edited";
  if (noteState(local) === "live" || noteState(remote) === "live") return "delete-vs-edit";
  return "ambiguous";
}

function conflictId(noteId: string): string {
  return `note-conflict:${requireText(noteId, "笔记标识")}`;
}

/**
 * Derive a conservative object-level plan. Without a common base, any
 * different record with the same ID is a conflict; this is intentional because
 * timestamps cannot prove which editor made the meaningful change.
 */
export function planNoteSyncConflicts(
  local: WorkspaceData,
  remote: WorkspaceData,
  base?: WorkspaceData | null,
): NoteSyncPlan {
  const localNotes = noteMap(local);
  const remoteNotes = noteMap(remote);
  const baseNotes = base ? noteMap(base) : new Map<string, Note>();
  const ids = new Set([...localNotes.keys(), ...remoteNotes.keys(), ...baseNotes.keys()]);
  const conflicts: NoteSyncConflict[] = [];
  const safe: SafeNoteSyncChange[] = [];

  for (const id of [...ids].sort()) {
    const localNote = localNotes.get(id) ?? null;
    const remoteNote = remoteNotes.get(id) ?? null;
    const baseNote = baseNotes.get(id) ?? null;
    if (sameNote(localNote, remoteNote)) {
      if (localNote || remoteNote)
        safe.push({
          noteId: id,
          side: localNote ? "local" : "remote",
          reason: safeReason(
            localNote ? "local" : "remote",
            localNote ?? remoteNote,
            baseNote,
            true,
          ),
          note: clone(localNote ?? remoteNote),
        });
      continue;
    }

    if (base) {
      const localChanged = !sameNote(localNote, baseNote);
      const remoteChanged = !sameNote(remoteNote, baseNote);
      if (localChanged !== remoteChanged) {
        const side: NoteSyncSide = localChanged ? "local" : "remote";
        const note = localChanged ? localNote : remoteNote;
        safe.push({
          noteId: id,
          side,
          reason: safeReason(side, note, baseNote),
          note: clone(note),
        });
        continue;
      }
    }

    conflicts.push({
      id: conflictId(id),
      noteId: id,
      kind: conflictKind(localNote, remoteNote),
      local: clone(localNote),
      remote: clone(remoteNote),
      base: clone(baseNote),
      localState: noteState(localNote),
      remoteState: noteState(remoteNote),
    });
  }
  return { baseKnown: Boolean(base), conflicts, safe };
}

function toVersion(note: Note, id: string, at: string): NoteVersion {
  return {
    id: requireText(id, "保留版本标识"),
    title: note.title,
    content: note.content,
    savedAt: requireTimestamp(note.updatedAt || at, "原笔记更新时间"),
    citations: clone(note.citations),
    status: note.status,
    aiGenerated: note.aiGenerated ?? false,
    spaceId: note.spaceId,
    contentRevision: note.contentRevision ?? 0,
    ...(note.manualExcerptRefs !== undefined
      ? { manualExcerptRefs: clone(note.manualExcerptRefs) }
      : {}),
  };
}

function requireVersionId(input: NoteConflictResolutionInput, side: NoteSyncSide): string {
  return requireText(
    input.preservedVersionIds?.[side],
    `${side === "local" ? "本地" : "云端"}保留版本标识`,
  );
}

function requireSnapshotId(input: NoteConflictResolutionInput, side: NoteSyncSide): string {
  return requireText(
    input.preservedSnapshotIds?.[side],
    `${side === "local" ? "本地" : "云端"}冲突快照标识`,
  );
}

function revisionOf(note: Note | null): number {
  const value = note?.contentRevision ?? 0;
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER - 1)
    throw new Error("笔记版本已无法安全解决冲突，请先导出副本。");
  return value;
}

function appendVersions(note: Note, versions: NoteVersion[], maxVersions: number): Note {
  if (!Number.isSafeInteger(maxVersions) || maxVersions < 1)
    throw new Error("笔记历史版本上限无效。");
  const currentIds = new Set(note.versions.map((version) => version.id));
  for (const version of versions) {
    if (currentIds.has(version.id)) throw new Error("保留版本标识已存在，不能覆盖历史内容。");
    currentIds.add(version.id);
  }
  if (note.versions.length + versions.length > maxVersions)
    throw new Error("保留冲突版本会超过笔记历史上限；请先导出或清理后再解决。");
  return { ...note, versions: [...clone(note.versions), ...clone(versions)] };
}

function mergeExistingVersions(incoming: Note, existing: Note | undefined): Note {
  const merged = clone(incoming.versions);
  const byId = new Map(merged.map((version) => [version.id, version]));
  if (byId.size !== merged.length) throw new Error("安全变更包含重复的历史版本标识。");
  for (const version of existing?.versions ?? []) {
    const known = byId.get(version.id);
    if (!known) {
      merged.push(clone(version));
      byId.set(version.id, version);
      continue;
    }
    if (JSON.stringify(known) !== JSON.stringify(version))
      throw new Error("同一历史版本标识对应不同内容，不能安全覆盖。");
  }
  if (merged.length > MAX_NOTE_CONFLICT_VERSIONS)
    throw new Error("保留已有历史版本会超过笔记历史上限；请先导出或清理后再同步。");
  return { ...clone(incoming), versions: merged };
}

function assertWorkspaceCapacity(data: WorkspaceData, maxWorkspaceBytes: number): void {
  if (!Number.isSafeInteger(maxWorkspaceBytes) || maxWorkspaceBytes < 1)
    throw new Error("工作区容量上限无效。");
  if (new TextEncoder().encode(JSON.stringify(data)).byteLength > maxWorkspaceBytes)
    throw new Error("保存同步结果会超过工作区 3 MiB 容量；双方内容均未丢弃。");
}

function snapshot(
  conflict: NoteSyncConflict,
  side: NoteSyncSide,
  note: Note | null,
  input: NoteConflictResolutionInput,
): NoteConflictSnapshot {
  const state = noteState(note);
  if (state === "live") throw new Error("可阅读的冲突笔记必须保留为历史版本。");
  return {
    id: requireSnapshotId(input, side),
    conflictId: conflict.id,
    noteId: conflict.noteId,
    side,
    state,
    note: clone(note),
    capturedAt: requireTimestamp(input.at, "解决时间"),
  };
}

/**
 * Resolve one disclosed conflict without silently discarding either alternative.
 * Manual resolution keeps local metadata and only replaces the body; both
 * original live bodies become retained versions for later inspection.
 */
export function resolveNoteSyncConflict(
  conflict: NoteSyncConflict,
  input: NoteConflictResolutionInput,
): NoteConflictResolution {
  const at = requireTimestamp(input.at, "解决时间");
  const maxVersions = input.maxVersions ?? MAX_NOTE_CONFLICT_VERSIONS;
  const local = clone(conflict.local);
  const remote = clone(conflict.remote);
  const versions: NoteVersion[] = [];
  const snapshots: NoteConflictSnapshot[] = [];

  if (input.choice === "manual") {
    if (noteState(local) !== "live" || noteState(remote) !== "live")
      throw new Error("删除冲突不能自动重新创建笔记，请选择保留删除或可阅读版本。");
    if (input.content === undefined) throw new Error("手动合并需要提供正文。");
    versions.push(toVersion(local!, requireVersionId(input, "local"), at));
    versions.push(toVersion(remote!, requireVersionId(input, "remote"), at));
    const merged: Note = {
      ...local!,
      content: input.content,
      contentRevision: Math.max(revisionOf(local), revisionOf(remote)) + 1,
      updatedAt: at,
    };
    const note = appendVersions(merged, versions, maxVersions);
    return {
      conflictId: conflict.id,
      choice: input.choice,
      note,
      preservedVersions: clone(versions),
      preservedSnapshots: snapshots,
    };
  }

  const selectedSide = input.choice;
  const rejectedSide: NoteSyncSide = selectedSide === "local" ? "remote" : "local";
  const selected = selectedSide === "local" ? local : remote;
  const rejected = rejectedSide === "local" ? local : remote;
  if (rejected && noteState(rejected) === "live")
    versions.push(toVersion(rejected, requireVersionId(input, rejectedSide), at));
  else snapshots.push(snapshot(conflict, rejectedSide, rejected, input));

  if (!selected) {
    snapshots.push(snapshot(conflict, selectedSide, selected, input));
    return {
      conflictId: conflict.id,
      choice: input.choice,
      note: null,
      preservedVersions: clone(versions),
      preservedSnapshots: snapshots,
    };
  }

  const resolved: Note = {
    ...selected,
    contentRevision: Math.max(revisionOf(local), revisionOf(remote)) + 1,
    updatedAt: at,
  };
  const note = appendVersions(resolved, versions, maxVersions);
  return {
    conflictId: conflict.id,
    choice: input.choice,
    note,
    preservedVersions: clone(versions),
    preservedSnapshots: snapshots,
  };
}

/**
 * Rebase only locally-originated safe changes onto the latest remote workspace.
 * A physical missing note is rejected: callers must materialize a tombstone or
 * disclose a separate deletion operation rather than silently removing history.
 */
export function applySafeNoteSyncChanges(
  data: WorkspaceData,
  changes: readonly SafeNoteSyncChange[],
  maxWorkspaceBytes = MAX_WORKSPACE_BYTES,
): WorkspaceData {
  const next = clone(data);
  const seen = new Set<string>();
  for (const change of changes) {
    if (change.side !== "local") throw new Error("只能将本地安全变更重新应用到最新云端工作区。");
    const noteId = requireText(change.noteId, "安全变更笔记标识");
    if (seen.has(noteId)) throw new Error(`同一笔记不能重复应用安全变更：${noteId}。`);
    seen.add(noteId);
    if (!change.note) throw new Error("缺少删除墓碑，不能静默移除笔记或其历史版本。");
    if (change.note.id !== noteId) throw new Error("安全变更的笔记标识不一致。");
    const index = next.notes.findIndex((note) => note.id === noteId);
    const existing = index < 0 ? undefined : next.notes[index];
    const merged = mergeExistingVersions(change.note, existing);
    if (index < 0) next.notes.push(merged);
    else next.notes[index] = merged;
  }
  assertWorkspaceCapacity(next, maxWorkspaceBytes);
  return next;
}

/**
 * Apply a resolution only when every losing state fits in the current workspace
 * schema. Callers with independent snapshots must persist them first and then
 * retry; this deliberately prevents a UI from silently dropping a tombstone.
 */
export function applyNoteSyncResolution(
  data: WorkspaceData,
  resolution: NoteConflictResolution,
  maxWorkspaceBytes = MAX_WORKSPACE_BYTES,
): WorkspaceData {
  if (resolution.preservedSnapshots.length)
    throw new Error("这项解决方案包含独立冲突快照，必须先持久化快照后才能应用。");
  if (!resolution.note) throw new Error("缺少可写入的笔记，不能安全应用此冲突解决方案。");
  const next = clone(data);
  const index = next.notes.findIndex((note) => note.id === resolution.note!.id);
  const existing = index < 0 ? undefined : next.notes[index];
  const merged = mergeExistingVersions(resolution.note, existing);
  if (index >= 0) next.notes[index] = merged;
  else next.notes.push(merged);
  assertWorkspaceCapacity(next, maxWorkspaceBytes);
  return next;
}
