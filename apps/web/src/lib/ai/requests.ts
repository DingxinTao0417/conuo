import "server-only";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ApiError } from "../supabase/api";
import { getSupabaseConfig } from "../supabase/config";
import type { AnswerResult } from "../types";
import type { OrganizationResult } from "../organization-types";
import type { VisionStudyResult } from "../vision-region-contract";
import type { GlossarySuggestionResult } from "./glossary";
import type { PracticeResult } from "./practice";
import type { GradeResult, HintResult, ExplainFeedbackResult } from "./grading";
import {
  AI_DAILY_REQUEST_LIMIT_MIN,
  AI_DAILY_REQUEST_LIMIT_MAX,
  AI_DEFAULT_DAILY_REQUEST_LIMIT,
  AI_DAILY_TOKEN_LIMIT_MAX,
  AI_DEFAULT_DAILY_TOKEN_LIMIT,
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
export function readAiDailyTokenLimit(): number {
  const raw = process.env.CONUO_AI_DAILY_TOKEN_LIMIT;
  const daily = raw === undefined || raw === "" ? AI_DEFAULT_DAILY_TOKEN_LIMIT : Number(raw);
  if (
    (raw !== undefined && raw !== "" && raw.trim() === "") ||
    !Number.isInteger(daily) ||
    daily < 0 ||
    daily > AI_DAILY_TOKEN_LIMIT_MAX
  )
    throw new ApiError(503, "INVALID_AI_LIMIT", "模型每日 token 限制配置无效。");
  return daily;
}
/** Ledger routes recorded by the membership reservation (see the membership migration). */
export type AiRequestRoute =
  "ask" | "organize" | "organization-job" | "vision" | "learning" | "glossary";
/** Plan feature switches; keep in sync with docs/MEMBERSHIP_SYSTEM_PLAN.md §4.3. */
export type MembershipFeature =
  "vision_region" | "organization" | "learning_ai" | "deep_thinking" | "tutor_mode";
export type MembershipEnforcement = "off" | "shadow" | "on";

/** off keeps the legacy global quota; shadow observes plan limits; on enforces them. */
export function readMembershipEnforcement(): MembershipEnforcement {
  const raw = process.env.CONUO_MEMBERSHIP_ENFORCEMENT?.trim() ?? "";
  if (raw === "" || raw === "off") return "off";
  if (raw === "shadow" || raw === "on") return raw;
  throw new ApiError(503, "INVALID_MEMBERSHIP_CONFIGURATION", "会员额度配置无效，本次未调用模型。");
}

const reservationSchema = z.object({
  status: z.enum([
    "reserved",
    "running",
    "completed",
    "failed",
    "mismatch",
    "busy",
    "limited",
    "token_limited",
    "feature_unavailable",
  ]),
  result: z.unknown().optional(),
  errorCode: z.string().nullable().optional(),
  shadow: z
    .object({
      planCode: z.string().optional(),
      planLimit: z.number().optional(),
      wouldLimit: z.boolean().optional(),
      featureAllowed: z.boolean().optional(),
      error: z.string().optional(),
    })
    .optional(),
});

/** Aggregate-only observation for calibrating plan limits; no account or content fields. */
function logMembershipShadow(route: AiRequestRoute, status: string, shadow: unknown) {
  console.info(
    JSON.stringify({ event: "membership_shadow", route, status, ...(shadow as object) }),
  );
}
const completionSchema = z.object({ requestId: z.string().min(1).max(100) }).strict();

export async function reserveRequest(
  store: Store,
  ownerId: string,
  requestId: string,
  fingerprint: string,
  options: { ttlSeconds?: number; route?: AiRequestRoute; features?: MembershipFeature[] } = {},
): Promise<{ kind: "reserved" } | { kind: "cached"; result: unknown }> {
  const daily = readAiDailyRequestLimit();
  const dailyTokenLimit = readAiDailyTokenLimit();
  const enforcement = readMembershipEnforcement();
  const ttl = Object.hasOwn(options, "ttlSeconds") ? { p_ttl_seconds: options.ttlSeconds } : {};
  if (enforcement !== "off" && !options.route)
    throw new ApiError(
      503,
      "INVALID_MEMBERSHIP_CONFIGURATION",
      "会员额度配置无效，本次未调用模型。",
    );
  // off keeps the legacy RPC so this code is safe before the membership migration is applied.
  const { data, error } =
    enforcement === "off"
      ? await store.rpc("reserve_ai_request", {
          p_owner: ownerId,
          p_request_id: requestId,
          p_fingerprint: fingerprint,
          p_daily_limit: daily,
          p_daily_token_limit: dailyTokenLimit,
          ...ttl,
        })
      : await store.rpc("reserve_membership_ai_request", {
          p_owner: ownerId,
          p_request_id: requestId,
          p_fingerprint: fingerprint,
          p_route: options.route,
          p_features: options.features?.length ? options.features : null,
          p_global_cap: daily,
          p_enforcement: enforcement,
          p_daily_token_limit: dailyTokenLimit,
          ...ttl,
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
  if (parsed.data.shadow && options.route)
    logMembershipShadow(options.route, parsed.data.status, parsed.data.shadow);
  switch (parsed.data.status) {
    case "feature_unavailable":
      throw new ApiError(
        403,
        "MEMBERSHIP_FEATURE_REQUIRED",
        "当前会员等级未开放这项 AI 功能；阅读、搜索、笔记和导出不受影响。",
      );
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
    case "token_limited":
      throw new ApiError(
        429,
        "AI_DAILY_TOKEN_LIMIT",
        "今日 AI 用量（按 token 计）已用完，UTC 次日恢复。仍可阅读、搜索和导出资料。",
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
  result?:
    | AnswerResult
    | OrganizationResult
    | VisionStudyResult
    | GlossarySuggestionResult
    | PracticeResult
    | GradeResult
    | HintResult
    | ExplainFeedbackResult,
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
