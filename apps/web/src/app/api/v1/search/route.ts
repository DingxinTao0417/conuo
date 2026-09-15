import { z } from "zod";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import { workspaceSchema } from "@/lib/supabase/validation";
import { searchRequestSchema } from "@/lib/search-types";
import { materializeSearchCandidates, SearchBoundaryError } from "@/lib/search";
import { indexedSourceCandidates, noteSearchCandidates } from "@/lib/server-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const schema = z
  .object({
    request: searchRequestSchema,
    mode: z.enum(["keyword", "semantic"]).default("keyword"),
  })
  .strict();

export async function POST(request: Request) {
  try {
    const { supabase, user } = await requireUser(request);
    const parsed = schema.safeParse(await readJson(request, 20000));
    if (!parsed.success || !parsed.data.request.query.trim())
      throw new ApiError(400, "INVALID_SEARCH", "请检查搜索词与筛选条件。");
    const input = parsed.data;
    const load = async () => {
      const { data, error } = await supabase
        .from("workspaces")
        .select("data,revision")
        .eq("owner_id", user.id)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new ApiError(404, "NO_WORKSPACE", "请先将资料保存到云端。");
      const workspace = workspaceSchema.safeParse(data.data);
      if (!workspace.success)
        throw new ApiError(422, "INVALID_CLOUD_DATA", "云端资料格式无法读取。");
      return { data: workspace.data, revision: Number(data.revision) };
    };
    const initial = await load();
    const assertCurrent = async () => {
      if (request.signal.aborted) throw new ApiError(499, "SEARCH_CANCELLED", "搜索已停止。");
      const auth = await requireUser(request);
      const latest = await load();
      if (request.signal.aborted) throw new ApiError(499, "SEARCH_CANCELLED", "搜索已停止。");
      if (auth.user.id !== user.id || latest.revision !== initial.revision)
        throw new ApiError(409, "SEARCH_CONTEXT_CHANGED", "资料或账号已改变，请重新搜索。");
    };
    const sources = await indexedSourceCandidates(
      supabase,
      initial.data,
      initial.revision,
      input.request,
      input.mode === "semantic",
      { mode: input.mode, ownerId: user.id, signal: request.signal, assertCurrent },
    );
    const notes = input.mode === "keyword" ? noteSearchCandidates(initial.data, input.request) : [];
    const candidates = [...sources, ...notes];
    // Validate before returning only version-bound IDs; the browser rematerializes from its current workspace.
    materializeSearchCandidates(initial.data, input.request, candidates);
    await assertCurrent();
    return json({ candidates, mode: input.mode, revision: initial.revision });
  } catch (error) {
    return failure(
      error instanceof SearchBoundaryError
        ? new ApiError(409, "SEARCH_CONTEXT_CHANGED", error.message)
        : error,
    );
  }
}
