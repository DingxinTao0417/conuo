import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import {
  SOURCE_PURGE_SELECTION_MAX_BODY_BYTES,
  sameSourcePurgeSelection,
  sourcePurgePreviewSchema,
  sourcePurgeSelectionSchema,
} from "@/lib/source-purge-contract";
import {
  assertSourcePurgeRequestActive,
  parseSourcePurgeId,
  sourcePurgeFailure,
} from "@/lib/supabase/source-purge-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only selection preview; the server computes associations and impact. */
export async function POST(request: Request, context: { params: Promise<{ sourceId: string }> }) {
  try {
    const { supabase, user } = await requireUser(request);
    assertSourcePurgeRequestActive(request);
    const id = parseSourcePurgeId((await context.params).sourceId);
    const input = sourcePurgeSelectionSchema.safeParse(
      await readJson(request, SOURCE_PURGE_SELECTION_MAX_BODY_BYTES),
    );
    if (!input.success)
      throw new ApiError(400, "INVALID_PURGE_SELECTION", "请选择当前关联的笔记和对话后重新核对。");
    assertSourcePurgeRequestActive(request);
    const { data, error } = await supabase.rpc("preview_source_purge_selection", {
      p_source_id: id,
      p_note_ids: input.data.noteIds,
      p_conversation_ids: input.data.conversationIds,
    });
    if (error) sourcePurgeFailure(error);
    const parsed = sourcePurgePreviewSchema.safeParse(data);
    if (!parsed.success || !parsed.data.contentSelection)
      throw new ApiError(503, "PURGE_UNAVAILABLE", "删除选择服务尚未就绪，请完成数据库迁移。");
    if (
      parsed.data.impact.source.id !== id ||
      !sameSourcePurgeSelection(parsed.data.contentSelection.selection, input.data)
    )
      throw new ApiError(503, "PURGE_UNAVAILABLE", "删除选择核对结果不完整，请重新核对。");
    assertSourcePurgeRequestActive(request);
    const current = await requireUser(request);
    if (current.user.id !== user.id)
      throw new ApiError(409, "SESSION_CHANGED", "账号已改变，请重新核对删除范围。");
    return json(parsed.data);
  } catch (error) {
    return failure(error);
  }
}
