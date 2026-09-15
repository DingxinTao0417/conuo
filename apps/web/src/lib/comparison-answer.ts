import { answerRequestSchema } from "./supabase/validation";
import type { AnswerRequest, Source, Space } from "./types";

/**
 * A resolved side of the side-by-side reader. `isCurrentVersion` comes from
 * the route resolver, rather than being inferred from a title or a snapshot's
 * text. This keeps a retained version readable but unavailable for new AI
 * requests.
 */
export interface ComparisonAnswerSource {
  source: Source;
  isCurrentVersion: boolean;
}

/** The already-resolved, two-source boundary for one comparison question. */
export interface ComparisonAnswerScope {
  space: Space;
  left: ComparisonAnswerSource;
  right: ComparisonAnswerSource;
}

export interface CreateComparisonAnswerRequest extends ComparisonAnswerScope {
  question: string;
  /**
   * The caller owns the attempt identity. Keep it stable for one retry; the
   * model transport requires it before it reserves a paid generation.
   */
  requestId?: string;
}

export type ComparisonAnswerRequestReason =
  | "empty-question"
  | "invalid-request"
  | "notes-not-allowed"
  | "scope-not-sources"
  | "source-id-not-allowed"
  | "selection-not-allowed"
  | "source-ids-mismatch"
  | "source-versions-mismatch"
  | "comparison-mismatch"
  | "space-mismatch"
  | "space-archived"
  | "same-source"
  | "source-recycled"
  | "source-not-in-space"
  | "historical-version"
  | "source-ai-disabled"
  | "source-not-ready";

const reasonMessage: Record<ComparisonAnswerRequestReason, string> = {
  "empty-question": "请输入要比较的问题。",
  "invalid-request": "对照问答请求格式无效，请重新发起问题。",
  "notes-not-allowed": "对照问答只能使用两份资料，不能附带笔记。",
  "scope-not-sources": "对照问答只能限定为两份资料。",
  "source-id-not-allowed": "对照问答不能混入单份资料范围。",
  "selection-not-allowed": "对照问答不能混入选段。",
  "source-ids-mismatch": "对照问答的资料范围已改变，请重新选择两份资料。",
  "source-versions-mismatch": "对照资料版本已变化，请重新打开后再提问。",
  "comparison-mismatch": "对照问答身份已变化，请重新打开两份资料后再提问。",
  "space-mismatch": "对照问答的知识库已改变，请重新打开对照阅读。",
  "space-archived": "当前知识库已归档，不能发起对照问答。",
  "same-source": "请在两份不同的资料之间进行对照。",
  "source-recycled": "部分对照资料已移入回收站，请恢复后重试。",
  "source-not-in-space": "部分对照资料已离开当前知识库，请重新选择。",
  "historical-version": "对照阅读可查看历史版本，但 AI 问答只能使用两份当前版本。",
  "source-ai-disabled": "部分对照资料未允许 AI 使用，请调整资料范围。",
  "source-not-ready": "部分对照资料尚未解析出可用正文，请完成解析后重试。",
};

export class ComparisonAnswerRequestError extends Error {
  constructor(readonly reason: ComparisonAnswerRequestReason) {
    super(reasonMessage[reason]);
    this.name = "ComparisonAnswerRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isParsedCurrentSource(side: ComparisonAnswerSource): boolean {
  const { source } = side;
  return (
    side.isCurrentVersion &&
    (source.status === "ready" || source.status === "partial") &&
    !!source.text.trim() &&
    source.chunks.length > 0 &&
    source.chunks.every(
      (chunk) =>
        chunk.sourceId === source.id &&
        chunk.versionId === source.versionId &&
        !!chunk.text.trim() &&
        source.text.includes(chunk.text),
    )
  );
}

function sourceReason(scope: ComparisonAnswerScope): ComparisonAnswerRequestReason | undefined {
  const { left, right, space } = scope;
  if (left.source.id === right.source.id) return "same-source";
  if (space.archived) return "space-archived";

  for (const side of [left, right]) {
    const { source } = side;
    if (source.deletedAt) return "source-recycled";
    if (!source.spaceIds.includes(space.id)) return "source-not-in-space";
    if (
      !side.isCurrentVersion ||
      source.versions?.some((version) => version.versionId === source.versionId)
    )
      return "historical-version";
    if (!source.aiAllowed) return "source-ai-disabled";
    if (!isParsedCurrentSource(side)) return "source-not-ready";
  }
  return undefined;
}

/**
 * Returns a stable, user-displayable reason instead of reading workspace state
 * or mutating a request. A caller should use this right before dispatch, after
 * it has resolved the comparison route against the latest workspace snapshot.
 */
export function comparisonAnswerRequestReason(
  scope: ComparisonAnswerScope,
  value: unknown,
): ComparisonAnswerRequestReason | undefined {
  if (!isRecord(value)) return "invalid-request";
  if ("notes" in value || "noteId" in value || "noteIds" in value) return "notes-not-allowed";
  if (typeof value.question !== "string" || !value.question.trim()) return "empty-question";
  // Keep the comparison diagnostic before another valid scope's version-lock
  // requirements reject the entire request. Unknown scopes remain invalid.
  const parsedScope = answerRequestSchema.shape.scope.safeParse(value.scope);
  if (parsedScope.success && parsedScope.data !== "sources") return "scope-not-sources";
  if (value.scope === "sources" && value.sourceVersions === undefined)
    return "source-versions-mismatch";

  const parsed = answerRequestSchema.safeParse(value);
  if (!parsed.success) return "invalid-request";
  const request = parsed.data;
  if (request.scope !== "sources") return "scope-not-sources";
  if (request.sourceId !== undefined) return "source-id-not-allowed";
  if (request.selection !== undefined) return "selection-not-allowed";
  if (request.spaceId !== scope.space.id) return "space-mismatch";

  const expected = [scope.left.source.id, scope.right.source.id];
  if (new Set(expected).size !== 2) return "same-source";
  const actual = new Set(request.sourceIds);
  if (
    request.sourceIds.length !== 2 ||
    actual.size !== 2 ||
    actual.size !== expected.length ||
    expected.some((sourceId) => !actual.has(sourceId))
  )
    return "source-ids-mismatch";

  const expectedVersions = new Map([
    [scope.left.source.id, scope.left.source.versionId],
    [scope.right.source.id, scope.right.source.versionId],
  ]);
  const actualVersions = new Map(
    (request.sourceVersions ?? []).map((item) => [item.sourceId, item.versionId]),
  );
  if (
    !request.sourceVersions ||
    request.sourceVersions.length !== expectedVersions.size ||
    actualVersions.size !== request.sourceVersions.length ||
    [...expectedVersions].some(
      ([sourceId, versionId]) => actualVersions.get(sourceId) !== versionId,
    )
  )
    return "source-versions-mismatch";

  const comparison = request.comparison;
  if (
    !comparison ||
    comparison.leftSourceId !== scope.left.source.id ||
    comparison.leftVersionId !== scope.left.source.versionId ||
    comparison.rightSourceId !== scope.right.source.id ||
    comparison.rightVersionId !== scope.right.source.versionId
  )
    return "comparison-mismatch";

  return sourceReason(scope);
}

/**
 * Strictly validates an existing request without silently narrowing it. This
 * is the dispatch-time guard for a request built by the comparison reader.
 */
export function validateComparisonAnswerRequest(
  scope: ComparisonAnswerScope,
  value: unknown,
): AnswerRequest {
  const reason = comparisonAnswerRequestReason(scope, value);
  if (reason) throw new ComparisonAnswerRequestError(reason);
  return answerRequestSchema.parse(value);
}

/**
 * Builds the only allowed answer shape for a current two-source comparison.
 * It intentionally does not create a request ID: a UI attempt owns that ID so
 * stopped/retried model calls remain auditable.
 */
export function createComparisonAnswerRequest(input: CreateComparisonAnswerRequest): AnswerRequest {
  return validateComparisonAnswerRequest(input, {
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    question: input.question,
    scope: "sources",
    sourceIds: [input.left.source.id, input.right.source.id],
    sourceVersions: [
      { sourceId: input.left.source.id, versionId: input.left.source.versionId },
      { sourceId: input.right.source.id, versionId: input.right.source.versionId },
    ],
    comparison: {
      leftSourceId: input.left.source.id,
      leftVersionId: input.left.source.versionId,
      rightSourceId: input.right.source.id,
      rightVersionId: input.right.source.versionId,
    },
    spaceId: input.space.id,
  });
}
