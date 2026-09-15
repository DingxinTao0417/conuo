import { ApiError, failure, json, requireUser } from "@/lib/supabase/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    request.signal.throwIfAborted();
    const { supabase, user } = await requireUser(request);
    request.signal.throwIfAborted();
    const { data, error } = await supabase
      .from("workspaces")
      .select("revision")
      .eq("owner_id", user.id)
      .abortSignal(request.signal)
      .maybeSingle();
    request.signal.throwIfAborted();
    if (error) throw error;
    if (!data) return json({ revision: 0 });
    if (!Number.isSafeInteger(data.revision) || data.revision < 1)
      throw new ApiError(422, "INVALID_CLOUD_DATA", "云端版本格式异常，请保留本机资料。");
    return json({ revision: data.revision });
  } catch (error) {
    return failure(error);
  }
}
