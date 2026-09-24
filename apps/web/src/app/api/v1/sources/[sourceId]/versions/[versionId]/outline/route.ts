import { z } from "zod";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const item = z
  .object({
    title: z.string().trim().min(1).max(200),
    level: z.number().int().min(1).max(6),
    page: z.number().int().min(1).max(100_000).optional(),
  })
  .strict();
const method = z.enum(["pdf-outline", "heading-heuristic", "docx-headings", "markdown-headings"]);
const requestSchema = z.object({ method, items: z.array(item).max(1_000) }).strict();

async function target(context: { params: Promise<{ sourceId: string; versionId: string }> }) {
  const params = await context.params;
  const parsed = z.object({ sourceId: id, versionId: id }).safeParse(params);
  if (!parsed.success) throw new ApiError(400, "INVALID_SOURCE_OUTLINE", "资料目录地址无效。");
  return parsed.data;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ sourceId: string; versionId: string }> },
) {
  try {
    const { supabase } = await requireUser(_request);
    const { sourceId, versionId } = await target(context);
    const { data, error } = await supabase.rpc("read_source_outlines", {
      p_refs: [{ sourceId, versionId }],
    });
    if (error) throw error;
    if (!Array.isArray(data))
      throw new ApiError(503, "SOURCE_OUTLINE_UNAVAILABLE", "资料目录暂时无法读取。");
    return json(
      data[0] ?? {
        sourceId,
        versionId,
        method: null,
        items: [],
      },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ sourceId: string; versionId: string }> },
) {
  try {
    const { supabase } = await requireUser(request);
    const { sourceId, versionId } = await target(context);
    const parsed = requestSchema.safeParse(await readJson(request, 140 * 1024));
    if (!parsed.success) throw new ApiError(400, "INVALID_SOURCE_OUTLINE", "资料目录格式无效。");
    const { data, error } = await supabase.rpc("save_source_outline", {
      p_source_id: sourceId,
      p_version_id: versionId,
      p_method: parsed.data.method,
      p_items: parsed.data.items,
    });
    if (error) throw error;
    if (!data || typeof data !== "object")
      throw new ApiError(503, "SOURCE_OUTLINE_UNAVAILABLE", "资料目录保存响应无效。");
    return json(data);
  } catch (error) {
    return failure(error);
  }
}
