import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ApiError, failure, json, readJson } from "@/lib/supabase/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { runSourcePurgeCleanup } from "@/lib/supabase/source-purge-cleanup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const requestSchema = z
  .object({
    workerId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,80}$/)
      .default("manual-source-purge-cleanup"),
    limit: z.number().int().min(1).max(5).default(3),
    leaseSeconds: z.number().int().min(30).max(180).default(120),
  })
  .strict();
const cronInput = { workerId: "vercel-source-purge-cleanup", limit: 3, leaseSeconds: 120 };

function requireCleanupIdentity(request: Request) {
  const secret = process.env.CONUO_CLEANUP_SECRET?.trim() || process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 32 || secret.length > 4096 || /[^\x21-\x7e]/.test(secret))
    throw new ApiError(503, "CLEANUP_NOT_CONFIGURED", "资料清理入口尚未配置。");
  const header = request.headers.get("authorization") || "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (header.length > 8192 || !timingSafeEqual(digest(header), digest(`Bearer ${secret}`)))
    throw new ApiError(401, "CLEANUP_UNAUTHORIZED", "资料清理身份无效。");
}

async function clean(request: Request, input: z.infer<typeof requestSchema>) {
  requireCleanupIdentity(request);
  const admin = createAdminClient();
  return json(
    await runSourcePurgeCleanup(admin, admin.storage, {
      ...input,
      signal: request.signal,
    }),
  );
}

/** Vercel Cron calls this endpoint with GET and an Authorization Bearer secret. */
export async function GET(request: Request) {
  try {
    return await clean(request, cronInput);
  } catch (error) {
    return failure(error);
  }
}

/** A bounded POST is available for an operator or an external scheduler. */
export async function POST(request: Request) {
  try {
    requireCleanupIdentity(request);
    const parsed = requestSchema.safeParse(await readJson(request, 4096));
    if (!parsed.success)
      throw new ApiError(400, "INVALID_CLEANUP_REQUEST", "资料清理任务请求格式无效。");
    const admin = createAdminClient();
    return json(
      await runSourcePurgeCleanup(admin, admin.storage, {
        ...parsed.data,
        signal: request.signal,
      }),
    );
  } catch (error) {
    return failure(error);
  }
}
