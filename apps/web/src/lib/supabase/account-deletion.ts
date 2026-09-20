import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import {
  accountDeletionPrepareSchema,
  type AccountDeletionConfirmation,
  type AccountDeletionPreparation,
} from "@/lib/account-deletion";
import { ApiError } from "./api";
import { getSupabaseConfig } from "./config";

export type AccountDeletionAdmin = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
};

type ConfirmedUser = { id: string; email?: string | null };

function unavailable() {
  return new ApiError(503, "ACCOUNT_DELETION_UNAVAILABLE", "账号注销服务暂不可用，请稍后重试。");
}

function confirmationFailed() {
  return new ApiError(
    401,
    "ACCOUNT_DELETION_CONFIRMATION_FAILED",
    "当前邮箱或密码不正确，请检查后重试。",
  );
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

/**
 * Re-check the current credential using an ephemeral, no-persistence public
 * client. It never shares or overwrites the request's cookie-backed session.
 */
export async function verifyAccountDeletionConfirmation(
  user: ConfirmedUser,
  confirmation: AccountDeletionConfirmation,
): Promise<void> {
  const config = getSupabaseConfig();
  const expectedEmail = user.email?.trim();
  if (!config || !expectedEmail) throw unavailable();
  if (normalizeEmail(confirmation.email) !== normalizeEmail(expectedEmail))
    throw confirmationFailed();

  const client = createSupabaseClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  try {
    const result = await client.auth.signInWithPassword({
      email: expectedEmail,
      password: confirmation.password,
    });
    if (result.error || !result.data.user) throw confirmationFailed();
    if (result.data.user.id !== user.id)
      throw new ApiError(
        409,
        "ACCOUNT_DELETION_SESSION_CHANGED",
        "当前账号已改变，请刷新后重新确认注销。",
      );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw confirmationFailed();
  }
}

/**
 * The service-role RPC owns the atomic transition: it blocks access, captures
 * the server-side object inventory, and queues deletion. The browser does not
 * provide an owner ID, Storage path, or object count.
 */
export async function prepareAccountDeletion(
  admin: AccountDeletionAdmin,
  ownerId: string,
): Promise<AccountDeletionPreparation> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownerId))
    throw unavailable();
  let result: { data: unknown; error: { code?: string; message?: string } | null };
  try {
    result = await admin.rpc("prepare_account_deletion", { p_owner_id: ownerId });
  } catch {
    throw unavailable();
  }
  if (result.error) {
    if (result.error.code === "40001" || result.error.code === "PT409")
      throw new ApiError(
        409,
        "ACCOUNT_DELETION_STATE_CHANGED",
        "账号状态已改变，请刷新后重新确认注销。",
      );
    throw unavailable();
  }
  const parsed = accountDeletionPrepareSchema.safeParse(result.data);
  if (!parsed.success) throw unavailable();
  return parsed.data;
}
