import { ApiError, failure, json, requireUser } from "@/lib/supabase/api";
import { id } from "../_utils";
import { parseLimit, requireLearningFeature, rethrowLearningRpc } from "../_utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { supabase } = await requireUser(request);
    requireLearningFeature();
    const params = new URL(request.url).searchParams;
    const spaceId = params.get("spaceId") ?? "";
    if (!id.safeParse(spaceId).success)
      throw new ApiError(400, "INVALID_LEARNING_REQUEST", "学习空间地址无效。");
    const { data, error } = await supabase.rpc("due_review_items", {
      p_space_id: spaceId,
      p_limit: parseLimit(params.get("limit")),
    });
    if (error) rethrowLearningRpc(error);
    return json({ items: data ?? [] });
  } catch (error) {
    return failure(error);
  }
}
