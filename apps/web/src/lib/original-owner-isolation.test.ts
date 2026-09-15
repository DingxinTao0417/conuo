import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { deleteDB, openDB } from "idb";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitLocalImport,
  getBlob,
  saveLocalWorkspace,
  putBlobIfAbsent,
  putBlob,
  loadLocalWorkspaceRecord,
  shareAnonymousOriginals,
  deleteUnreferencedBlob,
  clearAccountLocalCache,
  deleteBlob,
  LocalAccountDeletedError,
} from "./local-store";
import { buildWorkspaceArchiveResult } from "./export";
import { createDemoWorkspace, createEmptyWorkspace } from "./seed";
import { assertWorkspaceOwner, workspaceSchema } from "./supabase/validation";
import { WorkspaceCoordinator, type WorkspaceIO } from "./use-workspace";
import { readWorkspaceBackup } from "./backup-archive";
import { prepareBackupRestore } from "./backup-restore";
import { getSourceVersion } from "./source-versions";
import type { SourceVersion, WorkspaceData } from "./types";

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(async () => {
  await deleteDB("conuo-web");
  vi.unstubAllGlobals();
});

async function imported(owner = "A", withHistory = false) {
  const data = createDemoWorkspace();
  data.sources = [data.sources[0]!];
  data.sources[0]!.blobKey = `original:${data.sources[0]!.id}:${data.sources[0]!.versionId}`;
  const blob = new Blob(["ACCOUNT_A_PRIVATE_ORIGINAL"]);
  data.sources[0]!.size = blob.size;
  data.sources[0]!.hash = await digest(blob);
  const oldBlob = new Blob(["ACCOUNT_A_HISTORY_ORIGINAL"]);
  if (withHistory) {
    const current = data.sources[0]!;
    const historical: SourceVersion = {
      versionId: "retained-version",
      title: "保留的旧原件",
      filename: "old.md",
      kind: current.kind,
      mime: current.mime,
      hash: await digest(oldBlob),
      size: oldBlob.size,
      status: "ready",
      text: "旧版提取正文",
      chunks: [],
      blobKey: `original:${current.id}:retained-version`,
      createdAt: current.createdAt,
      archivedAt: current.updatedAt,
    };
    current.versions = [historical];
    await putBlobIfAbsent(historical.blobKey!, oldBlob, owner);
  }
  await commitLocalImport(owner, data.sources[0]!.blobKey!, blob, () => ({
    workspace: data,
    storeBlob: true,
    result: null,
  }));
  return { data, blob, oldBlob };
}

async function digest(blob: Blob) {
  const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
}

function adapters(remote: Map<string, WorkspaceData>): WorkspaceIO {
  return {
    loadLocal: loadLocalWorkspaceRecord,
    saveLocal: saveLocalWorkspace,
    commitLocalImport,
    getBlob: vi.fn(async () => {
      throw new Error("Unscoped local read bypass");
    }),
    getAccountBlob: getBlob,
    putBlobIfAbsent,
    putAccountBlobIfAbsent: putBlobIfAbsent,
    shareAnonymousOriginals,
    deleteUnreferencedBlob,
    deleteAccountUnreferencedBlob: deleteUnreferencedBlob,
    loadCloud: vi.fn(async (owner) => ({
      data: structuredClone(remote.get(owner) ?? createEmptyWorkspace()),
      revision: 1,
    })),
    saveCloud: vi.fn(async (data, revision, owner) => {
      remote.set(owner, structuredClone(data));
      return { revision: revision + 1 };
    }),
    uploadBlob: vi.fn(async () => {
      throw new Error("No cloud storage in local regression");
    }),
    downloadBlob: vi.fn(async () => undefined),
    askCloud: vi.fn(),
    organizeCloud: vi.fn(),
    getModelStatus: vi.fn(async () => ({ mode: "extractive", message: "Local regression" })),
    readLegacyMeta: () => null,
  };
}

async function archiveBodies(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const bodies = await Promise.all(
    Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => entry.async("string")),
  );
  return { zip, bodies: bodies.join("\n") };
}

describe("trusted local original ownership", () => {
  it("does not grant cached bytes to an account whose valid cloud record claims another owner's key", async () => {
    const { data } = await imported();
    const claimed = structuredClone(data);
    expect(workspaceSchema.safeParse(claimed).success).toBe(true);
    expect(() => assertWorkspaceOwner(claimed, "B")).not.toThrow();
    await saveLocalWorkspace(claimed, "B");
    expect(await getBlob(claimed.sources[0]!.blobKey!, "B")).toBeUndefined();
    expect(await (await getBlob(claimed.sources[0]!.blobKey!, "A"))?.text()).toBe(
      "ACCOUNT_A_PRIVATE_ORIGINAL",
    );
  });

  it("never bypasses an account-bound resolver with a global IndexedDB read", async () => {
    const { data } = await imported();
    const resolveBlob = vi.fn(async () => undefined);
    const archive = await buildWorkspaceArchiveResult(data, { resolveBlob });
    const zip = await JSZip.loadAsync(archive.bytes);
    const bodies = await Promise.all(
      Object.values(zip.files)
        .filter((entry) => !entry.dir)
        .map((entry) => entry.async("string")),
    );
    expect(bodies.join("\n")).not.toContain("ACCOUNT_A_PRIVATE_ORIGINAL");
    expect(resolveBlob).toHaveBeenCalled();
    expect(archive.issues).toHaveLength(1);
  });

  it("keeps canonical B records from reading A current/history bytes through the real coordinator", async () => {
    const { data } = await imported("A", true);
    await saveLocalWorkspace(data, "B");
    const io = adapters(new Map([["B", data]]));
    const coordinator = new WorkspaceCoordinator(io);
    await coordinator.activate({ id: "B", email: "b@example.com" });
    const state = coordinator.getSnapshot();
    const source = state.data.sources[0]!;
    expect(await coordinator.sourceBlob(source, state.token)).toBeUndefined();
    expect(
      await coordinator.sourceBlob(getSourceVersion(source, "retained-version")!, state.token),
    ).toBeUndefined();
    const result = await buildWorkspaceArchiveResult(state.data, {
      resolveBlob: (version, options) => coordinator.sourceBlob(version, state.token, options),
    });
    const { bodies } = await archiveBodies(result.bytes);
    expect(bodies).not.toContain("ACCOUNT_A_PRIVATE_ORIGINAL");
    expect(bodies).not.toContain("ACCOUNT_A_HISTORY_ORIGINAL");
    expect(result.issues).toHaveLength(2);
    expect(io.getBlob).not.toHaveBeenCalled();
  });

  it("exports the owning account's unuploaded current/history originals with exact bytes", async () => {
    const { data, blob, oldBlob } = await imported("A", true);
    const io = adapters(new Map([["A", data]]));
    const coordinator = new WorkspaceCoordinator(io);
    await coordinator.activate({ id: "A", email: "a@example.com" });
    const state = coordinator.getSnapshot();
    const result = await buildWorkspaceArchiveResult(state.data, {
      resolveBlob: (version, options) => coordinator.sourceBlob(version, state.token, options),
    });
    const { zip } = await archiveBodies(result.bytes);
    const mapping = JSON.parse(await zip.file("source-mapping.json")!.async("string"))[0];
    expect(await zip.file(mapping.original)!.async("uint8array")).toEqual(
      new Uint8Array(await blob.arrayBuffer()),
    );
    expect(await zip.file(mapping.versions[0].original)!.async("uint8array")).toEqual(
      new Uint8Array(await oldBlob.arrayBuffer()),
    );
    expect(result.issues).toEqual([]);
    expect(io.getBlob).not.toHaveBeenCalled();
    expect(io.downloadBlob).not.toHaveBeenCalled();
  });

  it("allows only the explicitly chosen anonymous copy to share local originals", async () => {
    const { data } = await imported("local", true);
    const keys = [data.sources[0]!.blobKey!, data.sources[0]!.versions![0]!.blobKey!];
    expect(await getBlob(keys[0]!, "A")).toBeUndefined();
    await shareAnonymousOriginals("A", keys);
    for (const key of keys) {
      expect(await getBlob(key, "A")).toBeInstanceOf(Blob);
      expect(await getBlob(key, "local")).toBeInstanceOf(Blob);
      expect(await getBlob(key, "B")).toBeUndefined();
    }
    await expect(shareAnonymousOriginals("local", keys)).rejects.toThrow("登录账号");
  });

  it("cannot grant one signed-in account's original to another through the anonymous action", async () => {
    const { data } = await imported("A", true);
    const keys = [data.sources[0]!.blobKey!, data.sources[0]!.versions![0]!.blobKey!];
    await shareAnonymousOriginals("B", keys);
    for (const key of keys) {
      expect(await getBlob(key, "B")).toBeUndefined();
      expect(await getBlob(key, "A")).toBeInstanceOf(Blob);
      expect(await getBlob(key)).toBeUndefined();
    }
  });

  it("restores an exported backup into a new owning account through the real admission", async () => {
    const { data } = await imported("A", true);
    const exported = await buildWorkspaceArchiveResult(data, {
      resolveBlob: (source) => getBlob(source.blobKey!, "A"),
    });
    const archive = await readWorkspaceBackup(
      new Blob([new Uint8Array(exported.bytes)], { type: "application/zip" }),
    );
    const plan = prepareBackupRestore(archive);
    const io = adapters(new Map());
    const coordinator = new WorkspaceCoordinator(io);
    await coordinator.activate({ id: "C", email: "c@example.com" });
    const state = coordinator.getSnapshot();
    await coordinator.restoreBackup(plan, state.token);
    for (const entry of plan.blobs) {
      expect(await (await getBlob(entry.key, "C"))!.arrayBuffer()).toEqual(
        await entry.blob.arrayBuffer(),
      );
      expect(await getBlob(entry.key, "A")).toBeUndefined();
      expect(await getBlob(entry.key, "B")).toBeUndefined();
    }
    const current = coordinator.getSnapshot();
    const copied = current.data.sources[0]!;
    expect(await coordinator.sourceBlob(copied, current.token)).toBeInstanceOf(Blob);
    expect(
      await coordinator.sourceBlob(
        getSourceVersion(copied, copied.versions![0]!.versionId)!,
        current.token,
      ),
    ).toBeInstanceOf(Blob);
    expect(io.getBlob).not.toHaveBeenCalled();
  });

  it("preserves legacy bytes and refuses to infer their owner from a later workspace claim", async () => {
    const key = "legacy-unowned-original";
    const raw = new Blob(["LEGACY_PRIVATE_BYTES"]);
    // Create an actual legacy v1 database before the production entry point
    // upgrades it. A later workspace claim must never confer ownership.
    const db = await openDB("conuo-web", 1, {
      upgrade(database) {
        database.createObjectStore("workspaces");
        database.createObjectStore("blobs");
      },
    });
    await db.put("blobs", raw, key);
    db.close();
    const { data } = await imported();
    data.sources[0]!.blobKey = key;
    await saveLocalWorkspace(data, "A");
    await saveLocalWorkspace(data, "B");
    await shareAnonymousOriginals("B", [key]);
    expect(await putBlobIfAbsent(key, new Blob(["replacement"]), "B")).toBe(false);
    await expect(putBlob(key, new Blob(["replacement"]), "B")).rejects.toThrow("标识已存在");
    expect(await deleteUnreferencedBlob(key, "B")).toBe(false);
    await deleteBlob(key, "B");
    for (const owner of ["local", "A", "B"]) expect(await getBlob(key, owner)).toBeUndefined();
    const inspect = await openDB("conuo-web");
    expect(inspect.version).toBe(2);
    expect(inspect.objectStoreNames.contains("accountDeletions")).toBe(true);
    expect(await ((await inspect.get("blobs", key)) as Blob).text()).toBe("LEGACY_PRIVATE_BYTES");
    inspect.close();
  });

  it("does not grant ownership when a reservation collides with an existing original", async () => {
    const { data } = await imported();
    const key = data.sources[0]!.blobKey!;
    expect(await putBlobIfAbsent(key, new Blob(["B supplied bytes"]), "B")).toBe(false);
    await expect(putBlob(key, new Blob(["B supplied bytes"]), "B")).rejects.toThrow("标识已存在");
    expect(await getBlob(key, "B")).toBeUndefined();
    expect(await (await getBlob(key, "A"))?.text()).toBe("ACCOUNT_A_PRIVATE_ORIGINAL");
  });

  it("does not delete another account's unreferenced current/history bytes from forged cleanup candidates", async () => {
    const { data } = await imported("A", true);
    await saveLocalWorkspace(createEmptyWorkspace(), "A");
    await saveLocalWorkspace(data, "B");
    expect(await clearAccountLocalCache("B")).toEqual({ deletedBlobs: 0, retainedBlobs: 2 });
    const inspect = await openDB("conuo-web");
    try {
      expect(await inspect.get("workspaces", "account:B:workspace")).toBeUndefined();
      expect(await inspect.get("accountDeletions", "B")).toEqual({
        schemaVersion: 1,
        accountId: "B",
        blocked: true,
      });
    } finally {
      inspect.close();
    }
    await expect(loadLocalWorkspaceRecord("B")).rejects.toBeInstanceOf(LocalAccountDeletedError);
    for (const key of [data.sources[0]!.blobKey!, data.sources[0]!.versions![0]!.blobKey!]) {
      await expect(deleteUnreferencedBlob(key, "B")).rejects.toBeInstanceOf(
        LocalAccountDeletedError,
      );
      await expect(deleteBlob(key, "B")).rejects.toBeInstanceOf(LocalAccountDeletedError);
      expect(await getBlob(key, "A")).toBeInstanceOf(Blob);
      await expect(getBlob(key, "B")).rejects.toBeInstanceOf(LocalAccountDeletedError);
      expect(await (await getBlob(key, "A"))!.text()).toBe(
        key === data.sources[0]!.blobKey!
          ? "ACCOUNT_A_PRIVATE_ORIGINAL"
          : "ACCOUNT_A_HISTORY_ORIGINAL",
      );
      expect(await deleteUnreferencedBlob(key, "A")).toBe(true);
      expect(await getBlob(key, "A")).toBeUndefined();
    }
  });

  it("revokes only the cleared account's anonymous-copy grant even after the local snapshot has no reference", async () => {
    const { data } = await imported("local", true);
    const keys = [data.sources[0]!.blobKey!, data.sources[0]!.versions![0]!.blobKey!];
    await shareAnonymousOriginals("A", keys);
    await saveLocalWorkspace(data, "A");
    await saveLocalWorkspace(createEmptyWorkspace(), "local");
    expect(await clearAccountLocalCache("A")).toEqual({ deletedBlobs: 0, retainedBlobs: 2 });
    const inspect = await openDB("conuo-web");
    try {
      expect(await inspect.get("workspaces", "account:A:workspace")).toBeUndefined();
      expect(await inspect.get("accountDeletions", "A")).toEqual({
        schemaVersion: 1,
        accountId: "A",
        blocked: true,
      });
    } finally {
      inspect.close();
    }
    await expect(loadLocalWorkspaceRecord("A")).rejects.toBeInstanceOf(LocalAccountDeletedError);
    for (const key of keys) {
      await expect(getBlob(key, "A")).rejects.toBeInstanceOf(LocalAccountDeletedError);
      expect(await getBlob(key, "local")).toBeInstanceOf(Blob);
      expect(await getBlob(key, "B")).toBeUndefined();
    }
  });

  it("copies anonymous current/history originals through the actual explicit coordinator action", async () => {
    const { data } = await imported("local", true);
    const io = adapters(new Map([["B", createEmptyWorkspace()]]));
    const coordinator = new WorkspaceCoordinator(io);
    await coordinator.activate({ id: "B", email: "b@example.com" });
    const state = coordinator.getSnapshot();
    expect(state.anonymousMigration.kind).toBe("pending");
    await coordinator.migrateAnonymousWorkspace(state.token);
    const migrated = coordinator.getSnapshot();
    const copied = migrated.data.sources[0]!;
    expect(await coordinator.sourceBlob(copied, migrated.token)).toBeInstanceOf(Blob);
    expect(
      await coordinator.sourceBlob(
        getSourceVersion(copied, copied.versions![0]!.versionId)!,
        migrated.token,
      ),
    ).toBeInstanceOf(Blob);
    for (const key of [data.sources[0]!.blobKey!, data.sources[0]!.versions![0]!.blobKey!]) {
      expect(await getBlob(key, "local")).toBeInstanceOf(Blob);
      expect(await getBlob(key, "B")).toBeInstanceOf(Blob);
      expect(await getBlob(key, "A")).toBeUndefined();
    }
    expect(io.getBlob).not.toHaveBeenCalled();
  });
});
