import { z } from "zod";
import { ApiError } from "./api";
import { workspaceSchema } from "./validation";
import { sourcePurgeIdSchema } from "../source-purge-contract";

export const sourcePurgeResultSchema = z.object({
  revision: z.number().int().positive().safe(),
  data: workspaceSchema,
  purgeId: z.string().uuid(),
  cleanupPending: z.boolean(),
});

export function parseSourcePurgeId(value: unknown): string {
  const parsed = sourcePurgeIdSchema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(400, "INVALID_SOURCE", "资料标识格式无效。请刷新后重试。");
  return parsed.data;
}

export function assertSourcePurgeRequestActive(request: Request): void {
  if (request.signal.aborted)
    throw new ApiError(499, "REQUEST_CANCELLED", "删除范围核对已停止，请重新核对后再确认。");
}

export function sourcePurgeFailure(error: unknown): never {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  if (code === "40001")
    throw new ApiError(
      409,
      "PURGE_CONTEXT_CHANGED",
      "资料或回收站状态已改变，请重新查看影响范围。",
    );
  if (code === "P0001")
    throw new ApiError(
      409,
      "PURGE_BLOCKED",
      "这份资料仍有需要你处理的批注或手工关系，请先另存或明确删除这些内容。",
    );
  if (code === "22023")
    throw new ApiError(
      409,
      "PURGE_UNAVAILABLE",
      "这份资料或所选记录当前无法彻底删除，请重新核对关联范围。",
    );
  if (code === "PGRST202" || code === "42883")
    throw new ApiError(503, "PURGE_UNAVAILABLE", "删除选择服务尚未就绪，请完成数据库迁移。");
  throw error;
}
