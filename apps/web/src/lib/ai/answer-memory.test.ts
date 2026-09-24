import { describe, expect, it } from "vitest";
import { createDemoWorkspace } from "../seed";
import type { Citation, Conversation, Message } from "../types";
import { priorAnswerContext } from "./answer-memory";

function fixture() {
  const data = createDemoWorkspace();
  const source = data.sources[0]!;
  const chunk = source.chunks[0]!;
  const citation: Citation = {
    sourceId: source.id,
    versionId: source.versionId,
    chunkId: chunk.id,
    title: source.title,
    quote: chunk.text,
    section: chunk.section,
    page: chunk.page,
  };
  const request = {
    question: "再解释一次",
    scope: "document" as const,
    sourceId: source.id,
    sourceIds: [],
    spaceId: data.spaces[0]!.id,
    conversationId: "conversation-memory",
  };
  const snapshot = {
    scope: request.scope,
    sourceId: request.sourceId,
    sourceIds: request.sourceIds,
    spaceId: request.spaceId,
  };
  const message = (id: string, content: string, overrides: Partial<Message> = {}): Message => ({
    id,
    role: "assistant",
    content,
    citations: [citation],
    createdAt: `2026-09-2${id.slice(-1)}T00:00:00.000Z`,
    mode: "model",
    attempt: {
      id: `attempt-${id}`,
      questionMessageId: `question-${id}`,
      scopeSnapshot: snapshot,
      status: "completed",
    },
    ...overrides,
  });
  const conversation: Conversation = {
    id: request.conversationId,
    spaceId: request.spaceId,
    sourceId: source.id,
    title: "记忆测试",
    scope: request.scope,
    sourceIds: [],
    messages: [
      message("answer-1", "第一条已完成回答"),
      message("answer-2", "第二条回答\n\n---\n\n覆盖说明 [1] [[conuo-citation:1]]"),
      message("answer-3", "失败回答", { error: "模型失败" }),
      message("answer-4", "extractive 回答", { mode: "extractive" }),
      {
        ...message("answer-5", "最新回答"),
        citations: [{ ...citation, versionId: "old-version" }],
      },
    ],
    resolved: false,
    updatedAt: "2026-09-24T00:00:00.000Z",
  };
  data.conversations = [conversation];
  return { data, request, citation, message };
}

describe("prior answer memory", () => {
  it("keeps at most two completed model answers and strips coverage/citation markers", () => {
    const { data, request } = fixture();
    const result = priorAnswerContext(data, request, [data.sources[0]!]);
    expect(result.answers).toEqual([{ text: "第二条回答" }, { text: "最新回答" }]);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({ sourceId: data.sources[0]!.id });
    expect(result.key).toEqual(expect.any(String));
  });

  it("drops citations from changed versions and sources outside the selected source set", () => {
    const { data, request, citation, message } = fixture();
    const foreignSpace = { ...data.spaces[0]!, id: "foreign-space" };
    const foreignSource = {
      ...data.sources[1]!,
      id: "foreign-source",
      spaceIds: [foreignSpace.id],
    };
    data.spaces.push(foreignSpace);
    data.sources.push(foreignSource);
    const foreignCitation = {
      ...citation,
      sourceId: foreignSource.id,
      versionId: foreignSource.versionId,
      chunkId: foreignSource.chunks[0]!.id,
      quote: foreignSource.chunks[0]!.text,
      title: foreignSource.title,
    };
    data.conversations[0]!.messages = [
      message("answer-6", "回答", {
        citations: [citation, { ...citation, versionId: "old-version" }, foreignCitation],
      }),
    ];
    const result = priorAnswerContext(data, request, [data.sources[0]!]);
    expect(result.citations).toEqual([citation]);
  });

  it("changes the memory key when remembered text changes", () => {
    const { data, request } = fixture();
    const before = priorAnswerContext(data, request, [data.sources[0]!]).key;
    data.conversations[0]!.messages[1]!.content = "改写后的第二条回答";
    const after = priorAnswerContext(data, request, [data.sources[0]!]).key;
    expect(after).not.toBe(before);
  });
});
