import { z } from "zod";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import { inkFailure, inkTarget as target } from "@/lib/ink-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z
  .object({
    operationId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    intentId: z.string().uuid(),
    reservationToken: z.string().uuid(),
  })
  .strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ sourceId: string; versionId: string }> },
) {
  try {
    const { supabase } = await requireUser(request);
    await target(context);
    const input = requestSchema.safeParse(await readJson(request, 8 * 1024));
    if (!input.success)
      throw new ApiError(400, "INVALID_INK_COMMIT", "笔迹提交信息无效，已保留本机笔迹。");
    const { data, error } = await supabase.rpc("commit_ink_upload", {
      p_intent_id: input.data.intentId,
      p_reservation_token: input.data.reservationToken,
      p_operation_id: input.data.operationId,
    });
    if (error) inkFailure(error);
    if (!data || typeof data !== "object")
      throw new ApiError(503, "INK_UNAVAILABLE", "笔迹提交响应无效，已保留本机笔迹。");
    return json(data);
  } catch (error) {
    return failure(error);
  }
}
