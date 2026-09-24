import { z } from "zod";
import { aiFeatureEnabled } from "@/lib/ai/features";
import { ApiError } from "@/lib/supabase/api";
import { learningIdSchema } from "@/lib/learning/schema";

export const id = learningIdSchema;

export function requireLearningFeature() {
  if (!aiFeatureEnabled("LEARNING"))
    throw new ApiError(404, "LEARNING_DISABLED", "学习功能尚未开启。");
}

export function rethrowLearningRpc(error: { code?: string; message?: string }) {
  if (error.code === "40001")
    throw new ApiError(409, "LEARNING_REVIEW_CONFLICT", "复习状态已更新，请刷新后重试。");
  throw error;
}

export function parseLimit(value: string | null, fallback = 20) {
  const parsed = z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .safeParse(value ?? fallback);
  if (!parsed.success) throw new ApiError(400, "INVALID_LEARNING_REQUEST", "学习请求参数无效。");
  return parsed.data;
}
