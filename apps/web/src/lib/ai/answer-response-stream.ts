import "server-only";
import { ApiError } from "../supabase/api";
import type { AnswerStreamEvent } from "../answer-stream-types";

export const ANSWER_STREAM_LIMITS = Object.freeze({
  eventBytes: 512 * 1024,
  totalBytes: 16 * 1024 * 1024,
  durationMs: 55_000,
  cleanupMs: 2_000,
});
export type AnswerStreamSink = (
  event: AnswerStreamEvent,
  beforePublish?: () => Promise<unknown>,
) => Promise<void>;

/** One awaited event at a time. Drafts do not bypass disclosure checks while waiting for a reader. */
export function answerStreamResponse(
  requestSignal: AbortSignal,
  produce: (signal: AbortSignal, send: AnswerStreamSink) => Promise<void>,
  onFailure: (error: unknown) => Promise<void>,
  deadlineAt = Date.now() + ANSWER_STREAM_LIMITS.durationMs,
): Response {
  const upstream = new AbortController();
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false,
    completed = false,
    failed = false,
    ready = false,
    sending = false;
  let bytesSent = 0;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failureCleanup: Promise<void> | undefined;
  const cancelled = () => new ApiError(499, "REQUEST_CANCELLED", "回答已停止，问题已保留。");
  const timeout = () =>
    new ApiError(504, "ANSWER_STREAM_TIMEOUT", "回答耗时过长，已停止本次生成。");
  const check = () => {
    if (upstream.signal.aborted) throw upstream.signal.reason;
    if (closed || completed) throw cancelled();
    if (Date.now() >= deadlineAt) throw timeout();
  };
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    requestSignal.removeEventListener("abort", abort);
    wake?.();
    wake = undefined;
  };
  const fail = (error: unknown): Promise<void> => {
    if (failed || completed) return failureCleanup ?? Promise.resolve();
    failed = true;
    upstream.abort(error);
    cleanup();
    // Cancellation returns this bounded task to the stream consumer. Keep the
    // stream alive for ledger cleanup without waiting forever on a failed database.
    failureCleanup = new Promise<void>((resolve) => {
      const deadline = setTimeout(resolve, ANSWER_STREAM_LIMITS.cleanupMs);
      void Promise.resolve()
        .then(() => onFailure(error))
        .catch(() => undefined)
        .then(() => {
          clearTimeout(deadline);
          resolve();
        });
    });
    if (!closed) {
      const known =
        error instanceof ApiError &&
        Number.isInteger(error.status) &&
        error.status >= 400 &&
        error.status <= 599 &&
        /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code);
      const event: AnswerStreamEvent = known
        ? {
            type: "error",
            status: error.status,
            code: error.code,
            error: error.message.slice(0, 1000) || "回答未完成。",
          }
        : {
            type: "error",
            status: 500,
            code: "CLOUD_ERROR",
            error: "云端请求失败，请稍后重试；本地资料仍然保留。",
          };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    }
    void failureCleanup.then(() => {
      if (!closed) {
        controller.close();
        closed = true;
      }
    });
    return failureCleanup;
  };
  const abort = () => fail(cancelled());
  const send: AnswerStreamSink = async (event, beforePublish) => {
    check();
    if (sending) throw new ApiError(500, "ANSWER_STREAM_ORDER", "回答流顺序异常，请重新提问。");
    sending = true;
    try {
      const encoded = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
      if (
        encoded.byteLength > ANSWER_STREAM_LIMITS.eventBytes ||
        bytesSent + encoded.byteLength > ANSWER_STREAM_LIMITS.totalBytes - 8192
      )
        throw new ApiError(502, "ANSWER_STREAM_LIMIT", "回答流超过容量限制，请缩小问题范围。");
      while (!ready) {
        check();
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      check();
      await beforePublish?.();
      check();
      ready = false;
      bytesSent += encoded.byteLength;
      if (event.type === "complete") {
        completed = true;
        cleanup();
      }
      controller.enqueue(encoded);
    } finally {
      sending = false;
    }
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
        requestSignal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(
          () => fail(timeout()),
          Math.max(0, Math.min(ANSWER_STREAM_LIMITS.durationMs, deadlineAt - Date.now())),
        );
        if (requestSignal.aborted) {
          abort();
          return;
        }
        void Promise.resolve()
          .then(() => produce(upstream.signal, send))
          .then(() => {
            if (!completed)
              throw new ApiError(502, "ANSWER_STREAM_INCOMPLETE", "回答流未完整结束，请重新提问。");
            if (!closed) {
              controller.close();
              closed = true;
            }
          })
          .catch(fail);
      },
      pull() {
        ready = true;
        wake?.();
        wake = undefined;
      },
      cancel() {
        closed = true;
        if (!completed) return fail(cancelled());
        else cleanup();
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-store, no-transform, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "X-Accel-Buffering": "no",
      Vary: "Cookie, Accept",
    },
  });
}
