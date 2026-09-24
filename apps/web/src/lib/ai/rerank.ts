import "server-only";
import { ApiError } from "../supabase/api";

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_QUERY_CHARS = 4_000;
const MAX_DOCUMENT_CHARS = 2_000;

export interface RerankConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxCandidates: number;
  topN: number;
}

const configurationError = () =>
  new ApiError(503, "MODEL_CONFIGURATION", "重排服务配置不完整或无效，请联系管理员。");
const inputError = () => new ApiError(400, "MODEL_INPUT", "重排请求内容无效。");
const responseError = () =>
  new ApiError(502, "MODEL_RESPONSE", "重排服务返回的数据无法读取，请稍后重试。");
const timeoutError = () => new ApiError(504, "MODEL_TIMEOUT", "重排服务响应超时，请稍后重试。");
const cancelledError = () => new ApiError(499, "MODEL_CANCELLED", "已停止生成。");

function parseBoundedInteger(
  value: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return fallback;
  if (!/^\d+$/u.test(trimmed)) throw configurationError();
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw configurationError();
  return parsed;
}

function normalizeBaseUrl(value: string): string {
  try {
    if (value.length > 2_048 || /\s|\\/u.test(value) || !/^https?:\/\//iu.test(value))
      throw configurationError();
    const url = new URL(value);
    const authority = value.match(/^https?:\/\/([^/?#]*)/iu)?.[1]?.toLowerCase();
    const explicitLoopback = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/u.test(authority ?? "");
    if (
      !authority ||
      url.username ||
      url.password ||
      authority.includes("@") ||
      value.includes("?") ||
      value.includes("#") ||
      !url.hostname ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && explicitLoopback))
    )
      throw configurationError();
    return url.toString().replace(/\/+$/u, "");
  } catch {
    throw configurationError();
  }
}

export function readRerankConfig(
  env: Record<string, string | undefined> = process.env,
): RerankConfig | null {
  const rawBaseUrl = env.CONUO_RERANK_BASE_URL?.trim() ?? "";
  const apiKey = env.CONUO_RERANK_API_KEY?.trim() ?? "";
  const model = env.CONUO_RERANK_MODEL?.trim() ?? "";
  if (!rawBaseUrl && !apiKey && !model) return null;
  if (
    !rawBaseUrl ||
    !apiKey ||
    !model ||
    /[^\x21-\x7e]/u.test(apiKey) ||
    apiKey.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(model) ||
    model.length > 256
  )
    throw configurationError();
  const maxCandidates = parseBoundedInteger(env.CONUO_RERANK_MAX_CANDIDATES, 8, 64, 40);
  const topN = parseBoundedInteger(env.CONUO_RERANK_TOP_N, 4, 24, 12);
  return {
    baseUrl: normalizeBaseUrl(rawBaseUrl),
    apiKey,
    model,
    maxCandidates,
    topN,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerError(status: number): ApiError {
  if (status === 429)
    return new ApiError(429, "MODEL_RATE_LIMIT", "重排服务暂时繁忙或额度不足，请稍后重试。");
  if (status === 401 || status === 403)
    return new ApiError(503, "MODEL_AUTH", "重排服务认证失败，请联系管理员。");
  if (status >= 300 && status < 400)
    return new ApiError(502, "MODEL_REDIRECT", "重排服务地址发生跳转，请联系管理员检查配置。");
  if (status >= 500)
    return new ApiError(503, "MODEL_UNAVAILABLE", "重排服务暂时不可用，请稍后重试。");
  return new ApiError(502, "MODEL_REQUEST_REJECTED", "重排服务未接受请求，请稍后重试。");
}

async function readResponseBody(response: Response, signal: AbortSignal): Promise<unknown> {
  const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  const advertised = response.headers.get("content-length");
  if (
    mime !== "application/json" ||
    (advertised && (!/^\d+$/u.test(advertised) || Number(advertised) > MAX_RESPONSE_BYTES)) ||
    !response.body
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw responseError();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw cancelledError();
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw responseError();
      }
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw responseError();
    }
  } finally {
    reader.releaseLock();
  }
}

export async function rerank(
  config: RerankConfig,
  query: string,
  documents: string[],
  signal?: AbortSignal,
): Promise<number[]> {
  if (!documents.length) return [];
  if (
    !query.trim() ||
    query.length > MAX_QUERY_CHARS ||
    documents.length > config.maxCandidates ||
    documents.some((document) => !document.trim() || document.length > MAX_DOCUMENT_CHARS)
  )
    throw inputError();
  const body = JSON.stringify({
    model: config.model,
    query,
    documents,
    top_n: Math.min(config.topN, documents.length),
    return_documents: false,
  });
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES)
    throw new ApiError(413, "MODEL_INPUT_TOO_LARGE", "重排请求内容过多，请缩小资料范围后重试。");

  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 10_000);
  try {
    const response = await fetch(`${config.baseUrl}/rerank`, {
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body,
    });
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      throw providerError(302);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw providerError(response.status);
    }
    const parsed = await readResponseBody(response, controller.signal);
    if (
      !isRecord(parsed) ||
      !Array.isArray(parsed.results) ||
      parsed.results.length > Math.min(config.topN, documents.length)
    )
      throw responseError();
    const seen = new Set<number>();
    const ranked = parsed.results.map((item, order) => {
      if (!isRecord(item)) throw responseError();
      const index = item.index;
      const score = item.relevance_score;
      if (
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= documents.length ||
        seen.has(index) ||
        typeof score !== "number" ||
        !Number.isFinite(score)
      )
        throw responseError();
      seen.add(index);
      return { index, score, order };
    });
    ranked.sort((left, right) => right.score - left.score || left.order - right.order);
    return ranked.map((item) => item.index);
  } catch (error) {
    if (controller.signal.aborted)
      throw signal?.aborted ? cancelledError() : timedOut ? timeoutError() : cancelledError();
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "MODEL_UNAVAILABLE", "重排服务连接失败，请稍后重试。");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
