import { questionContextKey } from "./question-context";
import { resolveCitation } from "./retrieval";
import { organizationRequestSchema } from "./organization-schema";
import { knowledgeUpdateTargetReason, snapshotKnowledgeNote } from "./knowledge-update";
import { relationTargetsReason } from "./concept-relations";
import type {
  OrganizationJob,
  OrganizationRequest,
  OrganizationResult,
} from "./organization-types";
import type { AnswerRequest, Citation, Note, WorkspaceData } from "./types";

/** A summary-shaped request selects a bounded sample from every chosen source. */
export function organizationQuestion(request: OrganizationRequest): AnswerRequest {
  return {
    requestId: request.requestId,
    question: `概括并整理所选资料${request.topic ? `，关注主题：${request.topic}` : ""}`,
    scope: "sources",
    sourceIds: request.sourceIds,
    spaceId: request.spaceId,
  };
}

/** Comparison key only. It must be used alongside authenticated scope checks. */
export function organizationContextKey(data: WorkspaceData, request: OrganizationRequest): string {
  const target =
    request.kind === "update" || request.kind === "relations"
      ? data.notes.find((note) => note.id === request.targetNote?.id)
      : undefined;
  const compare =
    request.kind === "relations"
      ? data.notes.find((note) => note.id === request.compareNote?.id)
      : undefined;
  return JSON.stringify({
    kind: request.kind,
    trigger: request.trigger,
    versions: [...request.sourceVersions].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    automatic: request.trigger === "automatic" ? data.autoOrganize === true : null,
    evidence: questionContextKey(data, organizationQuestion(request)),
    ...(request.kind === "update" || request.kind === "relations"
      ? {
          targetBasis: request.targetNote ?? null,
          target: target
            ? {
                note: snapshotKnowledgeNote(target),
                kind: target.kind,
                deletedAt: target.deletedAt,
              }
            : null,
        }
      : {}),
    ...(request.kind === "relations"
      ? {
          compareBasis: request.compareNote ?? null,
          compare: compare
            ? {
                note: snapshotKnowledgeNote(compare),
                kind: compare.kind,
                deletedAt: compare.deletedAt,
              }
            : null,
        }
      : {}),
  });
}

function sourceBoundaryReason(data: WorkspaceData, request: OrganizationRequest): string {
  if (!organizationRequestSchema.safeParse(request).success)
    return "整理范围或版本格式无效，请重新选择资料。";
  if (
    request.spaceId !== "inbox" &&
    !data.spaces.some((space) => space.id === request.spaceId && !space.archived)
  )
    return "所选知识库已不可用，请切换知识库。";
  for (const basis of request.sourceVersions) {
    const source = data.sources.find((item) => item.id === basis.sourceId);
    if (!source || source.deletedAt) return "部分资料已删除或无法访问，这份建议已失效。";
    if (source.versionId !== basis.versionId) return "资料版本已改变，请基于当前版本重新生成。";
    if (
      request.spaceId === "inbox"
        ? source.spaceIds.length !== 0
        : !source.spaceIds.includes(request.spaceId)
    )
      return "部分资料已离开所选知识库，请重新选择范围。";
    if (
      !(source.status === "ready" || source.status === "partial") ||
      !source.text.trim() ||
      !source.chunks.length
    )
      return "部分资料尚未提取出可用文字，暂时无法整理。";
  }
  return "";
}

export function organizationUnavailableReason(
  data: WorkspaceData,
  request: OrganizationRequest,
): string {
  const reason = sourceBoundaryReason(data, request);
  if (reason) return reason;
  if (request.kind === "update") {
    const targetReason = knowledgeUpdateTargetReason(data, request);
    if (targetReason) return targetReason;
  }
  if (request.kind === "relations") {
    const targetsReason = relationTargetsReason(data, request);
    if (targetsReason) return targetsReason;
  }
  if (!data.aiEnabled) return "AI 使用已关闭，开启后才能生成整理建议。";
  if (request.trigger === "automatic" && data.autoOrganize !== true)
    return "自动整理已关闭，不再创建或继续自动分析任务。";
  if (request.sourceIds.some((id) => !data.sources.find((source) => source.id === id)?.aiAllowed))
    return "部分资料不允许 AI 使用，本次未整理。";
  return "";
}

export function organizationCitations(result: OrganizationResult): Citation[] {
  if (result.kind === "update") return result.changes.flatMap((change) => change.citations);
  if (result.kind === "relations")
    return result.relations.flatMap((relation) => [
      ...relation.fromCitations,
      ...relation.toCitations,
    ]);
  return result.kind === "source"
    ? [
        ...result.summary.citations,
        ...result.tags.flatMap((tag) => tag.citations),
        ...result.topics.flatMap((topic) => topic.citations),
      ]
    : result.pages.flatMap((page) => page.citations);
}

function citationCurrent(data: WorkspaceData, citation: Citation): boolean {
  const resolved = resolveCitation(data, citation);
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  return (
    !!resolved &&
    !!normalize(citation.quote) &&
    normalize(resolved.source.text).includes(normalize(citation.quote)) &&
    resolved.chunk.page === citation.page &&
    resolved.chunk.section === citation.section
  );
}

export function knowledgeAcceptanceReason(data: WorkspaceData, note: Note): string {
  if (!note.aiGenerated) return "";
  if (!note.citations.length || note.citations.some((citation) => !citationCurrent(data, citation)))
    return "这份 AI 草稿的原文依据已失效。正文仍保留；请根据当前资料重新生成并核对后再接受。";
  return "";
}

/** Existing results remain readable with AI off; only current evidence may be applied. */
export function organizationReviewReason(data: WorkspaceData, job: OrganizationJob): string {
  if (job.status !== "ready" || !job.result) return "这项整理建议尚不可审核。";
  const reason = sourceBoundaryReason(data, job.request);
  if (reason) return reason;
  const allowed = new Set(job.request.sourceIds);
  if (
    organizationCitations(job.result).some(
      (citation) => !allowed.has(citation.sourceId) || !citationCurrent(data, citation),
    )
  )
    return "建议的原文引用已变化，请重新生成后再审核。";
  return "";
}
