import { afterEach, describe, expect, it, vi } from "vitest";
import { ANSWER_STREAM_LIMITS, readAnswerResponse } from "./answer-stream";
import type { AnswerResult } from "./types";

const answer: AnswerResult = {
  content: "第一段：学习率决定步长。🙂\n\nSecond paragraph.",
  citations: [],
  mode: "model",
};
const encoder = new TextEncoder();
const frame = (value: unknown, newline = "\n") =>
  `data: ${JSON.stringify(value)}${newline}${newline}`;
function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel,
    }),
    { headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
  );
  return {
    response,
    controller,
    cancel,
    send: (value: string) => controller.enqueue(encoder.encode(value)),
  };
}
function buffered(text: string, split = false) {
  const bytes = encoder.encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        if (split) for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
        else c.enqueue(bytes);
        c.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
afterEach(() => vi.useRealTimers());

describe("bounded answer SSE reader", () => {
  it.each(["\n", "\r\n", "\r"])(
    "decodes UTF8 and %j boundaries across every byte",
    async (newline) => {
      const progress = vi.fn();
      const text =
        frame({ type: "progress", phase: "generating" }, newline) +
        frame({ type: "draft", answer }, newline) +
        frame({ type: "complete", answer }, newline);
      expect(await readAnswerResponse(buffered(text, true), { onProgress: progress })).toEqual(
        answer,
      );
      expect(progress.mock.calls.map(([event]) => event.type)).toEqual(["progress", "draft"]);
      expect(progress.mock.calls[1][0].answer.content).toContain("🙂");
    },
  );

  it("publishes a first paragraph while the HTTP stream and promise remain open", async () => {
    const feed = stream();
    const progress = vi.fn();
    const settled = vi.fn();
    const reading = readAnswerResponse(feed.response, { onProgress: progress }).then((result) => {
      settled();
      return result;
    });
    feed.send(frame({ type: "draft", answer }));
    await vi.waitFor(() => expect(progress).toHaveBeenCalledOnce());
    expect(settled).not.toHaveBeenCalled();
    expect(feed.cancel).not.toHaveBeenCalled();
    feed.send(frame({ type: "complete", answer }));
    expect(await reading).toEqual(answer);
    expect(feed.cancel).toHaveBeenCalledOnce();
  });

  it("handles comments, nonauthoritative fields and multiline JSON data", async () => {
    const text = `:heartbeat\n\nevent: whatever\nid: ignored\nretry: 1\ndata: {"type":"complete",\ndata: "answer":${JSON.stringify(answer)}}\n\n`;
    expect(await readAnswerResponse(buffered(text, true))).toEqual(answer);
  });

  it("does not accept a final frame without its blank dispatch boundary", async () => {
    await expect(
      readAnswerResponse(buffered(frame({ type: "complete", answer }).trimEnd())),
    ).rejects.toMatchObject({ code: "ANSWER_STREAM_INCOMPLETE" });
  });

  it.each(["", frame({ type: "progress", phase: "generating" }), frame({ type: "draft", answer })])(
    "EOF never promotes an incomplete response to saved output",
    async (text) => {
      await expect(readAnswerResponse(buffered(text))).rejects.toMatchObject({
        code: "ANSWER_STREAM_INCOMPLETE",
      });
    },
  );

  it.each([
    { type: "complete", answer: { ...answer, content: "" } },
    { type: "complete", answer: { ...answer, unexpected: "secret" } },
    { type: "progress", phase: "unknown" },
    { type: "draft", answer: { ...answer, citations: [{ sourceId: "x" }] } },
    { type: "complete", answer, extra: true },
    { type: "error", error: "raw", code: "bad code", status: 500 },
    { type: "error", error: "raw", code: "BAD", status: 200 },
  ])("rejects malformed frame %j before a complete result", async (event) => {
    await expect(
      readAnswerResponse(buffered(frame(event) + frame({ type: "complete", answer }))),
    ).rejects.toMatchObject({ code: "INVALID_ANSWER_STREAM" });
  });

  it("redacts malformed JSON and malformed UTF8", async () => {
    await expect(
      readAnswerResponse(buffered("data: SECRET-key-invalid-json\n\n")),
    ).rejects.not.toThrow("SECRET");
    const feed = stream();
    feed.controller.enqueue(new Uint8Array([0xc3, 0x28]));
    await expect(readAnswerResponse(feed.response)).rejects.toMatchObject({
      code: "INVALID_ANSWER_STREAM",
    });
  });

  it("surfaces a safe terminal error and discards the preceding draft", async () => {
    await expect(
      readAnswerResponse(
        buffered(
          frame({ type: "draft", answer }) +
            frame({ type: "error", error: "资料已改变", code: "CONTEXT_CHANGED", status: 409 }),
        ),
      ),
    ).rejects.toMatchObject({ message: "资料已改变", code: "CONTEXT_CHANGED", status: 409 });
  });

  it("returns after complete and never processes a trailing draft", async () => {
    const onProgress = vi.fn();
    expect(
      await readAnswerResponse(
        buffered(frame({ type: "complete", answer }) + frame({ type: "draft", answer })),
        { onProgress },
      ),
    ).toEqual(answer);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("reads strict legacy JSON without simulating progress", async () => {
    const onProgress = vi.fn();
    expect(await readAnswerResponse(Response.json(answer), { onProgress })).toEqual(answer);
    expect(onProgress).not.toHaveBeenCalled();
    await expect(
      readAnswerResponse(Response.json({ ...answer, mode: "fake" })),
    ).rejects.toMatchObject({ code: "INVALID_ANSWER_STREAM" });
  });

  it("only exposes structured HTTP errors and never returns HTML or extra debug fields", async () => {
    await expect(
      readAnswerResponse(
        Response.json({ error: "请登录", code: "UNAUTHENTICATED" }, { status: 401 }),
      ),
    ).rejects.toMatchObject({ message: "请登录", status: 401 });
    for (const response of [
      new Response("SECRET access token", { status: 500 }),
      Response.json({ error: "SECRET", code: "INTERNAL", stack: "SECRET" }, { status: 500 }),
    ]) {
      await expect(readAnswerResponse(response)).rejects.toMatchObject({
        code: "CLOUD_ERROR",
        message: "云端问答请求失败，请稍后重试。",
      });
    }
    await expect(readAnswerResponse(new Response("{}"))).rejects.toMatchObject({
      code: "INVALID_ANSWER_STREAM",
    });
  });

  it("cancels an already aborted response without callbacks", async () => {
    const feed = stream();
    const controller = new AbortController();
    controller.abort();
    await expect(
      readAnswerResponse(feed.response, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(feed.cancel).toHaveBeenCalledOnce();
  });

  it("interrupts a stalled read even when the peer's cancel never settles", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { "Content-Type": "text/event-stream" },
    });
    const controller = new AbortController();
    const outcome = readAnswerResponse(response, { signal: controller.signal }).catch(
      (error) => error,
    );
    controller.abort();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("abort from a progress callback prevents same-chunk complete", async () => {
    const controller = new AbortController();
    await expect(
      readAnswerResponse(
        buffered(frame({ type: "draft", answer }) + frame({ type: "complete", answer })),
        { signal: controller.signal, onProgress: () => controller.abort() },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("enforces idle timeout", async () => {
    vi.useFakeTimers();
    const feed = stream();
    const outcome = readAnswerResponse(feed.response, { timeoutMs: 100, idleTimeoutMs: 20 }).catch(
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(await outcome).toMatchObject({ code: "ANSWER_STREAM_TIMEOUT", status: 504 });
    expect(feed.cancel).toHaveBeenCalledOnce();
  });

  it("heartbeats reset idle but never extend the overall deadline", async () => {
    vi.useFakeTimers();
    const feed = stream();
    const outcome = readAnswerResponse(feed.response, { timeoutMs: 50, idleTimeoutMs: 20 }).catch(
      (error) => error,
    );
    for (let time = 0; time < 4; time++) {
      await vi.advanceTimersByTimeAsync(10);
      feed.send(":keepalive\n\n");
    }
    await vi.advanceTimersByTimeAsync(10);
    expect(await outcome).toMatchObject({ code: "ANSWER_STREAM_TIMEOUT" });
  });

  it("bounds advertised body, unterminated lines and multi-line events", async () => {
    const advertised = new Response("", {
      headers: {
        "Content-Type": "text/event-stream",
        "Content-Length": String(ANSWER_STREAM_LIMITS.totalBytes + 1),
      },
    });
    await expect(readAnswerResponse(advertised)).rejects.toMatchObject({
      code: "ANSWER_STREAM_LIMIT",
    });
    await expect(
      readAnswerResponse(buffered(`:${"x".repeat(ANSWER_STREAM_LIMITS.eventBytes)}`)),
    ).rejects.toMatchObject({ code: "ANSWER_STREAM_LIMIT" });
    await expect(readAnswerResponse(buffered(":line\n".repeat(100_000)))).rejects.toMatchObject({
      code: "ANSWER_STREAM_LIMIT",
    });
  });

  it("bounds total bytes even when every heartbeat is small", async () => {
    const feed = stream();
    const block = `:${"x".repeat(1020)}\n\n`;
    const reading = readAnswerResponse(feed.response).catch((error) => error);
    for (let index = 0; index < 17; index++) feed.send(block.repeat(1024));
    expect(await reading).toMatchObject({ code: "ANSWER_STREAM_LIMIT" });
  });

  it("bounds valid event count independently of body size", async () => {
    await expect(
      readAnswerResponse(
        buffered(
          frame({ type: "progress", phase: "generating" }).repeat(ANSWER_STREAM_LIMITS.events + 1),
        ),
      ),
    ).rejects.toMatchObject({ code: "ANSWER_STREAM_LIMIT" });
  });
});
