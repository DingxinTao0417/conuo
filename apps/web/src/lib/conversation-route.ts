import { comparisonRouteFromConversation } from "./comparison-conversation";
import type { ComparisonRoute } from "./comparison-route";
import { resolveComparisonSources } from "./comparison-sources";
import { isCrossLibraryConversation, resolveCrossLibraryConversation } from "./cross-library-ask";
import type { Conversation, Source, WorkspaceData } from "./types";

export interface ConversationRoute {
  conversationId: string;
}

/**
 * A conversation URL is deliberately only an identifier. Resolution always
 * happens against the already account-scoped workspace snapshot; the route
 * never triggers an object lookup by itself.
 */
function isRouteId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function decodeRouteId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const decoded = decodeURIComponent(value);
    return isRouteId(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** Parses only the canonical, single-conversation fragment. */
export function parseConversationRoute(hash: string): ConversationRoute | undefined {
  if (typeof hash !== "string" || !hash.startsWith("#")) return undefined;

  const [fragment] = hash.slice(1).split("?");
  const path = fragment.split("/");
  if (path.length !== 2 || path[0] !== "conversation") return undefined;

  const conversationId = decodeRouteId(path[1]);
  return conversationId ? { conversationId } : undefined;
}

/** Returns the canonical, encoded fragment for a saved conversation. */
export function formatConversationRoute(route: ConversationRoute): string {
  if (!route || !isRouteId(route.conversationId)) {
    throw new Error("A conversation route needs one non-empty conversation ID.");
  }
  return `#conversation/${encodeURIComponent(route.conversationId)}`;
}

type ConversationHistoryReason =
  | "space-unavailable"
  | "source-unavailable"
  | "source-out-of-scope"
  | "comparison-read-only"
  | "cross-library-read-only"
  | "conversation-unbound";

export type ConversationRouteResolution =
  | { kind: "unavailable" }
  | {
      /**
       * The saved pair and both frozen versions are still readable. The caller
       * can reopen the exact comparison instead of substituting a newer thread
       * for the same two sources.
       */
      kind: "comparison";
      conversation: Conversation;
      route: ComparisonRoute;
    }
  | {
      /** The all-library panel restores this conversation's fixed source versions. */
      kind: "cross-library";
      conversation: Conversation;
    }
  | {
      kind: "source";
      conversation: Conversation;
      source: Source;
    }
  | {
      kind: "history";
      conversation: Conversation;
      reason: ConversationHistoryReason;
    };

function conversationSpaceAvailable(data: WorkspaceData, conversation: Conversation): boolean {
  if (isCrossLibraryConversation(conversation)) return true;
  if (conversation.spaceId === "inbox") return true;
  return data.spaces.some((space) => space.id === conversation.spaceId && !space.archived);
}

function sourceBelongsToConversationSpace(source: Source, conversation: Conversation): boolean {
  return conversation.spaceId === "inbox"
    ? source.spaceIds.length === 0
    : source.spaceIds.includes(conversation.spaceId);
}

/**
 * Chooses a safe presentation for one URL-addressed conversation. A missing
 * ID is intentionally indistinguishable from another account's ID. A saved
 * conversation may remain readable after its context is no longer safe to
 * reopen, but then only its retained transcript is exposed.
 */
export function resolveConversationRoute(
  data: WorkspaceData,
  route: ConversationRoute,
): ConversationRouteResolution {
  const conversation = data.conversations.find((item) => item.id === route.conversationId);
  if (!conversation) return { kind: "unavailable" };

  if (isCrossLibraryConversation(conversation)) {
    const crossLibrary = resolveCrossLibraryConversation(data, conversation);
    return crossLibrary.ok
      ? { kind: "cross-library", conversation }
      : { kind: "history", conversation, reason: "cross-library-read-only" };
  }

  if (!conversationSpaceAvailable(data, conversation)) {
    return { kind: "history", conversation, reason: "space-unavailable" };
  }

  if (conversation.comparison !== undefined) {
    const comparisonRoute = comparisonRouteFromConversation(conversation);
    // Never reconstruct a comparison from the newest source versions. A
    // malformed saved identity or an unavailable pair remains a retained,
    // read-only transcript instead of opening a related but different pair.
    if (!comparisonRoute || !resolveComparisonSources(data, comparisonRoute).ok)
      return { kind: "history", conversation, reason: "comparison-read-only" };
    return { kind: "comparison", conversation, route: comparisonRoute };
  }

  if (!conversation.sourceId) {
    return { kind: "history", conversation, reason: "conversation-unbound" };
  }

  const source = data.sources.find((item) => item.id === conversation.sourceId);
  if (!source || source.deletedAt) {
    return { kind: "history", conversation, reason: "source-unavailable" };
  }
  if (
    !conversation.sourceIds.includes(source.id) ||
    !sourceBelongsToConversationSpace(source, conversation)
  ) {
    return { kind: "history", conversation, reason: "source-out-of-scope" };
  }

  return { kind: "source", conversation, source };
}
