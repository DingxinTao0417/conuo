import type {
  AnswerRequest,
  Conversation,
  Source,
  SourceVersionReference,
  Space,
  WorkspaceData,
} from "./types";

/** A separately named boundary for the explicit, all-library question panel. */
export const CROSS_LIBRARY_SCOPE = "cross-library-sources" as const;
export const CROSS_LIBRARY_SPACE_ID = "all" as const;
export const CROSS_LIBRARY_MIN_SOURCES = 1;
export const CROSS_LIBRARY_MAX_SOURCES = 5;

export type CrossLibraryErrorCode =
  | "CROSS_LIBRARY_SCOPE_REQUIRED"
  | "CROSS_LIBRARY_SELECTION_REQUIRED"
  | "CROSS_LIBRARY_SELECTION_LIMIT"
  | "CROSS_LIBRARY_SELECTION_DUPLICATE"
  | "CROSS_LIBRARY_VERSION_REQUIRED"
  | "CROSS_LIBRARY_VERSION_CHANGED"
  | "CROSS_LIBRARY_SOURCE_MISSING"
  | "CROSS_LIBRARY_SOURCE_RECYCLED"
  | "CROSS_LIBRARY_AI_DISABLED"
  | "CROSS_LIBRARY_SOURCE_NOT_READY"
  | "CROSS_LIBRARY_SPACE_UNAVAILABLE"
  | "CROSS_LIBRARY_CONVERSATION_UNBOUND";

export class CrossLibraryAnswerError extends Error {
  constructor(
    public code: CrossLibraryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CrossLibraryAnswerError";
  }
}

export type CrossLibrarySourceReason = "recycled" | "ai-disabled" | "not-ready" | "no-active-space";

export interface CrossLibrarySourceEligibility {
  source: Source;
  activeSpaces: Space[];
  available: boolean;
  reason?: CrossLibrarySourceReason;
}

export type CrossLibraryAnswerResolution =
  | {
      ok: true;
      sources: Source[];
      sourceVersions: SourceVersionReference[];
    }
  | { ok: false; error: CrossLibraryAnswerError };

function failure(code: CrossLibraryErrorCode, message: string): CrossLibraryAnswerResolution {
  return { ok: false, error: new CrossLibraryAnswerError(code, message) };
}

function sameIds(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return expected.size === left.length && right.every((value) => expected.has(value));
}

function sameVersions(
  left: readonly SourceVersionReference[],
  right: readonly SourceVersionReference[],
) {
  if (left.length !== right.length) return false;
  const expected = new Map(left.map((item) => [item.sourceId, item.versionId]));
  return (
    expected.size === left.length &&
    right.length === expected.size &&
    right.every((item) => expected.get(item.sourceId) === item.versionId)
  );
}

function currentTextReady(source: Source) {
  return (
    (source.status === "ready" || source.status === "partial") &&
    Boolean(source.text.trim()) &&
    source.chunks.length > 0 &&
    source.chunks.every(
      (chunk) =>
        chunk.sourceId === source.id &&
        chunk.versionId === source.versionId &&
        Boolean(chunk.text.trim()) &&
        source.text.includes(chunk.text),
    )
  );
}

/** Active space membership is mandatory for cross-library AI, even for a selected source. */
export function crossLibraryActiveSpaces(data: WorkspaceData, source: Source): Space[] {
  return data.spaces.filter((space) => !space.archived && source.spaceIds.includes(space.id));
}

/**
 * Returns a presentation-safe per-source status. Callers intentionally render
 * every item rather than silently dropping an unavailable selection.
 */
export function crossLibrarySourceEligibility(
  data: WorkspaceData,
  source: Source,
): CrossLibrarySourceEligibility {
  const activeSpaces = crossLibraryActiveSpaces(data, source);
  if (source.deletedAt) return { source, activeSpaces, available: false, reason: "recycled" };
  if (!source.aiAllowed) return { source, activeSpaces, available: false, reason: "ai-disabled" };
  if (!currentTextReady(source))
    return { source, activeSpaces, available: false, reason: "not-ready" };
  if (!activeSpaces.length)
    return { source, activeSpaces, available: false, reason: "no-active-space" };
  return { source, activeSpaces, available: true };
}

export function crossLibrarySourceReasonLabel(reason: CrossLibrarySourceReason | undefined) {
  switch (reason) {
    case "recycled":
      return "已移入回收站，不能用于新问答";
    case "ai-disabled":
      return "此资料已禁止 AI 使用";
    case "not-ready":
      return "正文或索引尚未可用";
    case "no-active-space":
      return "没有归属到可用知识库";
    default:
      return "可用于跨库问答";
  }
}

export function isCrossLibraryAnswerRequest(
  request: Pick<AnswerRequest, "scope">,
): request is AnswerRequest & { scope: typeof CROSS_LIBRARY_SCOPE } {
  return request.scope === CROSS_LIBRARY_SCOPE;
}

export function isCrossLibraryConversation(
  conversation: Pick<Conversation, "scope" | "spaceId">,
): boolean {
  return (
    conversation.scope === CROSS_LIBRARY_SCOPE && conversation.spaceId === CROSS_LIBRARY_SPACE_ID
  );
}

function requestSourceVersions(request: AnswerRequest): SourceVersionReference[] | null {
  const references = request.sourceVersions;
  if (!references || !references.length) return null;
  return references;
}

/**
 * Rechecks an explicit cross-library request against the current account's
 * workspace. It returns an error instead of filtering selected sources, so a
 * stale, revoked, recycled or moved document can never narrow the question.
 */
export function validateCrossLibraryAnswerRequest(
  data: WorkspaceData,
  request: AnswerRequest,
): CrossLibraryAnswerResolution {
  if (!isCrossLibraryAnswerRequest(request))
    return failure("CROSS_LIBRARY_SCOPE_REQUIRED", "请从全部资料库开启跨库问答。");
  if (
    request.spaceId !== CROSS_LIBRARY_SPACE_ID ||
    request.sourceId !== undefined ||
    request.selection !== undefined ||
    request.comparison !== undefined
  )
    return failure(
      "CROSS_LIBRARY_SCOPE_REQUIRED",
      "跨库问答只能使用全部资料库中明确选择的资料，不能附带单资料、选段或对照范围。",
    );
  if (!request.sourceIds.length)
    return failure("CROSS_LIBRARY_SELECTION_REQUIRED", "请先明确选择 1 至 5 份可用资料。");
  if (request.sourceIds.length > CROSS_LIBRARY_MAX_SOURCES)
    return failure(
      "CROSS_LIBRARY_SELECTION_LIMIT",
      `跨库问答一次最多选择 ${CROSS_LIBRARY_MAX_SOURCES} 份资料。`,
    );
  if (new Set(request.sourceIds).size !== request.sourceIds.length)
    return failure("CROSS_LIBRARY_SELECTION_DUPLICATE", "同一份资料不能重复加入跨库问答范围。");

  const references = requestSourceVersions(request);
  if (
    !references ||
    references.length !== request.sourceIds.length ||
    new Set(references.map((item) => item.sourceId)).size !== references.length ||
    !sameIds(
      request.sourceIds,
      references.map((item) => item.sourceId),
    )
  )
    return failure(
      "CROSS_LIBRARY_VERSION_REQUIRED",
      "跨库问答必须锁定每份已选资料的当前版本，请重新确认资料后再提问。",
    );

  const sourceVersions = new Map(references.map((item) => [item.sourceId, item.versionId]));
  const sources: Source[] = [];
  for (const sourceId of request.sourceIds) {
    const source = data.sources.find((item) => item.id === sourceId);
    if (!source)
      return failure("CROSS_LIBRARY_SOURCE_MISSING", "部分所选资料不可用或不属于当前账号。");
    if (source.versionId !== sourceVersions.get(source.id))
      return failure(
        "CROSS_LIBRARY_VERSION_CHANGED",
        "部分所选资料的版本已改变，请重新确认资料后再提问。",
      );
    if (source.deletedAt)
      return failure(
        "CROSS_LIBRARY_SOURCE_RECYCLED",
        "部分所选资料已移入回收站，不能继续用于问答。",
      );
    if (!source.aiAllowed)
      return failure("CROSS_LIBRARY_AI_DISABLED", "部分所选资料已禁止 AI 使用，请重新确认范围。");
    if (!currentTextReady(source))
      return failure(
        "CROSS_LIBRARY_SOURCE_NOT_READY",
        "部分所选资料尚无可用正文或索引，请完成解析后重新确认。",
      );
    if (!crossLibraryActiveSpaces(data, source).length)
      return failure(
        "CROSS_LIBRARY_SPACE_UNAVAILABLE",
        "部分所选资料没有归属到可用知识库，不能用于跨库问答。",
      );
    sources.push(source);
  }
  return {
    ok: true,
    sources,
    sourceVersions: request.sourceIds.map((sourceId) => ({
      sourceId,
      versionId: sourceVersions.get(sourceId)!,
    })),
  };
}

export function createCrossLibraryAnswerRequest(
  data: WorkspaceData,
  input: Pick<AnswerRequest, "question" | "requestId" | "userContext"> & {
    sourceIds: readonly string[];
  },
): AnswerRequest {
  const sourceIds = [...input.sourceIds];
  const provisional: AnswerRequest = {
    question: input.question,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.userContext?.length ? { userContext: [...input.userContext] } : {}),
    scope: CROSS_LIBRARY_SCOPE,
    sourceIds,
    sourceVersions: sourceIds.map((sourceId) => ({
      sourceId,
      versionId: data.sources.find((source) => source.id === sourceId)?.versionId ?? "",
    })),
    spaceId: CROSS_LIBRARY_SPACE_ID,
  };
  const validated = validateCrossLibraryAnswerRequest(data, provisional);
  if (!validated.ok) throw validated.error;
  return { ...provisional, sourceVersions: validated.sourceVersions };
}

export type CrossLibraryConversationResolution =
  | { ok: true; request: Omit<AnswerRequest, "question" | "requestId" | "userContext"> }
  | { ok: false; error: CrossLibraryAnswerError };

/**
 * The first completed/stopped/failed answer attempt retains the exact version
 * lock. Every later attempt must match it before a saved cross-library thread
 * can become writable again.
 */
export function resolveCrossLibraryConversation(
  data: WorkspaceData,
  conversation: Conversation,
): CrossLibraryConversationResolution {
  if (
    !isCrossLibraryConversation(conversation) ||
    conversation.sourceId !== undefined ||
    conversation.comparison !== undefined ||
    conversation.sourceIds.length < CROSS_LIBRARY_MIN_SOURCES ||
    conversation.sourceIds.length > CROSS_LIBRARY_MAX_SOURCES ||
    new Set(conversation.sourceIds).size !== conversation.sourceIds.length
  )
    return {
      ok: false,
      error: new CrossLibraryAnswerError(
        "CROSS_LIBRARY_CONVERSATION_UNBOUND",
        "这条跨库问答没有可安全恢复的固定资料范围。",
      ),
    };

  const snapshots = conversation.messages
    .map((message) => message.attempt?.scopeSnapshot)
    .filter((snapshot): snapshot is NonNullable<typeof snapshot> => Boolean(snapshot));
  const first = snapshots[0];
  if (!first)
    return {
      ok: false,
      error: new CrossLibraryAnswerError(
        "CROSS_LIBRARY_CONVERSATION_UNBOUND",
        "这条跨库问答尚未保存可恢复的资料版本，请新建问题后重新选择资料。",
      ),
    };
  const fixed = first.sourceVersions;
  if (
    first.scope !== CROSS_LIBRARY_SCOPE ||
    first.spaceId !== CROSS_LIBRARY_SPACE_ID ||
    first.sourceId !== undefined ||
    first.selection !== undefined ||
    first.comparison !== undefined ||
    !fixed ||
    !sameIds(conversation.sourceIds, first.sourceIds)
  )
    return {
      ok: false,
      error: new CrossLibraryAnswerError(
        "CROSS_LIBRARY_CONVERSATION_UNBOUND",
        "这条跨库问答的资料范围记录不完整，已保留历史但不能继续提问。",
      ),
    };

  if (
    snapshots.some(
      (snapshot) =>
        snapshot.scope !== CROSS_LIBRARY_SCOPE ||
        snapshot.spaceId !== CROSS_LIBRARY_SPACE_ID ||
        snapshot.sourceId !== undefined ||
        snapshot.selection !== undefined ||
        snapshot.comparison !== undefined ||
        !sameIds(conversation.sourceIds, snapshot.sourceIds) ||
        !snapshot.sourceVersions ||
        !sameVersions(fixed, snapshot.sourceVersions),
    )
  )
    return {
      ok: false,
      error: new CrossLibraryAnswerError(
        "CROSS_LIBRARY_CONVERSATION_UNBOUND",
        "这条跨库问答的固定资料范围已不一致，已保留历史但不能继续提问。",
      ),
    };

  const request: AnswerRequest = {
    question: "检查跨库问答范围",
    scope: CROSS_LIBRARY_SCOPE,
    sourceIds: [...conversation.sourceIds],
    sourceVersions: fixed.map((item) => ({ ...item })),
    spaceId: CROSS_LIBRARY_SPACE_ID,
  };
  const checked = validateCrossLibraryAnswerRequest(data, request);
  if (!checked.ok) return checked;
  return {
    ok: true,
    request: {
      scope: CROSS_LIBRARY_SCOPE,
      sourceIds: [...conversation.sourceIds],
      sourceVersions: checked.sourceVersions,
      spaceId: CROSS_LIBRARY_SPACE_ID,
    },
  };
}
