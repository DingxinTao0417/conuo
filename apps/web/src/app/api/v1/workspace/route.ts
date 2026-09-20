import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import {
  assertWorkspaceOwner,
  MAX_WORKSPACE_BYTES,
  saveRequestSchema,
  workspaceSchema,
} from "@/lib/supabase/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    request.signal.throwIfAborted();
    const { supabase, user } = await requireUser(request);
    request.signal.throwIfAborted();
    const { data, error } = await supabase
      .from("workspaces")
      .select("data, revision")
      .eq("owner_id", user.id)
      .abortSignal(request.signal)
      .maybeSingle();
    request.signal.throwIfAborted();
    if (error) throw error;
    if (!data) return json({ data: null, revision: 0 });
    const parsed = workspaceSchema.safeParse(data.data);
    if (!parsed.success)
      throw new ApiError(
        422,
        "INVALID_CLOUD_DATA",
        "云端数据格式与当前版本不兼容，请保留本地资料。",
      );
    assertWorkspaceOwner(parsed.data, user.id);
    return json({ data: parsed.data, revision: data.revision });
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: Request) {
  try {
    const { supabase, user } = await requireUser(request);
    const parsed = saveRequestSchema.safeParse(await readJson(request, MAX_WORKSPACE_BYTES + 1024));
    if (!parsed.success)
      throw new ApiError(
        400,
        "INVALID_WORKSPACE",
        "资料格式不完整或超出容量限制，请保留本地副本。",
      );
    assertWorkspaceOwner(parsed.data.data, user.id);
    if (new TextEncoder().encode(JSON.stringify(parsed.data.data)).byteLength > MAX_WORKSPACE_BYTES)
      throw new ApiError(
        413,
        "TOO_LARGE",
        "工作区文字与历史记录超过当前 3 MiB 云端上限，请先导出备份。",
      );
    const { data, error } = await supabase.rpc("save_workspace", {
      p_data: parsed.data.data,
      p_expected_revision: parsed.data.expectedRevision,
    });
    if (error?.code === "40001" || error?.code === "PT409")
      throw new ApiError(
        409,
        "REVISION_CONFLICT",
        "云端已有新版本。已保留本地修改，请先解决冲突。",
      );
    if (error?.code === "22023")
      throw new ApiError(400, "INVALID_WORKSPACE", "工作区格式或容量不符合云端要求。");
    if (error?.code === "55P03")
      throw new ApiError(
        503,
        "WORKSPACE_BUSY",
        "云端正在处理同一账号的资料，请稍后重新连接；本地修改仍然保留。",
      );
    if (error) throw error;
    return json({ revision: data });
  } catch (error) {
    return failure(error);
  }
}
