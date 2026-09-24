import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import { learningSettingsSchema } from "@/lib/learning/schema";
import { requireLearningFeature, rethrowLearningRpc } from "../_utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { supabase } = await requireUser(request);
    requireLearningFeature();
    const { data, error } = await supabase.rpc("get_learning_settings");
    if (error) rethrowLearningRpc(error);
    return json(data ?? { dailyNewLimit: 20, desiredRetention: 0.9, paused: false });
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: Request) {
  try {
    const { supabase } = await requireUser(request);
    requireLearningFeature();
    const parsed = learningSettingsSchema.safeParse(await readJson(request, 4_096));
    if (!parsed.success) throw new ApiError(400, "INVALID_LEARNING_REQUEST", "学习设置格式无效。");
    const { data, error } = await supabase.rpc("save_learning_settings", {
      p_settings: parsed.data,
    });
    if (error) rethrowLearningRpc(error);
    return json(data);
  } catch (error) {
    return failure(error);
  }
}
