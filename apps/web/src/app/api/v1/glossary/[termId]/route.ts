import { z } from "zod";
import { ApiError, failure, json, requireUser } from "@/lib/supabase/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);

export async function DELETE(request: Request, context: { params: Promise<{ termId: string }> }) {
  try {
    const { supabase } = await requireUser(request);
    const { termId } = await context.params;
    const spaceId = new URL(request.url).searchParams.get("spaceId") ?? "";
    if (!id.safeParse(termId).success || !id.safeParse(spaceId).success)
      throw new ApiError(400, "INVALID_GLOSSARY", "术语地址无效。");
    const { data, error } = await supabase.rpc("delete_glossary_term", {
      p_space_id: spaceId,
      p_term_id: termId,
    });
    if (error) throw error;
    if (!data || typeof data !== "object")
      throw new ApiError(503, "GLOSSARY_UNAVAILABLE", "术语表删除结果无效，请稍后重试。");
    return json(data);
  } catch (error) {
    return failure(error);
  }
}
