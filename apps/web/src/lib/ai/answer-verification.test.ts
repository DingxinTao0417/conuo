import { beforeEach, describe, expect, it, vi } from "vitest";
import { findUnsupportedParagraphs, VERIFY_CONTRACT_VERSION } from "./answer-verification";
import type { Grounding } from "./grounding";
import type { ModelConfig } from "./model";

const mock = vi.hoisted(() => ({ callModel: vi.fn() }));
vi.mock("./model", () => ({ callModel: mock.callModel }));

const config: ModelConfig = {
  baseUrl: "https://model.example",
  apiKey: "test-key",
  model: "fast",
  jsonMode: true,
  tokenLimitParameter: "max_tokens",
  timeoutMs: 1000,
};

function grounding(): Grounding {
  return {
    evidence: [
      {
        sourceId: "source-1",
        versionId: "version-1",
        chunkId: "chunk-1",
        title: "资料",
        quote: "证据一。".repeat(1000),
        section: "",
        page: 1,
      },
      {
        sourceId: "source-1",
        versionId: "version-1",
        chunkId: "chunk-2",
        title: "资料",
        quote: "证据二。",
        section: "",
        page: 2,
      },
    ],
    noteEvidence: [],
    coverage: "依据范围",
    fallback: { mode: "model", citations: [], content: "证据不足" },
    layout: "retrieval",
  };
}

describe("answer verification", () => {
  beforeEach(() => mock.callModel.mockReset());

  it("uses only source paragraphs and truncates cited evidence", async () => {
    mock.callModel.mockResolvedValue(
      JSON.stringify({ results: [{ paragraph: 1, verdict: "supported" }] }),
    );
    const answer = {
      status: "answered" as const,
      paragraphs: [
        { text: "来源结论", kind: "source" as const, evidenceIndexes: [0], noteIndexes: [] },
        { text: "我的笔记", kind: "note" as const, evidenceIndexes: [], noteIndexes: [] },
        { text: "推断", kind: "inference" as const, evidenceIndexes: [1], noteIndexes: [] },
      ],
    };

    const unsupported = await findUnsupportedParagraphs(
      config,
      answer,
      grounding(),
      new AbortController().signal,
    );

    expect(unsupported).toEqual(new Set());
    const messages = mock.callModel.mock.calls[0][1] as Array<{ role: string; content: string }>;
    const payload = JSON.parse(messages[1].content) as {
      paragraphs: Array<{ paragraph: number; evidence: Array<{ id: string; text: string }> }>;
    };
    expect(payload.paragraphs).toHaveLength(1);
    expect(payload.paragraphs[0]?.paragraph).toBe(1);
    expect(payload.paragraphs[0]?.evidence[0]?.text).toHaveLength(2000);
  });

  it("returns zero-based unsupported paragraph indexes", async () => {
    mock.callModel.mockResolvedValue(
      JSON.stringify({
        results: [
          { paragraph: 1, verdict: "unsupported" },
          { paragraph: 2, verdict: "partial" },
        ],
      }),
    );
    const answer = {
      status: "answered" as const,
      paragraphs: [
        { text: "第一段", kind: "source" as const, evidenceIndexes: [0], noteIndexes: [] },
        { text: "第二段", kind: "source" as const, evidenceIndexes: [1], noteIndexes: [] },
      ],
    };
    await expect(
      findUnsupportedParagraphs(config, answer, grounding(), new AbortController().signal),
    ).resolves.toEqual(new Set([0]));
  });

  it("rejects invalid verification JSON", async () => {
    mock.callModel.mockResolvedValue("not-json");
    const answer = {
      status: "answered" as const,
      paragraphs: [
        { text: "第一段", kind: "source" as const, evidenceIndexes: [0], noteIndexes: [] },
      ],
    };
    await expect(
      findUnsupportedParagraphs(config, answer, grounding(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "INVALID_MODEL_ANSWER" });
  });

  it("pins the verification contract version", () => {
    expect(VERIFY_CONTRACT_VERSION).toBe("verify-v1");
  });
});
