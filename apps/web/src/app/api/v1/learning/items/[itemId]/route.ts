import { z } from "zod";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import { learningStatusSchema } from "@/lib/learning/schema";
import { id, requireLearningFeature, rethrowLearningRpc } from "../../_utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({ status: learningStatusSchema }).strict();
async function itemId(context: { params: Promise<{ itemId: string }> }) {
  const parsed = id.safeParse((await context.params).itemId);
  if (!parsed.success) throw new ApiError(400, "INVALID_LEARNING_REQUEST", "学习题目地址无效。");
  return parsed.data;
}

export async function PATCH(request: Request, context: { params: Promise<{ itemId: string }> }) {
  try {
    const { supabase } = await requireUser(request);
    requireLearningFeature();
    const parsed = patchSchema.safeParse(await readJson(request, 4_096));
    if (!parsed.success) throw new ApiError(400, "INVALID_LEARNING_REQUEST", "学习状态格式无效。");
    const { data, error } = await supabase.rpc("set_learning_item_status", {
      p_item_id: await itemId(context),
      p_status: parsed.data.status,
    });
    if (error) rethrowLearningRpc(error);
    return json(data);
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ itemId: string }> }) {
  try {
    const { supabase } = await requireUser(request);
    requireLearningFeature();
    const { data, error } = await supabase.rpc("delete_learning_item", {
      p_item_id: await itemId(context),
    });
    if (error) rethrowLearningRpc(error);
    return json({ deleted: data === true });
  } catch (error) {
    return failure(error);
  }
}
