import { z } from "zod";
import { aiFeatureEnabled } from "@/lib/ai/features";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
async function target(context: { params: Promise<{ sourceId: string; versionId: string }> }) {
  const parsed = z.object({ sourceId: id, versionId: id }).safeParse(await context.params);
  if (!parsed.success) throw new ApiError(400, "INVALID_SOURCE_SUMMARY", "资料摘要地址无效。");
  return parsed.data;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ sourceId: string; versionId: string }> },
) {
  try {
    const { supabase } = await requireUser(request);
    if (!aiFeatureEnabled("SECTION_SUMMARIES"))
      throw new ApiError(404, "SUMMARY_FEATURE_DISABLED", "分层摘要功能尚未开启。");
    const { sourceId, versionId } = await target(context);
    const body = await readJson(request, 1024);
    if (!z.object({}).strict().safeParse(body).success)
      throw new ApiError(400, "INVALID_SOURCE_SUMMARY", "摘要请求格式无效。");
    const { data, error } = await supabase.rpc("request_source_summary", {
      p_source_id: sourceId,
      p_version_id: versionId,
    });
    if (error) throw error;
    if (!data || typeof data !== "object")
      throw new ApiError(503, "SOURCE_SUMMARY_UNAVAILABLE", "资料摘要请求响应无效。");
    return json(data, 202);
  } catch (error) {
    return failure(error);
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ sourceId: string; versionId: string }> },
) {
  try {
    const { supabase } = await requireUser(request);
    const { sourceId, versionId } = await target(context);
    const { data, error } = await supabase.rpc("source_summary_status", {
      p_source_id: sourceId,
      p_version_id: versionId,
    });
    if (error) throw error;
    if (!data || typeof data !== "object")
      throw new ApiError(503, "SOURCE_SUMMARY_UNAVAILABLE", "资料摘要状态响应无效。");
    return json(data);
  } catch (error) {
    return failure(error);
  }
}
