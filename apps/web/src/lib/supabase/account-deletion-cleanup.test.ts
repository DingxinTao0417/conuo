import { describe, expect, it, vi } from "vitest";
import { runAccountDeletionCleanup } from "./account-deletion-cleanup";

const ownerId = "86d5eaa8-3ab9-4d1b-bd73-210f353e8052";
const deletionId = "11111111-1111-4111-8111-111111111111";
const leaseToken = "22222222-2222-4222-8222-222222222222";
const storagePath = `${ownerId}/version-1/source-a.pdf`;
const object = {
  deletionId,
  ownerId,
  bucketId: "originals",
  storagePath,
  leaseToken,
  leaseUntil: "2026-09-13T03:00:00.000Z",
  attempt: 1,
};
const authDeletion = {
  deletionId,
  ownerId,
  leaseToken,
  leaseUntil: "2026-09-13T03:00:00.000Z",
  attempt: 1,
};

function setup(
  options: {
    objectData?: unknown;
    authData?: unknown;
    storageError?: { statusCode?: number | string } | null;
    authError?: { status?: number | string } | null;
    objectHeartbeat?: unknown;
    objectCompletion?: unknown;
    objectFailure?: unknown;
    authHeartbeat?: unknown;
    authCompletion?: unknown;
    authFailure?: unknown;
    rpcError?: { code?: string; message?: string } | null;
  } = {},
) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    void args;
    if (options.rpcError) return { data: null, error: options.rpcError };
    if (name === "claim_account_deletion_objects")
      return { data: options.objectData ?? { objects: [object] }, error: null };
    if (name === "heartbeat_account_deletion_object")
      return {
        data: options.objectHeartbeat ?? { leaseUntil: "2026-09-13T03:02:00.000Z" },
        error: null,
      };
    if (name === "complete_account_deletion_object")
      return {
        data: options.objectCompletion ?? {
          state: "completed",
          deletionState: "ready_for_auth_deletion",
          completedAt: "2026-09-13T03:00:01.000Z",
        },
        error: null,
      };
    if (name === "fail_account_deletion_object")
      return {
        data: options.objectFailure ?? {
          state: "pending",
          deletionState: "storage_processing",
          nextAttemptAt: "2026-09-13T03:01:00.000Z",
        },
        error: null,
      };
    if (name === "claim_ready_account_auth_deletions")
      return { data: options.authData ?? { deletions: [authDeletion] }, error: null };
    if (name === "heartbeat_account_auth_deletion")
      return {
        data: options.authHeartbeat ?? { leaseUntil: "2026-09-13T03:02:00.000Z" },
        error: null,
      };
    if (name === "complete_account_auth_deletion")
      return {
        data: options.authCompletion ?? {
          state: "completed",
          completedAt: "2026-09-13T03:00:02.000Z",
          storageReopened: false,
        },
        error: null,
      };
    if (name === "fail_account_auth_deletion")
      return {
        data: options.authFailure ?? {
          state: "ready_for_auth_deletion",
          nextAttemptAt: "2026-09-13T03:01:00.000Z",
        },
        error: null,
      };
    throw new Error(`unexpected RPC ${name}`);
  });
  const remove = vi.fn().mockResolvedValue({ error: options.storageError ?? null });
  const from = vi.fn().mockReturnValue({ remove });
  const deleteUser = vi.fn().mockResolvedValue({ error: options.authError ?? null });
  return {
    rpc,
    remove,
    from,
    deleteUser,
    store: { rpc },
    storage: { from },
    auth: { admin: { deleteUser } },
  };
}

describe("account deletion cleanup worker", () => {
  it("drains only leased account objects, then removes Auth after SQL reports storage is ready", async () => {
    const fixture = setup();
    await expect(
      runAccountDeletionCleanup(fixture.store, fixture.storage, fixture.auth, {
        workerId: "account-cleanup",
        limit: 3,
        leaseSeconds: 120,
      }),
    ).resolves.toEqual({
      claimed: 1,
      completed: 1,
      retried: 0,
      failed: 0,
      authClaimed: 1,
      authCompleted: 1,
      authRetried: 0,
      authFailed: 0,
      storageReopened: 0,
      cancelled: false,
    });
    expect(fixture.rpc).toHaveBeenNthCalledWith(1, "claim_account_deletion_objects", {
      p_worker_id: "account-cleanup",
      p_limit: 3,
      p_lease_seconds: 120,
    });
    expect(fixture.rpc).toHaveBeenNthCalledWith(2, "heartbeat_account_deletion_object", {
      p_deletion_id: deletionId,
      p_bucket_id: "originals",
      p_storage_path: storagePath,
      p_lease_token: leaseToken,
      p_lease_seconds: 120,
    });
    expect(fixture.from).toHaveBeenCalledExactlyOnceWith("originals");
    expect(fixture.remove).toHaveBeenCalledExactlyOnceWith([storagePath]);
    expect(fixture.rpc).toHaveBeenNthCalledWith(3, "complete_account_deletion_object", {
      p_deletion_id: deletionId,
      p_bucket_id: "originals",
      p_storage_path: storagePath,
      p_lease_token: leaseToken,
    });
    expect(fixture.rpc).toHaveBeenNthCalledWith(4, "claim_ready_account_auth_deletions", {
      p_worker_id: "account-cleanup",
      p_limit: 1,
      p_lease_seconds: 60,
    });
    expect(fixture.rpc).toHaveBeenNthCalledWith(5, "heartbeat_account_auth_deletion", {
      p_deletion_id: deletionId,
      p_lease_token: leaseToken,
      p_lease_seconds: 60,
    });
    expect(fixture.deleteUser).toHaveBeenCalledExactlyOnceWith(ownerId);
    expect(fixture.rpc).toHaveBeenNthCalledWith(6, "complete_account_auth_deletion", {
      p_deletion_id: deletionId,
      p_lease_token: leaseToken,
    });
  });

  it("treats an already absent Storage object and an already absent Auth user as idempotent completion", async () => {
    const fixture = setup({ storageError: { statusCode: 404 }, authError: { status: 404 } });
    const result = await runAccountDeletionCleanup(fixture.store, fixture.storage, fixture.auth, {
      workerId: "account-cleanup",
      limit: 1,
      leaseSeconds: 120,
    });
    expect(result).toMatchObject({ completed: 1, authCompleted: 1, retried: 0, authRetried: 0 });
    expect(fixture.rpc.mock.calls.map((call) => call[0])).toEqual([
      "claim_account_deletion_objects",
      "heartbeat_account_deletion_object",
      "complete_account_deletion_object",
      "claim_ready_account_auth_deletions",
      "heartbeat_account_auth_deletion",
      "complete_account_auth_deletion",
    ]);
  });

  it("accepts a non-originals bucket only when its SQL-leased path stays below the same owner prefix", async () => {
    const fixture = setup({ objectData: { objects: [{ ...object, bucketId: "private-files" }] } });
    await runAccountDeletionCleanup(fixture.store, fixture.storage, fixture.auth, {
      workerId: "account-cleanup",
      limit: 1,
      leaseSeconds: 120,
    });
    expect(fixture.from).toHaveBeenCalledWith("private-files");
  });

  it("records retryable Storage failures without exposing the provider response", async () => {
    const fixture = setup({ storageError: { statusCode: 503 }, authData: { deletions: [] } });
    await expect(
      runAccountDeletionCleanup(fixture.store, fixture.storage, fixture.auth, {
        workerId: "account-cleanup",
        limit: 1,
        leaseSeconds: 120,
      }),
    ).resolves.toMatchObject({ completed: 0, retried: 1, failed: 0, authClaimed: 0 });
    expect(fixture.rpc).toHaveBeenCalledWith("fail_account_deletion_object", {
      p_deletion_id: deletionId,
      p_bucket_id: "originals",
      p_storage_path: storagePath,
      p_lease_token: leaseToken,
      p_error_code: "STORAGE_DELETE_RETRYABLE",
      p_retryable: true,
    });
  });

  it("never submits an unexpected account path to privileged Storage", async () => {
    const fixture = setup({
      objectData: { objects: [{ ...object, storagePath: `other-owner/${storagePath}` }] },
    });
    const error = await runAccountDeletionCleanup(fixture.store, fixture.storage, fixture.auth, {
      workerId: "account-cleanup",
      limit: 1,
      leaseSeconds: 120,
    }).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 503, code: "ACCOUNT_DELETION_CLEANUP_UNAVAILABLE" });
    expect(String(error)).not.toContain(storagePath);
    expect(fixture.remove).not.toHaveBeenCalled();
    expect(fixture.deleteUser).not.toHaveBeenCalled();
  });

  it("does not touch Storage or Auth when the object lease cannot be refreshed", async () => {
    const fixture = setup({ objectHeartbeat: { leaseUntil: null } });
    const error = await runAccountDeletionCleanup(fixture.store, fixture.storage, fixture.auth, {
      workerId: "account-cleanup",
      limit: 1,
      leaseSeconds: 120,
    }).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 409, code: "ACCOUNT_DELETION_CLEANUP_STATE_CHANGED" });
    expect(fixture.remove).not.toHaveBeenCalled();
    expect(fixture.deleteUser).not.toHaveBeenCalled();
  });

  it("records retryable Auth failures after a fresh auth lease, without reporting a completed deletion", async () => {
    const fixture = setup({ objectData: { objects: [] }, authError: { status: 503 } });
    const result = await runAccountDeletionCleanup(fixture.store, fixture.storage, fixture.auth, {
      workerId: "account-cleanup",
      limit: 1,
      leaseSeconds: 120,
    });
    expect(result).toMatchObject({
      authClaimed: 1,
      authCompleted: 0,
      authRetried: 1,
      authFailed: 0,
    });
    expect(fixture.rpc).toHaveBeenLastCalledWith("fail_account_auth_deletion", {
      p_deletion_id: deletionId,
      p_lease_token: leaseToken,
      p_error_code: "AUTH_DELETE_RETRYABLE",
      p_retryable: true,
    });
  });

  it("returns a reopened Storage queue to the worker instead of declaring the account completed", async () => {
    const fixture = setup({
      objectData: { objects: [] },
      authCompletion: { state: "storage_pending", completedAt: null, storageReopened: true },
    });
    const result = await runAccountDeletionCleanup(fixture.store, fixture.storage, fixture.auth, {
      workerId: "account-cleanup",
      limit: 1,
      leaseSeconds: 120,
    });
    expect(result).toMatchObject({ authClaimed: 1, authCompleted: 0, storageReopened: 1 });
    expect(fixture.deleteUser).toHaveBeenCalledExactlyOnceWith(ownerId);
    expect(fixture.rpc).toHaveBeenLastCalledWith("complete_account_auth_deletion", {
      p_deletion_id: deletionId,
      p_lease_token: leaseToken,
    });
  });

  it("does not claim work when cancellation preceded the worker request", async () => {
    const fixture = setup();
    const controller = new AbortController();
    controller.abort();
    const error = await runAccountDeletionCleanup(fixture.store, fixture.storage, fixture.auth, {
      workerId: "account-cleanup",
      limit: 1,
      leaseSeconds: 120,
      signal: controller.signal,
    }).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 499, code: "REQUEST_CANCELLED" });
    expect(fixture.rpc).not.toHaveBeenCalled();
  });
});
