import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "../supabase/api";
import { createRequestStore } from "./requests";

export const EMBEDDING_PROFILE = "embedding-v1";
export const EMBEDDING_DIMENSIONS = 1536;
export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensionsParam: boolean;
  batchSize: number;
  fingerprint: string;
}
const invalidConfig = () =>
  new ApiError(503, "EMBEDDING_CONFIGURATION", "语义检索服务配置不完整或无效。");

export function readEmbeddingConfig(
  env: Record<string, string | undefined> = process.env,
): EmbeddingConfig | null {
  const value = env.CONUO_EMBEDDING_BASE_URL?.trim() || "";
  const apiKey = env.CONUO_EMBEDDING_API_KEY?.trim() || "";
  const model = env.CONUO_EMBEDDING_MODEL?.trim() || "";
  if (!value && !apiKey && !model) return null;
  if (
    !value ||
    !apiKey ||
    !model ||
    /[^\x21-\x7e]/.test(apiKey) ||
    apiKey.length > 4096 ||
    /[^\x20-\x7e]/.test(model) ||
    model.length > 256
  )
    throw invalidConfig();
  let baseUrl: string;
  try {
    if (
      value.length > 2048 ||
      /[^\x21-\x7e]|\\|%2e/i.test(value) ||
      /\/(?:\.|\.\.)(?:\/|$)/.test(value) ||
      !/^https?:\/\//i.test(value)
    )
      throw invalidConfig();
    const url = new URL(value);
    const authority = value.match(/^https?:\/\/([^/?#]*)/i)?.[1]?.toLowerCase() || "";
    const loopback = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(authority);
    if (
      url.username ||
      url.password ||
      authority.includes("@") ||
      value.includes("?") ||
      value.includes("#") ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    )
      throw invalidConfig();
    baseUrl = url.toString().replace(/\/+$/, "");
  } catch {
    throw invalidConfig();
  }
  const dimensionsParam = env.CONUO_EMBEDDING_DIMENSIONS_PARAM?.trim() || "false";
  if (dimensionsParam !== "true" && dimensionsParam !== "false") throw invalidConfig();
  const batchValue = env.CONUO_EMBEDDING_BATCH_SIZE?.trim() || "10";
  const batchSize = Number(batchValue);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 16) throw invalidConfig();
  const fingerprintParts: unknown[] = [EMBEDDING_PROFILE, baseUrl, model, EMBEDDING_DIMENSIONS];
  if (dimensionsParam === "true") fingerprintParts.push("dimensions-param");
  const fingerprint = createHash("sha256").update(JSON.stringify(fingerprintParts)).digest("hex");
  return {
    baseUrl,
    apiKey,
    model,
    dimensionsParam: dimensionsParam === "true",
    batchSize,
    fingerprint,
  };
}

/** Conservative character budget, including failed attempts; not a provider currency ceiling. */
export async function reserveEmbeddingUsage(
  ownerId: string,
  characters: number,
  store = createRequestStore(),
) {
  const daily = Number(process.env.CONUO_EMBEDDING_DAILY_CHAR_LIMIT || "200000");
  if (!Number.isInteger(daily) || daily < 1 || daily > 2_000_000) throw invalidConfig();
  const { data, error } = await store.rpc("reserve_embedding_usage", {
    p_owner_id: ownerId,
    p_request_id: randomUUID(),
    p_characters: characters,
    p_daily_char_limit: daily,
  });
  if (error || typeof data?.allowed !== "boolean")
    throw new ApiError(
      503,
      "EMBEDDING_BUDGET_UNAVAILABLE",
      "语义检索额度服务暂不可用，本次未调用模型。",
    );
  if (!data.allowed)
    throw new ApiError(
      429,
      "EMBEDDING_DAILY_LIMIT",
      "今日语义索引与搜索的处理额度已用完，UTC 次日恢复。普通关键词搜索仍可使用。",
    );
}

export async function embedQuery(
  config: EmbeddingConfig,
  input: string,
  signal?: AbortSignal,
): Promise<number[]> {
  if (!input.trim() || input.length > 4000)
    throw new ApiError(400, "INVALID_QUERY", "请输入不超过 4000 字符的搜索内容。");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(cancel, 20_000);
  const bad = () => new ApiError(502, "EMBEDDING_RESPONSE", "语义检索服务返回的数据无效。");
  try {
    const response = await fetch(`${config.baseUrl}/embeddings`, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        input: [input],
        encoding_format: "float",
        ...(config.dimensionsParam ? { dimensions: EMBEDDING_DIMENSIONS } : {}),
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiError(
        response.status === 429 ? 429 : 502,
        "EMBEDDING_PROVIDER",
        "语义检索服务暂不可用，请稍后重试。",
      );
    }
    if (
      !response.headers.get("content-type")?.toLowerCase().startsWith("application/json") ||
      Number(response.headers.get("content-length")) > 256 * 1024 ||
      !response.body
    ) {
      await response.body?.cancel();
      throw bad();
    }
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 256 * 1024) {
          await reader.cancel();
          throw bad();
        }
        parts.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw bad();
    }
    if (!Array.isArray(parsed?.data) || parsed.data.length !== 1 || parsed.data[0]?.index !== 0)
      throw bad();
    const vector: unknown = parsed.data[0]?.embedding;
    if (
      !Array.isArray(vector) ||
      vector.length !== EMBEDDING_DIMENSIONS ||
      vector.some((x) => typeof x !== "number" || !Number.isFinite(x) || Math.abs(x) > 1e10) ||
      !vector.some((x) => x !== 0)
    )
      throw bad();
    if (controller.signal.aborted)
      throw new ApiError(499, "EMBEDDING_CANCELLED", "语义搜索已停止。");
    return vector as number[];
  } catch (error) {
    if (controller.signal.aborted)
      throw new ApiError(
        signal?.aborted ? 499 : 504,
        "EMBEDDING_CANCELLED",
        signal?.aborted ? "语义搜索已停止。" : "语义搜索超时，请重试。",
      );
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "EMBEDDING_PROVIDER", "语义检索服务连接失败。");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

const EMBEDDING_INPUT_MAX_CHARS = 24_000;
const EMBEDDING_INPUT_MAX_BYTES = 120_000;
const EMBEDDING_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;

export async function embedTexts(
  config: EmbeddingConfig,
  texts: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  const validBatch =
    Array.isArray(texts) &&
    texts.length >= 1 &&
    texts.length <= Math.min(16, config.batchSize) &&
    texts.every(
      (text) =>
        typeof text === "string" && text.length > 0 && text.length <= EMBEDDING_INPUT_MAX_CHARS,
    ) &&
    texts.reduce((total, text) => total + new TextEncoder().encode(text).byteLength, 0) <=
      EMBEDDING_INPUT_MAX_BYTES;
  if (!validBatch) throw new ApiError(400, "EMBEDDING_INPUT_INVALID", "语义索引输入批次无效。");

  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(cancel, 30_000);
  const bad = () =>
    new ApiError(502, "EMBEDDING_PROVIDER_REJECTED", "语义检索服务返回的数据无效。");
  try {
    const response = await fetch(config.baseUrl + "/embeddings", {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.apiKey },
      body: JSON.stringify({
        model: config.model,
        input: texts,
        encoding_format: "float",
        ...(config.dimensionsParam ? { dimensions: EMBEDDING_DIMENSIONS } : {}),
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429 || response.status >= 500)
        throw new ApiError(
          503,
          "EMBEDDING_PROVIDER_RETRYABLE",
          "语义检索服务暂不可用，请稍后重试。",
        );
      if ([400, 401, 403, 404, 413, 422].includes(response.status))
        throw new ApiError(502, "EMBEDDING_PROVIDER_REJECTED", "语义检索服务拒绝了本次请求。");
      throw new ApiError(502, "EMBEDDING_PROVIDER_REJECTED", "语义检索服务返回了未知状态。");
    }
    if (
      !response.headers.get("content-type")?.toLowerCase().startsWith("application/json") ||
      Number(response.headers.get("content-length")) > EMBEDDING_RESPONSE_MAX_BYTES ||
      !response.body
    ) {
      await response.body?.cancel();
      throw bad();
    }
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > EMBEDDING_RESPONSE_MAX_BYTES) {
          await reader.cancel();
          throw bad();
        }
        parts.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    let parsed: { data?: Array<{ index?: unknown; embedding?: unknown }> };
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw bad();
    }
    if (!Array.isArray(parsed?.data) || parsed.data.length !== texts.length) throw bad();
    const ordered: number[][] = new Array(texts.length);
    const seen = new Set<number>();
    for (const item of parsed.data) {
      const index = item.index;
      if (
        !item ||
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= texts.length ||
        seen.has(index)
      )
        throw bad();
      const vector: unknown = item.embedding;
      if (
        !Array.isArray(vector) ||
        vector.length !== EMBEDDING_DIMENSIONS ||
        vector.some((x) => typeof x !== "number" || !Number.isFinite(x) || Math.abs(x) > 1e10) ||
        !vector.some((x) => x !== 0)
      )
        throw bad();
      seen.add(index);
      ordered[index] = vector as number[];
    }
    if (seen.size !== texts.length || ordered.some((vector) => !vector)) throw bad();
    if (controller.signal.aborted)
      throw new ApiError(499, "EMBEDDING_CANCELLED", "语义索引已停止。");
    return ordered;
  } catch (error) {
    if (controller.signal.aborted)
      throw new ApiError(
        signal?.aborted ? 499 : 504,
        "EMBEDDING_CANCELLED",
        signal?.aborted ? "语义索引已停止。" : "语义索引超时，请重试。",
      );
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "EMBEDDING_PROVIDER_RETRYABLE", "语义检索服务连接失败。");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
