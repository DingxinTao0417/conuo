import { z } from "zod";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import { readEmbeddingConfig } from "@/lib/ai/embeddings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const { supabase } = await requireUser(request);
    const { data, error } = await supabase.rpc("embedding_job_status", { p_source_ids: null });
    if (error)
      throw new ApiError(503, "INDEXING_UNAVAILABLE", "索引任务服务尚未就绪，请完成数据库迁移。");
    return json({ ...data, configured: Boolean(readEmbeddingConfig()) });
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    const { supabase } = await requireUser(request);
    const parsed = z
      .object({ jobId: z.uuid(), action: z.enum(["cancel", "retry"]) })
      .strict()
      .safeParse(await readJson(request, 2048));
    if (!parsed.success) throw new ApiError(400, "INVALID_INDEXING_ACTION", "索引任务操作无效。");
    const { data, error } = await supabase.rpc("control_embedding_job", {
      p_job_id: parsed.data.jobId,
      p_action: parsed.data.action,
    });
    if (error) throw new ApiError(409, "INDEXING_STATE_CHANGED", "任务状态已改变，请刷新后重试。");
    return json(data);
  } catch (error) {
    return failure(error);
  }
}
