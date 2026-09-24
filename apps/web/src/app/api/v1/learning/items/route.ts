import { z } from "zod";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import { learningItemSchema } from "@/lib/learning/schema";
import { id, parseLimit, requireLearningFeature, rethrowLearningRpc } from "../_utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const saveSchema = z.object({ items: z.array(learningItemSchema).min(1).max(20) }).strict();

export async function GET(request: Request) {
  try {
    const { supabase } = await requireUser(request);
    requireLearningFeature();
    const params = new URL(request.url).searchParams;
    const spaceId = params.get("spaceId") ?? "";
    const status = params.get("status");
    if (
      !id.safeParse(spaceId).success ||
      (status !== null && !["active", "suspended", "archived"].includes(status))
    )
      throw new ApiError(400, "INVALID_LEARNING_REQUEST", "学习列表参数无效。");
    const { data, error } = await supabase.rpc("list_learning_items", {
      p_space_id: spaceId,
      p_status: status,
      p_limit: parseLimit(params.get("limit")),
      p_before: params.get("before"),
    });
    if (error) rethrowLearningRpc(error);
    return json({ items: data ?? [] });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase } = await requireUser(request);
    requireLearningFeature();
    const parsed = saveSchema.safeParse(await readJson(request, 512_000));
    if (!parsed.success) throw new ApiError(400, "INVALID_LEARNING_REQUEST", "学习题目格式无效。");
    const { data, error } = await supabase.rpc("upsert_learning_items", {
      p_items: parsed.data.items,
    });
    if (error) rethrowLearningRpc(error);
    return json({ items: data ?? [] });
  } catch (error) {
    return failure(error);
  }
}
