import { z } from "zod";
import { ApiError } from "@/lib/supabase/api";

const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const paramsSchema = z.object({ sourceId: idSchema, versionId: idSchema });

export async function inkTarget(
  context: { params: Promise<{ sourceId: string; versionId: string }> },
) {
  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success)
    throw new ApiError(400, "INVALID_SOURCE_VERSION", "资料或版本标识格式无效，请刷新后重试。");
  return parsed.data;
}

export function inkFailure(error: { code?: string; message?: string } | null): never {
  if (error?.code === "40001" || error?.code === "PT409")
    throw new ApiError(409, "INK_PAGE_CONFLICT", "这页在其他设备上已有新笔迹，请刷新后重试。");
  if (error?.code === "42501")
    throw new ApiError(401, "UNAUTHENTICATED", "登录已失效，请重新登录后同步笔迹。");
  if (error?.code === "22023")
    throw new ApiError(409, "INK_UNAVAILABLE", "资料版本或笔迹格式已改变，请重新打开资料。");
  throw new ApiError(503, "INK_UNAVAILABLE", "笔迹云端服务尚未就绪，请保留本机笔迹后重试。");
}
