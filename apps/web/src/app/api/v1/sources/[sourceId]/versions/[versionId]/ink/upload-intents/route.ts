import { z } from "zod";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import { inkFailure, inkTarget as target } from "@/lib/ink-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z
  .object({
    operationId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    pageIndex: z.number().int().min(0).max(99999),
    baseRevisionId: z.string().uuid().nullable(),
    localGeneration: z.number().int().positive(),
    drawing: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().min(1).max(8 * 1024 * 1024) }).strict(),
    preview: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().min(1).max(3 * 1024 * 1024), mimeType: z.literal("image/png") }).strict(),
    coordinateSpace: z.object({ version: z.literal(1), space: z.literal("pdf-crop-box") }).strict(),
    pencilKitContentVersion: z.number().int().min(1).max(100),
  })
  .strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ sourceId: string; versionId: string }> },
) {
  try {
    const { supabase } = await requireUser(request);
    const { sourceId, versionId } = await target(context);
    const input = requestSchema.safeParse(await readJson(request, 16 * 1024));
    if (!input.success)
      throw new ApiError(400, "INVALID_INK_UPLOAD", "笔迹快照格式无效，已保留本机笔迹。");
    const { data, error } = await supabase.rpc("reserve_ink_upload", {
      p_source_id: sourceId,
      p_version_id: versionId,
      p_operation_id: input.data.operationId,
      p_page_index: input.data.pageIndex,
      p_base_revision_id: input.data.baseRevisionId,
      p_local_generation: input.data.localGeneration,
      p_drawing_sha256: input.data.drawing.sha256,
      p_drawing_bytes: input.data.drawing.bytes,
      p_preview_sha256: input.data.preview.sha256,
      p_preview_bytes: input.data.preview.bytes,
      p_coordinate_space: input.data.coordinateSpace,
      p_pencilkit_content_version: input.data.pencilKitContentVersion,
    });
    if (error) inkFailure(error);
    if (!data || typeof data !== "object")
      throw new ApiError(503, "INK_UNAVAILABLE", "笔迹预留响应无效，已保留本机笔迹。");
    return json(data);
  } catch (error) {
    return failure(error);
  }
}
