import "fake-indexeddb/auto";
import { IDBFactory, IDBObjectStore as FakeIDBObjectStore } from "fake-indexeddb";
import { deleteDB, openDB } from "idb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  observeAccountDeletionFailure,
  subscribeConfirmedAccountDeletions,
} from "./account-deletion-observer";
import {
  getBlob,
  isAccountLocallyDeleted,
  loadLocalWorkspaceRecord,
  putBlobIfAbsent,
  saveLocalWorkspace,
} from "./local-store";
import { createEmptyWorkspace } from "./seed";
import { KNOWLEDGE_UPDATE_DRAFT_DATABASE } from "./knowledge-update-review-drafts";
import { webSessionStore } from "./web-session-store";

const subscriptions: (() => void)[] = [];
beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(async () => {
  for (const stop of subscriptions.splice(0)) stop();
  vi.restoreAllMocks();
  await deleteDB("conuo-web");
  await deleteDB(KNOWLEDGE_UPDATE_DRAFT_DATABASE);
  vi.unstubAllGlobals();
});
const confirmed = {
  status: 423,
  code: "ACCOUNT_DELETION_PENDING",
  message: "private content must not enter observation payload",
};

async function prepare() {
  for (const account of ["A", "B", "local"])
    await saveLocalWorkspace(createEmptyWorkspace(), account, 0);
  await putBlobIfAbsent("A-original", new Blob(["A"]), "A");
  await putBlobIfAbsent("B-original", new Blob(["B"]), "B");
}
async function raw(store: string, key: string) {
  const db = await openDB("conuo-web");
  try {
    return await db.get(store, key);
  } finally {
    db.close();
  }
}

describe("same-tab confirmed account deletion observer", () => {
  it("clears a cloud-only web account without accessing legacy browser persistence", async () => {
    const actor = "cloud-only-observer-actor";
    webSessionStore.beginSession(actor);
    await webSessionStore.saveLocal(createEmptyWorkspace(), actor, 0);
    await webSessionStore.putBlobIfAbsent("web-only-original", new Blob(["temporary"]), actor);
    const legacy = indexedDB;
    vi.stubGlobal("indexedDB", {
      open: () => {
        throw new Error("legacy browser database must not be accessed");
      },
    });
    try {
      expect(await observeAccountDeletionFailure(confirmed, actor)).toEqual({
        confirmed: true,
        cleanupFailed: false,
      });
      await expect(webSessionStore.getBlob("web-only-original", actor)).rejects.toMatchObject({
        code: "LOCAL_ACCOUNT_DELETED",
      });
      expect(webSessionStore.managesAccount(actor)).toBe(true);
    } finally {
      webSessionStore.clearSession();
      vi.stubGlobal("indexedDB", legacy);
    }
  });

  it("notifies synchronously with identity alone before durable cleanup and only clears captured A", async () => {
    await prepare();
    const listener = vi.fn();
    subscriptions.push(subscribeConfirmedAccountDeletions(listener));
    const observation = observeAccountDeletionFailure(confirmed, "A");
    expect(listener).toHaveBeenCalledExactlyOnceWith("A");
    expect(await observation).toEqual({ confirmed: true, cleanupFailed: false });
    expect(await isAccountLocallyDeleted("A")).toBe(true);
    expect(await isAccountLocallyDeleted("B")).toBe(false);
    expect(await raw("workspaces", "account:A:workspace")).toBeUndefined();
    expect(await raw("blobs", "A-original")).toBeUndefined();
    expect(await loadLocalWorkspaceRecord("B")).not.toBeNull();
    expect(await loadLocalWorkspaceRecord("local")).not.toBeNull();
    expect(await (await getBlob("B-original", "B"))!.text()).toBe("B");
  });

  it("still persists and clears with no subscribers or browser APIs", async () => {
    await prepare();
    expect(await observeAccountDeletionFailure(confirmed, "A")).toEqual({
      confirmed: true,
      cleanupFailed: false,
    });
    expect(await raw("workspaces", "account:A:workspace")).toBeUndefined();
    expect(await raw("blobs", "A-original")).toBeUndefined();
  });

  it("does not wait for subscriber drains that may need the adapter to return its error", async () => {
    await prepare();
    let reject!: (reason: unknown) => void;
    const pending = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    subscriptions.push(subscribeConfirmedAccountDeletions(() => pending));
    expect(await observeAccountDeletionFailure(confirmed, "A")).toEqual({
      confirmed: true,
      cleanupFailed: false,
    });
    reject(new Error("subscriber cleanup failed later"));
    await Promise.resolve();
    expect(await isAccountLocallyDeleted("A")).toBe(true);
  });

  it("observes a failing consumer and continues notifying other consumers and cleanup", async () => {
    await prepare();
    subscriptions.push(
      subscribeConfirmedAccountDeletions(() => {
        throw new Error("consumer failed");
      }),
    );
    const other = vi.fn();
    subscriptions.push(subscribeConfirmedAccountDeletions(other));
    expect(await observeAccountDeletionFailure(confirmed, "A")).toEqual({
      confirmed: true,
      cleanupFailed: false,
    });
    expect(other).toHaveBeenCalledExactlyOnceWith("A");
  });

  it("unsubscribes idempotently without disabling mandatory durable cleanup", async () => {
    await prepare();
    const listener = vi.fn();
    const stop = subscribeConfirmedAccountDeletions(listener);
    stop();
    stop();
    await observeAccountDeletionFailure(confirmed, "A");
    expect(listener).not.toHaveBeenCalled();
    expect(await isAccountLocallyDeleted("A")).toBe(true);
  });

  it("deduplicates concurrent cleanup without skipping immediate notifications", async () => {
    await prepare();
    const listener = vi.fn();
    subscriptions.push(subscribeConfirmedAccountDeletions(listener));
    const deletes = vi.spyOn(FakeIDBObjectStore.prototype, "delete");
    const observations = [
      observeAccountDeletionFailure(confirmed, "A"),
      observeAccountDeletionFailure(confirmed, "A"),
    ];
    expect(listener).toHaveBeenCalledTimes(2);
    expect(await Promise.all(observations)).toEqual([
      { confirmed: true, cleanupFailed: false },
      { confirmed: true, cleanupFailed: false },
    ]);
    expect(
      deletes.mock.calls.filter(
        (args, index) =>
          args[0] === "account:A:workspace" &&
          (deletes.mock.instances[index] as InstanceType<typeof FakeIDBObjectStore>).name ===
            "workspaces",
      ),
    ).toHaveLength(1);
  });

  it.each([
    null,
    {},
    new Error("network"),
    { status: 401, code: "ACCOUNT_DELETION_PENDING" },
    { status: 423, code: "OTHER_LOCK" },
    { status: "423", code: "ACCOUNT_DELETION_PENDING" },
    { status: 503, code: "CLOUD_ERROR" },
  ])("does not infer deletion from %j", async (reason) => {
    await prepare();
    const listener = vi.fn();
    subscriptions.push(subscribeConfirmedAccountDeletions(listener));
    expect(await observeAccountDeletionFailure(reason, "A")).toEqual({
      confirmed: false,
      cleanupFailed: false,
    });
    expect(listener).not.toHaveBeenCalled();
    expect(await isAccountLocallyDeleted("A")).toBe(false);
    expect(await loadLocalWorkspaceRecord("A")).not.toBeNull();
  });

  it.each(["local", "recovery:A:123:token", "", " A", "A "])(
    "rejects unbound actor %j without touching valid accounts",
    async (actor) => {
      await prepare();
      const listener = vi.fn();
      subscriptions.push(subscribeConfirmedAccountDeletions(listener));
      expect(await observeAccountDeletionFailure(confirmed, actor)).toEqual({
        confirmed: false,
        cleanupFailed: false,
      });
      expect(listener).not.toHaveBeenCalled();
      expect(await isAccountLocallyDeleted("A")).toBe(false);
    },
  );

  it("does not trust an unreadable proxy error or overwrite its observation", async () => {
    await prepare();
    const reason = new Proxy(
      {},
      {
        has() {
          throw new Error("unreadable");
        },
      },
    );
    expect(await observeAccountDeletionFailure(reason, "A")).toEqual({
      confirmed: false,
      cleanupFailed: false,
    });
    expect(await isAccountLocallyDeleted("A")).toBe(false);
  });

  it("reports marker failure without changing the original error", async () => {
    await prepare();
    const originalPut = FakeIDBObjectStore.prototype.put;
    vi.spyOn(FakeIDBObjectStore.prototype, "put").mockImplementation(function (
      this: InstanceType<typeof FakeIDBObjectStore>,
      ...args: Parameters<typeof originalPut>
    ) {
      if (this.transaction.db.name === "conuo-web" && this.name === "accountDeletions")
        throw new Error("marker disk denied");
      return originalPut.apply(this, args);
    });
    const error = { ...confirmed };
    expect(await observeAccountDeletionFailure(error, "A")).toEqual({
      confirmed: true,
      cleanupFailed: true,
    });
    expect(error).toEqual(confirmed);
    expect(await isAccountLocallyDeleted("A")).toBe(false);
    expect(await raw("blobs", "A-original")).not.toBeUndefined();
  });

  it("reports cleanup failure but preserves the already committed access fence", async () => {
    await prepare();
    const originalDelete = FakeIDBObjectStore.prototype.delete;
    vi.spyOn(FakeIDBObjectStore.prototype, "delete").mockImplementation(function (
      this: InstanceType<typeof FakeIDBObjectStore>,
      ...args: Parameters<typeof originalDelete>
    ) {
      if (this.transaction.db.name === "conuo-web" && this.name === "workspaces")
        throw new Error("cache disk denied");
      return originalDelete.apply(this, args);
    });
    expect(await observeAccountDeletionFailure(confirmed, "A")).toEqual({
      confirmed: true,
      cleanupFailed: true,
    });
    expect(await isAccountLocallyDeleted("A")).toBe(true);
    await expect(loadLocalWorkspaceRecord("A")).rejects.toMatchObject({
      code: "LOCAL_ACCOUNT_DELETED",
    });
  });
});
