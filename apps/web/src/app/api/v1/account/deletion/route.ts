import {
  accountDeletionConfirmationSchema,
  accountDeletionCountsSchema,
} from "@/lib/account-deletion";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  prepareAccountDeletion,
  verifyAccountDeletionConfirmation,
} from "@/lib/supabase/account-deletion";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function previewFailure(error: { code?: string } | null): never {
  if (error?.code === "40001")
    throw new ApiError(
      409,
      "ACCOUNT_DELETION_STATE_CHANGED",
      "账号状态已改变，请刷新后重新查看注销影响。",
    );
  throw new ApiError(503, "ACCOUNT_DELETION_UNAVAILABLE", "账号注销服务暂不可用，请稍后重试。");
}

/** Returns a counts-only snapshot, even when an earlier deletion request is pending. */
export async function GET(request: Request) {
  try {
    const { supabase, accountDeletion } = await requireUser(request, {
      allowAccountDeletion: true,
    });
    const { data, error } = await supabase.rpc("preview_account_deletion", {});
    if (error) previewFailure(error);
    const parsed = accountDeletionCountsSchema.safeParse(data);
    if (!parsed.success)
      throw new ApiError(
        503,
        "ACCOUNT_DELETION_UNAVAILABLE",
        "账号注销服务尚未就绪，请完成数据库迁移。",
      );
    return json({ ...parsed.data, allowed: accountDeletion.allowed });
  } catch (error) {
    return failure(error);
  }
}

/**
 * Confirmation happens in the current request before the service-role
 * transaction atomically blocks the account and captures its deletion work.
 */
export async function POST(request: Request) {
  try {
    const { user } = await requireUser(request, { allowAccountDeletion: true });
    const input = accountDeletionConfirmationSchema.safeParse(await readJson(request, 2048));
    if (!input.success)
      throw new ApiError(
        400,
        "INVALID_ACCOUNT_DELETION_CONFIRMATION",
        "请填写当前邮箱、密码，并输入 DELETE 后再确认注销。",
      );
    await verifyAccountDeletionConfirmation(user, input.data);
    const result = await prepareAccountDeletion(createAdminClient(), user.id);
    return json(result);
  } catch (error) {
    return failure(error);
  }
}
