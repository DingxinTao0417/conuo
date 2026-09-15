import "server-only";

import { z } from "zod";
import { ApiError } from "./api";

const workerId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const originalPath = z
  .string()
  .max(512)
  .regex(/^[0-9a-f-]{36}\/[a-zA-Z0-9_-]{1,100}\/[a-zA-Z0-9_-]{1,100}\.(pdf|docx|md|txt|html)$/);
const claimedObject = z
  .object({
    intentId: z.uuid(),
    ownerId: z.uuid(),
    storagePath: originalPath,
    leaseToken: z.uuid(),
    leaseUntil: z.string().min(1).max(80),
    attempt: z.number().int().min(1).max(5),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.storagePath.startsWith(`${value.ownerId}/`))
      context.addIssue({ code: "custom", message: "The canonical owner path does not match." });
  });
const claimResult = z.object({ intents: z.array(claimedObject).max(5) }).strict();
const heartbeatResult = z.object({ leaseUntil: z.string().min(1).max(80) }).strict();
const completionResult = z
  .object({
    state: z.literal("released"),
    releasedAt: z.string().min(1).max(80),
  })
  .strict();
const failureResult = z
  .object({
    state: z.enum(["cleanup_pending", "failed"]),
    nextAttemptAt: z.string().min(1).max(80).nullable(),
  })
  .strict();

export type OriginalUploadCleanupStore = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
};
export type OriginalUploadCleanupStorage = {
  from: (bucket: string) => {
    remove: (paths: string[]) => Promise<{ error: { statusCode?: number | string } | null }>;
  };
};
export type OriginalUploadCleanupInput = {
  workerId: string;
  limit: number;
  leaseSeconds: number;
  signal?: AbortSignal;
};
export type OriginalUploadCleanupSummary = {
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
  cancelled: boolean;
};

function unavailable() {
  return new ApiError(
    503,
    "ORIGINAL_UPLOAD_CLEANUP_UNAVAILABLE",
    "原件上传清理服务暂不可用，请稍后重试。",
  );
}

function stateChanged() {
  return new ApiError(
    409,
    "ORIGINAL_UPLOAD_CLEANUP_STATE_CHANGED",
    "原件上传清理状态已改变，请稍后重试。",
  );
}

function storageFailure(error: unknown) {
  const statusCode =
    error && typeof error === "object" && "statusCode" in error
      ? Number((error as { statusCode?: unknown }).statusCode)
      : Number.NaN;
  if (statusCode === 404) return { alreadyGone: true, retryable: false };
  if (statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500)
    return { alreadyGone: false, retryable: true };
  if (statusCode >= 400 && statusCode < 500) return { alreadyGone: false, retryable: false };
  return { alreadyGone: false, retryable: true };
}

async function rpc(
  store: OriginalUploadCleanupStore,
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
    if (["40001", "P0001"].includes(result.error.code || "")) throw stateChanged();
    throw unavailable();
  }
  return result.data;
}

async function heartbeatObject(
  store: OriginalUploadCleanupStore,
  object: z.infer<typeof claimedObject>,
  leaseSeconds: number,
) {
  const result = heartbeatResult.safeParse(
    await rpc(store, "heartbeat_original_upload_cleanup", {
      p_intent_id: object.intentId,
      p_lease_token: object.leaseToken,
      p_lease_seconds: leaseSeconds,
    }),
  );
  if (!result.success) throw stateChanged();
}

async function completeObject(
  store: OriginalUploadCleanupStore,
  object: z.infer<typeof claimedObject>,
) {
  const result = completionResult.safeParse(
    await rpc(store, "complete_original_upload_cleanup", {
      p_intent_id: object.intentId,
      p_lease_token: object.leaseToken,
    }),
  );
  if (!result.success) throw stateChanged();
}

async function failObject(
  store: OriginalUploadCleanupStore,
  object: z.infer<typeof claimedObject>,
  retryable: boolean,
) {
  const result = failureResult.safeParse(
    await rpc(store, "fail_original_upload_cleanup", {
      p_intent_id: object.intentId,
      p_lease_token: object.leaseToken,
      p_error_code: retryable ? "STORAGE_DELETE_RETRYABLE" : "STORAGE_DELETE_REJECTED",
      p_retryable: retryable,
    }),
  );
  if (!result.success) throw stateChanged();
  return result.data.state;
}

/**
 * Drains only SQL-leased, expired upload intents. The database is the sole
 * source of owner and canonical Storage path, so callers cannot direct this
 * privileged worker at another account's original.
 */
export async function runOriginalUploadCleanup(
  store: OriginalUploadCleanupStore,
  storage: OriginalUploadCleanupStorage,
  input: OriginalUploadCleanupInput,
): Promise<OriginalUploadCleanupSummary> {
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
    throw new ApiError(499, "REQUEST_CANCELLED", "原件上传清理任务已取消。");

  const claimed = claimResult.safeParse(
    await rpc(store, "claim_expired_original_upload_intents", {
      p_worker_id: settings.data.workerId,
      p_limit: settings.data.limit,
      p_lease_seconds: settings.data.leaseSeconds,
    }),
  );
  if (!claimed.success) throw unavailable();

  const summary: OriginalUploadCleanupSummary = {
    claimed: claimed.data.intents.length,
    completed: 0,
    retried: 0,
    failed: 0,
    cancelled: false,
  };
  for (const object of claimed.data.intents) {
    if (input.signal?.aborted) {
      summary.cancelled = true;
      break;
    }
    await heartbeatObject(store, object, settings.data.leaseSeconds);
    let deletionError: unknown;
    try {
      const result = await storage.from("originals").remove([object.storagePath]);
      deletionError = result.error;
    } catch (error) {
      deletionError = error;
    }
    const failure = deletionError ? storageFailure(deletionError) : undefined;
    if (!failure || failure.alreadyGone) {
      await completeObject(store, object);
      summary.completed += 1;
      continue;
    }
    const state = await failObject(store, object, failure.retryable);
    if (state === "cleanup_pending") summary.retried += 1;
    else summary.failed += 1;
  }
  return summary;
}
