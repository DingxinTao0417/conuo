import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askCloud } from "./cloud";
import { ANSWER_STREAM_LIMITS } from "./answer-stream";
import type { AnswerRequest, AnswerResult } from "./types";

const config = vi.hoisted(() => ({ enabled: true }));
vi.mock("./supabase/config", () => ({
  getSupabaseConfig: () => (config.enabled ? { url: "https://example.test", key: "public" } : null),
}));
vi.mock("./supabase/client", () => ({ createClient: vi.fn() }));
const fetchMock = vi.fn<typeof fetch>();
const request: AnswerRequest = {
  scope: "document",
  spaceId: "space",
  sourceId: "source",
  sourceIds: [],
  question: "What is the key idea?",
};
const answer: AnswerResult = { content: "经当前资料校验的回答。", citations: [], mode: "model" };
const encode = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
function controlledResponse() {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
      cancel,
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
  return {
    response,
    cancel,
    send: (event: unknown) => stream.enqueue(encode(event)),
    close: () => stream.close(),
  };
}
beforeEach(() => {
  config.enabled = true;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("askCloud stream transport", () => {
  it("requests authenticated same-origin SSE and resolves only after complete", async () => {
    const fixture = controlledResponse();
    fetchMock.mockResolvedValue(fixture.response);
    const onProgress = vi.fn();
    const settled = vi.fn();
    const pending = askCloud(request, undefined, "account-A", onProgress).then((result) => {
      settled();
      return result;
    });
    fixture.send({ type: "draft", answer });
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledOnce());
    expect(settled).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/ask",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(request),
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "X-Conuo-User": "account-A",
        },
      }),
    );
    fixture.send({ type: "complete", answer });
    expect(await pending).toEqual(answer);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fixture.cancel).toHaveBeenCalledOnce();
  });

  it("preserves legacy HTTP JSON compatibility without progress", async () => {
    fetchMock.mockResolvedValue(Response.json(answer));
    const onProgress = vi.fn();
    expect(await askCloud(request, undefined, "A", onProgress)).toEqual(answer);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("does not send HTTP requests without configuration, user or with pre-abort", async () => {
    config.enabled = false;
    await expect(askCloud(request, undefined, "A")).rejects.toMatchObject({
      code: "CLOUD_NOT_CONFIGURED",
    });
    config.enabled = true;
    await expect(askCloud(request, undefined, "")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(askCloud(request, controller.signal, "A")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exposes safe streamed API errors after a draft without retrying", async () => {
    const fixture = controlledResponse();
    fetchMock.mockResolvedValue(fixture.response);
    const outcome = askCloud(request, undefined, "A").catch((error) => error);
    fixture.send({ type: "draft", answer });
    fixture.send({ type: "error", error: "资料版本已改变", code: "CONTEXT_CHANGED", status: 409 });
    expect(await outcome).toMatchObject({
      name: "CloudError",
      message: "资料版本已改变",
      status: 409,
      code: "CONTEXT_CHANGED",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("connection loss cannot resolve a draft or automatically repeat the request", async () => {
    const fixture = controlledResponse();
    fetchMock.mockResolvedValue(fixture.response);
    const outcome = askCloud(request, undefined, "A").catch((error) => error);
    fixture.send({ type: "draft", answer });
    fixture.close();
    expect(await outcome).toMatchObject({ code: "ANSWER_STREAM_INCOMPLETE" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("network and malformed HTTP failures never echo underlying secrets", async () => {
    fetchMock.mockRejectedValueOnce(new Error("SECRET provider token"));
    await expect(askCloud(request, undefined, "A")).rejects.toMatchObject({
      code: "ANSWER_CONNECTION_FAILED",
      message: "云端问答连接失败，未保存未完成的回答。",
    });
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "SECRET", code: "INTERNAL", stack: "SECRET" }, { status: 500 }),
    );
    await expect(askCloud(request, undefined, "A")).rejects.toMatchObject({
      code: "CLOUD_ERROR",
      message: "云端问答请求失败，请稍后重试。",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("external cancellation interrupts an ignored fetch signal and cancels a late body", async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockReturnValue(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    const controller = new AbortController();
    const outcome = askCloud(request, controller.signal, "A").catch((error) => error);
    controller.abort();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    const fixture = controlledResponse();
    resolve(fixture.response);
    await vi.waitFor(() => expect(fixture.cancel).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("cancels an active response and suppresses subsequent progress", async () => {
    const fixture = controlledResponse();
    fetchMock.mockResolvedValue(fixture.response);
    const controller = new AbortController();
    const onProgress = vi.fn();
    const outcome = askCloud(request, controller.signal, "A", onProgress).catch((error) => error);
    fixture.send({ type: "draft", answer });
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledOnce());
    controller.abort();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(fixture.cancel).toHaveBeenCalledOnce();
  });

  it("total timeout includes waiting for HTTP headers, even if fetch ignores abort", async () => {
    vi.useFakeTimers();
    fetchMock.mockReturnValue(new Promise(() => {}));
    const outcome = askCloud(request, undefined, "A").catch((error) => error);
    await vi.advanceTimersByTimeAsync(ANSWER_STREAM_LIMITS.timeoutMs);
    expect(await outcome).toMatchObject({ status: 504, code: "ANSWER_STREAM_TIMEOUT" });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("stream idle timeout still returns a safe CloudError", async () => {
    vi.useFakeTimers();
    const fixture = controlledResponse();
    fetchMock.mockResolvedValue(fixture.response);
    const outcome = askCloud(request, undefined, "A").catch((error) => error);
    await vi.advanceTimersByTimeAsync(ANSWER_STREAM_LIMITS.idleTimeoutMs);
    expect(await outcome).toMatchObject({
      name: "CloudError",
      code: "ANSWER_STREAM_TIMEOUT",
      status: 504,
    });
    expect(fixture.cancel).toHaveBeenCalledOnce();
  });
});
