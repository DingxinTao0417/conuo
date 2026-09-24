import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/supabase/api";
import { callModel, readModelConfig, type ModelConfig } from "./model";

const config: ModelConfig = {
  baseUrl: "https://model.example.test/v1",
  apiKey: "private-test-key",
  model: "configured-model",
  jsonMode: false,
  tokenLimitParameter: "max_completion_tokens",
  timeoutMs: 45_000,
  streamUsage: false,
};
const messages: Array<{ role: "system" | "user"; content: string }> = [
  { role: "system", content: "Return a JSON object using only the supplied evidence." },
  { role: "user", content: "Explain evidence item 1." },
];
const env = {
  CONUO_MODEL_BASE_URL: config.baseUrl,
  CONUO_MODEL_API_KEY: config.apiKey,
  CONUO_MODEL_NAME: config.model,
};
const fetchMock = vi.fn<typeof fetch>();

function completion(override: Record<string, unknown> = {}) {
  return {
    id: "chat-test",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: '{"answer":"quoted evidence"}', refusal: null },
      },
    ],
    ...override,
  };
}

function response(value: unknown = completion()) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function choice(value: Record<string, unknown> = {}, message: Record<string, unknown> = {}) {
  return completion({
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "answer", ...message },
        ...value,
      },
    ],
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("model configuration", () => {
  it.each(["enabled", "disabled"] as const)("loads explicit thinking mode %s", (thinkingMode) => {
    expect(readModelConfig({ ...env, CONUO_MODEL_THINKING_MODE: thinkingMode })).toEqual({
      ...config,
      thinkingMode,
    });
  });

  it("omits thinking configuration unless explicitly supplied", () => {
    expect(Object.hasOwn(readModelConfig(env)!, "thinkingMode")).toBe(false);
    for (const value of ["", " "])
      expect(
        Object.hasOwn(
          readModelConfig({ ...env, CONUO_MODEL_THINKING_MODE: value })!,
          "thinkingMode",
        ),
      ).toBe(false);
    expect(readModelConfig({ ...env, CONUO_MODEL_THINKING_MODE: " disabled " })?.thinkingMode).toBe(
      "disabled",
    );
  });

  it.each(["auto", "off", "DISABLED", "disabled\nenabled"])(
    "rejects invalid explicit thinking configuration %j even without an otherwise configured model",
    (thinkingMode) => {
      for (const values of [env, {}])
        expect(() =>
          readModelConfig({ ...values, CONUO_MODEL_THINKING_MODE: thinkingMode }),
        ).toThrowError(expect.objectContaining({ code: "MODEL_CONFIGURATION" }));
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it("leaves generation unconfigured when all three model values are blank", () => {
    expect(readModelConfig({})).toBeNull();
    expect(
      readModelConfig({ CONUO_MODEL_BASE_URL: "  ", CONUO_MODEL_JSON_MODE: "false" }),
    ).toBeNull();
  });

  it("loads only explicit settings without assuming a provider or model", () => {
    expect(
      readModelConfig({ ...env, CONUO_MODEL_BASE_URL: " https://model.example.test/v1/ " }),
    ).toEqual(config);
    expect(readModelConfig({ ...env, CONUO_MODEL_JSON_MODE: "true" })?.jsonMode).toBe(true);
  });

  it("accepts the configured DeepSeek OpenAI-compatible profile", () => {
    expect(
      readModelConfig({
        CONUO_MODEL_BASE_URL: "https://api.deepseek.com",
        CONUO_MODEL_API_KEY: "test-deepseek-key",
        CONUO_MODEL_NAME: "deepseek-flash",
        CONUO_MODEL_JSON_MODE: "true",
        CONUO_MODEL_TOKEN_LIMIT_PARAMETER: "max_tokens",
      }),
    ).toMatchObject({
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      jsonMode: true,
      tokenLimitParameter: "max_tokens",
      timeoutMs: 45_000,
    });
  });

  it.each([
    { CONUO_MODEL_BASE_URL: config.baseUrl },
    { ...env, CONUO_MODEL_NAME: "" },
    { ...env, CONUO_MODEL_API_KEY: "key\nother" },
    { ...env, CONUO_MODEL_API_KEY: "key\u0000other" },
    { ...env, CONUO_MODEL_NAME: "model\nother" },
    { ...env, CONUO_MODEL_JSON_MODE: "1" },
    { ...env, CONUO_MODEL_JSON_MODE: "TRUE" },
    { ...env, CONUO_MODEL_TOKEN_LIMIT_PARAMETER: "completion_limit" },
  ])("rejects incomplete or invalid configuration without exposing secrets", (values) => {
    try {
      readModelConfig(values);
      expect.fail("configuration should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 503, code: "MODEL_CONFIGURATION" });
      expect(String(error)).not.toContain(config.apiKey);
      expect(String(error)).not.toContain(config.baseUrl);
    }
  });

  it.each([
    "http://model.example.test/v1",
    "http://192.168.1.2/v1",
    "http://127.1/v1",
    "http://2130706433/v1",
    "http://localhost.example.test/v1",
    "http://localhost./v1",
    "file:///etc/hosts",
    "https://user:secret@example.test/v1",
    "https://@example.test/v1",
    "https://example.test/v1?key=secret",
    "https://example.test/v1?",
    "https://example.test/v1#",
    "https://example.test\\other/v1",
    "https://exa\nmple.test/v1",
    "not-a-url",
  ])("rejects ambiguous or unsafe model URL %s", (url) => {
    expect(() => readModelConfig({ ...env, CONUO_MODEL_BASE_URL: url })).toThrowError(ApiError);
  });

  it.each(["http://localhost:8080/v1", "http://127.0.0.1:11434/v1", "http://[::1]:8080/v1"])(
    "allows explicitly local development endpoint %s",
    (url) => {
      expect(readModelConfig({ ...env, CONUO_MODEL_BASE_URL: url })?.baseUrl).toBe(url);
    },
  );
});

describe("thinking transport for completions", () => {
  it.each([undefined, "enabled", "disabled"] as const)(
    "sends exactly the optional thinking declaration %s without changing the token budget",
    async (thinkingMode) => {
      fetchMock.mockResolvedValue(response());
      expect(
        await callModel(
          {
            ...config,
            tokenLimitParameter: "max_tokens",
            ...(thinkingMode === undefined ? {} : { thinkingMode }),
          },
          messages,
        ),
      ).toContain("quoted evidence");
      const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      if (thinkingMode === undefined) expect(Object.hasOwn(body, "thinking")).toBe(false);
      else expect(body.thinking).toEqual({ type: thinkingMode });
      expect(body.max_tokens).toBe(4096);
      expect(body).not.toHaveProperty("max_completion_tokens");
      expect(body.stream).toBe(false);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it.each(["auto", "", null])(
    "rejects invalid runtime thinking mode %j before a provider request",
    async (thinkingMode) => {
      await expect(
        callModel({ ...config, thinkingMode } as unknown as ModelConfig, messages),
      ).rejects.toMatchObject({ code: "MODEL_CONFIGURATION" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("model HTTP adapter", () => {
  it("reports provider token usage to the observer", async () => {
    fetchMock.mockResolvedValue(
      response(
        completion({
          usage: {
            prompt_tokens: 12,
            completion_tokens: 7,
            total_tokens: 19,
            completion_tokens_details: { reasoning_tokens: 3 },
            prompt_tokens_details: { cached_tokens: 5 },
          },
        }),
      ),
    );
    const onUsage = vi.fn();
    await callModel(config, messages, undefined, { onUsage });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({
      promptTokens: 12,
      completionTokens: 7,
      totalTokens: 19,
      reasoningTokens: 3,
      cacheHitTokens: 5,
    });
  });

  it("makes one bounded nonstreaming request and returns assistant content", async () => {
    fetchMock.mockResolvedValue(response());
    expect(await callModel(config, messages)).toBe('{"answer":"quoted evidence"}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://model.example.test/v1/chat/completions");
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      headers: { Authorization: "Bearer private-test-key" },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: config.model,
      messages,
      stream: false,
      store: false,
      n: 1,
      max_completion_tokens: 4096,
    });
  });

  it("enables JSON mode only when explicitly requested", async () => {
    fetchMock.mockResolvedValue(response());
    await callModel({ ...config, jsonMode: true }, messages);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).response_format).toEqual({
      type: "json_object",
    });
  });

  it("uses DeepSeek's documented max_tokens parameter without a fallback request", async () => {
    const deepSeek = readModelConfig({
      CONUO_MODEL_BASE_URL: "https://api.deepseek.com",
      CONUO_MODEL_API_KEY: "test-deepseek-key",
      CONUO_MODEL_NAME: "deepseek-flash",
      CONUO_MODEL_JSON_MODE: "true",
      CONUO_MODEL_TOKEN_LIMIT_PARAMETER: "max_tokens",
    });
    if (!deepSeek) throw new Error("Expected DeepSeek configuration");
    fetchMock.mockResolvedValue(response());

    await callModel(deepSeek, messages);

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      model: "deepseek-flash",
      max_tokens: 4096,
      response_format: { type: "json_object" },
    });
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("validates directly supplied config before any network call", async () => {
    await expect(
      callModel({ ...config, baseUrl: "http://remote.test" }, messages),
    ).rejects.toMatchObject({ code: "MODEL_CONFIGURATION" });
    await expect(callModel({ ...config, timeoutMs: Infinity }, messages)).rejects.toMatchObject({
      code: "MODEL_CONFIGURATION",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects oversized input before sending", async () => {
    await expect(
      callModel(config, [{ role: "user", content: "资料".repeat(100_000) }]),
    ).rejects.toMatchObject({ status: 413, code: "MODEL_INPUT_TOO_LARGE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [301, 502, "MODEL_REDIRECT"],
    [302, 502, "MODEL_REDIRECT"],
    [307, 502, "MODEL_REDIRECT"],
    [308, 502, "MODEL_REDIRECT"],
    [400, 502, "MODEL_REQUEST_REJECTED"],
    [401, 503, "MODEL_AUTH"],
    [403, 503, "MODEL_AUTH"],
    [429, 429, "MODEL_RATE_LIMIT"],
    [500, 503, "MODEL_UNAVAILABLE"],
    [503, 503, "MODEL_UNAVAILABLE"],
  ])(
    "handles HTTP %s without leaking upstream body or retrying",
    async (upstream, status, code) => {
      const cancelled = vi.fn();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(config.apiKey));
        },
        cancel: cancelled,
      });
      fetchMock.mockResolvedValue(
        new Response(body, {
          status: upstream,
          headers: { Location: "https://other.example.test/stolen" },
        }),
      );
      const error = await callModel(config, messages).catch((error: unknown) => error);
      expect(error).toMatchObject({ status, code });
      expect(String(error)).not.toContain(config.apiKey);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(cancelled).toHaveBeenCalled();
    },
  );

  it("rejects an unexpectedly followed redirect even with a successful body", async () => {
    const redirected = response();
    Object.defineProperty(redirected, "redirected", { value: true });
    fetchMock.mockResolvedValue(redirected);
    await expect(callModel(config, messages)).rejects.toMatchObject({ code: "MODEL_REDIRECT" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sanitizes transport errors and does not retry", async () => {
    fetchMock.mockRejectedValue(
      new Error(`Request failed: ${config.baseUrl}?key=${config.apiKey}`),
    );
    const error = await callModel(config, messages).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "MODEL_UNAVAILABLE" });
    expect(String(error)).not.toContain(config.apiKey);
    expect(String(error)).not.toContain(config.baseUrl);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not issue a request if already cancelled", async () => {
    const controller = new AbortController();
    controller.abort("private abort reason");
    await expect(callModel(config, messages, controller.signal)).rejects.toMatchObject({
      status: 499,
      code: "MODEL_CANCELLED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels immediately even if the transport never settles", async () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const promise = callModel(config, messages, controller.signal);
    const assertion = expect(promise).rejects.toMatchObject({ code: "MODEL_CANCELLED" });
    controller.abort("private abort reason");
    await assertion;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("times out the whole request without retrying or waiting for transport acknowledgement", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    const promise = callModel(config, messages);
    const assertion = expect(promise).rejects.toMatchObject({ status: 504, code: "MODEL_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(45_000);
    await assertion;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also times out a response whose body stalls and cancels the reader", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const promise = callModel(config, messages);
    const assertion = expect(promise).rejects.toMatchObject({ code: "MODEL_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(45_000);
    await assertion;
    expect(cancel).toHaveBeenCalled();
  });

  it("cancels a late upstream response after the user has stopped", async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const controller = new AbortController();
    const promise = callModel(config, messages, controller.signal);
    const assertion = expect(promise).rejects.toMatchObject({ code: "MODEL_CANCELLED" });
    controller.abort();
    await assertion;
    const cancel = vi.fn();
    resolve(new Response(new ReadableStream({ cancel })));
    await Promise.resolve();
    expect(cancel).toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    completion({ object: "chat.completion.chunk" }),
    completion({ choices: [] }),
    completion({ choices: [choice(), choice()] }),
    choice({ index: 1 }),
    choice({ finish_reason: null }),
    choice({}, { role: "user" }),
    choice({}, { content: null }),
    choice({}, { content: ["text"] }),
    choice({}, { content: "  " }),
    choice({}, { content: "x".repeat(32_001) }),
    choice({ finish_reason: "tool_calls" }, { content: null }),
    choice({}, { tool_calls: [{ id: "tool" }] }),
    choice({}, { tool_calls: "tool" }),
    choice({}, { function_call: { name: "tool" } }),
  ])("rejects malformed, empty, or tool-only completion %#", async (value) => {
    fetchMock.mockResolvedValue(response(value));
    await expect(callModel(config, messages)).rejects.toMatchObject({
      status: 502,
      code: "MODEL_RESPONSE",
    });
  });

  it("rejects truncated answers instead of publishing incomplete JSON", async () => {
    fetchMock.mockResolvedValue(response(choice({ finish_reason: "length" })));
    await expect(callModel(config, messages)).rejects.toMatchObject({ code: "MODEL_INCOMPLETE" });
  });

  it.each([
    choice({ finish_reason: "content_filter" }),
    choice({}, { refusal: "private refusal content" }),
  ])("rejects refusals without returning provider content %#", async (value) => {
    fetchMock.mockResolvedValue(response(value));
    const error = await callModel(config, messages).catch((error: unknown) => error);
    expect(error).toMatchObject({ status: 422, code: "MODEL_REFUSED" });
    expect(String(error)).not.toContain("private refusal");
  });

  it.each([
    () => new Response("<html>upstream error</html>", { headers: { "Content-Type": "text/html" } }),
    () => new Response("{}", { headers: { "Content-Type": "application/jsonx" } }),
    () => new Response("not JSON", { headers: { "Content-Type": "application/json" } }),
    () =>
      new Response(new Uint8Array([0xff, 0xfe]), {
        headers: { "Content-Type": "application/json" },
      }),
    () =>
      new Response("{}", {
        headers: { "Content-Type": "application/json", "Content-Length": "262145" },
      }),
    () =>
      new Response(" ".repeat(262_145), {
        headers: { "Content-Type": "application/json", "Content-Length": "2" },
      }),
  ])("rejects wrong MIME, invalid JSON/UTF-8, or oversized response %#", async (makeResponse) => {
    fetchMock.mockResolvedValue(makeResponse());
    await expect(callModel(config, messages)).rejects.toMatchObject({ code: "MODEL_RESPONSE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
