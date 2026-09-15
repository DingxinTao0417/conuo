import type { Citation, Source, SourceVersion, WorkspaceData } from "./types";
import type { ConceptRelation } from "./concept-relation-types";

export interface ArchivedSourceVersionDeletionImpact {
  source: Pick<Source, "id" | "title">;
  version: Pick<SourceVersion, "versionId" | "filename" | "createdAt" | "archivedAt">;
  /** Annotations without a saved note are derived highlights and are removed. */
  annotations: number;
  /** Annotations containing user-authored notes must be handled first. */
  blockingAnnotations: number;
  /** Notes remain readable; their historical citations retain the original quote. */
  retainedNotes: number;
  retainedNoteCitations: number;
  /** Conversations remain readable; their historical citations retain the original quote. */
  retainedConversations: number;
  retainedConversationCitations: number;
  /** Finished AI organization records tied to the version are removed. */
  organizationJobs: number;
  /** Active organization work must finish or be stopped before removal. */
  blockingOrganizationJobs: number;
  /** AI-generated relations tied to the version are removed. */
  conceptRelations: number;
  /** Manually saved relations must be handled first. */
  blockingConceptRelations: number;
  /** Finished import records tied to the version are removed. */
  importJobs: number;
  /** Parsing work for the version must finish or be stopped first. */
  blockingImportJobs: number;
  /** Immutable originals that become unreferenced in this browser. */
  localOriginals: number;
  /** Immutable originals queued for trusted cloud Storage cleanup. */
  cloudOriginals: number;
}

export interface ArchivedSourceVersionDeletionBlockers {
  annotations: string[];
  conceptRelations: string[];
  organizationJobs: string[];
  importJobs: string[];
}

export interface ArchivedSourceVersionDeletionResult {
  data: WorkspaceData;
  impact: ArchivedSourceVersionDeletionImpact;
  blobKeys: string[];
  storagePaths: string[];
}

function historicalVersion(data: WorkspaceData, sourceId: string, versionId: string) {
  const source = data.sources.find((item) => item.id === sourceId);
  if (!source || source.deletedAt) throw new Error("资料已删除或不可用，请返回资料库检查。");
  if (source.versionId === versionId)
    throw new Error("当前版本不能单独清理，请先恢复其他版本或彻底删除资料。");
  const matches = source.versions?.filter((item) => item.versionId === versionId) ?? [];
  if (matches.length !== 1) throw new Error("这个历史版本不存在或记录重复，未改变资料。");
  return { source, version: matches[0] };
}

function citesVersion(
  citations: readonly Citation[] | undefined,
  sourceId: string,
  versionId: string,
) {
  return (citations ?? []).filter(
    (citation) => citation.sourceId === sourceId && citation.versionId === versionId,
  ).length;
}

function relationReferencesVersion(relation: ConceptRelation, sourceId: string, versionId: string) {
  return (
    citesVersion(relation.fromCitations, sourceId, versionId) > 0 ||
    citesVersion(relation.toCitations, sourceId, versionId) > 0
  );
}

function dependencies(data: WorkspaceData, sourceId: string, versionId: string) {
  const annotations = data.annotations.filter(
    (annotation) => annotation.sourceId === sourceId && annotation.versionId === versionId,
  );
  const blockingAnnotations = annotations.filter((annotation) => annotation.note.trim().length > 0);
  const notes = data.notes.filter(
    (note) =>
      citesVersion(note.citations, sourceId, versionId) +
        note.versions.reduce(
          (count, noteVersion) => count + citesVersion(noteVersion.citations, sourceId, versionId),
          0,
        ) >
      0,
  );
  const conversations = data.conversations.filter((conversation) =>
    conversation.messages.some(
      (message) => citesVersion(message.citations, sourceId, versionId) > 0,
    ),
  );
  const organizationJobs = (data.organizationJobs ?? []).filter((job) =>
    job.request.sourceVersions.some(
      (candidate) => candidate.sourceId === sourceId && candidate.versionId === versionId,
    ),
  );
  const blockingOrganizationJobs = organizationJobs.filter((job) =>
    ["queued", "running"].includes(job.status),
  );
  const conceptRelations = (data.conceptRelations ?? []).filter((relation) =>
    relationReferencesVersion(relation, sourceId, versionId),
  );
  const blockingConceptRelations = conceptRelations.filter(
    (relation) => relation.origin === "manual",
  );
  const importJobs = (data.importJobs ?? []).filter(
    (job) => job.sourceId === sourceId && job.versionId === versionId,
  );
  const blockingImportJobs = importJobs.filter((job) => ["queued", "running"].includes(job.status));
  return {
    annotations,
    blockingAnnotations,
    notes,
    conversations,
    organizationJobs,
    blockingOrganizationJobs,
    conceptRelations,
    blockingConceptRelations,
    importJobs,
    blockingImportJobs,
  };
}

export function archivedSourceVersionDeletionBlockers(
  data: WorkspaceData,
  sourceId: string,
  versionId: string,
): ArchivedSourceVersionDeletionBlockers {
  historicalVersion(data, sourceId, versionId);
  const found = dependencies(data, sourceId, versionId);
  return {
    annotations: found.blockingAnnotations.map((item) => item.id),
    conceptRelations: found.blockingConceptRelations.map((item) => item.id),
    organizationJobs: found.blockingOrganizationJobs.map((item) => item.id),
    importJobs: found.blockingImportJobs.map((item) => item.id),
  };
}

export function previewArchivedSourceVersionDeletion(
  data: WorkspaceData,
  sourceId: string,
  versionId: string,
): ArchivedSourceVersionDeletionImpact {
  const { source, version } = historicalVersion(data, sourceId, versionId);
  const found = dependencies(data, sourceId, versionId);
  return {
    source: { id: source.id, title: source.title },
    version: {
      versionId: version.versionId,
      filename: version.filename,
      createdAt: version.createdAt,
      archivedAt: version.archivedAt,
    },
    annotations: found.annotations.length - found.blockingAnnotations.length,
    blockingAnnotations: found.blockingAnnotations.length,
    retainedNotes: found.notes.length,
    retainedNoteCitations: found.notes.reduce(
      (count, note) =>
        count +
        citesVersion(note.citations, sourceId, versionId) +
        note.versions.reduce(
          (total, noteVersion) => total + citesVersion(noteVersion.citations, sourceId, versionId),
          0,
        ),
      0,
    ),
    retainedConversations: found.conversations.length,
    retainedConversationCitations: found.conversations.reduce(
      (count, conversation) =>
        count +
        conversation.messages.reduce(
          (total, message) => total + citesVersion(message.citations, sourceId, versionId),
          0,
        ),
      0,
    ),
    organizationJobs: found.organizationJobs.length - found.blockingOrganizationJobs.length,
    blockingOrganizationJobs: found.blockingOrganizationJobs.length,
    conceptRelations: found.conceptRelations.length - found.blockingConceptRelations.length,
    blockingConceptRelations: found.blockingConceptRelations.length,
    importJobs: found.importJobs.length - found.blockingImportJobs.length,
    blockingImportJobs: found.blockingImportJobs.length,
    localOriginals: version.blobKey ? 1 : 0,
    cloudOriginals: version.storagePath ? 1 : 0,
  };
}

/**
 * Pure representation of the transaction committed by the cloud RPC. It is used for
 * validation and tests; the user-facing action always uses the server transaction so
 * normalized chunks and the Storage outbox cannot get out of sync with this snapshot.
 */
export function deleteArchivedSourceVersion(
  data: WorkspaceData,
  sourceId: string,
  versionId: string,
): ArchivedSourceVersionDeletionResult {
  const { source, version } = historicalVersion(data, sourceId, versionId);
  const blockers = archivedSourceVersionDeletionBlockers(data, sourceId, versionId);
  if (Object.values(blockers).some((ids) => ids.length))
    throw new Error("这个历史版本仍有已保存内容或进行中的任务，请先处理后再清理。");
  const impact = previewArchivedSourceVersionDeletion(data, sourceId, versionId);
  const found = dependencies(data, sourceId, versionId);
  const organizationJobIds = new Set(found.organizationJobs.map((job) => job.id));
  const relationIds = new Set(found.conceptRelations.map((relation) => relation.id));
  const importJobIds = new Set(found.importJobs.map((job) => job.id));
  return {
    impact,
    blobKeys: version.blobKey ? [version.blobKey] : [],
    storagePaths: version.storagePath ? [version.storagePath] : [],
    data: {
      ...data,
      sources: data.sources.map((item) =>
        item.id === source.id
          ? {
              ...item,
              versions: item.versions?.filter((candidate) => candidate.versionId !== versionId),
            }
          : item,
      ),
      annotations: data.annotations.filter(
        (annotation) => annotation.sourceId !== sourceId || annotation.versionId !== versionId,
      ),
      ...(data.organizationJobs
        ? {
            organizationJobs: data.organizationJobs.filter(
              (job) => !organizationJobIds.has(job.id),
            ),
          }
        : {}),
      ...(data.conceptRelations
        ? {
            conceptRelations: data.conceptRelations.filter(
              (relation) => !relationIds.has(relation.id),
            ),
          }
        : {}),
      ...(data.importJobs
        ? { importJobs: data.importJobs.filter((job) => !importJobIds.has(job.id)) }
        : {}),
    },
  };
}
