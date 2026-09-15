import "fake-indexeddb/auto";
import { IDBFactory, IDBObjectStore as FakeIDBObjectStore } from "fake-indexeddb";
import { deleteDB, openDB } from "idb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as local from "./local-store";
import { createDemoWorkspace, createEmptyWorkspace } from "./seed";
import { CloudError } from "./cloud";
import {
  observeAccountDeletionFailure,
  subscribeConfirmedAccountDeletions,
} from "./account-deletion-observer";
import { KNOWLEDGE_UPDATE_DRAFT_DATABASE } from "./knowledge-update-review-drafts";
import { WorkspaceCoordinator, type WorkspaceIO } from "./use-workspace";
import type { Note, WorkspaceData } from "./types";
import type { OrganizationJob } from "./organization-types";

const accountA = { id: "A", email: "a@example.test" };
const accountB = { id: "B", email: "b@example.test" };
const coordinators: WorkspaceCoordinator[] = [];

class FakeBroadcastChannel extends EventTarget {
  static instances = new Set<FakeBroadcastChannel>();
  closed = false;
  constructor(readonly name: string) {
    super();
    FakeBroadcastChannel.instances.add(this);
  }
  postMessage(data: unknown) {
    for (const peer of FakeBroadcastChannel.instances) {
      if (peer !== this && !peer.closed && peer.name === this.name)
        peer.dispatchEvent(new MessageEvent("message", { data: structuredClone(data) }));
    }
  }
  close() {
    this.closed = true;
    FakeBroadcastChannel.instances.delete(this);
  }
}

function browser(broadcast = true) {
  const window = Object.assign(new EventTarget(), {
    crypto: globalThis.crypto,
    BroadcastChannel: broadcast ? FakeBroadcastChannel : undefined,
  });
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  return { window, document };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function workspace(name: string): WorkspaceData {
  const data = createEmptyWorkspace();
  data.spaces[0]!.name = name;
  return data;
}

async function setup() {
  const remote = new Map([
    ["A", { data: workspace("PRIVATE_A"), revision: 1 }],
    ["B", { data: workspace("PRIVATE_B"), revision: 1 }],
  ]);
  for (const [id, value] of remote) {
    await local.saveLocalWorkspace(
      { ...value.data, _conuoSync: { revision: 1, dirty: false } } as WorkspaceData,
      id,
      0,
    );
  }
  const io: WorkspaceIO = {
    loadLocal: local.loadLocalWorkspaceRecord,
    saveLocal: local.saveLocalWorkspace,
    commitLocalImport: local.commitLocalImport,
    subscribeLocalCommits: local.subscribeLocalWorkspaceCommits,
    clearAccountLocalCache: local.clearAccountLocalCache,
    isAccountLocallyDeleted: local.isAccountLocallyDeleted,
    markAccountLocalDeletion: local.markAccountLocalDeletion,
    subscribeLocalAccountDeletions: local.subscribeLocalAccountDeletions,
    subscribeConfirmedAccountDeletions,
    loadCloud: vi.fn(async (id) => structuredClone(remote.get(id) ?? { data: null, revision: 0 })),
    loadCloudRevision: vi.fn(async (id) => ({ revision: remote.get(id)?.revision ?? 0 })),
    saveCloud: vi.fn(async (data, revision, id) => {
      remote.set(id, { data: structuredClone(data), revision: revision + 1 });
      return { revision: revision + 1 };
    }),
    getBlob: local.getBlob,
    getAccountBlob: local.getBlob,
    putBlobIfAbsent: local.putBlobIfAbsent,
    putAccountBlobIfAbsent: local.putBlobIfAbsent,
    deleteUnreferencedBlob: local.deleteUnreferencedBlob,
    deleteAccountUnreferencedBlob: local.deleteUnreferencedBlob,
    uploadBlob: vi.fn(async () => "unused"),
    downloadBlob: vi.fn(async () => undefined),
    askCloud: vi.fn(async () => ({
      content: "answer",
      citations: [],
      mode: "extractive" as const,
    })),
    organizeCloud: vi.fn(),
    getModelStatus: vi.fn(async () => ({ mode: "extractive", message: "local test" })),
    readLegacyMeta: () => null,
  };
  const coordinator = new WorkspaceCoordinator(io);
  coordinators.push(coordinator);
  return { coordinator, io, remote };
}

async function rawWorkspace(id: string) {
  const db = await openDB("conuo-web");
  try {
    return await db.get("workspaces", `account:${id}:workspace`);
  } finally {
    db.close();
  }
}

async function setupDemo() {
  const result = await setup();
  const data = createDemoWorkspace();
  const revision = (await local.loadLocalWorkspaceRecord("A"))!._conuoLocalRevision!;
  await local.saveLocalWorkspace(
    { ...data, _conuoSync: { revision: 1, dirty: false } } as WorkspaceData,
    "A",
    revision,
  );
  result.remote.set("A", { data, revision: 1 });
  return { ...result, data };
}

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(async () => {
  coordinators.splice(0).forEach((coordinator) => coordinator.dispose());
  vi.restoreAllMocks();
  await deleteDB("conuo-web");
  await deleteDB(KNOWLEDGE_UPDATE_DRAFT_DATABASE);
  for (const channel of FakeBroadcastChannel.instances) channel.close();
  vi.unstubAllGlobals();
});

describe("account deletion coordinator local lifecycle", () => {
  it("redacts immediately before an already-started local save settles", async () => {
    const { coordinator, io } = await setup();
    await coordinator.activate(accountA);
    const save = deferred<void>();
    const started = deferred<void>();
    io.saveLocal = async (...args) => {
      started.resolve();
      await save.promise;
      return local.saveLocalWorkspace(...args);
    };
    const token = coordinator.getSnapshot().token;
    coordinator.update((data) => ({ ...data, aiEnabled: false }), token);
    await started.promise;
    const deletion = coordinator.discardAccount("A");
    expect(coordinator.getSnapshot().data.spaces).toEqual([]);
    expect(coordinator.getSnapshot().token).toBeGreaterThan(token);
    save.resolve();
    await deletion;
    expect(await rawWorkspace("A")).toBeUndefined();
  });

  it("clears A after switching to B without changing B's visible workspace", async () => {
    const { coordinator } = await setup();
    await coordinator.activate(accountA);
    await coordinator.activate(accountB);
    const before = coordinator.getSnapshot();
    await coordinator.discardAccount("A");
    expect(await rawWorkspace("A")).toBeUndefined();
    expect(coordinator.getSnapshot()).toBe(before);
    expect(coordinator.getSnapshot().data.spaces[0]!.name).toBe("PRIVATE_B");
  });

  it("keeps data redacted when real review-draft cleanup fails", async () => {
    const { coordinator } = await setup();
    await coordinator.activate(accountA);
    const originalPut = FakeIDBObjectStore.prototype.put;
    vi.spyOn(FakeIDBObjectStore.prototype, "put").mockImplementation(function (
      this: InstanceType<typeof FakeIDBObjectStore>,
      ...args: Parameters<typeof originalPut>
    ) {
      if (this.transaction.db.name === KNOWLEDGE_UPDATE_DRAFT_DATABASE)
        throw new Error("draft disk denied");
      return originalPut.apply(this, args);
    });
    await expect(coordinator.discardAccount("A")).rejects.toThrow("清理");
    expect(coordinator.getSnapshot().data.spaces).toEqual([]);
    expect(await rawWorkspace("A")).toBeUndefined();
    await expect(local.saveLocalWorkspace(workspace("RESURRECT"), "A", 0)).rejects.toMatchObject({
      code: "LOCAL_ACCOUNT_DELETED",
    });
    expect(coordinator.getSnapshot().accountDeletionState).toBe("cleanup-failed");
    vi.restoreAllMocks();
    await coordinator.retryAccountLocalDeletion();
    expect(coordinator.getSnapshot().accountDeletionState).toBe("blocked");
    expect(coordinator.getSnapshot().data.spaces).toEqual([]);
  });

  it("notifies a second real coordinator and fences its dirty in-memory copy", async () => {
    browser();
    const { coordinator, io } = await setup();
    const other = new WorkspaceCoordinator(io);
    coordinators.push(other);
    await coordinator.activate(accountA);
    await other.activate(accountA);
    other.update((data) => ({ ...data, aiEnabled: false }), other.getSnapshot().token);
    await coordinator.discardAccount("A");
    await vi.waitFor(() => expect(other.getSnapshot().accountDeletionState).toBe("blocked"));
    expect(other.getSnapshot().data.spaces).toEqual([]);
    await other.activate(accountB);
    await other.activate(accountA);
    expect(other.getSnapshot().data.spaces).toEqual([]);
    expect(await rawWorkspace("A")).toBeUndefined();
  });

  it("rejects restored and refreshed sessions before any cloud body is read", async () => {
    const { coordinator, io } = await setup();
    await coordinator.activate(accountA);
    await coordinator.discardAccount("A");
    coordinator.dispose();
    const fresh = new WorkspaceCoordinator(io);
    coordinators.push(fresh);
    vi.mocked(io.loadCloud).mockClear();
    await fresh.activate(accountA);
    expect(io.loadCloud).not.toHaveBeenCalled();
    expect(fresh.getSnapshot().accountDeletionState).toBe("blocked");
    expect(fresh.getSnapshot().data.spaces).toEqual([]);
    await expect(local.loadLocalWorkspaceRecord("A")).rejects.toMatchObject({
      code: "LOCAL_ACCOUNT_DELETED",
    });
  });

  it.each(["focus", "visibilitychange", "pageshow"])(
    "rechecks the authoritative marker on %s without BroadcastChannel",
    async (event) => {
      const surface = browser(false);
      const { coordinator } = await setup();
      await coordinator.activate(accountA);
      await local.markAccountLocalDeletion("A");
      expect(coordinator.getSnapshot().data.spaces[0]!.name).toBe("PRIVATE_A");
      (event === "visibilitychange" ? surface.document : surface.window).dispatchEvent(
        new Event(event),
      );
      await vi.waitFor(() =>
        expect(coordinator.getSnapshot().accountDeletionState).toBe("blocked"),
      );
      expect(coordinator.getSnapshot().data.spaces).toEqual([]);
      expect(await rawWorkspace("A")).toBeUndefined();
    },
  );

  it("does not treat a forged notification with no durable marker as deletion", async () => {
    browser();
    const { coordinator } = await setup();
    await coordinator.activate(accountA);
    const channel = new FakeBroadcastChannel("conuo-local-account-deletions-v1");
    channel.postMessage({ schemaVersion: 1, accountId: "A", writerId: "another-writer" });
    await local.isAccountLocallyDeleted("A");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(coordinator.getSnapshot().accountDeletionState).toBeNull();
    expect(coordinator.getSnapshot().data.spaces[0]!.name).toBe("PRIVATE_A");
  });

  it.each([
    [new CloudError("network unavailable", 502, "CLOUD_ERROR"), false],
    [new CloudError("session expired", 401, "UNAUTHENTICATED"), false],
    [new CloudError("wrong code", 423, "OTHER_LOCK"), false],
    [new CloudError("wrong status", 401, "ACCOUNT_DELETION_PENDING"), false],
    [new CloudError("deletion accepted", 423, "ACCOUNT_DELETION_PENDING"), true],
    [{ status: 423, code: "ACCOUNT_DELETION_PENDING" }, true],
  ])("only fences confirmed 423 ACCOUNT_DELETION_PENDING (%s)", async (cause, deleted) => {
    const { coordinator, io } = await setup();
    vi.mocked(io.loadCloud).mockRejectedValue(cause);
    await coordinator.activate(accountA);
    await vi.waitFor(async () => expect(await local.isAccountLocallyDeleted("A")).toBe(deleted));
    if (deleted) {
      await vi.waitFor(() =>
        expect(coordinator.getSnapshot().accountDeletionState).toBe("blocked"),
      );
      expect(coordinator.getSnapshot().data.spaces).toEqual([]);
    } else {
      expect(coordinator.getSnapshot().data.spaces[0]!.name).toBe("PRIVATE_A");
      expect(coordinator.getSnapshot().accountDeletionState).toBeNull();
    }
  });

  it("does not publish a late cleanup failure over B and cannot recover A's retained edit", async () => {
    const { coordinator, io } = await setup();
    await coordinator.activate(accountA);
    coordinator.update((data) => ({ ...data, aiEnabled: false }), coordinator.getSnapshot().token);
    const cleanup = deferred<void>();
    const started = deferred<void>();
    io.clearAccountLocalCache = async (id) => {
      started.resolve();
      await cleanup.promise;
      return local.clearAccountLocalCache(id);
    };
    const deletion = coordinator.discardAccount("A");
    const rejected = expect(deletion).rejects.toThrow("本机副本清理失败");
    await started.promise;
    await coordinator.activate(accountB);
    const before = coordinator.getSnapshot();
    cleanup.reject(new Error("cleanup unavailable"));
    await rejected;
    expect(coordinator.getSnapshot()).toBe(before);
    expect(coordinator.getSnapshot().data.spaces[0]!.name).toBe("PRIVATE_B");
    io.clearAccountLocalCache = local.clearAccountLocalCache;
    await coordinator.activate(accountA);
    expect(coordinator.getSnapshot().data.spaces).toEqual([]);
    expect(coordinator.getSnapshot().accountDeletionState).toBe("blocked");
  });

  it("aborts a late cloud answer and prevents disposed A from rebuilding local state", async () => {
    const { coordinator, io, remote } = await setup();
    const data = createDemoWorkspace();
    const revision = (await local.loadLocalWorkspaceRecord("A"))!._conuoLocalRevision!;
    await local.saveLocalWorkspace(
      { ...data, _conuoSync: { revision: 1, dirty: false } } as WorkspaceData,
      "A",
      revision,
    );
    remote.set("A", { data, revision: 1 });
    await coordinator.activate(accountA);
    const answer = deferred<{ content: string; citations: []; mode: "extractive" }>();
    vi.mocked(io.askCloud).mockReturnValue(answer.promise);
    const source = data.sources[0]!;
    const request = coordinator.ask(
      {
        scope: "document",
        sourceIds: [],
        question: "什么是学习率？",
        spaceId: data.spaces[0]!.id,
        sourceId: source.id,
      },
      new AbortController().signal,
      coordinator.getSnapshot().token,
    );
    const stopped = expect(request).rejects.toThrow();
    await vi.waitFor(() => expect(io.askCloud).toHaveBeenCalledOnce());
    await coordinator.discardAccount("A");
    coordinator.dispose();
    await stopped;
    answer.resolve({ content: "LATE_PRIVATE_ANSWER", citations: [], mode: "extractive" });
    await Promise.resolve();
    const fresh = new WorkspaceCoordinator(io);
    coordinators.push(fresh);
    await fresh.activate(accountA);
    expect(fresh.getSnapshot().data.spaces).toEqual([]);
    expect(await rawWorkspace("A")).toBeUndefined();
  });

  it("fences queued old-owner writes while durable marker publication is still pending", async () => {
    const { coordinator, io } = await setup();
    await coordinator.activate(accountA);
    const write = deferred<void>();
    const writeStarted = deferred<void>();
    const marker = deferred<void>();
    const markerStarted = deferred<void>();
    const calls: string[] = [];
    io.saveLocal = async (...args) => {
      calls.push(args[1]!);
      writeStarted.resolve();
      await write.promise;
      return local.saveLocalWorkspace(...args);
    };
    io.markAccountLocalDeletion = async (id) => {
      markerStarted.resolve();
      await marker.promise;
      await local.markAccountLocalDeletion(id);
    };
    const token = coordinator.getSnapshot().token;
    coordinator.update((data) => ({ ...data, aiEnabled: false }), token);
    await writeStarted.promise;
    coordinator.update(
      (data) => ({ ...data, spaces: data.spaces.map((space) => ({ ...space, name: "QUEUED_A" })) }),
      token,
    );
    const deletion = coordinator.discardAccount("A");
    await markerStarted.promise;
    expect(await local.isAccountLocallyDeleted("A")).toBe(false);
    expect(coordinator.getSnapshot().accountDeletionState).toBe("clearing");
    expect(coordinator.getSnapshot().data.spaces).toEqual([]);
    write.resolve();
    await vi.waitFor(() => expect(coordinator.hasUnsavedLocalChanges()).toBe(false));
    marker.resolve();
    await deletion;
    expect(calls).toEqual(["A"]);
    expect(await rawWorkspace("A")).toBeUndefined();
  });

  it("refuses a malformed marker before loading local or remote content without declaring deletion", async () => {
    const { coordinator, io } = await setup();
    const db = await openDB("conuo-web");
    try {
      await db.put("accountDeletions", { schemaVersion: 1, accountId: "B", blocked: true }, "A");
    } finally {
      db.close();
    }
    await coordinator.activate(accountA);
    expect(io.loadCloud).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().data.spaces[0]?.name).not.toBe("PRIVATE_A");
    expect(coordinator.getSnapshot().ready).toBe(false);
    expect(coordinator.getSnapshot().accountDeletionState).toBeNull();
    expect(coordinator.getSnapshot().error).toContain("无法核验本机账号注销状态");
    expect((await rawWorkspace("A"))!.spaces[0].name).toBe("PRIVATE_A");
  });

  it("stops a real import before its delayed atomic admission can recreate bytes or sources", async () => {
    const { coordinator, io } = await setup();
    await coordinator.activate(accountA);
    const admission = deferred<void>();
    const started = deferred<void>();
    let key = "";
    io.commitLocalImport = async (...args) => {
      key = args[1];
      started.resolve();
      await admission.promise;
      return local.commitLocalImport(...args);
    };
    const importing = coordinator.importFile(
      new File(["学习率决定每一步的更新幅度。"], "actual.txt", { type: "text/plain" }),
      coordinator.getSnapshot().data.spaces[0]!.id,
      coordinator.getSnapshot().token,
    );
    const stopped = expect(importing).rejects.toThrow();
    await started.promise;
    const deletion = coordinator.discardAccount("A");
    await vi.waitFor(async () => expect(await local.isAccountLocallyDeleted("A")).toBe(true));
    admission.resolve();
    await deletion;
    await stopped;
    expect(await rawWorkspace("A")).toBeUndefined();
    const db = await openDB("conuo-web");
    try {
      expect(await db.get("blobs", key)).toBeUndefined();
    } finally {
      db.close();
    }
    expect(coordinator.getSnapshot().accountDeletionState).toBe("blocked");
  });

  it("rejects a late durable organization reply without adopting its saved projection", async () => {
    const { coordinator, io, data } = await setupDemo();
    await coordinator.activate(accountA);
    const reply = deferred<{ revision: number; job: OrganizationJob; created: boolean }>();
    const started = deferred<void>();
    let job!: OrganizationJob;
    io.enqueueOrganizationJob = async (request) => {
      job = {
        id: request.requestId,
        request: structuredClone(request),
        durable: true,
        status: "queued",
        createdAt: "2026-09-15T06:00:00.000Z",
        updatedAt: "2026-09-15T06:00:00.000Z",
      };
      started.resolve();
      return reply.promise;
    };
    const organization = coordinator.organize(
      { kind: "source", spaceId: data.spaces[0]!.id, sourceIds: [data.sources[0]!.id] },
      undefined,
      coordinator.getSnapshot().token,
    );
    const stopped = expect(organization).rejects.toThrow();
    await started.promise;
    await coordinator.discardAccount("A");
    reply.resolve({ revision: 2, job, created: true });
    await stopped;
    expect(coordinator.getSnapshot().data.organizationJobs ?? []).toEqual([]);
    expect(await rawWorkspace("A")).toBeUndefined();
  });

  it("waits for a delayed real recovery write and refuses its old-owner admission", async () => {
    const { coordinator, io, remote } = await setup();
    const disk = (await local.loadLocalWorkspaceRecord("A"))!;
    await local.saveLocalWorkspace(
      {
        ...workspace("DIRTY_A"),
        _conuoSync: { revision: 1, dirty: true, baseRevision: 1, base: remote.get("A")!.data },
      } as WorkspaceData,
      "A",
      disk._conuoLocalRevision!,
    );
    remote.set("A", { data: workspace("REMOTE_A"), revision: 2 });
    await coordinator.activate(accountA);
    expect(coordinator.getSnapshot().recovery).not.toBeNull();
    const write = deferred<void>();
    const started = deferred<void>();
    let recoveryId = "";
    io.saveLocal = async (...args) => {
      if (args[1]?.startsWith("recovery:")) {
        recoveryId = args[1];
        started.resolve();
        await write.promise;
      }
      return local.saveLocalWorkspace(...args);
    };
    const recovery = coordinator.useRemote(coordinator.getSnapshot().token);
    await started.promise;
    const deletion = coordinator.discardAccount("A");
    await vi.waitFor(async () => expect(await local.isAccountLocallyDeleted("A")).toBe(true));
    write.resolve();
    await deletion;
    await recovery;
    const db = await openDB("conuo-web");
    try {
      expect(await db.get("workspaces", `account:${recoveryId}:workspace`)).toBeUndefined();
    } finally {
      db.close();
    }
    expect(await rawWorkspace("A")).toBeUndefined();
  });

  it("handles A's late confirmed deletion error after B activates without affecting B", async () => {
    const { coordinator, io } = await setup();
    const reply = deferred<Awaited<ReturnType<WorkspaceIO["loadCloud"]>>>();
    const started = deferred<void>();
    const original = io.loadCloud;
    io.loadCloud = async (...args) => {
      if (args[0] === "A") {
        started.resolve();
        return reply.promise;
      }
      return original(...args);
    };
    const activation = coordinator.activate(accountA);
    await started.promise;
    await coordinator.activate(accountB);
    const before = coordinator.getSnapshot();
    reply.reject(new CloudError("accepted deletion", 423, "ACCOUNT_DELETION_PENDING"));
    await activation;
    await vi.waitFor(async () => expect(await rawWorkspace("A")).toBeUndefined());
    expect(await local.isAccountLocallyDeleted("A")).toBe(true);
    expect(coordinator.getSnapshot()).toBe(before);
  });

  it("redacts both same-tab coordinators synchronously from an independent confirmed adapter signal without BC", async () => {
    browser(false);
    const { coordinator, io } = await setup();
    const other = new WorkspaceCoordinator(io);
    coordinators.push(other);
    await coordinator.activate(accountA);
    await other.activate(accountA);
    const observation = observeAccountDeletionFailure(
      { status: 423, code: "ACCOUNT_DELETION_PENDING" },
      "A",
    );
    expect(coordinator.getSnapshot().data.spaces).toEqual([]);
    expect(other.getSnapshot().data.spaces).toEqual([]);
    expect(coordinator.getSnapshot().accountDeletionState).toBe("clearing");
    await expect(observation).resolves.toMatchObject({ confirmed: true, cleanupFailed: false });
    await vi.waitFor(() => expect(other.getSnapshot().accountDeletionState).toBe("blocked"));
    expect(await rawWorkspace("A")).toBeUndefined();
  });

  it("receives an independent late A signal while B is visible and drops retained A data", async () => {
    browser(false);
    const { coordinator } = await setup();
    await coordinator.activate(accountA);
    await coordinator.activate(accountB);
    const before = coordinator.getSnapshot();
    await observeAccountDeletionFailure(
      new CloudError("accepted A", 423, "ACCOUNT_DELETION_PENDING"),
      "A",
    );
    expect(coordinator.getSnapshot()).toBe(before);
    expect(await rawWorkspace("A")).toBeUndefined();
    await coordinator.activate(accountA);
    expect(coordinator.getSnapshot().data.spaces).toEqual([]);
    expect(coordinator.getSnapshot().accountDeletionState).toBe("blocked");
  });

  it("unsubscribes a disposed coordinator while the independent signal still cleans its durable owner", async () => {
    browser(false);
    const { coordinator, io } = await setup();
    await coordinator.activate(accountA);
    const before = coordinator.getSnapshot();
    coordinator.dispose();
    await observeAccountDeletionFailure(
      new CloudError("accepted A", 423, "ACCOUNT_DELETION_PENDING"),
      "A",
    );
    expect(coordinator.getSnapshot()).toBe(before);
    expect(await rawWorkspace("A")).toBeUndefined();
    const fresh = new WorkspaceCoordinator(io);
    coordinators.push(fresh);
    await fresh.activate(accountA);
    expect(fresh.getSnapshot().data.spaces).toEqual([]);
    expect(fresh.getSnapshot().accountDeletionState).toBe("blocked");
  });

  it("hides a ready foreground workspace, recovery and conflict plans on marker read failure, then restores its exact dirty note after verification", async () => {
    const surface = browser(false);
    const { coordinator, io, remote, data } = await setupDemo();
    const base: Note = {
      id: "private-note",
      spaceId: data.spaces[0]!.id,
      title: "PRIVATE_TITLE",
      content: "BASE_PRIVATE_NOTE",
      kind: "note",
      status: "accepted",
      citations: [],
      versions: [],
      contentRevision: 0,
      createdAt: "2026-09-15T06:00:00.000Z",
      updatedAt: "2026-09-15T06:00:00.000Z",
      deletedAt: null,
    };
    const baseline = { ...data, notes: [base] };
    const dirty = {
      ...data,
      notes: [{ ...base, content: "EXACT_DIRTY_PRIVATE_NOTE", contentRevision: 1 }],
    };
    const revision = (await local.loadLocalWorkspaceRecord("A"))!._conuoLocalRevision!;
    await local.saveLocalWorkspace(
      {
        ...dirty,
        _conuoSync: { revision: 1, dirty: true, baseRevision: 1, base: baseline },
      } as WorkspaceData,
      "A",
      revision,
    );
    remote.set("A", {
      data: { ...data, notes: [{ ...base, content: "REMOTE_PRIVATE_NOTE", contentRevision: 1 }] },
      revision: 2,
    });
    await coordinator.activate(accountA);
    const before = coordinator.getSnapshot();
    expect(before.ready).toBe(true);
    expect(before.noteSyncPlan).not.toBeNull();
    expect(before.recovery?.notes[0]?.content).toBe("REMOTE_PRIVATE_NOTE");

    const originalGet = FakeIDBObjectStore.prototype.get;
    const readFailure = vi.spyOn(FakeIDBObjectStore.prototype, "get").mockImplementation(function (
      this: InstanceType<typeof FakeIDBObjectStore>,
      ...args: Parameters<typeof originalGet>
    ) {
      if (this.name === "accountDeletions" && args[0] === "A")
        throw new Error("marker disk denied");
      return originalGet.apply(this, args);
    });
    surface.window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().error).toContain("无法核验本机账号注销状态"),
    );
    expect(coordinator.getSnapshot()).toMatchObject({
      ready: false,
      accountAccessVerificationFailed: true,
      accountDeletionState: null,
      recovery: null,
      noteSyncPlan: null,
      readingProgressSyncPlan: null,
    });
    expect(coordinator.getSnapshot().data.spaces).toEqual([]);
    expect(coordinator.getSnapshot().data.sources).toEqual([]);
    expect(coordinator.getSnapshot().data.notes).toEqual([]);
    expect(JSON.stringify(coordinator.getSnapshot())).not.toContain("PRIVATE");
    expect((await rawWorkspace("A"))!.notes[0].content).toBe("EXACT_DIRTY_PRIVATE_NOTE");
    readFailure.mockRestore();
    expect(await local.isAccountLocallyDeleted("A")).toBe(false);
    await coordinator.retry(coordinator.getSnapshot().token);
    expect(coordinator.getSnapshot()).toMatchObject({
      ready: true,
      accountAccessVerificationFailed: false,
      accountDeletionState: null,
    });
    expect(coordinator.getSnapshot().data.notes[0]?.content).toBe("EXACT_DIRTY_PRIVATE_NOTE");
    expect(coordinator.getSnapshot().noteSyncPlan).not.toBeNull();
    expect(io.saveCloud).not.toHaveBeenCalled();
  });

  it("preserves a memory-only note across repeated failed verification retries", async () => {
    const surface = browser(false);
    const { coordinator, data } = await setupDemo();
    await coordinator.activate(accountA);
    const originalPut = FakeIDBObjectStore.prototype.put;
    const putFailure = vi.spyOn(FakeIDBObjectStore.prototype, "put").mockImplementation(function (
      this: InstanceType<typeof FakeIDBObjectStore>,
      ...args: Parameters<typeof originalPut>
    ) {
      if (this.name === "workspaces") throw new Error("workspace disk denied");
      return originalPut.apply(this, args);
    });
    const note: Note = {
      id: "memory-note",
      spaceId: data.spaces[0]!.id,
      title: "MEMORY_PRIVATE_TITLE",
      content: "EXACT_MEMORY_ONLY_PRIVATE_NOTE",
      kind: "note",
      status: "accepted",
      citations: [],
      versions: [],
      contentRevision: 0,
      createdAt: "2026-09-15T06:00:00.000Z",
      updatedAt: "2026-09-15T06:00:00.000Z",
      deletedAt: null,
    };
    coordinator.update((data) => ({ ...data, notes: [note] }), coordinator.getSnapshot().token);
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("error"));
    expect((await rawWorkspace("A"))!.notes).toEqual([]);
    const originalGet = FakeIDBObjectStore.prototype.get;
    const getFailure = vi.spyOn(FakeIDBObjectStore.prototype, "get").mockImplementation(function (
      this: InstanceType<typeof FakeIDBObjectStore>,
      ...args: Parameters<typeof originalGet>
    ) {
      if (this.name === "accountDeletions" && args[0] === "A")
        throw new Error("marker disk denied");
      return originalGet.apply(this, args);
    });
    surface.window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().accountAccessVerificationFailed).toBe(true),
    );
    await coordinator.retry(coordinator.getSnapshot().token);
    expect(coordinator.getSnapshot().accountAccessVerificationFailed).toBe(true);
    expect(coordinator.getSnapshot().data.notes).toEqual([]);
    getFailure.mockRestore();
    putFailure.mockRestore();
    await coordinator.retry(coordinator.getSnapshot().token);
    expect(coordinator.getSnapshot().data.notes[0]?.content).toBe("EXACT_MEMORY_ONLY_PRIVATE_NOTE");
    expect(coordinator.getSnapshot().accountAccessVerificationFailed).toBe(false);
    expect(await local.isAccountLocallyDeleted("A")).toBe(false);
  });

  it("does not reopen a hidden workspace when its in-flight cloud update arrives after marker verification failed", async () => {
    const surface = browser(false);
    const { coordinator, io, remote } = await setup();
    await coordinator.activate(accountA);
    const candidate = deferred<Awaited<ReturnType<WorkspaceIO["loadCloud"]>>>();
    remote.set("A", { data: workspace("LATE_CLOUD_PRIVATE_BODY"), revision: 2 });
    vi.mocked(io.loadCloud).mockReturnValueOnce(candidate.promise);
    const checking = coordinator.checkCloudUpdates(coordinator.getSnapshot().token);
    await vi.waitFor(() => expect(io.loadCloud).toHaveBeenCalledTimes(2));
    const originalGet = FakeIDBObjectStore.prototype.get;
    const markerRead = vi.spyOn(FakeIDBObjectStore.prototype, "get").mockImplementation(function (
      this: InstanceType<typeof FakeIDBObjectStore>,
      ...args: Parameters<typeof originalGet>
    ) {
      if (this.name === "accountDeletions" && args[0] === "A")
        throw new Error("marker disk denied");
      return originalGet.apply(this, args);
    });
    surface.window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().accountAccessVerificationFailed).toBe(true),
    );
    candidate.resolve(remote.get("A")!);
    await checking;
    await Promise.resolve();
    expect(coordinator.getSnapshot()).toMatchObject({
      ready: false,
      accountAccessVerificationFailed: true,
      accountDeletionState: null,
      recovery: null,
      noteSyncPlan: null,
      readingProgressSyncPlan: null,
    });
    expect(coordinator.getSnapshot().data.spaces).toEqual([]);
    expect(JSON.stringify(coordinator.getSnapshot())).not.toContain("PRIVATE");
    expect((await rawWorkspace("A"))!.spaces[0].name).toBe("PRIVATE_A");
    await expect(
      coordinator.importFile(
        new File(["blocked"], "blocked.txt"),
        "",
        coordinator.getSnapshot().token,
      ),
    ).rejects.toThrow("当前账号已改变");
    markerRead.mockRestore();
    expect(await local.isAccountLocallyDeleted("A")).toBe(false);
  });
});
