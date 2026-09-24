import { z } from "zod";
import { glossaryTermSchema } from "@/lib/ai/glossary";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const definition = z
  .object({
    text: z.string().trim().min(1).max(600),
    chunkRefs: z
      .array(z.object({ sourceId: id, versionId: id, chunkId: id }).strict())
      .min(1)
      .max(3),
  })
  .strict();
const upsertSchema = z
  .object({
    spaceId: id,
    termId: id,
    term: z.string().trim().min(1).max(80),
    aliases: z.array(z.string().trim().min(1).max(80)).max(10),
    definition,
    status: z.enum(["accepted", "rejected"]),
    origin: z.enum(["ai", "user"]),
  })
  .strict();

export async function GET(request: Request) {
  try {
    const { supabase } = await requireUser(request);
    const spaceId = new URL(request.url).searchParams.get("spaceId") ?? "";
    if (!id.safeParse(spaceId).success)
      throw new ApiError(400, "INVALID_GLOSSARY", "术语表空间地址无效。");
    const { data, error } = await supabase.rpc("list_glossary_terms", { p_space_id: spaceId });
    if (error) throw error;
    const parsed = z.array(glossaryTermSchema).safeParse(data);
    if (!parsed.success)
      throw new ApiError(503, "GLOSSARY_UNAVAILABLE", "术语表读取结果无效，请稍后重试。");
    return json({ terms: parsed.data });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase } = await requireUser(request);
    const parsed = upsertSchema.safeParse(await readJson(request, 32_000));
    if (!parsed.success)
      throw new ApiError(400, "INVALID_GLOSSARY", "术语、别名和原文依据格式无效。");
    const { data, error } = await supabase.rpc("upsert_glossary_term", {
      p_space_id: parsed.data.spaceId,
      p_term_id: parsed.data.termId,
      p_term: parsed.data.term,
      p_aliases: parsed.data.aliases,
      p_definition: parsed.data.definition,
      p_status: parsed.data.status,
      p_origin: parsed.data.origin,
    });
    if (error) throw error;
    const result = glossaryTermSchema.safeParse(data);
    if (!result.success)
      throw new ApiError(503, "GLOSSARY_UNAVAILABLE", "术语表保存结果无效，请稍后重试。");
    return json(result.data);
  } catch (error) {
    return failure(error);
  }
}
