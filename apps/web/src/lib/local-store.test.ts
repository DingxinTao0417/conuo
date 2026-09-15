import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceData } from "./types";
import {
  deleteBlob,
  getBlob,
  loadLocalWorkspace,
  putBlob,
  saveLocalWorkspace,
  subscribeLocalWorkspaceCommits,
} from "./local-store";

const stores = vi.hoisted(() => ({
  workspaces: new Map<string, unknown>(),
  blobs: new Map<string, unknown>(),
  accountDeletions: new Map<string, unknown>(),
}));
const transactionState = vi.hoisted((): { done: Promise<void> } => ({
  done: Promise.resolve(undefined),
}));
vi.mock("idb", () => ({
  openDB: async () => ({
    get: async (store: keyof typeof stores, key: string) => structuredClone(stores[store].get(key)),
    put: async (store: keyof typeof stores, value: unknown, key: string) => {
      stores[store].set(key, structuredClone(value));
    },
    add: async (store: keyof typeof stores, value: unknown, key: string) => {
      if (stores[store].has(key)) throw new DOMException("Key exists", "ConstraintError");
      stores[store].set(key, structuredClone(value));
    },
    delete: async (store: keyof typeof stores, key: string) => {
      stores[store].delete(key);
    },
    transaction: (scope: keyof typeof stores | Array<keyof typeof stores>) => {
      const objectStore = (store: keyof typeof stores) => ({
        get: async (key: string) => structuredClone(stores[store].get(key)),
        put: async (value: unknown, key: string) => {
          stores[store].set(key, structuredClone(value));
        },
        add: async (value: unknown, key: string) => {
          if (stores[store].has(key)) throw new DOMException("Key exists", "ConstraintError");
          stores[store].set(key, structuredClone(value));
        },
        getAll: async () => structuredClone([...stores[store].values()]),
        getAllKeys: async () => [...stores[store].keys()],
        delete: async (key: string) => {
          stores[store].delete(key);
        },
      });
      return {
        done: transactionState.done,
        store: Array.isArray(scope) ? undefined : objectStore(scope),
        objectStore,
        abort: vi.fn(),
      };
    },
    close: vi.fn(),
  }),
}));

type BroadcastListener = (event: MessageEvent<unknown>) => void;

class FakeBroadcastChannel {
  static readonly instances: FakeBroadcastChannel[] = [];
  static readonly sent: unknown[] = [];

  readonly listeners = new Set<BroadcastListener>();
  closed = false;

  constructor(readonly name: string) {
    FakeBroadcastChannel.instances.push(this);
  }

  postMessage(message: unknown) {
    if (this.closed) throw new Error("channel closed");
    FakeBroadcastChannel.sent.push(structuredClone(message));
    for (const peer of FakeBroadcastChannel.instances) {
      if (peer === this || peer.closed || peer.name !== this.name) continue;
      for (const listener of peer.listeners) {
        listener({ data: structuredClone(message) } as MessageEvent<unknown>);
      }
    }
  }

  addEventListener(type: string, listener: BroadcastListener) {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: BroadcastListener) {
    if (type === "message") this.listeners.delete(listener);
  }

  close() {
    this.closed = true;
    this.listeners.clear();
  }

  static reset() {
    FakeBroadcastChannel.instances.length = 0;
    FakeBroadcastChannel.sent.length = 0;
  }
}

function installBroadcastChannel() {
  vi.stubGlobal("window", {
    BroadcastChannel: FakeBroadcastChannel,
    crypto: { randomUUID: () => "writer-under-test" },
  });
}

function deferred() {
  let resolve!: () => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function workspace(): WorkspaceData {
  return {
    schemaVersion: 1,
    spaces: [],
    sources: [],
    notes: [],
    annotations: [],
    conversations: [],
    aiEnabled: true,
  };
}

beforeEach(() => {
  stores.workspaces.clear();
  stores.blobs.clear();
  stores.accountDeletions.clear();
  transactionState.done = Promise.resolve();
  FakeBroadcastChannel.reset();
  vi.stubGlobal("indexedDB", {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local persistence boundary", () => {
  it("keeps anonymous local data and separate authenticated accounts apart", async () => {
    const local = workspace();
    const cloud = { ...workspace(), aiEnabled: false };
    await saveLocalWorkspace(local);
    await saveLocalWorkspace(cloud, "account-a");
    expect(await loadLocalWorkspace("account-b")).toBeNull();
    expect((await loadLocalWorkspace())?.aiEnabled).toBe(true);
    expect((await loadLocalWorkspace("account-a"))?.aiEnabled).toBe(false);
    await expect(saveLocalWorkspace(cloud, "  ")).rejects.toThrow("缺少工作区身份");
  });

  it("takes a snapshot before asynchronous writes and does not silently reset unknown formats", async () => {
    const data = workspace();
    const pending = saveLocalWorkspace(data);
    data.aiEnabled = false;
    await pending;
    expect((await loadLocalWorkspace())?.aiEnabled).toBe(true);
    stores.workspaces.set("account:future:workspace", { schemaVersion: 99 });
    await expect(loadLocalWorkspace("future")).rejects.toThrow("格式暂不受支持");
  });

  it("round-trips original bytes and removes only the requested original", async () => {
    await putBlob("file-a", new Blob(["原始资料"]));
    await putBlob("file-b", new Blob(["another"]));
    expect(await (await getBlob("file-a"))?.text()).toBe("原始资料");
    await deleteBlob("file-a");
    expect(await getBlob("file-a")).toBeUndefined();
    expect(await (await getBlob("file-b"))?.text()).toBe("another");
  });

  it("reports unavailable storage instead of reporting a saved state", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(loadLocalWorkspace()).rejects.toThrow("无法使用本地存储");
  });

  it("broadcasts only commit metadata after the IndexedDB transaction commits", async () => {
    installBroadcastChannel();
    const pendingTransaction = deferred();
    transactionState.done = pendingTransaction.promise;

    const save = saveLocalWorkspace(workspace(), "account-a");
    await vi.waitFor(() => expect(stores.workspaces.has("account:account-a:workspace")).toBe(true));
    expect(FakeBroadcastChannel.sent).toHaveLength(0);

    pendingTransaction.resolve();
    const localRevision = await save;
    expect(FakeBroadcastChannel.sent).toHaveLength(1);
    expect(FakeBroadcastChannel.sent[0]).toEqual({
      accountId: "account-a",
      localRevision,
      writerId: expect.any(String),
    });
    expect(Object.keys(FakeBroadcastChannel.sent[0] as object).sort()).toEqual([
      "accountId",
      "localRevision",
      "writerId",
    ]);
    expect(FakeBroadcastChannel.instances.at(-1)?.closed).toBe(true);
  });

  it("delivers same-account foreign revisions while filtering self, other accounts and payloads", async () => {
    installBroadcastChannel();
    const received: Array<{ accountId: string; localRevision: number; writerId: string }> = [];
    const unsubscribe = subscribeLocalWorkspaceCommits("account-a", (event) => {
      received.push(event);
    });
    const subscriptionChannel = FakeBroadcastChannel.instances[0];

    await saveLocalWorkspace(workspace(), "account-a");
    expect(received).toEqual([]);

    const foreign = new FakeBroadcastChannel(subscriptionChannel.name);
    foreign.postMessage({ accountId: "account-b", localRevision: 4, writerId: "foreign" });
    foreign.postMessage({ accountId: "account-a", localRevision: 0, writerId: "foreign" });
    foreign.postMessage({
      accountId: "account-a",
      localRevision: 4,
      writerId: "foreign",
      content: "must not cross the channel",
    });
    foreign.postMessage({ accountId: "account-a", localRevision: 4, writerId: "foreign" });
    foreign.postMessage({ accountId: "account-a", localRevision: 2, writerId: "foreign" });

    expect(received).toEqual([
      { accountId: "account-a", localRevision: 4, writerId: "foreign" },
      { accountId: "account-a", localRevision: 2, writerId: "foreign" },
    ]);
    unsubscribe();
    foreign.close();
  });

  it("closes subscriptions idempotently and stops future delivery", () => {
    installBroadcastChannel();
    const listener = vi.fn();
    const unsubscribe = subscribeLocalWorkspaceCommits("account-a", listener);
    const subscriptionChannel = FakeBroadcastChannel.instances[0];
    const foreign = new FakeBroadcastChannel(subscriptionChannel.name);

    unsubscribe();
    unsubscribe();
    foreign.postMessage({ accountId: "account-a", localRevision: 1, writerId: "foreign" });

    expect(listener).not.toHaveBeenCalled();
    expect(subscriptionChannel.closed).toBe(true);
    expect(subscriptionChannel.listeners.size).toBe(0);
    foreign.close();
  });

  it("keeps successful saves usable when BroadcastChannel is unavailable or broken", async () => {
    vi.stubGlobal("window", {});
    expect(() => subscribeLocalWorkspaceCommits("account-a", vi.fn())).not.toThrow();
    await expect(saveLocalWorkspace(workspace(), "account-a")).resolves.toBe(1);

    class BrokenBroadcastChannel extends FakeBroadcastChannel {
      override postMessage() {
        throw new Error("broken channel");
      }
    }
    vi.stubGlobal("window", {
      BroadcastChannel: BrokenBroadcastChannel,
      crypto: { randomUUID: () => "writer-under-test" },
    });
    await expect(saveLocalWorkspace(workspace(), "account-b")).resolves.toBe(1);
    expect(BrokenBroadcastChannel.instances.at(-1)?.closed).toBe(true);
  });

  it("does not notify when compare-and-swap rejects a stale writer", async () => {
    installBroadcastChannel();
    await saveLocalWorkspace(workspace(), "account-a");
    FakeBroadcastChannel.sent.length = 0;

    await expect(saveLocalWorkspace(workspace(), "account-a", 0)).rejects.toMatchObject({
      code: "LOCAL_WORKSPACE_CONFLICT",
    });
    expect(FakeBroadcastChannel.sent).toHaveLength(0);
  });
});
