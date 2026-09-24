import { z } from "zod";
import { answerNoteEvidenceSchema, citationSchema } from "./citation-schema";
import type { AnswerResult } from "./types";
import type { OnAnswerProgress } from "./answer-stream-types";

export const ANSWER_STREAM_LIMITS = Object.freeze({
  eventBytes: 512 * 1024,
  totalBytes: 16 * 1024 * 1024,
  events: 4096,
  timeoutMs: 310_000,
  idleTimeoutMs: 60_000,
});
export const streamedAnswerSchema = z
  .object({
    content: z.string().min(1).max(50_000),
    citations: z.array(citationSchema).max(12),
    noteEvidence: z.array(answerNoteEvidenceSchema).max(12).optional(),
    mode: z.enum(["extractive", "model"]),
  })
  .strict();
const safeError = z
  .object({
    error: z.string().trim().min(1).max(1000),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
  })
  .strict();
export const answerStreamEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("progress"),
      phase: z.enum(["retrieving", "generating", "validating", "reasoning"]),
    })
    .strict(),
  z.object({ type: z.literal("draft"), answer: streamedAnswerSchema }).strict(),
  z.object({ type: z.literal("complete"), answer: streamedAnswerSchema }).strict(),
  safeError
    .extend({ type: z.literal("error"), status: z.number().int().min(400).max(599) })
    .strict(),
]);
export class AnswerStreamError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 502,
  ) {
    super(message);
    this.name = "AnswerStreamError";
  }
}
const invalid = () =>
  new AnswerStreamError("INVALID_ANSWER_STREAM", "问答响应格式无效，未保存未完成的回答。");
const limit = () =>
  new AnswerStreamError("ANSWER_STREAM_LIMIT", "问答响应超过读取上限，未保存未完成的回答。");
export const answerCancelled = () =>
  new DOMException("问答已停止，未保存未完成的回答。", "AbortError");

/** Reads transient frames without persistence. Only a complete frame or a full legacy JSON resolves. */
export async function readAnswerResponse(
  response: Response,
  options: {
    signal?: AbortSignal;
    onProgress?: OnAnswerProgress;
    timeoutMs?: number;
    idleTimeoutMs?: number;
  } = {},
): Promise<AnswerResult> {
  const { signal, onProgress } = options;
  const cancelBody = () => {
    void response.body?.cancel().catch(() => {});
  };
  if (signal?.aborted) {
    cancelBody();
    throw answerCancelled();
  }
  const mime = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  const streaming = response.ok && mime === "text/event-stream";
  if ((!streaming && mime !== "application/json") || !response.body) {
    cancelBody();
    if (!response.ok)
      throw new AnswerStreamError("CLOUD_ERROR", "云端问答请求失败，请稍后重试。", response.status);
    throw invalid();
  }
  const totalLimit = streaming ? ANSWER_STREAM_LIMITS.totalBytes : ANSWER_STREAM_LIMITS.eventBytes;
  if (Number(response.headers.get("Content-Length")) > totalLimit) {
    cancelBody();
    throw limit();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let rejectInterrupted!: (error: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupted = reject;
  });
  const abort = () => rejectInterrupted(answerCancelled());
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = () =>
    rejectInterrupted(
      new AnswerStreamError("ANSWER_STREAM_TIMEOUT", "问答响应超时，未保存未完成的回答。", 504),
    );
  const deadline = setTimeout(timeout, options.timeoutMs ?? ANSWER_STREAM_LIMITS.timeoutMs);
  let idle: ReturnType<typeof setTimeout>;
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(timeout, options.idleTimeoutMs ?? ANSWER_STREAM_LIMITS.idleTimeoutMs);
  };
  let received = 0;
  resetIdle();
  const take = async () => {
    if (signal?.aborted) throw answerCancelled();
    const item = await Promise.race([reader.read(), interrupted]);
    if (signal?.aborted) throw answerCancelled();
    if (!item.done) {
      received += item.value.byteLength;
      if (received > totalLimit) throw limit();
      resetIdle();
    }
    try {
      return { done: item.done, text: decoder.decode(item.value, { stream: !item.done }) };
    } catch {
      throw invalid();
    }
  };
  const parseJson = (value: string): unknown => {
    try {
      return JSON.parse(value);
    } catch {
      throw invalid();
    }
  };
  try {
    if (!streaming) {
      let body = "";
      while (true) {
        const item = await take();
        body += item.text;
        if (item.done) break;
      }
      if (!response.ok) {
        let value: unknown;
        try {
          value = JSON.parse(body);
        } catch {
          /* Never echo an unstructured server response. */
        }
        const error = safeError.safeParse(value);
        if (error.success)
          throw new AnswerStreamError(error.data.code, error.data.error, response.status);
        throw new AnswerStreamError(
          "CLOUD_ERROR",
          "云端问答请求失败，请稍后重试。",
          response.status,
        );
      }
      const answer = streamedAnswerSchema.safeParse(parseJson(body));
      if (!answer.success) throw invalid();
      return answer.data;
    }
    let buffer = "";
    let data: string[] = [];
    let frameBytes = 0;
    let events = 0;
    while (true) {
      const item = await take();
      buffer += item.text;
      while (true) {
        const newline = /[\r\n]/.exec(buffer);
        if (!newline) break;
        const index = newline.index;
        if (buffer[index] === "\r" && index === buffer.length - 1 && !item.done) break;
        const end = index + (buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1);
        const line = buffer.slice(0, index);
        frameBytes += encoder.encode(buffer.slice(0, end)).byteLength;
        if (frameBytes > ANSWER_STREAM_LIMITS.eventBytes) throw limit();
        buffer = buffer.slice(end);
        if (line === "") {
          frameBytes = 0;
          if (!data.length) continue;
          if (++events > ANSWER_STREAM_LIMITS.events) throw limit();
          const parsed = answerStreamEventSchema.safeParse(parseJson(data.join("\n")));
          data = [];
          if (!parsed.success) throw invalid();
          const event = parsed.data;
          if (event.type === "error")
            throw new AnswerStreamError(event.code, event.error, event.status);
          if (event.type === "complete") return event.answer;
          if (signal?.aborted) throw answerCancelled();
          onProgress?.(event);
          if (signal?.aborted) throw answerCancelled();
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? "" : line.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "data") data.push(value);
          // SSE event/id/retry fields are not authoritative and never cause reconnection.
        }
      }
      if (frameBytes + encoder.encode(buffer).byteLength > ANSWER_STREAM_LIMITS.eventBytes)
        throw limit();
      if (item.done)
        throw new AnswerStreamError(
          "ANSWER_STREAM_INCOMPLETE",
          "问答连接在完整结果确认前结束，未保存草稿。请重新提问。",
        );
    }
  } finally {
    clearTimeout(deadline);
    clearTimeout(idle!);
    signal?.removeEventListener("abort", abort);
    // Do not await a peer's cancel hook: a stalled peer must not hold a stopped answer open.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
