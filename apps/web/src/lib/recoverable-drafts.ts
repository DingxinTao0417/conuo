import { annotationTextAnchorMatches } from "./annotations";
import type {
  Annotation,
  RecoverableSourceAnnotationDraft,
  ResolvedRecoverableSourceAnnotationDraft,
  Source,
} from "./types";

/**
 * Derive a bounded ID from identities already persisted in the conflicting
 * snapshots. Using the deletion instant makes a retry idempotent while still
 * allowing a later restore-and-delete cycle to create a new recovery record.
 */
export function recoverableSourceAnnotationDraftId(
  annotationId: string,
  sourceDeletedAt: string,
): string {
  const deletedAt = Date.parse(sourceDeletedAt);
  if (!Number.isFinite(deletedAt)) throw new Error("资料删除时间无效，不能生成可恢复草稿。");
  return `deleted-source-${annotationId}-${deletedAt.toString(36)}`;
}

function sourceVersionExists(source: Source, versionId: string): boolean {
  return (
    source.versionId === versionId ||
    Boolean(source.versions?.some((version) => version.versionId === versionId))
  );
}

/** Create an exact, detached copy of the user's annotation text and context. */
export function createRecoverableSourceAnnotationDraft(
  source: Source,
  sourceDeletedAt: string,
  annotation: Annotation,
): RecoverableSourceAnnotationDraft {
  if (source.deletedAt !== sourceDeletedAt) throw new Error("可恢复草稿必须绑定当前资料删除事件。");
  if (annotation.sourceId !== source.id || !sourceVersionExists(source, annotation.versionId))
    throw new Error("批注与删除资料的版本不一致，不能生成可恢复草稿。");
  if (!annotation.note.trim()) throw new Error("批注没有可恢复的人工文字。");
  if (!annotation.quote.trim()) throw new Error("批注缺少原文上下文，不能生成可恢复草稿。");
  if (!Number.isFinite(Date.parse(annotation.createdAt)))
    throw new Error("批注创建时间无效，不能生成可恢复草稿。");
  if (annotation.textAnchor !== undefined) {
    const versions = [source, ...(source.versions ?? [])].filter(
      (version) => version.versionId === annotation.versionId,
    );
    if (versions.length !== 1 || !annotationTextAnchorMatches(versions[0].text, annotation))
      throw new Error("批注原文位置与保留资料不一致，不能生成可恢复草稿。");
  }
  return {
    id: recoverableSourceAnnotationDraftId(annotation.id, sourceDeletedAt),
    kind: "source-annotation",
    reason: "source-deleted-during-offline-edit",
    sourceId: source.id,
    sourceVersionId: annotation.versionId,
    sourceTitle: source.title,
    sourceDeletedAt,
    annotationId: annotation.id,
    annotationCreatedAt: annotation.createdAt,
    quote: annotation.quote,
    note: annotation.note,
    ...(annotation.page !== undefined ? { page: annotation.page } : {}),
    ...(annotation.textAnchor !== undefined ? { textAnchor: { ...annotation.textAnchor } } : {}),
    capturedAt: sourceDeletedAt,
  };
}

/** Create the deterministic, append-only acknowledgement for a handled draft. */
export function resolveRecoverableSourceAnnotationDraft(
  draft: Pick<
    RecoverableSourceAnnotationDraft,
    "id" | "sourceId" | "annotationId" | "sourceDeletedAt"
  >,
  annotationDisposition: "retain" | "remove",
): ResolvedRecoverableSourceAnnotationDraft {
  const expectedId = recoverableSourceAnnotationDraftId(draft.annotationId, draft.sourceDeletedAt);
  if (draft.id !== expectedId) throw new Error("可恢复草稿标识与删除事件不一致。");
  return {
    id: expectedId,
    sourceId: draft.sourceId,
    annotationId: draft.annotationId,
    sourceDeletedAt: draft.sourceDeletedAt,
    annotationDisposition,
  };
}
