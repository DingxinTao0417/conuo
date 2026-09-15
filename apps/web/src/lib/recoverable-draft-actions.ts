import type {
  Annotation,
  Note,
  RecoverableSourceAnnotationDraft,
  ResolvedRecoverableSourceAnnotationDraft,
  Source,
  WorkspaceData,
} from "./types";
import { resolveRecoverableSourceAnnotationDraft } from "./recoverable-drafts";
import { annotationTextAnchorMatches, sameAnnotationTextAnchor } from "./annotations";

function requireTimestamp(value: string, label: string) {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label}无效，请刷新后重试。`);
  return value;
}

function requireDraft(data: WorkspaceData, draftId: string) {
  const drafts = data.recoverableDrafts ?? [];
  const matches = drafts.filter((draft) => draft.id === draftId);
  if (matches.length !== 1) throw new Error("这份可恢复草稿已变化，请刷新回收站后重试。");
  const draft = matches[0];
  const source = data.sources.find((candidate) => candidate.id === draft.sourceId);
  const annotation = data.annotations.find((candidate) => candidate.id === draft.annotationId);
  if (!source || source.deletedAt !== draft.sourceDeletedAt)
    throw new Error("原资料的回收站状态已变化，请刷新后重试。");
  if (!annotationMatchesDraft(annotation, draft))
    throw new Error("原批注已变化，请刷新回收站后重试。");
  requireAnchoredSource(source, annotation);
  return { draft, source, annotation };
}

function annotationMatchesDraft(
  annotation: Annotation | undefined,
  draft: RecoverableSourceAnnotationDraft,
): annotation is Annotation {
  return Boolean(
    annotation &&
    annotation.sourceId === draft.sourceId &&
    annotation.versionId === draft.sourceVersionId &&
    annotation.createdAt === draft.annotationCreatedAt &&
    annotation.quote === draft.quote &&
    annotation.note === draft.note &&
    annotation.page === draft.page &&
    sameAnnotationTextAnchor(annotation.textAnchor, draft.textAnchor),
  );
}

function requireAnchoredSource(source: Source, annotation: Annotation) {
  if (annotation.textAnchor === undefined) return;
  const versions = [source, ...(source.versions ?? [])].filter(
    (version) => version.versionId === annotation.versionId,
  );
  if (versions.length !== 1 || !annotationTextAnchorMatches(versions[0].text, annotation))
    throw new Error("批注原文位置与保留资料不一致，请刷新后重试。");
}

function escaped(value: string) {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function paragraph(value: string) {
  return `<p>${escaped(value).replace(/\r?\n/gu, "<br>")}</p>`;
}

function recoveredNoteTitle(sourceTitle: string) {
  const title = `从「${sourceTitle.trim() || "已删除资料"}」恢复的批注`;
  return title.length <= 512 ? title : `${title.slice(0, 511)}…`;
}

function recoveredNoteContent(draft: RecoverableSourceAnnotationDraft) {
  const location = draft.page === undefined ? "" : ` · 第 ${draft.page} 页`;
  return [
    paragraph(draft.note),
    "<hr>",
    paragraph(`恢复自已删除资料「${draft.sourceTitle}」${location}`),
    `<blockquote>${paragraph(draft.quote)}</blockquote>`,
  ].join("");
}

function noteSpaceId(data: WorkspaceData, source: Source) {
  return (
    source.spaceIds.find((spaceId) =>
      data.spaces.some((space) => space.id === spaceId && !space.archived),
    ) ?? "inbox"
  );
}

function withoutDraftAndAnnotation(data: WorkspaceData, draft: RecoverableSourceAnnotationDraft) {
  const resolved = resolveMarker(data.resolvedRecoverableDrafts ?? [], draft, "remove");
  return {
    ...data,
    annotations: data.annotations.filter((annotation) => annotation.id !== draft.annotationId),
    recoverableDrafts: (data.recoverableDrafts ?? []).filter(
      (candidate) => candidate.id !== draft.id,
    ),
    resolvedRecoverableDrafts: resolved,
  };
}

function resolveMarker(
  current: readonly ResolvedRecoverableSourceAnnotationDraft[],
  draft: RecoverableSourceAnnotationDraft,
  annotationDisposition: "retain" | "remove",
) {
  const marker = resolveRecoverableSourceAnnotationDraft(draft, annotationDisposition);
  const existing = current.find((candidate) => candidate.id === marker.id);
  if (existing && JSON.stringify(existing) !== JSON.stringify(marker))
    throw new Error("这份草稿的处理记录已变化，请刷新后重试。");
  return existing ? [...current] : [...current, marker];
}

/**
 * Restore the deleted source and make all of its detached annotations ordinary
 * reader annotations again. Every recovery marker for that deletion is then
 * resolved atomically with the source update.
 */
export function restoreSourceAndResolveDrafts(
  data: WorkspaceData,
  sourceId: string,
  expectedDeletedAt: string,
  restoredAt: string,
): WorkspaceData {
  requireTimestamp(expectedDeletedAt, "资料删除时间");
  requireTimestamp(restoredAt, "资料恢复时间");
  const source = data.sources.find((candidate) => candidate.id === sourceId);
  if (!source || source.deletedAt !== expectedDeletedAt)
    throw new Error("资料的回收站状态已变化，请刷新后重试。");
  const sourceDrafts = (data.recoverableDrafts ?? []).filter(
    (draft) => draft.sourceId === source.id,
  );
  for (const draft of sourceDrafts) {
    const annotation = data.annotations.find((candidate) => candidate.id === draft.annotationId);
    if (draft.sourceDeletedAt !== expectedDeletedAt || !annotationMatchesDraft(annotation, draft))
      throw new Error("原批注已变化，请刷新回收站后重试。");
    requireAnchoredSource(source, annotation);
  }
  const resolvedRecoverableDrafts = sourceDrafts.reduce(
    (markers, draft) => resolveMarker(markers, draft, "retain"),
    [...(data.resolvedRecoverableDrafts ?? [])],
  );
  return {
    ...data,
    sources: data.sources.map((candidate) =>
      candidate.id === source.id
        ? { ...candidate, deletedAt: null, updatedAt: restoredAt }
        : candidate,
    ),
    recoverableDrafts: (data.recoverableDrafts ?? []).filter(
      (draft) => draft.sourceId !== source.id,
    ),
    resolvedRecoverableDrafts,
  };
}

export function restoreSourceFromRecoverableDraft(
  data: WorkspaceData,
  draftId: string,
  restoredAt: string,
): WorkspaceData {
  const { draft } = requireDraft(data, draftId);
  return restoreSourceAndResolveDrafts(data, draft.sourceId, draft.sourceDeletedAt, restoredAt);
}

/**
 * Keep the deleted source in the recycle bin, detach the recovered text from
 * its annotation, and save a normal user note with inert source context.
 */
export function saveRecoverableDraftAsNote(
  data: WorkspaceData,
  draftId: string,
  noteId: string,
  savedAt: string,
): { data: WorkspaceData; note: Note } {
  requireTimestamp(savedAt, "笔记保存时间");
  if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(noteId) || data.notes.some((note) => note.id === noteId))
    throw new Error("新笔记标识无效，请重试。");
  const { draft, source } = requireDraft(data, draftId);
  const note: Note = {
    id: noteId,
    spaceId: noteSpaceId(data, source),
    title: recoveredNoteTitle(draft.sourceTitle),
    content: recoveredNoteContent(draft),
    kind: "note",
    aiGenerated: false,
    status: "accepted",
    citations: [],
    versions: [],
    createdAt: savedAt,
    updatedAt: savedAt,
    deletedAt: null,
  };
  const cleaned = withoutDraftAndAnnotation(data, draft);
  return { data: { ...cleaned, notes: [note, ...cleaned.notes] }, note };
}

/** Explicitly discard only the detached annotation text; the source stays deleted. */
export function discardRecoverableDraft(data: WorkspaceData, draftId: string): WorkspaceData {
  const { draft } = requireDraft(data, draftId);
  return withoutDraftAndAnnotation(data, draft);
}
