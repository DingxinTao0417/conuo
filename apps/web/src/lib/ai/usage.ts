import "server-only";
import { aiRequestUsageSchema, type AiRequestUsage } from "../ai-request-usage";
import { ApiError } from "../supabase/api";
import {
  createRequestStore,
  readAiDailyRequestLimit,
  readAiDailyTokenLimit,
  readMembershipEnforcement,
  type MembershipEnforcement,
} from "./requests";

type Store = ReturnType<typeof createRequestStore>;

function timestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** Same limit rule as reserve_membership_ai_request; the RPC resolves membership. */
async function readMembershipCount(
  store: Store,
  ownerId: string,
  globalCap: number,
  enforcement: Exclude<MembershipEnforcement, "off">,
  signal: AbortSignal,
) {
  const result = await store
    .rpc("ai_membership_usage", {
      p_owner: ownerId,
      p_global_cap: globalCap,
      p_enforcement: enforcement,
    })
    .abortSignal(signal);
  if (result.error) throw result.error;
  const data = (result.data ?? {}) as Record<string, unknown>;
  const membership = (data.membership ?? {}) as Record<string, unknown>;
  return {
    count: data.usedCount,
    dailyLimit: data.dailyLimit,
    membership: {
      planCode: membership.planCode,
      planName: membership.planName,
      source: membership.source ?? null,
      endsAt: membership.endsAt == null ? null : timestamp(membership.endsAt),
      afterEnd: membership.afterEnd ?? null,
      enforced: enforcement === "on",
    },
  };
}

export async function readAiRequestUsage(
  store: Store,
  ownerId: string,
  signal: AbortSignal,
): Promise<AiRequestUsage> {
  const globalCap = readAiDailyRequestLimit();
  let dailyLimit: unknown = globalCap;
  const tokenLimit = readAiDailyTokenLimit();
  const enforcement = readMembershipEnforcement();
  let membership: unknown;
  if (signal.aborted) throw new ApiError(499, "REQUEST_CANCELLED", "用量检查已停止，请重新刷新。");
  const checkedAt = new Date();
  const start = new Date(checkedAt);
  start.setUTCHours(0, 0, 0, 0);
  const reset = new Date(start.getTime() + 86_400_000);
  let count: unknown;
  try {
    if (enforcement !== "off") {
      const read = await readMembershipCount(store, ownerId, globalCap, enforcement, signal);
      ({ count, dailyLimit, membership } = read);
    } else {
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
    }
  } catch {
    if (signal.aborted)
      throw new ApiError(499, "REQUEST_CANCELLED", "用量检查已停止，请重新刷新。");
    throw new ApiError(503, "AI_USAGE_UNAVAILABLE", "暂时无法读取 AI 用量，请稍后刷新。");
  }
  if (signal.aborted) throw new ApiError(499, "REQUEST_CANCELLED", "用量检查已停止，请重新刷新。");
  let tokenUsage: unknown;
  try {
    const result = await store
      .rpc("ai_token_usage_today", { p_owner: ownerId })
      .abortSignal(signal);
    if (result.error) throw result.error;
    tokenUsage = result.data;
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
    remainingCount:
      typeof count === "number" && typeof dailyLimit === "number"
        ? Math.max(0, dailyLimit - count)
        : null,
    windowStart: start.toISOString(),
    resetsAt: reset.toISOString(),
    checkedAt: checkedAt.toISOString(),
    counting: "reserved_requests",
    includesFailedAndCancelled: true,
    tokens: {
      ...(tokenUsage && typeof tokenUsage === "object" ? tokenUsage : {}),
      limit: tokenLimit,
    },
    ...(membership ? { membership } : {}),
  });
  if (!parsed.success)
    throw new ApiError(503, "AI_USAGE_UNAVAILABLE", "AI 用量返回异常，请稍后刷新。");
  return parsed.data;
}
