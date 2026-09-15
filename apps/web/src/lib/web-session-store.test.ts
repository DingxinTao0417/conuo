import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Source, WorkspaceData } from "./types";
import type { StoredLocalWorkspace } from "./local-store";
import {
  WebSessionAccountDeletedError,
  WebSessionStore,
  WebSessionWorkspaceConflictError,
} from "./web-session-store";

const now = "2026-09-15T08:00:00.000Z";

function source(blobKey = "original-a"): Source {
  return {
    id: "source-a",
    versionId: "version-a",
    title: "资料",
    filename: "资料.txt",
    kind: "text",
    mime: "text/plain",
    size: 8,
    hash: "hash-a",
    spaceIds: [],
    tags: [],
    status: "ready",
    text: "原始资料",
    chunks: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    aiAllowed: true,
    starred: false,
    blobKey,
  };
}

function workspace(original?: Source): WorkspaceData {
  return {
    schemaVersion: 1,
    spaces: [],
    sources: original ? [original] : [],
    notes: [],
    annotations: [],
    conversations: [],
    aiEnabled: true,
  };
}

let store: WebSessionStore;

beforeEach(() => {
  store = new WebSessionStore();
  store.beginSession("account-a");
});

afterEach(() => vi.unstubAllGlobals());

describe("web cloud coordinator's temporary session memory", () => {
  it("requires a verified active account before any workspace or original access", async () => {
    const fresh = new WebSessionStore();
    await expect(fresh.loadLocal("account-a")).rejects.toThrow("请先登录");
    await expect(fresh.saveLocal(workspace(), "account-a")).rejects.toThrow("请先登录");
    await expect(fresh.getBlob("original-a", "account-a")).rejects.toThrow("请先登录");
    await expect(fresh.putBlobIfAbsent("original-a", new Blob(), "account-a")).rejects.toThrow(
      "请先登录",
    );
  });

  it.each([undefined, "", "local", " account-a", "account-a ", "recovery:local:1:token"])(
    "rejects anonymous or malformed identities %s without changing current data",
    async (accountId) => {
      await store.saveLocal(workspace(), "account-a");
      await expect(store.loadLocal(accountId)).rejects.toThrow();
      await expect(store.saveLocal(workspace(), accountId)).rejects.toThrow();
      await expect(store.getBlob("original-a", accountId)).rejects.toThrow();
      expect((await store.loadLocal("account-a"))?._conuoLocalRevision).toBe(1);
    },
  );

  it("snapshots both requested writes and returned reads and keeps sync metadata", async () => {
    const input: StoredLocalWorkspace = {
      ...workspace(),
      _conuoSync: { revision: 4, dirty: true, base: workspace() },
    };
    const save = store.saveLocal(input, "account-a", 0);
    input.aiEnabled = false;
    expect(await save).toBe(1);
    const loaded = await store.loadLocal("account-a");
    expect(loaded?.aiEnabled).toBe(true);
    expect(loaded?._conuoSync).toEqual({ revision: 4, dirty: true, base: workspace() });
    loaded!.aiEnabled = false;
    expect((await store.loadLocal("account-a"))?.aiEnabled).toBe(true);
  });

  it("uses CAS so concurrent stale saves cannot overwrite newer memory", async () => {
    const writes = await Promise.allSettled([
      store.saveLocal(workspace(), "account-a", 0),
      store.saveLocal({ ...workspace(), aiEnabled: false }, "account-a", 0),
    ]);
    expect(writes[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(writes[1]).toMatchObject({
      status: "rejected",
      reason: { code: "LOCAL_WORKSPACE_CONFLICT" },
    });
    expect((await store.loadLocal("account-a"))?.aiEnabled).toBe(true);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe expected revisions %s without writing",
    async (revision) => {
      await expect(store.saveLocal(workspace(), "account-a", revision)).rejects.toThrow(
        "预期版本无效",
      );
      expect(await store.loadLocal("account-a")).toBeNull();
    },
  );

  it("rejects unknown schema fields and another account's cloud paths at the boundary", async () => {
    await expect(
      store.saveLocal({ ...workspace(), schemaVersion: 99 } as never, "account-a"),
    ).rejects.toThrow("格式无效");
    await expect(
      store.saveLocal({ ...workspace(), injectedOwner: "account-a" } as never, "account-a"),
    ).rejects.toThrow("格式无效");
    await expect(
      store.saveLocal(workspace({ ...source(), storagePath: "account-b/original" }), "account-a"),
    ).rejects.toThrow("不属于当前账号");
    expect(await store.loadLocal("account-a")).toBeNull();
  });

  it("preserves in-progress originals when the same account is activated again", async () => {
    await store.saveLocal(workspace(), "account-a");
    await store.putBlobIfAbsent("original-a", new Blob(["original"]), "account-a");
    store.beginSession("account-a");
    expect((await store.loadLocal("account-a"))?._conuoLocalRevision).toBe(1);
    expect(await (await store.getBlob("original-a", "account-a"))?.text()).toBe("original");
  });

  it("discards the previous account on switching and rejects guessed owner identifiers", async () => {
    await store.saveLocal(workspace(source()), "account-a");
    await store.putBlobIfAbsent("original-a", new Blob(["private-a"]), "account-a");
    store.beginSession("account-b");
    await expect(store.loadLocal("account-a")).rejects.toThrow("不属于当前登录账号");
    await expect(store.getBlob("original-a", "account-a")).rejects.toThrow("不属于当前登录账号");
    await expect(store.loadLocal("recovery:account-a:1:token")).rejects.toThrow(
      "不属于当前登录账号",
    );
    expect(await store.getBlob("original-a", "account-b")).toBeUndefined();
    store.beginSession("account-a");
    expect(await store.loadLocal("account-a")).toBeNull();
    expect(await store.getBlob("original-a", "account-a")).toBeUndefined();
  });

  it("retains only explicitly admitted recovery snapshots and denies recovery original ownership", async () => {
    const recoveryId = "recovery:account-a:1:token";
    expect(await store.loadLocal(recoveryId)).toBeNull();
    await store.saveLocal(workspace(source()), recoveryId);
    await store.putBlobIfAbsent("original-a", new Blob(["bytes"]), "account-a");
    expect((await store.loadLocal(recoveryId))?.sources).toHaveLength(1);
    await expect(store.getBlob("original-a", recoveryId)).rejects.toThrow("请先登录");
    await expect(store.loadLocal("recovery:account-a:not-a-timestamp:token")).rejects.toThrow(
      "所属账号无效",
    );
    await expect(store.loadLocal("recovery:account-a:1:")).rejects.toThrow("所属账号无效");
    expect(await store.deleteUnreferencedBlob("original-a", "account-a")).toBe(false);
  });

  it("reserves immutable originals without replacing bytes on a key collision", async () => {
    expect(await store.putBlobIfAbsent("original-a", new Blob(["first"]), "account-a")).toBe(true);
    expect(await store.putBlobIfAbsent("original-a", new Blob(["replacement"]), "account-a")).toBe(
      false,
    );
    expect(await (await store.getBlob("original-a", "account-a"))?.text()).toBe("first");
  });

  it("commits workspace and original together and returns an independent snapshot", async () => {
    const committed = await store.commitLocalImport(
      "account-a",
      "original-a",
      new Blob(["bytes"]),
      (latest) => {
        expect(latest).toBeNull();
        return { workspace: workspace(source()), storeBlob: true, result: { imported: true } };
      },
    );
    expect(committed).toMatchObject({
      localRevision: 1,
      blobStored: true,
      result: { imported: true },
    });
    expect(await (await store.getBlob("original-a", "account-a"))?.text()).toBe("bytes");
    committed.workspace.sources[0].title = "mutated";
    expect((await store.loadLocal("account-a"))?.sources[0].title).toBe("资料");
  });

  it("never stores the original when a merger throws or its workspace is invalid", async () => {
    await expect(
      store.commitLocalImport("account-a", "original-a", new Blob(), () => {
        throw new Error("quota rejected");
      }),
    ).rejects.toThrow("quota rejected");
    await expect(
      store.commitLocalImport("account-a", "original-a", new Blob(), () => ({
        workspace: { ...workspace(source()), schemaVersion: 99 } as never,
        storeBlob: true,
        result: null,
      })),
    ).rejects.toThrow("格式无效");
    expect(await store.getBlob("original-a", "account-a")).toBeUndefined();
    expect(await store.loadLocal("account-a")).toBeNull();
  });

  it("rejects an orphan original or missing original without either write", async () => {
    await expect(
      store.commitLocalImport("account-a", "original-a", new Blob(), () => ({
        workspace: workspace(),
        storeBlob: true,
        result: null,
      })),
    ).rejects.toThrow("没有引用");
    await expect(
      store.commitLocalImport("account-a", "original-a", new Blob(), () => ({
        workspace: workspace(source()),
        storeBlob: false,
        result: null,
      })),
    ).rejects.toThrow("不存在或不属于");
    expect(await store.getBlob("original-a", "account-a")).toBeUndefined();
    expect(await store.loadLocal("account-a")).toBeNull();
  });

  it("reads a failed merger result before publishing either original or workspace", async () => {
    await expect(
      store.commitLocalImport("account-a", "original-a", new Blob(), () => ({
        workspace: workspace(source()),
        storeBlob: true,
        get result() {
          throw new Error("result rejected");
        },
      })),
    ).rejects.toThrow("result rejected");
    expect(await store.getBlob("original-a", "account-a")).toBeUndefined();
    expect(await store.loadLocal("account-a")).toBeNull();
  });

  it("keeps existing originals and the workspace unchanged on an import collision", async () => {
    await store.saveLocal(workspace(), "account-a");
    await store.putBlobIfAbsent("original-a", new Blob(["first"]), "account-a");
    await expect(
      store.commitLocalImport("account-a", "original-a", new Blob(["second"]), () => ({
        workspace: workspace(source()),
        storeBlob: true,
        result: null,
      })),
    ).rejects.toThrow("标识已存在");
    expect((await store.loadLocal("account-a"))?.sources).toEqual([]);
    expect((await store.loadLocal("account-a"))?._conuoLocalRevision).toBe(1);
    expect(await (await store.getBlob("original-a", "account-a"))?.text()).toBe("first");
  });

  it("can restore a workspace using an original already admitted for the active owner", async () => {
    await store.putBlobIfAbsent("original-a", new Blob(["restored"]), "account-a");
    const commit = await store.commitLocalImport(
      "account-a",
      "original-a",
      new Blob(["unused"]),
      () => ({ workspace: workspace(source()), storeBlob: false, result: "restored" }),
    );
    expect(commit.blobStored).toBe(false);
    expect(await (await store.getBlob("original-a", "account-a"))?.text()).toBe("restored");
  });

  it("rechecks the newest snapshot when two admissions are requested concurrently", async () => {
    const merge = vi.fn((latest: StoredLocalWorkspace | null) => ({
      workspace: latest ?? workspace(source()),
      storeBlob: latest === null,
      result: latest === null ? "new" : "duplicate",
    }));
    const commits = await Promise.all([
      store.commitLocalImport("account-a", "original-a", new Blob(["first"]), merge),
      store.commitLocalImport("account-a", "original-a", new Blob(["second"]), merge),
    ]);
    expect(commits.map((commit) => commit.result)).toEqual(["new", "duplicate"]);
    expect(commits.map((commit) => commit.localRevision)).toEqual([1, 2]);
    expect(await (await store.getBlob("original-a", "account-a"))?.text()).toBe("first");
  });

  it("CAS failure from a reentrant merger never writes its blob or stale workspace", async () => {
    await expect(
      store.commitLocalImport("account-a", "original-a", new Blob(["stale"]), () => {
        void store.saveLocal({ ...workspace(), aiEnabled: false }, "account-a", 0);
        return { workspace: workspace(source()), storeBlob: true, result: null };
      }),
    ).rejects.toBeInstanceOf(WebSessionWorkspaceConflictError);
    expect((await store.loadLocal("account-a"))?.aiEnabled).toBe(false);
    expect(await store.getBlob("original-a", "account-a")).toBeUndefined();
  });

  it("rejects an admission crossing a sign-out and sign-in even if the CAS revision matches", async () => {
    await expect(
      store.commitLocalImport("account-a", "original-a", new Blob(), () => {
        store.clearSession();
        store.beginSession("account-a");
        return { workspace: workspace(source()), storeBlob: true, result: null };
      }),
    ).rejects.toBeInstanceOf(WebSessionWorkspaceConflictError);
    expect(await store.getBlob("original-a", "account-a")).toBeUndefined();
  });

  it("keeps originals referenced by live or historical versions until references are removed", async () => {
    const current = source("current-original");
    current.versions = [
      {
        ...source("historical-original"),
        versionId: "historical-version",
        createdAt: now,
        archivedAt: now,
      },
    ];
    // SourceVersion intentionally excludes live-only fields.
    const { id, spaceIds, tags, updatedAt, deletedAt, aiAllowed, starred, ...version } = current
      .versions[0] as Source & { archivedAt: string };
    void [id, spaceIds, tags, updatedAt, deletedAt, aiAllowed, starred];
    current.versions = [version];
    await store.saveLocal(workspace(current), "account-a");
    await store.putBlobIfAbsent("historical-original", new Blob(["history"]), "account-a");
    expect(await store.deleteUnreferencedBlob("historical-original", "account-a")).toBe(false);
    await store.saveLocal(workspace(), "account-a");
    expect(await store.deleteUnreferencedBlob("historical-original", "account-a")).toBe(true);
    expect(await store.getBlob("historical-original", "account-a")).toBeUndefined();
  });

  it("deletion fences block access, survive sign-out, and notify exact subscribers only", async () => {
    const current = vi.fn();
    const other = vi.fn();
    const unsubscribed = vi.fn();
    store.subscribeLocalAccountDeletions("account-a", current);
    store.subscribeLocalAccountDeletions("account-b", other);
    const unsubscribe = store.subscribeLocalAccountDeletions("account-a", unsubscribed);
    unsubscribe();
    await store.markAccountLocalDeletion("account-a");
    await store.markAccountLocalDeletion("account-a");
    expect(current).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
    expect(unsubscribed).not.toHaveBeenCalled();
    await expect(store.loadLocal("account-a")).rejects.toBeInstanceOf(
      WebSessionAccountDeletedError,
    );
    await expect(store.putBlobIfAbsent("original-a", new Blob(), "account-a")).rejects.toThrow(
      "已提交注销",
    );
    store.clearSession();
    expect(await store.isAccountLocallyDeleted("account-a")).toBe(true);
    expect(() => store.beginSession("account-a")).toThrow("已提交注销");
    store.reset();
    expect(() => store.beginSession("account-a")).toThrow("已提交注销");
  });

  it("clears exact account memory and recovery originals while preserving another active account", async () => {
    await store.putBlobIfAbsent("original-a", new Blob(), "account-a");
    await store.saveLocal(workspace(source()), "recovery:account-a:1:token");
    expect(await store.clearAccountLocalCache("account-a")).toEqual({
      deletedBlobs: 1,
      retainedBlobs: 0,
    });
    store.beginSession("account-b");
    await store.saveLocal(workspace(), "account-b");
    await store.putBlobIfAbsent("original-b", new Blob(["b"]), "account-b");
    expect(await store.clearAccountLocalCache("account-a")).toEqual({
      deletedBlobs: 0,
      retainedBlobs: 0,
    });
    expect((await store.loadLocal("account-b"))?._conuoLocalRevision).toBe(1);
    expect(await (await store.getBlob("original-b", "account-b"))?.text()).toBe("b");
  });

  it("releases all session bytes on sign-out and a fresh page starts with no persisted copy", async () => {
    await store.saveLocal(workspace(source()), "account-a");
    await store.putBlobIfAbsent("original-a", new Blob(["bytes"]), "account-a");
    store.clearSession("account-a");
    await expect(store.loadLocal("account-a")).rejects.toThrow("请先登录");
    store.beginSession("account-a");
    expect(await store.loadLocal("account-a")).toBeNull();
    expect(await store.getBlob("original-a", "account-a")).toBeUndefined();
    const nextPage = new WebSessionStore();
    nextPage.beginSession("account-a");
    expect(await nextPage.loadLocal("account-a")).toBeNull();
  });

  it("imports and clears even when accessing any browser persistence API would throw", async () => {
    const accessed = vi.fn(() => {
      throw new Error("browser persistence must never be accessed");
    });
    const guarded = Object.defineProperties(
      {},
      Object.fromEntries(
        ["indexedDB", "localStorage", "sessionStorage", "BroadcastChannel"].map((name) => [
          name,
          { get: accessed },
        ]),
      ),
    );
    vi.stubGlobal("window", guarded);
    const oldDescriptors = new Map<string, PropertyDescriptor | undefined>();
    for (const name of ["indexedDB", "localStorage", "sessionStorage", "BroadcastChannel"]) {
      oldDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, get: accessed });
    }
    try {
      vi.resetModules();
      const { WebSessionStore: FreshStore } = await import("./web-session-store");
      const fresh = new FreshStore();
      fresh.beginSession("account-a");
      await fresh.commitLocalImport("account-a", "original-a", new Blob(["bytes"]), () => ({
        workspace: workspace(source()),
        storeBlob: true,
        result: null,
      }));
      expect(await (await fresh.getBlob("original-a", "account-a"))?.text()).toBe("bytes");
      await fresh.saveLocal(workspace(), "account-a", 1);
      await fresh.deleteUnreferencedBlob("original-a", "account-a");
      await fresh.clearAccountLocalCache("account-a");
      fresh.clearSession();
      fresh.reset();
      expect(accessed).not.toHaveBeenCalled();
    } finally {
      for (const [name, descriptor] of oldDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
});
