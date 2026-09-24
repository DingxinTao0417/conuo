import { ApiError, failure, json, requireUser, readJson } from "@/lib/supabase/api";
import { reviewRequestSchema } from "@/lib/learning/schema";
import { scheduleReview, type ReviewRating } from "@/lib/learning/fsrs";
import { id, requireLearningFeature, rethrowLearningRpc } from "../_utils";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stateSchema = z.object({
  card: z.record(z.string(), z.unknown()),
  dueAt: z.string(),
  version: z.number().int(),
});

export async function POST(request: Request) {
  try {
    const { supabase } = await requireUser(request);
    requireLearningFeature();
    const parsed = reviewRequestSchema.safeParse(await readJson(request, 64_000));
    if (!parsed.success) throw new ApiError(400, "INVALID_LEARNING_REQUEST", "复习记录格式无效。");
    if (!id.safeParse(parsed.data.itemId).success)
      throw new ApiError(400, "INVALID_LEARNING_REQUEST", "学习题目地址无效。");
    const state = await supabase.rpc("list_learning_items", {
      p_space_id: null,
      p_status: null,
      p_limit: 100,
      p_before: null,
    });
    if (state.error) rethrowLearningRpc(state.error);
    const item = (state.data ?? []).find(
      (value: unknown) => (value as { itemId?: string }).itemId === parsed.data.itemId,
    );
    const current = stateSchema.safeParse(item);
    if (!current.success || !current.data.card)
      throw new ApiError(404, "LEARNING_ITEM_NOT_FOUND", "学习题目不存在。");
    const settings = await supabase.rpc("get_learning_settings");
    if (settings.error) rethrowLearningRpc(settings.error);
    const desiredRetention = Number(
      (settings.data as { desiredRetention?: number } | null)?.desiredRetention ?? 0.9,
    );
    const next = scheduleReview(
      current.data.card,
      parsed.data.rating as ReviewRating,
      desiredRetention,
    );
    const { data, error } = await supabase.rpc("record_review", {
      p_item_id: parsed.data.itemId,
      p_log: {
        logId: crypto.randomUUID().replaceAll("-", ""),
        rating: parsed.data.rating,
        answerText: parsed.data.answerText,
        grade: parsed.data.grade,
        elapsedMs: parsed.data.elapsedMs,
      },
      p_next_card: next.card,
      p_due_at: next.dueAt,
      p_expected_version: parsed.data.expectedVersion,
    });
    if (error) rethrowLearningRpc(error);
    return json(data);
  } catch (error) {
    return failure(error);
  }
}
