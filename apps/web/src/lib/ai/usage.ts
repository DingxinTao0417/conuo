import "server-only";
import { aiRequestUsageSchema, type AiRequestUsage } from "../ai-request-usage";
import { ApiError } from "../supabase/api";
import { createRequestStore, readAiDailyRequestLimit } from "./requests";

export async function readAiRequestUsage(
  store: ReturnType<typeof createRequestStore>,
  ownerId: string,
  signal: AbortSignal,
): Promise<AiRequestUsage> {
  const dailyLimit = readAiDailyRequestLimit();
  if (signal.aborted) throw new ApiError(499, "REQUEST_CANCELLED", "用量检查已停止，请重新刷新。");
  const checkedAt = new Date();
  const start = new Date(checkedAt);
  start.setUTCHours(0, 0, 0, 0);
  const reset = new Date(start.getTime() + 86_400_000);
  let count: number | null;
  try {
    const result = await store
      .from("ai_requests")
      .select("request_id", { count: "exact", head: true })
      .eq("owner_id", ownerId)
      .gte("created_at", start.toISOString())
      .lt("created_at", reset.toISOString())
      .abortSignal(signal)
      .retry(false);
    if (result.error) throw result.error;
    count = result.count;
  } catch {
    if (signal.aborted)
      throw new ApiError(499, "REQUEST_CANCELLED", "用量检查已停止，请重新刷新。");
    throw new ApiError(503, "AI_USAGE_UNAVAILABLE", "暂时无法读取 AI 用量，请稍后刷新。");
  }
  if (signal.aborted) throw new ApiError(499, "REQUEST_CANCELLED", "用量检查已停止，请重新刷新。");
  // Missing/malformed counts are unknown, not zero. Include every reserved row,
  // regardless of running/completed/failed state, just like the reservation RPC.
  const parsed = aiRequestUsageSchema.safeParse({
    usedCount: count,
    dailyLimit,
    remainingCount: typeof count === "number" ? Math.max(0, dailyLimit - count) : null,
    windowStart: start.toISOString(),
    resetsAt: reset.toISOString(),
    checkedAt: checkedAt.toISOString(),
    counting: "reserved_requests",
    includesFailedAndCancelled: true,
  });
  if (!parsed.success)
    throw new ApiError(503, "AI_USAGE_UNAVAILABLE", "AI 用量返回异常，请稍后刷新。");
  return parsed.data;
}
