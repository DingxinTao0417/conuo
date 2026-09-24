import "server-only";
import { ApiError } from "@/lib/supabase/api";

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  jsonMode: boolean;
  thinkingMode?: "enabled" | "disabled";
  tokenLimitParameter: "max_completion_tokens" | "max_tokens";
  timeoutMs: number;
  maxOutputTokens?: number;
  maxRequestBytes?: number;
  contextChars?: number;
  streamUsage?: boolean;
}

export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheHitTokens?: number;
}

export interface ModelObserver {
  onUsage?(usage: ModelUsage): void;
  onFirstDelta?(): void;
}

type ModelMessage = { role: "system" | "user"; content: string };
export type InlineModelImage = {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  base64: string;
};
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_VISION_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_VISION_REQUEST_BYTES = 3 * 1024 * 1024;
// SSE envelopes are much larger than the completed assistant content.
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_CHARS = 64 * 1024;
const MAX_STREAM_EVENTS = 8192;

function configurationError(): ApiError {
  return new ApiError(503, "MODEL_CONFIGURATION", "模型服务配置不完整或无效，请联系管理员。");
}

function parseTokenLimitParameter(value: string): ModelConfig["tokenLimitParameter"] {
  if (value === "max_completion_tokens" || value === "max_tokens") return value;
  throw configurationError();
}

function parseThinkingMode(value: string): ModelConfig["thinkingMode"] {
  if (value === "enabled" || value === "disabled") return value;
  throw configurationError();
}

function parseStreamUsage(value: string): boolean {
  if (value !== "true" && value !== "false") throw configurationError();
  return value === "true";
}

function parseBoundedInteger(
  value: string | undefined,
  min: number,
  max: number,
  fallback: number,
) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return fallback;
  if (!/^\d+$/.test(trimmed)) throw configurationError();
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw configurationError();
  return parsed;
}

function baseUrl(value: string): string {
  try {
    // Reject ambiguous host spelling, backslashes, and URL credentials before normalization.
    if (value.length > 2048 || /\s|\\/.test(value) || !/^https?:\/\//i.test(value))
      throw configurationError();
    const url = new URL(value);
    const authority = value.match(/^https?:\/\/([^/?#]*)/i)?.[1]?.toLowerCase();
    const explicitLoopback = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(authority ?? "");
    if (
      !authority ||
      url.username ||
      url.password ||
      authority?.includes("@") ||
      value.includes("?") ||
      value.includes("#") ||
      !url.hostname ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && explicitLoopback))
    ) {
      throw configurationError();
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw configurationError();
  }
}

function validateConfig(config: ModelConfig): ModelConfig {
  if (
    !config ||
    typeof config.baseUrl !== "string" ||
    typeof config.apiKey !== "string" ||
    !config.apiKey ||
    /[^\x21-\x7e]/.test(config.apiKey) ||
    config.apiKey.length > 4096 ||
    typeof config.model !== "string" ||
    !config.model.trim() ||
    config.model !== config.model.trim() ||
    /[\u0000-\u001f\u007f]/.test(config.model) ||
    config.model.length > 256 ||
    typeof config.jsonMode !== "boolean" ||
    (config.thinkingMode !== undefined &&
      config.thinkingMode !== "enabled" &&
      config.thinkingMode !== "disabled") ||
    (config.tokenLimitParameter !== "max_completion_tokens" &&
      config.tokenLimitParameter !== "max_tokens") ||
    !Number.isInteger(config.timeoutMs) ||
    config.timeoutMs < 1 ||
    config.timeoutMs > 600_000 ||
    (config.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(config.maxOutputTokens) ||
        config.maxOutputTokens < 256 ||
        config.maxOutputTokens > 65_536)) ||
    (config.maxRequestBytes !== undefined &&
      (!Number.isSafeInteger(config.maxRequestBytes) ||
        config.maxRequestBytes < 65_536 ||
        config.maxRequestBytes > 4_194_304)) ||
    (config.contextChars !== undefined &&
      (!Number.isSafeInteger(config.contextChars) ||
        config.contextChars < 0 ||
        config.contextChars > 2_000_000)) ||
    (config.streamUsage !== undefined && typeof config.streamUsage !== "boolean")
  ) {
    throw configurationError();
  }
  const normalized = { ...config, baseUrl: baseUrl(config.baseUrl) };
  // Keep defaults available to older hand-written test configs without changing
  // their enumerable shape or the existing configuration contract.
  for (const [key, value] of [
    ["maxOutputTokens", 4096],
    ["maxRequestBytes", MAX_REQUEST_BYTES],
    ["contextChars", 0],
    ["streamUsage", false],
  ] as const) {
    if (normalized[key] === undefined)
      Object.defineProperty(normalized, key, { configurable: true, value });
  }
  return normalized;
}

export function readProfileConfig(
  prefix: string,
  env: Record<string, string | undefined> = process.env,
): ModelConfig | null {
  const url = env[`${prefix}BASE_URL`]?.trim() ?? "";
  const key = env[`${prefix}API_KEY`]?.trim() ?? "";
  const model = env[`${prefix}NAME`]?.trim() ?? "";
  const thinkingValue = env[`${prefix}THINKING_MODE`]?.trim();
  const thinkingMode = thinkingValue ? parseThinkingMode(thinkingValue) : undefined;
  const streamUsage = parseStreamUsage(env[`${prefix}STREAM_USAGE`]?.trim() || "false");
  if (!url && !key && !model) return null;
  const jsonMode = env[`${prefix}JSON_MODE`]?.trim() || "false";
  const tokenLimitParameter =
    env[`${prefix}TOKEN_LIMIT_PARAMETER`]?.trim() || "max_completion_tokens";
  if (!url || !key || !model || !["true", "false"].includes(jsonMode)) throw configurationError();
  const timeoutMs = parseBoundedInteger(env[`${prefix}TIMEOUT_MS`], 1_000, 600_000, 45_000);
  const maxOutputTokens = parseBoundedInteger(env[`${prefix}MAX_OUTPUT_TOKENS`], 256, 65_536, 4096);
  const maxRequestBytes = parseBoundedInteger(
    env[`${prefix}MAX_REQUEST_BYTES`],
    65_536,
    4_194_304,
    MAX_REQUEST_BYTES,
  );
  const contextChars = parseBoundedInteger(env[`${prefix}CONTEXT_CHARS`], 0, 2_000_000, 0);
  return validateConfig({
    baseUrl: url,
    apiKey: key,
    model,
    jsonMode: jsonMode === "true",
    ...(thinkingMode === undefined ? {} : { thinkingMode }),
    tokenLimitParameter: parseTokenLimitParameter(tokenLimitParameter),
    timeoutMs,
    ...(env[`${prefix}MAX_OUTPUT_TOKENS`]?.trim() ? { maxOutputTokens } : {}),
    ...(env[`${prefix}MAX_REQUEST_BYTES`]?.trim() ? { maxRequestBytes } : {}),
    ...(env[`${prefix}CONTEXT_CHARS`]?.trim() ? { contextChars } : {}),
    streamUsage,
  });
}

export function readModelConfig(
  env: Record<string, string | undefined> = process.env,
): ModelConfig | null {
  return readProfileConfig("CONUO_MODEL_", env);
}

export type ModelProfileName = "default" | "fast" | "reasoning" | "vision";
const PROFILE_PREFIX: Record<Exclude<ModelProfileName, "default">, string> = {
  fast: "CONUO_FAST_MODEL_",
  reasoning: "CONUO_REASONING_MODEL_",
  vision: "CONUO_VISION_MODEL_",
};

/** Falls back to the default profile when a dedicated profile is not configured. */
export function readModelProfile(
  name: ModelProfileName,
  env: Record<string, string | undefined> = process.env,
): { profile: ModelProfileName; config: ModelConfig } | null {
  if (name === "default") {
    const config = readModelConfig(env);
    return config ? { profile: "default", config } : null;
  }
  if (name === "vision") {
    const dedicated = readProfileConfig(PROFILE_PREFIX.vision, env);
    const enabled = env.CONUO_VISION_MODEL_ENABLED?.trim() || "false";
    if (enabled !== "true" && enabled !== "false") throw configurationError();
    if (dedicated) return enabled === "true" ? { profile: "vision", config: dedicated } : null;
    const legacy = readVisionModelConfig(env);
    return legacy ? { profile: "default", config: legacy } : null;
  }
  const dedicated = readProfileConfig(PROFILE_PREFIX[name], env);
  if (dedicated) return { profile: name, config: dedicated };
  const fallback = readModelConfig(env);
  return fallback ? { profile: "default", config: fallback } : null;
}

function tokenCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 100_000_000
    ? (value as number)
    : undefined;
}

export function readModelUsage(value: unknown): ModelUsage | undefined {
  if (!isRecord(value) || !isRecord(value.usage)) return undefined;
  const usage = value.usage;
  const completionDetails = isRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : {};
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const result: ModelUsage = {
    promptTokens: tokenCount(usage.prompt_tokens),
    completionTokens: tokenCount(usage.completion_tokens),
    totalTokens: tokenCount(usage.total_tokens),
    reasoningTokens: tokenCount(completionDetails.reasoning_tokens),
    cacheHitTokens:
      tokenCount(usage.prompt_cache_hit_tokens) ?? tokenCount(promptDetails.cached_tokens),
  };
  return Object.values(result).some((item) => item !== undefined) ? result : undefined;
}

/**
 * Vision is an explicit capability because an OpenAI-compatible text endpoint
 * does not imply support for image content parts.
 */
export function readVisionModelConfig(
  env: Record<string, string | undefined> = process.env,
): ModelConfig | null {
  const config = readModelConfig(env);
  const enabled = env.CONUO_MODEL_VISION_ENABLED?.trim() || "false";
  if (enabled !== "true" && enabled !== "false") throw configurationError();
  return config && enabled === "true" ? config : null;
}

function responseError(): ApiError {
  return new ApiError(502, "MODEL_RESPONSE", "模型返回的内容无法读取，请稍后重试。");
}

function cancelledError(): ApiError {
  return new ApiError(499, "MODEL_CANCELLED", "已停止生成。");
}

function statusError(status: number): ApiError {
  if (status === 429)
    return new ApiError(429, "MODEL_RATE_LIMIT", "模型服务暂时繁忙或额度不足，请稍后重试。");
  if (status === 401 || status === 403)
    return new ApiError(503, "MODEL_AUTH", "模型服务认证失败，请联系管理员。");
  if (status >= 300 && status < 400)
    return new ApiError(502, "MODEL_REDIRECT", "模型服务地址发生跳转，请联系管理员检查配置。");
  if (status >= 500)
    return new ApiError(503, "MODEL_UNAVAILABLE", "模型服务暂时不可用，请稍后重试。");
  return new ApiError(
    502,
    "MODEL_REQUEST_REJECTED",
    "模型服务未接受请求，请联系管理员检查接口配置。",
  );
}

async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const mime = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (!mime || !/^application\/(?:[a-z0-9.+-]+\+)?json$/.test(mime) || !response.body)
    throw responseError();
  const advertised = response.headers.get("Content-Length");
  if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_RESPONSE_BYTES))
    throw responseError();
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw cancelledError();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw responseError();
      chunks.push(value);
    }
    if (signal.aborted) throw cancelledError();
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    // Cancellation need not wait for a broken upstream stream to acknowledge it.
    cancel();
    if (error instanceof ApiError) throw error;
    throw responseError();
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function completionText(value: unknown): string {
  if (
    !isRecord(value) ||
    value.object !== "chat.completion" ||
    !Array.isArray(value.choices) ||
    value.choices.length !== 1
  )
    throw responseError();
  const choice: unknown = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message) || choice.index !== 0) throw responseError();
  const message = choice.message;
  if (choice.finish_reason === "length")
    throw new ApiError(502, "MODEL_INCOMPLETE", "模型回答未完整生成，请缩小资料范围后重试。");
  if (
    choice.finish_reason === "content_filter" ||
    (message.refusal !== undefined && message.refusal !== null && message.refusal !== "")
  )
    throw new ApiError(422, "MODEL_REFUSED", "模型未能回答这次问题，请调整问题后重试。");
  if (
    choice.finish_reason !== "stop" ||
    message.role !== "assistant" ||
    (message.tool_calls !== undefined &&
      message.tool_calls !== null &&
      (!Array.isArray(message.tool_calls) || message.tool_calls.length !== 0)) ||
    (message.function_call !== undefined && message.function_call !== null) ||
    typeof message.content !== "string" ||
    !message.content.trim() ||
    message.content.length > 32_000
  )
    throw responseError();
  return message.content.trim();
}

async function readStreamResponse(
  response: Response,
  signal: AbortSignal,
  onDelta: (delta: string) => Promise<void>,
  streamUsage: boolean,
  observer?: ModelObserver,
): Promise<string> {
  const mime = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  const advertised = response.headers.get("Content-Length");
  if (
    mime !== "text/event-stream" ||
    !response.body ||
    (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_STREAM_BYTES))
  )
    throw responseError();
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let events = 0;
  let line = "";
  let eventLength = 0;
  let data: string[] = [];
  let eventType = "";
  let skipLF = false;
  let text = "";
  let stopped = false;
  let done = false;
  let usage: ModelUsage | undefined;

  const dispatch = async () => {
    if (!data.length) {
      eventType = "";
      eventLength = 0;
      return;
    }
    if (++events > MAX_STREAM_EVENTS || (eventType && eventType !== "message"))
      throw responseError();
    const payload = data.join("\n");
    data = [];
    eventType = "";
    eventLength = 0;
    if (payload === "[DONE]") {
      if (!stopped || !text.trim()) throw responseError();
      done = true;
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      throw responseError();
    }
    const parsedUsage = readModelUsage(value);
    if (parsedUsage) usage = parsedUsage;
    if (
      !isRecord(value) ||
      value.object !== "chat.completion.chunk" ||
      !Array.isArray(value.choices) ||
      (value.choices.length !== 1 && !(streamUsage && value.choices.length === 0 && parsedUsage))
    )
      throw responseError();
    if (value.choices.length === 0) return;
    if (stopped) throw responseError();
    const choice: unknown = value.choices[0];
    if (!isRecord(choice) || choice.index !== 0 || !isRecord(choice.delta)) throw responseError();
    const delta = choice.delta;
    if (choice.finish_reason === "length")
      throw new ApiError(502, "MODEL_INCOMPLETE", "模型回答未完整生成，请缩小资料范围后重试。");
    if (
      choice.finish_reason === "content_filter" ||
      (delta.refusal !== undefined && delta.refusal !== null && delta.refusal !== "")
    )
      throw new ApiError(422, "MODEL_REFUSED", "模型未能回答这次问题，请调整问题后重试。");
    if (
      (choice.finish_reason !== null && choice.finish_reason !== "stop") ||
      (delta.role !== undefined && delta.role !== null && delta.role !== "assistant") ||
      (delta.tool_calls !== undefined &&
        delta.tool_calls !== null &&
        (!Array.isArray(delta.tool_calls) || delta.tool_calls.length !== 0)) ||
      (delta.function_call !== undefined && delta.function_call !== null) ||
      (delta.content !== undefined && delta.content !== null && typeof delta.content !== "string")
    )
      throw responseError();
    if (typeof delta.content === "string" && delta.content) {
      if (text.length + delta.content.length > 32_000) throw responseError();
      text += delta.content;
      if (signal.aborted) throw cancelledError();
      if (!text.slice(0, text.length - delta.content.length)) observer?.onFirstDelta?.();
      // The caller validates current permissions and applies its own output backpressure.
      await onDelta(delta.content);
      if (signal.aborted) throw cancelledError();
    }
    if (choice.finish_reason === "stop") stopped = true;
  };
  const endLine = async () => {
    if (!line) await dispatch();
    else if (!line.startsWith(":")) {
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const raw = colon < 0 ? "" : line.slice(colon + 1);
      const value = raw.startsWith(" ") ? raw.slice(1) : raw;
      if (field === "data") data.push(value);
      if (field === "event") eventType = value;
    }
    line = "";
  };
  const consume = async (chunk: string) => {
    for (const char of chunk) {
      if (signal.aborted) throw cancelledError();
      if (skipLF && char === "\n") {
        skipLF = false;
        continue;
      }
      skipLF = false;
      if (++eventLength > MAX_EVENT_CHARS) throw responseError();
      if (char === "\r" || char === "\n") {
        skipLF = char === "\r";
        await endLine();
        if (done) return;
      } else line += char;
    }
  };
  try {
    while (!done) {
      if (signal.aborted) throw cancelledError();
      const chunk = await reader.read();
      if (chunk.done) {
        await consume(decoder.decode());
        // A disconnected stream, even after finish_reason, is not a completed response.
        if (!done)
          throw new ApiError(502, "MODEL_INCOMPLETE", "模型连接中断，回答未完成，请重新生成。");
      } else {
        bytes += chunk.value.byteLength;
        if (bytes > MAX_STREAM_BYTES) throw responseError();
        await consume(decoder.decode(chunk.value, { stream: true }));
      }
    }
    if (signal.aborted) throw cancelledError();
    if (usage) observer?.onUsage?.(usage);
    return text.trim();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw responseError();
  } finally {
    cancel();
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

async function sendModelRequest(
  validated: ModelConfig,
  body: string,
  signal?: AbortSignal,
  onDelta?: (delta: string) => Promise<void>,
  observer?: ModelObserver,
): Promise<string> {
  const controller = new AbortController();
  let stopError: ApiError | undefined;
  let rejectStopped!: (reason: ApiError) => void;
  const stopped = new Promise<never>((_, reject) => {
    rejectStopped = reject;
  });
  const stop = (error: ApiError) => {
    if (stopError) return;
    stopError = error;
    // Settle our request even if a transport does not honor AbortSignal promptly.
    rejectStopped(error);
    controller.abort();
  };
  const abort = () => stop(cancelledError());
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => stop(new ApiError(504, "MODEL_TIMEOUT", "模型响应超时，请稍后重试。")),
    validated.timeoutMs,
  );
  let response: Response | undefined;
  try {
    return await Promise.race([
      stopped,
      (async () => {
        // The URL is administrator configuration; user content never chooses an endpoint.
        try {
          response = await fetch(`${validated.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: onDelta ? "text/event-stream" : "application/json",
              Authorization: `Bearer ${validated.apiKey}`,
            },
            body,
            cache: "no-store",
            credentials: "omit",
            redirect: "manual",
            signal: controller.signal,
          });
        } catch {
          throw new ApiError(503, "MODEL_UNAVAILABLE", "模型服务暂时不可用，请稍后重试。");
        }
        if (stopError) {
          if (response.body && !response.body.locked)
            void response.body.cancel().catch(() => undefined);
          throw stopError;
        }
        if (response.redirected) throw statusError(302);
        if (!response.ok) throw statusError(response.status);
        let result: string;
        if (onDelta)
          result = await readStreamResponse(
            response,
            controller.signal,
            onDelta,
            validated.streamUsage === true,
            observer,
          );
        else {
          const value = await readResponse(response, controller.signal);
          result = completionText(value);
          const usage = readModelUsage(value);
          if (usage) observer?.onUsage?.(usage);
        }
        if (stopError) throw stopError;
        return result;
      })(),
    ]);
  } catch (error) {
    if (stopError) throw stopError;
    if (error instanceof ApiError) throw error;
    // Fetch exceptions can contain credentials, provider URLs, or provider content.
    throw new ApiError(503, "MODEL_UNAVAILABLE", "模型服务暂时不可用，请稍后重试。");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
  }
}

/** One shared generation declaration for text, SSE and inline-image completions. */
function generationOptions(config: ModelConfig) {
  return {
    store: false,
    n: 1,
    ...(config.tokenLimitParameter === "max_tokens"
      ? { max_tokens: config.maxOutputTokens ?? 4096 }
      : { max_completion_tokens: config.maxOutputTokens ?? 4096 }),
    ...(config.jsonMode ? { response_format: { type: "json_object" } } : {}),
    ...(config.thinkingMode === undefined ? {} : { thinking: { type: config.thinkingMode } }),
  };
}

async function requestModel(
  config: ModelConfig,
  messages: ModelMessage[],
  signal?: AbortSignal,
  onDelta?: (delta: string) => Promise<void>,
  observer?: ModelObserver,
): Promise<string> {
  const validated = validateConfig(config);
  if (signal?.aborted) throw cancelledError();
  if (
    !Array.isArray(messages) ||
    !messages.length ||
    messages.length > 16 ||
    messages.some(
      (message) =>
        !message ||
        !["system", "user"].includes(message.role) ||
        typeof message.content !== "string" ||
        !message.content.trim(),
    )
  ) {
    throw new ApiError(400, "MODEL_INPUT", "无法读取模型请求，请调整问题后重试。");
  }
  const body = JSON.stringify({
    model: validated.model,
    messages: messages.map(({ role, content }) => ({ role, content })),
    stream: !!onDelta,
    ...generationOptions(validated),
    ...(onDelta && validated.streamUsage === true
      ? { stream_options: { include_usage: true } }
      : {}),
  });
  if (new TextEncoder().encode(body).length > (validated.maxRequestBytes ?? MAX_REQUEST_BYTES))
    throw new ApiError(413, "MODEL_INPUT_TOO_LARGE", "本次资料过多，请缩小范围后重试。");
  return sendModelRequest(validated, body, signal, onDelta, observer);
}

export function callModel(
  config: ModelConfig,
  messages: ModelMessage[],
  signal?: AbortSignal,
  observer?: ModelObserver,
): Promise<string> {
  return requestModel(config, messages, signal, undefined, observer);
}

/**
 * Sends one already-validated inline image. The adapter constructs the data URL
 * itself, so callers cannot make the provider fetch an attacker-controlled URL.
 */
export function callVisionModel(
  config: ModelConfig,
  messages: ModelMessage[],
  image: InlineModelImage,
  signal?: AbortSignal,
  observer?: ModelObserver,
): Promise<string> {
  try {
    const validated = validateConfig(config);
    if (signal?.aborted) throw cancelledError();
    if (
      !Array.isArray(messages) ||
      messages.length !== 2 ||
      messages[0]?.role !== "system" ||
      messages[1]?.role !== "user" ||
      messages.some(
        (message) =>
          typeof message.content !== "string" ||
          !message.content.trim() ||
          message.content.length > 32_000,
      ) ||
      !image ||
      !["image/png", "image/jpeg", "image/webp"].includes(image.mimeType) ||
      typeof image.base64 !== "string" ||
      !image.base64 ||
      image.base64.length > Math.ceil((MAX_VISION_IMAGE_BYTES * 4) / 3) + 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64) ||
      image.base64.length % 4 !== 0
    )
      throw new ApiError(400, "MODEL_INPUT", "无法读取区域视觉学习请求，请重新选择区域。");
    const body = JSON.stringify({
      model: validated.model,
      messages: [
        { role: "system", content: messages[0].content },
        {
          role: "user",
          content: [
            { type: "text", text: messages[1].content },
            {
              type: "image_url",
              image_url: {
                url: `data:${image.mimeType};base64,${image.base64}`,
                detail: "original",
              },
            },
          ],
        },
      ],
      stream: false,
      ...generationOptions(validated),
    });
    if (
      new TextEncoder().encode(body).length >
      Math.min(validated.maxRequestBytes ?? MAX_REQUEST_BYTES, MAX_VISION_REQUEST_BYTES)
    )
      throw new ApiError(413, "MODEL_INPUT_TOO_LARGE", "区域图片过大，请缩小区域后重试。");
    return sendModelRequest(validated, body, signal, undefined, observer);
  } catch (error) {
    return Promise.reject(error);
  }
}

/** Deltas are provisional; only a validated stop + [DONE] resolves the complete raw answer. */
export function callModelStream(
  config: ModelConfig,
  messages: ModelMessage[],
  signal: AbortSignal | undefined,
  onDelta: (delta: string) => Promise<void>,
  observer?: ModelObserver,
): Promise<string> {
  if (typeof onDelta !== "function")
    return Promise.reject(new ApiError(400, "MODEL_INPUT", "无法读取模型请求，请调整问题后重试。"));
  return requestModel(config, messages, signal, onDelta, observer);
}
