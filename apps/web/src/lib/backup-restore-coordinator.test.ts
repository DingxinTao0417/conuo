import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { deleteDB } from "idb";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceCoordinator, type WorkspaceIO } from "./use-workspace";
import { createEmptyWorkspace } from "./seed";
import type { RestorePlan } from "./backup-types";
import type { Source, WorkspaceData } from "./types";
import {
  deleteUnreferencedBlob,
  getBlob,
  loadLocalWorkspaceRecord,
  putBlobIfAbsent,
  saveLocalWorkspace,
} from "./local-store";

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
  getAccountMembership: vi.fn(),
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

const at = "2026-09-12T12:00:00.000Z";
const accountA = { id: "A", email: "a@example.com" };
const accountB = { id: "B", email: "b@example.com" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function workspace(): WorkspaceData {
  const data = createEmptyWorkspace();
  data.spaces = [
    {
      id: "existing",
      name: "原来的资料库",
      color: "#7865cf",
      goal: "",
      archived: false,
      createdAt: at,
    },
  ];
  data.notes = [
    {
      id: "existing-note",
      spaceId: "existing",
      kind: "note",
      status: "accepted",
      title: "原来的笔记",
      content: "<p>原来的内容</p>",
      citations: [],
      versions: [],
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    },
  ];
  return data;
}
async function source(versionId: string, text: string): Promise<{ source: Source; blob: Blob }> {
  const id = "restored-source";
  const blob = new Blob([text], { type: "text/plain" });
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return {
    blob,
    source: {
      id,
      versionId,
      title: "恢复资料",
      filename: "lesson.txt",
      kind: "text",
      mime: "text/plain",
      size: blob.size,
      hash: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      ),
      spaceIds: ["restored-space"],
      tags: [],
      status: "ready",
      text,
      chunks: [
        { id: `chunk-${versionId}`, sourceId: id, versionId, text, section: "正文", order: 0 },
      ],
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      aiAllowed: false,
      starred: false,
      blobKey: `original:${id}:${versionId}`,
    },
  };
}
async function plan(withHistory = true): Promise<RestorePlan> {
  const current = await source("restored-current", "这是恢复副本的当前原件。");
  const older = await source("restored-old", "这是历史原件，字节不可串绑。");
  if (withHistory) {
    const previous = older.source;
    current.source.versions = [
      {
        versionId: previous.versionId,
        title: previous.title,
        filename: previous.filename,
        kind: previous.kind,
        mime: previous.mime,
        size: previous.size,
        hash: previous.hash,
        status: previous.status,
        text: previous.text,
        chunks: previous.chunks,
        blobKey: previous.blobKey,
        createdAt: previous.createdAt,
        archivedAt: at,
      },
    ];
  }
  const restored = createEmptyWorkspace();
  restored.spaces = [
    {
      id: "restored-space",
      name: "恢复资料库",
      color: "#7865cf",
      goal: "",
      archived: false,
      createdAt: at,
    },
  ];
  restored.sources = [current.source];
  restored.aiEnabled = false;
  restored.semanticSearch = false;
  restored.autoOrganize = false;
  return {
    id: "restore-plan",
    fingerprint: "a".repeat(64),
    data: restored,
    blobs: [current, ...(withHistory ? [older] : [])].map(({ source: item, blob }) => ({
      key: item.blobKey!,
      sourceId: item.id,
      versionId: item.versionId,
      blob,
    })),
    missingOriginals: [],
    counts: {
      spaces: 1,
      sources: 1,
      sourceVersions: withHistory ? 1 : 0,
      notes: 0,
      noteVersions: 0,
      conversations: 0,
      messages: 0,
      annotations: 0,
      recoverableDrafts: 0,
      organizationJobs: 0,
      conceptRelations: 0,
    },
    warnings: [],
  };
}
type Stored = WorkspaceData & { _conuoSync?: { revision: number; dirty: boolean } };
function setup() {
  const disk = new Map<string, Stored>([["local", workspace()]]);
  const originals = new Map<string, Blob>();
  const remote = new Map<string, { data: WorkspaceData | null; revision: number }>();
  const io: WorkspaceIO &
    Required<Pick<WorkspaceIO, "putBlobIfAbsent" | "deleteUnreferencedBlob">> = {
    loadLocal: vi.fn(async (id = "local") => structuredClone(disk.get(id) ?? null)),
    saveLocal: vi.fn(async (data, id = "local") => {
      disk.set(id, structuredClone(data));
    }),
    loadCloud: vi.fn(async (id) => structuredClone(remote.get(id) ?? { data: null, revision: 0 })),
    saveCloud: vi.fn(async (data, revision, id) => {
      if ((remote.get(id)?.revision ?? 0) !== revision) throw new Error("409 cloud conflict");
      remote.set(id, { data: structuredClone(data), revision: revision + 1 });
      return { revision: revision + 1 };
    }),
    getBlob: vi.fn(async (key) => originals.get(key)),
    putBlobIfAbsent: vi.fn(async (key, blob) => {
      if (originals.has(key)) return false;
      originals.set(key, blob);
      return true;
    }),
    deleteUnreferencedBlob: vi.fn(async (key) => {
      if (
        [...disk.values()].some((data) =>
          data.sources.some(
            (item) =>
              item.blobKey === key || item.versions?.some((version) => version.blobKey === key),
          ),
        )
      )
        return false;
      originals.delete(key);
      return true;
    }),
    uploadBlob: vi.fn(async (item, _blob, owner) => `${owner}/${item.versionId}/${item.id}.txt`),
    downloadBlob: vi.fn(async () => undefined),
    askCloud: vi.fn(),
    cancelImportParse: vi.fn(),
    claimImportParse: vi.fn(),
    finishImportParse: vi.fn(),
    heartbeatImportParse: vi.fn(),
    releaseImportParse: vi.fn(),
    retryImportParse: vi.fn(),
    organizeCloud: vi.fn(),
    getModelStatus: vi.fn(),
    readLegacyMeta: () => null,
  };
  const coordinator = new WorkspaceCoordinator(io);
  return { coordinator, io, disk, originals, remote };
}
function edit(coordinator: WorkspaceCoordinator, title: string) {
  coordinator.update(
    (data) => ({
      ...data,
      notes: data.notes.map((note) => (note.id === "existing-note" ? { ...note, title } : note)),
    }),
    coordinator.getSnapshot().token,
  );
}
const token = (coordinator: WorkspaceCoordinator) => coordinator.getSnapshot().token;

describe("backup restore through the real workspace coordinator", () => {
  it("survives reopening through real IndexedDB transactions with both exact original versions", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    try {
      const { io } = setup();
      Object.assign(io, {
        loadLocal: loadLocalWorkspaceRecord,
        saveLocal: saveLocalWorkspace,
        getBlob,
        putBlobIfAbsent,
        deleteUnreferencedBlob,
      });
      await saveLocalWorkspace(workspace());
      const first = new WorkspaceCoordinator(io);
      await first.activate(null);
      const prepared = await plan();
      await first.restoreBackup(prepared, token(first));
      const reopened = new WorkspaceCoordinator(io);
      await reopened.activate(null);
      expect(reopened.getSnapshot().data.sources).toHaveLength(1);
      expect(reopened.getSnapshot().data.notes[0].title).toBe("原来的笔记");
      expect(reopened.getSnapshot().data.sources[0].versions).toHaveLength(1);
      for (const entry of prepared.blobs)
        expect(await (await getBlob(entry.key))!.text()).toBe(await entry.blob.text());
      expect(io.saveCloud).not.toHaveBeenCalled();
    } finally {
      await deleteDB("conuo-web");
      vi.unstubAllGlobals();
    }
  });

  it("adds current and historical originals locally without replacing data or inheriting AI settings", async () => {
    const { coordinator, disk, originals, io } = setup();
    await coordinator.activate(null);
    const prepared = await plan();
    await coordinator.restoreBackup(prepared, token(coordinator));
    const saved = disk.get("local")!;
    expect(saved.sources).toHaveLength(1);
    expect(saved.notes[0].title).toBe("原来的笔记");
    expect(saved.spaces.map((item) => item.id)).toEqual(["existing", "restored-space"]);
    expect(saved.aiEnabled).toBe(true);
    expect(saved.sources[0].aiAllowed).toBe(false);
    expect(saved.autoOrganize).toBeUndefined();
    for (const entry of prepared.blobs)
      expect(await originals.get(entry.key)!.text()).toBe(await entry.blob.text());
    expect(io.saveCloud).not.toHaveBeenCalled();
    expect(io.uploadBlob).not.toHaveBeenCalled();
    expect(io.organizeCloud).not.toHaveBeenCalled();
    expect(coordinator.hasUnsavedLocalChanges()).toBe(false);
  });

  it("does not publish a partial copy before every original is read back", async () => {
    const { coordinator, originals, io } = setup();
    await coordinator.activate(null);
    const prepared = await plan();
    const gate = deferred<Blob | undefined>();
    vi.mocked(io.getBlob).mockImplementation(async (key) =>
      key === prepared.blobs[1].key ? gate.promise : originals.get(key),
    );
    const restoring = coordinator.restoreBackup(prepared, token(coordinator));
    await vi.waitFor(() => expect(io.getBlob).toHaveBeenCalledWith(prepared.blobs[1].key));
    expect(coordinator.getSnapshot().data.sources).toEqual([]);
    gate.resolve(prepared.blobs[1].blob);
    await restoring;
    expect(coordinator.getSnapshot().data.sources).toHaveLength(1);
  });

  it("merges into edits made while reading back originals", async () => {
    const { coordinator, disk, io } = setup();
    await coordinator.activate(null);
    const prepared = await plan(false);
    const gate = deferred<Blob | undefined>();
    vi.mocked(io.getBlob).mockReturnValueOnce(gate.promise);
    const restoring = coordinator.restoreBackup(prepared, token(coordinator));
    await vi.waitFor(() => expect(io.getBlob).toHaveBeenCalled());
    edit(coordinator, "准备恢复时继续编辑");
    gate.resolve(prepared.blobs[0].blob);
    await restoring;
    expect(disk.get("local")!.notes[0].title).toBe("准备恢复时继续编辑");
    expect(disk.get("local")!.sources).toHaveLength(1);
  });

  it("waits for local persistence and preserves edits arriving while an earlier write is pending", async () => {
    const { coordinator, disk, io } = setup();
    await coordinator.activate(null);
    const gate = deferred<void>();
    vi.mocked(io.saveLocal).mockImplementationOnce(async (data, id = "local") => {
      await gate.promise;
      disk.set(id, structuredClone(data));
    });
    edit(coordinator, "保存中的编辑");
    const prepared = await plan(false);
    let completed = false;
    const restoring = coordinator.restoreBackup(prepared, token(coordinator)).then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(coordinator.getSnapshot().data.sources).toHaveLength(1));
    edit(coordinator, "恢复期间的最新编辑");
    expect(completed).toBe(false);
    gate.resolve();
    await restoring;
    await vi.waitFor(() => expect(disk.get("local")!.notes[0].title).toBe("恢复期间的最新编辑"));
    expect(disk.get("local")!.sources).toHaveLength(1);
  });

  it("makes concurrent and later submission of one plan idempotent while preserving later edits", async () => {
    const { coordinator, disk, io } = setup();
    await coordinator.activate(null);
    const prepared = await plan();
    await Promise.all([
      coordinator.restoreBackup(prepared, token(coordinator)),
      coordinator.restoreBackup(prepared, token(coordinator)),
    ]);
    edit(coordinator, "恢复后的笔记编辑");
    await coordinator.restoreBackup(prepared, token(coordinator));
    expect(io.putBlobIfAbsent).toHaveBeenCalledTimes(2);
    expect(disk.get("local")!.sources).toHaveLength(1);
    expect(disk.get("local")!.notes[0].title).toBe("恢复后的笔记编辑");
  });

  it("keeps newly referenced originals and retries persistence without duplicate copies after quota failure", async () => {
    const { coordinator, disk, originals, io } = setup();
    await coordinator.activate(null);
    vi.mocked(io.saveLocal).mockRejectedValue(new DOMException("quota", "QuotaExceededError"));
    const prepared = await plan();
    await expect(coordinator.restoreBackup(prepared, token(coordinator))).rejects.toThrow("保存");
    expect(coordinator.getSnapshot().data.sources).toHaveLength(1);
    expect(coordinator.hasUnsavedLocalChanges()).toBe(true);
    expect(coordinator.getSnapshot().status).toBe("error");
    expect(originals.size).toBe(2);
    expect(io.deleteUnreferencedBlob).not.toHaveBeenCalled();
    edit(coordinator, "失败后继续编辑");
    vi.mocked(io.saveLocal).mockImplementation(async (data, id = "local") => {
      disk.set(id, structuredClone(data));
    });
    await coordinator.restoreBackup(prepared, token(coordinator));
    expect(disk.get("local")!.sources).toHaveLength(1);
    expect(disk.get("local")!.notes[0].title).toBe("失败后继续编辑");
    expect(io.putBlobIfAbsent).toHaveBeenCalledTimes(2);
    expect(coordinator.hasUnsavedLocalChanges()).toBe(false);
  });

  it("cleans only originals created by a failed prepublication attempt", async () => {
    const { coordinator, originals, io } = setup();
    await coordinator.activate(null);
    const prepared = await plan();
    const existing = new Blob(["其他账号的原件"]);
    originals.set("unrelated", existing);
    vi.mocked(io.putBlobIfAbsent)
      .mockImplementationOnce(async (key, blob) => {
        originals.set(key, blob);
        return true;
      })
      .mockRejectedValueOnce(new DOMException("quota", "QuotaExceededError"));
    await expect(coordinator.restoreBackup(prepared, token(coordinator))).rejects.toThrow();
    expect(coordinator.getSnapshot().data.sources).toEqual([]);
    expect(originals).toEqual(new Map([["unrelated", existing]]));
    expect(io.deleteUnreferencedBlob).toHaveBeenCalledExactlyOnceWith(prepared.blobs[0].key);
  });

  it("does not delete an original whose add acknowledgement is uncertain", async () => {
    const { coordinator, originals, io } = setup();
    await coordinator.activate(null);
    const prepared = await plan(false);
    vi.mocked(io.putBlobIfAbsent).mockImplementation(async (key, blob) => {
      originals.set(key, blob);
      throw new Error("connection interrupted after write");
    });
    await expect(coordinator.restoreBackup(prepared, token(coordinator))).rejects.toThrow();
    expect(coordinator.getSnapshot().data.sources).toEqual([]);
    expect(originals.size).toBe(1);
    expect(io.deleteUnreferencedBlob).not.toHaveBeenCalled();
  });

  it("refuses key collisions without overwriting or deleting existing bytes", async () => {
    const { coordinator, originals, io } = setup();
    await coordinator.activate(null);
    const prepared = await plan(false);
    const existing = new Blob(["另一个原件"]);
    originals.set(prepared.blobs[0].key, existing);
    await expect(coordinator.restoreBackup(prepared, token(coordinator))).rejects.toThrow(
      "已经存在",
    );
    expect(originals.get(prepared.blobs[0].key)).toBe(existing);
    expect(io.deleteUnreferencedBlob).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().data.sources).toEqual([]);
  });

  it.each(["hash", "size", "key", "missing", "cloud-path", "ai-permission"])(
    "rejects invalid %s before publishing or writing bytes",
    async (invalid) => {
      const { coordinator, io } = setup();
      await coordinator.activate(null);
      const prepared = await plan(false);
      if (invalid === "hash") prepared.data.sources[0].hash = "f".repeat(64);
      if (invalid === "size") prepared.data.sources[0].size++;
      if (invalid === "key") prepared.blobs[0].key = "original:foreign:version";
      if (invalid === "missing") prepared.blobs = [];
      if (invalid === "cloud-path") prepared.data.sources[0].storagePath = "old-owner/original";
      if (invalid === "ai-permission") prepared.data.sources[0].aiAllowed = true;
      await expect(coordinator.restoreBackup(prepared, token(coordinator))).rejects.toThrow();
      expect(io.putBlobIfAbsent).not.toHaveBeenCalled();
      expect(coordinator.getSnapshot().data.sources).toEqual([]);
    },
  );

  it("rechecks capacity against concurrent edits and retains those edits on restore rejection", async () => {
    const { coordinator, disk, originals, io } = setup();
    await coordinator.activate(null);
    const prepared = await plan(false);
    vi.mocked(io.putBlobIfAbsent).mockImplementation(async (key, blob) => {
      originals.set(key, blob);
      coordinator.update(
        (current) => ({
          ...current,
          spaces: [
            current.spaces[0],
            ...Array.from({ length: 499 }, (_, i) => ({ ...current.spaces[0], id: `added-${i}` })),
          ],
        }),
        token(coordinator),
      );
      return true;
    });
    await expect(coordinator.restoreBackup(prepared, token(coordinator))).rejects.toThrow();
    expect(coordinator.getSnapshot().data.spaces).toHaveLength(500);
    expect(coordinator.getSnapshot().data.sources).toEqual([]);
    await vi.waitFor(() => expect(disk.get("local")!.spaces).toHaveLength(500));
    expect(originals.size).toBe(0);
  });

  it("keeps a confirmed staged original if another in-memory record acquires its reference", async () => {
    const { coordinator, originals, io } = setup();
    await coordinator.activate(null);
    const prepared = await plan(false);
    vi.mocked(io.putBlobIfAbsent).mockImplementation(async (key, blob) => {
      originals.set(key, blob);
      coordinator.update(
        (data) => ({ ...data, sources: [structuredClone(prepared.data.sources[0])] }),
        token(coordinator),
      );
      return true;
    });
    await expect(coordinator.restoreBackup(prepared, token(coordinator))).rejects.toThrow();
    expect(originals.size).toBe(1);
    expect(io.deleteUnreferencedBlob).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().data.sources).toHaveLength(1);
  });

  it("does not write through a stale account token", async () => {
    const { coordinator, io } = setup();
    await coordinator.activate(null);
    const previous = token(coordinator);
    await coordinator.activate(accountB);
    await expect(coordinator.restoreBackup(await plan(false), previous)).rejects.toThrow("账号");
    expect(io.putBlobIfAbsent).not.toHaveBeenCalled();
  });

  it("stops and cleans a prepublication restore when the account changes", async () => {
    const { coordinator, disk, originals, io } = setup();
    await coordinator.activate(null);
    const prepared = await plan(false);
    const gate = deferred<Blob | undefined>();
    vi.mocked(io.getBlob).mockReturnValueOnce(gate.promise);
    const restoring = coordinator.restoreBackup(prepared, token(coordinator));
    const rejection = expect(restoring).rejects.toThrow("账号");
    await vi.waitFor(() => expect(io.getBlob).toHaveBeenCalled());
    await coordinator.activate(accountB);
    gate.resolve(prepared.blobs[0].blob);
    await rejection;
    expect(disk.get("local")!.sources).toEqual([]);
    expect(coordinator.getSnapshot().data.sources).toEqual([]);
    expect(originals.size).toBe(0);
  });

  it("retains an already-published copy under its original account after a switch during persistence", async () => {
    const { coordinator, disk, io } = setup();
    await coordinator.activate(null);
    const prepared = await plan(false);
    const gate = deferred<void>();
    vi.mocked(io.saveLocal).mockImplementationOnce(async (data, id = "local") => {
      await gate.promise;
      disk.set(id, structuredClone(data));
    });
    const restoring = coordinator.restoreBackup(prepared, token(coordinator));
    const rejection = expect(restoring).rejects.toThrow("账号");
    await vi.waitFor(() => expect(coordinator.getSnapshot().data.sources).toHaveLength(1));
    await coordinator.activate(accountB);
    gate.resolve();
    await rejection;
    await vi.waitFor(() => expect(disk.get("local")!.sources).toHaveLength(1));
    expect(coordinator.getSnapshot().data.sources).toEqual([]);
    expect(io.deleteUnreferencedBlob).not.toHaveBeenCalled();
    expect(vi.mocked(io.uploadBlob).mock.calls.some((call) => call[2] === "B")).toBe(false);
  });

  it("uses the existing cloud queue with new-owner original paths while preserving global settings", async () => {
    const { coordinator, remote, disk, io } = setup();
    remote.set("A", {
      data: { ...workspace(), autoOrganize: true, semanticSearch: true },
      revision: 4,
    });
    await coordinator.activate(accountA);
    const prepared = await plan();
    await coordinator.restoreBackup(prepared, token(coordinator));
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
    expect(io.uploadBlob).toHaveBeenCalledTimes(2);
    const saved = remote.get("A")!.data!;
    expect(saved.sources[0].storagePath).toBe("A/restored-current/restored-source.txt");
    expect(saved.sources[0].versions![0].storagePath).toBe("A/restored-old/restored-source.txt");
    expect(saved.autoOrganize).toBe(true);
    expect(saved.semanticSearch).toBe(true);
    expect(saved.sources[0].aiAllowed).toBe(false);
    expect(disk.get("A")?._conuoSync?.dirty).toBe(false);
    expect(io.organizeCloud).not.toHaveBeenCalled();
  });

  it("retains new copies locally during an existing cloud conflict without discarding either version", async () => {
    const { coordinator, remote, disk, io } = setup();
    disk.set("A", { ...workspace(), _conuoSync: { revision: 1, dirty: true } });
    const cloud = workspace();
    cloud.notes[0].title = "其他设备的编辑";
    remote.set("A", { data: cloud, revision: 3 });
    await coordinator.activate(accountA);
    const recovery = structuredClone(coordinator.getSnapshot().recovery);
    expect(coordinator.getSnapshot().status).toBe("conflict");
    await coordinator.restoreBackup(await plan(false), token(coordinator));
    expect(coordinator.getSnapshot().status).toBe("conflict");
    expect(coordinator.getSnapshot().recovery).toEqual(recovery);
    expect(disk.get("A")!.sources).toHaveLength(1);
    expect(io.uploadBlob).not.toHaveBeenCalled();
    expect(io.saveCloud).not.toHaveBeenCalled();
    expect(remote.get("A")!.data!.notes[0].title).toBe("其他设备的编辑");
  });

  it.each([false, true])(
    "does not report a copy as current after useRemote removes it during local confirmation (retry=%s)",
    async (retry) => {
      const { coordinator, remote, disk, io } = setup();
      disk.set("A", { ...workspace(), _conuoSync: { revision: 1, dirty: true } });
      const cloud = workspace();
      cloud.notes[0].title = "选择加载的云端副本";
      remote.set("A", { data: cloud, revision: 3 });
      await coordinator.activate(accountA);
      const prepared = await plan(false);
      if (retry) await coordinator.restoreBackup(prepared, token(coordinator));
      const gate = deferred<void>();
      let held = false;
      vi.mocked(io.saveLocal).mockImplementation(async (data, id = "local") => {
        if (id === "A" && !held) {
          held = true;
          await gate.promise;
        }
        disk.set(id, structuredClone(data));
      });
      const restoring = coordinator.restoreBackup(prepared, token(coordinator));
      const rejection = expect(restoring).rejects.toThrow("当前工作区");
      await vi.waitFor(() => expect(held).toBe(true));
      expect(coordinator.getSnapshot().data.sources).toHaveLength(1);
      const remoteLoad = coordinator.useRemote(token(coordinator));
      await vi.waitFor(() => {
        expect(coordinator.getSnapshot().ready).toBe(true);
        expect(coordinator.getSnapshot().data.sources).toEqual([]);
      });
      gate.resolve();
      await Promise.all([rejection, remoteLoad]);
      await vi.waitFor(() => expect(disk.get("A")!.sources).toEqual([]));
      expect(coordinator.getSnapshot().data.notes[0].title).toBe("选择加载的云端副本");
      const savedBackup = [...disk.entries()].find(([key]) => key.startsWith("recovery:A:"));
      expect(savedBackup?.[1].sources).toHaveLength(1);
      expect(io.deleteUnreferencedBlob).not.toHaveBeenCalled();
    },
  );

  it("never checks an imported task against the old ledger, but permits explicit fresh generation", async () => {
    const { coordinator, remote, io } = setup();
    remote.set("A", { data: workspace(), revision: 1 });
    await coordinator.activate(accountA);
    const prepared = await plan(false);
    const source = prepared.data.sources[0];
    const jobId = "restored-job";
    prepared.data.organizationJobs = [
      {
        id: jobId,
        status: "cancelled",
        restoredFromBackup: true,
        createdAt: at,
        updatedAt: at,
        request: {
          requestId: jobId,
          kind: "source",
          trigger: "manual",
          spaceId: "restored-space",
          sourceIds: [source.id],
          sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
        },
      },
    ];
    prepared.counts.organizationJobs = 1;
    await coordinator.restoreBackup(prepared, token(coordinator));
    coordinator.update(
      (data) => ({ ...data, sources: data.sources.map((item) => ({ ...item, aiAllowed: true })) }),
      token(coordinator),
    );
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
    vi.mocked(io.getModelStatus).mockResolvedValue({ mode: "model", message: "已配置" });
    vi.mocked(io.organizeCloud).mockRejectedValue(new Error("new request transport sentinel"));
    await expect(coordinator.checkOrganization(jobId, token(coordinator))).rejects.toThrow(
      "备份中的任务属于原工作区",
    );
    expect(io.getModelStatus).not.toHaveBeenCalled();
    expect(io.organizeCloud).not.toHaveBeenCalled();
    await expect(coordinator.retryOrganization(jobId, token(coordinator))).rejects.toThrow(
      "new request transport sentinel",
    );
    expect(io.organizeCloud).toHaveBeenCalledOnce();
    const newRequest = vi.mocked(io.organizeCloud).mock.calls[0][0];
    expect(newRequest.requestId).not.toBe(jobId);
    expect(newRequest.trigger).toBe("manual");
    expect(newRequest.sourceVersions).toEqual([
      { sourceId: source.id, versionId: source.versionId },
    ]);
    const jobs = coordinator.getSnapshot().data.organizationJobs!;
    expect(jobs).toHaveLength(2);
    expect(jobs.find((job) => job.id === jobId)).toMatchObject({
      status: "cancelled",
      restoredFromBackup: true,
    });
    expect(jobs.find((job) => job.id === newRequest.requestId)).not.toHaveProperty(
      "restoredFromBackup",
    );
  });

  it("does not lose a restore when an earlier cloud save acknowledges afterward", async () => {
    const { coordinator, remote, io } = setup();
    remote.set("A", { data: workspace(), revision: 1 });
    await coordinator.activate(accountA);
    const gate = deferred<{ revision: number }>();
    vi.mocked(io.saveCloud).mockImplementationOnce(async (data, revision, id) => {
      await gate.promise;
      remote.set(id, { data: structuredClone(data), revision: revision + 1 });
      return { revision: revision + 1 };
    });
    edit(coordinator, "云请求发出前");
    await vi.waitFor(() => expect(io.saveCloud).toHaveBeenCalledOnce());
    await coordinator.restoreBackup(await plan(false), token(coordinator));
    edit(coordinator, "恢复后的最新编辑");
    gate.resolve({ revision: 2 });
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
    expect(remote.get("A")!.data!.sources).toHaveLength(1);
    expect(remote.get("A")!.data!.notes[0].title).toBe("恢复后的最新编辑");
    expect(remote.get("A")!.revision).toBe(3);
  });
});
