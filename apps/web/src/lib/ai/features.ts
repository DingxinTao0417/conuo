import "server-only";
import { ApiError } from "../supabase/api";

/** Server-side switches. Keep names in sync with docs/AI_ENHANCEMENT_PLAN.md appendix A. */
export type AiFeature =
  | "LONG_CONTEXT"
  | "RICH_ANSWERS"
  | "DEEP_THINKING"
  | "QUERY_REWRITE"
  | "RERANK"
  | "NEIGHBOR_EXPANSION"
  | "CROSS_LIBRARY_SEMANTIC"
  | "ANSWER_MEMORY"
  | "ANSWER_VERIFY"
  | "KNOWLEDGE_NAVIGATION"
  | "SECTION_SUMMARIES"
  | "AI_TRACES"
  | "LEARNING"
  | "TUTOR_MODE"
  | "AGENT"
  | "WEB_SEARCH"
  | "EXTERNAL_BODIES";

export function aiFeatureEnabled(
  name: AiFeature,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[`CONUO_FEATURE_${name}`]?.trim() ?? "";
  if (raw === "" || raw === "off") return false;
  if (raw === "on") return true;
  throw new ApiError(503, "FEATURE_CONFIGURATION", "功能开关配置无效，请联系管理员。");
}
