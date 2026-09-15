import type { AnswerScopeSnapshot, Citation, Note, Source, WorkspaceData } from "./types";

export interface PermanentSourceDeletionSelection {
  noteIds: string[];
  conversationIds: string[];
}

export interface PermanentSourceDeletionContent {
  version: 1;
  notes: { id: string; title: string; kind: "note" | "knowledge"; versions: number }[];
  conversations: { id: string; title: string; messages: number }[];
  selection: PermanentSourceDeletionSelection;
}

export interface PermanentSourceDeletionImpact {
  source: Pick<Source, "id" | "title" | "deletedAt">;
  /** The live source plus every retained original version that will be removed. */
  versions: number;
  /** Direct, version-bound annotations that can be discarded with the source. */
  annotations: number;
  /** Annotations with user-authored text that must be saved or explicitly discarded first. */
  blockingAnnotations: number;
  /** User-owned notes and historical versions that remain after source references are removed. */
  retainedNotes: number;
  /** Normal citations plus manual-excerpt identities that point to the source. */
  retainedNoteCitations: number;
  /** User-owned question threads that will remain, with unavailable citations. */
  retainedConversations: number;
  retainedConversationCitations: number;
  /** Explicitly selected saved documents, including their current and historical bodies. */
  removedNotes?: number;
  removedNoteVersions?: number;
  removedConversations?: number;
  removedMessages?: number;
  /** Generated or pending work that directly references the source and will be discarded. */
  organizationJobs: number;
  pendingOrganizationJobs: number;
  /** AI-derived concept relations that directly cite the source and will be discarded. */
  conceptRelations: number;
  /** Manually saved concept relations that need the user's explicit decision. */
  blockingConceptRelations: number;
  /** Parsing and indexing work that cannot run after its source is removed. */
  importJobs: number;
  /** Immutable originals scheduled for local-browser cleanup after the metadata commit. */
  localOriginals: number;
  /** Immutable originals scheduled for cloud Storage cleanup after the metadata commit. */
  cloudOriginals: number;
}

export interface PermanentSourceDeletionBlockers {
  annotations: string[];
  conceptRelations: string[];
}

export interface PermanentSourceDeletionResult {
  data: WorkspaceData;
  impact: PermanentSourceDeletionImpact;
  blobKeys: string[];
  storagePaths: string[];
}

function sourceForPermanentDeletion(data: WorkspaceData, sourceId: string): Source {
  const source = data.sources.find((item) => item.id === sourceId);
  if (!source) throw new Error("这份资料已不存在，请刷新回收站后重试。");
  if (!source.deletedAt) throw new Error("请先将资料移入回收站，再执行彻底删除。");
  return source;
}

function citesSource(citations: readonly Citation[] | undefined, sourceId: string): number {
  return citations?.filter((citation) => citation.sourceId === sourceId).length ?? 0;
}

function noteEvidenceForSource(
  evidence: readonly { sourceId: string }[] | undefined,
  sourceId: string,
): number {
  return evidence?.filter((item) => item.sourceId === sourceId).length ?? 0;
}

function conversationSourceEvidenceCount(
  conversation: WorkspaceData["conversations"][number],
  sourceId: string,
): number {
  return conversation.messages.reduce(
    (count, message) =>
      count +
      citesSource(message.citations, sourceId) +
      noteEvidenceForSource(message.noteEvidence, sourceId),
    0,
  );
}

function attemptReferencesSource(
  message: WorkspaceData["conversations"][number]["messages"][number],
  sourceId: string,
) {
  return scopeReferencesSource(message.attempt?.scopeSnapshot, sourceId);
}

function comparisonReferencesSource(
  comparison: { leftSourceId: string; rightSourceId: string } | undefined,
  sourceId: string,
) {
  return comparison?.leftSourceId === sourceId || comparison?.rightSourceId === sourceId;
}

function scopeReferencesSource(snapshot: AnswerScopeSnapshot | undefined, sourceId: string) {
  return Boolean(
    snapshot &&
    (snapshot.sourceId === sourceId ||
      snapshot.sourceIds.includes(sourceId) ||
      snapshot.sourceVersions?.some((version) => version.sourceId === sourceId) ||
      comparisonReferencesSource(snapshot.comparison, sourceId)),
  );
}

function removeSourceCitations(citations: readonly Citation[] | undefined, sourceId: string) {
  return citations?.filter((citation) => citation.sourceId !== sourceId) ?? [];
}

function manualExcerptReferenceCount(
  references: readonly { sourceId: string }[] | undefined,
  sourceId: string,
): number {
  return references?.filter((reference) => reference.sourceId === sourceId).length ?? 0;
}

function removeManualExcerptReferences<T extends { sourceId: string }>(
  references: readonly T[] | undefined,
  sourceId: string,
): T[] {
  return references?.filter((reference) => reference.sourceId !== sourceId) ?? [];
}

function noteCitationCount(note: Note, sourceId: string): number {
  return (
    citesSource(note.citations, sourceId) +
    manualExcerptReferenceCount(note.manualExcerptRefs, sourceId) +
    note.versions.reduce(
      (count, version) =>
        count +
        citesSource(version.citations, sourceId) +
        manualExcerptReferenceCount(version.manualExcerptRefs, sourceId),
      0,
    )
  );
}

/** Generated records are not independent user documents. Discard an entire record if it cites a purged source. */
function containsSourceReference(
  value: unknown,
  sourceId: string,
  visited = new WeakSet<object>(),
): boolean {
  if (!value || typeof value !== "object") return false;
  if (visited.has(value)) return false;
  visited.add(value);
  if (Array.isArray(value))
    return value.some((item) => containsSourceReference(item, sourceId, visited));
  if ("sourceId" in value && value.sourceId === sourceId) return true;
  if ("sourceIds" in value && Array.isArray(value.sourceIds) && value.sourceIds.includes(sourceId))
    return true;
  if ("leftSourceId" in value && value.leftSourceId === sourceId) return true;
  if ("rightSourceId" in value && value.rightSourceId === sourceId) return true;
  return Object.values(value).some((item) => containsSourceReference(item, sourceId, visited));
}

/** Follow exact structured note identities; user body strings are never associations. */
function containsSelectedNoteReference(value: unknown, selected: ReadonlySet<string>): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value))
    return value.some((item) => containsSelectedNoteReference(item, selected));
  for (const [key, child] of Object.entries(value)) {
    if (
      (key === "noteId" || key === "targetNoteId") &&
      typeof child === "string" &&
      selected.has(child)
    )
      return true;
    if (
      ["targetNote", "compareNote", "target", "compare", "note", "from", "to"].includes(key) &&
      child &&
      typeof child === "object" &&
      "id" in child &&
      typeof child.id === "string" &&
      selected.has(child.id)
    )
      return true;
    if (containsSelectedNoteReference(child, selected)) return true;
  }
  return false;
}

function sourceVersionHandles(source: Source) {
  const versions = [source, ...(source.versions ?? [])];
  return {
    blobKeys: [
      ...new Set(versions.flatMap((version) => (version.blobKey ? [version.blobKey] : []))),
    ],
    storagePaths: [
      ...new Set(versions.flatMap((version) => (version.storagePath ? [version.storagePath] : []))),
    ],
  };
}

function associatedDocuments(data: WorkspaceData, sourceId: string) {
  const notes = data.notes.filter((note) => noteCitationCount(note, sourceId) > 0);
  const conversations = data.conversations.filter(
    (conversation) =>
      conversation.sourceId === sourceId ||
      conversation.sourceIds.includes(sourceId) ||
      comparisonReferencesSource(conversation.comparison, sourceId) ||
      conversationSourceEvidenceCount(conversation, sourceId) > 0 ||
      conversation.messages.some((message) => attemptReferencesSource(message, sourceId)),
  );
  return { notes, conversations };
}

function validatedSelection(
  candidates: ReturnType<typeof associatedDocuments>,
  selection: PermanentSourceDeletionSelection | undefined,
): PermanentSourceDeletionSelection {
  if (selection === undefined) return { noteIds: [], conversationIds: [] };
  if (
    !selection ||
    typeof selection !== "object" ||
    Array.isArray(selection) ||
    Object.keys(selection).length !== 2 ||
    !Object.hasOwn(selection, "noteIds") ||
    !Object.hasOwn(selection, "conversationIds")
  )
    throw new Error("关联内容删除选择格式无效，请重新选择。");
  const result = { noteIds: [] as string[], conversationIds: [] as string[] };
  for (const key of ["noteIds", "conversationIds"] as const) {
    const ids = selection[key];
    if (
      !Array.isArray(ids) ||
      ids.length > (key === "noteIds" ? 10000 : 5000) ||
      ids.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) ||
      new Set(ids).size !== ids.length
    )
      throw new Error("关联内容删除选择含重复或无效标识，请重新选择。");
    const valid = new Set(
      candidates[key === "noteIds" ? "notes" : "conversations"].map((item) => item.id),
    );
    if (ids.some((id) => !valid.has(id)))
      throw new Error("所选内容已不属于这份资料的关联内容，请刷新后重新选择。");
    result[key] = [...ids].sort();
  }
  return result;
}

function deletionDependencies(
  data: WorkspaceData,
  sourceId: string,
  selection?: PermanentSourceDeletionSelection,
) {
  const candidates = associatedDocuments(data, sourceId);
  const selected = validatedSelection(candidates, selection);
  const selectedNoteIds = new Set(selected.noteIds);
  const selectedConversationIds = new Set(selected.conversationIds);
  const organizationJobs =
    data.organizationJobs?.filter(
      (job) =>
        containsSourceReference(job, sourceId) ||
        containsSelectedNoteReference(job, selectedNoteIds),
    ) ?? [];
  const conceptRelations =
    data.conceptRelations?.filter(
      (relation) =>
        containsSourceReference(relation, sourceId) ||
        selectedNoteIds.has(relation.from.id) ||
        selectedNoteIds.has(relation.to.id),
    ) ?? [];
  const annotations = data.annotations.filter((annotation) => annotation.sourceId === sourceId);
  const importJobs = data.importJobs?.filter((job) => job.sourceId === sourceId) ?? [];
  const blockingAnnotations = annotations.filter((annotation) => annotation.note.trim().length > 0);
  const blockingConceptRelations = conceptRelations.filter(
    (relation) => relation.origin === "manual",
  );
  return {
    annotations,
    blockingAnnotations,
    notes: candidates.notes.filter((note) => !selectedNoteIds.has(note.id)),
    conversations: candidates.conversations.filter(
      (conversation) => !selectedConversationIds.has(conversation.id),
    ),
    removedNotes: candidates.notes.filter((note) => selectedNoteIds.has(note.id)),
    removedConversations: candidates.conversations.filter((conversation) =>
      selectedConversationIds.has(conversation.id),
    ),
    candidates,
    selection: selected,
    organizationJobs,
    conceptRelations,
    blockingConceptRelations,
    importJobs,
  };
}

export function permanentSourceDeletionBlockers(
  data: WorkspaceData,
  sourceId: string,
  selection?: PermanentSourceDeletionSelection,
): PermanentSourceDeletionBlockers {
  sourceForPermanentDeletion(data, sourceId);
  const dependencies = deletionDependencies(data, sourceId, selection);
  return {
    annotations: dependencies.blockingAnnotations.map((annotation) => annotation.id),
    conceptRelations: dependencies.blockingConceptRelations.map((relation) => relation.id),
  };
}

function assertNoPermanentDeletionBlockers(
  data: WorkspaceData,
  sourceId: string,
  selection?: PermanentSourceDeletionSelection,
) {
  const blockers = permanentSourceDeletionBlockers(data, sourceId, selection);
  if (blockers.annotations.length || blockers.conceptRelations.length)
    throw new Error(
      "这份资料仍有你保存的批注或手工关系。请先另存内容，或明确删除这些关联内容后再彻底删除。",
    );
}

/**
 * Bind reviewed choices to every exact related body and identity, even when
 * timestamps and counts have not changed. Unrelated user documents are absent.
 */
export function permanentSourceDeletionFingerprint(
  data: WorkspaceData,
  sourceId: string,
  selection?: PermanentSourceDeletionSelection,
): string {
  const source = sourceForPermanentDeletion(data, sourceId);
  const dependencies = deletionDependencies(data, sourceId, selection);
  const handles = sourceVersionHandles(source);
  const ordered = <T extends { id: string }>(items: readonly T[]) =>
    [...items].sort((left, right) => left.id.localeCompare(right.id));
  return JSON.stringify({
    source,
    selection: dependencies.selection,
    handles,
    annotations: ordered(dependencies.annotations),
    notes: ordered(dependencies.candidates.notes),
    conversations: ordered(dependencies.candidates.conversations),
    organizationJobs: ordered(dependencies.organizationJobs),
    conceptRelations: ordered(dependencies.conceptRelations),
    importJobs: ordered(dependencies.importJobs),
  });
}

/** Candidate identities come only from explicit source references, never body text. */
export function previewPermanentSourceDeletionContent(
  data: WorkspaceData,
  sourceId: string,
  selection?: PermanentSourceDeletionSelection,
): PermanentSourceDeletionContent {
  sourceForPermanentDeletion(data, sourceId);
  const candidates = associatedDocuments(data, sourceId);
  return {
    version: 1,
    notes: candidates.notes.map((note) => ({
      id: note.id,
      title: note.title,
      kind: note.kind,
      versions: 1 + note.versions.length,
    })),
    conversations: candidates.conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      messages: conversation.messages.length,
    })),
    selection: validatedSelection(candidates, selection),
  };
}

/** Show every traceable effect before deleting a recycled source. */
export function previewPermanentSourceDeletion(
  data: WorkspaceData,
  sourceId: string,
  selection?: PermanentSourceDeletionSelection,
): PermanentSourceDeletionImpact {
  const source = sourceForPermanentDeletion(data, sourceId);
  const dependencies = deletionDependencies(data, sourceId, selection);
  const handles = sourceVersionHandles(source);
  return {
    source: { id: source.id, title: source.title, deletedAt: source.deletedAt },
    versions: 1 + (source.versions?.length ?? 0),
    annotations: dependencies.annotations.length - dependencies.blockingAnnotations.length,
    blockingAnnotations: dependencies.blockingAnnotations.length,
    retainedNotes: dependencies.notes.length,
    retainedNoteCitations: dependencies.notes.reduce(
      (count, note) => count + noteCitationCount(note, sourceId),
      0,
    ),
    retainedConversations: dependencies.conversations.length,
    retainedConversationCitations: dependencies.conversations.reduce(
      (count, conversation) => count + conversationSourceEvidenceCount(conversation, sourceId),
      0,
    ),
    removedNotes: dependencies.removedNotes.length,
    removedNoteVersions: dependencies.removedNotes.reduce(
      (count, note) => count + 1 + note.versions.length,
      0,
    ),
    removedConversations: dependencies.removedConversations.length,
    removedMessages: dependencies.removedConversations.reduce(
      (count, conversation) => count + conversation.messages.length,
      0,
    ),
    organizationJobs: dependencies.organizationJobs.length,
    pendingOrganizationJobs: dependencies.organizationJobs.filter((job) =>
      ["queued", "running"].includes(job.status),
    ).length,
    conceptRelations:
      dependencies.conceptRelations.length - dependencies.blockingConceptRelations.length,
    blockingConceptRelations: dependencies.blockingConceptRelations.length,
    importJobs: dependencies.importJobs.length,
    localOriginals: handles.blobKeys.length,
    cloudOriginals: handles.storagePaths.length,
  };
}

/**
 * Remove a recycled source and every traceable system-derived record. User
 * notes and conversation text stay intact unless explicitly selected. Source citations are stripped so a
 * future model call cannot revive a deleted source by reference; personal-note
 * snapshots remain visibly historical and are never a new-answer input.
 */
export function permanentlyDeleteSource(
  data: WorkspaceData,
  sourceId: string,
  selection?: PermanentSourceDeletionSelection,
): PermanentSourceDeletionResult {
  const source = sourceForPermanentDeletion(data, sourceId);
  assertNoPermanentDeletionBlockers(data, sourceId, selection);
  const impact = previewPermanentSourceDeletion(data, sourceId, selection);
  const dependencies = deletionDependencies(data, sourceId, selection);
  const handles = sourceVersionHandles(source);
  const jobIds = new Set(dependencies.organizationJobs.map((job) => job.id));
  const relationIds = new Set(dependencies.conceptRelations.map((relation) => relation.id));
  const importJobIds = new Set(dependencies.importJobs.map((job) => job.id));
  const noteIds = new Set(dependencies.selection.noteIds);
  const conversationIds = new Set(dependencies.selection.conversationIds);
  return {
    impact,
    blobKeys: handles.blobKeys,
    storagePaths: handles.storagePaths,
    data: {
      ...data,
      sources: data.sources.filter((item) => item.id !== sourceId),
      annotations: data.annotations.filter((item) => item.sourceId !== sourceId),
      notes: data.notes
        .filter((note) => !noteIds.has(note.id))
        .map((note) => ({
          ...note,
          citations: removeSourceCitations(note.citations, sourceId),
          ...(note.manualExcerptRefs !== undefined
            ? {
                manualExcerptRefs: removeManualExcerptReferences(note.manualExcerptRefs, sourceId),
              }
            : {}),
          versions: note.versions.map((version) => ({
            ...version,
            ...(version.citations !== undefined
              ? { citations: removeSourceCitations(version.citations, sourceId) }
              : {}),
            ...(version.manualExcerptRefs !== undefined
              ? {
                  manualExcerptRefs: removeManualExcerptReferences(
                    version.manualExcerptRefs,
                    sourceId,
                  ),
                }
              : {}),
          })),
        })),
      conversations: data.conversations
        .filter((conversation) => !conversationIds.has(conversation.id))
        .map((conversation) => {
          const removesPrimary = conversation.sourceId === sourceId;
          const invalidatesComparison =
            conversation.comparison?.leftSourceId === sourceId ||
            conversation.comparison?.rightSourceId === sourceId;
          // Keep a purged comparison's immutable pair identity solely as history.
          // The comparison route resolver rejects the missing side, while the
          // normal reader continues to exclude this explicitly marked thread.
          const sourceIds = invalidatesComparison
            ? [...conversation.sourceIds]
            : conversation.sourceIds.filter((id) => id !== sourceId);
          return {
            ...conversation,
            ...(removesPrimary ? { sourceId: undefined } : {}),
            sourceIds,
            ...(removesPrimary &&
            (conversation.scope === "document" || conversation.scope === "document-notes")
              ? { scope: "sources" }
              : {}),
            messages: conversation.messages.map((message) => ({
              ...message,
              citations: removeSourceCitations(message.citations, sourceId),
              ...(attemptReferencesSource(message, sourceId) && message.attempt
                ? {
                    attempt: {
                      ...message.attempt,
                      unavailableReason: "source-purged" as const,
                    },
                  }
                : {}),
            })),
          };
        }),
      ...(data.importJobs
        ? { importJobs: data.importJobs.filter((job) => !importJobIds.has(job.id)) }
        : {}),
      ...(data.organizationJobs
        ? { organizationJobs: data.organizationJobs.filter((job) => !jobIds.has(job.id)) }
        : {}),
      ...(data.conceptRelations
        ? {
            conceptRelations: data.conceptRelations.filter(
              (relation) => !relationIds.has(relation.id),
            ),
          }
        : {}),
    },
  };
}
