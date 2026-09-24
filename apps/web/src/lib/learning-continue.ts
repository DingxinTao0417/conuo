import type { Conversation, Source, WorkspaceData } from "./types";
import { resolveConversationRoute } from "./conversation-route";

export interface PrimaryLearningContinuation {
  source: Source;
  spaceId: string;
  spaceName: string;
  conversation?: Conversation;
}

function dateValue(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Continue cards represent actual reading activity only. Importing, tagging or
 * renaming a source must never push it ahead of a document the user was reading.
 */
export function recentlyReadSources(data: WorkspaceData, spaceId: string, limit = 3): Source[] {
  const inScope = (source: Source) =>
    spaceId === "all"
      ? true
      : spaceId === "inbox"
        ? source.spaceIds.length === 0
        : source.spaceIds.includes(spaceId);
  return data.sources
    .filter((source) => !source.deletedAt && dateValue(source.lastReadAt) > 0 && inScope(source))
    .sort((left, right) => {
      const timestamp = dateValue(right.lastReadAt) - dateValue(left.lastReadAt);
      return timestamp || left.id.localeCompare(right.id);
    })
    .slice(0, Math.max(0, limit));
}

/** Unresolved questions remain a user-controlled learning queue, never an AI claim of mastery. */
export function unresolvedConversations(
  data: WorkspaceData,
  spaceId: string,
  limit = 3,
): Conversation[] {
  return data.conversations
    .filter(
      (conversation) =>
        !conversation.resolved && (spaceId === "all" || conversation.spaceId === spaceId),
    )
    .sort((left, right) => {
      const timestamp = dateValue(right.updatedAt) - dateValue(left.updatedAt);
      return timestamp || left.id.localeCompare(right.id);
    })
    .slice(0, Math.max(0, limit));
}

/** Home learning cards only surface questions updated during the last seven days. */
export function recentUnresolvedConversations(
  data: WorkspaceData,
  spaceId: string,
  limit = 3,
  now = Date.now(),
): Conversation[] {
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  return unresolvedConversations(data, spaceId, data.conversations.length)
    .filter((conversation) => {
      const updatedAt = dateValue(conversation.updatedAt);
      return updatedAt >= cutoff && updatedAt <= now;
    })
    .slice(0, Math.max(0, limit));
}

function continuationSpace(
  data: WorkspaceData,
  source: Source,
  requestedSpaceId: string,
  conversation?: Conversation,
) {
  const resolvedSpaceId =
    requestedSpaceId !== "all"
      ? requestedSpaceId
      : conversation?.spaceId ||
        source.spaceIds.find((id) =>
          data.spaces.some((space) => space.id === id && !space.archived),
        ) ||
        source.spaceIds[0] ||
        "inbox";
  return {
    spaceId: resolvedSpaceId,
    spaceName:
      resolvedSpaceId === "inbox"
        ? "收件箱"
        : data.spaces.find((space) => space.id === resolvedSpaceId)?.name || "原学习空间",
  };
}

/**
 * Keeps the source, reading position and one safely resumable question in a
 * single continuation item. This prevents a newer resolved thread from being
 * chosen implicitly when the reader opens a source without a conversation ID.
 */
export function primaryLearningContinuation(
  data: WorkspaceData,
  spaceId: string,
): PrimaryLearningContinuation | null {
  const source = recentlyReadSources(data, spaceId, 1)[0];
  if (!source) return null;
  const conversation = unresolvedConversations(data, spaceId, data.conversations.length).find(
    (candidate) => {
      const resolution = resolveConversationRoute(data, { conversationId: candidate.id });
      return resolution.kind === "source" && resolution.source.id === source.id;
    },
  );
  return {
    source,
    ...continuationSpace(data, source, spaceId, conversation),
    ...(conversation ? { conversation } : {}),
  };
}
