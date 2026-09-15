import { describe, expect, it } from "vitest";
import {
  CROSS_LIBRARY_SCOPE,
  createCrossLibraryAnswerRequest,
  crossLibrarySourceEligibility,
  resolveCrossLibraryConversation,
  validateCrossLibraryAnswerRequest,
  type CrossLibraryErrorCode,
} from "./cross-library-ask";
import { createDemoWorkspace } from "./seed";
import type {
  AnswerRequest,
  AnswerScopeSnapshot,
  Conversation,
  Source,
  WorkspaceData,
} from "./types";

const now = "2026-09-13T00:00:00.000Z";

function twoSpaceWorkspace() {
  const data = createDemoWorkspace();
  const firstSpace = data.spaces[0]!;
  const secondSpace = {
    ...firstSpace,
    id: "cross-library-space-b",
    name: "第二知识库",
  };
  data.spaces.push(secondSpace);
  data.sources[1]!.spaceIds = [secondSpace.id];
  return { data, first: data.sources[0]!, second: data.sources[1]!, firstSpace, secondSpace };
}

function crossRequest(
  data: WorkspaceData,
  sourceIds = data.sources.slice(0, 2).map((source) => source.id),
) {
  return createCrossLibraryAnswerRequest(data, {
    question: "学习率过高时会有什么表现？",
    requestId: "cross-request",
    sourceIds,
  });
}

function snapshot(request: AnswerRequest): AnswerScopeSnapshot {
  return {
    scope: request.scope,
    spaceId: request.spaceId,
    sourceIds: [...request.sourceIds],
    sourceVersions: request.sourceVersions?.map((item) => ({ ...item })),
  };
}

function lockedConversation(data: WorkspaceData, request = crossRequest(data)): Conversation {
  return {
    id: "cross-library-thread",
    spaceId: "all",
    title: "跨库学习率问题",
    scope: CROSS_LIBRARY_SCOPE,
    sourceIds: [...request.sourceIds],
    messages: [
      {
        id: "question-message",
        role: "user",
        content: request.question,
        citations: [],
        createdAt: now,
      },
      {
        id: "answer-message",
        role: "assistant",
        content: "已基于固定资料范围回答。",
        citations: [],
        createdAt: now,
        attempt: {
          id: "cross-attempt",
          questionMessageId: "question-message",
          scopeSnapshot: snapshot(request),
          status: "completed",
        },
      },
    ],
    resolved: false,
    updatedAt: now,
  };
}

function copiedSource(data: WorkspaceData, source: Source, index: number) {
  const copy = structuredClone(source);
  copy.id = `cross-source-${index}`;
  copy.versionId = `cross-version-${index}`;
  copy.chunks = copy.chunks.map((chunk, chunkIndex) => ({
    ...chunk,
    id: `cross-chunk-${index}-${chunkIndex}`,
    sourceId: copy.id,
    versionId: copy.versionId,
  }));
  data.sources.push(copy);
  return copy;
}

function expectFailure(data: WorkspaceData, request: AnswerRequest, code: CrossLibraryErrorCode) {
  const result = validateCrossLibraryAnswerRequest(data, request);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected the cross-library request to be rejected.");
  expect(result.error.code).toBe(code);
}

const unavailableScenarios: Array<{
  name: string;
  mutate(data: WorkspaceData, source: Source): void;
  code: CrossLibraryErrorCode;
  eligibilityReason: "recycled" | "ai-disabled" | "not-ready" | "no-active-space";
}> = [
  {
    name: "recycled source",
    mutate: (_data, source) => {
      source.deletedAt = now;
    },
    code: "CROSS_LIBRARY_SOURCE_RECYCLED",
    eligibilityReason: "recycled",
  },
  {
    name: "AI-disabled source",
    mutate: (_data, source) => {
      source.aiAllowed = false;
    },
    code: "CROSS_LIBRARY_AI_DISABLED",
    eligibilityReason: "ai-disabled",
  },
  {
    name: "unparsed source",
    mutate: (_data, source) => {
      source.status = "parsing";
    },
    code: "CROSS_LIBRARY_SOURCE_NOT_READY",
    eligibilityReason: "not-ready",
  },
  {
    name: "archived final membership",
    mutate: (data, source) => {
      data.spaces
        .filter((space) => source.spaceIds.includes(space.id))
        .forEach((space) => {
          space.archived = true;
        });
    },
    code: "CROSS_LIBRARY_SPACE_UNAVAILABLE",
    eligibilityReason: "no-active-space",
  },
];

describe("explicit cross-library answer boundary", () => {
  it("accepts a deliberate one-to-five source range across active spaces and locks versions", () => {
    const { data, first } = twoSpaceWorkspace();
    const one = crossRequest(data, [first.id]);
    expect(one).toMatchObject({
      scope: CROSS_LIBRARY_SCOPE,
      spaceId: "all",
      sourceIds: [first.id],
      sourceVersions: [{ sourceId: first.id, versionId: first.versionId }],
    });

    for (let index = 3; index <= 5; index++) copiedSource(data, first, index);
    const selected = data.sources.slice(0, 5).map((source) => source.id);
    const five = crossRequest(data, selected);
    const checked = validateCrossLibraryAnswerRequest(data, five);
    expect(checked.ok).toBe(true);
    if (!checked.ok) throw checked.error;
    expect(checked.sources.map((source) => source.id)).toEqual(selected);
    expect(checked.sourceVersions).toEqual(
      selected.map((sourceId) => ({
        sourceId,
        versionId: data.sources.find((source) => source.id === sourceId)!.versionId,
      })),
    );

    const six = copiedSource(data, first, 6);
    expectFailure(
      data,
      { ...five, sourceIds: [...five.sourceIds, six.id] },
      "CROSS_LIBRARY_SELECTION_LIMIT",
    );
  });

  it("rejects an empty, duplicated, or unversioned selection instead of broadening it", () => {
    const { data, first, second } = twoSpaceWorkspace();
    const valid = crossRequest(data);
    expectFailure(
      data,
      { ...valid, sourceIds: [], sourceVersions: [] },
      "CROSS_LIBRARY_SELECTION_REQUIRED",
    );
    expectFailure(
      data,
      {
        ...valid,
        sourceIds: [first.id, first.id],
        sourceVersions: [
          { sourceId: first.id, versionId: first.versionId },
          { sourceId: first.id, versionId: first.versionId },
        ],
      },
      "CROSS_LIBRARY_SELECTION_DUPLICATE",
    );
    expectFailure(
      data,
      { ...valid, sourceVersions: [{ sourceId: first.id, versionId: first.versionId }] },
      "CROSS_LIBRARY_VERSION_REQUIRED",
    );
    expectFailure(
      data,
      {
        ...valid,
        sourceIds: [first.id, second.id],
        sourceVersions: [
          { sourceId: first.id, versionId: first.versionId },
          { sourceId: "not-selected", versionId: second.versionId },
        ],
      },
      "CROSS_LIBRARY_VERSION_REQUIRED",
    );
  });

  it.each(unavailableScenarios)("does not silently drop a $name", (scenario) => {
    const { data, second } = twoSpaceWorkspace();
    const request = crossRequest(data);
    scenario.mutate(data, second);
    expect(crossLibrarySourceEligibility(data, second)).toMatchObject({
      available: false,
      reason: scenario.eligibilityReason,
    });
    expectFailure(data, request, scenario.code);
  });

  it("keeps a saved follow-up bound to its original source versions", () => {
    const { data, second } = twoSpaceWorkspace();
    const request = crossRequest(data);
    const conversation = lockedConversation(data, request);

    const resolved = resolveCrossLibraryConversation(data, conversation);
    expect(resolved).toMatchObject({
      ok: true,
      request: {
        scope: CROSS_LIBRARY_SCOPE,
        spaceId: "all",
        sourceIds: request.sourceIds,
        sourceVersions: request.sourceVersions,
      },
    });

    second.versionId = "replacement-version";
    const stale = resolveCrossLibraryConversation(data, conversation);
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("Expected a stale fixed conversation to be read-only.");
    expect(stale.error.code).toBe("CROSS_LIBRARY_VERSION_CHANGED");
  });

  it("refuses a conversation whose recorded attempts disagree on the fixed range", () => {
    const { data, first, second } = twoSpaceWorkspace();
    const request = crossRequest(data);
    const conversation = lockedConversation(data, request);
    conversation.messages.push({
      id: "second-answer",
      role: "assistant",
      content: "不应允许混合范围。",
      citations: [],
      createdAt: now,
      attempt: {
        id: "second-attempt",
        questionMessageId: "question-message",
        scopeSnapshot: {
          ...snapshot(request),
          sourceVersions: [
            { sourceId: first.id, versionId: first.versionId },
            { sourceId: second.id, versionId: "different-version" },
          ],
        },
        status: "completed",
      },
    });

    const resolved = resolveCrossLibraryConversation(data, conversation);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("Expected inconsistent fixed range to remain read-only.");
    expect(resolved.error.code).toBe("CROSS_LIBRARY_CONVERSATION_UNBOUND");
  });
});
