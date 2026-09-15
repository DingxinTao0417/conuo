import { z } from "zod";
import { ApiError, json, readJson, requireUser } from "@/lib/supabase/api";
import { getSupabaseConfig } from "@/lib/supabase/config";
import { normalizeWebUrl, webPreviewSchema } from "@/lib/web-types";
import { fetchWebPage, WebFetchError } from "@/lib/web/fetch-page";
import { extractArticle } from "@/lib/web/extract-article";
import { previewLimiter } from "@/lib/web/preview-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;
const requestSchema = z.object({ url: z.string().min(1).max(8192) }).strict();

function localDevelopment(request: Request) {
  // The development server binds to 127.0.0.1. Never enable anonymous fetching
  // from a Host/X-Forwarded-Host claim in a deployed production build.
  return (
    process.env.NODE_ENV === "development" &&
    !getSupabaseConfig() &&
    ["127.0.0.1", "localhost", "[::1]"].includes(new URL(request.url).hostname)
  );
}

async function authorize(request: Request): Promise<string> {
  if (localDevelopment(request)) {
    if (request.headers.has("X-Conuo-User"))
      throw new ApiError(409, "SESSION_CHANGED", "账号配置已改变，请重新载入工作台。");
    return "local-development";
  }
  if (!getSupabaseConfig())
    throw new ApiError(503, "WEB_NOT_CONFIGURED", "网页提取尚未启用，可先收藏链接或粘贴正文。");
  return (await requireUser(request)).user.id;
}

export async function GET(request: Request) {
  try {
    await authorize(request);
    return json({ available: true });
  } catch (error) {
    return json({
      available: false,
      reason:
        error instanceof ApiError
          ? error.message
          : "暂时无法检查提取服务，可先收藏链接或粘贴正文。",
    });
  }
}

export async function POST(request: Request) {
  let release: (() => void) | undefined;
  try {
    const input = requestSchema.safeParse(await readJson(request, 16 * 1024));
    if (!input.success) throw new ApiError(400, "INVALID_WEB_URL", "请输入一个有效的网页地址。");
    const userId = await authorize(request);
    let originalUrl: string;
    try {
      originalUrl = normalizeWebUrl(input.data.url);
    } catch {
      throw new ApiError(400, "INVALID_WEB_URL", "请输入不含账号或密码的 http 或 https 网页地址。");
    }
    if (request.signal.aborted) throw new ApiError(499, "WEB_CANCELLED", "已取消网页提取。");
    release = previewLimiter.reserve(userId);
    const fetched = await fetchWebPage(originalUrl, request.signal);
    if (request.signal.aborted) throw new ApiError(499, "WEB_CANCELLED", "已取消网页提取。");
    const article = extractArticle(fetched.html, fetched.finalUrl);
    // This response contains only the public page explicitly requested. It is
    // not persisted or sent to a model by this endpoint.
    if ((await authorize(request)) !== userId)
      throw new ApiError(409, "SESSION_CHANGED", "当前账号已改变，请重新提取网页。");
    if (request.signal.aborted) throw new ApiError(499, "WEB_CANCELLED", "已取消网页提取。");
    const preview = webPreviewSchema.parse({
      ...article,
      originalUrl,
      finalUrl: fetched.finalUrl,
      capturedAt: fetched.fetchedAt,
    });
    return json(preview);
  } catch (error) {
    if (error instanceof ApiError)
      return json({ error: error.message, code: error.code }, error.status);
    if (error instanceof WebFetchError)
      return json({ error: error.message, code: error.code }, 422);
    return json(
      {
        error: "无法提取这个网页，可打开原站后粘贴正文，或仅收藏链接。",
        code: "WEB_EXTRACTION_FAILED",
      },
      502,
    );
  } finally {
    release?.();
  }
}
