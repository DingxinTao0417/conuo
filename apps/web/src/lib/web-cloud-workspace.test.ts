import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceCoordinator, type WorkspaceIO } from "./use-workspace";
import { WebSessionStore } from "./web-session-store";
import { createDemoWorkspace, createEmptyWorkspace } from "./seed";
import { prepareBackupRestore } from "./backup-restore";
import { prepareImportFile, parseImportSource } from "./import";
import { assertWorkspaceOwner, workspaceSchema } from "./supabase/validation";
import type { RestorePlan } from "./backup-types";
import type { WorkspaceData } from "./types";

vi.mock("./cloud", () => ({
  askCloud: vi.fn(),
  cancelOrganizationJob: vi.fn(),
  cancelImportParse: vi.fn(),
  claimImportParse: vi.fn(),
  downloadSourceBlob: vi.fn(),
  enqueueOrganizationJob: vi.fn(),
  finishImportParse: vi.fn(),
  heartbeatImportParse: vi.fn(),
  isCloudConfigured: () => false,
  loadCloudWorkspace: vi.fn(),
  loadCloudWorkspaceRevision: vi.fn(),
  getModelStatus: vi.fn(),
  organizeCloud: vi.fn(),
  previewSourcePurge: vi.fn(),
  previewSourceVersionPurge: vi.fn(),
  reconcileOrganizationJobs: vi.fn(),
  releaseImportParse: vi.fn(),
  requestSourcePurge: vi.fn(),
  requestSourceVersionPurge: vi.fn(),
  retryImportParse: vi.fn(),
  saveCloudWorkspace: vi.fn(),
  subscribeSession: vi.fn(),
  uploadSourceBlob: vi.fn(),
}));

const a = { id: "account-a", email: "a@example.test" };
const b = { id: "account-b", email: "b@example.test" };
type Remote = { data: WorkspaceData | null; revision: number };
const coordinators: WorkspaceCoordinator[] = [];

afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.dispose();
  vi.unstubAllGlobals();
});

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
  data.spaces[0].name = name;
  data.notes = [
    {
      id: crypto.randomUUID(),
      spaceId: data.spaces[0].id,
      title: `${name}笔记`,
      content: `<p>${name}原有正文</p>`,
      kind: "note",
      status: "accepted",
      citations: [],
      versions: [],
      createdAt: "2026-09-15T08:00:00.000Z",
      updatedAt: "2026-09-15T08:00:00.000Z",
      deletedAt: null,
    },
  ];
  return workspaceSchema.parse(data);
}

function setup(
  remote = new Map<string, Remote>([
    [a.id, { data: workspace("甲账号云端"), revision: 3 }],
    [b.id, { data: workspace("乙账号云端"), revision: 8 }],
  ]),
) {
  const memory = new WebSessionStore();
  const io: WorkspaceIO = {
    beginSession: vi.fn(memory.beginSession),
    clearSession: vi.fn(memory.clearSession),
    loadLocal: vi.fn(memory.loadLocal),
    saveLocal: vi.fn(memory.saveLocal),
    commitLocalImport: memory.commitLocalImport,
    getBlob: vi.fn(memory.getBlob),
    getAccountBlob: vi.fn(memory.getBlob),
    putBlobIfAbsent: vi.fn(memory.putBlobIfAbsent),
    putAccountBlobIfAbsent: vi.fn(memory.putBlobIfAbsent),
    deleteUnreferencedBlob: vi.fn(memory.deleteUnreferencedBlob),
    deleteAccountUnreferencedBlob: vi.fn(memory.deleteUnreferencedBlob),
    clearAccountLocalCache: vi.fn(memory.clearAccountLocalCache),
    isAccountLocallyDeleted: vi.fn(memory.isAccountLocallyDeleted),
    markAccountLocalDeletion: vi.fn(memory.markAccountLocalDeletion),
    subscribeLocalAccountDeletions: vi.fn(memory.subscribeLocalAccountDeletions),
    loadCloud: vi.fn(async (owner) =>
      structuredClone(remote.get(owner) ?? { data: null, revision: 0 }),
    ),
    loadCloudRevision: vi.fn(async (owner) => ({ revision: remote.get(owner)?.revision ?? 0 })),
    saveCloud: vi.fn(async (snapshot, expected, owner) => {
      const data = workspaceSchema.parse(snapshot);
      assertWorkspaceOwner(data, owner);
      const current = remote.get(owner)?.revision ?? 0;
      if (expected !== current) throw new Error("409 cloud revision conflict");
      remote.set(owner, { data: structuredClone(data), revision: current + 1 });
      return { revision: current + 1 };
    }),
    uploadBlob: vi.fn(
      async (source, _blob, owner) => `${owner}/${source.id}/${source.versionId}/original`,
    ),
    downloadBlob: vi.fn(async () => undefined),
    askCloud: vi.fn(),
    organizeCloud: vi.fn(),
    getModelStatus: vi.fn(),
    readLegacyMeta: vi.fn(() => {
      throw new Error("web must not read legacy localStorage metadata");
    }),
  };
  const coordinator = new WorkspaceCoordinator(io, undefined, { storageMode: "cloud" });
  coordinators.push(coordinator);
  return { coordinator, io, memory, remote };
}

function edit(coordinator: WorkspaceCoordinator, title = "当前页面的新标题") {
  return coordinator.update(
    (data) => ({
      ...data,
      notes: data.notes.map((note) => ({ ...note, title })),
    }),
    coordinator.getSnapshot().token,
  );
}

async function restorePlan(withOriginal = false): Promise<RestorePlan> {
  const data = createDemoWorkspace();
  const source = data.sources[0];
  const chunk = source.chunks[0];
  const citation = {
    sourceId: source.id,
    versionId: source.versionId,
    chunkId: chunk.id,
    title: source.title,
    quote: chunk.text,
    section: chunk.section,
  };
  data.notes = [
    {
      ...workspace("匿名备份").notes[0],
      spaceId: data.spaces[0].id,
      content: `<p>匿名笔记正文 <a href="#source/${source.id}">查看原文</a></p>`,
      citations: [citation],
      versions: [
        {
          id: crypto.randomUUID(),
          title: "匿名笔记历史",
          content: "<p>匿名历史正文</p>",
          citations: [citation],
          savedAt: "2026-09-14T08:00:00.000Z",
        },
      ],
    },
  ];
  const originals = [];
  if (withOriginal) {
    const file = new File(["# 匿名原件\n\n匿名保存的原始资料。"], "anonymous.md", {
      type: "text/markdown",
    });
    const prepared = await prepareImportFile(file, data.spaces[0].id, true);
    data.sources.push(await parseImportSource(prepared, file));
    originals.push({ sourceId: prepared.id, versionId: prepared.versionId, blob: file });
  }
  return prepareBackupRestore({
    data,
    originals,
    missingOriginals: [],
    fingerprint: "a".repeat(64),
  });
}

describe("cloud-only web through the real workspace coordinator", () => {
  it("requires login before any workspace read or write", async () => {
    const { coordinator, io } = setup();
    await coordinator.activate(null);
    expect(coordinator.getSnapshot()).toMatchObject({ ready: false, user: null, status: "error" });
    expect(coordinator.getSnapshot().error).toContain("登录");
    expect(io.loadLocal).not.toHaveBeenCalled();
    expect(io.loadCloud).not.toHaveBeenCalled();
    expect(io.saveLocal).not.toHaveBeenCalled();
    expect(io.saveCloud).not.toHaveBeenCalled();
    expect(edit(coordinator)).toBe(false);
    expect(coordinator.getSnapshot().signOutState.canKeepLocalDraft).toBe(false);
  });

  it("does not publish an empty library or PUT after the first cloud GET fails, and retries the cloud", async () => {
    const { coordinator, io, remote } = setup();
    vi.mocked(io.loadCloud).mockRejectedValueOnce(new Error("GET unavailable"));
    await coordinator.activate(a);
    expect(coordinator.getSnapshot()).toMatchObject({ ready: false, status: "error" });
    expect(edit(coordinator)).toBe(false);
    expect(io.saveCloud).not.toHaveBeenCalled();
    expect(io.saveLocal).not.toHaveBeenCalled();
    await coordinator.retry(coordinator.getSnapshot().token);
    expect(coordinator.getSnapshot()).toMatchObject({ ready: true, status: "cloud" });
    expect(coordinator.getSnapshot().data).toEqual(remote.get(a.id)!.data);
    expect(io.loadCloud).toHaveBeenCalledTimes(2);
    expect(io.saveCloud).not.toHaveBeenCalled();
    expect(io.readLegacyMeta).not.toHaveBeenCalled();
  });

  it("initializes and saves without reading IndexedDB, localStorage, or sessionStorage", async () => {
    const inaccessible = new Proxy(
      {},
      {
        get: () => {
          throw new Error("persistent browser storage accessed");
        },
      },
    );
    vi.stubGlobal("indexedDB", inaccessible);
    vi.stubGlobal("localStorage", inaccessible);
    vi.stubGlobal("sessionStorage", inaccessible);
    const { coordinator, io, remote } = setup();
    await coordinator.activate(a);
    expect(coordinator.getSnapshot()).toMatchObject({ ready: true, status: "cloud" });
    expect(io.readLegacyMeta).not.toHaveBeenCalled();
    expect(edit(coordinator)).toBe(true);
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
    expect(remote.get(a.id)!.data!.notes[0].title).toBe("当前页面的新标题");
    expect(io.saveCloud).toHaveBeenCalledExactlyOnceWith(expect.any(Object), 3, a.id);
    expect(coordinator.hasUnsavedLocalChanges()).toBe(false);
  });

  it("keeps failed cloud edits only in page memory and never offers a durable local exit", async () => {
    const { coordinator, io, memory, remote } = setup();
    await coordinator.activate(a);
    const original = structuredClone(remote.get(a.id));
    vi.mocked(io.saveCloud).mockRejectedValue(new Error("PUT unavailable"));
    expect(edit(coordinator)).toBe(true);
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("error"));
    expect((await memory.loadLocal(a.id))!.notes[0].title).toBe("当前页面的新标题");
    expect(remote.get(a.id)).toEqual(original);
    expect(coordinator.getSnapshot().signOutState).toMatchObject({ canKeepLocalDraft: false });
    expect(coordinator.hasUnsavedLocalChanges()).toBe(true);
    const auth = vi.fn(async () => {});
    await expect(
      coordinator.signOut(coordinator.getSnapshot().token, "local", auth),
    ).rejects.toThrow("网页版");
    await expect(
      coordinator.signOut(coordinator.getSnapshot().token, "direct", auth),
    ).rejects.toThrow();
    expect(auth).not.toHaveBeenCalled();
  });

  it("a fresh page fetches only authoritative cloud data instead of recovering unsaved page edits", async () => {
    const first = setup();
    await first.coordinator.activate(a);
    vi.mocked(first.io.saveCloud).mockRejectedValue(new Error("PUT unavailable"));
    edit(first.coordinator, "只在旧页面的草稿");
    await vi.waitFor(() => expect(first.coordinator.getSnapshot().status).toBe("error"));
    first.coordinator.dispose();
    const fresh = setup(first.remote);
    await fresh.coordinator.activate(a);
    expect(fresh.coordinator.getSnapshot().data).toEqual(first.remote.get(a.id)!.data);
    expect(fresh.coordinator.getSnapshot().data.notes[0].title).not.toBe("只在旧页面的草稿");
    expect(fresh.io.readLegacyMeta).not.toHaveBeenCalled();
    expect(fresh.io.saveCloud).not.toHaveBeenCalled();
  });

  it("restores as new copies into a nonempty account, preserves originals, and waits for cloud confirmation", async () => {
    const { coordinator, io, remote } = setup();
    await coordinator.activate(a);
    const original = structuredClone(remote.get(a.id)!.data!);
    const plan = await restorePlan(true);
    const waiting = deferred<void>();
    const save = vi.mocked(io.saveCloud).getMockImplementation()!;
    vi.mocked(io.saveCloud).mockImplementation(async (...args) => {
      await waiting.promise;
      return save(...args);
    });
    let completed = false;
    const restoring = coordinator.restoreBackup(plan, coordinator.getSnapshot().token).then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(io.saveCloud).toHaveBeenCalled());
    expect(completed).toBe(false);
    expect(remote.get(a.id)!.data).toEqual(original);
    waiting.resolve();
    await restoring;
    expect(completed).toBe(true);
    expect(coordinator.getSnapshot().status).toBe("cloud");
    const saved = remote.get(a.id)!.data!;
    expect(saved.notes).toEqual([...original.notes, ...plan.data.notes]);
    expect(saved.notes.at(-1)!.citations[0].sourceId).toBe(plan.data.sources[0].id);
    expect(saved.notes.at(-1)!.versions[0].citations).toEqual(
      plan.data.notes[0].versions[0].citations,
    );
    expect(saved.sources).toHaveLength(plan.counts.sources);
    expect(saved.sources.every((source) => !source.aiAllowed)).toBe(true);
    const withOriginal = saved.sources.find((source) => source.id === plan.blobs[0].sourceId)!;
    expect(withOriginal.storagePath).toContain(a.id);
    expect(io.uploadBlob).toHaveBeenCalledTimes(1);
  });

  it("rejects unconfirmed cloud restore and reuses the same plan on retry without duplicate copies", async () => {
    const { coordinator, io, remote } = setup();
    await coordinator.activate(a);
    const original = structuredClone(remote.get(a.id)!.data!);
    const plan = await restorePlan();
    const save = vi.mocked(io.saveCloud).getMockImplementation()!;
    vi.mocked(io.saveCloud).mockRejectedValueOnce(new Error("PUT unavailable"));
    await expect(
      coordinator.restoreBackup(plan, coordinator.getSnapshot().token),
    ).rejects.toThrow();
    expect(coordinator.getSnapshot().status).toBe("error");
    expect(coordinator.hasUnsavedLocalChanges()).toBe(true);
    expect(remote.get(a.id)!.data).toEqual(original);
    expect(coordinator.getSnapshot().data.sources).toHaveLength(plan.counts.sources);
    vi.mocked(io.saveCloud).mockImplementation(save);
    await coordinator.retry(coordinator.getSnapshot().token);
    await coordinator.restoreBackup(plan, coordinator.getSnapshot().token);
    expect(coordinator.getSnapshot().status).toBe("cloud");
    expect(remote.get(a.id)!.data!.sources).toHaveLength(plan.counts.sources);
    expect(remote.get(a.id)!.data!.notes).toEqual([...original.notes, ...plan.data.notes]);
  });

  it("recognizes a restore already committed by cloud when its response was lost, without a second PUT", async () => {
    const { coordinator, io, remote } = setup();
    await coordinator.activate(a);
    const original = structuredClone(remote.get(a.id)!.data!);
    const plan = await restorePlan();
    const save = vi.mocked(io.saveCloud).getMockImplementation()!;
    vi.mocked(io.saveCloud).mockImplementationOnce(async (...args) => {
      await save(...args);
      throw new Error("committed but HTTP response lost");
    });
    const result = await coordinator
      .restoreBackup(plan, coordinator.getSnapshot().token)
      .catch((cause: unknown) => cause);
    expect(remote.get(a.id)!.data).toEqual(vi.mocked(io.saveCloud).mock.calls[0][0]);
    if (result instanceof Error) throw result;
    expect(coordinator.getSnapshot().status).toBe("cloud");
    expect(io.saveCloud).toHaveBeenCalledTimes(1);
    expect(remote.get(a.id)!.data!.sources).toHaveLength(plan.counts.sources);
    expect(remote.get(a.id)!.data!.notes).toEqual([...original.notes, ...plan.data.notes]);
    await coordinator.restoreBackup(plan, coordinator.getSnapshot().token);
    expect(io.saveCloud).toHaveBeenCalledTimes(1);
  });

  it("both callers of the same restore plan wait for the one cloud confirmation", async () => {
    const { coordinator, io } = setup();
    await coordinator.activate(a);
    const plan = await restorePlan();
    const waiting = deferred<void>();
    const save = vi.mocked(io.saveCloud).getMockImplementation()!;
    vi.mocked(io.saveCloud).mockImplementationOnce(async (...args) => {
      await waiting.promise;
      return save(...args);
    });
    let completions = 0;
    const first = coordinator
      .restoreBackup(plan, coordinator.getSnapshot().token)
      .then(() => completions++);
    await vi.waitFor(() => expect(io.saveCloud).toHaveBeenCalledTimes(1));
    const second = coordinator
      .restoreBackup(plan, coordinator.getSnapshot().token)
      .then(() => completions++);
    await Promise.resolve();
    await Promise.resolve();
    expect(completions).toBe(0);
    waiting.resolve();
    await Promise.all([first, second]);
    expect(completions).toBe(2);
    expect(io.saveCloud).toHaveBeenCalledTimes(1);
  });

  it("requires a completed backup before discarding a conflicting web session snapshot", async () => {
    const { coordinator, io, remote } = setup();
    await coordinator.activate(a);
    vi.mocked(io.saveCloud).mockRejectedValue(new Error("PUT unavailable"));
    edit(coordinator, "当前页面尚未保存的编辑");
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("error"));
    const candidate = workspace("云端另一次编辑");
    remote.set(a.id, { data: candidate, revision: 4 });
    await coordinator.retry(coordinator.getSnapshot().token);
    expect(coordinator.getSnapshot().status).toBe("conflict");
    const before = coordinator.getSnapshot().data;
    await expect(coordinator.useRemote(coordinator.getSnapshot().token)).rejects.toThrow(
      "完整导出",
    );
    await expect(
      coordinator.useRemote(coordinator.getSnapshot().token, async () => false),
    ).rejects.toThrow("完整导出");
    expect(coordinator.getSnapshot().data).toBe(before);
    const backup = vi.fn(async (snapshot: WorkspaceData) => {
      expect(snapshot).toEqual(before);
      return true;
    });
    await coordinator.useRemote(coordinator.getSnapshot().token, backup);
    expect(backup).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot().data).toEqual(candidate);
    expect(coordinator.getSnapshot().status).toBe("cloud");
  });

  it("updateDurably waits for cloud confirmation rather than only memory persistence", async () => {
    const { coordinator, io, remote } = setup();
    await coordinator.activate(a);
    const waiting = deferred<void>();
    const save = vi.mocked(io.saveCloud).getMockImplementation()!;
    vi.mocked(io.saveCloud).mockImplementationOnce(async (...args) => {
      await waiting.promise;
      return save(...args);
    });
    let completed = false;
    const saving = coordinator
      .updateDurably(
        (data) => ({
          ...data,
          notes: data.notes.map((note) => ({ ...note, title: "需要云端确认的标题" })),
        }),
        coordinator.getSnapshot().token,
      )
      .then(() => {
        completed = true;
      });
    await vi.waitFor(() => expect(io.saveCloud).toHaveBeenCalled());
    expect(completed).toBe(false);
    expect(coordinator.hasUnsavedLocalChanges()).toBe(true);
    waiting.resolve();
    await saving;
    expect(completed).toBe(true);
    expect(remote.get(a.id)!.data!.notes[0].title).toBe("需要云端确认的标题");
    expect(coordinator.getSnapshot().status).toBe("cloud");
  });

  it("does not display or save A's late cloud read after switching to B", async () => {
    const { coordinator, io, remote } = setup();
    const waiting = deferred<Remote>();
    vi.mocked(io.loadCloud).mockImplementationOnce(() => waiting.promise);
    const activatingA = coordinator.activate(a);
    await vi.waitFor(() => expect(io.loadCloud).toHaveBeenCalledWith(a.id));
    await coordinator.activate(b);
    waiting.resolve(structuredClone(remote.get(a.id)!));
    await activatingA;
    expect(coordinator.getSnapshot()).toMatchObject({ user: b, ready: true, status: "cloud" });
    expect(coordinator.getSnapshot().data).toEqual(remote.get(b.id)!.data);
    expect(io.saveCloud).not.toHaveBeenCalled();
    expect(vi.mocked(io.saveLocal).mock.calls.every(([, owner]) => owner === b.id)).toBe(true);
  });

  it("drops the outgoing account's temporary originals and never reads them from B", async () => {
    const { coordinator, memory, io } = setup();
    await coordinator.activate(a);
    await memory.putBlobIfAbsent("a-original", new Blob(["A private bytes"]), a.id);
    await coordinator.activate(b);
    await expect(memory.getBlob("a-original", b.id)).resolves.toBeUndefined();
    await expect(memory.getBlob("a-original", a.id)).rejects.toThrow("当前登录账号");
    expect(io.readLegacyMeta).not.toHaveBeenCalled();
  });

  it("dispose refuses a late initial cloud response and all subsequent writes", async () => {
    const { coordinator, io, remote } = setup();
    const waiting = deferred<Remote>();
    vi.mocked(io.loadCloud).mockImplementationOnce(() => waiting.promise);
    const activating = coordinator.activate(a);
    await vi.waitFor(() => expect(io.loadCloud).toHaveBeenCalled());
    coordinator.dispose();
    waiting.resolve(structuredClone(remote.get(a.id)!));
    await activating;
    expect(io.saveLocal).not.toHaveBeenCalled();
    expect(io.saveCloud).not.toHaveBeenCalled();
    expect(edit(coordinator)).toBe(false);
    expect(io.clearSession).toHaveBeenCalled();
  });

  it("dispose refuses late save continuations from recreating page memory", async () => {
    const { coordinator, io, memory } = setup();
    await coordinator.activate(a);
    const waiting = deferred<void>();
    const save = vi.mocked(io.saveCloud).getMockImplementation()!;
    vi.mocked(io.saveCloud).mockImplementationOnce(async (...args) => {
      await waiting.promise;
      return save(...args);
    });
    edit(coordinator);
    await vi.waitFor(() => expect(io.saveCloud).toHaveBeenCalled());
    const writesBeforeDispose = vi.mocked(io.saveLocal).mock.calls.length;
    coordinator.dispose();
    waiting.resolve();
    await vi.waitFor(() =>
      expect(vi.mocked(io.saveCloud).mock.settledResults[0]?.type).toBe("fulfilled"),
    );
    await Promise.resolve();
    expect(io.saveLocal).toHaveBeenCalledTimes(writesBeforeDispose);
    await expect(memory.loadLocal(a.id)).rejects.toThrow("登录");
    expect(edit(coordinator)).toBe(false);
  });

  it.each(["fulfilled", "rejected"] as const)(
    "dispose keeps released memory empty after a late %s session save",
    async (outcome) => {
      const { coordinator, io, memory } = setup();
      await coordinator.activate(a);
      const waiting = deferred<number>();
      vi.mocked(io.saveLocal).mockImplementationOnce(() => waiting.promise);
      const save = coordinator
        .updateDurably(
          (data) => ({
            ...data,
            notes: data.notes.map((note) => ({ ...note, title: "离开页面后不可复活的修改" })),
          }),
          coordinator.getSnapshot().token,
        )
        .catch((cause: unknown) => cause);
      await vi.waitFor(() =>
        expect(
          vi
            .mocked(io.saveLocal)
            .mock.calls.some(
              ([snapshot]) => snapshot.notes[0]?.title === "离开页面后不可复活的修改",
            ),
        ).toBe(true),
      );
      coordinator.dispose();
      expect(coordinator.hasUnsavedLocalChanges()).toBe(false);
      if (outcome === "fulfilled") waiting.resolve(2);
      else waiting.reject(new Error("已离开页面的会话保存失败"));
      await expect(save).resolves.toBeInstanceOf(Error);
      expect(coordinator.hasUnsavedLocalChanges()).toBe(false);
      expect(io.saveCloud).not.toHaveBeenCalled();
      await expect(memory.loadLocal(a.id)).rejects.toThrow("登录");
    },
  );

  it("same-account re-login refuses an outgoing queued snapshot before it enters the new session store", async () => {
    const { coordinator, io, memory, remote } = setup();
    await coordinator.activate(a);
    const original = structuredClone(remote.get(a.id)!.data!);
    const waiting = deferred<number>();
    vi.mocked(io.saveLocal).mockImplementationOnce(() => waiting.promise);
    const token = coordinator.getSnapshot().token;
    const updateTitle = (title: string) =>
      coordinator
        .updateDurably(
          (data) => ({ ...data, notes: data.notes.map((note) => ({ ...note, title })) }),
          token,
        )
        .catch((cause: unknown) => cause);
    const first = updateTitle("旧会话已进入保存适配器的修改");
    await vi.waitFor(() =>
      expect(
        vi
          .mocked(io.saveLocal)
          .mock.calls.some(
            ([snapshot]) => snapshot.notes[0]?.title === "旧会话已进入保存适配器的修改",
          ),
      ).toBe(true),
    );
    const queued = updateTitle("旧会话尚未调用保存适配器的修改");
    coordinator.dispose();
    const reactivating = coordinator.activate(a);
    await Promise.resolve();
    expect(io.beginSession).toHaveBeenCalledTimes(2);
    waiting.resolve(2);
    await Promise.all([first, queued, reactivating]);
    expect(
      vi
        .mocked(io.saveLocal)
        .mock.calls.some(
          ([snapshot]) => snapshot.notes[0]?.title === "旧会话尚未调用保存适配器的修改",
        ),
    ).toBe(false);
    expect(coordinator.getSnapshot()).toMatchObject({ user: a, ready: true, status: "cloud" });
    expect(coordinator.getSnapshot().data).toEqual(original);
    expect((await memory.loadLocal(a.id))!.notes).toEqual(original.notes);
    expect(coordinator.hasUnsavedLocalChanges()).toBe(false);
    expect(io.saveCloud).not.toHaveBeenCalled();
  });
});
