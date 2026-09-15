import "fake-indexeddb/auto";
import {
  IDBFactory,
  IDBObjectStore as FakeIDBObjectStore,
  IDBDatabase as FakeIDBDatabase,
} from "fake-indexeddb";
import { deleteDB, openDB } from "idb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as local from "./local-store";
import { createDemoWorkspace, createEmptyWorkspace } from "./seed";
import { KNOWLEDGE_UPDATE_DRAFT_DATABASE } from "./knowledge-update-review-drafts";

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(async () => {
  vi.restoreAllMocks();
  await deleteDB("conuo-web");
  await deleteDB(KNOWLEDGE_UPDATE_DRAFT_DATABASE);
  vi.unstubAllGlobals();
});

async function rawRecord(store: string, key: string) {
  const db = await openDB("conuo-web");
  try {
    return await db.get(store, key);
  } finally {
    db.close();
  }
}

function imported() {
  const workspace = createDemoWorkspace();
  workspace.sources = [workspace.sources[0]!];
  const source = workspace.sources[0]!;
  const key = `original:${source.id}:${source.versionId}`;
  source.blobKey = key;
  return { workspace, key, bytes: new Blob(["private original"]) };
}

describe("durable account deletion admission", () => {
  it("removes only A's legacy sync snapshot while preserving B and anonymous preferences", async () => {
    const values = new Map([
      ["conuo.sync.A", JSON.stringify({ base: imported().workspace, dirty: true })],
      ["conuo.sync.AB", "private B base"],
      ["conuo.sync.local", "anonymous base"],
      ["conuo.theme", "light"],
    ]);
    vi.stubGlobal("window", { localStorage: { removeItem: (key: string) => values.delete(key) } });
    await local.clearAccountLocalCache("A");
    expect(values.has("conuo.sync.A")).toBe(false);
    expect([...values.keys()]).toEqual(["conuo.sync.AB", "conuo.sync.local", "conuo.theme"]);
    expect(await local.isAccountLocallyDeleted("A")).toBe(true);
  });

  it("reports a blocked legacy storage cleanup while still clearing and fencing main account bytes", async () => {
    const { workspace, key, bytes } = imported();
    await local.commitLocalImport("A", key, bytes, () => ({
      workspace,
      storeBlob: true,
      result: null,
    }));
    vi.stubGlobal("window", {
      get localStorage() {
        throw new DOMException("storage denied", "SecurityError");
      },
    });
    await expect(local.clearAccountLocalCache("A")).rejects.toThrow("storage denied");
    expect(await rawRecord("workspaces", "account:A:workspace")).toBeUndefined();
    expect(await rawRecord("blobs", key)).toBeUndefined();
    expect(await local.isAccountLocallyDeleted("A")).toBe(true);
  });
  it("upgrades v1 in place without changing workspaces, sync metadata, owned or legacy originals", async () => {
    const old = await openDB("conuo-web", 1, {
      upgrade(db) {
        db.createObjectStore("workspaces");
        db.createObjectStore("blobs");
      },
    });
    const workspace = {
      ...createEmptyWorkspace(),
      _conuoLocalRevision: 7,
      _conuoSync: { revision: 3, dirty: true },
    };
    try {
      await old.put("workspaces", workspace, "account:A:workspace");
      await old.put(
        "blobs",
        { schemaVersion: 1, blob: new Blob(["owned"]), ownerIds: ["A"] },
        "owned",
      );
      await old.put("blobs", new Blob(["legacy"]), "legacy");
    } finally {
      old.close();
    }
    expect(await local.isAccountLocallyDeleted("A")).toBe(false);
    expect(await local.loadLocalWorkspaceRecord("A")).toEqual(workspace);
    expect(await (await local.getBlob("owned", "A"))!.text()).toBe("owned");
    expect(await local.getBlob("legacy", "A")).toBeUndefined();
    expect(await ((await rawRecord("blobs", "legacy")) as Blob).text()).toBe("legacy");
    const upgraded = await openDB("conuo-web");
    expect(upgraded.version).toBe(2);
    expect([...upgraded.objectStoreNames]).toEqual(["accountDeletions", "blobs", "workspaces"]);
    upgraded.close();
  });

  it("persists an identity-only idempotent marker across fresh connections", async () => {
    await local.markAccountLocalDeletion("A");
    await local.markAccountLocalDeletion("A");
    expect(await rawRecord("accountDeletions", "A")).toEqual({
      schemaVersion: 1,
      accountId: "A",
      blocked: true,
    });
    expect(await local.isAccountLocallyDeleted("A")).toBe(true);
    expect(await local.isAccountLocallyDeleted("B")).toBe(false);
    expect(await local.isAccountLocallyDeleted("local")).toBe(false);
    expect(await rawRecord("workspaces", "account:A:workspace")).toBeUndefined();
  });

  it("rejects a fresh revision and an unguarded save after clearing", async () => {
    await local.saveLocalWorkspace(createEmptyWorkspace(), "A", 0);
    await local.clearAccountLocalCache("A");
    await expect(local.saveLocalWorkspace(createEmptyWorkspace(), "A", 0)).rejects.toMatchObject({
      code: "LOCAL_ACCOUNT_DELETED",
    });
    await expect(local.saveLocalWorkspace(createEmptyWorkspace(), "A")).rejects.toMatchObject({
      code: "LOCAL_ACCOUNT_DELETED",
    });
    expect(await rawRecord("workspaces", "account:A:workspace")).toBeUndefined();
  });

  it("rejects reads and new imports after deletion while keeping anonymous and B usable", async () => {
    await local.clearAccountLocalCache("A");
    const { workspace, key, bytes } = imported();
    const merger = vi.fn(() => ({ workspace, storeBlob: true, result: null }));
    await expect(local.loadLocalWorkspaceRecord("A")).rejects.toMatchObject({
      code: "LOCAL_ACCOUNT_DELETED",
    });
    await expect(local.commitLocalImport("A", key, bytes, merger)).rejects.toMatchObject({
      code: "LOCAL_ACCOUNT_DELETED",
    });
    expect(merger).not.toHaveBeenCalled();
    await expect(local.saveLocalWorkspace(createEmptyWorkspace(), "B", 0)).resolves.toBe(1);
    await expect(local.saveLocalWorkspace(createEmptyWorkspace(), "local", 0)).resolves.toBe(1);
    expect(await rawRecord("blobs", key)).toBeUndefined();
  });

  it("blocks exact-owner recovery copies and new original grants", async () => {
    await local.clearAccountLocalCache("A");
    await expect(
      local.saveLocalWorkspace(createEmptyWorkspace(), "recovery:A:123:session", 0),
    ).rejects.toMatchObject({ code: "LOCAL_ACCOUNT_DELETED" });
    await expect(local.putBlobIfAbsent("A-new", new Blob(["new"]), "A")).rejects.toMatchObject({
      code: "LOCAL_ACCOUNT_DELETED",
    });
    await local.putBlobIfAbsent("anonymous", new Blob(["anonymous"]), "local");
    await expect(local.shareAnonymousOriginals("A", ["anonymous"])).rejects.toMatchObject({
      code: "LOCAL_ACCOUNT_DELETED",
    });
    await expect(local.getBlob("anonymous", "A")).rejects.toMatchObject({
      code: "LOCAL_ACCOUNT_DELETED",
    });
    await expect(local.deleteBlob("anonymous", "A")).rejects.toMatchObject({
      code: "LOCAL_ACCOUNT_DELETED",
    });
    await expect(local.deleteUnreferencedBlob("anonymous", "A")).rejects.toMatchObject({
      code: "LOCAL_ACCOUNT_DELETED",
    });
    await expect(
      local.saveLocalWorkspace(createEmptyWorkspace(), "recovery:AB:123:session", 0),
    ).resolves.toBe(1);
  });

  it("matches recovery owner IDs containing colons without prefix collisions", async () => {
    await local.markAccountLocalDeletion("A:123");
    await expect(
      local.saveLocalWorkspace(createEmptyWorkspace(), "recovery:A:123:456:token", 0),
    ).rejects.toMatchObject({ code: "LOCAL_ACCOUNT_DELETED" });
    await expect(local.loadLocalWorkspaceRecord("recovery:A:123:456:token")).rejects.toMatchObject({
      code: "LOCAL_ACCOUNT_DELETED",
    });
    await expect(
      local.saveLocalWorkspace(createEmptyWorkspace(), "recovery:A:123:token", 0),
    ).resolves.toBe(1);
    await expect(
      local.saveLocalWorkspace(createEmptyWorkspace(), "recovery:A:1234:456:token", 0),
    ).resolves.toBe(1);
  });

  it.each(["local", "recovery:A:123:token", "", " A", "A "])(
    "rejects invalid deletion targets %j without modifying anonymous content",
    async (account) => {
      await local.saveLocalWorkspace(createEmptyWorkspace(), "local", 0);
      await expect(local.markAccountLocalDeletion(account)).rejects.toThrow("身份无效");
      await expect(local.clearAccountLocalCache(account)).rejects.toThrow("身份无效");
      expect(await local.loadLocalWorkspaceRecord("local")).not.toBeNull();
    },
  );

  it.each([
    null,
    false,
    {},
    { schemaVersion: 2, accountId: "A", blocked: true },
    { schemaVersion: 1, accountId: "B", blocked: true },
    { schemaVersion: 1, accountId: "A", blocked: false },
    { schemaVersion: 1, accountId: "A", blocked: true, content: "private" },
  ])("rejects damaged deletion marker %j without overwriting it", async (marker) => {
    await local.isAccountLocallyDeleted("A");
    const db = await openDB("conuo-web");
    try {
      await db.put("accountDeletions", marker, "A");
    } finally {
      db.close();
    }
    await expect(local.isAccountLocallyDeleted("A")).rejects.toThrow("标记无效");
    await expect(local.markAccountLocalDeletion("A")).rejects.toThrow("标记无效");
    await expect(local.loadLocalWorkspaceRecord("A")).rejects.toThrow("标记无效");
    await expect(local.saveLocalWorkspace(createEmptyWorkspace(), "A", 0)).rejects.toThrow(
      "标记无效",
    );
    await expect(local.putBlobIfAbsent("new", new Blob(["new"]), "A")).rejects.toThrow("标记无效");
    await expect(local.getBlob("new", "A")).rejects.toThrow("标记无效");
    const { workspace, key, bytes } = imported();
    await expect(
      local.commitLocalImport("A", key, bytes, () => ({
        workspace,
        storeBlob: true,
        result: null,
      })),
    ).rejects.toThrow("标记无效");
    await expect(local.shareAnonymousOriginals("A", ["new"])).rejects.toThrow("标记无效");
    expect(await rawRecord("accountDeletions", "A")).toEqual(marker);
    expect(await rawRecord("blobs", "new")).toBeUndefined();
  });
});

describe("proven original ownership cleanup", () => {
  it("retains shared bytes and removes only A's grant even with no A snapshot", async () => {
    await local.putBlobIfAbsent("shared", new Blob(["shared"]), "local");
    await local.shareAnonymousOriginals("A", ["shared"]);
    await local.shareAnonymousOriginals("B", ["shared"]);
    await expect(local.clearAccountLocalCache("A")).resolves.toEqual({
      deletedBlobs: 0,
      retainedBlobs: 1,
    });
    const shared = await rawRecord("blobs", "shared");
    expect(shared.ownerIds).toEqual(["local", "B"]);
    expect(await (await local.getBlob("shared", "B"))!.text()).toBe("shared");
    expect(await (await local.getBlob("shared", "local"))!.text()).toBe("shared");
  });

  it("retains bytes referenced by B without manufacturing B ownership", async () => {
    const { workspace, key, bytes } = imported();
    await local.putBlobIfAbsent(key, bytes, "A");
    await local.saveLocalWorkspace(workspace, "B", 0);
    await expect(local.clearAccountLocalCache("A")).resolves.toEqual({
      deletedBlobs: 0,
      retainedBlobs: 1,
    });
    expect((await rawRecord("blobs", key)).ownerIds).toEqual([]);
    expect(await local.getBlob(key, "B")).toBeUndefined();
    expect(await local.loadLocalWorkspaceRecord("B")).not.toBeNull();
  });

  it("removes A's grant but conservatively retains bytes when an independent workspace is damaged", async () => {
    await local.putBlobIfAbsent("A-owned", new Blob(["A"]), "A");
    const db = await openDB("conuo-web");
    try {
      await db.put("workspaces", { schemaVersion: 99 }, "account:B:workspace");
    } finally {
      db.close();
    }
    await expect(local.clearAccountLocalCache("A")).resolves.toEqual({
      deletedBlobs: 0,
      retainedBlobs: 1,
    });
    expect((await rawRecord("blobs", "A-owned")).ownerIds).toEqual([]);
    expect((await rawRecord("workspaces", "account:B:workspace")).schemaVersion).toBe(99);
  });

  it("clears proven A orphan bytes even without a target snapshot", async () => {
    await local.putBlobIfAbsent("A-orphan", new Blob(["A"]), "A");
    await local.putBlobIfAbsent("B-orphan", new Blob(["B"]), "B");
    await local.putBlobIfAbsent("local-orphan", new Blob(["local"]));
    await expect(local.clearAccountLocalCache("A")).resolves.toEqual({
      deletedBlobs: 1,
      retainedBlobs: 0,
    });
    expect(await rawRecord("blobs", "A-orphan")).toBeUndefined();
    expect(await (await local.getBlob("B-orphan", "B"))!.text()).toBe("B");
    expect(await (await local.getBlob("local-orphan"))!.text()).toBe("local");
  });

  it("clears proven orphans despite a damaged target while retaining legacy bytes", async () => {
    await local.putBlobIfAbsent("A-owned", new Blob(["A"]), "A");
    const db = await openDB("conuo-web");
    try {
      await db.put(
        "workspaces",
        { schemaVersion: 99, sources: [{ blobKey: "legacy" }] },
        "account:A:workspace",
      );
      await db.put("blobs", new Blob(["legacy"]), "legacy");
    } finally {
      db.close();
    }
    await expect(local.clearAccountLocalCache("A")).resolves.toEqual({
      deletedBlobs: 1,
      retainedBlobs: 0,
    });
    expect(await rawRecord("blobs", "A-owned")).toBeUndefined();
    expect(await ((await rawRecord("blobs", "legacy")) as Blob).text()).toBe("legacy");
  });

  it("still cleans and blocks the main cache when review-draft cleanup fails", async () => {
    await local.saveLocalWorkspace(createEmptyWorkspace(), "A", 0);
    await local.putBlobIfAbsent("A-owned", new Blob(["A"]), "A");
    const originalPut = FakeIDBObjectStore.prototype.put;
    vi.spyOn(FakeIDBObjectStore.prototype, "put").mockImplementation(function (
      this: InstanceType<typeof FakeIDBObjectStore>,
      ...args: Parameters<typeof originalPut>
    ) {
      if (this.transaction.db.name === KNOWLEDGE_UPDATE_DRAFT_DATABASE)
        throw new Error("draft disk denied");
      return originalPut.apply(this, args);
    });
    await expect(local.clearAccountLocalCache("A")).rejects.toThrow("清理");
    expect(await rawRecord("workspaces", "account:A:workspace")).toBeUndefined();
    expect(await rawRecord("blobs", "A-owned")).toBeUndefined();
    await expect(local.saveLocalWorkspace(createEmptyWorkspace(), "A", 0)).rejects.toMatchObject({
      code: "LOCAL_ACCOUNT_DELETED",
    });
  });

  it("keeps the durable marker if the main cleanup transaction fails", async () => {
    await local.saveLocalWorkspace(createEmptyWorkspace(), "A", 0);
    const originalDelete = FakeIDBObjectStore.prototype.delete;
    vi.spyOn(FakeIDBObjectStore.prototype, "delete").mockImplementation(function (
      this: InstanceType<typeof FakeIDBObjectStore>,
      ...args: Parameters<typeof originalDelete>
    ) {
      if (this.transaction.db.name === "conuo-web" && this.name === "workspaces")
        throw new Error("main disk denied");
      return originalDelete.apply(this, args);
    });
    await expect(local.clearAccountLocalCache("A")).rejects.toThrow("main disk denied");
    expect(await local.isAccountLocallyDeleted("A")).toBe(true);
    expect(await rawRecord("workspaces", "account:A:workspace")).not.toBeUndefined();
    await expect(local.loadLocalWorkspaceRecord("A")).rejects.toMatchObject({
      code: "LOCAL_ACCOUNT_DELETED",
    });
    vi.restoreAllMocks();
    await expect(local.clearAccountLocalCache("A")).resolves.toEqual({
      deletedBlobs: 0,
      retainedBlobs: 0,
    });
    expect(await rawRecord("workspaces", "account:A:workspace")).toBeUndefined();
  });

  it("reports both independent cleanup failures and keeps the committed marker", async () => {
    await local.saveLocalWorkspace(createEmptyWorkspace(), "A", 0);
    const originalDelete = FakeIDBObjectStore.prototype.delete;
    const originalPut = FakeIDBObjectStore.prototype.put;
    vi.spyOn(FakeIDBObjectStore.prototype, "delete").mockImplementation(function (
      this: InstanceType<typeof FakeIDBObjectStore>,
      ...args: Parameters<typeof originalDelete>
    ) {
      if (this.transaction.db.name === "conuo-web" && this.name === "workspaces")
        throw new Error("main cleanup failed");
      return originalDelete.apply(this, args);
    });
    vi.spyOn(FakeIDBObjectStore.prototype, "put").mockImplementation(function (
      this: InstanceType<typeof FakeIDBObjectStore>,
      ...args: Parameters<typeof originalPut>
    ) {
      if (this.transaction.db.name === KNOWLEDGE_UPDATE_DRAFT_DATABASE)
        throw new Error("draft cleanup failed");
      return originalPut.apply(this, args);
    });
    const result = await local.clearAccountLocalCache("A").then(
      () => null,
      (error) => error,
    );
    expect(result).toBeInstanceOf(AggregateError);
    expect(result.errors).toHaveLength(2);
    expect(await local.isAccountLocallyDeleted("A")).toBe(true);
    await expect(local.loadLocalWorkspaceRecord("A")).rejects.toMatchObject({
      code: "LOCAL_ACCOUNT_DELETED",
    });
  });
});

type DeletionListener = (message: MessageEvent<unknown>) => void;
class DeletionChannel {
  static peers: DeletionChannel[] = [];
  static messages: unknown[] = [];
  listeners = new Set<DeletionListener>();
  closed = false;
  constructor(readonly name: string) {
    DeletionChannel.peers.push(this);
  }
  addEventListener(_type: string, listener: DeletionListener) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: DeletionListener) {
    this.listeners.delete(listener);
  }
  postMessage(value: unknown) {
    DeletionChannel.messages.push(structuredClone(value));
    for (const peer of DeletionChannel.peers) {
      if (peer !== this && !peer.closed && peer.name === this.name)
        for (const listener of peer.listeners)
          listener({ data: structuredClone(value) } as MessageEvent<unknown>);
    }
  }
  close() {
    this.closed = true;
    this.listeners.clear();
  }
}

describe("authoritative account-deletion notifications", () => {
  beforeEach(() => {
    DeletionChannel.peers = [];
    DeletionChannel.messages = [];
    vi.stubGlobal("window", {
      BroadcastChannel: DeletionChannel,
      crypto: { randomUUID: () => "writer-test" },
    });
  });

  it("publishes only committed identity metadata and validates the marker before notifying exact-owner peers", async () => {
    const a = vi.fn();
    const b = vi.fn();
    const stopA = local.subscribeLocalAccountDeletions("A", a);
    const stopB = local.subscribeLocalAccountDeletions("B", b);
    await local.markAccountLocalDeletion("A");
    await vi.waitFor(() => expect(a).toHaveBeenCalledOnce());
    expect(b).not.toHaveBeenCalled();
    expect(DeletionChannel.messages).toEqual([
      { schemaVersion: 1, accountId: "A", writerId: expect.any(String) },
    ]);
    expect(await local.isAccountLocallyDeleted("A")).toBe(true);
    stopA();
    stopA();
    stopB();
    expect(DeletionChannel.peers.every((peer) => peer.closed)).toBe(true);
  });

  it("never publishes the deletion notification before its marker transaction commits", async () => {
    await local.isAccountLocallyDeleted("A");
    const listener = vi.fn();
    const stop = local.subscribeLocalAccountDeletions("A", listener);
    const db = await openDB("conuo-web");
    const blocker = db.transaction("accountDeletions", "readwrite");
    let released = false;
    const keepAlive = async () => {
      await blocker.store.get("hold");
      if (!released) void keepAlive();
    };
    void keepAlive();
    const transactions = vi.spyOn(FakeIDBDatabase.prototype, "transaction");
    const marker = local.markAccountLocalDeletion("A");
    await vi.waitFor(() =>
      expect(transactions.mock.calls.some((call) => call[1] === "readwrite")).toBe(true),
    );
    expect(DeletionChannel.messages).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    released = true;
    await blocker.done;
    await marker;
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    stop();
    db.close();
  });

  it("does not publish or report deletion when writing the marker fails", async () => {
    await local.saveLocalWorkspace(createEmptyWorkspace(), "A", 0);
    DeletionChannel.messages = [];
    const originalPut = FakeIDBObjectStore.prototype.put;
    vi.spyOn(FakeIDBObjectStore.prototype, "put").mockImplementation(function (
      this: InstanceType<typeof FakeIDBObjectStore>,
      ...args: Parameters<typeof originalPut>
    ) {
      if (this.transaction.db.name === "conuo-web" && this.name === "accountDeletions")
        throw new Error("marker disk denied");
      return originalPut.apply(this, args);
    });
    await expect(local.markAccountLocalDeletion("A")).rejects.toThrow("marker disk denied");
    await expect(local.clearAccountLocalCache("A")).rejects.toThrow("marker disk denied");
    expect(DeletionChannel.messages).toEqual([]);
    expect(await local.isAccountLocallyDeleted("A")).toBe(false);
    expect(await local.loadLocalWorkspaceRecord("A")).not.toBeNull();
  });

  it("does not trust a forged message with no marker or a malformed marker", async () => {
    const a = vi.fn();
    const stop = local.subscribeLocalAccountDeletions("A", a);
    await local.isAccountLocallyDeleted("A");
    const sender = new DeletionChannel("conuo-local-account-deletions-v1");
    const reads = vi.spyOn(FakeIDBObjectStore.prototype, "get");
    sender.postMessage({ schemaVersion: 1, accountId: "A", writerId: "forged" });
    await vi.waitFor(() =>
      expect(
        reads.mock.instances.some(
          (store) => (store as InstanceType<typeof FakeIDBObjectStore>).name === "accountDeletions",
        ),
      ).toBe(true),
    );
    await local.isAccountLocallyDeleted("A");
    expect(a).not.toHaveBeenCalled();
    const db = await openDB("conuo-web");
    try {
      await db.put("accountDeletions", { schemaVersion: 1, accountId: "A", blocked: false }, "A");
    } finally {
      db.close();
    }
    sender.postMessage({ schemaVersion: 1, accountId: "A", writerId: "forged" });
    await expect(local.isAccountLocallyDeleted("A")).rejects.toThrow("标记无效");
    expect(a).not.toHaveBeenCalled();
    stop();
    sender.close();
  });

  it("ignores malformed and foreign-owner messages and fences callbacks after unsubscribe", async () => {
    await local.markAccountLocalDeletion("A");
    const a = vi.fn();
    const stop = local.subscribeLocalAccountDeletions("A", a);
    const sender = new DeletionChannel("conuo-local-account-deletions-v1");
    const reads = vi.spyOn(FakeIDBObjectStore.prototype, "get");
    for (const message of [
      null,
      [],
      { schemaVersion: 2, accountId: "A", writerId: "other" },
      { schemaVersion: 1, accountId: "B", writerId: "other" },
      { schemaVersion: 1, accountId: "A", writerId: "" },
      { schemaVersion: 1, accountId: "A", writerId: "other", body: "forbidden" },
    ])
      sender.postMessage(message);
    expect(reads).not.toHaveBeenCalled();
    sender.postMessage({ schemaVersion: 1, accountId: "A", writerId: "other" });
    stop();
    await local.isAccountLocallyDeleted("A");
    expect(a).not.toHaveBeenCalled();
    sender.close();
  });

  it("keeps the durable marker functional without BroadcastChannel or with broken posting", async () => {
    vi.stubGlobal("window", {});
    expect(() => local.subscribeLocalAccountDeletions("A", vi.fn())()).not.toThrow();
    await local.markAccountLocalDeletion("A");
    expect(await local.isAccountLocallyDeleted("A")).toBe(true);
    vi.stubGlobal("window", {
      BroadcastChannel: class {
        postMessage() {
          throw new Error("closed");
        }
        close() {
          throw new Error("close failed");
        }
      },
    });
    await expect(local.markAccountLocalDeletion("B")).resolves.toBeUndefined();
    expect(await local.isAccountLocallyDeleted("B")).toBe(true);
  });
});

describe("serialized deletion and admission transactions", () => {
  it.each(["save", "import", "recovery", "blob", "grant"] as const)(
    "clears after an earlier %s admission, and denies the same admission after the marker",
    async (kind) => {
      await local.isAccountLocallyDeleted("A");
      await local.putBlobIfAbsent("shared", new Blob(["shared"]), "local");
      const { workspace, key, bytes } = imported();
      const operation = () => {
        switch (kind) {
          case "save":
            return local.saveLocalWorkspace(createEmptyWorkspace(), "A", 0);
          case "import":
            return local.commitLocalImport("A", key, bytes, () => ({
              workspace,
              storeBlob: true,
              result: null,
            }));
          case "recovery":
            return local.saveLocalWorkspace(createEmptyWorkspace(), "recovery:A:123:token", 0);
          case "blob":
            return local.putBlobIfAbsent("A-orphan", bytes, "A");
          case "grant":
            return local.shareAnonymousOriginals("A", ["shared"]);
        }
      };
      const db = await openDB("conuo-web");
      const blocker = db.transaction(["accountDeletions", "workspaces", "blobs"], "readwrite");
      let released = false;
      const keepAlive = async () => {
        await blocker.objectStore("accountDeletions").get("hold");
        if (!released) void keepAlive();
      };
      void keepAlive();
      const transactions = vi.spyOn(FakeIDBDatabase.prototype, "transaction");
      const admission = operation().then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await vi.waitFor(() =>
        expect(transactions.mock.calls.some((call) => call[1] === "readwrite")).toBe(true),
      );
      const createdBeforeClear = transactions.mock.calls.length;
      const cleanup = local.clearAccountLocalCache("A");
      await vi.waitFor(() =>
        expect(transactions.mock.calls.length).toBeGreaterThan(createdBeforeClear),
      );
      released = true;
      await blocker.done;
      expect(await admission).not.toHaveProperty("error");
      await cleanup;
      db.close();
      expect(await local.isAccountLocallyDeleted("A")).toBe(true);
      expect(await rawRecord("workspaces", "account:A:workspace")).toBeUndefined();
      expect(
        await rawRecord("workspaces", "account:recovery:A:123:token:workspace"),
      ).toBeUndefined();
      expect(await rawRecord("blobs", key)).toBeUndefined();
      expect(await rawRecord("blobs", "A-orphan")).toBeUndefined();
      expect((await rawRecord("blobs", "shared")).ownerIds).toEqual(["local"]);
      await expect(operation()).rejects.toMatchObject({ code: "LOCAL_ACCOUNT_DELETED" });
    },
  );

  it.each(["save", "import", "recovery", "blob", "grant"] as const)(
    "denies a %s transaction queued after deletion began",
    async (kind) => {
      await local.isAccountLocallyDeleted("A");
      await local.putBlobIfAbsent("shared", new Blob(["shared"]), "local");
      const { workspace, key, bytes } = imported();
      const operation = () => {
        switch (kind) {
          case "save":
            return local.saveLocalWorkspace(createEmptyWorkspace(), "A", 0);
          case "import":
            return local.commitLocalImport("A", key, bytes, () => ({
              workspace,
              storeBlob: true,
              result: null,
            }));
          case "recovery":
            return local.saveLocalWorkspace(createEmptyWorkspace(), "recovery:A:123:token", 0);
          case "blob":
            return local.putBlobIfAbsent("A-orphan", bytes, "A");
          case "grant":
            return local.shareAnonymousOriginals("A", ["shared"]);
        }
      };
      const db = await openDB("conuo-web");
      const blocker = db.transaction(["accountDeletions", "workspaces", "blobs"], "readwrite");
      let released = false;
      const keepAlive = async () => {
        await blocker.objectStore("accountDeletions").get("hold");
        if (!released) void keepAlive();
      };
      void keepAlive();
      const transactions = vi.spyOn(FakeIDBDatabase.prototype, "transaction");
      const cleanup = local.clearAccountLocalCache("A");
      await vi.waitFor(() =>
        expect(transactions.mock.calls.some((call) => call[1] === "readwrite")).toBe(true),
      );
      const beforeAdmission = transactions.mock.calls.length;
      const admission = operation().then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await vi.waitFor(() =>
        expect(transactions.mock.calls.length).toBeGreaterThan(beforeAdmission),
      );
      released = true;
      await blocker.done;
      expect(await admission).toHaveProperty("error.code", "LOCAL_ACCOUNT_DELETED");
      await cleanup;
      db.close();
      expect(await rawRecord("workspaces", "account:A:workspace")).toBeUndefined();
      expect(
        await rawRecord("workspaces", "account:recovery:A:123:token:workspace"),
      ).toBeUndefined();
      expect(await rawRecord("blobs", key)).toBeUndefined();
      expect(await rawRecord("blobs", "A-orphan")).toBeUndefined();
      expect((await rawRecord("blobs", "shared")).ownerIds).toEqual(["local"]);
    },
  );
});
