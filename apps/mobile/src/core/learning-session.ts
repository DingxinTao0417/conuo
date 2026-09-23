import {
  answerScope,
  type Answer,
  type Conversation,
  type ConversationMessage,
  type Source,
  type Workspace,
} from "./contracts.ts";
import type { QuestionDraftInput } from "./draft-recovery.ts";

/** A deterministic conversation identity per source keeps one document thread stable across saves. */
export function documentConversationId(sourceId: string) {
  return `doc-${sourceId.slice(0, 80)}`.slice(0, 100);
}

/** Keep workspace history small: 20 rounds means 40 messages, far below the server's 1000 ceiling. */
const MAX_CONVERSATION_ROUNDS = 20;

/**
 * Record one completed answer as user + assistant messages on the source's
 * document conversation. Appending is idempotent per request id and never
 * rewrites or deduplicates another device's newer messages.
 */
export function appendAnswerConversation(
  workspace: Workspace,
  input: {
    source: Source;
    question: string;
    answer: Answer;
    spaceId: string;
    requestId: string;
    questionMessageId: string;
    /** The frozen answer scope exactly as sent, without the volatile requestId/question. */
    scopeSnapshot: Record<string, unknown>;
    now: string;
  },
): Workspace {
  const { source, question, answer, spaceId, requestId, now } = input;
  const existing = workspace.conversations.find(
    (conversation) =>
      conversation.scope === "document" &&
      conversation.sourceId === source.id,
  );
  if (
    existing?.messages.some(
      (message) =>
        message.role === "assistant" &&
        message.attempt &&
        typeof message.attempt === "object" &&
        (message.attempt as { id?: unknown }).id === requestId,
    )
  )
    return workspace;
  const userMessage: ConversationMessage = {
    id: input.questionMessageId,
    role: "user",
    content: question,
    citations: [],
    createdAt: now,
  };
  const assistantMessage: ConversationMessage = {
    id: requestId,
    role: "assistant",
    content: answer.content,
    citations: answer.citations,
    createdAt: now,
    mode: answer.mode,
    attempt: {
      id: requestId,
      questionMessageId: input.questionMessageId,
      scopeSnapshot: input.scopeSnapshot,
      status: "completed",
    },
  };
  const incoming: Conversation = {
    id: existing?.id ?? documentConversationId(source.id),
    spaceId: existing?.spaceId ?? spaceId,
    sourceId: source.id,
    title: existing?.title ?? (question.trim().slice(0, 40) || source.title.slice(0, 40)),
    scope: "document",
    sourceIds: [source.id],
    resolved: existing?.resolved ?? false,
    updatedAt: now,
    messages: existing
      ? trimConversationMessages([...existing.messages, userMessage, assistantMessage])
      : [userMessage, assistantMessage],
  };
  return existing
    ? {
        ...workspace,
        conversations: workspace.conversations.map((item) =>
          item.id === incoming.id ? incoming : item,
        ),
      }
    : { ...workspace, conversations: [incoming, ...workspace.conversations] };
}

function trimConversationMessages(messages: ConversationMessage[]) {
  return messages.length <= MAX_CONVERSATION_ROUNDS * 2
    ? messages
    : messages.slice(messages.length - MAX_CONVERSATION_ROUNDS * 2);
}

/** The most recent document conversation for a source, if the client has loaded one. */
export function sourceConversation(
  workspace: Workspace,
  sourceId: string,
): Conversation | undefined {
  return workspace.conversations.find(
    (conversation) =>
      conversation.scope === "document" && conversation.sourceId === sourceId,
  );
}

/** Merge the current semantic reading position back into the cloud snapshot. */
export function applyReadingProgress(
  workspace: Workspace,
  sourceId: string,
  patch: { readPage?: number; lastReadAt: string },
): Workspace {
  const source = workspace.sources.find((item) => item.id === sourceId);
  if (!source || source.deletedAt) return workspace;
  if (
    (patch.readPage === undefined || patch.readPage === source.readPage) &&
    patch.lastReadAt === source.lastReadAt
  )
    return workspace;
  return {
    ...workspace,
    sources: workspace.sources.map((item) =>
      item.id === sourceId ? { ...item, ...patch } : item,
    ),
  };
}

export type LearningTab = "home" | "library" | "knowledge" | "account";
export type LearningLocation = {
  tab: LearningTab;
  filter: string;
  search: string;
};

export function listLocationKey(location: LearningLocation) {
  return JSON.stringify([
    location.tab,
    location.tab === "library" ? location.filter : "all",
    location.tab === "library"
      ? location.search.trim().toLocaleLowerCase()
      : "",
  ]);
}

export function filterLibrarySources(
  workspace: Workspace,
  filter: string,
  search: string,
) {
  const query = search.trim().toLocaleLowerCase();
  return workspace.sources.filter(
    (source) =>
      !source.deletedAt &&
      (filter === "all" ||
        (filter === "inbox"
          ? source.spaceIds.length === 0
          : source.spaceIds.includes(filter))) &&
      `${source.title} ${source.tags.join(" ")}`
        .toLocaleLowerCase()
        .includes(query),
  );
}

export function sourceStatusLabel(source: Pick<Source, "status">) {
  switch (source.status) {
    case "ready":
      return "可阅读";
    case "partial":
      return "部分正文";
    case "link-only":
      return "仅收藏链接";
    case "failed":
      return "解析失败";
    default:
      return "正在处理";
  }
}

/** Account ownership is the enclosing WorkspaceScreen lifetime, never persistent storage. */
export type Discussion = {
  scopeKey: string;
  question: string;
  /** Edited since the last explicitly submitted request, including an identical new draft. */
  questionDirty: boolean;
  contextNotice: string;
  answer: Answer | null;
  answerQuestion: string;
  error: string;
  scrollOffset: number;
};
export type Discussions = Map<string, Discussion>;
export type PendingQuestions = Map<
  string,
  {
    requestId: string;
    scopeKey: string;
    versionId: string;
    question: string;
  }
>;

export function completeQuestionRequest(
  pending: PendingQuestions,
  sourceId: string,
  requestId: string,
) {
  if (pending.get(sourceId)?.requestId !== requestId) return false;
  return pending.delete(sourceId);
}

/** Preserve only the user's words; a newer edit (including clearing) beats an older request. */
export function recoverableQuestions(
  store: Discussions,
  workspace: Workspace,
  pending: PendingQuestions,
  retained?: { current: QuestionDraftInput[] },
): QuestionDraftInput[] {
  return [
    ...(retained?.current ?? []),
    ...[...store].flatMap<QuestionDraftInput>(([id, value]) => {
      const source = workspace.sources.find(
        (item) => item.id === id && !item.deletedAt,
      );
      if (!source) return [];
      if (value.questionDirty)
        return value.question.trim()
          ? [
              {
                sourceId: id,
                versionId: source.versionId,
                question: value.question,
                questionDirty: true,
                kind: "unsent" as const,
              },
            ]
          : [];
      const request = pending.get(id);
      return request &&
        request.scopeKey === value.scopeKey &&
        request.question === value.question
        ? [
            {
              sourceId: id,
              versionId: request.versionId,
              question: request.question,
              questionDirty: true,
              kind: "unanswered" as const,
            },
          ]
        : [];
    }),
  ];
}

export function discussionScopeKey(workspace: Workspace, source: Source) {
  const spaces = source.spaceIds.filter((id) =>
    workspace.spaces.some((space) => space.id === id && !space.archived),
  );
  return JSON.stringify([
    source.id,
    source.versionId,
    source.deletedAt,
    source.status,
    workspace.aiEnabled,
    source.aiAllowed,
    source.spaceIds.length ? spaces : ["inbox"],
  ]);
}

export function discussionFor(
  store: Discussions,
  workspace: Workspace,
  source: Source,
): Discussion {
  const scopeKey = discussionScopeKey(workspace, source);
  const existing = store.get(source.id);
  if (existing?.scopeKey === scopeKey) return existing;
  // Retain the user's unsubmitted words, never old answers or already submitted prompts.
  const retainedDraft =
    existing?.questionDirty && existing.question.trim()
      ? existing.question
      : "";
  const next: Discussion = {
    scopeKey,
    question: retainedDraft,
    questionDirty: !!retainedDraft,
    contextNotice: existing
      ? retainedDraft
        ? "资料内容、范围或 AI 设置已改变。未发送的问题已保留，请核对当前资料后再发送。"
        : "资料内容、范围或 AI 设置已改变，之前的回答已清除。请核对当前资料后重新提问。"
      : "",
    answer: null,
    answerQuestion: "",
    error: "",
    scrollOffset: 0,
  };
  store.set(source.id, next);
  return next;
}

export function pruneDiscussions(store: Discussions, workspace: Workspace) {
  for (const [id, discussion] of store) {
    const source = workspace.sources.find(
      (item) => item.id === id && !item.deletedAt,
    );
    if (!source) store.delete(id);
    else if (discussion.scopeKey !== discussionScopeKey(workspace, source))
      discussionFor(store, workspace, source);
  }
}

export function unsentQuestionCount(store: Discussions) {
  return [...store.values()].filter((discussion) => {
    const question = discussion.question.trim();
    return question && discussion.questionDirty;
  }).length;
}

/** Local rejection leaves the input unsubmitted; only an explicit valid send clears dirty state. */
export function prepareDiscussionQuestion(
  store: Discussions,
  workspace: Workspace,
  source: Source,
  requestId: string,
) {
  const discussion = discussionFor(store, workspace, source);
  const payload = answerScope(
    workspace,
    source.id,
    discussion.question,
    requestId,
  );
  updateDiscussion(store, source.id, discussion.scopeKey, {
    questionDirty: false,
    contextNotice: "",
  });
  return payload;
}

/** A delayed result may only update the exact discussion in which the request started. */
export function updateDiscussion(
  store: Discussions,
  sourceId: string,
  scopeKey: string,
  patch: Partial<Omit<Discussion, "scopeKey">>,
) {
  const previous = store.get(sourceId);
  if (!previous || previous.scopeKey !== scopeKey) return false;
  store.set(sourceId, { ...previous, ...patch });
  return true;
}
