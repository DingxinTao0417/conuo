import { resolveConversationRoute } from "./conversation-route";
import { isCrossLibraryConversation } from "./cross-library-ask";
import { formatWorkspaceSectionRoute, parseWorkspaceSectionRoute } from "./workspace-section-route";
import type { Conversation, Source, WorkspaceData } from "./types";

export const questionHistoryFilters = ["all", "pending", "resolved"] as const;

export type QuestionHistoryFilter = (typeof questionHistoryFilters)[number];

export interface QuestionHistoryItem {
  conversation: Conversation;
  sourceSummary: string;
  recentDiscussionSummary: string;
  originalSource?: Source;
  action: "continue" | "history";
}

function isQuestionHistoryFilter(value: string | null): value is QuestionHistoryFilter {
  return (questionHistoryFilters as readonly (string | null)[]).includes(value);
}

/** Bare or malformed question routes intentionally fall back to the complete history. */
export function parseQuestionHistoryFilter(hash: string): QuestionHistoryFilter {
  if (parseWorkspaceSectionRoute(hash)?.section !== "questions") return "all";
  const queryStart = hash.indexOf("?");
  if (queryStart === -1) return "all";
  const value = new URLSearchParams(hash.slice(queryStart + 1)).get("status");
  return isQuestionHistoryFilter(value) ? value : "all";
}

/** Keeps learning-space and status state together in the browser history entry. */
export function formatQuestionHistoryRoute(spaceId: string, filter: QuestionHistoryFilter): string {
  const baseRoute = formatWorkspaceSectionRoute("questions", spaceId);
  const queryStart = baseRoute.indexOf("?");
  const path = queryStart === -1 ? baseRoute : baseRoute.slice(0, queryStart);
  const params = new URLSearchParams(queryStart === -1 ? "" : baseRoute.slice(queryStart + 1));
  params.set("status", filter);
  return `${path}?${params.toString()}`;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizedPreview(value: string): string {
  return value
    .replace(/<[^>]*>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function recentDiscussionSummary(conversation: Conversation, limit = 128): string {
  const message = [...conversation.messages]
    .reverse()
    .find((candidate) => normalizedPreview(candidate.content || candidate.error || ""));
  if (!message) return "还没有讨论内容。";

  const content = normalizedPreview(message.content || message.error || "");
  const preview = content.length > limit ? `${content.slice(0, limit).trimEnd()}…` : content;
  return `${message.role === "user" ? "最近问题" : "最近回答"}：${preview}`;
}

function associatedSourceIds(conversation: Conversation): string[] {
  return [conversation.sourceId, ...conversation.sourceIds].filter(
    (id, index, ids): id is string => Boolean(id) && ids.indexOf(id) === index,
  );
}

function sourceSummary(data: WorkspaceData, conversation: Conversation): string {
  const ids = associatedSourceIds(conversation);
  if (!ids.length) return "未关联资料";

  const labels = ids.map((id) => {
    const source = data.sources.find((candidate) => candidate.id === id);
    if (!source) return "资料已不可用";
    return source.deletedAt ? `${source.title}（已删除）` : source.title;
  });
  const prefix = isCrossLibraryConversation(conversation)
    ? `跨库 · ${ids.length} 份固定资料 · `
    : "";
  return `${prefix}${labels.join("、")}`;
}

export function questionHistoryItems(
  data: WorkspaceData,
  spaceId: string,
  filter: QuestionHistoryFilter,
): QuestionHistoryItem[] {
  return data.conversations
    .filter(
      (conversation) =>
        (spaceId === "all" || conversation.spaceId === spaceId) &&
        (filter === "all" ||
          (filter === "resolved" ? conversation.resolved : !conversation.resolved)),
    )
    .sort((left, right) => {
      const byUpdatedAt = timestamp(right.updatedAt) - timestamp(left.updatedAt);
      return byUpdatedAt || left.id.localeCompare(right.id);
    })
    .map((conversation) => {
      const resolution = resolveConversationRoute(data, { conversationId: conversation.id });
      let summary = sourceSummary(data, conversation);
      if (
        !isCrossLibraryConversation(conversation) &&
        resolution.kind === "history" &&
        resolution.reason === "source-unavailable"
      ) {
        summary += " · 原资料已删除，可查看记录";
      } else if (
        !isCrossLibraryConversation(conversation) &&
        resolution.kind === "history" &&
        resolution.reason === "source-out-of-scope"
      ) {
        summary += " · 原资料已不属于这个知识库，可查看记录";
      }
      return {
        conversation,
        sourceSummary: summary,
        recentDiscussionSummary: recentDiscussionSummary(conversation),
        ...(resolution.kind === "source" ? { originalSource: resolution.source } : {}),
        action: resolution.kind === "history" ? "history" : "continue",
      };
    });
}

export function questionHistoryCounts(data: WorkspaceData, spaceId: string) {
  const conversations = data.conversations.filter(
    (conversation) => spaceId === "all" || conversation.spaceId === spaceId,
  );
  const resolved = conversations.filter((conversation) => conversation.resolved).length;
  return {
    all: conversations.length,
    pending: conversations.length - resolved,
    resolved,
  } satisfies Record<QuestionHistoryFilter, number>;
}
