import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/supabase/api";
import { callModelStream, type ModelConfig } from "./model";

const config: ModelConfig = {
  baseUrl: "https://model.example.test/v1",
  apiKey: "private-test-key",
  model: "configured-model",
  jsonMode: false,
  tokenLimitParameter: "max_completion_tokens",
  timeoutMs: 45_000,
  streamUsage: false,
};
const messages = [{ role: "user" as const, content: "Explain evidence." }];
const encoder = new TextEncoder();
const fetchMock = vi.fn<typeof fetch>();
const delta = (content: unknown, extra: Record<string, unknown> = {}) => ({
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta: { content }, finish_reason: null, ...extra }],
});
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const stop = frame(delta(undefined, { delta: {}, finish_reason: "stop" }));
const done = "data: [DONE]\n\n";
const sse = (body: BodyInit | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
  new Response(body, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", ...headers },
  });
const noop = async () => undefined;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("model SSE adapter", () => {
  it("includes usage options and accepts the final usage-only chunk", async () => {
    fetchMock.mockResolvedValue(
      sse(
        frame(delta("answer")) +
          stop +
          frame({
            object: "chat.completion.chunk",
            choices: [],
            usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
          }) +
          done,
      ),
    );
    const observer = { onUsage: vi.fn(), onFirstDelta: vi.fn() };
    await expect(
      callModelStream({ ...config, streamUsage: true }, messages, undefined, noop, observer),
    ).resolves.toBe("answer");
    expect(observer.onFirstDelta).toHaveBeenCalledOnce();
    expect(observer.onUsage).toHaveBeenCalledExactlyOnceWith({
      promptTokens: 12,
      completionTokens: 7,
      totalTokens: 19,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      stream_options: { include_usage: true },
    });
  });

  it("reports reasoning deltas without adding them to the answer", async () => {
    fetchMock.mockResolvedValue(
      sse(
        frame(delta(undefined, { delta: { reasoning_content: "先推导" } })) +
          frame(delta("结论")) +
          stop +
          done,
      ),
    );
    const observer = { onReasoningDelta: vi.fn() };
    await expect(callModelStream(config, messages, undefined, noop, observer)).resolves.toBe(
      "结论",
    );
    expect(observer.onReasoningDelta).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("rejects a usage-only chunk when stream usage is disabled", async () => {
    fetchMock.mockResolvedValue(
      sse(
        frame(delta("answer")) +
          stop +
          frame({ object: "chat.completion.chunk", choices: [], usage: { total_tokens: 1 } }) +
          done,
      ),
    );
    await expect(callModelStream(config, messages, undefined, noop)).rejects.toMatchObject({
      code: "MODEL_RESPONSE",
    });
  });

  it.each([undefined, "enabled", "disabled"] as const)(
    "sends optional thinking mode %s and completes exactly one bounded stream",
    async (thinkingMode) => {
      fetchMock.mockResolvedValue(sse(frame(delta("answer")) + stop + done));
      const seen: string[] = [];
      expect(
        await callModelStream(
          {
            ...config,
            tokenLimitParameter: "max_tokens",
            ...(thinkingMode === undefined ? {} : { thinkingMode }),
          },
          messages,
          undefined,
          async (text) => {
            seen.push(text);
          },
        ),
      ).toBe("answer");
      const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      if (thinkingMode === undefined) expect(Object.hasOwn(body, "thinking")).toBe(false);
      else expect(body.thinking).toEqual({ type: thinkingMode });
      expect(body.max_tokens).toBe(4096);
      expect(body.stream).toBe(true);
      expect(seen).toEqual(["answer"]);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it.each(["auto", "", null])(
    "rejects invalid runtime streaming thinking mode %j before network",
    async (thinkingMode) => {
      await expect(
        callModelStream(
          { ...config, thinkingMode } as unknown as ModelConfig,
          messages,
          undefined,
          noop,
        ),
      ).rejects.toMatchObject({ code: "MODEL_CONFIGURATION" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it("delivers a first delta before stop/DONE and preserves the bounded authenticated request", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(
      sse(
        new ReadableStream({
          start(value) {
            controller = value;
          },
          cancel,
        }),
      ),
    );
    const first = deferred<void>();
    const seen: string[] = [];
    let settled = false;
    const result = callModelStream(config, messages, undefined, async (value) => {
      seen.push(value);
      first.resolve();
    });
    void result.then(() => {
      settled = true;
    });
    controller.enqueue(encoder.encode(frame(delta("第一段"))));
    await first.promise;
    expect(seen).toEqual(["第一段"]);
    expect(settled).toBe(false);
    controller.enqueue(encoder.encode(frame(delta("第二段")) + stop + done));
    expect(await result).toBe("第一段第二段");
    expect(cancel).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(config.baseUrl + "/chat/completions");
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      headers: { Accept: "text/event-stream", Authorization: `Bearer ${config.apiKey}` },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: config.model,
      messages,
      stream: true,
      store: false,
      n: 1,
      max_completion_tokens: 4096,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["\n", "\r\n", "\r"])(
    "handles %j line endings and UTF-8 split across every byte",
    async (newline) => {
      const bytes = encoder.encode(
        (": heartbeat\n\n" + frame(delta("中文😀")) + stop + done).replaceAll("\n", newline),
      );
      fetchMock.mockResolvedValue(
        sse(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
              controller.close();
            },
          }),
        ),
      );
      const seen: string[] = [];
      expect(
        await callModelStream(config, messages, undefined, async (value) => {
          seen.push(value);
        }),
      ).toBe("中文😀");
      expect(seen).toEqual(["中文😀"]);
    },
  );

  it("accepts multiline SSE data, assistant metadata and configured JSON mode", async () => {
    const json = JSON.stringify(
      delta("answer", { delta: { role: "assistant", content: "answer", refusal: null } }),
    );
    const multiline =
      "event: message\nid: 1\nretry: 1000\ndata: " +
      json.replace(',"choices"', ',\ndata: "choices"') +
      "\n\n";
    fetchMock.mockResolvedValue(sse(multiline + stop + done));
    await expect(
      callModelStream({ ...config, jsonMode: true }, messages, undefined, noop),
    ).resolves.toBe("answer");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).response_format).toEqual({
      type: "json_object",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("accepts DeepSeek's null role in its terminal stream chunk", async () => {
    fetchMock.mockResolvedValue(
      sse(
        frame(delta("answer", { delta: { role: "assistant", content: "answer" } })) +
          frame(delta(undefined, { delta: { role: null }, finish_reason: "stop" })) +
          done,
      ),
    );

    await expect(callModelStream(config, messages, undefined, noop)).resolves.toBe("answer");
  });

  it("awaits the consumer before processing the next delta", async () => {
    const gate = deferred<void>();
    const first = deferred<void>();
    fetchMock.mockResolvedValue(sse(frame(delta("one")) + frame(delta("two")) + stop + done));
    const seen: string[] = [];
    const result = callModelStream(config, messages, undefined, async (value) => {
      seen.push(value);
      if (value === "one") {
        first.resolve();
        await gate.promise;
      }
    });
    await first.promise;
    expect(seen).toEqual(["one"]);
    gate.resolve();
    expect(await result).toBe("onetwo");
    expect(seen).toEqual(["one", "two"]);
  });

  it("cancels upstream and preserves a safe permission error from the consumer", async () => {
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(
      sse(
        new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode(frame(delta("one")) + frame(delta("two"))));
          },
          cancel,
        }),
      ),
    );
    const error = new ApiError(409, "QUESTION_CONTEXT_CHANGED", "资料范围已变化。");
    const callback = vi.fn(async () => {
      throw error;
    });
    await expect(callModelStream(config, messages, undefined, callback)).rejects.toBe(error);
    expect(callback).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("sanitizes non-ApiError consumer failures", async () => {
    fetchMock.mockResolvedValue(sse(frame(delta("one")) + stop + done));
    const error = await callModelStream(config, messages, undefined, async () => {
      throw new Error(config.apiKey);
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "MODEL_RESPONSE" });
    expect(String(error)).not.toContain(config.apiKey);
  });

  it("rejects already cancelled, unsafe and oversized requests before networking", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(callModelStream(config, messages, controller.signal, noop)).rejects.toMatchObject({
      code: "MODEL_CANCELLED",
    });
    await expect(
      callModelStream({ ...config, baseUrl: "http://remote.test/v1" }, messages, undefined, noop),
    ).rejects.toMatchObject({ code: "MODEL_CONFIGURATION" });
    await expect(
      callModelStream(config, [{ role: "user", content: "中".repeat(100_000) }], undefined, noop),
    ).rejects.toMatchObject({ code: "MODEL_INPUT_TOO_LARGE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops while awaiting a broken transport and discards its late response", async () => {
    const late = deferred<Response>();
    fetchMock.mockReturnValue(late.promise);
    const controller = new AbortController();
    const callback = vi.fn(noop);
    const result = callModelStream(config, messages, controller.signal, callback);
    const assertion = expect(result).rejects.toMatchObject({ code: "MODEL_CANCELLED" });
    controller.abort("private reason");
    await assertion;
    const cancel = vi.fn();
    late.resolve(
      sse(
        new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode(frame(delta("late"))));
          },
          cancel,
        }),
      ),
    );
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(callback).not.toHaveBeenCalled();
  });

  it("cancels a stalled body after an initial delta without adopting later content", async () => {
    const first = deferred<void>();
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(
      sse(
        new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode(frame(delta("one"))));
          },
          cancel,
        }),
      ),
    );
    const controller = new AbortController();
    const callback = vi.fn(async () => {
      first.resolve();
    });
    const result = callModelStream(config, messages, controller.signal, callback);
    const assertion = expect(result).rejects.toMatchObject({ code: "MODEL_CANCELLED" });
    await first.promise;
    controller.abort();
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledOnce();
  });

  it.each(["fetch", "body", "consumer"])(
    "times out the total deadline during %s with no retry",
    async (stage) => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      const gate = deferred<void>();
      if (stage === "fetch") fetchMock.mockImplementation(() => new Promise(() => undefined));
      else
        fetchMock.mockResolvedValue(
          sse(
            new ReadableStream({
              start(c) {
                if (stage === "consumer") c.enqueue(encoder.encode(frame(delta("one"))));
              },
              cancel,
            }),
          ),
        );
      const result = callModelStream(config, messages, undefined, () =>
        stage === "consumer" ? gate.promise : Promise.resolve(),
      );
      const assertion = expect(result).rejects.toMatchObject({
        code: "MODEL_TIMEOUT",
        status: 504,
      });
      await vi.advanceTimersByTimeAsync(45_000);
      await assertion;
      gate.resolve();
      await Promise.resolve();
      if (stage !== "fetch") expect(cancel).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    [301, "MODEL_REDIRECT"],
    [307, "MODEL_REDIRECT"],
    [401, "MODEL_AUTH"],
    [429, "MODEL_RATE_LIMIT"],
    [500, "MODEL_UNAVAILABLE"],
  ])("rejects HTTP %s without provider body, followup or fallback call", async (status, code) => {
    fetchMock.mockResolvedValue(
      new Response(config.apiKey, {
        status: status as number,
        headers: { Location: "https://other.test" },
      }),
    );
    const error = await callModelStream(config, messages, undefined, noop).catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain(config.apiKey);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    {},
    { object: "chat.completion", choices: [] },
    { object: "chat.completion.chunk", choices: [] },
    { object: "chat.completion.chunk", choices: [delta("a"), delta("b")] },
    delta("a", { index: 1 }),
    delta("a", { finish_reason: "tool_calls" }),
    delta("a", { finish_reason: undefined }),
    delta(1),
    delta(["a"]),
    delta("a", { delta: { role: "user", content: "a" } }),
    delta("a", { delta: { tool_calls: [{ id: "x" }], content: "a" } }),
    delta("a", { delta: { function_call: { name: "x" }, content: "a" } }),
    delta("a".repeat(32_001)),
  ])("rejects malformed, wrong-index or non-text chunks %#", async (value) => {
    fetchMock.mockResolvedValue(sse(frame(value) + stop + done));
    await expect(callModelStream(config, messages, undefined, noop)).rejects.toMatchObject({
      code: "MODEL_RESPONSE",
    });
  });

  it.each([
    [delta("a", { finish_reason: "length" }), "MODEL_INCOMPLETE"],
    [delta("a", { finish_reason: "content_filter" }), "MODEL_REFUSED"],
    [delta("a", { delta: { refusal: "private provider refusal" } }), "MODEL_REFUSED"],
  ])("rejects truncation/refusal even after a provisional first delta %#", async (value, code) => {
    const callback = vi.fn(noop);
    fetchMock.mockResolvedValue(sse(frame(delta("first")) + frame(value) + done));
    const error = await callModelStream(config, messages, undefined, callback).catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain("private provider refusal");
    expect(callback).toHaveBeenCalledExactlyOnceWith("first");
  });

  it.each([
    [frame(delta("a")), "MODEL_INCOMPLETE"],
    [frame(delta("a")) + stop, "MODEL_INCOMPLETE"],
    [frame(delta("a")) + done, "MODEL_RESPONSE"],
    [stop + done, "MODEL_RESPONSE"],
    [frame(delta("   ")) + stop + done, "MODEL_RESPONSE"],
    [frame(delta("a")) + stop + frame(delta("late")) + done, "MODEL_RESPONSE"],
    ['event: error\ndata: {"message":"private"}\n\n', "MODEL_RESPONSE"],
    ["data: not JSON\n\n", "MODEL_RESPONSE"],
    [frame(delta("a")) + stop + "data: [DONE]", "MODEL_INCOMPLETE"],
  ])("requires a well-framed stop and DONE terminal sequence %#", async (body, code) => {
    fetchMock.mockResolvedValue(sse(body));
    await expect(callModelStream(config, messages, undefined, noop)).rejects.toMatchObject({
      code,
    });
  });

  it.each([
    () => sse("{}", { "Content-Type": "application/json" }),
    () => sse(new Uint8Array([0xff])),
    () => sse(": " + "x".repeat(64 * 1024) + "\n\n"),
    () => sse((": " + "x".repeat(10_000) + "\n\n").repeat(211)),
    () => sse(frame(delta("")).repeat(8193) + stop + done),
    () => sse(frame(delta("a")) + stop + done, { "Content-Length": "2097153" }),
  ])("bounds SSE envelopes, count, actual bytes and UTF-8 %#", async (make) => {
    fetchMock.mockResolvedValue(make());
    await expect(callModelStream(config, messages, undefined, noop)).rejects.toMatchObject({
      code: "MODEL_RESPONSE",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
