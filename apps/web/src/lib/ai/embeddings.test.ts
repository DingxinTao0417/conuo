import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ rpc: vi.fn(), fetch: vi.fn() }));
vi.mock("../supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("./requests", () => ({ createRequestStore: () => ({ rpc: mock.rpc }) }));

import { embedQuery, embedTexts, readEmbeddingConfig, reserveEmbeddingUsage } from "./embeddings";

const env = {
  CONUO_EMBEDDING_BASE_URL: "https://embedding.example/v1",
  CONUO_EMBEDDING_API_KEY: "private-provider-key",
  CONUO_EMBEDDING_MODEL: "embedding-model",
};
const config = readEmbeddingConfig(env)!;
const vector = () => [1, ...Array<number>(1535).fill(0)];
const payload = (embedding: unknown = vector()) => ({ data: [{ index: 0, embedding }] });
const response = (data: unknown = payload()) =>
  new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mock.fetch);
  vi.stubEnv("CONUO_EMBEDDING_DAILY_CHAR_LIMIT", "200000");
  mock.rpc.mockResolvedValue({ data: { allowed: true }, error: null });
  mock.fetch.mockImplementation(async () => response());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("embedding configuration boundary", () => {
  it("distinguishes an absent configuration from a partial one", () => {
    expect(readEmbeddingConfig({})).toBeNull();
    expect(() => readEmbeddingConfig({ CONUO_EMBEDDING_API_KEY: "secret" })).toThrow(
      expect.objectContaining({ status: 503, code: "EMBEDDING_CONFIGURATION" }),
    );
  });

  it("fingerprints the normalized endpoint and model, while allowing key rotation", () => {
    const rotated = readEmbeddingConfig({ ...env, CONUO_EMBEDDING_API_KEY: "rotated-key" })!;
    const slashed = readEmbeddingConfig({
      ...env,
      CONUO_EMBEDDING_BASE_URL: `${config.baseUrl}/`,
    })!;
    expect(config.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(rotated.fingerprint).toBe(config.fingerprint);
    expect(slashed.fingerprint).toBe(config.fingerprint);
    for (const changed of [
      { ...env, CONUO_EMBEDDING_BASE_URL: "https://other.example/v1" },
      { ...env, CONUO_EMBEDDING_MODEL: "another-model" },
    ])
      expect(readEmbeddingConfig(changed)!.fingerprint).not.toBe(config.fingerprint);
  });

  it.each(["http://localhost:8080/v1", "http://127.0.0.1:8080", "http://[::1]:8080/v1"])(
    "permits an explicit loopback development endpoint: %s",
    (url) => expect(readEmbeddingConfig({ ...env, CONUO_EMBEDDING_BASE_URL: url })).not.toBeNull(),
  );

  it.each([
    "http://provider.example/v1",
    "http://127.1/v1",
    "http://2130706433/v1",
    "http://0x7f000001/v1",
    "http://localhost.attacker.example/v1",
    "https://user:private-password@provider.example/v1",
    "https://provider.example/v1?key=private-password",
    "https://provider.example/v1#private-password",
    "https://provider.example/a/../v1",
    "https://provider.example/a/%2e%2e/v1",
    "https://provider.example\\attacker.example/v1",
    "file:///private-password",
  ])("rejects ambiguous or credential-bearing endpoint %s without echoing it", (url) => {
    try {
      readEmbeddingConfig({ ...env, CONUO_EMBEDDING_BASE_URL: url });
      expect.fail("Expected invalid configuration");
    } catch (error) {
      expect(error).toMatchObject({ status: 503, code: "EMBEDDING_CONFIGURATION" });
      expect(String(error)).not.toContain("private-password");
    }
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { CONUO_EMBEDDING_API_KEY: "bad\nkey" },
    { CONUO_EMBEDDING_API_KEY: "x".repeat(4097) },
    { CONUO_EMBEDDING_MODEL: "bad\rmodel" },
    { CONUO_EMBEDDING_MODEL: "x".repeat(257) },
  ])("rejects unsafe header/model settings %j", (override) => {
    expect(() => readEmbeddingConfig({ ...env, ...override })).toThrow();
  });
});

describe("embedding provider boundary (mock HTTP only)", () => {
  it("adds dimensions only when enabled and batches provider results by index", async () => {
    const batchConfig = readEmbeddingConfig({
      ...env,
      CONUO_EMBEDDING_DIMENSIONS_PARAM: "true",
      CONUO_EMBEDDING_BATCH_SIZE: "2",
    })!;
    expect(batchConfig.dimensionsParam).toBe(true);
    expect(batchConfig.batchSize).toBe(2);
    expect(batchConfig.fingerprint).not.toBe(config.fingerprint);
    mock.fetch.mockResolvedValue(
      response({
        object: "list",
        model: "embedding-model",
        data: [
          { object: "embedding", index: 1, embedding: [2, ...Array<number>(1535).fill(0)] },
          { object: "embedding", index: 0, embedding: vector() },
        ],
      }),
    );
    expect(await embedTexts(batchConfig, ["first", "second"])).toEqual([
      vector(),
      [2, ...Array<number>(1535).fill(0)],
    ]);
    const [, init] = mock.fetch.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      model: env.CONUO_EMBEDDING_MODEL,
      input: ["first", "second"],
      encoding_format: "float",
      dimensions: 1536,
    });
  });

  it("keeps the legacy embedding fingerprint when dimensions are disabled", () => {
    const legacy = readEmbeddingConfig({ ...env, CONUO_EMBEDDING_DIMENSIONS_PARAM: "false" })!;
    expect(legacy.dimensionsParam).toBe(false);
    expect(legacy.batchSize).toBe(10);
    expect(legacy.fingerprint).toBe(config.fingerprint);
  });

  it.each<[string[]]>([
    [[]],
    [Array.from({ length: 17 }, () => "x")],
    [[""]],
    [["x".repeat(24_001)]],
  ])("rejects invalid embedding batches before HTTP", async (texts) => {
    await expect(embedTexts(config, texts)).rejects.toMatchObject({
      status: 400,
      code: "EMBEDDING_INPUT_INVALID",
    });
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it("rejects a batch whose UTF-8 body exceeds the provider input limit", async () => {
    const texts = ["😀".repeat(30_001), "ok"];
    await expect(embedTexts(config, texts)).rejects.toMatchObject({
      status: 400,
      code: "EMBEDDING_INPUT_INVALID",
    });
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [429, 503, "EMBEDDING_PROVIDER_RETRYABLE"],
    [500, 503, "EMBEDDING_PROVIDER_RETRYABLE"],
    [400, 502, "EMBEDDING_PROVIDER_REJECTED"],
    [413, 502, "EMBEDDING_PROVIDER_REJECTED"],
  ])("maps provider status %i without exposing its body", async (status, expectedStatus, code) => {
    mock.fetch.mockResolvedValue(new Response("private-provider-body", { status }));
    await expect(embedTexts(config, ["query"])).rejects.toMatchObject({
      status: expectedStatus,
      code,
    });
  });

  it.each([
    [
      {
        object: "list",
        model: "embedding-model",
        data: [
          { object: "embedding", index: 0, embedding: vector() },
          { object: "embedding", index: 0, embedding: vector() },
        ],
      },
    ],
    [
      {
        object: "list",
        model: "embedding-model",
        data: [{ object: "embedding", index: 0, embedding: [1] }],
      },
    ],
    [
      {
        object: "list",
        model: "embedding-model",
        data: [{ object: "embedding", index: 0, embedding: Array<number>(1536).fill(0) }],
      },
    ],
  ])("rejects malformed batch provider data", async (data) => {
    mock.fetch.mockResolvedValue(response(data));
    await expect(embedTexts(config, ["query"])).rejects.toMatchObject({
      status: 502,
      code: "EMBEDDING_PROVIDER_REJECTED",
    });
  });

  it("posts only the requested query, with redirects disabled and no cache", async () => {
    expect(await embedQuery(config, " 学习率😀 ")).toEqual(vector());
    expect(mock.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mock.fetch.mock.calls[0];
    expect(url).toBe("https://embedding.example/v1/embeddings");
    expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.CONUO_EMBEDDING_API_KEY}`,
    });
    expect(JSON.parse(init.body)).toEqual({
      model: env.CONUO_EMBEDDING_MODEL,
      input: [" 学习率😀 "],
      encoding_format: "float",
    });
  });

  it.each(["  ", "a".repeat(4001)])("rejects invalid input before HTTP", async (query) => {
    await expect(embedQuery(config, query)).rejects.toMatchObject({ status: 400 });
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong dimension", Array<number>(1535).fill(1)],
    ["zero vector", Array<number>(1536).fill(0)],
    ["numeric string", ["1", ...Array<number>(1535).fill(0)]],
    ["null coordinate", [null, ...Array<number>(1535).fill(0)]],
    ["out-of-range coordinate", [1e11, ...Array<number>(1535).fill(0)]],
  ])("rejects %s", async (_label, embedding) => {
    mock.fetch.mockResolvedValue(response(payload(embedding)));
    await expect(embedQuery(config, "query")).rejects.toMatchObject({
      status: 502,
      code: "EMBEDDING_RESPONSE",
    });
  });

  it("rejects non-finite JSON numbers without accepting JSON parser overflow", async () => {
    mock.fetch.mockResolvedValue(
      new Response(`{"data":[{"index":0,"embedding":[1e999,${Array(1535).fill(0).join(",")}]}]}`, {
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(embedQuery(config, "query")).rejects.toMatchObject({ code: "EMBEDDING_RESPONSE" });
  });

  it.each([
    { data: [] },
    { data: [{ index: 1, embedding: vector() }] },
    { data: [payload(), payload()] },
  ])("requires exactly the indexed response for the sole input", async (data) => {
    mock.fetch.mockResolvedValue(response(data));
    await expect(embedQuery(config, "query")).rejects.toMatchObject({ code: "EMBEDDING_RESPONSE" });
  });

  it.each(["text/html", "application/json"])("bounds response bytes even for %s", async (mime) => {
    mock.fetch.mockResolvedValue(
      new Response("x".repeat(256 * 1024 + 1), { headers: { "Content-Type": mime } }),
    );
    await expect(embedQuery(config, "query")).rejects.toMatchObject({ code: "EMBEDDING_RESPONSE" });
  });

  it("cancels an advertised oversized body without consuming it", async () => {
    const cancel = vi.fn();
    mock.fetch.mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        headers: { "Content-Type": "application/json", "Content-Length": String(256 * 1024 + 1) },
      }),
    );
    await expect(embedQuery(config, "query")).rejects.toMatchObject({ code: "EMBEDDING_RESPONSE" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects malformed UTF-8 instead of replacing bytes", async () => {
    mock.fetch.mockResolvedValue(
      new Response(new Uint8Array([0xff, 0xfe]), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(embedQuery(config, "query")).rejects.toMatchObject({ code: "EMBEDDING_RESPONSE" });
  });

  it.each([302, 429, 500])("does not echo provider bodies for HTTP %i", async (status) => {
    mock.fetch.mockResolvedValue(new Response("provider-secret-and-private-query", { status }));
    await expect(embedQuery(config, "query")).rejects.toMatchObject({
      status: status === 429 ? 429 : 502,
      code: "EMBEDDING_PROVIDER",
    });
  });

  it("does not expose thrown network details", async () => {
    mock.fetch.mockRejectedValue(new Error("private-provider-key and internal host"));
    await expect(embedQuery(config, "query")).rejects.toMatchObject({
      status: 502,
      message: "语义检索服务连接失败。",
    });
  });

  it.each(["timeout", "caller"])("aborts the actual outgoing signal on %s", async (cause) => {
    vi.useFakeTimers();
    let outgoing: AbortSignal | undefined;
    mock.fetch.mockImplementation(
      (_url, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          outgoing = init.signal as AbortSignal;
          outgoing.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const caller = new AbortController();
    const pending = embedQuery(config, "query", caller.signal);
    const assertion = expect(pending).rejects.toMatchObject({
      status: cause === "timeout" ? 504 : 499,
      code: "EMBEDDING_CANCELLED",
    });
    if (cause === "caller") caller.abort();
    else await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(outgoing?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("embedding budget admission", () => {
  it("uses the SQL owner/request/character contract with independent reservation IDs", async () => {
    await reserveEmbeddingUsage("owner", 42);
    await reserveEmbeddingUsage("owner", 42);
    const args = mock.rpc.mock.calls.map((call) => call[1]);
    expect(mock.rpc.mock.calls[0][0]).toBe("reserve_embedding_usage");
    expect(args[0]).toEqual({
      p_owner_id: "owner",
      p_request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      p_characters: 42,
      p_daily_char_limit: 200000,
    });
    expect(args[0].p_request_id).not.toBe(args[1].p_request_id);
  });

  it.each(["0", "2000001", "1.5", "invalid"])(
    "fails closed for invalid daily limit %s",
    async (limit) => {
      vi.stubEnv("CONUO_EMBEDDING_DAILY_CHAR_LIMIT", limit);
      await expect(reserveEmbeddingUsage("owner", 10)).rejects.toMatchObject({ status: 503 });
      expect(mock.rpc).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ data: { allowed: false }, error: null }, 429, "EMBEDDING_DAILY_LIMIT"],
    [{ data: { allowed: "true" }, error: null }, 503, "EMBEDDING_BUDGET_UNAVAILABLE"],
    [{ data: null, error: { message: "private SQL/key" } }, 503, "EMBEDDING_BUDGET_UNAVAILABLE"],
  ])("rejects failed or malformed budget admission", async (result, status, code) => {
    mock.rpc.mockResolvedValue(result);
    await expect(reserveEmbeddingUsage("owner", 10)).rejects.toMatchObject({ status, code });
    expect(mock.fetch).not.toHaveBeenCalled();
  });
});
