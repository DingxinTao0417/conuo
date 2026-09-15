import "fake-indexeddb/auto";
import { IDBFactory, IDBObjectStore as FakeIDBObjectStore } from "fake-indexeddb";
import { deleteDB, openDB } from "idb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAccountLocalCache,
  commitLocalImport,
  deleteUnreferencedBlob,
  getBlob,
  loadLocalWorkspaceRecord,
  loadLocalWorkspace,
  LocalAccountDeletedError,
  LocalWorkspaceConflictError,
  putBlobIfAbsent,
  saveLocalWorkspace,
  type StoredLocalWorkspace,
} from "./local-store";
import { createImportJob } from "./import-queue";
import { assessImportQuota, type ImportQuotaPolicy } from "./import-quota";
import { createEmptyWorkspace } from "./seed";
import type { Source, WorkspaceData } from "./types";

const key = "original:source-a:version-a";
const currentKey = "original:source-a:current-version";
const timestamp = "2026-09-12T00:00:00.000Z";

beforeEach(() => {
  // Each test owns an independent in-memory IndexedDB factory; idb itself is never mocked.
  vi.stubGlobal("indexedDB", new IDBFactory());
});

afterEach(async () => {
  await deleteDB("conuo-web");
  vi.unstubAllGlobals();
});

function reference(location: "current" | "history", deleted = false): WorkspaceData {
  const data = createEmptyWorkspace();
  const source: Source = {
    id: "source-a",
    versionId: "current-version",
    title: "原件保护",
    filename: "current.txt",
    kind: "text",
    mime: "text/plain",
    hash: "a".repeat(64),
    size: 6,
    text: "原文",
    chunks: [],
    status: "ready",
    spaceIds: [],
    tags: [],
    aiAllowed: false,
    starred: false,
    deletedAt: deleted ? timestamp : null,
    createdAt: timestamp,
    updatedAt: timestamp,
    blobKey: location === "current" ? key : "original:source-a:current-version",
  };
  if (location === "history")
    source.versions = [
      {
        versionId: "version-a",
        title: "旧原件",
        filename: "old.txt",
        kind: "text",
        mime: "text/plain",
        hash: "b".repeat(64),
        size: 6,
        text: "旧文",
        chunks: [],
        status: "ready",
        blobKey: key,
        createdAt: timestamp,
        archivedAt: timestamp,
      },
    ];
  data.sources.push(source);
  return data;
}

async function rawWorkspace(value: unknown, storageKey = "account:damaged:workspace") {
  const db = await openDB("conuo-web");
  try {
    await db.put("workspaces", value, storageKey);
  } finally {
    db.close();
  }
}

async function expectClearedAccount(accountId: string, ownerId = accountId) {
  const db = await openDB("conuo-web");
  try {
    expect(await db.get("workspaces", `account:${accountId}:workspace`)).toBeUndefined();
    expect(await db.get("accountDeletions", ownerId)).toEqual({
      schemaVersion: 1,
      accountId: ownerId,
      blocked: true,
    });
  } finally {
    db.close();
  }
  await expect(loadLocalWorkspace(accountId)).rejects.toBeInstanceOf(LocalAccountDeletedError);
  await expect(loadLocalWorkspaceRecord(accountId)).rejects.toBeInstanceOf(
    LocalAccountDeletedError,
  );
}

function importedSource(
  id: string,
  hashCharacter: string,
  size: number,
  spaceIds: string[],
): Source {
  const versionId = `version-${id}`;
  return {
    id,
    versionId,
    title: id,
    filename: `${id}.txt`,
    kind: "text",
    mime: "text/plain",
    hash: hashCharacter.repeat(64),
    size,
    text: "",
    chunks: [],
    status: "parsing",
    coverage: { captureScope: "full", parseState: "pending" },
    spaceIds,
    tags: [],
    aiAllowed: false,
    starred: false,
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    blobKey: `original:${id}:${versionId}`,
  };
}

describe("atomic local import commits", () => {
  it("increments the local revision and accepts a save against the current revision", async () => {
    const initial = createEmptyWorkspace();
    const firstRevision = await saveLocalWorkspace(initial, "account-a", 0);
    const changed = { ...initial, aiEnabled: false };
    const secondRevision = await saveLocalWorkspace(changed, "account-a", firstRevision);

    expect(firstRevision).toBe(1);
    expect(secondRevision).toBe(2);
    expect(await loadLocalWorkspaceRecord("account-a")).toEqual({
      ...changed,
      _conuoLocalRevision: 2,
    });
    expect(await loadLocalWorkspace("account-a")).toEqual(changed);
  });

  it("rejects a stale expected revision without overwriting the newer workspace", async () => {
    const initial = createEmptyWorkspace();
    const firstRevision = await saveLocalWorkspace(initial, "account-a", 0);
    const latest = { ...initial, aiEnabled: false };
    await saveLocalWorkspace(latest, "account-a", firstRevision);

    await expect(
      saveLocalWorkspace({ ...initial, semanticSearch: true }, "account-a", firstRevision),
    ).rejects.toBeInstanceOf(LocalWorkspaceConflictError);

    expect(await loadLocalWorkspaceRecord("account-a")).toEqual({
      ...latest,
      _conuoLocalRevision: 2,
    });
  });

  it("does not let a pre-deletion revision recreate an account cache after clearing", async () => {
    const stale = createEmptyWorkspace();
    const staleRevision = await saveLocalWorkspace(stale, "account-a", 0);
    await clearAccountLocalCache("account-a");

    await expect(
      saveLocalWorkspace({ ...stale, autoOrganize: true }, "account-a", staleRevision),
    ).rejects.toBeInstanceOf(LocalAccountDeletedError);
    await expectClearedAccount("account-a");
  });

  it("prevents an old ordinary save from erasing an atomic import source, job, or original", async () => {
    const stale = createEmptyWorkspace();
    const staleRevision = await saveLocalWorkspace(stale, "account-a", 0);
    const source = importedSource("source-cas-import", "9", 4, []);
    const job = {
      ...createImportJob({
        sourceId: source.id,
        versionId: source.versionId,
        filename: source.filename,
        spaceId: "",
        at: timestamp,
      }),
      stage: "parsing" as const,
      originalSaved: true,
    };

    const committed = await commitLocalImport(
      "account-a",
      source.blobKey!,
      new Blob(["four"]),
      (latest) => ({
        workspace: {
          ...latest!,
          sources: [source, ...latest!.sources],
          importJobs: [job, ...(latest!.importJobs ?? [])],
        },
        storeBlob: true,
        result: source.id,
      }),
    );

    expect(committed.localRevision).toBe(2);
    await expect(
      saveLocalWorkspace({ ...stale, semanticSearch: true }, "account-a", staleRevision),
    ).rejects.toBeInstanceOf(LocalWorkspaceConflictError);

    const saved = await loadLocalWorkspaceRecord("account-a");
    expect(saved?._conuoLocalRevision).toBe(2);
    expect(saved?.sources).toEqual([source]);
    expect(saved?.importJobs).toEqual([job]);
    expect(await (await getBlob(source.blobKey!, "account-a"))?.text()).toBe("four");
  });

  it("stores an original and its exact account workspace in one commit", async () => {
    const initial: StoredLocalWorkspace = {
      ...createEmptyWorkspace(),
      _conuoSync: { revision: 7, dirty: true },
    };
    const source = importedSource("source-import", "a", 5, ["space-a"]);
    await saveLocalWorkspace(initial, "account-a");

    const committed = await commitLocalImport(
      "account-a",
      source.blobKey!,
      new Blob(["hello"]),
      (latest) => ({
        workspace: { ...latest!, sources: [source, ...latest!.sources] },
        storeBlob: true,
        result: { kind: "queued" as const, sourceId: source.id },
      }),
    );

    expect(committed.blobStored).toBe(true);
    expect(committed.result).toEqual({ kind: "queued", sourceId: source.id });
    expect(committed.workspace._conuoSync).toEqual({ revision: 7, dirty: true });
    expect(await (await getBlob(source.blobKey!, "account-a"))?.text()).toBe("hello");
    expect(await loadLocalWorkspaceRecord("account-a")).toEqual(committed.workspace);
  });

  it("serializes concurrent tabs so SHA-256 deduplication uses the latest workspace", async () => {
    const initial: StoredLocalWorkspace = {
      ...createEmptyWorkspace(),
      _conuoSync: { revision: 3, dirty: false },
    };
    await saveLocalWorkspace(initial, "account-a");
    const candidates = [
      importedSource("source-left", "b", 4, ["space-left"]),
      importedSource("source-right", "b", 4, ["space-right"]),
    ];

    const committed = await Promise.all(
      candidates.map((candidate) =>
        commitLocalImport<{ kind: "duplicate" | "queued"; sourceId: string }>(
          "account-a",
          candidate.blobKey!,
          new Blob([candidate.id]),
          (latest) => {
            const duplicate = latest!.sources.find(
              (source) => !source.deletedAt && !!source.hash && source.hash === candidate.hash,
            );
            if (duplicate) {
              const spaceIds = [...new Set([...duplicate.spaceIds, ...candidate.spaceIds])];
              return {
                workspace: {
                  ...latest!,
                  sources: latest!.sources.map((source) =>
                    source.id === duplicate.id ? { ...source, spaceIds } : source,
                  ),
                },
                storeBlob: false,
                result: { kind: "duplicate" as const, sourceId: duplicate.id },
              };
            }
            return {
              workspace: { ...latest!, sources: [candidate, ...latest!.sources] },
              storeBlob: true,
              result: { kind: "queued" as const, sourceId: candidate.id },
            };
          },
        ),
      ),
    );

    expect(committed.filter((item) => item.blobStored)).toHaveLength(1);
    expect(committed.map((item) => item.result.kind).sort()).toEqual(["duplicate", "queued"]);
    const saved = (await loadLocalWorkspace("account-a")) as StoredLocalWorkspace;
    expect(saved.sources).toHaveLength(1);
    expect(saved.sources[0].spaceIds.sort()).toEqual(["space-left", "space-right"]);
    expect(saved._conuoSync).toEqual({ revision: 3, dirty: false });
    const stored = await Promise.all(
      candidates.map((candidate) => getBlob(candidate.blobKey!, "account-a")),
    );
    expect(stored.filter(Boolean)).toHaveLength(1);
  });

  it("serializes different hashes so quota is recalculated before either workspace write", async () => {
    await saveLocalWorkspace(createEmptyWorkspace(), "account-a");
    const policy: ImportQuotaPolicy = {
      maxFileBytes: 10,
      maxBatchFiles: 20,
      maxBatchBytes: 20,
      maxAccountBytes: 6,
    };
    const candidates = [
      importedSource("source-quota-a", "c", 4, []),
      importedSource("source-quota-b", "d", 4, []),
    ];

    const attempts = await Promise.allSettled(
      candidates.map((candidate) =>
        commitLocalImport("account-a", candidate.blobKey!, new Blob(["four"]), (latest) => {
          const assessment = assessImportQuota(
            latest!,
            [{ name: candidate.filename, size: candidate.size }],
            policy,
          );
          const item = assessment.items[0];
          if (!item.accepted)
            throw new Error(item.rejections.map(({ message }) => message).join(" "));
          return {
            workspace: { ...latest!, sources: [candidate, ...latest!.sources] },
            storeBlob: true,
            result: candidate.id,
          };
        }),
      ),
    );

    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected" });
    if (rejected?.status === "rejected")
      expect(String(rejected.reason)).toContain("账号保留原件超过");
    const saved = await loadLocalWorkspace("account-a");
    expect(saved?.sources).toHaveLength(1);
    const stored = await Promise.all(
      candidates.map((candidate) => getBlob(candidate.blobKey!, "account-a")),
    );
    expect(stored.filter(Boolean)).toHaveLength(1);
  });

  it("aborts the workspace change when immutable original reservation collides", async () => {
    const source = importedSource("source-collision", "e", 4, []);
    await saveLocalWorkspace(createEmptyWorkspace(), "account-a");
    await putBlobIfAbsent(source.blobKey!, new Blob(["existing bytes"]));

    await expect(
      commitLocalImport("account-a", source.blobKey!, new Blob(["replacement"]), (latest) => ({
        workspace: { ...latest!, sources: [source, ...latest!.sources] },
        storeBlob: true,
        result: null,
      })),
    ).rejects.toThrow("原文件标识已存在");

    expect((await loadLocalWorkspace("account-a"))?.sources).toEqual([]);
    expect(await (await getBlob(source.blobKey!))?.text()).toBe("existing bytes");
  });

  it("rolls back an inserted original when the workspace request aborts", async () => {
    const source = importedSource("source-workspace-failure", "1", 4, []);
    const initial = createEmptyWorkspace();
    await saveLocalWorkspace(initial, "account-a");
    const originalPut = FakeIDBObjectStore.prototype.put;
    const failingPut = vi.spyOn(FakeIDBObjectStore.prototype, "put").mockImplementation(function (
      this: InstanceType<typeof FakeIDBObjectStore>,
      value,
      key,
    ) {
      if (this.name === "workspaces") this.transaction.abort();
      return Reflect.apply(originalPut, this, [value, key]);
    });

    try {
      await expect(
        commitLocalImport("account-a", source.blobKey!, new Blob(["four"]), (latest) => ({
          workspace: { ...latest!, sources: [source, ...latest!.sources] },
          storeBlob: true,
          result: null,
        })),
      ).rejects.toBeDefined();
    } finally {
      failingPut.mockRestore();
    }

    expect(await loadLocalWorkspace("account-a")).toEqual(initial);
    expect(await getBlob(source.blobKey!)).toBeUndefined();
  });

  it("rejects failed validation without leaving an original or changing the workspace", async () => {
    const source = importedSource("source-rejected", "f", 4, []);
    const initial = createEmptyWorkspace();
    await saveLocalWorkspace(initial, "account-a");

    await expect(
      commitLocalImport("account-a", source.blobKey!, new Blob(["four"]), () => {
        throw new Error("quota changed");
      }),
    ).rejects.toThrow("quota changed");

    expect(await loadLocalWorkspace("account-a")).toEqual(initial);
    expect(await getBlob(source.blobKey!)).toBeUndefined();
  });

  it("will not commit a newly stored blob unless the result workspace references it", async () => {
    const source = importedSource("source-orphan", "0", 4, []);
    const initial = createEmptyWorkspace();
    await saveLocalWorkspace(initial, "account-a");

    await expect(
      commitLocalImport("account-a", source.blobKey!, new Blob(["four"]), (latest) => ({
        workspace: latest!,
        storeBlob: true,
        result: null,
      })),
    ).rejects.toThrow("没有引用待保存的原文件");

    expect(await loadLocalWorkspace("account-a")).toEqual(initial);
    expect(await getBlob(source.blobKey!)).toBeUndefined();
  });
});

describe("atomic original reservation with real IndexedDB transactions", () => {
  it("inserts once and keeps exact original bytes when the same key is reserved again", async () => {
    const bytes = new Uint8Array([0, 255, 65, 13, 10]);
    expect(await putBlobIfAbsent(key, new Blob([bytes]))).toBe(true);
    expect(await putBlobIfAbsent(key, new Blob(["replacement must not overwrite"]))).toBe(false);
    expect(new Uint8Array(await (await getBlob(key))!.arrayBuffer())).toEqual(bytes);
  });

  it("allows exactly one concurrent add and preserves the winning bytes", async () => {
    const bodies = Array.from({ length: 12 }, (_, index) => `candidate ${index}`);
    const inserted = await Promise.all(
      bodies.map((body) => putBlobIfAbsent(key, new Blob([body]))),
    );
    expect(inserted.filter(Boolean)).toHaveLength(1);
    const winner = inserted.indexOf(true);
    expect(await (await getBlob(key))!.text()).toBe(bodies[winner]);
    expect(await putBlobIfAbsent(key, new Blob(["late candidate"]))).toBe(false);
    expect(await (await getBlob(key))!.text()).toBe(bodies[winner]);
  });

  it("keeps independent reservations intact after another add hits ConstraintError", async () => {
    await putBlobIfAbsent(key, new Blob(["first"]));
    const result = await Promise.all([
      putBlobIfAbsent(key, new Blob(["duplicate"])),
      putBlobIfAbsent("original:source-b:version-b", new Blob(["independent"])),
    ]);
    expect(result).toEqual([false, true]);
    expect(await (await getBlob(key))!.text()).toBe("first");
    expect(await (await getBlob("original:source-b:version-b"))!.text()).toBe("independent");
  });

  it("rejects missing reservation and cleanup keys without modifying an existing original", async () => {
    await putBlobIfAbsent(key, new Blob(["keep"]));
    await expect(putBlobIfAbsent("", new Blob(["bad"]))).rejects.toThrow("缺少文件标识");
    await expect(deleteUnreferencedBlob("")).rejects.toThrow("缺少文件标识");
    expect(await (await getBlob(key))!.text()).toBe("keep");
  });
});

describe("transactional cleanup checks all retained workspace references", () => {
  it.each([
    ["local", "current", false],
    ["local", "history", false],
    ["account-a", "current", false],
    ["account-b", "history", false],
    ["account-b", "current", true],
    ["account-b", "history", true],
    ["recovery:account-a:1780000000:session", "current", false],
    ["recovery:account-a:1780000000:session", "history", true],
  ] as const)("keeps %s / %s / deleted=%s originals", async (account, location, deleted) => {
    await putBlobIfAbsent(key, new Blob(["protected original"]));
    await saveLocalWorkspace(createEmptyWorkspace(), "local");
    await saveLocalWorkspace(reference(location, deleted), account);
    expect(await deleteUnreferencedBlob(key)).toBe(false);
    expect(await (await getBlob(key))!.text()).toBe("protected original");
    expect((await loadLocalWorkspace(account))?.sources[0].deletedAt).toBe(
      deleted ? timestamp : null,
    );
  });

  it("keeps an original until references from all accounts and recovery backups are gone", async () => {
    await putBlobIfAbsent(key, new Blob(["shared retained original"]));
    await saveLocalWorkspace(reference("current"), "account-a");
    await saveLocalWorkspace(reference("history", true), "account-b");
    await saveLocalWorkspace(reference("history"), "recovery:account-b:1:session");
    for (const account of ["account-a", "account-b"]) {
      await saveLocalWorkspace(createEmptyWorkspace(), account);
      expect(await deleteUnreferencedBlob(key)).toBe(false);
    }
    await saveLocalWorkspace(createEmptyWorkspace(), "recovery:account-b:1:session");
    expect(await deleteUnreferencedBlob(key)).toBe(true);
    expect(await getBlob(key)).toBeUndefined();
  });

  it("deletes only an unreferenced original while leaving workspaces and other bytes unchanged", async () => {
    const data = reference("history");
    await saveLocalWorkspace(data, "account-a");
    await putBlobIfAbsent(key, new Blob(["retained"]));
    await putBlobIfAbsent("uncommitted", new Blob(["cancelled preview"]));
    expect(await deleteUnreferencedBlob("uncommitted")).toBe(true);
    expect(await getBlob("uncommitted")).toBeUndefined();
    expect(await (await getBlob(key))!.text()).toBe("retained");
    expect(await loadLocalWorkspace("account-a")).toEqual(data);
  });

  it("sees another connection's queued workspace commit before deleting its original", async () => {
    await putBlobIfAbsent(key, new Blob(["queued reference"]));
    const db = await openDB("conuo-web");
    try {
      const write = db.transaction("workspaces", "readwrite");
      const saved = write.store.put(reference("history"), "account:another-tab:workspace");
      const cleanup = deleteUnreferencedBlob(key);
      await saved;
      await write.done;
      expect(await cleanup).toBe(false);
      expect(await (await getBlob(key))!.text()).toBe("queued reference");
    } finally {
      db.close();
    }
  });

  it("does not treat normal cloud sync metadata as a malformed workspace", async () => {
    const cloudWorkspace = { ...createEmptyWorkspace(), _conuoSync: { revision: 4, dirty: false } };
    await saveLocalWorkspace(cloudWorkspace, "account-a");
    await putBlobIfAbsent(key, new Blob(["unused despite cloud metadata"]));

    expect(await deleteUnreferencedBlob(key)).toBe(true);
    expect(await getBlob(key)).toBeUndefined();
  });
});

describe("account local cache clearing", () => {
  it("removes only the target workspace and its exclusive original bytes", async () => {
    const target = { ...reference("history"), _conuoSync: { revision: 4, dirty: false } };
    const otherAccount = { ...reference("current"), _conuoSync: { revision: 4, dirty: false } };
    await saveLocalWorkspace(target, "account-a");
    await saveLocalWorkspace(otherAccount, "account-b");
    await putBlobIfAbsent(key, new Blob(["shared by another account"]));
    await putBlobIfAbsent(currentKey, new Blob(["owned only by account-a"]), "account-a");
    await putBlobIfAbsent("orphaned-from-another-operation", new Blob(["leave alone"]));

    await expect(clearAccountLocalCache("account-a")).resolves.toEqual({
      deletedBlobs: 1,
      retainedBlobs: 1,
    });

    await expectClearedAccount("account-a");
    expect(await loadLocalWorkspace("account-b")).toEqual(otherAccount);
    expect(await (await getBlob(key))?.text()).toBe("shared by another account");
    expect(await getBlob(currentKey)).toBeUndefined();
    expect(await (await getBlob("orphaned-from-another-operation"))?.text()).toBe("leave alone");
  });

  it("deletes current and recovery snapshots belonging to the deleted account", async () => {
    const recoveryId = "recovery:account-a:1780000000:session";
    const recovery = { ...reference("history"), _conuoSync: { revision: 4, dirty: false } };
    await saveLocalWorkspace(reference("current"), "account-a");
    await saveLocalWorkspace(recovery, recoveryId);
    await putBlobIfAbsent(
      key,
      new Blob(["delete account-a current and recovery copy"]),
      "account-a",
    );
    await putBlobIfAbsent(currentKey, new Blob(["owned only by account-a recovery"]), "account-a");

    await expect(clearAccountLocalCache("account-a")).resolves.toEqual({
      deletedBlobs: 2,
      retainedBlobs: 0,
    });

    await expectClearedAccount("account-a");
    await expectClearedAccount(recoveryId, "account-a");
    expect(await getBlob(key)).toBeUndefined();
    expect(await getBlob(currentKey)).toBeUndefined();
  });

  it("keeps an original referenced by another account's recovery workspace", async () => {
    const recoveryId = "recovery:account-b:1780000000:session";
    const recovery = { ...reference("current"), _conuoSync: { revision: 4, dirty: false } };
    await saveLocalWorkspace(reference("current"), "account-a");
    await saveLocalWorkspace(recovery, recoveryId);
    await putBlobIfAbsent(key, new Blob(["other account recovery retains this"]));

    await expect(clearAccountLocalCache("account-a")).resolves.toEqual({
      deletedBlobs: 0,
      retainedBlobs: 1,
    });

    await expectClearedAccount("account-a");
    expect(await loadLocalWorkspace(recoveryId)).toEqual(recovery);
    expect(await (await getBlob(key))?.text()).toBe("other account recovery retains this");
  });

  it("matches recovery ownership exactly instead of by account ID prefix", async () => {
    const accountId = "account-a:1780000000";
    const recoveryId = "recovery:account-a:1780000000:session";
    const recovery = reference("current");
    await saveLocalWorkspace(reference("current"), accountId);
    await saveLocalWorkspace(recovery, recoveryId);
    await putBlobIfAbsent(key, new Blob(["similar account IDs remain isolated"]));

    await expect(clearAccountLocalCache(accountId)).resolves.toEqual({
      deletedBlobs: 0,
      retainedBlobs: 1,
    });

    await expectClearedAccount(accountId);
    expect(await loadLocalWorkspace(recoveryId)).toEqual(recovery);
    expect(await (await getBlob(key))?.text()).toBe("similar account IDs remain isolated");
  });

  it("sees a queued other-account recovery write before deciding whether an original is exclusive", async () => {
    const recoveryId = "recovery:account-b:1780000000:session";
    const recovery = { ...reference("current"), _conuoSync: { revision: 4, dirty: false } };
    await saveLocalWorkspace(reference("current"), "account-a");
    await putBlobIfAbsent(key, new Blob(["wait for another tab's recovery"]));
    const db = await openDB("conuo-web");
    try {
      const write = db.transaction("workspaces", "readwrite");
      const saved = write.store.put(recovery, `account:${recoveryId}:workspace`);
      const clearing = clearAccountLocalCache("account-a");
      await saved;
      await write.done;

      await expect(clearing).resolves.toEqual({ deletedBlobs: 0, retainedBlobs: 1 });
      await expectClearedAccount("account-a");
      expect(await loadLocalWorkspace(recoveryId)).toEqual(recovery);
      expect(await (await getBlob(key))?.text()).toBe("wait for another tab's recovery");
    } finally {
      db.close();
    }
  });

  it("fails closed for a damaged other workspace record", async () => {
    await saveLocalWorkspace(reference("current"), "account-a");
    await rawWorkspace({ schemaVersion: 99 }, "account:damaged:workspace");
    await putBlobIfAbsent(key, new Blob(["cannot prove this is unused"]));

    await expect(clearAccountLocalCache("account-a")).resolves.toEqual({
      deletedBlobs: 0,
      retainedBlobs: 1,
    });

    await expectClearedAccount("account-a");
    expect(await (await getBlob(key))?.text()).toBe("cannot prove this is unused");
  });

  it("removes a damaged target record without guessing at its original references", async () => {
    await putBlobIfAbsent(key, new Blob(["keep when target cannot be parsed"]));
    await rawWorkspace(
      { schemaVersion: 99, sources: [{ blobKey: key }] },
      "account:account-a:workspace",
    );

    await expect(clearAccountLocalCache("account-a")).resolves.toEqual({
      deletedBlobs: 0,
      retainedBlobs: 0,
    });

    await expectClearedAccount("account-a");
    expect(await (await getBlob(key))?.text()).toBe("keep when target cannot be parsed");
  });

  it("rejects anonymous and recovery targets without changing their records", async () => {
    const recoveryId = "recovery:account-a:1780000000:session";
    const local = reference("current");
    const recovery = reference("history");
    await saveLocalWorkspace(local);
    await saveLocalWorkspace(recovery, recoveryId);
    await putBlobIfAbsent(key, new Blob(["protected by local and recovery"]));

    await expect(clearAccountLocalCache("local")).rejects.toThrow("账户身份无效");
    await expect(clearAccountLocalCache(recoveryId)).rejects.toThrow("账户身份无效");

    expect(await loadLocalWorkspace()).toEqual(local);
    expect(await loadLocalWorkspace(recoveryId)).toEqual(recovery);
    expect(await (await getBlob(key))?.text()).toBe("protected by local and recovery");
  });
});

describe("unreadable workspace records block cleanup", () => {
  it.each([
    "null-workspace",
    "unknown-schema",
    "missing-schema",
    "missing-sources",
    "nonarray-sources",
    "null-source",
    "invalid-source-key",
    "nonarray-history",
    "null-history-version",
    "invalid-history-key",
  ])("fails closed for %s without deleting an original", async (kind) => {
    await putBlobIfAbsent(key, new Blob(["do not guess that this is unused"]));
    let bad: unknown = createEmptyWorkspace();
    if (kind === "null-workspace") bad = null;
    if (kind === "unknown-schema") bad = { ...createEmptyWorkspace(), schemaVersion: 99 };
    if (kind === "missing-schema") bad = { sources: [] };
    if (kind === "missing-sources") bad = { schemaVersion: 1 };
    if (kind === "nonarray-sources") bad = { schemaVersion: 1, sources: {} };
    if (kind === "null-source") bad = { ...createEmptyWorkspace(), sources: [null] };
    if (kind === "invalid-source-key") {
      bad = reference("current");
      Object.assign((bad as WorkspaceData).sources[0], { blobKey: 123 });
    }
    if (kind === "nonarray-history") {
      bad = reference("current");
      Object.assign((bad as WorkspaceData).sources[0], { blobKey: undefined, versions: {} });
    }
    if (kind === "null-history-version") {
      bad = reference("history");
      Object.assign((bad as WorkspaceData).sources[0], { versions: [null] });
    }
    if (kind === "invalid-history-key") {
      bad = reference("history");
      Object.assign((bad as WorkspaceData).sources[0].versions![0], { blobKey: { ref: key } });
    }
    await rawWorkspace(bad);
    expect(await deleteUnreferencedBlob(key)).toBe(false);
    expect(await (await getBlob(key))!.text()).toBe("do not guess that this is unused");
  });
});
