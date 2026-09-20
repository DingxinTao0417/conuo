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
    purgeId: z.uuid(),
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
const claimResult = z.object({ objects: z.array(claimedObject).max(5) }).strict();
const heartbeatResult = z.object({ leaseUntil: z.string().min(1).max(80) }).strict();
const completionResult = z
  .object({
    state: z.literal("completed"),
    purgeState: z.enum(["pending", "processing", "completed", "failed"]),
    completedAt: z.string().min(1).max(80),
  })
  .strict();
const failureResult = z
  .object({
    state: z.enum(["pending", "failed"]),
    purgeState: z.enum(["pending", "processing", "completed", "failed"]),
    nextAttemptAt: z.string().nullable(),
  })
  .strict();

export type SourcePurgeCleanupStore = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
};
export type SourcePurgeStorage = {
  from: (bucket: string) => {
    remove: (paths: string[]) => Promise<{ error: { statusCode?: number | string } | null }>;
  };
};
export type SourcePurgeCleanupInput = {
  workerId: string;
  limit: number;
  leaseSeconds: number;
  signal?: AbortSignal;
};
export type SourcePurgeCleanupSummary = {
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
  cancelled: boolean;
};

function unavailable() {
  return new ApiError(
    503,
    "SOURCE_PURGE_CLEANUP_UNAVAILABLE",
    "资料清理服务暂不可用，请稍后重试。",
  );
}

function stateChanged() {
  return new ApiError(
    409,
    "SOURCE_PURGE_CLEANUP_STATE_CHANGED",
    "资料清理状态已改变，请稍后重试。",
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
  store: SourcePurgeCleanupStore,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await store.rpc(name, args);
  if (result.error) {
    if (["40001", "PT409", "P0001"].includes(result.error.code || "")) throw stateChanged();
    throw unavailable();
  }
  return result.data;
}

async function heartbeatObject(
  store: SourcePurgeCleanupStore,
  object: z.infer<typeof claimedObject>,
  leaseSeconds: number,
) {
  const result = heartbeatResult.safeParse(
    await rpc(store, "heartbeat_source_purge_object", {
      p_purge_id: object.purgeId,
      p_storage_path: object.storagePath,
      p_lease_token: object.leaseToken,
      p_lease_seconds: leaseSeconds,
    }),
  );
  if (!result.success) throw stateChanged();
}

async function completeObject(
  store: SourcePurgeCleanupStore,
  object: z.infer<typeof claimedObject>,
) {
  const result = completionResult.safeParse(
    await rpc(store, "complete_source_purge_object", {
      p_purge_id: object.purgeId,
      p_storage_path: object.storagePath,
      p_lease_token: object.leaseToken,
    }),
  );
  if (!result.success) throw stateChanged();
}

async function failObject(
  store: SourcePurgeCleanupStore,
  object: z.infer<typeof claimedObject>,
  retryable: boolean,
) {
  const result = failureResult.safeParse(
    await rpc(store, "fail_source_purge_object", {
      p_purge_id: object.purgeId,
      p_storage_path: object.storagePath,
      p_lease_token: object.leaseToken,
      p_error_code: retryable ? "STORAGE_DELETE_RETRYABLE" : "STORAGE_DELETE_REJECTED",
      p_retryable: retryable,
    }),
  );
  if (!result.success) throw stateChanged();
  return result.data.state;
}

/**
 * Drains a very small, leased batch of canonical originals. Paths only ever originate
 * in the SQL outbox; callers cannot submit an account id, purge id, or Storage path.
 */
export async function runSourcePurgeCleanup(
  store: SourcePurgeCleanupStore,
  storage: SourcePurgeStorage,
  input: SourcePurgeCleanupInput,
): Promise<SourcePurgeCleanupSummary> {
  const settings = z
    .object({
      workerId,
      limit: z.number().int().min(1).max(5),
      leaseSeconds: z.number().int().min(30).max(180),
    })
    .strict()
    .safeParse({ workerId: input.workerId, limit: input.limit, leaseSeconds: input.leaseSeconds });
  if (!settings.success) throw unavailable();
  if (input.signal?.aborted) throw new ApiError(499, "REQUEST_CANCELLED", "资料清理任务已取消。");

  const claimed = claimResult.safeParse(
    await rpc(store, "claim_source_purge_objects", {
      p_worker_id: settings.data.workerId,
      p_limit: settings.data.limit,
      p_lease_seconds: settings.data.leaseSeconds,
    }),
  );
  if (!claimed.success) throw unavailable();

  const summary: SourcePurgeCleanupSummary = {
    claimed: claimed.data.objects.length,
    completed: 0,
    retried: 0,
    failed: 0,
    cancelled: false,
  };
  for (const object of claimed.data.objects) {
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
    if (state === "pending") summary.retried += 1;
    else summary.failed += 1;
  }
  return summary;
}
