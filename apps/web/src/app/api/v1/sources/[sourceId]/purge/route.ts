import { z } from "zod";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import { assertWorkspaceOwner } from "@/lib/supabase/validation";
import {
  SOURCE_PURGE_SELECTION_MAX_BODY_BYTES,
  sourcePurgePreviewSchema,
  sourcePurgeSelectionSchema,
} from "@/lib/source-purge-contract";
import {
  assertSourcePurgeRequestActive,
  parseSourcePurgeId,
  sourcePurgeFailure,
  sourcePurgeResultSchema,
} from "@/lib/supabase/source-purge-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const purgeRequestSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    fingerprint: fingerprintSchema,
    selection: sourcePurgeSelectionSchema.optional(),
  })
  .strict();

/** Preview is server-derived so a stale browser cannot understate the deletion impact. */
export async function GET(request: Request, context: { params: Promise<{ sourceId: string }> }) {
  try {
    const { supabase, user } = await requireUser(request);
    assertSourcePurgeRequestActive(request);
    const id = parseSourcePurgeId((await context.params).sourceId);
    const { data, error } = await supabase.rpc("preview_source_purge", { p_source_id: id });
    if (error) sourcePurgeFailure(error);
    const parsed = sourcePurgePreviewSchema.safeParse(data);
    if (!parsed.success)
      throw new ApiError(503, "PURGE_UNAVAILABLE", "彻底删除服务尚未就绪，请完成数据库迁移。");
    if (
      parsed.data.impact.source.id !== id ||
      (parsed.data.contentSelection &&
        (parsed.data.contentSelection.selection.noteIds.length ||
          parsed.data.contentSelection.selection.conversationIds.length))
    )
      throw new ApiError(503, "PURGE_UNAVAILABLE", "删除范围核对结果不完整，请重新核对。");
    assertSourcePurgeRequestActive(request);
    const current = await requireUser(request);
    if (current.user.id !== user.id)
      throw new ApiError(409, "SESSION_CHANGED", "账号已改变，请重新核对删除范围。");
    return json(parsed.data);
  } catch (error) {
    return failure(error);
  }
}

/**
 * The mutation runs entirely inside the database transaction. The browser
 * supplies a revision, preview fingerprint and explicit saved-content choices.
 * Storage paths and all actual associations are derived inside the transaction.
 */
export async function POST(request: Request, context: { params: Promise<{ sourceId: string }> }) {
  try {
    const { supabase, user } = await requireUser(request);
    assertSourcePurgeRequestActive(request);
    const id = parseSourcePurgeId((await context.params).sourceId);
    const input = purgeRequestSchema.safeParse(
      await readJson(request, SOURCE_PURGE_SELECTION_MAX_BODY_BYTES),
    );
    if (!input.success)
      throw new ApiError(400, "INVALID_PURGE", "请重新查看删除影响范围后再确认。");
    assertSourcePurgeRequestActive(request);
    const selection = input.data.selection;
    const { data, error } = await supabase.rpc(
      selection ? "request_source_purge_selection" : "request_source_purge",
      {
        p_source_id: id,
        p_expected_revision: input.data.expectedRevision,
        p_fingerprint: input.data.fingerprint,
        ...(selection
          ? { p_note_ids: selection.noteIds, p_conversation_ids: selection.conversationIds }
          : {}),
      },
    );
    if (error) sourcePurgeFailure(error);
    const parsed = sourcePurgeResultSchema.safeParse(data);
    if (!parsed.success)
      throw new ApiError(503, "PURGE_UNAVAILABLE", "彻底删除服务尚未就绪，请完成数据库迁移。");
    assertWorkspaceOwner(parsed.data.data, user.id);
    if (
      parsed.data.revision <= input.data.expectedRevision ||
      parsed.data.data.sources.some((source) => source.id === id) ||
      selection?.noteIds.some((noteId) =>
        parsed.data.data.notes.some((note) => note.id === noteId),
      ) ||
      selection?.conversationIds.some((conversationId) =>
        parsed.data.data.conversations.some((conversation) => conversation.id === conversationId),
      )
    )
      throw new ApiError(503, "PURGE_UNAVAILABLE", "云端删除结果不完整，请刷新资料库后重新核对。");
    assertSourcePurgeRequestActive(request);
    const current = await requireUser(request);
    if (current.user.id !== user.id)
      throw new ApiError(409, "SESSION_CHANGED", "账号已改变，请重新核对删除结果。");
    return json(parsed.data);
  } catch (error) {
    return failure(error);
  }
}
