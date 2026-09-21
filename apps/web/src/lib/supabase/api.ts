import { NextResponse } from "next/server";
import { accountDeletionAccessSchema, type AccountDeletionAccess } from "@/lib/account-deletion";
import { getSupabaseConfig } from "./config";
import { createClient } from "./server";
import { createBearerClient } from "./bearer-client";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      Vary: "Cookie, Authorization",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function failure(error: unknown) {
  if (error instanceof ApiError)
    return json({ error: error.message, code: error.code }, error.status);
  // Never return database messages, tokens, SQL details, or uploaded content.
  return json({ error: "云端请求失败，请稍后重试；本地资料仍然保留。", code: "CLOUD_ERROR" }, 500);
}

export type RequireUserOptions = { allowAccountDeletion?: boolean };

/**
 * The embedded development browser can report 127.0.0.1 as its page origin
 * while Next has normalized the same loopback request URL to localhost. Keep
 * this exception to the exact pair: browsers otherwise treat these as distinct
 * origins, and other loopback representations must not gain CSRF access.
 */
function isLoopbackAliasOrigin(origin: string, requestUrl: URL): boolean {
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  return (
    originUrl.origin === origin &&
    originUrl.protocol === requestUrl.protocol &&
    originUrl.port === requestUrl.port &&
    ((originUrl.hostname === "127.0.0.1" && requestUrl.hostname === "localhost") ||
      (originUrl.hostname === "localhost" && requestUrl.hostname === "127.0.0.1"))
  );
}

/**
 * Confirm the cookie session or explicit native bearer identity, then consult
 * the database-side deletion gate. An explicit Authorization header never
 * falls back to cookies, including when it is malformed or expired.
 * Every normal route is denied as soon as an account deletion request exists;
 * the dedicated deletion endpoint opts in only to display its safe status or
 * replay an idempotent request.
 */
export async function requireUser(request: Request, options: RequireUserOptions = {}) {
  const config = getSupabaseConfig();
  if (!config) throw new ApiError(503, "CLOUD_NOT_CONFIGURED", "尚未配置云端服务。");
  const authorization = request.headers.get("Authorization");
  // A single bounded RFC 6750 bearer value; reject duplicate/combined headers,
  // unsupported schemes and whitespace inside the credential before any I/O.
  const bearer =
    authorization !== null && authorization.length <= 8192
      ? /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/i.exec(authorization)?.[1]
      : undefined;
  if (authorization !== null && !bearer)
    throw new ApiError(401, "UNAUTHENTICATED", "登录凭据无效，请重新登录。");
  const supabase = bearer ? createBearerClient(bearer, config) : await createClient();
  const {
    data: { user },
    error,
  } = bearer ? await supabase.auth.getUser(bearer) : await supabase.auth.getUser();
  if (error || !user) throw new ApiError(401, "UNAUTHENTICATED", "请先登录，再连接云端资料。");
  if (request.headers.get("X-Conuo-User") !== user.id)
    throw new ApiError(409, "SESSION_CHANGED", "当前账号已改变，请重新载入对应账号的资料。");
  let status: { data: unknown; error: { code?: string; message?: string } | null };
  try {
    status = await supabase.rpc("account_deletion_access_status", {});
  } catch {
    throw new ApiError(503, "ACCOUNT_DELETION_UNAVAILABLE", "账号状态检查暂不可用，请稍后重试。");
  }
  const parsed = status.error ? null : accountDeletionAccessSchema.safeParse(status.data);
  if (!parsed || !parsed.success)
    throw new ApiError(503, "ACCOUNT_DELETION_UNAVAILABLE", "账号状态检查暂不可用，请稍后重试。");
  const accountDeletion: AccountDeletionAccess = parsed.data;
  if (!accountDeletion.allowed && !options.allowAccountDeletion)
    throw new ApiError(
      423,
      "ACCOUNT_DELETION_PENDING",
      "账号注销正在处理中，资料与云端访问已停止。",
    );
  return { supabase, user, accountDeletion };
}

export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const origin = request.headers.get("Origin");
  const requestUrl = new URL(request.url);
  const requestOrigin = requestUrl.origin;
  // Origin is the authoritative browser CSRF signal. Sec-Fetch-Site is only a
  // fallback when a client did not send Origin: embedded development browsers
  // can retain a cross-site navigation classification for a same-origin fetch.
  // A mismatched Origin remains rejected even if Sec-Fetch-Site says otherwise.
  const allowedOrigin =
    origin === requestOrigin || (origin !== null && isLoopbackAliasOrigin(origin, requestUrl));
  if (origin !== null ? !allowedOrigin : request.headers.get("Sec-Fetch-Site") === "cross-site") {
    throw new ApiError(403, "CROSS_ORIGIN", "不允许跨站修改资料。");
  }
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json"))
    throw new ApiError(415, "JSON_REQUIRED", "请求必须使用 JSON。");
  const advertised = Number(request.headers.get("Content-Length"));
  if (advertised > maxBytes)
    throw new ApiError(413, "TOO_LARGE", "工作区超过当前云端容量上限，请先导出备份。");
  if (!request.body) throw new ApiError(400, "INVALID_JSON", "请求内容为空。");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, "TOO_LARGE", "工作区超过当前云端容量上限，请先导出备份。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) {
    all.set(chunk, position);
    position += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "无法读取请求内容。");
  }
}
