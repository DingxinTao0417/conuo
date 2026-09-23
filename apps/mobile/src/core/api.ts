import {
  snapshotSchema,
  answerSchema,
  type Workspace,
  type Snapshot,
} from "./contracts.ts";
import { normalizeImportUrl, webPreviewSchema } from "./web-import.ts";

export class ClientError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 0, code = "CONNECTION_FAILED") {
    super(message);
    this.name = "ClientError";
    this.status = status;
    this.code = code;
  }
}
export function validateApiUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("请配置有效的 HTTPS 服务地址。");
  return url.origin;
}
export type Identity = { userId: string; accessToken: string };
export function createApi(
  base: string,
  identity: () => Promise<Identity | null>,
  fetcher: typeof fetch = fetch,
) {
  const origin = validateApiUrl(base);
  async function request(path: string, owner: string, init: RequestInit = {}) {
    const current = await identity();
    if (!current || current.userId !== owner)
      throw new ClientError(
        "当前账号已改变，请重新登录。",
        409,
        "SESSION_CHANGED",
      );
    const controller = new AbortController();
    const abort = () => controller.abort();
    init.signal?.addEventListener("abort", abort, { once: true });
    if (init.signal?.aborted) controller.abort();
    const timer = setTimeout(abort, path === "/api/v1/ask" ? 120_000 : 30_000);
    try {
      const response = await fetcher(origin + path, {
        ...init,
        signal: controller.signal,
        credentials: "omit",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${current.accessToken}`,
          "X-Conuo-User": owner,
        },
      });
      const data: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted)
        throw new ClientError(
          "请求已停止，未确认的内容仍留在当前页面。",
          0,
          "CANCELLED",
        );
      const after = await identity();
      if (!after || after.userId !== owner)
        throw new ClientError(
          "账号已改变，已忽略原账号响应。",
          409,
          "SESSION_CHANGED",
        );
      if (!response.ok) {
        const error = data as { error?: unknown; code?: unknown } | null;
        throw new ClientError(
          typeof error?.error === "string"
            ? error.error.slice(0, 1000)
            : "云端请求失败，请稍后重试。",
          response.status,
          typeof error?.code === "string" && /^[A-Z_]{1,80}$/.test(error.code)
            ? error.code
            : "CLOUD_ERROR",
        );
      }
      return data;
    } catch (error) {
      if (error instanceof ClientError) throw error;
      throw new ClientError(
        controller.signal.aborted
          ? "连接超时或请求已停止，请重新连接确认结果。"
          : "暂时无法连接云端，请检查网络。",
      );
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", abort);
    }
  }
  return {
    async previewWeb(owner: string, url: string, signal?: AbortSignal) {
      const originalUrl = normalizeImportUrl(url);
      const result = webPreviewSchema.safeParse(
        await request("/api/v1/web/preview", owner, {
          method: "POST",
          signal,
          body: JSON.stringify({ url: originalUrl }),
        }),
      );
      if (!result.success || result.data.originalUrl !== originalUrl)
        throw new ClientError(
          "网页预览格式或来源不一致，请重新提取。",
          502,
          "INVALID_WEB_PREVIEW",
        );
      return result.data;
    },
    async load(owner: string, signal?: AbortSignal): Promise<Snapshot> {
      const result = snapshotSchema.safeParse(
        await request("/api/v1/workspace", owner, { signal }),
      );
      if (!result.success)
        throw new ClientError(
          "云端资料格式不兼容，请更新客户端。",
          502,
          "INVALID_WORKSPACE",
        );
      return result.data;
    },
    async save(
      owner: string,
      snapshot: Snapshot,
      data: Workspace,
      signal?: AbortSignal,
    ) {
      const result = (await request("/api/v1/workspace", owner, {
        method: "PUT",
        signal,
        body: JSON.stringify({ data, expectedRevision: snapshot.revision }),
      })) as { revision?: unknown };
      if (result?.revision !== snapshot.revision + 1)
        throw new ClientError(
          "云端确认格式异常，请重新连接核对保存结果。",
          502,
          "INVALID_SAVE",
        );
      return { data, revision: result.revision as number };
    },
    async ask(owner: string, payload: unknown, signal?: AbortSignal) {
      const result = answerSchema.safeParse(
        await request("/api/v1/ask", owner, {
          method: "POST",
          signal,
          body: JSON.stringify(payload),
        }),
      );
      if (!result.success)
        throw new ClientError(
          "回答未通过完整性校验，请重试。",
          502,
          "INVALID_ANSWER",
        );
      return result.data;
    },
    async loadInkManifest(owner: string, sourceId: string, versionId: string, signal?: AbortSignal) {
      return request(
        `/api/v1/sources/${encodeURIComponent(sourceId)}/versions/${encodeURIComponent(versionId)}/ink`,
        owner,
        { signal },
      );
    },
    async reserveInkUpload(
      owner: string,
      sourceId: string,
      versionId: string,
      input: unknown,
      signal?: AbortSignal,
    ) {
      return request(
        `/api/v1/sources/${encodeURIComponent(sourceId)}/versions/${encodeURIComponent(versionId)}/ink/upload-intents`,
        owner,
        { method: "POST", signal, body: JSON.stringify(input) },
      );
    },
    async commitInkUpload(
      owner: string,
      sourceId: string,
      versionId: string,
      input: unknown,
      signal?: AbortSignal,
    ) {
      return request(
        `/api/v1/sources/${encodeURIComponent(sourceId)}/versions/${encodeURIComponent(versionId)}/ink/commits`,
        owner,
        { method: "POST", signal, body: JSON.stringify(input) },
      );
    },
  };
}
