import { ApiError, failure, json, requireUser } from "@/lib/supabase/api";
import { learningOverviewSchema } from "@/lib/learning/overview";
import { id, requireLearningFeature, rethrowLearningRpc } from "../_utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { supabase } = await requireUser(request);
    requireLearningFeature();
    const spaceId = new URL(request.url).searchParams.get("spaceId") ?? "all";
    if (!id.safeParse(spaceId).success)
      throw new ApiError(400, "INVALID_LEARNING_REQUEST", "学习空间地址无效。");
    const { data, error } = await supabase.rpc("learning_overview", { p_space_id: spaceId });
    if (error) rethrowLearningRpc(error);
    const parsed = learningOverviewSchema.safeParse(data);
    if (!parsed.success)
      throw new ApiError(503, "LEARNING_UNAVAILABLE", "学习概览暂时无法读取，请稍后重试。");
    return json(parsed.data);
  } catch (error) {
    return failure(error);
  }
}
