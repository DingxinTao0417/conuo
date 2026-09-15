import { describe, expect, it } from "vitest";
import {
  formatConversationRoute,
  parseConversationRoute,
  resolveConversationRoute,
} from "./conversation-route";
import { createComparisonConversationMetadata } from "./comparison-conversation";
import { CROSS_LIBRARY_SCOPE, createCrossLibraryAnswerRequest } from "./cross-library-ask";
import { createDemoWorkspace } from "./seed";
import type { AnswerScopeSnapshot, Conversation, WorkspaceData } from "./types";

const now = "2026-09-13T00:00:00.000Z";

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  const data = createDemoWorkspace();
  const source = data.sources[0]!;
  return {
    id: "conversation-a",
    spaceId: data.spaces[0]!.id,
    sourceId: source.id,
    title: "学习率问题",
    scope: "document",
    sourceIds: [source.id],
    messages: [],
    resolved: false,
    updatedAt: now,
    ...overrides,
  };
}

function crossLibraryConversation(data: WorkspaceData): Conversation {
  const firstSpace = data.spaces[0]!;
  const secondSpace = {
    ...firstSpace,
    id: "cross-route-space-b",
    name: "跨库第二空间",
  };
  data.spaces.push(secondSpace);
  data.sources[1]!.spaceIds = [secondSpace.id];
  const request = createCrossLibraryAnswerRequest(data, {
    question: "两个资料如何解释学习率？",
    requestId: "cross-route-request",
    sourceIds: [data.sources[0]!.id, data.sources[1]!.id],
  });
  const scopeSnapshot: AnswerScopeSnapshot = {
    scope: request.scope,
    spaceId: request.spaceId,
    sourceIds: [...request.sourceIds],
    sourceVersions: request.sourceVersions?.map((item) => ({ ...item })),
  };
  return {
    id: "cross-library-thread",
    spaceId: "all",
    title: "跨库问题",
    scope: CROSS_LIBRARY_SCOPE,
    sourceIds: [...request.sourceIds],
    messages: [
      {
        id: "cross-question",
        role: "user",
        content: request.question,
        citations: [],
        createdAt: now,
      },
      {
        id: "cross-answer",
        role: "assistant",
        content: "固定范围的回答",
        citations: [],
        createdAt: now,
        attempt: {
          id: "cross-attempt",
          questionMessageId: "cross-question",
          scopeSnapshot,
          status: "completed",
        },
      },
    ],
    resolved: false,
    updatedAt: now,
  };
}

describe("conversation route", () => {
  it("round-trips one encoded conversation identity", () => {
    const route = { conversationId: "问答 / 1?" };
    expect(formatConversationRoute(route)).toBe("#conversation/%E9%97%AE%E7%AD%94%20%2F%201%3F");
    expect(parseConversationRoute(formatConversationRoute(route))).toEqual(route);
  });

  it.each([
    "conversation/conversation-a",
    "#conversation",
    "#conversation/",
    "#conversation/a/b",
    "#source/conversation-a",
    "#conversation/%E0%A4%A",
    "#conversation/%00",
  ])("rejects a malformed or non-canonical fragment: %s", (hash) => {
    expect(parseConversationRoute(hash)).toBeUndefined();
  });

  it("opens only the matching current-account conversation in its current source", () => {
    const data = createDemoWorkspace();
    const saved = conversation({
      id: "conversation-a",
      spaceId: data.spaces[0]!.id,
      sourceId: data.sources[0]!.id,
      sourceIds: [data.sources[0]!.id],
    });
    data.conversations = [saved];

    expect(resolveConversationRoute(data, { conversationId: saved.id })).toMatchObject({
      kind: "source",
      conversation: { id: saved.id },
      source: { id: data.sources[0]!.id },
    });
    // A route is resolved only from this account-scoped snapshot. An ID not
    // present here has the same safe result whether it is malformed history or
    // belongs to another account.
    expect(resolveConversationRoute(data, { conversationId: "other-account-thread" })).toEqual({
      kind: "unavailable",
    });
  });

  it("keeps a retained transcript read-only when its source is no longer safe to reopen", () => {
    const data = createDemoWorkspace();
    const saved = conversation({
      id: "conversation-a",
      spaceId: data.spaces[0]!.id,
      sourceId: data.sources[0]!.id,
      sourceIds: [data.sources[0]!.id],
    });
    data.conversations = [saved];
    data.sources[0] = { ...data.sources[0]!, deletedAt: now };

    expect(resolveConversationRoute(data, { conversationId: saved.id })).toMatchObject({
      kind: "history",
      conversation: { id: saved.id },
      reason: "source-unavailable",
    });
  });

  it("keeps a retained transcript read-only when its learning space is no longer available", () => {
    const data = createDemoWorkspace();
    const saved = conversation({
      id: "conversation-a",
      spaceId: data.spaces[0]!.id,
      sourceId: data.sources[0]!.id,
      sourceIds: [data.sources[0]!.id],
    });
    data.conversations = [saved];
    data.spaces[0] = { ...data.spaces[0]!, archived: true };

    expect(resolveConversationRoute(data, { conversationId: saved.id })).toMatchObject({
      kind: "history",
      conversation: { id: saved.id },
      reason: "space-unavailable",
    });
  });

  it("reopens a comparison conversation in its exact fixed-version route", () => {
    const data = createDemoWorkspace();
    const [left, right] = data.sources;
    const space = data.spaces[0]!;
    const route = {
      leftSourceId: left!.id,
      leftVersionId: left!.versionId,
      rightSourceId: right!.id,
      rightVersionId: right!.versionId,
      spaceId: space.id,
    };
    const saved = conversation({
      id: "comparison-thread",
      spaceId: space.id,
      sourceId: undefined,
      scope: "sources",
      sourceIds: [left!.id, right!.id],
      comparison: createComparisonConversationMetadata(route),
    });
    data.conversations = [saved];

    expect(resolveConversationRoute(data, { conversationId: saved.id })).toMatchObject({
      kind: "comparison",
      conversation: { id: saved.id },
      route,
    });
  });

  it("keeps a comparison transcript read-only when either fixed side is no longer safe", () => {
    const data = createDemoWorkspace();
    const [left, right] = data.sources;
    const space = data.spaces[0]!;
    const route = {
      leftSourceId: left!.id,
      leftVersionId: left!.versionId,
      rightSourceId: right!.id,
      rightVersionId: right!.versionId,
      spaceId: space.id,
    };
    const saved = conversation({
      id: "comparison-thread",
      spaceId: space.id,
      sourceId: undefined,
      scope: "sources",
      sourceIds: [left!.id, right!.id],
      comparison: createComparisonConversationMetadata(route),
    });
    data.conversations = [saved];
    data.sources[1] = { ...right!, deletedAt: now };

    expect(resolveConversationRoute(data, { conversationId: saved.id })).toMatchObject({
      kind: "history",
      conversation: { id: saved.id },
      reason: "comparison-read-only",
    });
  });

  it("reopens an explicit cross-library conversation only with its fixed source versions", () => {
    const data = createDemoWorkspace();
    const saved = crossLibraryConversation(data);
    data.conversations = [saved];

    expect(resolveConversationRoute(data, { conversationId: saved.id })).toMatchObject({
      kind: "cross-library",
      conversation: {
        id: saved.id,
        scope: CROSS_LIBRARY_SCOPE,
        spaceId: "all",
        sourceIds: [data.sources[0]!.id, data.sources[1]!.id],
      },
    });
  });

  it.each([
    ["a deleted source", (data: WorkspaceData) => (data.sources[1]!.deletedAt = now)],
    ["an AI-disabled source", (data: WorkspaceData) => (data.sources[1]!.aiAllowed = false)],
    [
      "a source whose parsing is no longer ready",
      (data: WorkspaceData) => (data.sources[1]!.status = "parsing"),
    ],
    [
      "an archived final space membership",
      (data: WorkspaceData) => {
        const source = data.sources[1]!;
        data.spaces
          .filter((space) => source.spaceIds.includes(space.id))
          .forEach((space) => {
            space.archived = true;
          });
      },
    ],
    [
      "a changed fixed source version",
      (data: WorkspaceData) => (data.sources[1]!.versionId = "new-version"),
    ],
  ])("keeps cross-library history read-only after %s", (_name, mutate) => {
    const data = createDemoWorkspace();
    const saved = crossLibraryConversation(data);
    data.conversations = [saved];
    mutate(data);

    expect(resolveConversationRoute(data, { conversationId: saved.id })).toMatchObject({
      kind: "history",
      conversation: { id: saved.id },
      reason: "cross-library-read-only",
    });
  });

  it("does not open an unsnapshotted cross-library draft as a writable conversation", () => {
    const data = createDemoWorkspace();
    const saved = crossLibraryConversation(data);
    saved.messages = saved.messages.filter((message) => message.role === "user");
    data.conversations = [saved];

    expect(resolveConversationRoute(data, { conversationId: saved.id })).toMatchObject({
      kind: "history",
      conversation: { id: saved.id },
      reason: "cross-library-read-only",
    });
  });

  it("accepts a query suffix from restored internal links", () => {
    expect(parseConversationRoute("#conversation/conversation-a?restored=1")).toEqual({
      conversationId: "conversation-a",
    });
  });
});
