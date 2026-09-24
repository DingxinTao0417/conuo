import { describe, expect, it, vi } from "vitest";
import type { Source } from "../types";

const mock = vi.hoisted(() => ({ callModel: vi.fn() }));
vi.mock("./model", () => ({ callModel: mock.callModel }));

import { REWRITE_CONTRACT_VERSION, needsRewrite, rewriteQuery } from "./query-rewrite";

const source = (text: string): Source =>
  ({
    id: "source-1",
    versionId: "version-1",
    title: "资料",
    filename: "source.txt",
    kind: "text",
    mime: "text/plain",
    size: text.length,
    hash: "a".repeat(64),
    spaceIds: ["space-1"],
    tags: [],
    status: "ready",
    text,
    chunks: [],
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
    deletedAt: null,
    aiAllowed: true,
    starred: false,
  }) as Source;

describe("query rewrite", () => {
  it("only rewrites short follow-ups when user context exists", () => {
    expect(needsRewrite("学习率如何？", [], [source("学习率控制更新步长。")])).toBe(false);
    expect(
      needsRewrite("为什么？", ["学习率是什么"], [source("Learning rate controls updates.")]),
    ).toBe(true);
    expect(
      needsRewrite(
        "this again",
        ["what is the learning rate"],
        [source("Learning rate controls updates.")],
      ),
    ).toBe(true);
    expect(needsRewrite("学习率是什么", [], [source("The learning rate controls updates.")])).toBe(
      true,
    );
  });

  it("accepts only the strict rewrite contract and falls back on invalid JSON", async () => {
    expect(REWRITE_CONTRACT_VERSION).toBe("rewrite-v1");
    const config = {
      baseUrl: "https://model.example/v1",
      apiKey: "secret",
      model: "fast",
      jsonMode: true,
      tokenLimitParameter: "max_completion_tokens" as const,
      timeoutMs: 45_000,
    };
    mock.callModel.mockResolvedValueOnce("not-json");
    await expect(
      rewriteQuery(config, {
        question: "为什么？",
        priorUserQuestions: ["学习率是什么"],
        documentLanguage: "en",
      }),
    ).resolves.toBeNull();
  });
});
