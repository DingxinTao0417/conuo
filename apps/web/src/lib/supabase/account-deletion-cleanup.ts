import "server-only";

import { z } from "zod";
import { accountDeletionStateSchema } from "@/lib/account-deletion";
import { ApiError } from "./api";

const workerId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const bucketId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
const ownerId = z.uuid();
const path = z.string().min(1).max(1024);
const leaseToken = z.uuid();
const attempt = z.number().int().min(1).max(5);

function safeOwnerPath(value: string, owner: string) {
  if (!value.startsWith(`${owner}/`) || /[\u0000-\u001f\u007f\\]/.test(value)) return false;
  const segments = value.split("/");
  return (
    segments.length >= 2 &&
    segments.every((segment) => segment && segment !== "." && segment !== "..")
  );
}

const claimedObject = z
  .object({
    deletionId: z.uuid(),
    ownerId,
    bucketId,
    storagePath: path,
    leaseToken,
    leaseUntil: z.string().min(1).max(80),
    attempt,
  })
  .strict()
  .superRefine((value, context) => {
    if (!safeOwnerPath(value.storagePath, value.ownerId))
      context.addIssue({ code: "custom", message: "Unsafe account deletion Storage path." });
  });
const objectClaimResult = z.object({ objects: z.array(claimedObject).max(5) }).strict();
const heartbeatResult = z.object({ leaseUntil: z.string().min(1).max(80) }).strict();
const objectCompletionResult = z
  .object({
    state: z.literal("completed"),
    deletionState: accountDeletionStateSchema,
    completedAt: z.string().min(1).max(80),
  })
  .strict();
const objectFailureResult = z
  .object({
    state: z.enum(["pending", "failed"]),
    deletionState: accountDeletionStateSchema,
    nextAttemptAt: z.string().min(1).max(80).nullable(),
  })
  .strict();
const claimedAuthDeletion = z
  .object({
    deletionId: z.uuid(),
    ownerId,
    leaseToken,
    leaseUntil: z.string().min(1).max(80),
    attempt,
  })
  .strict();
const authClaimResult = z.object({ deletions: z.array(claimedAuthDeletion).max(1) }).strict();
const authCompletionResult = z.union([
  z
    .object({
      state: z.literal("completed"),
      completedAt: z.string().min(1).max(80).nullable().optional(),
      storageReopened: z.literal(false),
    })
    .strict(),
  // A final Storage scan can observe a late object after Auth deletion. SQL
  // re-opens the Storage queue; the next lease must drain it before the
  // already-absent Auth user is acknowledged as completed.
  z
    .object({
      state: z.literal("storage_pending"),
      completedAt: z.null().optional(),
      storageReopened: z.literal(true),
    })
    .strict(),
]);
const authFailureResult = z
  .object({
    state: z.enum(["ready_for_auth_deletion", "failed"]),
    nextAttemptAt: z.string().min(1).max(80).nullable(),
  })
  .strict();

export type AccountDeletionCleanupStore = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
};
export type AccountDeletionCleanupStorage = {
  from: (bucket: string) => {
    remove: (paths: string[]) => Promise<{ error: { statusCode?: number | string } | null }>;
  };
};
export type AccountDeletionCleanupAuth = {
  admin: {
    deleteUser: (id: string) => Promise<{ error: { status?: number | string } | null }>;
  };
};
export type AccountDeletionCleanupInput = {
  workerId: string;
  limit: number;
  leaseSeconds: number;
  signal?: AbortSignal;
};
export type AccountDeletionCleanupSummary = {
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
  authClaimed: number;
  authCompleted: number;
  authRetried: number;
  authFailed: number;
  storageReopened: number;
  cancelled: boolean;
};

function unavailable() {
  return new ApiError(
    503,
    "ACCOUNT_DELETION_CLEANUP_UNAVAILABLE",
    "账号注销清理服务暂不可用，请稍后重试。",
  );
}

function stateChanged() {
  return new ApiError(
    409,
    "ACCOUNT_DELETION_CLEANUP_STATE_CHANGED",
    "账号注销清理状态已改变，请稍后重试。",
  );
}

function providerFailure(error: unknown) {
  const status =
    error && typeof error === "object" && "statusCode" in error
      ? Number((error as { statusCode?: unknown }).statusCode)
      : error && typeof error === "object" && "status" in error
        ? Number((error as { status?: unknown }).status)
        : Number.NaN;
  if (status === 404) return { alreadyGone: true, retryable: false };
  if (status === 408 || status === 425 || status === 429 || status >= 500)
    return { alreadyGone: false, retryable: true };
  if (status >= 400 && status < 500) return { alreadyGone: false, retryable: false };
  return { alreadyGone: false, retryable: true };
}

async function rpc(
  store: AccountDeletionCleanupStore,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  let result: { data: unknown; error: { code?: string; message?: string } | null };
  try {
    result = await store.rpc(name, args);
  } catch {
    throw unavailable();
  }
  if (result.error) {
    if (["40001", "PT409", "P0001"].includes(result.error.code || "")) throw stateChanged();
    throw unavailable();
  }
  return result.data;
}

async function heartbeatObject(
  store: AccountDeletionCleanupStore,
  object: z.infer<typeof claimedObject>,
  leaseSeconds: number,
) {
  const result = heartbeatResult.safeParse(
    await rpc(store, "heartbeat_account_deletion_object", {
      p_deletion_id: object.deletionId,
      p_bucket_id: object.bucketId,
      p_storage_path: object.storagePath,
      p_lease_token: object.leaseToken,
      p_lease_seconds: leaseSeconds,
    }),
  );
  if (!result.success) throw stateChanged();
}

async function completeObject(
  store: AccountDeletionCleanupStore,
  object: z.infer<typeof claimedObject>,
) {
  const result = objectCompletionResult.safeParse(
    await rpc(store, "complete_account_deletion_object", {
      p_deletion_id: object.deletionId,
      p_bucket_id: object.bucketId,
      p_storage_path: object.storagePath,
      p_lease_token: object.leaseToken,
    }),
  );
  if (!result.success) throw stateChanged();
}

async function failObject(
  store: AccountDeletionCleanupStore,
  object: z.infer<typeof claimedObject>,
  retryable: boolean,
) {
  const result = objectFailureResult.safeParse(
    await rpc(store, "fail_account_deletion_object", {
      p_deletion_id: object.deletionId,
      p_bucket_id: object.bucketId,
      p_storage_path: object.storagePath,
      p_lease_token: object.leaseToken,
      p_error_code: retryable ? "STORAGE_DELETE_RETRYABLE" : "STORAGE_DELETE_REJECTED",
      p_retryable: retryable,
    }),
  );
  if (!result.success) throw stateChanged();
  return result.data.state;
}

async function heartbeatAuth(
  store: AccountDeletionCleanupStore,
  deletion: z.infer<typeof claimedAuthDeletion>,
) {
  const result = heartbeatResult.safeParse(
    await rpc(store, "heartbeat_account_auth_deletion", {
      p_deletion_id: deletion.deletionId,
      p_lease_token: deletion.leaseToken,
      p_lease_seconds: 60,
    }),
  );
  if (!result.success) throw stateChanged();
}

async function completeAuth(
  store: AccountDeletionCleanupStore,
  deletion: z.infer<typeof claimedAuthDeletion>,
) {
  const result = authCompletionResult.safeParse(
    await rpc(store, "complete_account_auth_deletion", {
      p_deletion_id: deletion.deletionId,
      p_lease_token: deletion.leaseToken,
    }),
  );
  if (!result.success) throw stateChanged();
  return result.data;
}

async function failAuth(
  store: AccountDeletionCleanupStore,
  deletion: z.infer<typeof claimedAuthDeletion>,
  retryable: boolean,
) {
  const result = authFailureResult.safeParse(
    await rpc(store, "fail_account_auth_deletion", {
      p_deletion_id: deletion.deletionId,
      p_lease_token: deletion.leaseToken,
      p_error_code: retryable ? "AUTH_DELETE_RETRYABLE" : "AUTH_DELETE_REJECTED",
      p_retryable: retryable,
    }),
  );
  if (!result.success) throw stateChanged();
  return result.data.state;
}

/**
 * Drains only SQL-leased objects. The account deletion transaction owns both
 * access blocking and inventory capture; no caller can select an account,
 * bucket, or path for this privileged worker.
 */
export async function runAccountDeletionCleanup(
  store: AccountDeletionCleanupStore,
  storage: AccountDeletionCleanupStorage,
  auth: AccountDeletionCleanupAuth,
  input: AccountDeletionCleanupInput,
): Promise<AccountDeletionCleanupSummary> {
  const settings = z
    .object({
      workerId,
      limit: z.number().int().min(1).max(5),
      leaseSeconds: z.number().int().min(30).max(180),
    })
    .strict()
    .safeParse({ workerId: input.workerId, limit: input.limit, leaseSeconds: input.leaseSeconds });
  if (!settings.success) throw unavailable();
  if (input.signal?.aborted)
    throw new ApiError(499, "REQUEST_CANCELLED", "账号注销清理任务已取消。");

  const claimed = objectClaimResult.safeParse(
    await rpc(store, "claim_account_deletion_objects", {
      p_worker_id: settings.data.workerId,
      p_limit: settings.data.limit,
      p_lease_seconds: settings.data.leaseSeconds,
    }),
  );
  if (!claimed.success) throw unavailable();

  const summary: AccountDeletionCleanupSummary = {
    claimed: claimed.data.objects.length,
    completed: 0,
    retried: 0,
    failed: 0,
    authClaimed: 0,
    authCompleted: 0,
    authRetried: 0,
    authFailed: 0,
    storageReopened: 0,
    cancelled: false,
  };
  for (const object of claimed.data.objects) {
    if (input.signal?.aborted) {
      summary.cancelled = true;
      return summary;
    }
    await heartbeatObject(store, object, settings.data.leaseSeconds);
    let deletionError: unknown;
    try {
      deletionError = (await storage.from(object.bucketId).remove([object.storagePath])).error;
    } catch (error) {
      deletionError = error;
    }
    const failure = deletionError ? providerFailure(deletionError) : undefined;
    if (!failure || failure.alreadyGone) {
      await completeObject(store, object);
      summary.completed += 1;
      continue;
    }
    const state = await failObject(store, object, failure.retryable);
    if (state === "pending") summary.retried += 1;
    else summary.failed += 1;
  }

  if (input.signal?.aborted) {
    summary.cancelled = true;
    return summary;
  }
  const authClaim = authClaimResult.safeParse(
    await rpc(store, "claim_ready_account_auth_deletions", {
      p_worker_id: settings.data.workerId,
      p_limit: 1,
      p_lease_seconds: 60,
    }),
  );
  if (!authClaim.success) throw unavailable();
  summary.authClaimed = authClaim.data.deletions.length;
  for (const deletion of authClaim.data.deletions) {
    if (input.signal?.aborted) {
      summary.cancelled = true;
      return summary;
    }
    await heartbeatAuth(store, deletion);
    let deletionError: unknown;
    try {
      deletionError = (await auth.admin.deleteUser(deletion.ownerId)).error;
    } catch (error) {
      deletionError = error;
    }
    const failure = deletionError ? providerFailure(deletionError) : undefined;
    if (!failure || failure.alreadyGone) {
      const completion = await completeAuth(store, deletion);
      if (completion.state === "completed") summary.authCompleted += 1;
      else summary.storageReopened += 1;
      continue;
    }
    const state = await failAuth(store, deletion, failure.retryable);
    if (state === "ready_for_auth_deletion") summary.authRetried += 1;
    else summary.authFailed += 1;
  }
  return summary;
}
