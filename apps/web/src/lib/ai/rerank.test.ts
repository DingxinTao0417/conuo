import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ fetch: vi.fn() }));

import { readRerankConfig, rerank } from "./rerank";

const env = {
  CONUO_RERANK_BASE_URL: "https://rerank.example/v1",
  CONUO_RERANK_API_KEY: "private-rerank-key",
  CONUO_RERANK_MODEL: "rerank-model",
};
const config = readRerankConfig(env)!;
const response = (data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", ...headers },
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mock.fetch);
  mock.fetch.mockResolvedValue(
    response({
      results: [
        { index: 1, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.2 },
      ],
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("rerank configuration", () => {
  it("requires all provider connection fields and keeps bounded defaults", () => {
    expect(readRerankConfig({})).toBeNull();
    expect(config).toMatchObject({ maxCandidates: 40, topN: 12 });
    expect(() => readRerankConfig({ ...env, CONUO_RERANK_TOP_N: "3" })).toThrow();
    expect(() =>
      readRerankConfig({ ...env, CONUO_RERANK_BASE_URL: "http://provider.example/v1" }),
    ).toThrow();
  });
});

describe("rerank provider boundary", () => {
  it("posts bounded documents and returns provider indexes by score", async () => {
    await expect(rerank(config, "学习率", ["第一段", "第二段"])).resolves.toEqual([1, 0]);
    expect(mock.fetch).toHaveBeenCalledOnce();
    const [url, init] = mock.fetch.mock.calls[0];
    expect(url).toBe("https://rerank.example/v1/rerank");
    expect(init).toMatchObject({ method: "POST", redirect: "manual", cache: "no-store" });
    expect(JSON.parse(init.body)).toEqual({
      model: "rerank-model",
      query: "学习率",
      documents: ["第一段", "第二段"],
      top_n: 2,
      return_documents: false,
    });
  });

  it("rejects duplicate or out-of-range provider indexes", async () => {
    mock.fetch.mockResolvedValueOnce(
      response({
        results: [
          { index: 0, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.8 },
        ],
      }),
    );
    await expect(rerank(config, "query", ["one", "two"])).rejects.toMatchObject({
      status: 502,
      code: "MODEL_RESPONSE",
    });
  });
});
