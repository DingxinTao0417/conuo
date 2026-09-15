import { describe, expect, it, vi } from "vitest";
import { runSourcePurgeCleanup } from "./source-purge-cleanup";

const ownerId = "86d5eaa8-3ab9-4d1b-bd73-210f353e8052";
const purgeId = "11111111-1111-4111-8111-111111111111";
const leaseToken = "22222222-2222-4222-8222-222222222222";
const path = `${ownerId}/version-1/source-a.pdf`;
const object = {
  purgeId,
  ownerId,
  storagePath: path,
  leaseToken,
  leaseUntil: "2026-09-13T03:00:00.000Z",
  attempt: 1,
};

function setup(
  options: {
    objectData?: unknown;
    removeError?: { statusCode?: number | string } | null;
    heartbeat?: unknown;
    completion?: unknown;
    failure?: unknown;
    rpcError?: { code?: string; message?: string } | null;
  } = {},
) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    void args;
    if (options.rpcError) return { data: null, error: options.rpcError };
    if (name === "claim_source_purge_objects")
      return { data: options.objectData ?? { objects: [object] }, error: null };
    if (name === "heartbeat_source_purge_object")
      return { data: options.heartbeat ?? { leaseUntil: "2026-09-13T03:02:00.000Z" }, error: null };
    if (name === "complete_source_purge_object")
      return {
        data: options.completion ?? {
          state: "completed",
          purgeState: "completed",
          completedAt: "2026-09-13T03:00:01.000Z",
        },
        error: null,
      };
    if (name === "fail_source_purge_object")
      return {
        data: options.failure ?? {
          state: "pending",
          purgeState: "processing",
          nextAttemptAt: "2026-09-13T03:01:00.000Z",
        },
        error: null,
      };
    throw new Error(`unexpected RPC ${name}`);
  });
  const remove = vi.fn().mockResolvedValue({ error: options.removeError ?? null });
  const from = vi.fn().mockReturnValue({ remove });
  return { rpc, remove, from, store: { rpc }, storage: { from } };
}

describe("source purge cleanup worker", () => {
  it("claims only a bounded canonical batch and confirms each physical Storage deletion", async () => {
    const fixture = setup();
    await expect(
      runSourcePurgeCleanup(fixture.store, fixture.storage, {
        workerId: "cleanup-worker",
        limit: 3,
        leaseSeconds: 120,
      }),
    ).resolves.toEqual({ claimed: 1, completed: 1, retried: 0, failed: 0, cancelled: false });
    expect(fixture.rpc).toHaveBeenNthCalledWith(1, "claim_source_purge_objects", {
      p_worker_id: "cleanup-worker",
      p_limit: 3,
      p_lease_seconds: 120,
    });
    expect(fixture.from).toHaveBeenCalledExactlyOnceWith("originals");
    expect(fixture.remove).toHaveBeenCalledExactlyOnceWith([path]);
    expect(fixture.rpc).toHaveBeenNthCalledWith(2, "heartbeat_source_purge_object", {
      p_purge_id: purgeId,
      p_storage_path: path,
      p_lease_token: leaseToken,
      p_lease_seconds: 120,
    });
    expect(fixture.rpc).toHaveBeenNthCalledWith(3, "complete_source_purge_object", {
      p_purge_id: purgeId,
      p_storage_path: path,
      p_lease_token: leaseToken,
    });
  });

  it("treats a missing canonical object as an idempotently completed cleanup", async () => {
    const fixture = setup({ removeError: { statusCode: 404 } });
    const result = await runSourcePurgeCleanup(fixture.store, fixture.storage, {
      workerId: "cleanup-worker",
      limit: 1,
      leaseSeconds: 120,
    });
    expect(result.completed).toBe(1);
    expect(fixture.rpc.mock.calls.map((call) => call[0])).toEqual([
      "claim_source_purge_objects",
      "heartbeat_source_purge_object",
      "complete_source_purge_object",
    ]);
  });

  it("records a retryable Storage failure without returning its provider error", async () => {
    const fixture = setup({ removeError: { statusCode: 503 } });
    await expect(
      runSourcePurgeCleanup(fixture.store, fixture.storage, {
        workerId: "cleanup-worker",
        limit: 1,
        leaseSeconds: 120,
      }),
    ).resolves.toMatchObject({ completed: 0, retried: 1, failed: 0 });
    expect(fixture.rpc).toHaveBeenLastCalledWith("fail_source_purge_object", {
      p_purge_id: purgeId,
      p_storage_path: path,
      p_lease_token: leaseToken,
      p_error_code: "STORAGE_DELETE_RETRYABLE",
      p_retryable: true,
    });
  });

  it("records a rejected canonical delete as terminal after SQL confirms it", async () => {
    const fixture = setup({
      removeError: { statusCode: 400 },
      failure: { state: "failed", purgeState: "failed", nextAttemptAt: null },
    });
    await expect(
      runSourcePurgeCleanup(fixture.store, fixture.storage, {
        workerId: "cleanup-worker",
        limit: 1,
        leaseSeconds: 120,
      }),
    ).resolves.toMatchObject({ retried: 0, failed: 1 });
    expect(fixture.rpc.mock.lastCall?.[1]).toMatchObject({
      p_error_code: "STORAGE_DELETE_REJECTED",
      p_retryable: false,
    });
  });

  it("never sends an unexpected claimed path to privileged Storage", async () => {
    const fixture = setup({
      objectData: { objects: [{ ...object, storagePath: `other/${path}` }] },
    });
    const error = await runSourcePurgeCleanup(fixture.store, fixture.storage, {
      workerId: "cleanup-worker",
      limit: 1,
      leaseSeconds: 120,
    }).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 503, code: "SOURCE_PURGE_CLEANUP_UNAVAILABLE" });
    expect(String(error)).not.toContain(path);
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it("does not delete from privileged Storage when the lease cannot be refreshed", async () => {
    const fixture = setup({ heartbeat: { leaseUntil: null } });
    const error = await runSourcePurgeCleanup(fixture.store, fixture.storage, {
      workerId: "cleanup-worker",
      limit: 1,
      leaseSeconds: 120,
    }).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 409, code: "SOURCE_PURGE_CLEANUP_STATE_CHANGED" });
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it("does not report a deletion as complete when the completion lease is no longer valid", async () => {
    const fixture = setup({ completion: { state: "pending", purgeState: "processing" } });
    const error = await runSourcePurgeCleanup(fixture.store, fixture.storage, {
      workerId: "cleanup-worker",
      limit: 1,
      leaseSeconds: 120,
    }).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 409, code: "SOURCE_PURGE_CLEANUP_STATE_CHANGED" });
    expect(fixture.remove).toHaveBeenCalledOnce();
  });

  it("does not claim work when the request was already cancelled", async () => {
    const fixture = setup();
    const controller = new AbortController();
    controller.abort();
    const error = await runSourcePurgeCleanup(fixture.store, fixture.storage, {
      workerId: "cleanup-worker",
      limit: 1,
      leaseSeconds: 120,
      signal: controller.signal,
    }).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 499, code: "REQUEST_CANCELLED" });
    expect(fixture.rpc).not.toHaveBeenCalled();
  });
});
