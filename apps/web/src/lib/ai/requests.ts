import "server-only";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ApiError } from "../supabase/api";
import { getSupabaseConfig } from "../supabase/config";
import type { AnswerResult } from "../types";
import type { OrganizationResult } from "../organization-types";
import type { VisionStudyResult } from "../vision-region-contract";
import {
  AI_DAILY_REQUEST_LIMIT_MIN,
  AI_DAILY_REQUEST_LIMIT_MAX,
  AI_DEFAULT_DAILY_REQUEST_LIMIT,
} from "../ai-request-usage";

export function createRequestStore() {
  const config = getSupabaseConfig();
  const secret =
    process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!config || !secret)
    throw new ApiError(
      503,
      "MODEL_LEDGER_NOT_CONFIGURED",
      "模型请求记录服务尚未配置，请联系管理员完成设置。",
    );
  return createClient(config.url, secret, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
type Store = ReturnType<typeof createRequestStore>;
export function readAiDailyRequestLimit(): number {
  const daily = Number(process.env.CONUO_AI_DAILY_REQUEST_LIMIT || AI_DEFAULT_DAILY_REQUEST_LIMIT);
  if (
    !Number.isInteger(daily) ||
    daily < AI_DAILY_REQUEST_LIMIT_MIN ||
    daily > AI_DAILY_REQUEST_LIMIT_MAX
  )
    throw new ApiError(503, "INVALID_AI_LIMIT", "模型每日调用限制配置无效。");
  return daily;
}
const reservationSchema = z.object({
  status: z.enum(["reserved", "running", "completed", "failed", "mismatch", "busy", "limited"]),
  result: z.unknown().optional(),
  errorCode: z.string().nullable().optional(),
});
const completionSchema = z.object({ requestId: z.string().min(1).max(100) }).strict();

export async function reserveRequest(
  store: Store,
  ownerId: string,
  requestId: string,
  fingerprint: string,
  options: { ttlSeconds?: number } = {},
): Promise<{ kind: "reserved" } | { kind: "cached"; result: unknown }> {
  const daily = readAiDailyRequestLimit();
  const { data, error } = await store.rpc("reserve_ai_request", {
    p_owner: ownerId,
    p_request_id: requestId,
    p_fingerprint: fingerprint,
    p_daily_limit: daily,
    ...(Object.hasOwn(options, "ttlSeconds") ? { p_ttl_seconds: options.ttlSeconds } : {}),
  });
  if (error)
    throw new ApiError(
      503,
      "MODEL_LEDGER_UNAVAILABLE",
      "模型请求记录服务暂不可用，请检查数据库迁移后重试。",
    );
  const parsed = reservationSchema.safeParse(data);
  if (!parsed.success)
    throw new ApiError(503, "MODEL_LEDGER_UNAVAILABLE", "模型请求记录返回异常，本次未调用模型。");
  switch (parsed.data.status) {
    case "reserved":
      return { kind: "reserved" };
    case "completed":
      return { kind: "cached", result: parsed.data.result };
    case "mismatch":
      throw new ApiError(409, "REQUEST_CHANGED", "资料或请求内容已改变，请重新发起模型请求。");
    case "running":
    case "busy":
      throw new ApiError(409, "REQUEST_RUNNING", "已有模型请求正在处理，请等待完成或稍后重试。");
    case "limited":
      throw new ApiError(
        429,
        "AI_DAILY_LIMIT",
        "今日模型调用次数已用完，明日 UTC 0 点恢复。仍可阅读、搜索和导出资料。",
      );
    case "failed":
      throw new ApiError(
        409,
        "REQUEST_FINISHED",
        "上次模型请求没有完成；如需再次生成，请重新发起请求。",
      );
  }
}

export async function finishRequest(
  store: Store,
  ownerId: string,
  requestId: string,
  result?: AnswerResult | OrganizationResult | VisionStudyResult,
  errorCode?: string,
) {
  // Never write the service-role table directly: the database-side completion
  // RPC rechecks the account-deletion fence before a late model result can land.
  const { data, error } = await store.rpc("finish_ai_request", {
    p_owner: ownerId,
    p_request_id: requestId,
    p_result: result ?? null,
    p_error_code: result ? null : (errorCode ?? null),
  });
  if (error || !completionSchema.safeParse(data).success)
    throw new ApiError(
      503,
      "MODEL_RESULT_NOT_SAVED",
      "模型结果未能确认保存，请稍后重试原请求以检查结果。",
    );
}
