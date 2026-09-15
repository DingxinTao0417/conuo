import { ApiError } from "@/lib/supabase/api";

type OrganizationJobAction = "enqueue" | "cancel" | "reconcile";

export function organizationJobsUnavailable(
  message = "后台整理服务暂不可用，请稍后重试。",
): ApiError {
  return new ApiError(503, "ORGANIZATION_JOBS_UNAVAILABLE", message);
}

/**
 * Keep PostgreSQL details out of the browser while preserving the retry
 * distinction callers need: stale context, invalid request, or a short-lived
 * owner write lock.
 */
export function organizationJobRpcFailure(error: unknown, action: OrganizationJobAction): never {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  if (code === "40001")
    throw new ApiError(
      409,
      "ORGANIZATION_JOB_CONTEXT_CHANGED",
      action === "reconcile"
        ? "云端资料或后台整理状态已改变，请刷新后重试。"
        : "资料、任务或云端版本已改变，请刷新后重试。",
    );
  if (code === "22023")
    throw new ApiError(
      400,
      "INVALID_ORGANIZATION_JOB",
      action === "enqueue"
        ? "后台整理的资料范围或版本已不可用，请刷新后重新发起。"
        : "后台整理任务请求格式无效，请刷新后重试。",
    );
  if (code === "55P03")
    throw new ApiError(503, "ORGANIZATION_JOB_BUSY", "云端正在处理同一账号的资料，请稍后重试。");
  throw organizationJobsUnavailable();
}
