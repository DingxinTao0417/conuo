import type { ComparisonRoute } from "./comparison-route";
import type { ComparisonConversationMetadata, Conversation, Scope } from "./types";

/**
 * The immutable route identity captured when a learner starts a comparison
 * conversation. Source membership is kept on the conversation itself; the
 * versions live here so a later source update cannot silently rewrite the
 * meaning of an existing discussion.
 */
/**
 * `Conversation` gains this optional field when comparison conversations are
 * persisted. Keeping a structural type here lets this pure helper remain
 * independently testable while older stored conversations stay readable.
 */
export type ComparisonConversation = Conversation & {
  comparison?: ComparisonConversationMetadata;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isComparisonRoute(value: unknown): value is ComparisonRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const route = value as Partial<ComparisonRoute>;
  return (
    isNonEmptyString(route.leftSourceId) &&
    isNonEmptyString(route.leftVersionId) &&
    isNonEmptyString(route.rightSourceId) &&
    isNonEmptyString(route.rightVersionId) &&
    isNonEmptyString(route.spaceId) &&
    route.leftSourceId !== route.rightSourceId
  );
}

function isMetadata(value: unknown): value is ComparisonConversationMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Partial<ComparisonConversationMetadata>;
  return (
    isNonEmptyString(metadata.leftSourceId) &&
    isNonEmptyString(metadata.leftVersionId) &&
    isNonEmptyString(metadata.rightSourceId) &&
    isNonEmptyString(metadata.rightVersionId) &&
    metadata.leftSourceId !== metadata.rightSourceId
  );
}

function hasExactSourceScope(
  conversation: Pick<Conversation, "scope" | "sourceId" | "sourceIds">,
  metadata: ComparisonConversationMetadata,
): boolean {
  const expected = new Set([metadata.leftSourceId, metadata.rightSourceId]);
  const actual = new Set(conversation.sourceIds);
  return (
    conversation.scope === ("sources" satisfies Scope) &&
    conversation.sourceId === undefined &&
    conversation.sourceIds.length === 2 &&
    actual.size === 2 &&
    actual.size === expected.size &&
    [...expected].every((sourceId) => actual.has(sourceId))
  );
}

/** Returns a detached, persistable comparison identity for one canonical route. */
export function createComparisonConversationMetadata(
  route: ComparisonRoute,
): ComparisonConversationMetadata {
  if (!isComparisonRoute(route)) {
    throw new Error("A comparison conversation needs two distinct sources, versions, and a space.");
  }

  return {
    leftSourceId: route.leftSourceId,
    leftVersionId: route.leftVersionId,
    rightSourceId: route.rightSourceId,
    rightVersionId: route.rightVersionId,
  };
}

/**
 * Safely reconstructs the canonical route of a persisted comparison
 * conversation. It refuses legacy or tampered conversations instead of
 * guessing versions from the current source records.
 */
export function comparisonRouteFromConversation(
  conversation: ComparisonConversation | undefined,
): ComparisonRoute | undefined {
  if (
    !conversation ||
    !isNonEmptyString(conversation.spaceId) ||
    !isMetadata(conversation.comparison)
  )
    return undefined;
  if (!hasExactSourceScope(conversation, conversation.comparison)) return undefined;

  return {
    leftSourceId: conversation.comparison.leftSourceId,
    leftVersionId: conversation.comparison.leftVersionId,
    rightSourceId: conversation.comparison.rightSourceId,
    rightVersionId: conversation.comparison.rightVersionId,
    spaceId: conversation.spaceId,
  };
}

/**
 * Checks every part of the fixed two-document identity. A matching source set
 * alone is insufficient: left/right order, exact versions, and space must all
 * remain unchanged.
 */
export function isConversationForComparisonRoute(
  conversation: ComparisonConversation | undefined,
  route: ComparisonRoute,
): boolean {
  if (!isComparisonRoute(route)) return false;
  const conversationRoute = comparisonRouteFromConversation(conversation);
  return (
    !!conversationRoute &&
    conversationRoute.leftSourceId === route.leftSourceId &&
    conversationRoute.leftVersionId === route.leftVersionId &&
    conversationRoute.rightSourceId === route.rightSourceId &&
    conversationRoute.rightVersionId === route.rightVersionId &&
    conversationRoute.spaceId === route.spaceId
  );
}
