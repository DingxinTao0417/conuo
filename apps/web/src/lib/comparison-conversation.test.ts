import { describe, expect, it } from "vitest";
import type { ComparisonRoute } from "./comparison-route";
import {
  comparisonRouteFromConversation,
  createComparisonConversationMetadata,
  isConversationForComparisonRoute,
  type ComparisonConversation,
} from "./comparison-conversation";

const route: ComparisonRoute = {
  leftSourceId: "source-left",
  leftVersionId: "version-left",
  rightSourceId: "source-right",
  rightVersionId: "version-right",
  spaceId: "space-a",
};

function conversation(patch: Partial<ComparisonConversation> = {}): ComparisonConversation {
  return {
    id: "conversation-a",
    spaceId: route.spaceId,
    title: "两份资料的对照",
    scope: "sources",
    sourceIds: [route.leftSourceId, route.rightSourceId],
    messages: [],
    resolved: false,
    updatedAt: "2026-09-13T12:00:00.000Z",
    comparison: createComparisonConversationMetadata(route),
    ...patch,
  };
}

describe("comparison conversation identity", () => {
  it("captures fixed left/right versions and restores their canonical route", () => {
    const metadata = createComparisonConversationMetadata(route);
    const saved = conversation({ comparison: metadata });

    expect(metadata).toEqual({
      leftSourceId: "source-left",
      leftVersionId: "version-left",
      rightSourceId: "source-right",
      rightVersionId: "version-right",
    });
    expect(comparisonRouteFromConversation(saved)).toEqual(route);
    expect(isConversationForComparisonRoute(saved, route)).toBe(true);
  });

  it("keeps a historical version in its identity instead of rewriting it to a current version", () => {
    const historical: ComparisonRoute = { ...route, leftVersionId: "version-left-v1" };
    const saved = conversation({ comparison: createComparisonConversationMetadata(historical) });

    expect(comparisonRouteFromConversation(saved)).toEqual(historical);
    expect(isConversationForComparisonRoute(saved, historical)).toBe(true);
    expect(isConversationForComparisonRoute(saved, route)).toBe(false);
  });

  it.each([
    ["wrong space", conversation({ spaceId: "space-b" })],
    [
      "wrong left source",
      conversation({
        comparison: { ...createComparisonConversationMetadata(route), leftSourceId: "other" },
      }),
    ],
    [
      "wrong left version",
      conversation({
        comparison: {
          ...createComparisonConversationMetadata(route),
          leftVersionId: "other-version",
        },
      }),
    ],
    [
      "wrong right source",
      conversation({
        comparison: { ...createComparisonConversationMetadata(route), rightSourceId: "other" },
      }),
    ],
    [
      "wrong right version",
      conversation({
        comparison: {
          ...createComparisonConversationMetadata(route),
          rightVersionId: "other-version",
        },
      }),
    ],
  ] as const)("does not match a route with a %s", (_label, saved) => {
    expect(isConversationForComparisonRoute(saved, route)).toBe(false);
  });

  it.each([
    ["missing metadata", conversation({ comparison: undefined })],
    ["single-document scope", conversation({ scope: "document" })],
    ["a primary source id", conversation({ sourceId: route.leftSourceId })],
    ["one source", conversation({ sourceIds: [route.leftSourceId] })],
    ["a duplicated source", conversation({ sourceIds: [route.leftSourceId, route.leftSourceId] })],
    ["an unrelated source", conversation({ sourceIds: [route.leftSourceId, "other"] })],
    [
      "same sources in metadata",
      conversation({
        comparison: {
          ...createComparisonConversationMetadata(route),
          rightSourceId: route.leftSourceId,
        },
      }),
    ],
    [
      "blank version in metadata",
      conversation({
        comparison: { ...createComparisonConversationMetadata(route), rightVersionId: "" },
      }),
    ],
  ] as const)("rejects %s", (_label, saved) => {
    expect(comparisonRouteFromConversation(saved)).toBeUndefined();
    expect(isConversationForComparisonRoute(saved, route)).toBe(false);
  });

  it("does not mutate caller-owned route data", () => {
    const mutable = { ...route };
    const metadata = createComparisonConversationMetadata(mutable);
    mutable.leftVersionId = "new-version";

    expect(metadata.leftVersionId).toBe(route.leftVersionId);
  });

  it.each([
    { ...route, leftSourceId: "" },
    { ...route, leftVersionId: "" },
    { ...route, rightSourceId: "" },
    { ...route, rightVersionId: "" },
    { ...route, spaceId: "" },
    { ...route, rightSourceId: route.leftSourceId },
  ])("refuses malformed comparison metadata input", (invalid) => {
    expect(() => createComparisonConversationMetadata(invalid)).toThrow();
    expect(isConversationForComparisonRoute(conversation(), invalid)).toBe(false);
  });
});
