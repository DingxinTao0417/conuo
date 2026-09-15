import type {
  AnswerScopeSnapshot,
  Conversation,
  SourceVersionReference,
  WorkspaceData,
} from "./types";
import { comparisonRouteFromConversation } from "./comparison-conversation";
import type { ComparisonRoute } from "./comparison-route";
import { CROSS_LIBRARY_SCOPE, isCrossLibraryConversation } from "./cross-library-ask";

function sameSourceRange(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    right.every((sourceId) => left.includes(sourceId))
  );
}

function hasCrossLibraryIdentity(conversation: Conversation) {
  return (
    isCrossLibraryConversation(conversation) &&
    conversation.sourceId === undefined &&
    conversation.comparison === undefined &&
    conversation.sourceIds.length >= 1 &&
    conversation.sourceIds.length <= 5 &&
    new Set(conversation.sourceIds).size === conversation.sourceIds.length
  );
}

function sameSourceVersions(
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

function isFixedCrossLibrarySnapshot(
  snapshot: AnswerScopeSnapshot,
  sourceIds: readonly string[],
  expectedVersions: readonly SourceVersionReference[],
) {
  return (
    snapshot.scope === CROSS_LIBRARY_SCOPE &&
    snapshot.spaceId === "all" &&
    snapshot.sourceId === undefined &&
    snapshot.selection === undefined &&
    snapshot.comparison === undefined &&
    sameSourceRange(snapshot.sourceIds, sourceIds) &&
    Boolean(snapshot.sourceVersions) &&
    sameSourceVersions(snapshot.sourceVersions!, expectedVersions)
  );
}

/**
 * `null` means an initial user message has not yet received its first answer.
 * `undefined` is an invalid or self-contradictory persisted lock and must never
 * be overwritten by a delayed answer. A populated array is the exact fixed
 * source-version map shared by every answer attempt.
 */
function crossLibraryVersionLock(
  conversation: Conversation,
): readonly SourceVersionReference[] | null | undefined {
  const snapshots = conversation.messages.flatMap((message) =>
    message.attempt ? [message.attempt.scopeSnapshot] : [],
  );
  if (!snapshots.length) return null;
  const first = snapshots[0]!;
  const expectedVersions = first.sourceVersions;
  if (!expectedVersions) return undefined;
  if (!isFixedCrossLibrarySnapshot(first, conversation.sourceIds, expectedVersions))
    return undefined;
  return snapshots.every((snapshot) =>
    isFixedCrossLibrarySnapshot(snapshot, conversation.sourceIds, expectedVersions),
  )
    ? expectedVersions
    : undefined;
}

function sameComparisonRoute(left: ComparisonRoute, right: ComparisonRoute) {
  return (
    left.leftSourceId === right.leftSourceId &&
    left.leftVersionId === right.leftVersionId &&
    left.rightSourceId === right.rightSourceId &&
    left.rightVersionId === right.rightVersionId &&
    left.spaceId === right.spaceId
  );
}

function isFixedComparisonSnapshot(snapshot: AnswerScopeSnapshot, route: ComparisonRoute) {
  const sourceIds = [route.leftSourceId, route.rightSourceId];
  const sourceVersions = [
    { sourceId: route.leftSourceId, versionId: route.leftVersionId },
    { sourceId: route.rightSourceId, versionId: route.rightVersionId },
  ];
  const comparison = snapshot.comparison;
  return (
    snapshot.scope === "sources" &&
    snapshot.spaceId === route.spaceId &&
    snapshot.sourceId === undefined &&
    snapshot.selection === undefined &&
    sameSourceRange(snapshot.sourceIds, sourceIds) &&
    Boolean(snapshot.sourceVersions) &&
    sameSourceVersions(snapshot.sourceVersions!, sourceVersions) &&
    comparison?.leftSourceId === route.leftSourceId &&
    comparison.leftVersionId === route.leftVersionId &&
    comparison.rightSourceId === route.rightSourceId &&
    comparison.rightVersionId === route.rightVersionId
  );
}

/**
 * The comparison route itself establishes the expected versions, even before
 * the first answer. `null` only describes a user-message draft; `undefined`
 * is malformed history that a late response must never overwrite.
 */
function comparisonVersionLock(
  conversation: Conversation,
  route: ComparisonRoute,
): readonly SourceVersionReference[] | null | undefined {
  const snapshots = conversation.messages.flatMap((message) =>
    message.attempt ? [message.attempt.scopeSnapshot] : [],
  );
  if (!snapshots.length) return null;
  const expectedVersions = [
    { sourceId: route.leftSourceId, versionId: route.leftVersionId },
    { sourceId: route.rightSourceId, versionId: route.rightVersionId },
  ];
  return snapshots.every((snapshot) => isFixedComparisonSnapshot(snapshot, route))
    ? expectedVersions
    : undefined;
}

/**
 * Persists a reader update without allowing a late client response to undo a
 * workspace lifecycle move. A conversation's space is established when it is
 * created and can later be changed only by a workspace lifecycle operation.
 */
export function persistConversation(data: WorkspaceData, incoming: Conversation): WorkspaceData {
  const existing = data.conversations.find((item) => item.id === incoming.id);
  const existingCrossLibrary = existing && hasCrossLibraryIdentity(existing);
  const incomingCrossLibrary = hasCrossLibraryIdentity(incoming);
  const existingComparison = existing ? comparisonRouteFromConversation(existing) : undefined;
  const incomingComparison = comparisonRouteFromConversation(incoming);
  // Never persist a partial or forged virtual all-library identity. Validation
  // will reject it too, but keeping it out of local state prevents a later
  // update from being interpreted as a regular inbox conversation.
  if (incoming.scope === CROSS_LIBRARY_SCOPE && !incomingCrossLibrary) return data;
  // A comparison's route carries the full two-source/version identity. Do not
  // let malformed metadata enter local history and become an ordinary thread.
  if (incoming.comparison !== undefined && !incomingComparison) return data;
  if (existing?.comparison !== undefined && !existingComparison) return data;
  // A delayed response may change message content, but it can never turn a
  // normal conversation into a virtual all-library or fixed-pair identity (or
  // widen a saved range). Keep the last known safe record on mismatch.
  if (
    existing &&
    (existingCrossLibrary !== incomingCrossLibrary ||
      Boolean(existingComparison) !== Boolean(incomingComparison) ||
      (existingCrossLibrary && !sameSourceRange(existing.sourceIds, incoming.sourceIds)) ||
      (existingComparison &&
        (!incomingComparison || !sameComparisonRoute(existingComparison, incomingComparison))))
  )
    return data;

  if (incomingCrossLibrary && crossLibraryVersionLock(incoming) === undefined) return data;
  if (incomingComparison && comparisonVersionLock(incoming, incomingComparison) === undefined)
    return data;
  if (existingCrossLibrary) {
    const existingLock = crossLibraryVersionLock(existing!);
    const incomingLock = crossLibraryVersionLock(incoming);
    // The very first user message has no answer attempt yet. Once any attempt
    // has established a source-version lock, a late write may update content
    // only when it carries that same complete lock.
    if (
      existingLock === undefined ||
      (existingLock !== null &&
        (incomingLock === null ||
          incomingLock === undefined ||
          !sameSourceVersions(existingLock, incomingLock)))
    )
      return data;
  }
  if (existingComparison) {
    const existingLock = comparisonVersionLock(existing!, existingComparison);
    const incomingLock = incomingComparison
      ? comparisonVersionLock(incoming, incomingComparison)
      : undefined;
    // Once a fixed-pair attempt exists, an old first-message draft cannot
    // replace it. All later attempts must carry the exact route identity.
    if (
      existingLock === undefined ||
      incomingLock === undefined ||
      (existingLock !== null && incomingLock === null)
    )
      return data;
  }
  const spaceId = existing
    ? existing.spaceId
    : incomingCrossLibrary
      ? "all"
      : incoming.spaceId === "inbox" || data.spaces.some((space) => space.id === incoming.spaceId)
        ? incoming.spaceId
        : "inbox";
  const saved = existingCrossLibrary
    ? {
        ...incoming,
        spaceId: "all",
        scope: existing.scope,
        sourceIds: [...existing.sourceIds],
      }
    : existingComparison
      ? {
          ...incoming,
          spaceId: existing!.spaceId,
          scope: existing!.scope,
          sourceIds: [...existing!.sourceIds],
          comparison: { ...existing!.comparison! },
        }
      : { ...incoming, spaceId };

  return {
    ...data,
    conversations: existing
      ? data.conversations.map((item) => (item.id === saved.id ? saved : item))
      : [saved, ...data.conversations],
  };
}
