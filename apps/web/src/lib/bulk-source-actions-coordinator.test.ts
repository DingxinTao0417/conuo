import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceCoordinator, type WorkspaceIO } from "./use-workspace";
import { createDemoWorkspace } from "./seed";
import { chunkText } from "./import";
import { advanceImportJob, createImportJob, startImportJob } from "./import-queue";
import { addSourcesToLearningSpaces } from "./source-space-association";
import { recycleSourcesWithResult } from "./space-lifecycle";
import {
  applyBulkSourceAction,
  confirmBulkSourceAction,
  snapshotRetryBulkSourceAction,
  retryBulkSourceAction,
  type BulkSourceActionRequest,
  type BulkSourceActionResult,
} from "./bulk-source-actions";
import { workspaceSchema } from "./supabase/validation";
import type { WorkspaceData } from "./types";

vi.mock("./cloud", () => ({
  askCloud: vi.fn(),
  cancelOrganizationJob: vi.fn(),
  cancelImportParse: vi.fn(),
  claimImportParse: vi.fn(),
  enqueueOrganizationJob: vi.fn(),
  finishImportParse: vi.fn(),
  heartbeatImportParse: vi.fn(),
  releaseImportParse: vi.fn(),
  retryImportParse: vi.fn(),
  organizeCloud: vi.fn(),
  getModelStatus: vi.fn(),
  downloadSourceBlob: vi.fn(),
  isCloudConfigured: () => false,
  loadCloudWorkspace: vi.fn(),
  previewSourcePurge: vi.fn(),
  requestSourcePurge: vi.fn(),
  previewSourceVersionPurge: vi.fn(),
  requestSourceVersionPurge: vi.fn(),
  reconcileOrganizationJobs: vi.fn(),
  saveCloudWorkspace: vi.fn(),
  subscribeSession: vi.fn(),
  uploadSourceBlob: vi.fn(),
}));

const accountA = { id: "bulk-owner-a", email: "a@example.com" };
const accountB = { id: "bulk-owner-b", email: "b@example.com" };
const at = "2026-09-15T10:00:00.000Z";
type Kind = "associate" | "recycle";
const coordinators: WorkspaceCoordinator[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(protectedParse = false) {
  const data = createDemoWorkspace();
  data.spaces.push({ ...data.spaces[0], id: crypto.randomUUID(), name: "批量关联目标" });
  const extra = {
    ...structuredClone(data.sources[0]),
    id: crypto.randomUUID(),
    versionId: crypto.randomUUID(),
    title: "保留的未选资料",
  };
  extra.chunks = chunkText(extra.text, extra.id, extra.versionId);
  data.sources.push(extra);
  if (protectedParse) {
    const source = data.sources[0];
    source.status = "parsing";
    source.storagePath = `${accountA.id}/originals/held.txt`;
    data.importJobs = [
      advanceImportJob(
        startImportJob(
          createImportJob({
            sourceId: source.id,
            versionId: source.versionId,
            filename: source.filename,
            spaceId: source.spaceIds[0],
            at,
          }),
          at,
        ),
        "parsing",
        at,
      ),
    ];
  }
  expect(workspaceSchema.safeParse(data).success).toBe(true);
  return data;
}
async function setup(protectedParse = false) {
  const data = fixture(protectedParse),
    b = fixture();
  b.spaces[0].name = "账号 B 的独立空间";
  const stored = (value: WorkspaceData) => ({
    ...structuredClone(value),
    _conuoSync: { revision: 1, dirty: false },
  });
  const disk = new Map<string, WorkspaceData>([
    [accountA.id, stored(data)],
    [accountB.id, stored(b)],
  ]);
  const remote = new Map<string, { data: WorkspaceData; revision: number }>([
    [accountA.id, { data: structuredClone(data), revision: 1 }],
    [accountB.id, { data: structuredClone(b), revision: 1 }],
  ]);
  const io: WorkspaceIO = {
    loadLocal: vi.fn(async (id = "local") => structuredClone(disk.get(id) ?? null)),
    saveLocal: vi.fn(async (value, id = "local") => {
      disk.set(id, structuredClone(value));
    }),
    loadCloud: vi.fn(async (id) => structuredClone(remote.get(id) ?? { data: null, revision: 0 })),
    saveCloud: vi.fn(async (value, revision, id) => {
      if ((remote.get(id)?.revision ?? 0) !== revision) throw new Error("409 conflict");
      remote.set(id, { data: structuredClone(value), revision: revision + 1 });
      return { revision: revision + 1 };
    }),
    getBlob: vi.fn(async () => undefined),
    uploadBlob: vi.fn(async () => "unused"),
    downloadBlob: vi.fn(async () => undefined),
    askCloud: vi.fn(async () => {
      throw new Error("Unexpected model request");
    }),
    organizeCloud: vi.fn(async () => {
      throw new Error("Unexpected model request");
    }),
    getModelStatus: vi.fn(async () => ({ mode: "extractive", message: "本机受控测试" })),
    readLegacyMeta: vi.fn(() => null),
  };
  if (protectedParse) {
    io.claimImportParse = vi.fn(async () => ({
      status: "held" as const,
      leaseUntil: new Date(Date.now() + 120_000).toISOString(),
    }));
    io.heartbeatImportParse = vi.fn(async () => {
      throw new Error("Lease not owned");
    });
    io.releaseImportParse = vi.fn(async () => {});
    io.finishImportParse = vi.fn(async () => {
      throw new Error("Lease not owned");
    });
  }
  const coordinator = new WorkspaceCoordinator(io);
  coordinators.push(coordinator);
  await coordinator.activate(accountA);
  if (protectedParse) await vi.waitFor(() => expect(io.claimImportParse).toHaveBeenCalledOnce());
  vi.mocked(io.saveLocal).mockClear();
  vi.mocked(io.saveCloud).mockClear();
  return { coordinator, io, disk, remote, data, token: coordinator.getSnapshot().token };
}
function legacyAction(
  data: WorkspaceData,
  kind: Kind,
  ids = data.sources.slice(0, 2).map((s) => s.id),
) {
  return kind === "associate"
    ? addSourcesToLearningSpaces(data, ids, [data.spaces[1].id], at)
    : recycleSourcesWithResult(data, ids, at);
}
async function persistAction(
  coordinator: WorkspaceCoordinator,
  kind: Kind,
  token: number,
  ids?: string[],
  onProvisional?: (result: BulkSourceActionResult) => void,
) {
  const context = coordinator.getSnapshot();
  const expectedUserId = context.user?.id ?? null;
  const before = coordinator.readCurrentData(token, expectedUserId, context.localCacheMode);
  const sourceIds = ids ?? before.sources.slice(0, 2).map((s) => s.id);
  const request: BulkSourceActionRequest =
    kind === "associate"
      ? { kind, sourceIds, spaceIds: [before.spaces[1].id] }
      : { kind, sourceIds };
  let result: BulkSourceActionResult | undefined;
  const applied = await coordinator.updateDurably((current) => {
    const next = applyBulkSourceAction(current, request, at);
    result = next.result;
    onProvisional?.(result);
    return next.data === current ? { ...current } : next.data;
  }, token);
  if (!applied || !result) throw new Error("Bulk mutation not accepted");
  return confirmBulkSourceAction(
    coordinator.readCurrentData(token, expectedUserId, context.localCacheMode),
    result,
  );
}
function assertApplied(data: WorkspaceData, kind: Kind, ids: string[], targetSpaceId: string) {
  for (const id of ids) {
    const source = data.sources.find((s) => s.id === id)!;
    if (kind === "associate") expect(source.spaceIds).toContain(targetSpaceId);
    else expect(source.deletedAt).toBe(at);
  }
}
afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.dispose();
  vi.restoreAllMocks();
});

describe("bulk receipt current-data identity barrier", () => {
  it("returns the current visible snapshot only for matching ready actor, token and cache mode", async () => {
    const { coordinator, token } = await setup();
    expect(coordinator.readCurrentData(token, accountA.id, "normal")).toBe(
      coordinator.getSnapshot().data,
    );
    expect(() => coordinator.readCurrentData(token - 1, accountA.id, "normal")).toThrow();
    expect(() => coordinator.readCurrentData(token, accountB.id, "normal")).toThrow();
    expect(() => coordinator.readCurrentData(token, null, "normal")).toThrow();
    expect(() => coordinator.readCurrentData(token, accountA.id, "cloud-readonly")).toThrow();
  });

  it("rejects an unactivated snapshot even when its identity fields match", async () => {
    const { io } = await setup();
    const notReady = new WorkspaceCoordinator(io);
    coordinators.push(notReady);
    const snapshot = notReady.getSnapshot();
    expect(snapshot.ready).toBe(false);
    expect(() =>
      notReady.readCurrentData(snapshot.token, snapshot.user?.id ?? null, snapshot.localCacheMode),
    ).toThrow();
  });

  it("rejects both the old actor getter and the new matching getter while owner hydration is pending", async () => {
    const { coordinator, io, disk, token } = await setup(),
      hydration = deferred<void>();
    vi.mocked(io.loadLocal).mockImplementationOnce(async (id = "local") => {
      await hydration.promise;
      return structuredClone(disk.get(id) ?? null);
    });
    const activation = coordinator.activate(accountB);
    await vi.waitFor(() => expect(coordinator.getSnapshot().user?.id).toBe(accountB.id));
    const loading = coordinator.getSnapshot();
    expect(loading.ready).toBe(false);
    expect(() => coordinator.readCurrentData(token, accountA.id, "normal")).toThrow();
    expect(() =>
      coordinator.readCurrentData(loading.token, accountB.id, loading.localCacheMode),
    ).toThrow();
    hydration.resolve();
    await activation;
    expect(coordinator.readCurrentData(loading.token, accountB.id, "normal")).toBe(
      coordinator.getSnapshot().data,
    );
    expect(() => coordinator.readCurrentData(token, accountA.id, "normal")).toThrow();
  });

  it("does not let a getter captured for normal cache confirm a cloud-readonly snapshot", async () => {
    const { io } = await setup();
    vi.mocked(io.loadLocal).mockRejectedValueOnce(new Error("IndexedDB cannot be read"));
    const readonly = new WorkspaceCoordinator(io);
    coordinators.push(readonly);
    await readonly.activate(accountA);
    const view = readonly.getSnapshot();
    expect(view.ready).toBe(true);
    expect(view.localCacheMode).toBe("cloud-readonly");
    expect(() => readonly.readCurrentData(view.token, accountA.id, "normal")).toThrow();
    expect(readonly.readCurrentData(view.token, accountA.id, "cloud-readonly")).toBe(view.data);
  });
});

describe.each<Kind>(["associate", "recycle"])("bulk %s real coordinator persistence", (kind) => {
  it("publishes memory before local ACK, preserves unselected sources and can reload the acknowledged snapshot", async () => {
    const { coordinator, io, disk, data, token } = await setup(),
      local = deferred<void>();
    const ids = data.sources.slice(0, 2).map((s) => s.id),
      target = data.spaces[1].id;
    const before = structuredClone(coordinator.getSnapshot().data);
    vi.mocked(io.saveLocal).mockImplementationOnce(async (value, id = "local") => {
      await local.promise;
      disk.set(id, structuredClone(value));
    });
    let settled = false;
    const pending = persistAction(coordinator, kind, token).then((result) => {
      settled = true;
      return result;
    });
    void pending.catch(() => {});
    await vi.waitFor(() => expect(io.saveLocal).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    assertApplied(coordinator.getSnapshot().data, kind, ids, target);
    expect(disk.get(accountA.id)?.sources).toEqual(before.sources);
    expect(coordinator.getSnapshot().data.sources[2]).toEqual(before.sources[2]);
    expect(io.saveCloud).not.toHaveBeenCalled();
    local.resolve();
    const result = await pending;
    expect(result.acceptedSourceIds).toEqual(ids);
    expect(result.failedSourceIds).toEqual([]);
    assertApplied(disk.get(accountA.id)!, kind, ids, target);
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
    const reloaded = new WorkspaceCoordinator(io);
    coordinators.push(reloaded);
    await reloaded.activate(accountA);
    assertApplied(reloaded.getSnapshot().data, kind, ids, target);
    expect(reloaded.getSnapshot().data.sources[2]).toEqual(before.sources[2]);
    expect(workspaceSchema.safeParse(reloaded.getSnapshot().data).success).toBe(true);
    expect(io.askCloud).not.toHaveBeenCalled();
    expect(io.organizeCloud).not.toHaveBeenCalled();
  });

  it("retains failed-save memory and shallow retry writes the newest snapshot without repeating the action", async () => {
    const { coordinator, io, disk, data, token } = await setup();
    const ids = data.sources.slice(0, 2).map((s) => s.id),
      target = data.spaces[1].id;
    let provisional!: BulkSourceActionResult;
    vi.mocked(io.saveLocal)
      .mockRejectedValueOnce(new Error("IndexedDB quota reached"))
      .mockRejectedValueOnce(new Error("IndexedDB still unavailable"));
    await expect(
      persistAction(coordinator, kind, token, undefined, (result) => {
        provisional = result;
      }),
    ).rejects.toThrow("尚未保存到此浏览器");
    assertApplied(coordinator.getSnapshot().data, kind, ids, target);
    expect(coordinator.getSnapshot().status).toBe("error");
    expect(coordinator.hasUnsavedLocalChanges()).toBe(true);
    expect(disk.get(accountA.id)?.sources).toEqual(data.sources);
    expect(io.saveCloud).not.toHaveBeenCalled();
    const edited = "失败后最新的独立编辑";
    await expect(
      coordinator.updateDurably(
        (current) => ({
          ...current,
          spaces: current.spaces.map((space, index) =>
            index === 0 ? { ...space, goal: edited } : space,
          ),
        }),
        token,
      ),
    ).rejects.toThrow("尚未保存到此浏览器");
    const confirmed = structuredClone(coordinator.getSnapshot().data.sources);
    expect(disk.get(accountA.id)?.sources).toEqual(data.sources);
    let retried!: BulkSourceActionResult;
    await coordinator.updateDurably((current) => {
      const next = snapshotRetryBulkSourceAction(current, provisional);
      retried = next.result;
      expect(next.data).not.toBe(current);
      expect(next.data.sources).toBe(current.sources);
      return next.data;
    }, token);
    const result = confirmBulkSourceAction(coordinator.getSnapshot().data, retried);
    expect(result.acceptedSourceIds).toEqual(ids);
    expect(result.at).toBe(provisional.at);
    expect(result.items).toEqual(provisional.items);
    if (kind === "associate") expect(result.addedSourceIds).toEqual(ids);
    else expect(result.recycledSourceIds).toEqual(ids);
    expect(disk.get(accountA.id)?.sources).toEqual(confirmed);
    expect(disk.get(accountA.id)?.spaces[0].goal).toBe(edited);
    assertApplied(disk.get(accountA.id)!, kind, ids, target);
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
  });

  it("full noop still waits for a snapshot save instead of claiming an unwritten success", async () => {
    const { coordinator, io, disk, data, token } = await setup();
    await persistAction(coordinator, kind, token);
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
    const before = structuredClone(coordinator.getSnapshot().data),
      local = deferred<void>();
    vi.mocked(io.saveLocal).mockClear();
    vi.mocked(io.saveLocal).mockImplementationOnce(async (value, id = "local") => {
      await local.promise;
      disk.set(id, structuredClone(value));
    });
    let settled = false;
    const pending = persistAction(coordinator, kind, token).then((result) => {
      settled = true;
      return result;
    });
    void pending.catch(() => {});
    await vi.waitFor(() => expect(io.saveLocal).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(coordinator.getSnapshot().data.sources).toEqual(before.sources);
    local.resolve();
    const result = await pending;
    expect(result.acceptedSourceIds).toEqual([]);
    expect(result.noopSourceIds).toEqual(data.sources.slice(0, 2).map((s) => s.id));
    expect(disk.get(accountA.id)?.sources).toEqual(before.sources);
    assertApplied(
      disk.get(accountA.id)!,
      kind,
      data.sources.slice(0, 2).map((s) => s.id),
      data.spaces[1].id,
    );
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
  });

  it("local ACK resolves while the independent cloud pump is still pending", async () => {
    const { coordinator, io, disk, data, token } = await setup(),
      cloud = deferred<{ revision: number }>();
    vi.mocked(io.saveCloud).mockReturnValueOnce(cloud.promise);
    await persistAction(coordinator, kind, token);
    assertApplied(
      disk.get(accountA.id)!,
      kind,
      data.sources.slice(0, 2).map((s) => s.id),
      data.spaces[1].id,
    );
    await vi.waitFor(() => expect(io.saveCloud).toHaveBeenCalledOnce());
    expect(coordinator.getSnapshot().status).toBe("saving");
    cloud.resolve({ revision: 2 });
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
  });

  it("a held parser rejects the legacy whole batch but the new whole selection saves safe items and reports only the protected item failed", async () => {
    const { coordinator, io, disk, data, token } = await setup(true);
    const before = structuredClone(coordinator.getSnapshot().data);
    expect(
      await coordinator.updateDurably((current) => legacyAction(current, kind).data, token),
    ).toBe(false);
    expect(io.saveLocal).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().data.sources).toEqual(before.sources);
    expect(coordinator.getSnapshot().error).toContain("正在解析");
    const safeId = data.sources[1].id;
    const result = await persistAction(coordinator, kind, token);
    expect(result.selectedCount).toBe(2);
    expect(result.acceptedSourceIds).toEqual([safeId]);
    expect(result.failedSourceIds).toEqual([data.sources[0].id]);
    expect(result.items.find((item) => item.sourceId === data.sources[0].id)?.reason).toContain(
      "解析",
    );
    assertApplied(disk.get(accountA.id)!, kind, [safeId], data.spaces[1].id);
    expect(disk.get(accountA.id)?.sources[0]).toEqual(before.sources[0]);
    expect(disk.get(accountA.id)?.importJobs).toEqual(before.importJobs);
    expect(io.downloadBlob).not.toHaveBeenCalled();
    expect(io.finishImportParse).not.toHaveBeenCalled();
    expect(io.releaseImportParse).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
  });

  it("retries only a formerly missing item and keeps the first real success unchanged", async () => {
    const { coordinator, disk, data, token } = await setup();
    const firstId = data.sources[0].id,
      missingId = crypto.randomUUID();
    const first = await persistAction(coordinator, kind, token, [firstId, missingId]);
    expect(first.acceptedSourceIds).toEqual([firstId]);
    expect(first.failedSourceIds).toEqual([missingId]);
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
    const firstSource = structuredClone(coordinator.getSnapshot().data.sources[0]);
    const restored = {
      ...structuredClone(data.sources[1]),
      id: missingId,
      versionId: crypto.randomUUID(),
    };
    restored.chunks = chunkText(restored.text, restored.id, restored.versionId);
    await coordinator.updateDurably(
      (current) => ({ ...current, sources: [...current.sources, restored] }),
      token,
    );
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
    const retryAt = "2026-09-15T11:00:00.000Z";
    let provisional!: BulkSourceActionResult;
    await coordinator.updateDurably((current) => {
      const next = retryBulkSourceAction(current, first, retryAt);
      provisional = next.result;
      return next.data === current ? { ...current } : next.data;
    }, token);
    const result = confirmBulkSourceAction(coordinator.getSnapshot().data, provisional);
    expect(result.selectedCount).toBe(2);
    expect(result.acceptedSourceIds).toEqual([firstId, missingId]);
    expect(result.failedSourceIds).toEqual([]);
    expect(result.items.find((item) => item.sourceId === firstId)).toEqual(
      first.items.find((item) => item.sourceId === firstId),
    );
    expect(coordinator.getSnapshot().data.sources[0]).toEqual(firstSource);
    expect(disk.get(accountA.id)?.sources[0]).toEqual(firstSource);
    const newlyAccepted = disk.get(accountA.id)!.sources.find((source) => source.id === missingId)!;
    if (kind === "associate") {
      expect(result.addedSourceIds).toEqual([firstId, missingId]);
      expect(result.addedAssociations).toBe(2);
      expect(newlyAccepted.spaceIds).toContain(data.spaces[1].id);
    } else {
      expect(result.recycledSourceIds).toEqual([firstId, missingId]);
      expect(newlyAccepted.deletedAt).toBe(retryAt);
    }
    expect(workspaceSchema.safeParse(coordinator.getSnapshot().data).success).toBe(true);
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
  });

  it("checks the latest postcondition after ACK and never confirms an independently reverted result", async () => {
    const { coordinator, io, disk, data, token } = await setup(),
      local = deferred<void>();
    vi.mocked(io.saveLocal).mockImplementationOnce(async (value, id = "local") => {
      await local.promise;
      disk.set(id, structuredClone(value));
    });
    const outcome = persistAction(coordinator, kind, token).catch((error: unknown) => error);
    await vi.waitFor(() => expect(io.saveLocal).toHaveBeenCalledOnce());
    const firstId = data.sources[0].id,
      target = data.spaces[1].id;
    const independent = coordinator.updateDurably(
      (current) => ({
        ...current,
        sources: current.sources.map((source) =>
          source.id === firstId
            ? kind === "associate"
              ? { ...source, spaceIds: source.spaceIds.filter((id) => id !== target) }
              : { ...source, deletedAt: null }
            : source,
        ),
      }),
      token,
    );
    const latest = structuredClone(coordinator.getSnapshot().data.sources);
    local.resolve();
    expect(await outcome).toBeInstanceOf(Error);
    await independent;
    expect(disk.get(accountA.id)?.sources).toEqual(latest);
    if (kind === "associate") expect(latest[0].spaceIds).not.toContain(target);
    else expect(latest[0].deletedAt).toBeNull();
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
  });

  it("refuses to resave a failed operation receipt after the accepted source version is replaced", async () => {
    const { coordinator, io, disk, data, token } = await setup();
    let provisional!: BulkSourceActionResult;
    vi.mocked(io.saveLocal).mockRejectedValueOnce(new Error("IndexedDB temporarily unavailable"));
    await expect(
      persistAction(coordinator, kind, token, [data.sources[0].id], (result) => {
        provisional = result;
      }),
    ).rejects.toThrow("尚未保存到此浏览器");
    await coordinator.updateDurably(
      (current) => ({
        ...current,
        sources: current.sources.map((source, index) => {
          if (index !== 0) return source;
          const replacement = { ...source, versionId: crypto.randomUUID() };
          replacement.chunks = chunkText(replacement.text, replacement.id, replacement.versionId);
          return replacement;
        }),
      }),
      token,
    );
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
    const latest = structuredClone(coordinator.getSnapshot().data);
    expect(latest.sources[0].versionId).not.toBe(data.sources[0].versionId);
    vi.mocked(io.saveLocal).mockClear();
    await expect(
      coordinator.updateDurably(
        (current) => snapshotRetryBulkSourceAction(current, provisional).data,
        token,
      ),
    ).rejects.toThrow();
    expect(() => confirmBulkSourceAction(latest, provisional)).toThrow();
    expect(io.saveLocal).not.toHaveBeenCalled();
    expect(disk.get(accountA.id)?.sources).toEqual(latest.sources);
    expect(coordinator.getSnapshot().data).toEqual(latest);
    expect(workspaceSchema.safeParse(latest).success).toBe(true);
  });

  it("late A persistence rejects confirmation after owner change and cannot mutate B", async () => {
    const { coordinator, io, disk, data, token } = await setup(),
      local = deferred<void>();
    vi.mocked(io.saveLocal).mockImplementationOnce(async (value, id = "local") => {
      await local.promise;
      disk.set(id, structuredClone(value));
    });
    const outcome = persistAction(coordinator, kind, token).catch((error: unknown) => error);
    await vi.waitFor(() => expect(io.saveLocal).toHaveBeenCalledOnce());
    await coordinator.activate(accountB);
    const b = structuredClone(coordinator.getSnapshot().data);
    local.resolve();
    expect(await outcome).toBeInstanceOf(Error);
    expect(coordinator.getSnapshot().user?.id).toBe(accountB.id);
    expect(coordinator.getSnapshot().data).toEqual(b);
    expect(disk.get(accountB.id)?.sources).toEqual(b.sources);
    assertApplied(
      disk.get(accountA.id)!,
      kind,
      data.sources.slice(0, 2).map((s) => s.id),
      data.spaces[1].id,
    );
    expect(await coordinator.updateDurably((current) => ({ ...current }), token)).toBe(false);
  });

  it("A→B→A gets a fresh token and never treats the first A operation as current", async () => {
    const { coordinator, io, disk, data, token } = await setup(),
      local = deferred<void>();
    vi.mocked(io.saveLocal).mockImplementationOnce(async (value, id = "local") => {
      await local.promise;
      disk.set(id, structuredClone(value));
    });
    const outcome = persistAction(coordinator, kind, token).catch((error: unknown) => error);
    await vi.waitFor(() => expect(io.saveLocal).toHaveBeenCalledOnce());
    await coordinator.activate(accountB);
    const b = structuredClone(coordinator.getSnapshot().data);
    const returning = coordinator.activate(accountA);
    expect(coordinator.getSnapshot().token).not.toBe(token);
    local.resolve();
    expect(await outcome).toBeInstanceOf(Error);
    await returning;
    const freshToken = coordinator.getSnapshot().token;
    expect(freshToken).not.toBe(token);
    expect(await coordinator.updateDurably((current) => ({ ...current }), token)).toBe(false);
    await persistAction(coordinator, kind, freshToken);
    assertApplied(
      disk.get(accountA.id)!,
      kind,
      data.sources.slice(0, 2).map((s) => s.id),
      data.spaces[1].id,
    );
    expect(disk.get(accountB.id)?.sources).toEqual(b.sources);
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
  });
});
