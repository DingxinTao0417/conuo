import { describe, expect, it, vi } from "vitest";
import { WorkspaceCoordinator, type ImportPipeline, type WorkspaceIO } from "./use-workspace";
import type { AnswerRequest, AnswerResult, Note, Source, WorkspaceData } from "./types";
import { createDemoWorkspace } from "./seed";
import { retrieveEvidence } from "./retrieval";
import { deleteLearningSpace, recycleSources } from "./space-lifecycle";
import { prepareImportFile } from "./import";
import { LOCAL_IMPORT_QUOTA_POLICY } from "./import-quota";
import { advanceImportJob, createImportJob, failImportJob, startImportJob } from "./import-queue";
import { createAnnotation } from "./annotations";
import {
  previewPermanentSourceDeletion,
  previewPermanentSourceDeletionContent,
  permanentSourceDeletionBlockers,
  type PermanentSourceDeletionSelection,
} from "./permanent-deletion";
import type {
  DurableOrganizationRequest,
  SourcePurgePreview,
  SourceVersionPurgePreview,
} from "./cloud";
import type { RestorePlan } from "./backup-types";
import { MAX_WORKSPACE_BYTES, workspaceSchema } from "./supabase/validation";
import { bindOrganizationResult, buildOrganizationGrounding } from "./ai/organization";
import type { OrganizationJob, OrganizationResult } from "./organization-types";
import type {
  LocalImportCommitResult,
  LocalImportMerger,
  LocalWorkspaceCommitEvent,
} from "./local-store";

// Tests exercise the same asynchronous coordinator used by the hook, without
// relying on React render timing or substituting an imitation of the save loop.
vi.mock("./cloud", () => ({
  askCloud: vi.fn(),
  cancelOrganizationJob: vi.fn(),
  cancelImportParse: vi.fn(),
  claimImportParse: vi.fn(),
  enqueueOrganizationJob: vi.fn(),
  organizeCloud: vi.fn(),
  finishImportParse: vi.fn(),
  getModelStatus: vi.fn(),
  heartbeatImportParse: vi.fn(),
  downloadSourceBlob: vi.fn(),
  isCloudConfigured: () => false,
  loadCloudWorkspace: vi.fn(),
  previewSourcePurge: vi.fn(),
  requestSourcePurge: vi.fn(),
  previewSourceVersionPurge: vi.fn(),
  requestSourceVersionPurge: vi.fn(),
  releaseImportParse: vi.fn(),
  reconcileOrganizationJobs: vi.fn(),
  retryImportParse: vi.fn(),
  saveCloudWorkspace: vi.fn(),
  subscribeSession: vi.fn(),
  uploadSourceBlob: vi.fn(),
}));
function data(name: string): WorkspaceData {
  return {
    schemaVersion: 1,
    spaces: [
      {
        id: "base",
        name,
        goal: "",
        color: "#4B3FE3",
        archived: false,
        createdAt: "2026-09-12T00:00:00.000Z",
      },
    ],
    sources: [],
    notes: [],
    annotations: [],
    conversations: [],
    aiEnabled: true,
  };
}
function note(content: string, patch: Partial<Note> = {}): Note {
  return {
    id: "note-a",
    spaceId: "base",
    title: "同步笔记",
    content,
    kind: "note",
    status: "accepted",
    citations: [],
    versions: [],
    contentRevision: 0,
    createdAt: "2026-09-13T08:00:00.000Z",
    updatedAt: "2026-09-13T08:00:00.000Z",
    deletedAt: null,
    ...patch,
  };
}
function workspaceWithNote(name: string, content: string): WorkspaceData {
  return { ...data(name), notes: [note(content)] };
}
function readingSource(patch: Partial<Source> = {}): Source {
  return {
    id: "source-a",
    versionId: "source-a-version",
    title: "阅读资料",
    filename: "reading.txt",
    kind: "text",
    mime: "text/plain",
    size: 12,
    hash: "reading-hash",
    spaceIds: ["base"],
    tags: [],
    status: "ready",
    text: "用于验证多端续读。",
    chunks: [],
    createdAt: "2026-09-13T08:00:00.000Z",
    updatedAt: "2026-09-13T08:00:00.000Z",
    deletedAt: null,
    aiAllowed: true,
    starred: false,
    ...patch,
  };
}
function workspaceWithReadingSource(patch: Partial<Source> = {}): WorkspaceData {
  return { ...data("base"), sources: [readingSource(patch)] };
}
function editNote(coordinator: WorkspaceCoordinator, content: string) {
  coordinator.update(
    (current) => ({
      ...current,
      notes: current.notes.map((item) => ({
        ...item,
        content,
        contentRevision: (item.contentRevision ?? 0) + 1,
        updatedAt: "2026-09-13T09:00:00.000Z",
      })),
    }),
    coordinator.getSnapshot().token,
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Stored = WorkspaceData & {
  _conuoSync?: {
    revision: number;
    dirty: boolean;
    base?: WorkspaceData;
    baseRevision?: number;
  };
  _conuoLocalRevision?: number;
};
function setup(imports?: ImportPipeline) {
  const disk = new Map<string, Stored>();
  const remote = new Map<string, { data: WorkspaceData | null; revision: number }>();
  const blobs = new Map<string, Blob>();
  const io: WorkspaceIO = {
    loadLocal: vi.fn(async (id = "local") => structuredClone(disk.get(id) || null)),
    saveLocal: vi.fn(async (snapshot, id = "local") => {
      disk.set(id, structuredClone(snapshot));
    }),
    loadCloud: vi.fn(async (id) => structuredClone(remote.get(id) || { data: null, revision: 0 })),
    loadCloudRevision: vi.fn(async (id) => ({ revision: remote.get(id)?.revision ?? 0 })),
    saveCloud: vi.fn(async (snapshot, revision, id) => {
      const previous = remote.get(id)?.revision || 0;
      if (revision !== previous) throw new Error("409 conflict");
      remote.set(id, { data: structuredClone(snapshot), revision: revision + 1 });
      return { revision: revision + 1 };
    }),
    getBlob: vi.fn(async (key: string) => blobs.get(key)),
    putBlobIfAbsent: vi.fn(async (key: string, blob: Blob) => {
      if (blobs.has(key)) return false;
      blobs.set(key, blob);
      return true;
    }),
    deleteUnreferencedBlob: vi.fn(async (key: string) => {
      blobs.delete(key);
      return true;
    }),
    clearAccountLocalCache: vi.fn(async (id: string) => {
      for (const key of disk.keys()) {
        if (key === id || key.startsWith(`recovery:${id}:`)) disk.delete(key);
      }
      return { deletedBlobs: 0, retainedBlobs: 0 };
    }),
    uploadBlob: vi.fn(async () => "path"),
    downloadBlob: vi.fn(async () => undefined),
    previewSourcePurge: vi.fn(),
    requestSourcePurge: vi.fn(),
    previewSourceVersionPurge: vi.fn(),
    requestSourceVersionPurge: vi.fn(),
    askCloud: vi.fn(async () => ({
      content: "evidence",
      citations: [],
      mode: "extractive" as const,
    })),
    organizeCloud: vi.fn(),
    getModelStatus: vi.fn(async () => ({ mode: "extractive", message: "未配置模型" })),
    readLegacyMeta: vi.fn(() => null),
  };
  const coordinator = new WorkspaceCoordinator(io, imports);
  return { coordinator, io, disk, remote, blobs };
}

function attachLocalCommitEvents(io: WorkspaceIO) {
  const subscriptions = new Set<{
    accountId: string;
    listener: (event: LocalWorkspaceCommitEvent) => void;
  }>();
  const cleanups: ReturnType<typeof vi.fn>[] = [];
  io.subscribeLocalCommits = vi.fn((accountId, listener) => {
    const subscription = { accountId, listener };
    subscriptions.add(subscription);
    const cleanup = vi.fn(() => subscriptions.delete(subscription));
    cleanups.push(cleanup);
    return cleanup;
  });
  return {
    cleanups,
    activeCount: () => subscriptions.size,
    emit: (event: LocalWorkspaceCommitEvent) => {
      for (const subscription of subscriptions) subscription.listener(event);
    },
  };
}

function attachAtomicLocalImports(
  io: WorkspaceIO,
  disk: Map<string, Stored>,
  blobs: Map<string, Blob>,
  beforeMerge?: () => Promise<void>,
) {
  let tail = Promise.resolve();
  vi.mocked(io.saveLocal).mockImplementation(
    async (snapshot, accountId = "local", expectedLocalRevision) => {
      const currentRevision = disk.get(accountId)?._conuoLocalRevision ?? 0;
      if (expectedLocalRevision !== undefined && expectedLocalRevision !== currentRevision)
        throw new Error("另一个标签页已更新本机工作区，未覆盖较新的资料。请重新载入后继续。");
      const localRevision = currentRevision + 1;
      disk.set(accountId, {
        ...(structuredClone(snapshot) as Stored),
        _conuoLocalRevision: localRevision,
      });
      return localRevision;
    },
  );
  io.commitLocalImport = <TResult>(
    accountId: string,
    blobKey: string,
    blob: Blob,
    merge: LocalImportMerger<TResult>,
  ): Promise<LocalImportCommitResult<TResult>> => {
    const operation = tail.then(async () => {
      await beforeMerge?.();
      const latest = structuredClone(disk.get(accountId) ?? null);
      const localRevision = (latest?._conuoLocalRevision ?? 0) + 1;
      const plan = merge(latest);
      if (plan.storeBlob && blobs.has(blobKey))
        throw new Error("原文件标识已存在，已有原件和工作区均未修改。");
      const workspace = {
        ...structuredClone(plan.workspace),
        _conuoLocalRevision: localRevision,
      };
      if (plan.storeBlob) blobs.set(blobKey, blob);
      disk.set(accountId, workspace as Stored);
      return { workspace, localRevision, blobStored: plan.storeBlob, result: plan.result };
    });
    tail = operation.then(
      () => {},
      () => {},
    );
    return operation;
  };
}
const accountA = { id: "A", email: "a@example.com" };
const accountB = { id: "B", email: "b@example.com" };

describe("foreground cloud revision adoption", () => {
  async function ready(snapshot = data("initial")) {
    const fixture = setup();
    fixture.remote.set(accountA.id, { data: snapshot, revision: 1 });
    await fixture.coordinator.activate(accountA);
    await vi.waitFor(() => expect(fixture.coordinator.getSnapshot().status).toBe("cloud"));
    vi.mocked(fixture.io.loadCloud).mockClear();
    vi.mocked(fixture.io.saveCloud).mockClear();
    vi.mocked(fixture.io.saveLocal).mockClear();
    return fixture;
  }
  it("adopts a newer authoritative snapshot after local confirmation without uploading it", async () => {
    const { coordinator, io, remote, disk } = await ready(
      workspaceWithReadingSource({ readPage: 1 }),
    );
    const newer = {
      ...workspaceWithReadingSource({ readPage: 4 }),
      notes: [note("new note")],
      conversations: [],
    };
    remote.set(accountA.id, { data: newer, revision: 2 });
    await coordinator.checkCloudUpdates(coordinator.getSnapshot().token);
    expect(coordinator.getSnapshot()).toMatchObject({
      data: newer,
      status: "cloud",
      cloudUpdateRevision: null,
      cloudAdoptionSequence: 1,
      checkingCloudUpdate: false,
      loadingCloudUpdate: false,
    });
    expect(disk.get(accountA.id)).toMatchObject({
      sources: [{ readPage: 4 }],
      _conuoSync: { revision: 2, dirty: false },
    });
    expect(io.loadCloud).toHaveBeenCalledTimes(1);
    expect(io.saveCloud).not.toHaveBeenCalled();
    await coordinator.checkCloudUpdates(coordinator.getSnapshot().token);
    expect(io.loadCloud).toHaveBeenCalledTimes(1);
    expect(coordinator.getSnapshot().cloudAdoptionSequence).toBe(1);
  });
  it("keeps confirmed save status and contents when a probe fails", async () => {
    const { coordinator, io } = await ready();
    vi.mocked(io.loadCloudRevision!).mockRejectedValue(new Error("probe unavailable"));
    await coordinator.checkCloudUpdates(coordinator.getSnapshot().token);
    expect(coordinator.getSnapshot()).toMatchObject({
      data: data("initial"),
      status: "cloud",
      error: "",
      cloudUpdateError: "probe unavailable",
      cloudAdoptionSequence: 0,
    });
    expect(io.loadCloud).not.toHaveBeenCalled();
    expect(io.saveLocal).not.toHaveBeenCalled();
  });
  it("keeps dirty and in-flight edits intact while only announcing a new version", async () => {
    const { coordinator, io, remote } = await ready();
    const cloudSave = deferred<{ revision: number }>();
    vi.mocked(io.saveCloud).mockReturnValue(cloudSave.promise);
    rename(coordinator, "my edit");
    await vi.waitFor(() => expect(io.saveCloud).toHaveBeenCalled());
    remote.set(accountA.id, { data: data("other edit"), revision: 2 });
    await coordinator.checkCloudUpdates(coordinator.getSnapshot().token);
    expect(coordinator.getSnapshot()).toMatchObject({
      data: data("my edit"),
      cloudUpdateRevision: 2,
      cloudAdoptionSequence: 0,
    });
    expect(io.loadCloud).not.toHaveBeenCalled();
    cloudSave.reject(new Error("network unavailable"));
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("conflict"));
    await coordinator.loadCloudUpdate(coordinator.getSnapshot().token);
    expect(coordinator.getSnapshot()).toMatchObject({
      data: data("my edit"),
      status: "conflict",
      recovery: data("other edit"),
      recoveryRevision: 2,
      cloudAdoptionSequence: 0,
    });
  });
  it("ignores a late complete snapshot when an edit arrives during the read", async () => {
    const { coordinator, io, remote } = await ready();
    remote.set(accountA.id, { data: data("other edit"), revision: 2 });
    const full = deferred<{ data: WorkspaceData; revision: number }>();
    vi.mocked(io.loadCloud).mockReturnValue(full.promise);
    const check = coordinator.checkCloudUpdates(coordinator.getSnapshot().token);
    await vi.waitFor(() => expect(io.loadCloud).toHaveBeenCalled());
    rename(coordinator, "my edit");
    full.resolve({ data: data("other edit"), revision: 2 });
    await check;
    expect(coordinator.getSnapshot().data.spaces[0].name).toBe("my edit");
    expect(coordinator.getSnapshot().cloudAdoptionSequence).toBe(0);
  });
  it("deduplicates simultaneous probes and aborts old-account reads", async () => {
    const { coordinator, io, remote } = await ready();
    const probe = deferred<{ revision: number }>();
    vi.mocked(io.loadCloudRevision!).mockReturnValue(probe.promise);
    const controller = new AbortController();
    const one = coordinator.checkCloudUpdates(coordinator.getSnapshot().token, controller.signal);
    const two = coordinator.checkCloudUpdates(coordinator.getSnapshot().token);
    expect(two).toBe(one);
    await vi.waitFor(() => expect(io.loadCloudRevision).toHaveBeenCalledTimes(1));
    remote.set(accountB.id, { data: data("B"), revision: 1 });
    await coordinator.activate(accountB);
    await one;
    probe.resolve({ revision: 100 });
    expect(coordinator.getSnapshot()).toMatchObject({
      user: accountB,
      data: data("B"),
      cloudUpdateRevision: null,
      cloudAdoptionSequence: 0,
    });
    expect(vi.mocked(io.loadCloudRevision!).mock.calls[0][1]?.aborted).toBe(true);
  });
  it.each([1, 0])("never adopts a descending full snapshot at revision %i", async (revision) => {
    const { coordinator, io, remote } = await ready();
    remote.set(accountA.id, { data: data("new"), revision: 3 });
    vi.mocked(io.loadCloud).mockResolvedValue({ data: revision ? data("old") : null, revision });
    await coordinator.checkCloudUpdates(coordinator.getSnapshot().token);
    expect(coordinator.getSnapshot()).toMatchObject({
      data: data("initial"),
      status: "cloud",
      cloudUpdateRevision: 3,
      cloudAdoptionSequence: 0,
    });
    expect(io.saveLocal).not.toHaveBeenCalled();
  });
  it("preserves editor input during candidate CAS and further input during repair", async () => {
    const { coordinator, io, remote, disk } = await ready();
    remote.set(accountA.id, { data: data("cloud update"), revision: 2 });
    const candidate = deferred<void>();
    const repair = deferred<void>();
    const original = vi.mocked(io.saveLocal).getMockImplementation()!;
    vi.mocked(io.saveLocal)
      .mockImplementationOnce(async (...args) => {
        await candidate.promise;
        await original(...args);
        return 1;
      })
      .mockImplementationOnce(async (...args) => {
        await repair.promise;
        await original(...args);
        return 2;
      })
      .mockImplementation(async (...args) => {
        await original(...args);
        return 3;
      });
    const check = coordinator.checkCloudUpdates(coordinator.getSnapshot().token);
    await vi.waitFor(() => expect(coordinator.getSnapshot().loadingCloudUpdate).toBe(true));
    expect(rename(coordinator, "first input")).not.toBe(false);
    candidate.resolve();
    await vi.waitFor(() => expect(io.saveLocal).toHaveBeenCalledTimes(2));
    rename(coordinator, "second input");
    repair.resolve();
    await check;
    expect(coordinator.getSnapshot()).toMatchObject({
      data: data("second input"),
      cloudAdoptionSequence: 0,
      cloudUpdateRevision: 2,
    });
    expect(disk.get(accountA.id)).toMatchObject({
      spaces: [{ name: "second input" }],
      _conuoSync: { revision: 1, dirty: true, base: data("initial") },
    });
  });
  it("retains current input with an actionable local error if repair fails", async () => {
    const { coordinator, io, remote } = await ready();
    remote.set(accountA.id, { data: data("cloud update"), revision: 2 });
    const candidate = deferred<void>();
    vi.mocked(io.saveLocal)
      .mockImplementationOnce(async () => {
        await candidate.promise;
        return 1;
      })
      .mockRejectedValue(new Error("quota full"));
    const check = coordinator.checkCloudUpdates(coordinator.getSnapshot().token);
    await vi.waitFor(() => expect(coordinator.getSnapshot().loadingCloudUpdate).toBe(true));
    rename(coordinator, "retained input");
    candidate.resolve();
    await check;
    expect(coordinator.getSnapshot()).toMatchObject({
      data: data("retained input"),
      status: "error",
      cloudUpdateRevision: 2,
      cloudAdoptionSequence: 0,
    });
    expect(coordinator.getSnapshot().error).toContain("quota full");
    expect(coordinator.hasUnsavedLocalChanges()).toBe(true);
  });
  it("never publishes a failed local adoption as cloud or changes the business error", async () => {
    const { coordinator, io, remote } = await ready();
    remote.set(accountA.id, { data: data("cloud update"), revision: 2 });
    vi.mocked(io.saveLocal).mockRejectedValue(new Error("disk unavailable"));
    await coordinator.checkCloudUpdates(coordinator.getSnapshot().token);
    expect(coordinator.getSnapshot()).toMatchObject({
      data: data("initial"),
      status: "cloud",
      error: "",
      cloudUpdateRevision: 2,
      cloudUpdateError: "disk unavailable",
      cloudAdoptionSequence: 0,
    });
  });
  it("fences both automatic and explicit adoption for each reader's staged position", async () => {
    const { coordinator, io, remote } = await ready();
    const token = coordinator.getSnapshot().token;
    remote.set(accountA.id, { data: data("cloud update"), revision: 2 });
    coordinator.setPendingReadingPosition(token, "left", true);
    coordinator.setPendingReadingPosition(token, "right", true);
    await coordinator.checkCloudUpdates(token);
    coordinator.setPendingReadingPosition(token, "left", false);
    await coordinator.loadCloudUpdate(token);
    expect(coordinator.getSnapshot()).toMatchObject({
      data: data("initial"),
      cloudUpdateRevision: 2,
      cloudAdoptionSequence: 0,
    });
    expect(io.loadCloud).not.toHaveBeenCalled();
    coordinator.setPendingReadingPosition(token - 1, "right", false);
    await coordinator.checkCloudUpdates(token);
    expect(io.loadCloud).not.toHaveBeenCalled();
    coordinator.setPendingReadingPosition(token, "right", false);
    await coordinator.checkCloudUpdates(token);
    expect(coordinator.getSnapshot()).toMatchObject({
      data: data("cloud update"),
      cloudAdoptionSequence: 1,
    });
  });
  it("keeps a newer cross-tab disk record intact when local CAS fails", async () => {
    const { coordinator, io, remote, disk } = await ready();
    remote.set(accountA.id, { data: data("cloud update"), revision: 2 });
    disk.set(accountA.id, {
      ...data("other tab"),
      _conuoSync: { revision: 1, dirty: true },
      _conuoLocalRevision: 7,
    });
    vi.mocked(io.saveLocal).mockRejectedValue(
      Object.assign(new Error("local conflict"), { code: "LOCAL_WORKSPACE_CONFLICT" }),
    );
    await coordinator.checkCloudUpdates(coordinator.getSnapshot().token);
    expect(coordinator.getSnapshot()).toMatchObject({
      data: data("initial"),
      status: "cloud",
      localUpdateRevision: 7,
      cloudUpdateRevision: 2,
      cloudAdoptionSequence: 0,
    });
    expect(disk.get(accountA.id)?.spaces[0].name).toBe("other tab");
  });
  it("never applies a candidate completed after an account switch", async () => {
    const { coordinator, io, remote } = await ready();
    const candidate = deferred<void>();
    vi.mocked(io.saveLocal).mockImplementationOnce(async () => {
      await candidate.promise;
      return 1;
    });
    remote.set(accountA.id, { data: data("cloud update"), revision: 2 });
    remote.set(accountB.id, { data: data("B"), revision: 1 });
    const check = coordinator.checkCloudUpdates(coordinator.getSnapshot().token);
    await vi.waitFor(() => expect(coordinator.getSnapshot().loadingCloudUpdate).toBe(true));
    await coordinator.activate(accountB);
    candidate.resolve();
    await check;
    expect(coordinator.getSnapshot()).toMatchObject({
      user: accountB,
      data: data("B"),
      cloudAdoptionSequence: 0,
      cloudUpdateRevision: null,
    });
  });
  it("drains an already-started candidate before deleting the account cache without repair resurrection", async () => {
    const { coordinator, io, remote, disk } = await ready();
    const candidate = deferred<void>();
    const original = vi.mocked(io.saveLocal).getMockImplementation()!;
    vi.mocked(io.saveLocal).mockImplementationOnce(async (...args) => {
      await candidate.promise;
      await original(...args);
      return 1;
    });
    remote.set(accountA.id, { data: data("cloud update"), revision: 2 });
    const check = coordinator.checkCloudUpdates(coordinator.getSnapshot().token);
    await vi.waitFor(() => expect(coordinator.getSnapshot().loadingCloudUpdate).toBe(true));
    const discarded = coordinator.discardAccount(accountA.id);
    candidate.resolve();
    await Promise.all([check, discarded]);
    expect(disk.has(accountA.id)).toBe(false);
    expect(io.saveLocal).toHaveBeenCalledTimes(1);
    expect(coordinator.getSnapshot()).toMatchObject({ user: null, cloudAdoptionSequence: 0 });
  });
  it("does not apply a malformed or foreign-owner complete snapshot", async () => {
    const { coordinator, io, remote } = await ready();
    remote.set(accountA.id, { data: data("cloud update"), revision: 2 });
    vi.mocked(io.loadCloud).mockResolvedValue({
      data: workspaceWithReadingSource({ storagePath: "other-user/file.txt" }),
      revision: 2,
    });
    await coordinator.checkCloudUpdates(coordinator.getSnapshot().token);
    expect(coordinator.getSnapshot()).toMatchObject({
      data: data("initial"),
      cloudUpdateRevision: 2,
      cloudAdoptionSequence: 0,
    });
    expect(io.saveLocal).not.toHaveBeenCalled();
  });
  it("uses existing independent-object rebase on explicit load while preserving local changes", async () => {
    const initial = {
      ...data("initial"),
      notes: [note("old note"), note("second note", { id: "note-b" })],
    };
    const { coordinator, io, remote, disk } = await ready(initial);
    vi.mocked(io.saveCloud).mockRejectedValue(new Error("offline"));
    coordinator.update(
      (current) => ({
        ...current,
        notes: current.notes.map((item) =>
          item.id === "note-a" ? { ...item, content: "my note", contentRevision: 1 } : item,
        ),
      }),
      coordinator.getSnapshot().token,
    );
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("error"));
    remote.set(accountA.id, {
      data: {
        ...initial,
        notes: [
          initial.notes[0],
          { ...initial.notes[1], content: "remote second note", contentRevision: 1 },
        ],
      },
      revision: 2,
    });
    const upload = deferred<{ revision: number }>();
    vi.mocked(io.saveCloud).mockReturnValue(upload.promise);
    await coordinator.loadCloudUpdate(coordinator.getSnapshot().token);
    expect(coordinator.getSnapshot()).toMatchObject({
      data: { notes: [{ content: "my note" }, { content: "remote second note" }] },
      cloudAdoptionSequence: 1,
    });
    expect(disk.get(accountA.id)?.notes[0].content).toBe("my note");
    expect(disk.get(accountA.id)?._conuoSync).toMatchObject({
      revision: 2,
      dirty: true,
      base: { notes: [{ content: "old note" }, { content: "remote second note" }] },
    });
    upload.reject(new Error("offline"));
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).not.toBe("saving"));
  });
  it("does not race a durable organization request that has not yet reached its local projection", async () => {
    const request = {
      requestId: "job-a",
      kind: "source" as const,
      trigger: "manual" as const,
      spaceId: "base",
      sourceIds: ["source-a"],
      sourceVersions: [{ sourceId: "source-a", versionId: "source-a-version" }],
    };
    const job: OrganizationJob = {
      id: request.requestId,
      durable: true,
      request,
      status: "queued",
      createdAt: "2026-09-14T08:00:00.000Z",
      updatedAt: "2026-09-14T08:00:00.000Z",
    };
    const initial = { ...workspaceWithReadingSource(), organizationJobs: [job] };
    const { coordinator, io, remote } = await ready(initial);
    const rpc =
      deferred<Awaited<ReturnType<NonNullable<WorkspaceIO["reconcileOrganizationJobs"]>>>>();
    io.reconcileOrganizationJobs = vi.fn(() => rpc.promise);
    const token = coordinator.getSnapshot().token;
    const checkingJob = coordinator.checkOrganization(job.id, token);
    remote.set(accountA.id, { data: { ...initial, notes: [note("cloud note")] }, revision: 2 });
    await coordinator.checkCloudUpdates(token);
    await coordinator.loadCloudUpdate(token);
    expect(io.loadCloud).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot()).toMatchObject({
      data: initial,
      cloudUpdateRevision: 2,
      cloudAdoptionSequence: 0,
    });
    rpc.resolve({ revision: 2, jobs: [] });
    await checkingJob;
    expect(coordinator.getSnapshot().data.notes[0].content).toBe("cloud note");
  });
  it("keeps durable editor saves ordered behind the candidate barrier", async () => {
    const { coordinator, io, remote, disk } = await ready();
    remote.set(accountA.id, { data: data("cloud update"), revision: 2 });
    const candidate = deferred<void>();
    const original = vi.mocked(io.saveLocal).getMockImplementation()!;
    vi.mocked(io.saveLocal).mockImplementationOnce(async (...args) => {
      await candidate.promise;
      await original(...args);
      return 1;
    });
    const check = coordinator.checkCloudUpdates(coordinator.getSnapshot().token);
    await vi.waitFor(() => expect(coordinator.getSnapshot().loadingCloudUpdate).toBe(true));
    const editorSave = coordinator.updateDurably(
      (current) => ({
        ...current,
        spaces: current.spaces.map((space) => ({ ...space, name: "durable input" })),
      }),
      coordinator.getSnapshot().token,
    );
    rename(coordinator, "latest input");
    candidate.resolve();
    await Promise.all([check, editorSave]);
    expect(coordinator.getSnapshot()).toMatchObject({
      data: data("latest input"),
      cloudAdoptionSequence: 0,
    });
    expect(disk.get(accountA.id)?.spaces[0].name).toBe("latest input");
  });
  it.each(["read", "commit"])(
    "cancels adoption when a reader stages a position during %s",
    async (phase) => {
      const { coordinator, io, remote } = await ready();
      remote.set(accountA.id, { data: data("cloud update"), revision: 2 });
      const hold = deferred<void>();
      if (phase === "read")
        vi.mocked(io.loadCloud).mockImplementationOnce(async () => {
          await hold.promise;
          return { data: data("cloud update"), revision: 2 };
        });
      else {
        const original = vi.mocked(io.saveLocal).getMockImplementation()!;
        vi.mocked(io.saveLocal).mockImplementationOnce(async (...args) => {
          await hold.promise;
          await original(...args);
          return 1;
        });
      }
      const token = coordinator.getSnapshot().token;
      const check = coordinator.checkCloudUpdates(token);
      await vi.waitFor(() =>
        expect(
          phase === "read"
            ? vi.mocked(io.loadCloud).mock.calls.length > 0
            : coordinator.getSnapshot().loadingCloudUpdate,
        ).toBe(true),
      );
      coordinator.setPendingReadingPosition(token, "reader", true);
      hold.resolve();
      await check;
      expect(coordinator.getSnapshot()).toMatchObject({
        data: data("initial"),
        cloudAdoptionSequence: 0,
        cloudUpdateRevision: 2,
      });
      coordinator.setPendingReadingPosition(token, "reader", false);
    },
  );
});
function rename(
  coordinator: WorkspaceCoordinator,
  name: string,
  token = coordinator.getSnapshot().token,
) {
  coordinator.update(
    (current) => ({
      ...current,
      spaces: current.spaces.map((space, index) => (index ? space : { ...space, name })),
    }),
    token,
  );
}
async function status(coordinator: WorkspaceCoordinator, expected: string) {
  await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe(expected));
}
function parsedImport(source: Source, text = "资料已经可以检索。 "): Source {
  const body = text.trim();
  return {
    ...source,
    status: "ready",
    text: body,
    chunks: [
      {
        id: `${source.id}-chunk`,
        sourceId: source.id,
        versionId: source.versionId,
        text: body,
        section: "正文",
        order: 0,
      },
    ],
    error: undefined,
    updatedAt: "2026-09-13T12:00:00.000Z",
  };
}
function importPipeline(parse: ImportPipeline["parse"]): ImportPipeline {
  return { prepare: prepareImportFile, parse };
}

function attachImportLeases(
  io: WorkspaceIO,
  remote: Map<string, { data: WorkspaceData | null; revision: number }>,
) {
  const leases = new Map<string, { token: string; until: string }>();
  let sequence = 0;
  const key = (ownerId: string, sourceId: string, versionId: string) =>
    JSON.stringify([ownerId, sourceId, versionId]);
  const conflict = () => Object.assign(new Error("409 conflict"), { status: 409 });
  const nextToken = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  io.claimImportParse = vi.fn(async (sourceId: string, versionId: string, ownerId: string) => {
    const workspace = remote.get(ownerId);
    const source = workspace?.data?.sources.find(
      (item) => item.id === sourceId && item.versionId === versionId && !item.deletedAt,
    );
    const job = workspace?.data?.importJobs?.find(
      (item) =>
        item.sourceId === sourceId &&
        item.versionId === versionId &&
        item.originalSaved &&
        item.stage === "parsing" &&
        (item.status === "queued" || item.status === "running"),
    );
    if (!source || !job || (source.status !== "saved" && source.status !== "parsing"))
      throw conflict();
    const identity = key(ownerId, sourceId, versionId);
    const held = leases.get(identity);
    if (held) return { status: "held" as const, leaseUntil: held.until };
    const claimed = {
      token: nextToken(),
      until: new Date(Date.now() + 120_000).toISOString(),
    };
    leases.set(identity, claimed);
    return { status: "claimed" as const, leaseToken: claimed.token, leaseUntil: claimed.until };
  });
  io.heartbeatImportParse = vi.fn(
    async (sourceId: string, versionId: string, token: string, ownerId: string) => {
      const held = leases.get(key(ownerId, sourceId, versionId));
      if (!held || held.token !== token) throw conflict();
      held.until = new Date(Date.now() + 120_000).toISOString();
      return { status: "claimed" as const, leaseUntil: held.until };
    },
  );
  io.releaseImportParse = vi.fn(
    async (sourceId: string, versionId: string, token: string, ownerId: string) => {
      const identity = key(ownerId, sourceId, versionId);
      const held = leases.get(identity);
      if (held && held.token !== token) throw conflict();
      leases.delete(identity);
    },
  );
  io.finishImportParse = vi.fn(
    async (
      next: WorkspaceData,
      expectedRevision: number,
      sourceId: string,
      versionId: string,
      token: string,
      ownerId: string,
    ) => {
      const identity = key(ownerId, sourceId, versionId);
      const held = leases.get(identity);
      const current = remote.get(ownerId) || { data: null, revision: 0 };
      if (!held || held.token !== token || current.revision !== expectedRevision) throw conflict();
      remote.set(ownerId, { data: structuredClone(next), revision: expectedRevision + 1 });
      leases.delete(identity);
      return { revision: expectedRevision + 1 };
    },
  );
  io.cancelImportParse = vi.fn(
    async (
      next: WorkspaceData,
      expectedRevision: number,
      sourceId: string,
      versionId: string,
      ownerId: string,
    ) => {
      const current = remote.get(ownerId) || { data: null, revision: 0 };
      const source = current.data?.sources.find(
        (item) => item.id === sourceId && item.versionId === versionId && !item.deletedAt,
      );
      const job = current.data?.importJobs?.find(
        (item) =>
          item.sourceId === sourceId &&
          item.versionId === versionId &&
          item.originalSaved &&
          item.stage === "parsing" &&
          (item.status === "queued" || item.status === "running"),
      );
      if (!source || !job || current.revision !== expectedRevision) throw conflict();
      remote.set(ownerId, { data: structuredClone(next), revision: expectedRevision + 1 });
      leases.delete(key(ownerId, sourceId, versionId));
      return { revision: expectedRevision + 1 };
    },
  );
  io.retryImportParse = vi.fn(
    async (
      next: WorkspaceData,
      expectedRevision: number,
      sourceId: string,
      versionId: string,
      ownerId: string,
    ) => {
      const current = remote.get(ownerId) || { data: null, revision: 0 };
      const source = current.data?.sources.find(
        (item) => item.id === sourceId && item.versionId === versionId && !item.deletedAt,
      );
      const job = current.data?.importJobs?.find(
        (item) => item.sourceId === sourceId && item.versionId === versionId,
      );
      if (
        !source ||
        !job ||
        current.revision !== expectedRevision ||
        !(
          (source.status === "failed" && job.status === "failed") ||
          (source.status === "saved" && job.status === "cancelled")
        )
      )
        throw conflict();
      remote.set(ownerId, { data: structuredClone(next), revision: expectedRevision + 1 });
      leases.delete(key(ownerId, sourceId, versionId));
      return { revision: expectedRevision + 1 };
    },
  );
  return { leases, key };
}

async function retainedSourceAtSize(size: number): Promise<Source> {
  const source = await prepareImportFile(new File(["已保留的原件。"], "retained.txt"), "");
  return { ...source, size };
}

describe("workspace persistence and account boundaries", () => {
  it("shows only a higher revision for the active account and cleans subscriptions", async () => {
    const { coordinator, io, disk, remote } = setup();
    const initialA = data("account A");
    const initialB = data("account B");
    disk.set("A", {
      ...structuredClone(initialA),
      _conuoSync: { revision: 3, dirty: false },
      _conuoLocalRevision: 3,
    });
    disk.set("B", {
      ...structuredClone(initialB),
      _conuoSync: { revision: 7, dirty: false },
      _conuoLocalRevision: 7,
    });
    remote.set("A", { data: structuredClone(initialA), revision: 3 });
    remote.set("B", { data: structuredClone(initialB), revision: 7 });
    const events = attachLocalCommitEvents(io);

    await coordinator.activate(accountA);
    events.emit({ accountId: "B", localRevision: 9, writerId: "other-tab" });
    events.emit({ accountId: "A", localRevision: 2, writerId: "other-tab" });
    events.emit({ accountId: "A", localRevision: 3, writerId: "other-tab" });
    expect(coordinator.getSnapshot().localUpdateRevision).toBeNull();

    events.emit({ accountId: "A", localRevision: 4, writerId: "other-tab" });
    events.emit({ accountId: "A", localRevision: 6, writerId: "other-tab" });
    expect(coordinator.getSnapshot().localUpdateRevision).toBe(6);

    await coordinator.activate(accountB);
    expect(events.cleanups[0]).toHaveBeenCalledOnce();
    expect(events.activeCount()).toBe(1);
    expect(coordinator.getSnapshot().localUpdateRevision).toBeNull();
    coordinator.dispose();
    expect(events.cleanups[1]).toHaveBeenCalledOnce();
    expect(events.activeCount()).toBe(0);
  });

  it("waits for a pending stale save, exports its memory snapshot, then reloads IndexedDB", async () => {
    const { coordinator, io, disk, blobs } = setup();
    disk.set("local", { ...data("before"), _conuoLocalRevision: 1 });
    attachAtomicLocalImports(io, disk, blobs);
    const events = attachLocalCommitEvents(io);
    await coordinator.activate(null);

    const casSave = vi.mocked(io.saveLocal).getMockImplementation();
    if (!casSave) throw new Error("expected CAS save implementation");
    const pendingSave = deferred<void>();
    let delayCurrentAccount = true;
    vi.mocked(io.saveLocal).mockImplementation(
      async (snapshot, accountId = "local", expectedLocalRevision) => {
        if (accountId === "local" && delayCurrentAccount) {
          delayCurrentAccount = false;
          await pendingSave.promise;
        }
        return casSave(snapshot, accountId, expectedLocalRevision);
      },
    );
    vi.mocked(io.saveLocal).mockClear();

    rename(coordinator, "本页尚未保存");
    await vi.waitFor(() => expect(io.saveLocal).toHaveBeenCalledOnce());
    disk.set("local", { ...data("其他标签页最新数据"), _conuoLocalRevision: 2 });
    events.emit({ accountId: "local", localRevision: 2, writerId: "other-tab" });
    expect(coordinator.getSnapshot().localUpdateRevision).toBe(2);
    rename(coordinator, "通知后继续输入");
    expect(coordinator.getSnapshot().data.spaces[0]?.name).toBe("通知后继续输入");
    await Promise.resolve();
    expect(io.saveLocal).toHaveBeenCalledOnce();

    const preserve = vi.fn(async (snapshot: WorkspaceData) => {
      expect(snapshot.spaces[0]?.name).toBe("通知后继续输入");
      return true;
    });
    const reload = coordinator.loadLatestLocal(coordinator.getSnapshot().token, preserve);
    await Promise.resolve();
    expect(preserve).not.toHaveBeenCalled();

    pendingSave.resolve();
    await expect(reload).resolves.toBe(true);
    expect(preserve).toHaveBeenCalledOnce();
    expect(io.saveLocal).toHaveBeenCalledOnce();
    expect(disk.get("local")?.spaces[0]?.name).toBe("其他标签页最新数据");
    expect(coordinator.getSnapshot()).toMatchObject({
      data: { spaces: [{ name: "其他标签页最新数据" }] },
      localUpdateRevision: null,
      loadingLocalUpdate: false,
      status: "local",
    });
    expect(coordinator.hasUnsavedLocalChanges()).toBe(false);
  });

  it("keeps edits made during backup export and refuses to replace them", async () => {
    const { coordinator, io, disk, blobs } = setup();
    disk.set("local", { ...data("before"), _conuoLocalRevision: 1 });
    attachAtomicLocalImports(io, disk, blobs);
    const events = attachLocalCommitEvents(io);
    await coordinator.activate(null);

    disk.set("local", { ...data("other tab"), _conuoLocalRevision: 2 });
    events.emit({ accountId: "local", localRevision: 2, writerId: "other-tab" });
    rename(coordinator, "edit to export");
    const exportResult = deferred<boolean>();
    const preserve = vi.fn(async () => exportResult.promise);
    const reload = coordinator.loadLatestLocal(coordinator.getSnapshot().token, preserve);
    await vi.waitFor(() => expect(preserve).toHaveBeenCalledOnce());

    rename(coordinator, "typed during export");
    exportResult.resolve(true);
    await expect(reload).rejects.toThrow("导出期间当前页面再次变化");
    expect(coordinator.getSnapshot()).toMatchObject({
      data: { spaces: [{ name: "typed during export" }] },
      localUpdateRevision: 2,
      loadingLocalUpdate: false,
      status: "error",
    });
    expect(disk.get("local")?.spaces[0]?.name).toBe("other tab");
  });

  it("keeps edits made while IndexedDB is being read and refuses to replace them", async () => {
    const { coordinator, io, disk, blobs } = setup();
    disk.set("local", { ...data("before"), _conuoLocalRevision: 1 });
    attachAtomicLocalImports(io, disk, blobs);
    const events = attachLocalCommitEvents(io);
    await coordinator.activate(null);

    const latest = { ...data("other tab"), _conuoLocalRevision: 2 };
    disk.set("local", latest);
    events.emit({ accountId: "local", localRevision: 2, writerId: "other-tab" });
    const read = deferred<Stored | null>();
    vi.mocked(io.loadLocal).mockReturnValueOnce(read.promise);
    const reload = coordinator.loadLatestLocal(coordinator.getSnapshot().token);
    await vi.waitFor(() => expect(io.loadLocal).toHaveBeenCalledTimes(2));

    rename(coordinator, "typed during read");
    read.resolve(structuredClone(latest));
    await expect(reload).rejects.toThrow("读取期间当前页面再次变化");
    expect(coordinator.getSnapshot()).toMatchObject({
      data: { spaces: [{ name: "typed during read" }] },
      localUpdateRevision: 2,
      loadingLocalUpdate: false,
      status: "error",
    });
  });

  it("retains a higher disk revision prompt when dirty memory wins reactivation", async () => {
    const { coordinator, io, disk, remote, blobs } = setup();
    const base = data("base");
    disk.set("A", {
      ...structuredClone(base),
      _conuoSync: { revision: 3, dirty: false },
      _conuoLocalRevision: 3,
    });
    remote.set("A", { data: structuredClone(base), revision: 3 });
    attachAtomicLocalImports(io, disk, blobs);
    await coordinator.activate(accountA);
    const retainedLocalRevision = disk.get("A")?._conuoLocalRevision ?? 0;

    vi.mocked(io.saveLocal).mockRejectedValueOnce(new Error("temporary local failure"));
    rename(coordinator, "dirty memory");
    await status(coordinator, "error");
    disk.set("A", {
      ...data("newer disk"),
      _conuoSync: { revision: 3, dirty: true, base: structuredClone(base), baseRevision: 3 },
      _conuoLocalRevision: retainedLocalRevision + 1,
    });

    await coordinator.activate(accountA);
    expect(coordinator.getSnapshot()).toMatchObject({
      data: { spaces: [{ name: "dirty memory" }] },
      localUpdateRevision: retainedLocalRevision + 1,
    });
  });

  it("offers the same reload recovery after a local CAS conflict when events are unavailable", async () => {
    const { coordinator, io, disk, blobs } = setup();
    disk.set("local", { ...data("before"), _conuoLocalRevision: 1 });
    attachAtomicLocalImports(io, disk, blobs);
    await coordinator.activate(null);

    disk.set("local", { ...data("newest on disk"), _conuoLocalRevision: 2 });
    rename(coordinator, "stale in memory");
    await status(coordinator, "error");
    expect(coordinator.getSnapshot()).toMatchObject({
      localUpdateRevision: 2,
      data: { spaces: [{ name: "stale in memory" }] },
    });

    const preserve = vi.fn(async () => true);
    await expect(
      coordinator.loadLatestLocal(coordinator.getSnapshot().token, preserve),
    ).resolves.toBe(true);
    expect(preserve).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot()).toMatchObject({
      localUpdateRevision: null,
      data: { spaces: [{ name: "newest on disk" }] },
      status: "local",
    });
  });

  it("rechecks the external-update fence after an atomic import waits on the account queue", async () => {
    const parse = deferred<Source>();
    const { coordinator, io, disk, blobs } = setup(importPipeline(async () => parse.promise));
    disk.set("local", { ...data("before"), _conuoLocalRevision: 1 });
    attachAtomicLocalImports(io, disk, blobs);
    const originalCommit = io.commitLocalImport!;
    const commit = vi.fn();
    io.commitLocalImport = <TResult>(
      accountId: string,
      blobKey: string,
      blob: Blob,
      merge: LocalImportMerger<TResult>,
    ) => {
      commit();
      return originalCommit(accountId, blobKey, blob, merge);
    };
    const events = attachLocalCommitEvents(io);
    await coordinator.activate(null);

    const heldQueue = deferred<void>();
    const internals = coordinator as unknown as { queues: Map<string, Promise<void>> };
    internals.queues.set("local", heldQueue.promise);
    const importing = coordinator.importFile(
      new File(["queued import"], "queued.txt"),
      "",
      coordinator.getSnapshot().token,
    );
    await vi.waitFor(() => expect(internals.queues.get("local")).not.toBe(heldQueue.promise));

    const announcedRevision = (disk.get("local")?._conuoLocalRevision ?? 0) + 1;
    events.emit({
      accountId: "local",
      localRevision: announcedRevision,
      writerId: "other-tab",
    });
    heldQueue.resolve();

    await expect(importing).rejects.toThrow("请先载入最新数据");
    expect(commit).not.toHaveBeenCalled();
    parse.resolve(readingSource());
  });

  it("clears an announced revision when an in-flight atomic import commits beyond it", async () => {
    const parse = deferred<Source>();
    const mergeStarted = deferred<void>();
    const continueMerge = deferred<void>();
    const { coordinator, io, disk, blobs } = setup(importPipeline(async () => parse.promise));
    disk.set("local", { ...data("before"), _conuoLocalRevision: 1 });
    attachAtomicLocalImports(io, disk, blobs, async () => {
      mergeStarted.resolve();
      await continueMerge.promise;
    });
    const events = attachLocalCommitEvents(io);
    await coordinator.activate(null);

    const importing = coordinator.importFile(
      new File(["atomic import"], "atomic.txt"),
      "",
      coordinator.getSnapshot().token,
    );
    await mergeStarted.promise;
    const externalRevision = (disk.get("local")?._conuoLocalRevision ?? 0) + 1;
    disk.set("local", { ...data("other tab"), _conuoLocalRevision: externalRevision });
    events.emit({
      accountId: "local",
      localRevision: externalRevision,
      writerId: "other-tab",
    });
    expect(coordinator.getSnapshot().localUpdateRevision).toBe(externalRevision);

    continueMerge.resolve();
    const result = await importing;
    expect(result.kind).toBe("queued");
    expect(coordinator.getSnapshot()).toMatchObject({
      data: { spaces: [{ name: "other tab" }] },
      localUpdateRevision: null,
    });
    expect(disk.get("local")?._conuoLocalRevision).toBe(externalRevision + 1);
    if (result.kind === "queued") {
      const source = coordinator
        .getSnapshot()
        .data.sources.find((item) => item.id === result.job.sourceId);
      if (source) parse.resolve(parsedImport(source));
    }
  });

  it("resolves a durable update only after its exact snapshot reaches local storage", async () => {
    const { coordinator, io, disk } = setup();
    disk.set("local", data("before"));
    await coordinator.activate(null);
    const saved = deferred<void>();
    vi.mocked(io.saveLocal).mockImplementationOnce(async (snapshot, id = "local") => {
      await saved.promise;
      disk.set(id, structuredClone(snapshot));
    });
    let settled = false;
    const pending = coordinator
      .updateDurably(
        (current) => ({
          ...current,
          spaces: current.spaces.map((space, index) =>
            index ? space : { ...space, name: "durable edit" },
          ),
        }),
        coordinator.getSnapshot().token,
      )
      .then((result) => {
        settled = true;
        return result;
      });

    expect(coordinator.getSnapshot().data.spaces[0].name).toBe("durable edit");
    expect(coordinator.getSnapshot().status).toBe("saving");
    await vi.waitFor(() => expect(io.saveLocal).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(disk.get("local")?.spaces[0].name).toBe("before");

    saved.resolve();
    await expect(pending).resolves.toBe(true);
    expect(disk.get("local")?.spaces[0].name).toBe("durable edit");
    await status(coordinator, "local");
  });

  it("keeps a failed durable update dirty and reports the local durability failure", async () => {
    const { coordinator, io, disk } = setup();
    disk.set("local", data("before"));
    await coordinator.activate(null);
    vi.mocked(io.saveLocal).mockRejectedValueOnce(new Error("IndexedDB quota reached"));

    await expect(
      coordinator.updateDurably(
        (current) => ({
          ...current,
          spaces: current.spaces.map((space, index) =>
            index ? space : { ...space, name: "still in memory" },
          ),
        }),
        coordinator.getSnapshot().token,
      ),
    ).rejects.toThrow("操作结果尚未保存到此浏览器：IndexedDB quota reached");

    expect(io.saveLocal).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot()).toMatchObject({
      status: "error",
      data: { spaces: [{ name: "still in memory" }] },
    });
    expect(coordinator.hasUnsavedLocalChanges()).toBe(true);
    expect(disk.get("local")?.spaces[0].name).toBe("before");

    await coordinator.retry(coordinator.getSnapshot().token);
    expect(disk.get("local")?.spaces[0].name).toBe("still in memory");
    expect(coordinator.hasUnsavedLocalChanges()).toBe(false);
  });

  it("serializes concurrent durable snapshots without an extra pump write", async () => {
    const { coordinator, io, disk } = setup();
    disk.set("local", data("before"));
    await coordinator.activate(null);
    const firstSave = deferred<void>();
    const secondSave = deferred<void>();
    vi.mocked(io.saveLocal)
      .mockImplementationOnce(async (snapshot, id = "local") => {
        await firstSave.promise;
        disk.set(id, structuredClone(snapshot));
      })
      .mockImplementationOnce(async (snapshot, id = "local") => {
        await secondSave.promise;
        disk.set(id, structuredClone(snapshot));
      });
    const setName = (name: string) => (current: WorkspaceData) => ({
      ...current,
      spaces: current.spaces.map((space, index) => (index ? space : { ...space, name })),
    });
    const token = coordinator.getSnapshot().token;
    const first = coordinator.updateDurably(setName("first"), token);
    const second = coordinator.updateDurably(setName("second"), token);

    await vi.waitFor(() => expect(io.saveLocal).toHaveBeenCalledOnce());
    firstSave.resolve();
    await expect(first).resolves.toBe(true);
    await vi.waitFor(() => expect(io.saveLocal).toHaveBeenCalledTimes(2));
    expect(coordinator.getSnapshot().data.spaces[0].name).toBe("second");

    secondSave.resolve();
    await expect(second).resolves.toBe(true);
    await status(coordinator, "local");
    expect(io.saveLocal).toHaveBeenCalledTimes(2);
    expect(disk.get("local")?.spaces[0].name).toBe("second");
  });

  it("does not report a stale durable action as successful after the account changes", async () => {
    const { coordinator, io, disk } = setup();
    disk.set("local", data("anonymous before"));
    await coordinator.activate(null);
    const saved = deferred<void>();
    vi.mocked(io.saveLocal).mockImplementationOnce(async (snapshot, id = "local") => {
      await saved.promise;
      disk.set(id, structuredClone(snapshot));
    });
    const pending = coordinator.updateDurably(
      (current) => ({
        ...current,
        spaces: current.spaces.map((space, index) =>
          index ? space : { ...space, name: "old-session action" },
        ),
      }),
      coordinator.getSnapshot().token,
    );
    await vi.waitFor(() => expect(io.saveLocal).toHaveBeenCalledOnce());

    await coordinator.activate(accountB);
    expect(coordinator.getSnapshot().user?.id).toBe("B");
    saved.resolve();

    await expect(pending).rejects.toThrow("当前账号已改变");
    expect(disk.get("local")?.spaces[0].name).toBe("old-session action");
    expect(coordinator.getSnapshot().data.spaces[0].name).not.toBe("old-session action");
    expect(disk.get("B")?.spaces[0].name).not.toBe("old-session action");
  });

  it("does not wait for cloud confirmation after the durable local snapshot succeeds", async () => {
    const { coordinator, io, disk, remote } = setup();
    const base = data("cloud base");
    disk.set("A", { ...structuredClone(base), _conuoSync: { revision: 4, dirty: false } });
    remote.set("A", { data: structuredClone(base), revision: 4 });
    await coordinator.activate(accountA);
    vi.mocked(io.saveLocal).mockClear();
    vi.mocked(io.saveCloud).mockClear();
    const cloudSave = deferred<{ revision: number }>();
    vi.mocked(io.saveCloud).mockReturnValueOnce(cloudSave.promise);

    await expect(
      coordinator.updateDurably(
        (current) => ({
          ...current,
          spaces: current.spaces.map((space, index) =>
            index ? space : { ...space, name: "locally confirmed" },
          ),
        }),
        coordinator.getSnapshot().token,
      ),
    ).resolves.toBe(true);

    expect(io.saveLocal).toHaveBeenCalledOnce();
    expect(io.saveCloud).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot().status).toBe("saving");
    cloudSave.resolve({ revision: 5 });
    await status(coordinator, "cloud");
  });

  it("does not call an absent cloud snapshot synced until its first PUT is acknowledged", async () => {
    const { coordinator, io, disk } = setup();
    const save = deferred<{ revision: number }>();
    vi.mocked(io.saveCloud).mockReturnValueOnce(save.promise);
    const opening = coordinator.activate(accountA);
    await vi.waitFor(() => expect(io.saveCloud).toHaveBeenCalledOnce());
    expect(coordinator.getSnapshot().status).toBe("saving");
    expect(disk.get("A")?._conuoSync).toEqual({ revision: 0, dirty: true });
    save.resolve({ revision: 1 });
    await opening;
    expect(coordinator.getSnapshot().status).toBe("cloud");
    expect(disk.get("A")?._conuoSync).toEqual({ revision: 1, dirty: false });
    expect(coordinator.getSnapshot().data).not.toHaveProperty("_conuoSync");
    expect(vi.mocked(io.saveCloud).mock.calls[0][0]).not.toHaveProperty("_conuoSync");
  });

  it("flushes the latest outgoing edit to its own account while a previous write is slow", async () => {
    const { coordinator, io, disk } = setup();
    disk.set("local", data("local"));
    await coordinator.activate(null);
    const oldToken = coordinator.getSnapshot().token;
    const firstWrite = deferred<void>();
    vi.mocked(io.saveLocal).mockImplementationOnce(async (snapshot, id = "local") => {
      await firstWrite.promise;
      disk.set(id, structuredClone(snapshot));
    });
    rename(coordinator, "first edit");
    await vi.waitFor(() => expect(io.saveLocal).toHaveBeenCalledOnce());
    rename(coordinator, "latest local edit");
    const switching = coordinator.activate(accountB);
    await vi.waitFor(() => expect(coordinator.getSnapshot().user?.id).toBe("B"));
    firstWrite.resolve();
    await switching;
    await vi.waitFor(() => expect(disk.get("local")?.spaces[0].name).toBe("latest local edit"));
    rename(coordinator, "stale import callback", oldToken);
    expect(coordinator.getSnapshot().data.spaces[0].name).not.toBe("stale import callback");
    expect(disk.get("B")?.spaces[0].name).not.toBe("latest local edit");
    expect(
      vi
        .mocked(io.saveCloud)
        .mock.calls.every(
          (call) => call[2] === "B" && call[0].spaces[0].name !== "latest local edit",
        ),
    ).toBe(true);
  });

  it("ignores old cloud acknowledgements after switching and retains unsent edits for the old account", async () => {
    const { coordinator, io, disk, remote } = setup();
    remote.set("A", { data: data("A cloud"), revision: 3 });
    remote.set("B", { data: data("B cloud"), revision: 7 });
    await coordinator.activate(accountA);
    const oldSave = deferred<{ revision: number }>();
    vi.mocked(io.saveCloud).mockReturnValueOnce(oldSave.promise);
    rename(coordinator, "A first edit");
    await vi.waitFor(() => expect(io.saveCloud).toHaveBeenCalledOnce());
    rename(coordinator, "A latest edit");
    await coordinator.activate(accountB);
    oldSave.resolve({ revision: 4 });
    await vi.waitFor(() => expect(disk.get("A")?.spaces[0].name).toBe("A latest edit"));
    expect(coordinator.getSnapshot().data.spaces[0].name).toBe("B cloud");
    expect(disk.get("A")?.spaces[0].name).not.toBe("B cloud");
    expect(disk.get("B")?._conuoSync?.revision).toBe(7);
    expect(disk.get("A")?._conuoSync).toMatchObject({
      revision: 3,
      dirty: true,
      baseRevision: 3,
      base: { spaces: [{ name: "A cloud" }] },
    });
  });

  it("keeps failed local edits dirty, protects navigation and retries the latest snapshot", async () => {
    const { coordinator, io, disk } = setup();
    disk.set("local", data("before"));
    await coordinator.activate(null);
    vi.mocked(io.saveLocal).mockRejectedValueOnce(new Error("QuotaExceededError"));
    rename(coordinator, "must survive");
    await status(coordinator, "error");
    expect(coordinator.hasUnsavedLocalChanges()).toBe(true);
    expect(disk.get("local")?.spaces[0].name).toBe("before");
    expect(coordinator.getSnapshot().data.spaces[0].name).toBe("must survive");
    await coordinator.retry(coordinator.getSnapshot().token);
    expect(disk.get("local")?.spaces[0].name).toBe("must survive");
    expect(coordinator.hasUnsavedLocalChanges()).toBe(false);
    expect(coordinator.getSnapshot().status).toBe("local");
  });

  it("saves edits arriving during a cloud request against the acknowledged next revision", async () => {
    const { coordinator, io, disk, remote } = setup();
    remote.set("A", { data: data("base"), revision: 5 });
    await coordinator.activate(accountA);
    const firstSave = deferred<{ revision: number }>();
    vi.mocked(io.saveCloud).mockImplementationOnce(async (snapshot, _revision, id) => {
      const saved = await firstSave.promise;
      remote.set(id, { data: structuredClone(snapshot), revision: saved.revision });
      return saved;
    });
    rename(coordinator, "first edit");
    await vi.waitFor(() => expect(io.saveCloud).toHaveBeenCalledOnce());
    rename(coordinator, "newer edit while saving");
    firstSave.resolve({ revision: 6 });
    await status(coordinator, "cloud");
    expect(vi.mocked(io.saveCloud).mock.calls.map((call) => call[1])).toEqual([5, 6]);
    expect(remote.get("A")?.data?.spaces[0].name).toBe("newer edit while saving");
    expect(disk.get("A")?._conuoSync).toEqual({ revision: 7, dirty: false });
    expect(coordinator.getSnapshot().data.spaces[0].name).toBe("newer edit while saving");
  });

  it("keeps both concurrent reading positions instead of trusting a later local device clock", async () => {
    const { coordinator, io, remote } = setup();
    const base = workspaceWithReadingSource({
      readPage: 1,
      readOffset: 10,
      lastReadAt: "2026-09-13T08:00:00.000Z",
    });
    remote.set(accountA.id, { data: base, revision: 1 });
    await coordinator.activate(accountA);

    remote.set(accountA.id, {
      data: workspaceWithReadingSource({
        readPage: 3,
        readOffset: 30,
        lastReadAt: "2026-09-13T09:00:00.000Z",
      }),
      revision: 2,
    });
    coordinator.update(
      (current) => ({
        ...current,
        sources: current.sources.map((item) => ({
          ...item,
          readPage: 5,
          readOffset: 50,
          lastReadAt: "2026-09-13T10:00:00.000Z",
        })),
      }),
      coordinator.getSnapshot().token,
    );

    await status(coordinator, "conflict");
    expect(vi.mocked(io.saveCloud)).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot().data.sources[0]).toMatchObject({
      readPage: 5,
      readOffset: 50,
      lastReadAt: "2026-09-13T10:00:00.000Z",
    });
    expect(coordinator.getSnapshot().recovery?.sources[0]).toMatchObject({
      readPage: 3,
      readOffset: 30,
      lastReadAt: "2026-09-13T09:00:00.000Z",
    });
    expect(remote.get(accountA.id)?.revision).toBe(2);
  });

  it("keeps both concurrent reading positions instead of trusting a later remote device clock", async () => {
    const { coordinator, io, remote } = setup();
    const base = workspaceWithReadingSource({
      readPage: 1,
      readOffset: 10,
      lastReadAt: "2026-09-13T08:00:00.000Z",
    });
    remote.set(accountA.id, { data: base, revision: 1 });
    await coordinator.activate(accountA);

    remote.set(accountA.id, {
      data: workspaceWithReadingSource({
        readPage: 8,
        readOffset: 80,
        lastReadAt: "2026-09-13T11:00:00.000Z",
      }),
      revision: 2,
    });
    coordinator.update(
      (current) => ({
        ...current,
        sources: current.sources.map((item) => ({
          ...item,
          readPage: 4,
          readOffset: 40,
          lastReadAt: "2026-09-13T10:00:00.000Z",
        })),
      }),
      coordinator.getSnapshot().token,
    );

    await vi.waitFor(() => expect(vi.mocked(io.saveCloud)).toHaveBeenCalledOnce());
    await status(coordinator, "conflict");
    expect(coordinator.getSnapshot().data.sources[0]).toMatchObject({
      readPage: 4,
      readOffset: 40,
      lastReadAt: "2026-09-13T10:00:00.000Z",
    });
    expect(coordinator.getSnapshot().recovery?.sources[0]).toMatchObject({
      readPage: 8,
      readOffset: 80,
      lastReadAt: "2026-09-13T11:00:00.000Z",
    });
    expect(remote.get(accountA.id)?.revision).toBe(2);
  });

  it("retains a failed outgoing local snapshot in memory when the user switches accounts", async () => {
    const { coordinator, io, disk, remote } = setup();
    disk.set("local", data("old disk"));
    remote.set("B", { data: data("B remote"), revision: 1 });
    await coordinator.activate(null);
    vi.mocked(io.saveLocal).mockImplementation(async (snapshot, id = "local") => {
      if (id === "local") throw new Error("local storage full");
      disk.set(id, structuredClone(snapshot));
    });
    rename(coordinator, "unsaved local work");
    await status(coordinator, "error");
    await coordinator.activate(accountB);
    expect(coordinator.hasUnsavedLocalChanges()).toBe(true);
    expect(coordinator.getSnapshot().data.spaces[0].name).toBe("B remote");
    vi.mocked(io.saveLocal).mockImplementation(async (snapshot, id = "local") => {
      disk.set(id, structuredClone(snapshot));
    });
    await coordinator.activate(null);
    expect(coordinator.getSnapshot().data.spaces[0].name).toBe("unsaved local work");
    expect(disk.get("local")?.spaces[0].name).toBe("unsaved local work");
    expect(coordinator.hasUnsavedLocalChanges()).toBe(false);
  });

  it("continues local persistence while cloud saving is blocked and atomically stores its dirty revision", async () => {
    const { coordinator, io, disk, remote } = setup();
    remote.set("A", { data: data("base"), revision: 2 });
    await coordinator.activate(accountA);
    vi.mocked(io.saveCloud).mockRejectedValueOnce(new Error("offline"));
    rename(coordinator, "offline first");
    await status(coordinator, "error");
    rename(coordinator, "offline latest");
    await vi.waitFor(() => expect(disk.get("A")?.spaces[0].name).toBe("offline latest"));
    await status(coordinator, "error");
    expect(disk.get("A")?._conuoSync).toMatchObject({
      revision: 2,
      dirty: true,
      baseRevision: 2,
      base: { spaces: [{ name: "base" }] },
    });
    expect(io.saveCloud).toHaveBeenCalledOnce();
    expect(coordinator.hasUnsavedLocalChanges()).toBe(false);
    const refreshed = new WorkspaceCoordinator(io);
    await refreshed.activate(accountA);
    expect(refreshed.getSnapshot().data.spaces[0].name).toBe("offline latest");
    expect(refreshed.getSnapshot().status).toBe("cloud");
    expect(remote.get("A")?.data?.spaces[0].name).toBe("offline latest");
  });

  it("confirms a cloud save when its response is lost but one reconciliation read finds the sent snapshot", async () => {
    const { coordinator, io, disk, remote } = setup();
    remote.set(accountA.id, { data: data("base"), revision: 2 });
    await coordinator.activate(accountA);
    vi.mocked(io.saveCloud).mockImplementationOnce(async (snapshot, revision, userId) => {
      remote.set(userId, { data: structuredClone(snapshot), revision: revision + 1 });
      throw new Error("response lost");
    });

    rename(coordinator, "server committed");

    await vi.waitFor(() => expect(io.loadCloud).toHaveBeenCalledTimes(2));
    await status(coordinator, "cloud");
    expect(io.saveCloud).toHaveBeenCalledOnce();
    expect(remote.get(accountA.id)).toMatchObject({
      revision: 3,
      data: { spaces: [{ name: "server committed" }] },
    });
    expect(disk.get(accountA.id)?._conuoSync).toEqual({ revision: 3, dirty: false });
  });

  it("saves a later edit against the reconciled revision after an unknown cloud save result", async () => {
    const { coordinator, io, disk, remote } = setup();
    remote.set(accountA.id, { data: data("base"), revision: 2 });
    await coordinator.activate(accountA);
    const reconciliation = deferred<{ data: WorkspaceData | null; revision: number }>();
    vi.mocked(io.loadCloud).mockImplementationOnce(() => reconciliation.promise);
    vi.mocked(io.saveCloud).mockImplementationOnce(async (snapshot, revision, userId) => {
      remote.set(userId, { data: structuredClone(snapshot), revision: revision + 1 });
      throw new Error("response lost");
    });

    rename(coordinator, "first committed");
    await vi.waitFor(() => expect(io.loadCloud).toHaveBeenCalledTimes(2));
    rename(coordinator, "later edit");
    reconciliation.resolve(structuredClone(remote.get(accountA.id)!));

    await vi.waitFor(() => expect(io.saveCloud).toHaveBeenCalledTimes(2));
    await status(coordinator, "cloud");
    expect(vi.mocked(io.saveCloud).mock.calls[1]?.[0].spaces[0].name).toBe("later edit");
    expect(vi.mocked(io.saveCloud).mock.calls[1]?.slice(1)).toEqual([3, accountA.id]);
    expect(remote.get(accountA.id)).toMatchObject({
      revision: 4,
      data: { spaces: [{ name: "later edit" }] },
    });
    expect(disk.get(accountA.id)?._conuoSync).toEqual({ revision: 4, dirty: false });
  });

  it("keeps an ambiguous save dirty and in error when reconciliation finds no new remote revision", async () => {
    const { coordinator, io, disk, remote } = setup();
    remote.set(accountA.id, { data: data("base"), revision: 2 });
    await coordinator.activate(accountA);
    vi.mocked(io.saveCloud).mockRejectedValueOnce(new Error("connection lost"));

    rename(coordinator, "not committed");

    await vi.waitFor(() => expect(io.loadCloud).toHaveBeenCalledTimes(2));
    await status(coordinator, "error");
    expect(io.saveCloud).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot().data.spaces[0].name).toBe("not committed");
    expect(remote.get(accountA.id)).toMatchObject({
      revision: 2,
      data: { spaces: [{ name: "base" }] },
    });
    expect(disk.get(accountA.id)?._conuoSync).toMatchObject({
      revision: 2,
      dirty: true,
      baseRevision: 2,
      base: { spaces: [{ name: "base" }] },
    });
  });

  it("reads back a malformed success response even when its message mentions a cloud revision", async () => {
    const { coordinator, io, disk, remote } = setup();
    remote.set(accountA.id, { data: data("base"), revision: 2 });
    await coordinator.activate(accountA);
    vi.mocked(io.saveCloud).mockImplementationOnce(async (snapshot, revision, userId) => {
      remote.set(userId, { data: structuredClone(snapshot), revision: revision + 1 });
      throw Object.assign(new Error("云端版本确认格式无效"), {
        status: 502,
        code: "INVALID_WORKSPACE_SAVE_RESPONSE",
      });
    });

    rename(coordinator, "committed before malformed response");

    await vi.waitFor(() => expect(io.loadCloud).toHaveBeenCalledTimes(2));
    await status(coordinator, "cloud");
    expect(io.saveCloud).toHaveBeenCalledOnce();
    expect(disk.get(accountA.id)?._conuoSync).toEqual({ revision: 3, dirty: false });
  });

  it.each([
    { status: 413, code: "TOO_LARGE" },
    { status: 503, code: "WORKSPACE_BUSY" },
  ])(
    "does not read back or retry a definitive $code save rejection",
    async ({ status: responseStatus, code }) => {
      const { coordinator, io, remote } = setup();
      remote.set(accountA.id, { data: data("base"), revision: 2 });
      await coordinator.activate(accountA);
      vi.mocked(io.saveCloud).mockRejectedValueOnce(
        Object.assign(new Error(code), { status: responseStatus, code }),
      );

      rename(coordinator, "rejected edit");

      await status(coordinator, "error");
      expect(io.loadCloud).toHaveBeenCalledOnce();
      expect(io.saveCloud).toHaveBeenCalledOnce();
      expect(coordinator.getSnapshot().data.spaces[0].name).toBe("rejected edit");
    },
  );

  it("opens a conflict when reconciliation finds a different newer cloud snapshot", async () => {
    const { coordinator, io, remote } = setup();
    remote.set(accountA.id, { data: data("base"), revision: 2 });
    await coordinator.activate(accountA);
    vi.mocked(io.saveCloud).mockImplementationOnce(async (_snapshot, revision, userId) => {
      remote.set(userId, { data: data("other device"), revision: revision + 1 });
      throw new Error("response lost");
    });

    rename(coordinator, "local edit");

    await status(coordinator, "conflict");
    expect(io.loadCloud).toHaveBeenCalledTimes(2);
    expect(io.saveCloud).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot().data.spaces[0].name).toBe("local edit");
    expect(coordinator.getSnapshot().recovery?.spaces[0].name).toBe("other device");
  });

  it("does not confirm an ambiguous save when the reconciliation read fails", async () => {
    const { coordinator, io, disk, remote } = setup();
    remote.set(accountA.id, { data: data("base"), revision: 2 });
    await coordinator.activate(accountA);
    vi.mocked(io.loadCloud).mockRejectedValueOnce(new Error("GET unavailable"));
    vi.mocked(io.saveCloud).mockRejectedValueOnce(new Error("response lost"));

    rename(coordinator, "still local");

    await vi.waitFor(() => expect(io.loadCloud).toHaveBeenCalledTimes(2));
    await status(coordinator, "error");
    expect(io.saveCloud).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot().data.spaces[0].name).toBe("still local");
    expect(remote.get(accountA.id)).toMatchObject({
      revision: 2,
      data: { spaces: [{ name: "base" }] },
    });
    expect(disk.get(accountA.id)?._conuoSync).toMatchObject({
      revision: 2,
      dirty: true,
      baseRevision: 2,
      base: { spaces: [{ name: "base" }] },
    });
  });

  it("does not let a late reconciliation from a previous account confirm the new account", async () => {
    const { coordinator, io, remote } = setup();
    remote.set(accountA.id, { data: data("base"), revision: 2 });
    remote.set(accountB.id, { data: data("B remote"), revision: 4 });
    await coordinator.activate(accountA);
    const reconciliation = deferred<{ data: WorkspaceData | null; revision: number }>();
    vi.mocked(io.loadCloud).mockImplementationOnce(() => reconciliation.promise);
    vi.mocked(io.saveCloud).mockImplementationOnce(async (snapshot, revision, userId) => {
      remote.set(userId, { data: structuredClone(snapshot), revision: revision + 1 });
      throw new Error("response lost");
    });

    rename(coordinator, "A committed");
    await vi.waitFor(() => expect(io.loadCloud).toHaveBeenCalledTimes(2));
    await coordinator.activate(accountB);
    reconciliation.resolve(structuredClone(remote.get(accountA.id)!));
    await reconciliation.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    await status(coordinator, "cloud");
    expect(coordinator.getSnapshot().user?.id).toBe(accountB.id);
    expect(coordinator.getSnapshot().data.spaces[0].name).toBe("B remote");
    expect(io.saveCloud).toHaveBeenCalledOnce();
  });

  it("requires an explicit protected-draft choice before signing out with an offline cloud copy", async () => {
    const { coordinator, io, disk, remote } = setup();
    remote.set("A", { data: data("cloud"), revision: 2 });
    await coordinator.activate(accountA);
    vi.mocked(io.saveCloud).mockRejectedValueOnce(new Error("offline"));
    rename(coordinator, "offline draft");
    await status(coordinator, "error");

    const completeLocalSignOut = vi.fn(async () => {});
    const token = coordinator.getSnapshot().token;
    expect(coordinator.getSnapshot().signOutState).toMatchObject({
      kind: "unsynced",
      canSync: true,
      canKeepLocalDraft: true,
    });
    await expect(coordinator.signOut(token, "direct", completeLocalSignOut)).rejects.toThrow(
      "可安全退出",
    );
    expect(completeLocalSignOut).not.toHaveBeenCalled();

    await coordinator.signOut(token, "local", completeLocalSignOut);
    expect(completeLocalSignOut).toHaveBeenCalledOnce();
    expect(disk.get("A")?.spaces[0].name).toBe("offline draft");
    expect(disk.get("B")).toBeUndefined();

    remote.set("B", { data: data("B cloud"), revision: 1 });
    await coordinator.activate(accountB);
    expect(coordinator.getSnapshot().data.spaces[0].name).toBe("B cloud");
    await coordinator.activate(accountA);
    expect(coordinator.getSnapshot().data.spaces[0].name).toBe("offline draft");
  });

  it("refuses protected sign-out when IndexedDB has not confirmed the current draft", async () => {
    const { coordinator, io, remote } = setup();
    remote.set("A", { data: data("cloud"), revision: 2 });
    await coordinator.activate(accountA);
    vi.mocked(io.saveLocal).mockRejectedValueOnce(new Error("QuotaExceededError"));
    rename(coordinator, "draft without local confirmation");
    await status(coordinator, "error");

    const completeLocalSignOut = vi.fn(async () => {});
    const token = coordinator.getSnapshot().token;
    expect(coordinator.getSnapshot().signOutState).toMatchObject({
      kind: "local-error",
      canKeepLocalDraft: false,
    });
    await expect(coordinator.signOut(token, "local", completeLocalSignOut)).rejects.toThrow(
      "本机草稿",
    );
    expect(completeLocalSignOut).not.toHaveBeenCalled();
  });

  it("retries cloud sync before handing control to a local account sign-out", async () => {
    const { coordinator, io, remote } = setup();
    remote.set("A", { data: data("cloud"), revision: 2 });
    await coordinator.activate(accountA);
    vi.mocked(io.saveCloud).mockRejectedValueOnce(new Error("offline"));
    rename(coordinator, "retry this before exit");
    await status(coordinator, "error");

    const completeLocalSignOut = vi.fn(async () => {
      // Mirrors the SIGNED_OUT subscription that replaces the protected
      // account session once Supabase has completed its local sign-out.
      await coordinator.activate(null);
    });
    const token = coordinator.getSnapshot().token;
    await coordinator.signOut(token, "sync", completeLocalSignOut);
    expect(completeLocalSignOut).toHaveBeenCalledOnce();
    expect(remote.get("A")?.data?.spaces[0].name).toBe("retry this before exit");
    expect(coordinator.getSnapshot().signOutState.kind).toBe("ready");
  });

  it("freezes late edits until a pending local Auth exit either succeeds or fails", async () => {
    const { coordinator, remote } = setup();
    remote.set("A", { data: data("cloud"), revision: 2 });
    await coordinator.activate(accountA);
    const token = coordinator.getSnapshot().token;
    const pendingAuth = deferred<void>();
    const leaving = coordinator.signOut(token, "direct", () => pendingAuth.promise);

    await vi.waitFor(() => expect(coordinator.getSnapshot().signOutState.kind).toBe("syncing"));
    rename(coordinator, "must not write after exit begins", token);
    expect(coordinator.getSnapshot().data.spaces[0].name).toBe("cloud");

    pendingAuth.reject(new Error("Auth temporarily unavailable"));
    await expect(leaving).rejects.toThrow("Auth temporarily unavailable");
    expect(coordinator.getSnapshot().signOutState.kind).toBe("ready");
    rename(coordinator, "editable after Auth failure", token);
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().data.spaces[0].name).toBe("editable after Auth failure"),
    );
  });

  it("can retain an already-confirmed local draft while a cloud save is still pending", async () => {
    const { coordinator, io, disk, remote } = setup();
    remote.set("A", { data: data("cloud"), revision: 2 });
    await coordinator.activate(accountA);
    const pendingCloud = deferred<{ revision: number }>();
    vi.mocked(io.saveCloud).mockReturnValueOnce(pendingCloud.promise);
    rename(coordinator, "keep this local draft");
    await vi.waitFor(() => expect(io.saveCloud).toHaveBeenCalledOnce());

    const token = coordinator.getSnapshot().token;
    expect(coordinator.getSnapshot().signOutState).toMatchObject({
      kind: "syncing",
      canSync: false,
      canKeepLocalDraft: true,
    });
    const completeLocalSignOut = vi.fn(async () => {});
    await coordinator.signOut(token, "local", completeLocalSignOut);
    expect(completeLocalSignOut).toHaveBeenCalledOnce();
    expect(disk.get("A")?.spaces[0].name).toBe("keep this local draft");

    pendingCloud.resolve({ revision: 3 });
    await Promise.resolve();
  });

  it("preserves dirty local state across refresh when the cloud revision advanced", async () => {
    const { coordinator, io, disk, remote } = setup();
    disk.set("A", { ...data("unsynced local"), _conuoSync: { revision: 2, dirty: true } });
    remote.set("A", { data: data("newer remote"), revision: 3 });
    await coordinator.activate(accountA);
    expect(coordinator.getSnapshot().status).toBe("conflict");
    expect(coordinator.getSnapshot().data.spaces[0].name).toBe("unsynced local");
    expect(coordinator.getSnapshot().recovery?.spaces[0].name).toBe("newer remote");
    expect(io.saveCloud).not.toHaveBeenCalled();
    rename(coordinator, "edited during conflict");
    await vi.waitFor(() => expect(disk.get("A")?.spaces[0].name).toBe("edited during conflict"));
    await status(coordinator, "conflict");
    expect(io.saveCloud).not.toHaveBeenCalled();
  });

  it("does not overwrite different cloud data at the same revision without an exact base", async () => {
    const { coordinator, io, disk, remote } = setup();
    disk.set("A", { ...data("legacy local draft"), _conuoSync: { revision: 2, dirty: true } });
    remote.set("A", { data: data("different remote snapshot"), revision: 2 });

    await coordinator.activate(accountA);

    expect(coordinator.getSnapshot()).toMatchObject({
      status: "conflict",
      data: { spaces: [{ name: "legacy local draft" }] },
      recovery: { spaces: [{ name: "different remote snapshot" }] },
      recoveryRevision: 2,
    });
    expect(io.saveCloud).not.toHaveBeenCalled();
  });

  it("keeps a stale dirty reading cache in conflict when its common base is missing", async () => {
    const { coordinator, io, disk, remote } = setup();
    const local = workspaceWithReadingSource({
      readPage: 2,
      readOffset: 20,
      lastReadAt: "2026-09-13T09:00:00.000Z",
    });
    disk.set("A", { ...local, _conuoSync: { revision: 1, dirty: true } });
    remote.set("A", {
      data: workspaceWithReadingSource({
        readPage: 6,
        readOffset: 60,
        lastReadAt: "2026-09-13T10:00:00.000Z",
      }),
      revision: 2,
    });

    await coordinator.activate(accountA);
    await status(coordinator, "conflict");

    expect(coordinator.getSnapshot().data.sources[0]).toMatchObject({
      readPage: 2,
      readOffset: 20,
      lastReadAt: "2026-09-13T09:00:00.000Z",
    });
    expect(coordinator.getSnapshot().recovery?.sources[0]).toMatchObject({
      readPage: 6,
      readOffset: 60,
      lastReadAt: "2026-09-13T10:00:00.000Z",
    });
    expect(io.saveCloud).not.toHaveBeenCalled();
  });

  it("restores a persisted common base and rebases a one-sided reading edit after refresh", async () => {
    const { coordinator, io, disk, remote } = setup();
    const base = workspaceWithReadingSource({
      readPage: 1,
      readOffset: 10,
      lastReadAt: "2026-09-13T08:00:00.000Z",
    });
    const local = workspaceWithReadingSource({
      readPage: 2,
      readOffset: 20,
      lastReadAt: "2026-09-13T09:00:00.000Z",
    });
    disk.set("A", {
      ...local,
      _conuoSync: { revision: 1, dirty: true, baseRevision: 1, base },
    });
    remote.set("A", { data: base, revision: 2 });

    await coordinator.activate(accountA);
    await status(coordinator, "cloud");

    expect(io.saveCloud).toHaveBeenCalledOnce();
    expect(vi.mocked(io.saveCloud).mock.calls[0]?.[0]).not.toHaveProperty("_conuoSync");
    expect(remote.get("A")).toMatchObject({
      revision: 3,
      data: {
        sources: [
          {
            readPage: 2,
            readOffset: 20,
            lastReadAt: "2026-09-13T09:00:00.000Z",
          },
        ],
      },
    });
    expect(disk.get("A")?._conuoSync).toEqual({ revision: 3, dirty: false });
  });

  it("keeps a cloud-deleted source deleted while preserving offline source, annotation, and note edits", async () => {
    const { coordinator, io, remote } = setup();
    const base = workspaceWithReadingSource();
    remote.set("A", { data: base, revision: 1 });
    await coordinator.activate(accountA);

    const deletedAt = "2026-09-13T10:00:00.000Z";
    const deletedRemote = structuredClone(base);
    deletedRemote.sources[0] = {
      ...deletedRemote.sources[0],
      deletedAt,
      updatedAt: deletedAt,
    };
    remote.set("A", { data: deletedRemote, revision: 2 });

    coordinator.update(
      (current) => ({
        ...current,
        sources: current.sources.map((source) => ({ ...source, title: "本机离线标题" })),
        annotations: [
          ...current.annotations,
          {
            id: "offline-annotation",
            sourceId: "source-a",
            versionId: "source-a-version",
            quote: "离线摘录",
            note: "离线新增的批注文字",
            createdAt: "2026-09-13T09:30:00.000Z",
          },
        ],
        notes: [
          ...current.notes,
          note("离线新增的笔记文字", { id: "offline-note", spaceId: "base" }),
        ],
      }),
      coordinator.getSnapshot().token,
    );

    await status(coordinator, "cloud");

    expect(io.saveCloud).toHaveBeenCalledTimes(2);
    expect(remote.get("A")).toMatchObject({
      revision: 3,
      data: {
        sources: [{ title: "本机离线标题", deletedAt }],
        annotations: [{ id: "offline-annotation", note: "离线新增的批注文字" }],
        notes: [{ id: "offline-note", content: "离线新增的笔记文字" }],
      },
    });
  });

  it("uses a persisted base after refresh without reviving a source deleted in the cloud", async () => {
    const { coordinator, io, disk, remote } = setup();
    const base = workspaceWithReadingSource();
    const local = structuredClone(base);
    local.sources[0] = { ...local.sources[0], title: "刷新前的离线标题" };
    local.annotations = [
      {
        id: "offline-annotation",
        sourceId: "source-a",
        versionId: "source-a-version",
        quote: "离线摘录",
        note: "刷新后也要保留",
        createdAt: "2026-09-13T09:30:00.000Z",
      },
    ];
    disk.set("A", {
      ...local,
      _conuoSync: { revision: 1, dirty: true, baseRevision: 1, base },
    });
    const deletedAt = "2026-09-13T10:00:00.000Z";
    const deletedRemote = structuredClone(base);
    deletedRemote.sources[0] = {
      ...deletedRemote.sources[0],
      deletedAt,
      updatedAt: deletedAt,
    };
    remote.set("A", { data: deletedRemote, revision: 2 });

    await coordinator.activate(accountA);
    await status(coordinator, "cloud");

    expect(io.saveCloud).toHaveBeenCalledOnce();
    expect(remote.get("A")).toMatchObject({
      revision: 3,
      data: {
        sources: [{ title: "刷新前的离线标题", deletedAt }],
        annotations: [{ id: "offline-annotation", note: "刷新后也要保留" }],
      },
    });
    expect(disk.get("A")?._conuoSync).toEqual({ revision: 3, dirty: false });
  });

  it("accepts a cloud purge and its reference cleanup while retaining an unrelated offline note", async () => {
    const { coordinator, io, remote } = setup();
    const source = readingSource({
      text: "可核对的原文",
      chunks: [
        {
          id: "chunk-a",
          sourceId: "source-a",
          versionId: "source-a-version",
          text: "可核对的原文",
          section: "正文",
          order: 0,
        },
      ],
    });
    const citation = {
      sourceId: source.id,
      versionId: source.versionId,
      chunkId: "chunk-a",
      title: source.title,
      quote: "可核对的原文",
      section: "正文",
    };
    const base: WorkspaceData = {
      ...data("base"),
      sources: [source],
      annotations: [
        {
          id: "annotation-a",
          sourceId: source.id,
          versionId: source.versionId,
          quote: "可核对的原文",
          note: "随资料清理的批注",
          createdAt: "2026-09-13T08:30:00.000Z",
        },
      ],
      notes: [note("带来源的旧笔记", { citations: [citation] })],
    };
    remote.set("A", { data: base, revision: 1 });
    await coordinator.activate(accountA);

    const purged = structuredClone(base);
    purged.sources = [];
    purged.annotations = [];
    purged.notes = purged.notes.map((item) => ({ ...item, citations: [] }));
    remote.set("A", { data: purged, revision: 2 });
    coordinator.update(
      (current) => ({
        ...current,
        notes: [...current.notes, note("与被清理资料无关的离线笔记", { id: "offline-note" })],
      }),
      coordinator.getSnapshot().token,
    );

    await status(coordinator, "cloud");

    expect(io.saveCloud).toHaveBeenCalledTimes(2);
    expect(remote.get("A")).toMatchObject({ revision: 3 });
    expect(remote.get("A")?.data?.sources).toEqual([]);
    expect(remote.get("A")?.data?.annotations).toEqual([]);
    expect(remote.get("A")?.data?.notes.find((item) => item.id === "note-a")?.citations).toEqual(
      [],
    );
    expect(remote.get("A")?.data?.notes.find((item) => item.id === "offline-note")?.content).toBe(
      "与被清理资料无关的离线笔记",
    );
  });

  it("does not retry a 409 when the cloud revision did not advance", async () => {
    const { coordinator, io, remote } = setup();
    remote.set("A", {
      data: workspaceWithReadingSource({
        readPage: 1,
        readOffset: 10,
        lastReadAt: "2026-09-13T08:00:00.000Z",
      }),
      revision: 1,
    });
    await coordinator.activate(accountA);
    vi.mocked(io.saveCloud).mockRejectedValueOnce(
      Object.assign(new Error("409 conflict"), { status: 409 }),
    );

    coordinator.update(
      (current) => ({
        ...current,
        sources: current.sources.map((item) => ({
          ...item,
          readPage: 2,
          readOffset: 20,
          lastReadAt: "2026-09-13T09:00:00.000Z",
        })),
      }),
      coordinator.getSnapshot().token,
    );

    await status(coordinator, "error");
    expect(io.saveCloud).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot().recovery).toBeNull();
    expect(coordinator.getSnapshot().data.sources[0]).toMatchObject({
      readPage: 2,
      readOffset: 20,
      lastReadAt: "2026-09-13T09:00:00.000Z",
    });
  });

  it("does not loop on a reading race that changed on both devices", async () => {
    const { coordinator, io, remote } = setup();
    remote.set("A", {
      data: workspaceWithReadingSource({
        readPage: 1,
        readOffset: 10,
        lastReadAt: "2026-09-13T08:00:00.000Z",
      }),
      revision: 1,
    });
    await coordinator.activate(accountA);
    vi.mocked(io.saveCloud).mockImplementation(async (_snapshot, revision, id) => {
      const nextRevision = revision + 1;
      remote.set(id, {
        data: workspaceWithReadingSource({
          readPage: nextRevision,
          readOffset: nextRevision * 10,
          lastReadAt: `2026-09-13T${String(nextRevision + 7).padStart(2, "0")}:00:00.000Z`,
        }),
        revision: nextRevision,
      });
      throw Object.assign(new Error("409 conflict"), { status: 409 });
    });

    coordinator.update(
      (current) => ({
        ...current,
        sources: current.sources.map((item) => ({
          ...item,
          readPage: 20,
          readOffset: 200,
          lastReadAt: "2026-09-13T20:00:00.000Z",
        })),
      }),
      coordinator.getSnapshot().token,
    );

    await status(coordinator, "conflict");
    expect(io.saveCloud).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot().recoveryRevision).toBe(2);
    expect(coordinator.getSnapshot().data.sources[0]).toMatchObject({
      readPage: 20,
      readOffset: 200,
      lastReadAt: "2026-09-13T20:00:00.000Z",
    });
  });

  it("bounds repeated safe object rebases when another browser keeps advancing", async () => {
    const { coordinator, io, remote } = setup();
    const base = workspaceWithNote("base", "base explanation");
    remote.set("A", { data: base, revision: 1 });
    await coordinator.activate(accountA);
    vi.mocked(io.saveCloud).mockImplementation(async (_snapshot, revision, id) => {
      const current = remote.get(id)!;
      const nextRevision = revision + 1;
      remote.set(id, {
        data: {
          ...structuredClone(current.data!),
          notes: [
            ...current.data!.notes,
            note(`remote ${nextRevision}`, { id: `remote-add-${nextRevision}` }),
          ],
        },
        revision: nextRevision,
      });
      throw Object.assign(new Error("409 conflict"), { status: 409 });
    });

    coordinator.update(
      (current) => ({
        ...current,
        notes: [...current.notes, note("local independent", { id: "local-add" })],
      }),
      coordinator.getSnapshot().token,
    );

    await status(coordinator, "conflict");
    expect(io.saveCloud).toHaveBeenCalledTimes(4);
    expect(coordinator.getSnapshot().recoveryRevision).toBe(5);
    expect(
      coordinator
        .getSnapshot()
        .data.notes.map((item) => item.id)
        .sort(),
    ).toEqual(["local-add", "note-a", "remote-add-2", "remote-add-3", "remote-add-4"]);
    expect(
      coordinator
        .getSnapshot()
        .recovery?.notes.map((item) => item.id)
        .sort(),
    ).toEqual(["note-a", "remote-add-2", "remote-add-3", "remote-add-4", "remote-add-5"]);
  });

  it("treats missing legacy metadata conservatively instead of overwriting an unexplained local cache", async () => {
    const { coordinator, io, disk, remote } = setup();
    disk.set("A", data("legacy local edit"));
    remote.set("A", { data: data("remote"), revision: 4 });
    await coordinator.activate(accountA);
    expect(coordinator.getSnapshot().status).toBe("conflict");
    expect(coordinator.getSnapshot().data.spaces[0].name).toBe("legacy local edit");
    expect(io.saveCloud).not.toHaveBeenCalled();
  });

  it("does not overwrite unreadable local storage with a new empty workspace", async () => {
    const { coordinator, io, disk } = setup();
    disk.set("local", data("existing cache"));
    vi.mocked(io.loadLocal).mockRejectedValueOnce(new Error("cache cannot be read"));
    await coordinator.activate(null);
    expect(coordinator.getSnapshot().ready).toBe(false);
    expect(coordinator.getSnapshot().status).toBe("error");
    expect(io.saveLocal).not.toHaveBeenCalled();
    await coordinator.retry(coordinator.getSnapshot().token);
    expect(coordinator.getSnapshot().data.spaces[0].name).toBe("existing cache");
    expect(coordinator.getSnapshot().ready).toBe(true);
  });

  it("shows an already-confirmed cloud workspace read-only when an account cache cannot be read", async () => {
    const { coordinator, io, disk, remote } = setup();
    const cloud = data("confirmed cloud");
    const source = parsedImport(
      await prepareImportFile(
        new File(["confirmed original"], "confirmed.txt"),
        cloud.spaces[0]!.id,
      ),
    );
    cloud.sources = [{ ...source, storagePath: "originals/A/confirmed.txt" }];
    remote.set(accountA.id, { data: cloud, revision: 7 });
    vi.mocked(io.loadLocal).mockImplementation(async (id = "local") => {
      if (id === accountA.id) throw new Error("IndexedDB unavailable");
      return structuredClone(disk.get(id) || null);
    });
    const downloaded = new Blob(["confirmed original"]);
    vi.mocked(io.downloadBlob).mockResolvedValue(downloaded);

    await coordinator.activate(accountA);

    const snapshot = coordinator.getSnapshot();
    expect(snapshot).toMatchObject({
      ready: true,
      status: "error",
      localCacheMode: "cloud-readonly",
      data: { spaces: [{ name: "confirmed cloud" }] },
    });
    expect(snapshot.error).toContain("仅可查看");
    expect(snapshot.signOutState).toEqual({
      kind: "ready",
      canSync: false,
      canKeepLocalDraft: false,
    });
    expect(disk.has(accountA.id)).toBe(false);
    expect(io.saveLocal).not.toHaveBeenCalled();
    expect(io.saveCloud).not.toHaveBeenCalled();
    expect(await coordinator.sourceBlob(snapshot.data.sources[0]!, snapshot.token)).toBe(
      downloaded,
    );

    rename(coordinator, "must not write");
    expect(coordinator.getSnapshot().data.spaces[0]?.name).toBe("confirmed cloud");
    await expect(
      coordinator.importFile(new File(["new"], "new.txt"), cloud.spaces[0]!.id, snapshot.token),
    ).rejects.toThrow("仅可查看");
    await expect(coordinator.retryImport("missing", snapshot.token)).rejects.toThrow("仅可查看");
    coordinator.cancelImport("missing", snapshot.token);
    await expect(
      coordinator.replaceFile(
        "missing",
        "missing",
        {} as Source,
        new Blob(["new"]),
        snapshot.token,
      ),
    ).rejects.toThrow("仅可查看");
    await expect(coordinator.restoreBackup({} as RestorePlan, snapshot.token)).rejects.toThrow(
      "仅可查看",
    );
    await expect(
      coordinator.purgeSource("missing", {} as SourcePurgePreview, snapshot.token),
    ).rejects.toThrow("仅可查看");
    await expect(
      coordinator.organize(
        { kind: "source", spaceId: cloud.spaces[0]!.id, sourceIds: [] },
        undefined,
        snapshot.token,
      ),
    ).rejects.toThrow("仅可查看");
    await expect(
      coordinator.ask(
        {
          question: "这份资料讲了什么？",
          scope: "document",
          spaceId: cloud.spaces[0]!.id,
          sourceId: source.id,
          sourceIds: [],
        },
        new AbortController().signal,
        snapshot.token,
      ),
    ).rejects.toThrow("仅可查看");
    expect(io.askCloud).not.toHaveBeenCalled();
    expect(io.putBlobIfAbsent).not.toHaveBeenCalled();
    expect(io.saveLocal).not.toHaveBeenCalled();
    expect(io.saveCloud).not.toHaveBeenCalled();

    const completeLocalSignOut = vi.fn(async () => {});
    await coordinator.signOut(snapshot.token, "direct", completeLocalSignOut);
    expect(completeLocalSignOut).toHaveBeenCalledOnce();
  });

  it("retries a cloud-readonly account through a fresh activation without reconciling an unreadable cache", async () => {
    const { coordinator, io, disk, remote } = setup();
    remote.set(accountA.id, { data: data("cloud survives retry"), revision: 4 });
    vi.mocked(io.loadLocal).mockImplementation(async (id = "local") => {
      if (id === accountA.id) throw new Error("IndexedDB temporarily unavailable");
      return structuredClone(disk.get(id) || null);
    });

    await coordinator.activate(accountA);
    const first = coordinator.getSnapshot();
    await coordinator.retry(first.token);

    const retried = coordinator.getSnapshot();
    expect(retried.token).toBeGreaterThan(first.token);
    expect(retried).toMatchObject({
      ready: true,
      localCacheMode: "cloud-readonly",
      data: { spaces: [{ name: "cloud survives retry" }] },
    });
    expect(vi.mocked(io.loadLocal).mock.calls.filter(([id]) => id === accountA.id)).toHaveLength(2);
    expect(vi.mocked(io.loadCloud).mock.calls.filter(([id]) => id === accountA.id)).toHaveLength(2);
    expect(io.saveLocal).not.toHaveBeenCalled();
    expect(io.saveCloud).not.toHaveBeenCalled();
  });

  it("keeps a retained dirty account draft on the normal conflict path instead of replacing it with cloud-readonly data", async () => {
    const { coordinator, io, disk, remote } = setup();
    remote.set(accountA.id, { data: data("base cloud"), revision: 1 });
    await coordinator.activate(accountA);
    vi.mocked(io.saveCloud).mockRejectedValueOnce(new Error("offline"));
    rename(coordinator, "retained in-memory draft");
    await status(coordinator, "error");
    await coordinator.activate(accountB);
    remote.set(accountA.id, { data: data("newer cloud"), revision: 2 });
    vi.mocked(io.loadLocal).mockImplementation(async (id = "local") => {
      if (id === accountA.id) throw new Error("IndexedDB unavailable");
      return structuredClone(disk.get(id) || null);
    });

    await coordinator.activate(accountA);

    expect(coordinator.getSnapshot()).toMatchObject({
      ready: true,
      localCacheMode: "normal",
      status: "conflict",
      data: { spaces: [{ name: "retained in-memory draft" }] },
      recovery: { spaces: [{ name: "newer cloud" }] },
      recoveryRevision: 2,
    });
  });

  it("returns to the normal conflict guard when a previously unreadable cache recovers", async () => {
    const { coordinator, io, disk, remote } = setup();
    remote.set(accountA.id, { data: data("remote current"), revision: 3 });
    let cacheAvailable = false;
    vi.mocked(io.loadLocal).mockImplementation(async (id = "local") => {
      if (id === accountA.id && !cacheAvailable) throw new Error("IndexedDB unavailable");
      return structuredClone(disk.get(id) || null);
    });

    await coordinator.activate(accountA);
    const readonly = coordinator.getSnapshot();
    disk.set(accountA.id, { ...data("local draft"), _conuoSync: { revision: 2, dirty: true } });
    cacheAvailable = true;

    await coordinator.retry(readonly.token);

    expect(coordinator.getSnapshot()).toMatchObject({
      ready: true,
      localCacheMode: "normal",
      status: "conflict",
      data: { spaces: [{ name: "local draft" }] },
      recovery: { spaces: [{ name: "remote current" }] },
      recoveryRevision: 3,
    });
    expect(io.saveCloud).not.toHaveBeenCalled();
  });

  it("accepts the same recovered cache without uploading a new empty or duplicate workspace", async () => {
    const { coordinator, io, disk, remote } = setup();
    const cloud = data("same confirmed workspace");
    remote.set(accountA.id, { data: cloud, revision: 3 });
    let cacheAvailable = false;
    vi.mocked(io.loadLocal).mockImplementation(async (id = "local") => {
      if (id === accountA.id && !cacheAvailable) throw new Error("IndexedDB unavailable");
      return structuredClone(disk.get(id) || null);
    });

    await coordinator.activate(accountA);
    const readonly = coordinator.getSnapshot();
    disk.set(accountA.id, { ...structuredClone(cloud), _conuoSync: { revision: 2, dirty: true } });
    cacheAvailable = true;

    await coordinator.retry(readonly.token);

    expect(coordinator.getSnapshot()).toMatchObject({
      ready: true,
      localCacheMode: "normal",
      status: "cloud",
      data: { spaces: [{ name: "same confirmed workspace" }] },
    });
    expect(disk.get(accountA.id)?._conuoSync).toEqual({ revision: 3, dirty: false });
    expect(io.saveCloud).not.toHaveBeenCalled();
  });

  for (const remoteState of ["empty", "unavailable"] as const) {
    it(`does not bootstrap an account when its cache is unreadable and the cloud is ${remoteState}`, async () => {
      const { coordinator, io, disk } = setup();
      vi.mocked(io.loadLocal).mockImplementation(async (id = "local") => {
        if (id === accountA.id) throw new Error("IndexedDB unavailable");
        return structuredClone(disk.get(id) || null);
      });
      if (remoteState === "unavailable")
        vi.mocked(io.loadCloud).mockRejectedValue(new Error("offline"));

      await coordinator.activate(accountA);

      expect(coordinator.getSnapshot()).toMatchObject({ ready: false, status: "error" });
      expect(io.saveLocal).not.toHaveBeenCalled();
      expect(io.saveCloud).not.toHaveBeenCalled();
      expect(disk.has(accountA.id)).toBe(false);
    });
  }

  it("backs up the latest local copy before accepting remote recovery", async () => {
    const { coordinator, disk, remote } = setup();
    disk.set("A", { ...data("local to keep"), _conuoSync: { revision: 1, dirty: true } });
    remote.set("A", { data: data("remote chosen"), revision: 2 });
    await coordinator.activate(accountA);
    await coordinator.useRemote(coordinator.getSnapshot().token);
    expect(coordinator.getSnapshot().data.spaces[0].name).toBe("remote chosen");
    expect(coordinator.getSnapshot().status).toBe("cloud");
    const backups = [...disk.entries()].filter(([id]) => id.startsWith("recovery:A:"));
    expect(backups).toHaveLength(1);
    expect(backups[0][1].spaces[0].name).toBe("local to keep");
  });
});

describe("anonymous local workspace migration", () => {
  it("discovers a meaningful anonymous library before an empty account is bootstrapped", async () => {
    const { coordinator, io, disk } = setup();
    disk.set("local", data("匿名本机资料"));

    await coordinator.activate(accountA);

    expect(coordinator.getSnapshot()).toMatchObject({
      user: accountA,
      anonymousMigration: {
        kind: "pending",
        canMigrate: true,
        sourceCount: 0,
        noteCount: 0,
      },
    });
    expect(io.saveCloud).not.toHaveBeenCalled();
    expect(disk.has(accountA.id)).toBe(false);
    expect(disk.get("local")?.spaces[0].name).toBe("匿名本机资料");
  });

  it("can explicitly defer migration without deleting the anonymous browser copy", async () => {
    const { coordinator, disk, remote } = setup();
    disk.set("local", data("稍后迁移的资料"));
    await coordinator.activate(accountA);

    await coordinator.skipAnonymousWorkspaceMigration(coordinator.getSnapshot().token);

    expect(coordinator.getSnapshot().anonymousMigration).toMatchObject({
      kind: "dismissed",
      canMigrate: false,
    });
    expect(disk.get("local")?.spaces[0].name).toBe("稍后迁移的资料");
    expect(remote.get(accountA.id)?.data?.spaces[0].name).not.toBe("稍后迁移的资料");
    expect(disk.get(accountA.id)?.spaces[0].name).not.toBe("稍后迁移的资料");
  });

  it("copies anonymous sources into an empty account, keeps local originals, and awaits cloud confirmation", async () => {
    const { coordinator, io, disk, remote, blobs } = setup();
    const anonymous = data("匿名学习资料");
    const original = new Blob(["匿名资料原件"], { type: "text/plain" });
    const prepared = await prepareImportFile(
      new File([original], "anonymous.txt", { type: "text/plain" }),
      anonymous.spaces[0]!.id,
    );
    const source = parsedImport(prepared, "匿名资料正文");
    anonymous.sources.push(source);
    disk.set("local", anonymous);
    blobs.set(source.blobKey!, original);
    await coordinator.activate(accountA);
    const cloudConfirmation = deferred<{ revision: number }>();
    vi.mocked(io.saveCloud).mockImplementationOnce(async (snapshot, _revision, id) => {
      const saved = await cloudConfirmation.promise;
      remote.set(id, { data: structuredClone(snapshot), revision: saved.revision });
      return saved;
    });

    const migration = coordinator.migrateAnonymousWorkspace(coordinator.getSnapshot().token);
    await vi.waitFor(() => expect(io.saveCloud).toHaveBeenCalledOnce());
    expect(coordinator.getSnapshot().anonymousMigration).toMatchObject({
      kind: "migrated",
      pendingCloudConfirmation: true,
    });
    cloudConfirmation.resolve({ revision: 1 });
    await migration;

    const migrated = coordinator.getSnapshot();
    expect(migrated.data.sources[0]).toMatchObject({
      id: source.id,
      blobKey: source.blobKey,
      storagePath: "path",
    });
    expect(migrated.anonymousMigration).toMatchObject({
      kind: "migrated",
      canMigrate: false,
      pendingCloudConfirmation: false,
    });
    expect(io.uploadBlob).toHaveBeenCalledWith(
      expect.objectContaining({ id: source.id }),
      original,
      accountA.id,
    );
    expect(remote.get(accountA.id)?.data?.sources[0]).toMatchObject({
      id: source.id,
      blobKey: source.blobKey,
      storagePath: "path",
    });
    expect(disk.get("local")?.sources[0]).toMatchObject({ id: source.id, blobKey: source.blobKey });
    expect(disk.get("local")?.sources[0]?.storagePath).toBeUndefined();
    expect(await coordinator.sourceBlob(migrated.data.sources[0]!, migrated.token)).toBe(original);

    const refreshed = new WorkspaceCoordinator(io);
    await refreshed.activate(accountA);
    expect(refreshed.getSnapshot().anonymousMigration).toMatchObject({
      kind: "migrated",
      canMigrate: false,
      pendingCloudConfirmation: false,
    });
    expect(io.saveCloud).toHaveBeenCalledOnce();
  });

  it("refuses migration when a target account gains data after discovery", async () => {
    const { coordinator, disk, remote } = setup();
    disk.set("local", data("匿名资料"));
    await coordinator.activate(accountA);
    remote.set(accountA.id, { data: data("账号已有资料"), revision: 1 });

    await expect(
      coordinator.migrateAnonymousWorkspace(coordinator.getSnapshot().token),
    ).rejects.toThrow("当前账号已有资料");

    expect(coordinator.getSnapshot().anonymousMigration).toMatchObject({
      kind: "requires-export",
      canMigrate: false,
    });
    expect(remote.get(accountA.id)?.data?.spaces[0].name).toBe("账号已有资料");
    expect(disk.get(accountA.id)).toBeUndefined();
    expect(disk.get("local")?.spaces[0].name).toBe("匿名资料");
  });

  it("keeps both account and anonymous records untouched when the migration copy is not locally durable", async () => {
    const { coordinator, io, disk, remote } = setup();
    disk.set("local", data("本机写入失败时的匿名资料"));
    await coordinator.activate(accountA);
    vi.mocked(io.saveLocal).mockRejectedValueOnce(new Error("IndexedDB full"));

    await expect(
      coordinator.migrateAnonymousWorkspace(coordinator.getSnapshot().token),
    ).rejects.toThrow("尚未确认保存在当前账号");

    expect(coordinator.getSnapshot().anonymousMigration).toMatchObject({
      kind: "pending",
      canMigrate: true,
    });
    expect(coordinator.getSnapshot().data.spaces[0].name).not.toBe("本机写入失败时的匿名资料");
    expect(disk.get(accountA.id)).toBeUndefined();
    expect(remote.get(accountA.id)).toBeUndefined();
    expect(disk.get("local")?.spaces[0].name).toBe("本机写入失败时的匿名资料");
  });

  it("does not infer or revive anonymous data when its local record cannot be read", async () => {
    const { coordinator, io, disk, remote } = setup();
    disk.set("local", data("不可读取的匿名资料"));
    vi.mocked(io.loadLocal).mockImplementation(async (id = "local") => {
      if (id === "local") throw new Error("anonymous cache unavailable");
      return structuredClone(disk.get(id) || null);
    });

    await coordinator.activate(accountA);

    expect(coordinator.getSnapshot().anonymousMigration).toMatchObject({
      kind: "unavailable",
      canMigrate: false,
    });
    expect(coordinator.getSnapshot().data.spaces[0].name).not.toBe("不可读取的匿名资料");
    expect(remote.get(accountA.id)?.data?.spaces[0].name).not.toBe("不可读取的匿名资料");
    expect(disk.get("local")?.spaces[0].name).toBe("不可读取的匿名资料");
  });

  it("does not move a pending anonymous copy into a different account after an account switch", async () => {
    const { coordinator, io, disk, remote } = setup();
    disk.set("local", data("不可跨账号复活的匿名资料"));
    await coordinator.activate(accountA);
    const delayedCloud = deferred<{ data: WorkspaceData | null; revision: number }>();
    vi.mocked(io.loadCloud).mockImplementationOnce(() => delayedCloud.promise);

    const migration = coordinator.migrateAnonymousWorkspace(coordinator.getSnapshot().token);
    await vi.waitFor(() => expect(io.loadCloud).toHaveBeenCalledTimes(2));
    await coordinator.activate(accountB);
    delayedCloud.resolve({ data: null, revision: 0 });
    await migration;

    expect(coordinator.getSnapshot()).toMatchObject({
      user: accountB,
      anonymousMigration: { kind: "pending", canMigrate: true },
    });
    expect(coordinator.getSnapshot().data.spaces[0].name).not.toBe("不可跨账号复活的匿名资料");
    expect(remote.get(accountA.id)).toBeUndefined();
    expect(remote.get(accountB.id)).toBeUndefined();
    expect(disk.get(accountA.id)?.spaces[0].name).not.toBe("不可跨账号复活的匿名资料");
    expect(disk.get(accountB.id)?.spaces[0].name).not.toBe("不可跨账号复活的匿名资料");
    expect(disk.get("local")?.spaces[0].name).toBe("不可跨账号复活的匿名资料");
  });
});

describe("note-level cloud conflict resolution", () => {
  it("preserves both concurrent note bodies and uploads a user-authored merge", async () => {
    const { coordinator, remote } = setup();
    const base = workspaceWithNote("base", "base explanation");
    remote.set(accountA.id, { data: base, revision: 1 });
    await coordinator.activate(accountA);

    remote.set(accountA.id, {
      data: {
        ...structuredClone(base),
        notes: [note("remote explanation", { contentRevision: 1 })],
      },
      revision: 2,
    });
    editNote(coordinator, "local explanation");
    await status(coordinator, "conflict");

    const conflict = coordinator.getSnapshot();
    expect(conflict.recoveryRevision).toBe(2);
    expect(conflict.recovery?.notes[0].content).toBe("remote explanation");
    expect(conflict.noteSyncPlan?.conflicts).toHaveLength(1);

    await coordinator.resolveNoteConflicts(
      [
        {
          conflictId: "note-conflict:note-a",
          choice: "manual",
          content: "combined explanation",
        },
      ],
      conflict.token,
    );
    await status(coordinator, "cloud");

    const saved = remote.get(accountA.id)!;
    expect(saved.revision).toBe(3);
    expect(saved.data?.notes[0]).toMatchObject({
      content: "combined explanation",
      contentRevision: 2,
    });
    expect(saved.data?.notes[0].versions.map((version) => version.content)).toEqual([
      "local explanation",
      "remote explanation",
    ]);
    expect(coordinator.getSnapshot().recovery).toBeNull();
  });

  it("combines independently added notes when the confirmed base proves they do not overlap", async () => {
    const { coordinator, io, remote } = setup();
    const base = workspaceWithNote("base", "base explanation");
    remote.set(accountA.id, { data: base, revision: 1 });
    await coordinator.activate(accountA);
    remote.set(accountA.id, {
      data: {
        ...structuredClone(base),
        notes: [...base.notes, note("remote independent", { id: "remote-add" })],
      },
      revision: 2,
    });
    coordinator.update(
      (current) => ({
        ...current,
        notes: [...current.notes, note("local independent", { id: "local-add" })],
      }),
      coordinator.getSnapshot().token,
    );
    await status(coordinator, "cloud");
    expect(io.saveCloud).toHaveBeenCalledTimes(2);
    expect(coordinator.getSnapshot().recovery).toBeNull();
    expect(
      remote
        .get(accountA.id)
        ?.data?.notes.map((item) => item.id)
        .sort(),
    ).toEqual(["local-add", "note-a", "remote-add"]);
  });

  it("refreshes the recovery candidate instead of writing when the cloud changes again", async () => {
    const { coordinator, remote } = setup();
    const base = workspaceWithNote("base", "base explanation");
    remote.set(accountA.id, { data: base, revision: 1 });
    await coordinator.activate(accountA);
    remote.set(accountA.id, {
      data: {
        ...structuredClone(base),
        notes: [note("first remote edit", { contentRevision: 1 })],
      },
      revision: 2,
    });
    editNote(coordinator, "local explanation");
    await status(coordinator, "conflict");

    remote.set(accountA.id, {
      data: {
        ...structuredClone(base),
        notes: [note("newer remote edit", { contentRevision: 2 })],
      },
      revision: 3,
    });
    await expect(
      coordinator.resolveNoteConflicts(
        [{ conflictId: "note-conflict:note-a", choice: "local" }],
        coordinator.getSnapshot().token,
      ),
    ).rejects.toThrow("云端版本已再次变化");

    const refreshed = coordinator.getSnapshot();
    expect(refreshed.status).toBe("conflict");
    expect(refreshed.data.notes[0].content).toBe("local explanation");
    expect(refreshed.recoveryRevision).toBe(3);
    expect(refreshed.recovery?.notes[0].content).toBe("newer remote edit");
    expect(remote.get(accountA.id)?.revision).toBe(3);
  });

  it("keeps non-note differences on the explicit backup and remote-recovery path", async () => {
    const { coordinator, remote } = setup();
    const base = workspaceWithNote("base", "base explanation");
    remote.set(accountA.id, { data: base, revision: 1 });
    await coordinator.activate(accountA);
    remote.set(accountA.id, {
      data: {
        ...structuredClone(base),
        aiEnabled: false,
        notes: [note("remote explanation", { contentRevision: 1 })],
      },
      revision: 2,
    });
    editNote(coordinator, "local explanation");
    await status(coordinator, "conflict");

    const snapshot = coordinator.getSnapshot();
    expect(snapshot.noteSyncPlan).toBeNull();
    await expect(
      coordinator.resolveNoteConflicts(
        [{ conflictId: "note-conflict:note-a", choice: "local" }],
        snapshot.token,
      ),
    ).rejects.toThrow("暂不能安全自动合并");
    expect(remote.get(accountA.id)?.revision).toBe(2);
  });

  it("does not auto-resurrect a note when deletion conflicts with a local edit", async () => {
    const { coordinator, remote } = setup();
    const base = workspaceWithNote("base", "base explanation");
    remote.set(accountA.id, { data: base, revision: 1 });
    await coordinator.activate(accountA);
    remote.set(accountA.id, {
      data: {
        ...structuredClone(base),
        notes: [note("base explanation", { deletedAt: "2026-09-13T09:00:00.000Z" })],
      },
      revision: 2,
    });
    editNote(coordinator, "local explanation");
    await status(coordinator, "conflict");

    const snapshot = coordinator.getSnapshot();
    expect(snapshot.noteSyncPlan).toBeNull();
    await expect(
      coordinator.resolveNoteConflicts(
        [{ conflictId: "note-conflict:note-a", choice: "local" }],
        snapshot.token,
      ),
    ).rejects.toThrow("暂不能安全自动合并");
    expect(remote.get(accountA.id)?.data?.notes[0].deletedAt).toBe("2026-09-13T09:00:00.000Z");
  });
});

describe("reading-position cloud conflict resolution", () => {
  function moveReadingPosition(
    coordinator: WorkspaceCoordinator,
    progress: Pick<Source, "readPage" | "readOffset" | "lastReadAt">,
  ) {
    coordinator.update(
      (current) => ({
        ...current,
        sources: current.sources.map((source) => ({ ...source, ...progress })),
      }),
      coordinator.getSnapshot().token,
    );
  }

  async function createReadingConflict() {
    const fixture = setup();
    const base = workspaceWithReadingSource({
      readPage: 1,
      readOffset: 10,
      lastReadAt: "2026-09-13T08:00:00.000Z",
    });
    fixture.remote.set(accountA.id, { data: base, revision: 1 });
    await fixture.coordinator.activate(accountA);
    fixture.remote.set(accountA.id, {
      data: workspaceWithReadingSource({
        readPage: 4,
        readOffset: 400,
        lastReadAt: "2026-09-13T10:00:00.000Z",
      }),
      revision: 2,
    });
    // The later-looking local device time is deliberately not authoritative.
    moveReadingPosition(fixture.coordinator, {
      readPage: 9,
      readOffset: 900,
      lastReadAt: "2026-09-13T11:00:00.000Z",
    });
    await status(fixture.coordinator, "conflict");
    return fixture;
  }

  it("preserves the losing local position before saving the reviewed cloud position", async () => {
    const { coordinator, io, remote } = await createReadingConflict();
    const conflict = coordinator.getSnapshot();
    expect(conflict.readingProgressSyncPlan?.conflicts[0]).toMatchObject({
      id: "reading-progress-conflict:source-a",
      local: { readPage: 9, readOffset: 900 },
      remote: { readPage: 4, readOffset: 400 },
    });
    vi.mocked(io.saveCloud).mockClear();
    vi.mocked(io.saveLocal).mockClear();

    await coordinator.resolveReadingProgressConflicts(
      [{ conflictId: "reading-progress-conflict:source-a", choice: "remote" }],
      conflict.token,
    );

    expect(coordinator.getSnapshot()).toMatchObject({
      status: "cloud",
      recovery: null,
      readingProgressSyncPlan: null,
      data: {
        sources: [
          {
            readPage: 4,
            readOffset: 400,
            lastReadAt: "2026-09-13T10:00:00.000Z",
            readingPositionAlternatives: [
              {
                origin: "local",
                readPage: 9,
                readOffset: 900,
                lastReadAt: "2026-09-13T11:00:00.000Z",
              },
            ],
          },
        ],
      },
    });
    expect(vi.mocked(io.saveCloud)).toHaveBeenCalledOnce();
    expect(vi.mocked(io.saveCloud).mock.calls[0]?.[1]).toBe(2);
    expect(vi.mocked(io.saveLocal).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(io.saveCloud).mock.invocationCallOrder[0]!,
    );
    expect(remote.get(accountA.id)).toMatchObject({
      revision: 3,
      data: {
        sources: [
          {
            readPage: 4,
            readOffset: 400,
            lastReadAt: "2026-09-13T10:00:00.000Z",
            readingPositionAlternatives: [
              {
                origin: "local",
                readPage: 9,
                readOffset: 900,
                lastReadAt: "2026-09-13T11:00:00.000Z",
              },
            ],
          },
        ],
      },
    });
  });

  it("persists an explicit local choice before saving it against the reviewed revision", async () => {
    const { coordinator, io, remote } = await createReadingConflict();
    const conflict = coordinator.getSnapshot();
    vi.mocked(io.saveCloud).mockClear();
    vi.mocked(io.saveLocal).mockClear();

    await coordinator.resolveReadingProgressConflicts(
      [{ conflictId: "reading-progress-conflict:source-a", choice: "local" }],
      conflict.token,
    );
    await status(coordinator, "cloud");

    expect(vi.mocked(io.saveCloud)).toHaveBeenCalledOnce();
    expect(vi.mocked(io.saveCloud).mock.calls[0]?.[1]).toBe(2);
    expect(vi.mocked(io.saveLocal).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(io.saveCloud).mock.invocationCallOrder[0]!,
    );
    expect(remote.get(accountA.id)).toMatchObject({
      revision: 3,
      data: {
        sources: [
          {
            readPage: 9,
            readOffset: 900,
            lastReadAt: "2026-09-13T11:00:00.000Z",
          },
        ],
      },
    });
  });

  it("atomically resolves mixed choices and a safe local move in one durable cloud write", async () => {
    const { coordinator, io, remote } = setup();
    const sourceB = (patch: Partial<Source> = {}) =>
      readingSource({
        id: "source-b",
        versionId: "source-b-version",
        title: "第二份资料",
        filename: "reading-b.txt",
        hash: "reading-b-hash",
        ...patch,
      });
    const sourceC = (patch: Partial<Source> = {}) =>
      readingSource({
        id: "source-c",
        versionId: "source-c-version",
        title: "第三份资料",
        filename: "reading-c.txt",
        hash: "reading-c-hash",
        ...patch,
      });
    const base: WorkspaceData = {
      ...data("base"),
      sources: [
        readingSource({
          readPage: 1,
          readOffset: 10,
          lastReadAt: "2026-09-13T08:00:00.000Z",
        }),
        sourceB({
          readPage: 2,
          readOffset: 20,
          lastReadAt: "2026-09-13T08:00:00.000Z",
        }),
        sourceC({
          readPage: 3,
          readOffset: 30,
          lastReadAt: "2026-09-13T08:00:00.000Z",
        }),
      ],
    };
    remote.set(accountA.id, { data: base, revision: 1 });
    await coordinator.activate(accountA);
    remote.set(accountA.id, {
      data: {
        ...data("base"),
        sources: [
          readingSource({
            readPage: 4,
            readOffset: 400,
            lastReadAt: "2026-09-13T09:00:00.000Z",
          }),
          sourceB({
            readPage: 5,
            readOffset: 500,
            lastReadAt: "2026-09-13T09:00:00.000Z",
          }),
          sourceC({
            readPage: 3,
            readOffset: 30,
            lastReadAt: "2026-09-13T08:00:00.000Z",
          }),
        ],
      },
      revision: 2,
    });
    coordinator.update(
      (current) => ({
        ...current,
        sources: current.sources.map((source) => {
          if (source.id === "source-a")
            return {
              ...source,
              readPage: 9,
              readOffset: 900,
              lastReadAt: "2026-09-13T10:00:00.000Z",
            };
          if (source.id === "source-b")
            return {
              ...source,
              readPage: 10,
              readOffset: 1_000,
              lastReadAt: "2026-09-13T10:00:00.000Z",
            };
          return {
            ...source,
            readPage: 11,
            readOffset: 1_100,
            lastReadAt: "2026-09-13T10:00:00.000Z",
          };
        }),
      }),
      coordinator.getSnapshot().token,
    );
    await status(coordinator, "conflict");

    const conflict = coordinator.getSnapshot();
    expect(conflict.readingProgressSyncPlan?.conflicts.map((item) => item.sourceId)).toEqual([
      "source-a",
      "source-b",
    ]);
    expect(conflict.readingProgressSyncPlan?.safeLocal).toEqual([
      expect.objectContaining({
        sourceId: "source-c",
        local: expect.objectContaining({ readPage: 11, readOffset: 1_100 }),
        remote: expect.objectContaining({ readPage: 3, readOffset: 30 }),
      }),
    ]);
    vi.mocked(io.saveCloud).mockClear();
    vi.mocked(io.saveLocal).mockClear();

    await coordinator.resolveReadingProgressConflicts(
      [
        { conflictId: "reading-progress-conflict:source-a", choice: "remote" },
        { conflictId: "reading-progress-conflict:source-b", choice: "local" },
      ],
      conflict.token,
    );

    expect(vi.mocked(io.saveCloud)).toHaveBeenCalledOnce();
    expect(vi.mocked(io.saveCloud).mock.calls[0]?.slice(1)).toEqual([2, accountA.id]);
    expect(vi.mocked(io.saveLocal)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(io.saveLocal).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(io.saveCloud).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(io.saveCloud).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(io.saveLocal).mock.invocationCallOrder[1]!,
    );
    const firstLocalSnapshot = vi.mocked(io.saveLocal).mock.calls[0]?.[0] as Stored;
    const { _conuoSync, ...firstLocalData } = firstLocalSnapshot;
    const cloudPayload = vi.mocked(io.saveCloud).mock.calls[0]?.[0];
    expect(_conuoSync).toMatchObject({ revision: 2, dirty: true });
    expect(firstLocalData).toEqual(cloudPayload);
    expect(cloudPayload?.sources).toEqual([
      expect.objectContaining({
        id: "source-a",
        readPage: 4,
        readOffset: 400,
        lastReadAt: "2026-09-13T09:00:00.000Z",
        readingPositionAlternatives: [
          {
            origin: "local",
            readPage: 9,
            readOffset: 900,
            lastReadAt: "2026-09-13T10:00:00.000Z",
          },
        ],
      }),
      expect.objectContaining({
        id: "source-b",
        readPage: 10,
        readOffset: 1_000,
        lastReadAt: "2026-09-13T10:00:00.000Z",
        readingPositionAlternatives: [
          {
            origin: "remote",
            readPage: 5,
            readOffset: 500,
            lastReadAt: "2026-09-13T09:00:00.000Z",
          },
        ],
      }),
      expect.objectContaining({
        id: "source-c",
        readPage: 11,
        readOffset: 1_100,
        lastReadAt: "2026-09-13T10:00:00.000Z",
      }),
    ]);
    expect(cloudPayload?.sources[2]).not.toHaveProperty("readingPositionAlternatives");
    expect(remote.get(accountA.id)).toEqual({ data: cloudPayload, revision: 3 });
    expect(coordinator.getSnapshot()).toMatchObject({
      status: "cloud",
      recovery: null,
      readingProgressSyncPlan: null,
      data: cloudPayload,
    });
  });

  it("refreshes both candidates and performs no PUT when cloud changed after review", async () => {
    const { coordinator, io, remote } = await createReadingConflict();
    const conflict = coordinator.getSnapshot();
    remote.set(accountA.id, {
      data: workspaceWithReadingSource({
        readPage: 6,
        readOffset: 600,
        lastReadAt: "2026-09-13T12:00:00.000Z",
      }),
      revision: 3,
    });
    vi.mocked(io.saveCloud).mockClear();

    await expect(
      coordinator.resolveReadingProgressConflicts(
        [{ conflictId: "reading-progress-conflict:source-a", choice: "local" }],
        conflict.token,
      ),
    ).rejects.toThrow("云端版本已再次变化");

    expect(io.saveCloud).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot()).toMatchObject({
      status: "conflict",
      recoveryRevision: 3,
      recovery: { sources: [{ readPage: 6, readOffset: 600 }] },
      data: { sources: [{ readPage: 9, readOffset: 900 }] },
    });
    expect(coordinator.getSnapshot().readingProgressSyncPlan?.conflicts[0].remote).toMatchObject({
      readPage: 6,
      readOffset: 600,
    });
  });

  it("keeps both reviewed positions visible and skips PUT when IndexedDB rejects the choice", async () => {
    const { coordinator, io } = await createReadingConflict();
    const conflict = coordinator.getSnapshot();
    vi.mocked(io.saveCloud).mockClear();
    vi.mocked(io.saveLocal).mockRejectedValueOnce(new Error("IndexedDB unavailable"));

    await expect(
      coordinator.resolveReadingProgressConflicts(
        [{ conflictId: "reading-progress-conflict:source-a", choice: "remote" }],
        conflict.token,
      ),
    ).rejects.toThrow("尚未保存在此浏览器");

    expect(io.saveCloud).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot()).toMatchObject({
      status: "conflict",
      data: { sources: [{ readPage: 9, readOffset: 900 }] },
      recovery: { sources: [{ readPage: 4, readOffset: 400 }] },
    });
    expect(coordinator.getSnapshot().readingProgressSyncPlan?.conflicts).toHaveLength(1);
  });

  it("fences delayed reader callbacks while a reviewed choice is being saved", async () => {
    const { coordinator, io, remote } = await createReadingConflict();
    const conflict = coordinator.getSnapshot();
    const preflight = deferred<{ data: WorkspaceData | null; revision: number }>();
    vi.mocked(io.loadCloud).mockReturnValueOnce(preflight.promise);

    const resolving = coordinator.resolveReadingProgressConflicts(
      [{ conflictId: "reading-progress-conflict:source-a", choice: "remote" }],
      conflict.token,
    );
    await vi.waitFor(() => expect(io.loadCloud).toHaveBeenCalled());
    const accepted = coordinator.update(
      (current) => ({
        ...current,
        sources: current.sources.map((source) => ({
          ...source,
          readPage: 10,
          readOffset: 1_000,
          lastReadAt: "2026-09-13T12:00:00.000Z",
        })),
      }),
      conflict.token,
    );

    expect(accepted).toBe(false);
    expect(coordinator.getSnapshot().data.sources[0].readPage).toBe(9);
    preflight.resolve(structuredClone(remote.get(accountA.id)!));
    await resolving;
    expect(coordinator.getSnapshot().data.sources[0]).toMatchObject({
      readPage: 4,
      readOffset: 400,
      lastReadAt: "2026-09-13T10:00:00.000Z",
    });
  });

  it("reopens conflict when cloud changes between the preflight GET and resolved PUT", async () => {
    const { coordinator, io, remote } = await createReadingConflict();
    const conflict = coordinator.getSnapshot();
    vi.mocked(io.saveCloud).mockClear();
    vi.mocked(io.saveCloud).mockImplementationOnce(async (_snapshot, _revision, id) => {
      remote.set(id, {
        data: workspaceWithReadingSource({
          readPage: 6,
          readOffset: 600,
          lastReadAt: "2026-09-13T12:00:00.000Z",
        }),
        revision: 3,
      });
      throw Object.assign(new Error("409 conflict"), { status: 409 });
    });

    await expect(
      coordinator.resolveReadingProgressConflicts(
        [{ conflictId: "reading-progress-conflict:source-a", choice: "local" }],
        conflict.token,
      ),
    ).rejects.toThrow("保存期间云端版本再次变化");

    expect(coordinator.getSnapshot()).toMatchObject({
      status: "conflict",
      recoveryRevision: 3,
      data: { sources: [{ readPage: 9, readOffset: 900 }] },
      recovery: { sources: [{ readPage: 6, readOffset: 600 }] },
    });
    expect(coordinator.getSnapshot().readingProgressSyncPlan?.conflicts).toHaveLength(1);
  });

  it("does not report success after the account changes during preflight", async () => {
    const { coordinator, io, remote } = await createReadingConflict();
    const conflict = coordinator.getSnapshot();
    const preflight = deferred<{ data: WorkspaceData | null; revision: number }>();
    vi.mocked(io.loadCloud).mockReturnValueOnce(preflight.promise);
    remote.set(accountB.id, { data: data("account B"), revision: 7 });

    const resolving = coordinator.resolveReadingProgressConflicts(
      [{ conflictId: "reading-progress-conflict:source-a", choice: "remote" }],
      conflict.token,
    );
    await vi.waitFor(() => expect(io.loadCloud).toHaveBeenCalled());
    await coordinator.activate(accountB);
    preflight.resolve(structuredClone(remote.get(accountA.id)!));

    await expect(resolving).rejects.toThrow("当前账号已改变");
    expect(coordinator.getSnapshot()).toMatchObject({
      user: accountB,
      status: "cloud",
      data: { spaces: [{ name: "account B" }] },
    });
  });
});

describe("durable local file imports", () => {
  it("rejects a stale ordinary save without overwriting another tab", async () => {
    const { coordinator, io, disk, blobs } = setup();
    disk.set("local", data("original"));
    attachAtomicLocalImports(io, disk, blobs);
    await coordinator.activate(null);

    disk.set("local", {
      ...data("另一标签页已经保存"),
      _conuoLocalRevision: 1,
    });
    rename(coordinator, "当前页的陈旧修改");

    await status(coordinator, "error");
    expect(disk.get("local")?.spaces[0].name).toBe("另一标签页已经保存");
    expect(coordinator.getSnapshot()).toMatchObject({
      data: { spaces: [{ name: "当前页的陈旧修改" }] },
      error: expect.stringContaining("另一个标签页已更新本机工作区"),
    });
  });

  it("adopts an atomic account import and marks the exact clean cloud baseline dirty", async () => {
    const parse = deferred<Source>();
    const pipeline = importPipeline(vi.fn(async () => parse.promise));
    const { coordinator, io, disk, remote, blobs } = setup(pipeline);
    const initial = data("atomic account");
    disk.set(accountA.id, {
      ...structuredClone(initial),
      _conuoSync: { revision: 7, dirty: false },
    });
    remote.set(accountA.id, { data: structuredClone(initial), revision: 7 });
    attachAtomicLocalImports(io, disk, blobs);
    const cloudWrite = deferred<{ revision: number }>();
    vi.mocked(io.saveCloud).mockReturnValueOnce(cloudWrite.promise);

    await coordinator.activate(accountA);
    const result = await coordinator.importFile(
      new File(["原子发布。"], "atomic.txt"),
      "base",
      coordinator.getSnapshot().token,
    );

    expect(result.kind).toBe("queued");
    const saved = disk.get(accountA.id)!;
    expect(saved.sources).toHaveLength(1);
    expect(saved.importJobs).toHaveLength(1);
    expect(saved._conuoSync).toEqual({
      revision: 7,
      dirty: true,
      baseRevision: 7,
      base: initial,
    });
    expect(coordinator.getSnapshot()).toMatchObject({
      data: { sources: [{ filename: "atomic.txt", status: "parsing" }] },
      signOutState: { kind: "syncing" },
    });
    expect(blobs).toHaveLength(1);
    expect(io.putBlobIfAbsent).not.toHaveBeenCalled();
  });

  it("keeps clean sync metadata unchanged for a duplicate already in the requested library", async () => {
    const { coordinator, io, disk, remote, blobs } = setup();
    const retained = await prepareImportFile(new File(["相同资料。"], "retained.txt"), "base");
    const initial = { ...data("duplicate account"), sources: [retained] };
    disk.set(accountA.id, {
      ...structuredClone(initial),
      _conuoSync: { revision: 4, dirty: false },
    });
    remote.set(accountA.id, { data: structuredClone(initial), revision: 4 });
    attachAtomicLocalImports(io, disk, blobs);

    await coordinator.activate(accountA);
    vi.mocked(io.saveCloud).mockClear();
    const result = await coordinator.importFile(
      new File(["相同资料。"], "same.txt"),
      "base",
      coordinator.getSnapshot().token,
    );

    expect(result).toMatchObject({ kind: "duplicate", source: { id: retained.id } });
    expect(disk.get(accountA.id)?._conuoSync).toEqual({ revision: 4, dirty: false });
    expect(coordinator.getSnapshot().signOutState.kind).toBe("ready");
    expect(io.saveCloud).not.toHaveBeenCalled();
    expect(blobs).toHaveLength(0);
  });

  it("replays an edit made while the atomic transaction waits and persists both results", async () => {
    const parse = deferred<Source>();
    const entered = deferred<void>();
    const release = deferred<void>();
    const { coordinator, io, disk, blobs } = setup(
      importPipeline(vi.fn(async () => parse.promise)),
    );
    disk.set("local", data("before transaction"));
    attachAtomicLocalImports(io, disk, blobs, async () => {
      entered.resolve();
      await release.promise;
    });
    await coordinator.activate(null);

    const importing = coordinator.importFile(
      new File(["并发编辑仍应保留。"], "concurrent-edit.txt"),
      "base",
      coordinator.getSnapshot().token,
    );
    await entered.promise;
    rename(coordinator, "edited while importing");
    release.resolve();
    await expect(importing).resolves.toMatchObject({ kind: "queued" });

    expect(coordinator.getSnapshot().data).toMatchObject({
      spaces: [{ name: "edited while importing" }],
      sources: [{ filename: "concurrent-edit.txt" }],
      importJobs: [{ status: "running", stage: "parsing", originalSaved: true }],
    });
    expect(disk.get("local")).toMatchObject({
      spaces: [{ name: "edited while importing" }],
      sources: [{ filename: "concurrent-edit.txt" }],
      importJobs: [{ status: "running", stage: "parsing", originalSaved: true }],
    });
    expect(vi.mocked(io.saveLocal).mock.calls.length).toBeGreaterThan(0);
    expect(
      vi
        .mocked(io.saveLocal)
        .mock.calls.every(([snapshot]) =>
          snapshot.sources.some((source) => source.filename === "concurrent-edit.txt"),
        ),
    ).toBe(true);
    expect(coordinator.getSnapshot().signOutState.kind).toBe("ready");
    expect(blobs).toHaveLength(1);
  });

  it("three-way merges an independent change already committed by another tab", async () => {
    const parse = deferred<Source>();
    const entered = deferred<void>();
    const release = deferred<void>();
    const { coordinator, io, disk, blobs } = setup(
      importPipeline(vi.fn(async () => parse.promise)),
    );
    disk.set("local", data("before transaction"));
    attachAtomicLocalImports(io, disk, blobs, async () => {
      entered.resolve();
      await release.promise;
    });
    await coordinator.activate(null);

    const importing = coordinator.importFile(
      new File(["两个标签页的独立修改都要保留。"], "cross-tab-merge.txt"),
      "base",
      coordinator.getSnapshot().token,
    );
    await entered.promise;
    const fromOtherTab = disk.get("local")!;
    disk.set("local", {
      ...structuredClone(fromOtherTab),
      notes: [note("另一标签页新增的笔记")],
      _conuoLocalRevision: (fromOtherTab._conuoLocalRevision ?? 0) + 1,
    });
    rename(coordinator, "本页同时改名");
    release.resolve();
    await expect(importing).resolves.toMatchObject({ kind: "queued" });

    expect(disk.get("local")).toMatchObject({
      spaces: [{ name: "本页同时改名" }],
      notes: [{ content: "另一标签页新增的笔记" }],
      sources: [{ filename: "cross-tab-merge.txt" }],
    });
    expect(blobs).toHaveLength(1);
  });

  it("keeps the committed import and reports a true two-sided workspace conflict", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const { coordinator, io, disk, blobs } = setup();
    disk.set("local", data("before transaction"));
    attachAtomicLocalImports(io, disk, blobs, async () => {
      entered.resolve();
      await release.promise;
    });
    await coordinator.activate(null);

    const importing = coordinator.importFile(
      new File(["冲突时原件和导入任务仍应安全落盘。"], "cross-tab-conflict.txt"),
      "base",
      coordinator.getSnapshot().token,
    );
    await entered.promise;
    const fromOtherTab = disk.get("local")!;
    disk.set("local", {
      ...data("另一标签页改名"),
      _conuoLocalRevision: (fromOtherTab._conuoLocalRevision ?? 0) + 1,
    });
    rename(coordinator, "本页也改名");
    release.resolve();

    await expect(importing).rejects.toThrow("导入任务已保留在本机");
    await status(coordinator, "error");
    expect(disk.get("local")).toMatchObject({
      spaces: [{ name: "另一标签页改名" }],
      sources: [{ filename: "cross-tab-conflict.txt" }],
      importJobs: [{ status: "running", stage: "parsing", originalSaved: true }],
    });
    expect(blobs).toHaveLength(1);
  });

  it("keeps a committed import with its original account when the active account changes", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const { coordinator, io, disk, remote, blobs } = setup();
    const accountAWorkspace = data("account A");
    const accountBWorkspace = data("account B");
    disk.set(accountA.id, {
      ...structuredClone(accountAWorkspace),
      _conuoSync: { revision: 2, dirty: false },
    });
    disk.set(accountB.id, {
      ...structuredClone(accountBWorkspace),
      _conuoSync: { revision: 5, dirty: false },
    });
    remote.set(accountA.id, { data: structuredClone(accountAWorkspace), revision: 2 });
    remote.set(accountB.id, { data: structuredClone(accountBWorkspace), revision: 5 });
    attachAtomicLocalImports(io, disk, blobs, async () => {
      entered.resolve();
      await release.promise;
    });
    await coordinator.activate(accountA);

    const importing = coordinator.importFile(
      new File(["只属于账号 A。"], "account-a.txt"),
      "base",
      coordinator.getSnapshot().token,
    );
    await entered.promise;
    await coordinator.activate(accountB);
    release.resolve();

    await expect(importing).rejects.toThrow("保留在原账号");
    expect(disk.get(accountA.id)?.sources).toMatchObject([{ filename: "account-a.txt" }]);
    expect(coordinator.getSnapshot()).toMatchObject({
      user: accountB,
      data: { spaces: [{ name: "account B" }], sources: [] },
    });
    expect(disk.get(accountB.id)?.sources).toEqual([]);
  });

  it("repairs a clean cloud-ack snapshot queued while the atomic import is waiting", async () => {
    const parse = deferred<Source>();
    const entered = deferred<void>();
    const releaseImport = deferred<void>();
    const releaseCloud = deferred<void>();
    const { coordinator, io, disk, remote, blobs } = setup(
      importPipeline(vi.fn(async () => parse.promise)),
    );
    const initial = data("before cloud edit");
    disk.set(accountA.id, {
      ...structuredClone(initial),
      _conuoSync: { revision: 1, dirty: false },
    });
    remote.set(accountA.id, { data: structuredClone(initial), revision: 1 });
    attachAtomicLocalImports(io, disk, blobs, async () => {
      entered.resolve();
      await releaseImport.promise;
    });
    vi.mocked(io.saveCloud).mockImplementationOnce(async (snapshot, revision, id) => {
      await releaseCloud.promise;
      remote.set(id, { data: structuredClone(snapshot), revision: revision + 1 });
      return { revision: revision + 1 };
    });
    await coordinator.activate(accountA);
    rename(coordinator, "cloud edit acknowledged");
    await vi.waitFor(() => expect(io.saveCloud).toHaveBeenCalledOnce());

    const importing = coordinator.importFile(
      new File(["不得被云端确认后的旧保存覆盖。"], "cloud-ack-race.txt"),
      "base",
      coordinator.getSnapshot().token,
    );
    await entered.promise;
    releaseCloud.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseImport.resolve();
    await expect(importing).resolves.toMatchObject({ kind: "queued" });

    expect(disk.get(accountA.id)).toMatchObject({
      spaces: [{ name: "cloud edit acknowledged" }],
      sources: [{ filename: "cloud-ack-race.txt" }],
      _conuoSync: {
        revision: 2,
        dirty: true,
        baseRevision: 2,
        base: { spaces: [{ name: "cloud edit acknowledged" }], sources: [] },
      },
    });
    expect(coordinator.getSnapshot().data.sources).toMatchObject([
      { filename: "cloud-ack-race.txt" },
    ]);
    expect(blobs).toHaveLength(1);
  });

  it("keeps an over-cap parsed import locally and retries it after capacity is freed", async () => {
    const parse = deferred<Source>();
    const pipeline = importPipeline(vi.fn(async () => parse.promise));
    const { coordinator, io, disk, remote, blobs } = setup(pipeline);
    const base = workspaceWithNote("base", "");
    const baseBytes = new TextEncoder().encode(JSON.stringify(base)).byteLength;
    base.notes[0].content = "x".repeat(MAX_WORKSPACE_BYTES - baseBytes - 80_000);
    remote.set(accountA.id, { data: base, revision: 1 });

    await coordinator.activate(accountA);
    await status(coordinator, "cloud");
    const token = coordinator.getSnapshot().token;
    const result = await coordinator.importFile(
      new File(["small original"], "over-cloud-cap.txt"),
      "base",
      token,
    );
    if (result.kind !== "queued") throw new Error("expected queued import");
    await vi.waitFor(() => expect(pipeline.parse).toHaveBeenCalledOnce());
    await status(coordinator, "cloud");
    vi.mocked(io.saveCloud).mockClear();
    vi.mocked(io.uploadBlob).mockClear();

    const [prepared] = vi.mocked(pipeline.parse).mock.calls[0] ?? [];
    if (!prepared) throw new Error("expected parser input");
    parse.resolve(parsedImport(prepared, "parsed content ".repeat(8_000)));

    await status(coordinator, "error");
    const blocked = coordinator.getSnapshot();
    const localSource = blocked.data.sources.find((source) => source.id === result.job.sourceId);
    expect(blocked.error).toContain("3 MiB");
    expect(blocked.signOutState).toMatchObject({ kind: "unsynced", canSync: true });
    expect(localSource).toMatchObject({ status: "ready", text: expect.stringContaining("parsed") });
    expect(localSource?.blobKey && blobs.has(localSource.blobKey)).toBe(true);
    expect(io.saveCloud).not.toHaveBeenCalled();
    expect(io.uploadBlob).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(disk.get(accountA.id)).toMatchObject({
        _conuoSync: { dirty: true },
        sources: [expect.objectContaining({ id: result.job.sourceId, status: "ready" })],
      }),
    );

    coordinator.update(
      (current) => ({
        ...current,
        notes: current.notes.map((item) => ({ ...item, content: "retained local note" })),
      }),
      token,
    );
    await vi.waitFor(async () => {
      await coordinator.retry(token);
      expect(coordinator.getSnapshot().status).toBe("cloud");
    });
    expect(remote.get(accountA.id)?.data?.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: result.job.sourceId, status: "ready" }),
      ]),
    );
  });

  it("persists a source and resumable parsing job before parser completion", async () => {
    const parse = deferred<Source>();
    const pipeline = importPipeline(vi.fn(async () => parse.promise));
    const { coordinator, disk, blobs, io } = setup(pipeline);
    await coordinator.activate(null);
    const result = await coordinator.importFile(
      new File(["学习率决定更新步长。"], "learning.txt"),
      "",
      coordinator.getSnapshot().token,
    );
    expect(result.kind).toBe("queued");
    if (result.kind !== "queued") throw new Error("expected queued import");
    await vi.waitFor(() => expect(pipeline.parse).toHaveBeenCalledOnce());
    const source = coordinator
      .getSnapshot()
      .data.sources.find((item) => item.id === result.job.sourceId);
    expect(source).toMatchObject({
      id: result.job.sourceId,
      versionId: result.job.versionId,
      status: "parsing",
      aiAllowed: false,
    });
    expect(source?.blobKey && blobs.has(source.blobKey)).toBe(true);
    expect(disk.get("local")?.sources.some((item) => item.id === result.job.sourceId)).toBe(true);
    expect(disk.get("local")?.importJobs?.[0]).toMatchObject({
      id: result.job.id,
      sourceId: result.job.sourceId,
      originalSaved: true,
    });

    const stored = disk.get("local")?.sources.find((item) => item.id === result.job.sourceId);
    if (!stored) throw new Error("expected stored import source");
    stored.coverage = {
      captureScope: "full",
      parseState: "pending",
      unavailablePageRanges: [{ start: 1, end: 2 }],
    };

    const continueParse = deferred<void>();
    const resumedParse = vi.fn(async (input: Source) => {
      await continueParse.promise;
      return parsedImport(input);
    });
    const resumed = new WorkspaceCoordinator(io, importPipeline(resumedParse));
    await resumed.activate(null);
    await vi.waitFor(() => expect(resumedParse).toHaveBeenCalledOnce());
    expect(
      resumed.getSnapshot().data.sources.find((item) => item.id === result.job.sourceId)?.coverage,
    ).toEqual({ captureScope: "full", parseState: "pending" });
    continueParse.resolve();
    await vi.waitFor(() => {
      expect(
        resumed.getSnapshot().data.sources.find((item) => item.id === result.job.sourceId)?.status,
      ).toBe("ready");
    });
    expect(
      resumed.getSnapshot().data.sources.find((item) => item.id === result.job.sourceId)?.aiAllowed,
    ).toBe(false);
  });

  it("requires an import opt-in and never lets a duplicate expand an existing permission", async () => {
    const pipeline = importPipeline(vi.fn(async (source: Source) => parsedImport(source)));
    const { coordinator } = setup(pipeline);
    await coordinator.activate(null);
    const token = coordinator.getSnapshot().token;
    const first = await coordinator.importFile(
      new File(["相同资料"], "same.txt"),
      "",
      token,
      false,
      false,
    );
    if (first.kind !== "queued") throw new Error("expected queued import");
    const duplicate = await coordinator.importFile(
      new File(["相同资料"], "same.txt"),
      "",
      token,
      false,
      true,
    );
    expect(duplicate.kind).toBe("duplicate");
    expect(
      coordinator.getSnapshot().data.sources.find((source) => source.id === first.job.sourceId)
        ?.aiAllowed,
    ).toBe(false);

    const optedIn = await coordinator.importFile(
      new File(["另一份资料"], "allowed.txt"),
      "",
      token,
      false,
      true,
    );
    if (optedIn.kind !== "queued") throw new Error("expected queued import");
    expect(
      coordinator.getSnapshot().data.sources.find((source) => source.id === optedIn.job.sourceId)
        ?.aiAllowed,
    ).toBe(true);
  });

  it("downloads the exact cloud original when a resumed device has no local blob", async () => {
    const prepared = await prepareImportFile(
      new File(["跨设备恢复也应继续解析这份原件。"], "cloud-resume.txt"),
      "",
    );
    const now = "2026-09-13T12:00:00.000Z";
    const job = advanceImportJob(
      startImportJob(
        createImportJob({
          sourceId: prepared.id,
          versionId: prepared.versionId,
          filename: prepared.filename,
          spaceId: "",
          at: now,
        }),
        now,
      ),
      "parsing",
      now,
    );
    const parsed = vi.fn(async (source: Source) => parsedImport(source, "来自云端的原件。"));
    const { coordinator, io, remote } = setup(importPipeline(parsed));
    remote.set(accountA.id, {
      data: {
        ...data("cloud-space"),
        sources: [
          {
            ...prepared,
            status: "parsing",
            storagePath: `${accountA.id}/originals/${prepared.id}/${prepared.versionId}`,
          },
        ],
        importJobs: [job],
      },
      revision: 1,
    });
    vi.mocked(io.downloadBlob).mockResolvedValue(
      new File(["跨设备恢复也应继续解析这份原件。"], "cloud-resume.txt"),
    );

    await coordinator.activate(accountA);
    await vi.waitFor(() => expect(parsed).toHaveBeenCalledOnce());
    expect(io.downloadBlob).toHaveBeenCalledWith(
      expect.objectContaining({ id: prepared.id, versionId: prepared.versionId }),
      accountA.id,
    );
    await vi.waitFor(() => {
      expect(
        coordinator.getSnapshot().data.importJobs?.find((item) => item.id === job.id)?.status,
      ).toBe("completed");
    });
  });

  it("claims a cloud import before downloading or parsing, then writes its terminal result through the fence", async () => {
    const prepared = await prepareImportFile(
      new File(["租约只能让一个设备解析这份原件。"], "leased-cloud-resume.txt"),
      "",
    );
    const now = "2026-09-13T12:00:00.000Z";
    const job = advanceImportJob(
      startImportJob(
        createImportJob({
          sourceId: prepared.id,
          versionId: prepared.versionId,
          filename: prepared.filename,
          spaceId: "",
          at: now,
        }),
        now,
      ),
      "parsing",
      now,
    );
    const order: string[] = [];
    const parsed = vi.fn(async (source: Source) => {
      order.push("parse");
      return parsedImport(source, "只由租约持有者写回的正文。");
    });
    const { coordinator, io, remote } = setup(importPipeline(parsed));
    remote.set(accountA.id, {
      data: {
        ...data("cloud-space"),
        sources: [
          {
            ...prepared,
            status: "parsing",
            storagePath: `${accountA.id}/originals/${prepared.id}/${prepared.versionId}`,
          },
        ],
        importJobs: [job],
      },
      revision: 1,
    });
    attachImportLeases(io, remote);
    const claim = io.claimImportParse!;
    const finish = io.finishImportParse!;
    io.claimImportParse = vi.fn(async (sourceId, versionId, ownerId) => {
      order.push("claim");
      return claim(sourceId, versionId, ownerId);
    });
    io.downloadBlob = vi.fn(async () => {
      order.push("download");
      return new File(["租约只能让一个设备解析这份原件。"], "leased-cloud-resume.txt");
    });
    io.finishImportParse = vi.fn(
      async (next, expectedRevision, sourceId, versionId, leaseToken, ownerId) => {
        order.push("finish");
        return finish(next, expectedRevision, sourceId, versionId, leaseToken, ownerId);
      },
    );

    await coordinator.activate(accountA);

    await vi.waitFor(() => {
      expect(
        coordinator.getSnapshot().data.importJobs?.find((item) => item.id === job.id)?.status,
      ).toBe("completed");
    });
    expect(order).toEqual(["claim", "download", "parse", "finish"]);
    expect(io.saveCloud).not.toHaveBeenCalled();
    expect(io.finishImportParse).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [expect.objectContaining({ id: prepared.id, status: "ready" })],
        importJobs: [
          expect.objectContaining({ id: job.id, status: "completed", stage: "indexing" }),
        ],
      }),
      1,
      prepared.id,
      prepared.versionId,
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      accountA.id,
    );
  });

  it("leaves a remote-held import unparsed until its owner releases or expires", async () => {
    const prepared = await prepareImportFile(new File(["等待另一台设备。"], "held.txt"), "");
    const now = "2026-09-13T12:00:00.000Z";
    const job = advanceImportJob(
      startImportJob(
        createImportJob({
          sourceId: prepared.id,
          versionId: prepared.versionId,
          filename: prepared.filename,
          spaceId: "",
          at: now,
        }),
        now,
      ),
      "parsing",
      now,
    );
    const parse = vi.fn(async (source: Source) => parsedImport(source));
    const { coordinator, io, remote } = setup(importPipeline(parse));
    remote.set(accountA.id, {
      data: {
        ...data("cloud-space"),
        sources: [
          {
            ...prepared,
            status: "parsing",
            storagePath: `${accountA.id}/originals/${prepared.id}/${prepared.versionId}`,
          },
        ],
        importJobs: [job],
      },
      revision: 1,
    });
    const lease = attachImportLeases(io, remote);
    lease.leases.set(lease.key(accountA.id, prepared.id, prepared.versionId), {
      token: "00000000-0000-4000-8000-000000000099",
      until: new Date(Date.now() + 120_000).toISOString(),
    });
    io.downloadBlob = vi.fn(async () => new File(["等待另一台设备。"], "held.txt"));

    await coordinator.activate(accountA);

    await vi.waitFor(() => expect(io.claimImportParse).toHaveBeenCalledOnce());
    expect(parse).not.toHaveBeenCalled();
    expect(io.downloadBlob).not.toHaveBeenCalled();
    expect(io.finishImportParse).not.toHaveBeenCalled();
    // Remove the local retry timer before the test exits. This ordinary
    // cancellation is not sent while this mock's other-device lease is held.
    coordinator.cancelImport(job.id, coordinator.getSnapshot().token);
  });

  it("blocks source/job edits during a held parse but permits unrelated workspace edits", async () => {
    const prepared = await prepareImportFile(
      new File(["另一台设备正在处理。"], "held-edit.txt"),
      "",
    );
    const now = "2026-09-13T12:00:00.000Z";
    const job = advanceImportJob(
      startImportJob(
        createImportJob({
          sourceId: prepared.id,
          versionId: prepared.versionId,
          filename: prepared.filename,
          spaceId: "",
          at: now,
        }),
        now,
      ),
      "parsing",
      now,
    );
    const { coordinator, io, remote } = setup(
      importPipeline(vi.fn(async (source) => parsedImport(source))),
    );
    remote.set(accountA.id, {
      data: {
        ...data("cloud-space"),
        sources: [{ ...prepared, status: "parsing", storagePath: "A/originals/held-edit" }],
        importJobs: [job],
      },
      revision: 1,
    });
    const lease = attachImportLeases(io, remote);
    lease.leases.set(lease.key(accountA.id, prepared.id, prepared.versionId), {
      token: "00000000-0000-4000-8000-000000000099",
      until: new Date(Date.now() + 120_000).toISOString(),
    });

    await coordinator.activate(accountA);
    await vi.waitFor(() => expect(io.claimImportParse).toHaveBeenCalledOnce());
    const token = coordinator.getSnapshot().token;
    const changedSource = coordinator.update(
      (workspace) => ({
        ...workspace,
        sources: workspace.sources.map((source) =>
          source.id === prepared.id ? { ...source, title: "不应被本地改写" } : source,
        ),
      }),
      token,
    );
    expect(changedSource).toBe(false);
    expect(coordinator.getSnapshot().data.sources[0]?.title).toBe(prepared.title);

    const changedSpace = coordinator.update(
      (workspace) => ({
        ...workspace,
        spaces: workspace.spaces.map((space, index) =>
          index === 0 ? { ...space, name: "允许的无关编辑" } : space,
        ),
      }),
      token,
    );
    expect(changedSpace).toBe(true);
    await vi.waitFor(() => expect(io.saveCloud).toHaveBeenCalledOnce());
    coordinator.cancelImport(job.id, token);
  });

  it("finishes a parser failure through the fenced RPC instead of a generic workspace save", async () => {
    const parse = vi.fn(async (source: Source) => ({
      ...source,
      status: "failed" as const,
      text: "",
      chunks: [],
      coverage: { captureScope: "full" as const, parseState: "failed" as const },
      error: "无法读取这份原件。",
    }));
    const { coordinator, io, remote } = setup(importPipeline(parse));
    remote.set(accountA.id, { data: data("cloud-space"), revision: 1 });
    attachImportLeases(io, remote);

    await coordinator.activate(accountA);
    const result = await coordinator.importFile(
      new File(["故意无法读取的资料。"], "failed-lease.txt"),
      "",
      coordinator.getSnapshot().token,
    );
    if (result.kind !== "queued") throw new Error("expected queued import");

    await vi.waitFor(() => {
      expect(
        coordinator.getSnapshot().data.importJobs?.find((item) => item.id === result.job.id)
          ?.status,
      ).toBe("failed");
    });
    expect(io.finishImportParse).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [expect.objectContaining({ id: result.job.sourceId, status: "failed" })],
        importJobs: [
          expect.objectContaining({ id: result.job.id, status: "failed", stage: "parsing" }),
        ],
      }),
      expect.any(Number),
      result.job.sourceId,
      result.job.versionId,
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      accountA.id,
    );
    expect(
      vi
        .mocked(io.saveCloud)
        .mock.calls.some(([snapshot]) =>
          snapshot.importJobs?.some(
            (item) => item.id === result.job.id && item.status === "failed",
          ),
        ),
    ).toBe(false);
  });

  it("keeps an unconfirmed parser result recoverable across reload and replays it through a new lease", async () => {
    const parse = vi.fn(async (source: Source) => parsedImport(source, "等待网络恢复的解析结果。"));
    const { coordinator, io, disk, remote } = setup(importPipeline(parse));
    remote.set(accountA.id, { data: data("cloud-space"), revision: 1 });
    attachImportLeases(io, remote);
    const finish = io.finishImportParse!;
    let failFirstFinish = true;
    io.finishImportParse = vi.fn(async (...args: Parameters<typeof finish>) => {
      if (failFirstFinish) {
        failFirstFinish = false;
        throw new Error("temporary network failure");
      }
      return finish(...args);
    });

    await coordinator.activate(accountA);
    const result = await coordinator.importFile(
      new File(["这份结果必须通过专用恢复路径提交。"], "recover-finish.txt"),
      "",
      coordinator.getSnapshot().token,
    );
    if (result.kind !== "queued") throw new Error("expected queued import");
    await vi.waitFor(() => expect(io.finishImportParse).toHaveBeenCalledOnce());
    await status(coordinator, "error");
    expect(
      coordinator.getSnapshot().data.importJobs?.find((item) => item.id === result.job.id)?.status,
    ).toBe("completed");
    expect(
      remote.get(accountA.id)?.data?.importJobs?.find((item) => item.id === result.job.id)?.status,
    ).toMatch(/^(queued|running)$/);

    const genericSavesBeforeReload = vi.mocked(io.saveCloud).mock.calls.length;
    const recovered = new WorkspaceCoordinator(io, importPipeline(parse));
    await recovered.activate(accountA);
    await status(recovered, "error");
    expect(
      recovered.getSnapshot().data.importJobs?.find((item) => item.id === result.job.id)?.status,
    ).toBe("completed");
    expect(vi.mocked(io.saveCloud)).toHaveBeenCalledTimes(genericSavesBeforeReload);
    expect(disk.get(accountA.id)?._conuoSync).toMatchObject({ revision: 2, dirty: true });

    await recovered.retry(recovered.getSnapshot().token);
    await vi.waitFor(() => {
      expect(
        recovered.getSnapshot().data.importJobs?.find((item) => item.id === result.job.id)?.status,
      ).toBe("completed");
      expect(remote.get(accountA.id)?.revision).toBe(3);
    });
    expect(io.finishImportParse).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(io.saveCloud)
        .mock.calls.some(([snapshot]) =>
          snapshot.importJobs?.some(
            (item) => item.id === result.job.id && item.status === "completed",
          ),
        ),
    ).toBe(false);
  });

  it("replays an unconfirmed cancellation through its owner-authorized RPC", async () => {
    const parseGate = deferred<Source>();
    const parse = vi.fn(async () => parseGate.promise);
    const { coordinator, io, remote } = setup(importPipeline(parse));
    remote.set(accountA.id, { data: data("cloud-space"), revision: 1 });
    attachImportLeases(io, remote);
    const cancel = io.cancelImportParse!;
    let failFirstCancel = true;
    io.cancelImportParse = vi.fn(async (...args: Parameters<typeof cancel>) => {
      if (failFirstCancel) {
        failFirstCancel = false;
        throw new Error("temporary cancellation network failure");
      }
      return cancel(...args);
    });

    await coordinator.activate(accountA);
    const result = await coordinator.importFile(
      new File(["取消也必须走受控恢复。"], "recover-cancel.txt"),
      "",
      coordinator.getSnapshot().token,
    );
    if (result.kind !== "queued") throw new Error("expected queued import");
    await vi.waitFor(() => expect(parse).toHaveBeenCalledOnce());

    coordinator.cancelImport(result.job.id, coordinator.getSnapshot().token);
    await vi.waitFor(() => expect(io.cancelImportParse).toHaveBeenCalledOnce());
    await status(coordinator, "error");
    expect(
      coordinator.getSnapshot().data.importJobs?.find((item) => item.id === result.job.id)?.status,
    ).toBe("cancelled");

    await coordinator.retry(coordinator.getSnapshot().token);
    await vi.waitFor(() => {
      expect(io.cancelImportParse).toHaveBeenCalledTimes(2);
      expect(
        remote.get(accountA.id)?.data?.importJobs?.find((item) => item.id === result.job.id)
          ?.status,
      ).toBe("cancelled");
    });
    expect(
      vi
        .mocked(io.saveCloud)
        .mock.calls.some(([snapshot]) =>
          snapshot.importJobs?.some(
            (item) => item.id === result.job.id && item.status === "cancelled",
          ),
        ),
    ).toBe(false);
    parseGate.resolve(
      parsedImport(
        coordinator.getSnapshot().data.sources.find((item) => item.id === result.job.sourceId)!,
      ),
    );
  });

  it("replays an unconfirmed retry before another device can claim the work", async () => {
    const secondParse = deferred<Source>();
    let parseAttempt = 0;
    const parse = vi.fn(async (source: Source) => {
      parseAttempt += 1;
      if (parseAttempt === 1)
        return {
          ...source,
          status: "failed" as const,
          text: "",
          chunks: [],
          coverage: { captureScope: "full" as const, parseState: "failed" as const },
          error: "第一次解析失败。",
        };
      return secondParse.promise;
    });
    const { coordinator, io, remote } = setup(importPipeline(parse));
    remote.set(accountA.id, { data: data("cloud-space"), revision: 1 });
    attachImportLeases(io, remote);

    await coordinator.activate(accountA);
    const result = await coordinator.importFile(
      new File(["重试状态也不能落到普通保存。"], "recover-retry.txt"),
      "",
      coordinator.getSnapshot().token,
    );
    if (result.kind !== "queued") throw new Error("expected queued import");
    await vi.waitFor(() => {
      expect(
        coordinator.getSnapshot().data.importJobs?.find((item) => item.id === result.job.id)
          ?.status,
      ).toBe("failed");
    });
    vi.mocked(io.saveCloud).mockClear();

    const retry = io.retryImportParse!;
    let failFirstRetry = true;
    io.retryImportParse = vi.fn(async (...args: Parameters<typeof retry>) => {
      if (failFirstRetry) {
        failFirstRetry = false;
        throw new Error("temporary retry network failure");
      }
      return retry(...args);
    });
    await expect(
      coordinator.retryImport(result.job.id, coordinator.getSnapshot().token),
    ).rejects.toThrow("重新解析尚未保存到云端");
    await status(coordinator, "error");
    expect(
      coordinator.getSnapshot().data.importJobs?.find((item) => item.id === result.job.id)?.status,
    ).toBe("queued");

    await coordinator.retry(coordinator.getSnapshot().token);
    await vi.waitFor(() => expect(io.retryImportParse).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(parse).toHaveBeenCalledTimes(2));
    expect(
      remote.get(accountA.id)?.data?.importJobs?.find((item) => item.id === result.job.id)?.status,
    ).toMatch(/^(queued|running)$/);
    expect(io.saveCloud).not.toHaveBeenCalled();

    coordinator.cancelImport(result.job.id, coordinator.getSnapshot().token);
    await vi.waitFor(() => {
      expect(
        coordinator.getSnapshot().data.importJobs?.find((item) => item.id === result.job.id)
          ?.status,
      ).toBe("cancelled");
    });
    secondParse.resolve(
      parsedImport(
        coordinator.getSnapshot().data.sources.find((item) => item.id === result.job.sourceId)!,
      ),
    );
  });

  it.each(["local", "cloud"] as const)(
    "rejects a %s restored failed import with positioned annotations before changing text or attempting IO",
    async (mode) => {
      const file = new File(["已提取正文仍包含人工批注。"], "retained-failed.txt");
      const prepared = await prepareImportFile(file, "");
      const source: Source = {
        ...parsedImport(prepared, "已提取正文仍包含人工批注。"),
        status: "failed",
        coverage: { captureScope: "full", parseState: "failed" },
        error: "旧解析任务中断，但已提取正文仍被保留。",
      };
      const created = createImportJob({
        sourceId: source.id,
        versionId: source.versionId,
        filename: source.filename,
        spaceId: "",
        at: source.createdAt,
      });
      const job = failImportJob(
        advanceImportJob(startImportJob(created, source.createdAt), "parsing", source.createdAt),
        source.error!,
        source.updatedAt,
      );
      const annotation = createAnnotation(
        {
          id: "retained-position-annotation",
          sourceId: source.id,
          versionId: source.versionId,
          quote: source.text,
          textAnchor: { start: 0, end: source.text.length },
          note: "保留这个版本的理解。",
          createdAt: source.updatedAt,
        },
        source,
      );
      // A schema-valid restored snapshot is a supported input, including old failed tasks
      // that retained text. Completed partial imports remain outside the retry path.
      const restored = workspaceSchema.parse({
        ...data("restored failed import"),
        sources: [source],
        importJobs: [job],
        annotations: [annotation],
      });
      const parse = vi.fn(async (input: Source) => parsedImport(input));
      const { coordinator, io, disk, remote, blobs } = setup(importPipeline(parse));
      if (mode === "cloud") {
        remote.set(accountA.id, { data: structuredClone(restored), revision: 1 });
        attachImportLeases(io, remote);
      } else disk.set("local", structuredClone(restored));
      blobs.set(source.blobKey!, file);
      await coordinator.activate(mode === "cloud" ? accountA : null);
      await status(coordinator, mode === "cloud" ? "cloud" : "local");
      const before = structuredClone(coordinator.getSnapshot().data);
      const beforeDisk = structuredClone([...disk]);
      const beforeCloud = structuredClone([...remote]);
      const saveLocal = vi.mocked(io.saveLocal).getMockImplementation()!;
      vi.mocked(io.saveLocal).mockImplementation(async (...args) => {
        const business = { ...args[0] } as Record<string, unknown>;
        delete business._conuoSync;
        delete business._conuoLocalRevision;
        if (!workspaceSchema.safeParse(business).success)
          throw new Error("本机工作区原文位置与批注不一致，未保存无效数据。");
        return saveLocal(...args);
      });
      // Preserve the real persistence boundary's schema validation rather than accepting
      // the invalid cleared-text snapshot through the otherwise permissive in-memory IO.
      vi.mocked(io.saveLocal).mockClear();
      vi.mocked(io.saveCloud).mockClear();
      vi.mocked(io.loadCloud).mockClear();
      vi.mocked(io.getBlob).mockClear();
      parse.mockClear();
      try {
        await expect(
          coordinator.retryImport(job.id, coordinator.getSnapshot().token),
        ).rejects.toThrow("已有原文位置批注");
        expect(io.saveLocal).not.toHaveBeenCalled();
        expect(io.saveCloud).not.toHaveBeenCalled();
        if (mode === "cloud") expect(io.retryImportParse).not.toHaveBeenCalled();
        expect(io.loadCloud).not.toHaveBeenCalled();
        expect(io.getBlob).not.toHaveBeenCalled();
        expect(parse).not.toHaveBeenCalled();
        expect(coordinator.getSnapshot().data).toEqual(before);
        expect([...disk]).toEqual(beforeDisk);
        expect([...remote]).toEqual(beforeCloud);
      } finally {
        coordinator.dispose();
      }
    },
  );

  it("retries a failed source through the controlled transition before claiming it again", async () => {
    let attempt = 0;
    const parse = vi.fn(async (source: Source) => {
      attempt += 1;
      if (attempt === 1)
        return {
          ...source,
          status: "failed" as const,
          text: "",
          chunks: [],
          coverage: { captureScope: "full" as const, parseState: "failed" as const },
          error: "第一次解析失败。",
        };
      return parsedImport(source, "第二次解析通过受控重试保存。");
    });
    const { coordinator, io, remote } = setup(importPipeline(parse));
    remote.set(accountA.id, { data: data("cloud-space"), revision: 1 });
    attachImportLeases(io, remote);

    await coordinator.activate(accountA);
    const result = await coordinator.importFile(
      new File(["可重新解析的原件。"], "retry-lease.txt"),
      "",
      coordinator.getSnapshot().token,
    );
    if (result.kind !== "queued") throw new Error("expected queued import");
    await vi.waitFor(() => {
      expect(
        coordinator.getSnapshot().data.importJobs?.find((item) => item.id === result.job.id)
          ?.status,
      ).toBe("failed");
    });
    vi.mocked(io.saveCloud).mockClear();

    await coordinator.retryImport(result.job.id, coordinator.getSnapshot().token);
    await vi.waitFor(() => expect(io.retryImportParse).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      expect(
        coordinator.getSnapshot().data.importJobs?.find((item) => item.id === result.job.id)
          ?.status,
      ).toBe("completed");
    });
    expect(io.retryImportParse).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [expect.objectContaining({ id: result.job.sourceId, status: "parsing" })],
        importJobs: [expect.objectContaining({ id: result.job.id, status: "queued" })],
      }),
      expect.any(Number),
      result.job.sourceId,
      result.job.versionId,
      accountA.id,
    );
    expect(io.saveCloud).not.toHaveBeenCalled();
  });

  it("cancels atomically, invalidates its lease, and discards a late parser result", async () => {
    const gate = deferred<Source>();
    const parse = vi.fn(async () => gate.promise);
    const { coordinator, io, remote } = setup(importPipeline(parse));
    remote.set(accountA.id, { data: data("cloud-space"), revision: 1 });
    attachImportLeases(io, remote);

    await coordinator.activate(accountA);
    const result = await coordinator.importFile(
      new File(["取消时不应写回迟到结果。"], "cancel-lease.txt"),
      "",
      coordinator.getSnapshot().token,
    );
    if (result.kind !== "queued") throw new Error("expected queued import");
    await vi.waitFor(() => expect(parse).toHaveBeenCalledOnce());

    coordinator.cancelImport(result.job.id, coordinator.getSnapshot().token);
    await vi.waitFor(() => expect(io.cancelImportParse).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      expect(
        coordinator.getSnapshot().data.importJobs?.find((item) => item.id === result.job.id)
          ?.status,
      ).toBe("cancelled");
    });
    expect(io.cancelImportParse).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [expect.objectContaining({ id: result.job.sourceId, status: "saved" })],
        importJobs: [expect.objectContaining({ id: result.job.id, status: "cancelled" })],
      }),
      expect.any(Number),
      result.job.sourceId,
      result.job.versionId,
      accountA.id,
    );
    expect(
      vi
        .mocked(io.saveCloud)
        .mock.calls.some(([snapshot]) =>
          snapshot.importJobs?.some(
            (item) => item.id === result.job.id && item.status === "cancelled",
          ),
        ),
    ).toBe(false);
    gate.resolve(
      parsedImport(
        coordinator.getSnapshot().data.sources.find((item) => item.id === result.job.sourceId)!,
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(io.finishImportParse).not.toHaveBeenCalled();
  });

  it("treats simultaneous identical picks as one source plus a duplicate result", async () => {
    const parse = deferred<Source>();
    const pipeline = importPipeline(vi.fn(async () => parse.promise));
    const { coordinator, blobs } = setup(pipeline);
    await coordinator.activate(null);
    const token = coordinator.getSnapshot().token;
    const [first, second] = await Promise.all([
      coordinator.importFile(new File(["同一份资料。"], "same.txt"), "", token),
      coordinator.importFile(new File(["同一份资料。"], "same.txt"), "", token),
    ]);
    const results = [first, second];
    expect(results.filter((result) => result.kind === "queued")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "duplicate")).toHaveLength(1);
    expect(coordinator.getSnapshot().data.sources).toHaveLength(1);
    expect(coordinator.getSnapshot().data.importJobs).toHaveLength(1);
    expect(blobs.size).toBe(1);
  });

  it("allows an ordinary duplicate to associate at the account cap after hashing", async () => {
    const prepare = vi.fn(prepareImportFile);
    const pipeline: ImportPipeline = {
      prepare,
      parse: vi.fn(async (source: Source) => parsedImport(source)),
    };
    const { coordinator, blobs } = setup(pipeline);
    await coordinator.activate(null);
    const token = coordinator.getSnapshot().token;
    const retained = await retainedSourceAtSize(LOCAL_IMPORT_QUOTA_POLICY.maxAccountBytes);
    coordinator.update((workspace) => ({ ...workspace, sources: [retained] }), token);

    const result = await coordinator.importFile(
      new File(["已保留的原件。"], "same-content.txt"),
      "",
      token,
    );

    expect(result).toMatchObject({ kind: "duplicate", source: { id: retained.id } });
    expect(prepare).toHaveBeenCalledOnce();
    expect(blobs).toHaveLength(0);
    expect(coordinator.getSnapshot().data.sources).toEqual([retained]);
  });

  it("rejects a new direct over-cap import after hashing but before saving its original", async () => {
    const prepare = vi.fn(prepareImportFile);
    const pipeline: ImportPipeline = {
      prepare,
      parse: vi.fn(async (source: Source) => parsedImport(source)),
    };
    const { coordinator, blobs } = setup(pipeline);
    await coordinator.activate(null);
    const token = coordinator.getSnapshot().token;
    const retained = await retainedSourceAtSize(LOCAL_IMPORT_QUOTA_POLICY.maxAccountBytes);
    coordinator.update((workspace) => ({ ...workspace, sources: [retained] }), token);

    await expect(
      coordinator.importFile(new File(["x"], "over-cap.txt"), "", token),
    ).rejects.toThrow("账号保留原件超过");

    expect(prepare).toHaveBeenCalledOnce();
    expect(blobs).toHaveLength(0);
    expect(coordinator.getSnapshot().data.sources).toEqual([retained]);
  });

  it("keeps a requested duplicate copy blocked at the account cap", async () => {
    const prepare = vi.fn(prepareImportFile);
    const pipeline: ImportPipeline = {
      prepare,
      parse: vi.fn(async (source: Source) => parsedImport(source)),
    };
    const { coordinator, blobs } = setup(pipeline);
    await coordinator.activate(null);
    const token = coordinator.getSnapshot().token;
    const retained = await retainedSourceAtSize(LOCAL_IMPORT_QUOTA_POLICY.maxAccountBytes);
    coordinator.update((workspace) => ({ ...workspace, sources: [retained] }), token);

    await expect(
      coordinator.importFile(new File(["已保留的原件。"], "independent-copy.txt"), "", token, true),
    ).rejects.toThrow("账号保留原件超过");

    expect(prepare).not.toHaveBeenCalled();
    expect(blobs).toHaveLength(0);
    expect(coordinator.getSnapshot().data.sources).toEqual([retained]);
  });

  it("serializes concurrent admissions before the cumulative account cap is exceeded", async () => {
    const prepare = vi.fn(prepareImportFile);
    const pipeline: ImportPipeline = {
      prepare,
      parse: vi.fn(async (source: Source) => parsedImport(source)),
    };
    const { coordinator, blobs } = setup(pipeline);
    await coordinator.activate(null);
    const token = coordinator.getSnapshot().token;
    const retained = await retainedSourceAtSize(LOCAL_IMPORT_QUOTA_POLICY.maxAccountBytes - 1);
    coordinator.update((workspace) => ({ ...workspace, sources: [retained] }), token);

    const [first, second] = await Promise.allSettled([
      coordinator.importFile(new File(["a"], "first.txt"), "", token),
      coordinator.importFile(new File(["b"], "second.txt"), "", token),
    ]);

    expect(first).toMatchObject({ status: "fulfilled", value: { kind: "queued" } });
    expect(second).toMatchObject({ status: "rejected", reason: expect.any(Error) });
    if (second.status === "rejected") expect(second.reason.message).toContain("账号保留原件超过");
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(blobs).toHaveLength(1);
    expect(
      coordinator.getSnapshot().data.sources.reduce((total, source) => total + source.size, 0),
    ).toBe(LOCAL_IMPORT_QUOTA_POLICY.maxAccountBytes);
  });

  it("cancels parsing without deleting its original and retries the same source/version", async () => {
    const parse = vi.fn(
      async (
        _source: Source,
        _blob: Blob,
        options?: { signal?: AbortSignal; originalSaved?: boolean },
      ) =>
        new Promise<Source>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    const { coordinator, blobs } = setup(importPipeline(parse));
    await coordinator.activate(null);
    const result = await coordinator.importFile(
      new File(["学习率决定更新步长。"], "retry.txt"),
      "",
      coordinator.getSnapshot().token,
    );
    if (result.kind !== "queued") throw new Error("expected queued import");
    await vi.waitFor(() => expect(parse).toHaveBeenCalledOnce());
    const original = coordinator
      .getSnapshot()
      .data.sources.find((item) => item.id === result.job.sourceId)!;
    coordinator.cancelImport(result.job.id, coordinator.getSnapshot().token);
    await vi.waitFor(() => {
      const job = coordinator
        .getSnapshot()
        .data.importJobs?.find((item) => item.id === result.job.id);
      expect(job?.status).toBe("cancelled");
    });
    expect(
      coordinator.getSnapshot().data.sources.find((item) => item.id === original.id)?.coverage,
    ).toEqual({ captureScope: "full", parseState: "pending" });
    expect(original.blobKey && blobs.has(original.blobKey)).toBe(true);
    coordinator.update(
      (workspace) => ({
        ...workspace,
        sources: workspace.sources.map((source) =>
          source.id === original.id
            ? {
                ...source,
                coverage: {
                  captureScope: "full",
                  parseState: "pending",
                  unavailablePageRanges: [{ start: 1, end: 3 }],
                },
              }
            : source,
        ),
      }),
      coordinator.getSnapshot().token,
    );
    await coordinator.retryImport(result.job.id, coordinator.getSnapshot().token);
    await vi.waitFor(() => expect(parse).toHaveBeenCalledTimes(2));
    expect(
      coordinator.getSnapshot().data.sources.find((item) => item.id === original.id)?.coverage,
    ).toEqual({ captureScope: "full", parseState: "pending" });
    const retried = coordinator
      .getSnapshot()
      .data.importJobs?.find((item) => item.id === result.job.id);
    expect(retried).toMatchObject({
      id: result.job.id,
      sourceId: original.id,
      versionId: original.versionId,
      status: "running",
      attempt: 2,
    });
  });

  it("stops a recycled import immediately, retains its original, and retries only after restore", async () => {
    const signals: AbortSignal[] = [];
    const parse = vi.fn(
      async (
        _source: Source,
        _blob: Blob,
        options?: { signal?: AbortSignal; originalSaved?: boolean },
      ) =>
        new Promise<Source>((_resolve, reject) => {
          if (options?.signal) {
            signals.push(options.signal);
            options.signal.addEventListener("abort", () => reject(options.signal?.reason), {
              once: true,
            });
          }
        }),
    );
    const { coordinator, blobs } = setup(importPipeline(parse));
    await coordinator.activate(null);
    const result = await coordinator.importFile(
      new File(["回收前仍在解析的原文件。"], "recycle-during-parse.txt"),
      "",
      coordinator.getSnapshot().token,
    );
    if (result.kind !== "queued") throw new Error("expected queued import");
    await vi.waitFor(() => expect(parse).toHaveBeenCalledOnce());
    const original = coordinator
      .getSnapshot()
      .data.sources.find((item) => item.id === result.job.sourceId)!;

    coordinator.update(
      (workspace) => recycleSources(workspace, [original.id], "2026-09-13T12:30:00.000Z"),
      coordinator.getSnapshot().token,
    );

    await vi.waitFor(() => {
      const job = coordinator
        .getSnapshot()
        .data.importJobs?.find((item) => item.id === result.job.id);
      expect(job?.status).toBe("cancelled");
    });
    const recycled = coordinator
      .getSnapshot()
      .data.sources.find((item) => item.id === original.id)!;
    expect(signals[0]?.aborted).toBe(true);
    expect(recycled).toMatchObject({
      deletedAt: "2026-09-13T12:30:00.000Z",
      status: "saved",
      text: "",
      blobKey: original.blobKey,
    });
    expect(recycled.storagePath).toBe(original.storagePath);
    expect(original.blobKey && blobs.has(original.blobKey)).toBe(true);
    await expect(
      coordinator.retryImport(result.job.id, coordinator.getSnapshot().token),
    ).rejects.toThrow("导入资料已不可用");
    expect(parse).toHaveBeenCalledOnce();

    coordinator.update(
      (workspace) => ({
        ...workspace,
        sources: workspace.sources.map((source) =>
          source.id === original.id ? { ...source, deletedAt: null } : source,
        ),
      }),
      coordinator.getSnapshot().token,
    );
    await coordinator.retryImport(result.job.id, coordinator.getSnapshot().token);
    await vi.waitFor(() => expect(parse).toHaveBeenCalledTimes(2));
    expect(
      coordinator.getSnapshot().data.importJobs?.find((item) => item.id === result.job.id),
    ).toMatchObject({
      id: result.job.id,
      sourceId: original.id,
      versionId: original.versionId,
      status: "running",
      attempt: 2,
    });
  });

  it("normalizes a recycled interrupted import on hydration instead of failing it", async () => {
    const prepared = await prepareImportFile(
      new File(["已在回收站中的原文件。"], "hydrated-recycle.txt"),
      "",
    );
    const now = "2026-09-13T12:40:00.000Z";
    const job = advanceImportJob(
      startImportJob(
        createImportJob({
          sourceId: prepared.id,
          versionId: prepared.versionId,
          filename: prepared.filename,
          spaceId: "",
          at: now,
        }),
        now,
      ),
      "parsing",
      now,
    );
    const parse = vi.fn(async (source: Source) => parsedImport(source));
    const { coordinator, remote } = setup(importPipeline(parse));
    remote.set(accountA.id, {
      data: {
        ...data("cloud-space"),
        sources: [
          {
            ...prepared,
            status: "parsing",
            deletedAt: now,
            blobKey: "local:hydrated-recycle",
            storagePath: `${accountA.id}/originals/${prepared.id}/${prepared.versionId}`,
          },
        ],
        importJobs: [job],
      },
      revision: 1,
    });

    await coordinator.activate(accountA);
    await vi.waitFor(() => {
      expect(
        coordinator.getSnapshot().data.importJobs?.find((item) => item.id === job.id)?.status,
      ).toBe("cancelled");
    });
    expect(parse).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().data.sources[0]).toMatchObject({
      deletedAt: now,
      status: "saved",
      blobKey: "local:hydrated-recycle",
      storagePath: `${accountA.id}/originals/${prepared.id}/${prepared.versionId}`,
    });
  });

  it("confirms a retry state locally before starting its next parser", async () => {
    const parse = vi.fn(
      async (
        _source: Source,
        _blob: Blob,
        options?: { signal?: AbortSignal; originalSaved?: boolean },
      ) =>
        new Promise<Source>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    const { coordinator, io } = setup(importPipeline(parse));
    await coordinator.activate(null);
    const result = await coordinator.importFile(
      new File(["本地持久化必须先于重试解析。"], "durable-retry.txt"),
      "",
      coordinator.getSnapshot().token,
    );
    if (result.kind !== "queued") throw new Error("expected queued import");
    await vi.waitFor(() => expect(parse).toHaveBeenCalledOnce());

    vi.mocked(io.saveLocal).mockClear();
    const saved = deferred<void>();
    vi.mocked(io.saveLocal).mockImplementationOnce(async () => saved.promise);
    coordinator.cancelImport(result.job.id, coordinator.getSnapshot().token);
    await vi.waitFor(() => expect(io.saveLocal).toHaveBeenCalledOnce());

    const retry = coordinator.retryImport(result.job.id, coordinator.getSnapshot().token);
    await Promise.resolve();
    expect(parse).toHaveBeenCalledOnce();
    saved.resolve();
    await retry;
    await vi.waitFor(() => expect(parse).toHaveBeenCalledTimes(2));
  });

  it("continues after one parser failure, retains its real missing page range, and keeps incomplete sources out of evidence", async () => {
    const parse = vi.fn(async (source: Source) =>
      source.filename === "bad.txt"
        ? {
            ...source,
            status: "failed" as const,
            coverage: {
              captureScope: "full" as const,
              parseState: "failed" as const,
              unavailablePageRanges: [{ start: 1, end: 3 }],
            },
            error: "文件损坏",
            text: "",
            chunks: [],
          }
        : parsedImport(source, "学习率过高可能造成振荡。"),
    );
    const { coordinator } = setup(importPipeline(parse));
    await coordinator.activate(null);
    const first = await coordinator.importFile(
      new File(["bad"], "bad.txt"),
      "",
      coordinator.getSnapshot().token,
      false,
      true,
    );
    const second = await coordinator.importFile(
      new File(["good"], "good.txt"),
      "",
      coordinator.getSnapshot().token,
    );
    if (first.kind !== "queued" || second.kind !== "queued")
      throw new Error("expected queued imports");
    await vi.waitFor(() => {
      const jobs = coordinator.getSnapshot().data.importJobs ?? [];
      expect(jobs.find((job) => job.id === first.job.id)?.status).toBe("failed");
      expect(jobs.find((job) => job.id === second.job.id)?.status).toBe("completed");
    });
    const workspace = coordinator.getSnapshot().data;
    const failed = workspace.sources.find((source) => source.id === first.job.sourceId)!;
    expect(failed.coverage).toEqual({
      captureScope: "full",
      parseState: "failed",
      unavailablePageRanges: [{ start: 1, end: 3 }],
    });
    const result = retrieveEvidence(workspace, {
      question: "学习率过高会怎样",
      scope: "document",
      sourceId: failed.id,
      sourceIds: [],
      spaceId: "inbox",
    });
    expect(result.content).toContain("尚未提取出可检索文字");
  });
});

async function setupQuestion(
  patch: Partial<AnswerRequest> = {},
  prepare?: (workspace: WorkspaceData) => void,
) {
  const fixture = setup();
  const workspace = createDemoWorkspace();
  prepare?.(workspace);
  fixture.remote.set(accountA.id, { data: workspace, revision: 1 });
  await fixture.coordinator.activate(accountA);
  const request: AnswerRequest = {
    question: "学习率过高会怎样？",
    scope: "document",
    spaceId: workspace.spaces[0].id,
    sourceId: workspace.sources[0].id,
    sourceIds: [],
    ...patch,
  };
  const response: AnswerResult = {
    ...retrieveEvidence(workspace, request),
    mode: "model",
  };
  const network = deferred<AnswerResult>();
  vi.mocked(fixture.io.askCloud).mockReturnValueOnce(network.promise);
  const controller = new AbortController();
  const answer = fixture.coordinator.ask(
    request,
    controller.signal,
    fixture.coordinator.getSnapshot().token,
  );
  // Observe rejection immediately; each test still checks the concrete result.
  const outcome = answer.then(
    (value) => ({ value, error: null }),
    (error: unknown) => ({ value: null, error }),
  );
  return { ...fixture, workspace, request, response, network, controller, outcome };
}

describe("account deletion browser boundary", () => {
  it("stops late work, drains an already queued write, then clears the deleted account cache", async () => {
    const { coordinator, io, disk, network, response, outcome } = await setupQuestion();
    const providerSignal = vi.mocked(io.askCloud).mock.calls[0]?.[1];
    const localWrite = deferred<void>();
    const localWritesBefore = vi.mocked(io.saveLocal).mock.calls.length;
    vi.mocked(io.saveLocal).mockImplementationOnce(async (snapshot, id = "local") => {
      await localWrite.promise;
      disk.set(id, structuredClone(snapshot));
    });
    rename(coordinator, "待清理的本机修改");
    await vi.waitFor(() => expect(io.saveLocal).toHaveBeenCalledTimes(localWritesBefore + 1));

    const removal = coordinator.discardAccount(accountA.id);
    expect(providerSignal?.aborted).toBe(true);
    expect(io.clearAccountLocalCache).not.toHaveBeenCalled();
    localWrite.resolve();
    await removal;

    expect(io.clearAccountLocalCache).toHaveBeenCalledExactlyOnceWith(accountA.id);
    expect(disk.has(accountA.id)).toBe(false);
    expect(coordinator.getSnapshot()).toMatchObject({
      user: null,
      ready: false,
      data: { sources: [] },
    });
    const stopped = await outcome;
    expect(stopped.value).toBeNull();
    expect((stopped.error as Error).name).toBe("AbortError");
    // A provider that ignores AbortSignal cannot restore the detached snapshot.
    network.resolve(response);
    expect((await outcome).value).toBeNull();
  });

  it("waits for an in-flight same-account recovery snapshot before clearing it", async () => {
    const { coordinator, io, disk, remote } = setup();
    disk.set(accountA.id, { ...data("本机冲突副本"), _conuoSync: { revision: 1, dirty: true } });
    remote.set(accountA.id, { data: data("云端副本"), revision: 2 });
    await coordinator.activate(accountA);
    expect(coordinator.getSnapshot().status).toBe("conflict");

    const backupWrite = deferred<void>();
    const localWritesBefore = vi.mocked(io.saveLocal).mock.calls.length;
    vi.mocked(io.saveLocal).mockImplementationOnce(async (snapshot, id = "local") => {
      await backupWrite.promise;
      disk.set(id, structuredClone(snapshot));
    });
    const recovery = coordinator.useRemote(coordinator.getSnapshot().token);
    await vi.waitFor(() => expect(io.saveLocal).toHaveBeenCalledTimes(localWritesBefore + 1));

    const removal = coordinator.discardAccount(accountA.id);
    expect(io.clearAccountLocalCache).not.toHaveBeenCalled();
    backupWrite.resolve();
    await Promise.all([recovery, removal]);

    expect(io.clearAccountLocalCache).toHaveBeenCalledExactlyOnceWith(accountA.id);
    expect(
      [...disk.keys()].some(
        (key) => key === accountA.id || key.startsWith(`recovery:${accountA.id}:`),
      ),
    ).toBe(false);
  });
});

describe("question context changes during a delayed model response", () => {
  it("rechecks each explicit cross-library source in the browser before it can reach cloud retrieval", async () => {
    const { coordinator, io, remote } = setup();
    const workspace = createDemoWorkspace();
    const firstSpace = workspace.spaces[0]!;
    const secondSpace = { ...firstSpace, id: "cross-client-space", name: "第二知识库" };
    workspace.spaces.push(secondSpace);
    workspace.sources[1]!.spaceIds = [secondSpace.id];
    workspace.sources[1]!.aiAllowed = false;
    remote.set(accountA.id, { data: workspace, revision: 1 });
    await coordinator.activate(accountA);
    const sourceIds = workspace.sources.map((source) => source.id);
    const request: AnswerRequest = {
      question: "两份资料如何一起理解学习率？",
      scope: "cross-library-sources",
      sourceIds,
      sourceVersions: workspace.sources.map((source) => ({
        sourceId: source.id,
        versionId: source.versionId,
      })),
      spaceId: "all",
    };

    await expect(
      coordinator.ask(request, new AbortController().signal, coordinator.getSnapshot().token),
    ).rejects.toThrow("禁止 AI 使用");
    expect(io.askCloud).not.toHaveBeenCalled();
  });

  const changes: [string, (workspace: WorkspaceData) => void][] = [
    ["source deletion", (workspace) => (workspace.sources[0].deletedAt = new Date().toISOString())],
    ["source AI permission revocation", (workspace) => (workspace.sources[0].aiAllowed = false)],
    ["global AI shutdown", (workspace) => (workspace.aiEnabled = false)],
    ["source version replacement", (workspace) => (workspace.sources[0].versionId = "new-version")],
    ["source text replacement", (workspace) => (workspace.sources[0].text = "新版本的原文")],
    ["source leaving the chosen space", (workspace) => (workspace.sources[0].spaceIds = [])],
    ["space archival", (workspace) => (workspace.spaces[0].archived = true)],
    ["space removal", (workspace) => (workspace.spaces = [])],
  ];
  it.each(changes)(
    "stops generation immediately on %s and rejects late output",
    async (_name, mutate) => {
      const { coordinator, io, outcome, network, response } = await setupQuestion();
      const providerSignal = vi.mocked(io.askCloud).mock.calls[0][1];
      expect(providerSignal?.aborted).toBe(false);
      coordinator.update((current) => {
        const next = structuredClone(current);
        mutate(next);
        return next;
      }, coordinator.getSnapshot().token);
      expect(providerSignal?.aborted).toBe(true);
      // The transport deliberately ignores cancellation and remains unresolved.
      // The caller must still learn immediately that its evidence became invalid.
      const stopped = await outcome;
      expect(stopped.value).toBeNull();
      expect(stopped.error).toBeInstanceOf(Error);
      expect((stopped.error as Error).message).toContain("确认当前范围后重试");
      network.resolve(response);
      expect((await outcome).value).toBeNull();
      expect(coordinator.getSnapshot().data.conversations).toEqual([]);
    },
  );

  it("does not revive a cancelled answer if permissions are restored before the provider returns", async () => {
    const { coordinator, outcome, network, response } = await setupQuestion();
    const original = coordinator.getSnapshot().data;
    coordinator.update(
      (current) => ({ ...current, aiEnabled: false }),
      coordinator.getSnapshot().token,
    );
    coordinator.update(() => original, coordinator.getSnapshot().token);
    network.resolve(response);
    expect((await outcome).value).toBeNull();
  });

  it("stops a document-notes question when its selected personal note changes", async () => {
    const { coordinator, io, outcome, network, response } = await setupQuestion(
      { scope: "document-notes" },
      (workspace) => {
        const source = workspace.sources[0];
        const chunk = source.chunks[0];
        workspace.notes.push(
          note("<p>我的复盘：学习率过高时，损失可能上下波动。</p>", {
            id: "document-note",
            spaceId: workspace.spaces[0].id,
            title: "我的学习率复盘",
            aiGenerated: false,
            contentRevision: 3,
            citations: [
              {
                sourceId: source.id,
                versionId: source.versionId,
                chunkId: chunk.id,
                title: source.title,
                quote: chunk.text,
                section: chunk.section,
                page: chunk.page,
              },
            ],
          }),
        );
      },
    );
    expect(response.noteEvidence).toHaveLength(1);
    const providerSignal = vi.mocked(io.askCloud).mock.calls[0][1];
    coordinator.update(
      (current) => ({
        ...current,
        notes: current.notes.map((item) =>
          item.id === "document-note"
            ? {
                ...item,
                content: "<p>我已经修改了这条复盘。</p>",
                contentRevision: 4,
                updatedAt: "2026-09-13T09:00:00.000Z",
              }
            : item,
        ),
      }),
      coordinator.getSnapshot().token,
    );
    expect(providerSignal?.aborted).toBe(true);
    expect((await outcome).value).toBeNull();
    expect((await outcome).error).toBeInstanceOf(Error);
    network.resolve(response);
    expect((await outcome).value).toBeNull();
  });

  it("rejects forged personal-note evidence returned by the question transport", async () => {
    const { network, outcome, response } = await setupQuestion(
      { scope: "document-notes" },
      (workspace) => {
        const source = workspace.sources[0];
        const chunk = source.chunks[0];
        workspace.notes.push(
          note("<p>我的复盘：学习率过高时，损失可能上下波动。</p>", {
            id: "document-note",
            spaceId: workspace.spaces[0].id,
            title: "我的学习率复盘",
            aiGenerated: false,
            contentRevision: 3,
            citations: [
              {
                sourceId: source.id,
                versionId: source.versionId,
                chunkId: chunk.id,
                title: source.title,
                quote: chunk.text,
                section: chunk.section,
                page: chunk.page,
              },
            ],
          }),
        );
      },
    );
    const forged = structuredClone(response);
    expect(forged.noteEvidence).toHaveLength(1);
    forged.noteEvidence![0].quote = "伪造的个人笔记摘录";
    network.resolve(forged);
    const result = await outcome;
    expect(result.value).toBeNull();
    expect((result.error as Error).message).toContain("资料或笔记版本");
  });

  it("keeps a shared-source answer running when a different learning space is deleted", async () => {
    const removedSpaceId = "removed-space";
    const { coordinator, io, outcome, network, response } = await setupQuestion({}, (workspace) => {
      workspace.spaces.push({
        ...workspace.spaces[0],
        id: removedSpaceId,
        name: "将删除的知识库",
      });
      workspace.sources[0].spaceIds.push(removedSpaceId);
    });
    const providerSignal = vi.mocked(io.askCloud).mock.calls[0][1];

    coordinator.update(
      (workspace) => deleteLearningSpace(workspace, removedSpaceId),
      coordinator.getSnapshot().token,
    );

    expect(providerSignal?.aborted).toBe(false);
    network.resolve(response);
    expect((await outcome).value).toEqual(response);
  });

  it("rechecks canonical evidence after await even if a caller changed a snapshot without publishing", async () => {
    const { coordinator, io, outcome, network, response } = await setupQuestion();
    // Consumers should use update(), but the final boundary check must not rely
    // solely on the proactive publish event to reject stale source permissions.
    coordinator.getSnapshot().data.sources[0].aiAllowed = false;
    expect(vi.mocked(io.askCloud).mock.calls[0][1]?.aborted).toBe(false);
    network.resolve(response);
    expect((await outcome).value).toBeNull();
    expect(((await outcome).error as Error).message).toContain("AI 权限已改变");
  });

  it("stops the outgoing account's request even if its transport returns after switching back", async () => {
    const { coordinator, io, remote, outcome, network, response } = await setupQuestion();
    remote.set(accountB.id, { data: data("B cloud"), revision: 1 });
    const providerSignal = vi.mocked(io.askCloud).mock.calls[0][1];
    await coordinator.activate(accountB);
    expect(providerSignal?.aborted).toBe(true);
    await coordinator.activate(accountA);
    network.resolve(response);
    expect((await outcome).value).toBeNull();
    expect(((await outcome).error as Error).message).toContain("账号已改变");
    expect(coordinator.getSnapshot().data.conversations).toEqual([]);
  });

  it("honors Stop immediately and does not accept a provider that ignores AbortSignal", async () => {
    const { io, controller, outcome, network, response } = await setupQuestion();
    controller.abort();
    expect(vi.mocked(io.askCloud).mock.calls[0][1]?.aborted).toBe(true);
    const stopped = await outcome;
    expect(stopped.value).toBeNull();
    expect((stopped.error as Error).name).toBe("AbortError");
    network.resolve(response);
    expect((await outcome).value).toBeNull();
  });

  it("does not start an already stopped request", async () => {
    const { coordinator, io } = setup();
    await coordinator.activate(accountA);
    const controller = new AbortController();
    controller.abort();
    await expect(
      coordinator.ask(
        { question: "test", scope: "space", sourceIds: [], spaceId: "inbox" },
        controller.signal,
        coordinator.getSnapshot().token,
      ),
    ).rejects.toHaveProperty("name", "AbortError");
    expect(io.askCloud).not.toHaveBeenCalled();
  });

  it("allows Reader's new-question conversation update to save while asking about already synced evidence", async () => {
    const { coordinator, io, remote } = setup();
    const workspace = createDemoWorkspace();
    remote.set(accountA.id, { data: workspace, revision: 1 });
    await coordinator.activate(accountA);
    const localSave = deferred<void>();
    vi.mocked(io.saveLocal).mockReturnValueOnce(localSave.promise);
    const token = coordinator.getSnapshot().token;
    const request: AnswerRequest = {
      question: "学习率过高会怎样？",
      scope: "document",
      spaceId: workspace.spaces[0].id,
      sourceId: workspace.sources[0].id,
      sourceIds: [],
    };
    // Reader publishes the question first to preserve it even when generation fails.
    coordinator.update(
      (current) => ({
        ...current,
        conversations: [
          {
            id: "reader-conversation",
            spaceId: request.spaceId,
            sourceId: request.sourceId,
            title: request.question,
            scope: request.scope,
            sourceIds: [],
            resolved: false,
            updatedAt: new Date().toISOString(),
            messages: [
              {
                id: "question-message",
                role: "user",
                content: request.question,
                citations: [],
                createdAt: new Date().toISOString(),
              },
            ],
          },
        ],
      }),
      token,
    );
    expect(coordinator.getSnapshot().status).toBe("saving");
    await expect(
      coordinator.ask(request, new AbortController().signal, token),
    ).resolves.toMatchObject({ mode: "extractive" });
    expect(io.askCloud).toHaveBeenCalledOnce();
    localSave.resolve();
    await status(coordinator, "cloud");
    expect(remote.get(accountA.id)?.data?.conversations[0].messages[0].content).toBe(
      request.question,
    );
  });

  it("refuses an unsynced source edit until the evidence-changing cloud write is acknowledged", async () => {
    const { coordinator, io, remote } = setup();
    const workspace = createDemoWorkspace();
    remote.set(accountA.id, { data: workspace, revision: 1 });
    await coordinator.activate(accountA);
    const cloudSave = deferred<{ revision: number }>();
    vi.mocked(io.saveCloud).mockReturnValueOnce(cloudSave.promise);
    const token = coordinator.getSnapshot().token;
    const request: AnswerRequest = {
      question: "学习率过高会怎样？",
      scope: "document",
      sourceIds: [],
      sourceId: workspace.sources[0].id,
      spaceId: workspace.spaces[0].id,
    };
    coordinator.update(
      (current) => ({
        ...current,
        sources: current.sources.map((source, index) =>
          index ? source : { ...source, text: source.text + "\n需要同步的新证据" },
        ),
      }),
      token,
    );
    await vi.waitFor(() => expect(io.saveCloud).toHaveBeenCalledOnce());
    await expect(coordinator.ask(request, new AbortController().signal, token)).rejects.toThrow(
      "资料尚未同步",
    );
    expect(io.askCloud).not.toHaveBeenCalled();
    cloudSave.resolve({ revision: 2 });
    await status(coordinator, "cloud");
    await expect(
      coordinator.ask(request, new AbortController().signal, token),
    ).resolves.toMatchObject({ mode: "extractive" });
    expect(io.askCloud).toHaveBeenCalledOnce();
  });

  it("allows unrelated note edits, source edits and reading progress while generating", async () => {
    const { coordinator, io, outcome, network, response } = await setupQuestion();
    coordinator.update((current) => {
      const next = structuredClone(current);
      next.sources[0].readPage = 3;
      next.sources[0].readOffset = 500;
      next.sources[1].text = "另一个资料的修改";
      next.notes.push({
        id: "new-note",
        spaceId: next.spaces[0].id,
        title: "另一个想法",
        content: "<p>独立的笔记内容</p>",
        kind: "note",
        status: "accepted",
        citations: [],
        versions: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      });
      return next;
    }, coordinator.getSnapshot().token);
    expect(vi.mocked(io.askCloud).mock.calls[0][1]?.aborted).toBe(false);
    network.resolve(response);
    expect(await outcome).toEqual({ value: response, error: null });
  });

  it("detects a remote evidence change on reconnect", async () => {
    const { coordinator, io, remote, workspace, outcome, network, response } =
      await setupQuestion();
    workspace.sources[0].aiAllowed = false;
    remote.set(accountA.id, { data: workspace, revision: 2 });
    await coordinator.retry(coordinator.getSnapshot().token);
    expect(vi.mocked(io.askCloud).mock.calls[0][1]?.aborted).toBe(true);
    network.resolve(response);
    expect((await outcome).value).toBeNull();
  });

  it("cancels only the affected request when two document questions run concurrently", async () => {
    const { coordinator, io, request, outcome, network, response } = await setupQuestion();
    const secondNetwork = deferred<AnswerResult>();
    vi.mocked(io.askCloud).mockReturnValueOnce(secondNetwork.promise);
    const secondQuestion = coordinator.ask(
      { ...request, sourceId: coordinator.getSnapshot().data.sources[1].id },
      new AbortController().signal,
      coordinator.getSnapshot().token,
    );
    await vi.waitFor(() => expect(io.askCloud).toHaveBeenCalledTimes(2));
    coordinator.update(
      (current) => ({
        ...current,
        sources: current.sources.map((source, index) =>
          index === 0 ? { ...source, aiAllowed: false } : source,
        ),
      }),
      coordinator.getSnapshot().token,
    );
    expect(vi.mocked(io.askCloud).mock.calls[0][1]?.aborted).toBe(true);
    expect(vi.mocked(io.askCloud).mock.calls[1][1]?.aborted).toBe(false);
    expect((await outcome).value).toBeNull();
    const secondResponse: AnswerResult = {
      content: "第二份资料的回答",
      citations: [],
      mode: "model",
    };
    network.resolve(response);
    secondNetwork.resolve(secondResponse);
    await expect(secondQuestion).resolves.toEqual(secondResponse);
  });
});

describe("server-coordinated permanent source purge", () => {
  function preview(sourceId: string, revision: number): SourcePurgePreview {
    return {
      revision,
      fingerprint: "b".repeat(64),
      impact: {
        source: { id: sourceId, title: "待清理资料", deletedAt: "2026-09-13T12:00:00.000Z" },
        versions: 1,
        annotations: 0,
        blockingAnnotations: 0,
        retainedNotes: 0,
        retainedNoteCitations: 0,
        retainedConversations: 0,
        retainedConversationCitations: 0,
        organizationJobs: 0,
        pendingOrganizationJobs: 0,
        conceptRelations: 0,
        blockingConceptRelations: 0,
        importJobs: 0,
        localOriginals: 1,
        cloudOriginals: 1,
      },
      blockers: { annotations: [], conceptRelations: [] },
    };
  }

  function versionPreview(
    sourceId: string,
    versionId: string,
    revision: number,
  ): SourceVersionPurgePreview {
    return {
      revision,
      fingerprint: "c".repeat(64),
      impact: {
        source: { id: sourceId, title: "待清理资料" },
        version: {
          versionId,
          filename: "old.txt",
          createdAt: "2026-09-13T12:00:00.000Z",
          archivedAt: "2026-09-13T13:00:00.000Z",
        },
        annotations: 0,
        blockingAnnotations: 0,
        retainedNotes: 0,
        retainedNoteCitations: 0,
        retainedConversations: 0,
        retainedConversationCitations: 0,
        organizationJobs: 0,
        blockingOrganizationJobs: 0,
        conceptRelations: 0,
        blockingConceptRelations: 0,
        importJobs: 0,
        blockingImportJobs: 0,
        localOriginals: 1,
        cloudOriginals: 1,
      },
      blockers: { annotations: [], conceptRelations: [], organizationJobs: [], importJobs: [] },
    };
  }

  it("persists the server-returned snapshot before safely releasing a local original", async () => {
    const { coordinator, io, remote, disk, blobs } = setup();
    const workspace = createDemoWorkspace();
    const source = {
      ...workspace.sources[0],
      deletedAt: "2026-09-13T12:00:00.000Z",
      blobKey: "purge-local-original",
      storagePath: "A/current/source.txt",
    };
    workspace.sources[0] = source;
    remote.set(accountA.id, { data: structuredClone(workspace), revision: 5 });
    blobs.set(source.blobKey!, new Blob(["private original"]));
    await coordinator.activate(accountA);
    const confirmed = preview(source.id, 5);
    vi.mocked(io.previewSourcePurge!).mockResolvedValue(confirmed);
    vi.mocked(io.requestSourcePurge!).mockImplementation(async () => {
      const data = { ...structuredClone(workspace), sources: workspace.sources.slice(1) };
      remote.set(accountA.id, { data, revision: 6 });
      return {
        data,
        revision: 6,
        purgeId: "f5d81be7-8cf9-437c-a371-8ea571c006ca",
        cleanupPending: true,
      };
    });

    await expect(
      coordinator.previewSourcePurge(source.id, coordinator.getSnapshot().token),
    ).resolves.toEqual(confirmed);
    await coordinator.purgeSource(source.id, confirmed, coordinator.getSnapshot().token);

    expect(coordinator.getSnapshot().data.sources.some((item) => item.id === source.id)).toBe(
      false,
    );
    expect(coordinator.getSnapshot().status).toBe("cloud");
    expect(coordinator.getSnapshot().error).toContain("云端原件正在后台清理");
    expect(disk.get(accountA.id)?._conuoSync).toEqual({ revision: 6, dirty: false });
    expect(io.saveCloud).not.toHaveBeenCalled();
    expect(io.deleteUnreferencedBlob).toHaveBeenCalledWith("purge-local-original");
    expect(blobs.has("purge-local-original")).toBe(false);
  });

  it("pauses syncing after an ambiguous cloud failure instead of saving the old source", async () => {
    const { coordinator, io, remote } = setup();
    const workspace = createDemoWorkspace();
    workspace.sources[0] = {
      ...workspace.sources[0],
      deletedAt: "2026-09-13T12:00:00.000Z",
    };
    remote.set(accountA.id, { data: structuredClone(workspace), revision: 5 });
    await coordinator.activate(accountA);
    const confirmed = preview(workspace.sources[0].id, 5);
    vi.mocked(io.requestSourcePurge!).mockRejectedValue(new Error("network interrupted"));

    await expect(
      coordinator.purgeSource(workspace.sources[0].id, confirmed, coordinator.getSnapshot().token),
    ).rejects.toThrow("network interrupted");

    expect(coordinator.getSnapshot()).toMatchObject({
      status: "error",
      ready: true,
      purging: false,
    });
    expect(coordinator.getSnapshot().error).toContain("已暂停同步");
    expect(io.saveCloud).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)(
    "rejects old-account completion when the committed purge local write %s after switching accounts",
    async (settlement) => {
      const { coordinator, io, remote, disk, blobs } = setup();
      const workspace = workspaceWithReadingSource({
        deletedAt: "2026-09-14T00:00:00.000Z",
        blobKey: "purge-switch-original",
      });
      remote.set(accountA.id, { data: workspace, revision: 5 });
      remote.set(accountB.id, { data: workspaceWithNote("B", "B_PRIVATE_TEXT"), revision: 1 });
      blobs.set("purge-switch-original", new Blob(["A private original"]));
      await coordinator.activate(accountA);
      const source = workspace.sources[0];
      const committed = { ...structuredClone(workspace), sources: [] };
      vi.mocked(io.requestSourcePurge!).mockImplementation(async () => {
        remote.set(accountA.id, { data: committed, revision: 6 });
        return { data: committed, revision: 6, purgeId: "purge-switch", cleanupPending: false };
      });
      const localWrite = deferred<void>();
      const started = deferred<void>();
      const saveLocal = io.saveLocal;
      io.saveLocal = vi.fn(async (snapshot, id, expectedRevision) => {
        if (id === accountA.id) {
          started.resolve();
          await localWrite.promise;
        }
        return saveLocal(snapshot, id, expectedRevision);
      });
      const outcome = coordinator
        .purgeSource(source.id, preview(source.id, 5), coordinator.getSnapshot().token)
        .then(
          () => ({ error: null }),
          (error: unknown) => ({ error }),
        );
      await started.promise;
      await coordinator.activate(accountB);
      const activeB = structuredClone(coordinator.getSnapshot());
      if (settlement === "resolve") localWrite.resolve();
      else localWrite.reject(new Error("A local save failed"));
      const completed = await outcome;
      expect(completed.error).toBeInstanceOf(Error);
      expect((completed.error as Error).message).toContain("账号已改变");
      expect(coordinator.getSnapshot()).toEqual(activeB);
      expect(disk.get(accountB.id)?.notes[0].content).toBe("B_PRIVATE_TEXT");
      expect(remote.get(accountA.id)?.data?.sources).toEqual([]);
      expect(io.saveCloud).not.toHaveBeenCalled();
      expect(io.deleteUnreferencedBlob).not.toHaveBeenCalled();
      expect(blobs.has("purge-switch-original")).toBe(true);
      if (settlement === "resolve") expect(disk.get(accountA.id)?.sources).toEqual([]);
      else expect(disk.get(accountA.id)?.sources).toHaveLength(1);
      io.saveLocal = saveLocal;
      await coordinator.activate(accountA);
      expect(coordinator.getSnapshot().user).toEqual(accountA);
      expect(coordinator.getSnapshot().data.sources).toEqual([]);
      expect(disk.get(accountA.id)?.sources).toEqual([]);
      expect(disk.get(accountA.id)?._conuoSync).toEqual({ revision: 6, dirty: false });
    },
  );

  it.each(["resolve", "reject"] as const)(
    "rejects old-account completion when original cleanup %s after switching accounts",
    async (settlement) => {
      const { coordinator, io, remote, disk, blobs } = setup();
      const workspace = workspaceWithReadingSource({
        deletedAt: "2026-09-14T00:00:00.000Z",
        blobKey: "purge-cleanup-switch-original",
      });
      remote.set(accountA.id, { data: workspace, revision: 5 });
      remote.set(accountB.id, { data: workspaceWithNote("B", "B_PRIVATE_TEXT"), revision: 1 });
      blobs.set("purge-cleanup-switch-original", new Blob(["A original"]));
      await coordinator.activate(accountA);
      const source = workspace.sources[0];
      const committed = { ...structuredClone(workspace), sources: [] };
      vi.mocked(io.requestSourcePurge!).mockImplementation(async () => {
        remote.set(accountA.id, { data: committed, revision: 6 });
        return { data: committed, revision: 6, purgeId: "cleanup-switch", cleanupPending: false };
      });
      const cleanup = deferred<void>();
      const started = deferred<void>();
      const deleteOriginal = io.deleteUnreferencedBlob!;
      io.deleteUnreferencedBlob = vi.fn(async (...args: Parameters<typeof deleteOriginal>) => {
        started.resolve();
        await cleanup.promise;
        return deleteOriginal(...args);
      });
      const outcome = coordinator
        .purgeSource(source.id, preview(source.id, 5), coordinator.getSnapshot().token)
        .then(
          () => ({ error: null }),
          (error: unknown) => ({ error }),
        );
      await started.promise;
      expect(disk.get(accountA.id)?.sources).toEqual([]);
      await coordinator.activate(accountB);
      const activeB = structuredClone(coordinator.getSnapshot());
      if (settlement === "resolve") cleanup.resolve();
      else cleanup.reject(new Error("A original cleanup failed"));
      const completed = await outcome;
      expect(completed.error).toBeInstanceOf(Error);
      expect((completed.error as Error).message).toContain("账号已改变");
      expect(coordinator.getSnapshot()).toEqual(activeB);
      expect(disk.get(accountA.id)?._conuoSync).toEqual({ revision: 6, dirty: false });
      expect(disk.get(accountB.id)?.notes[0].content).toBe("B_PRIVATE_TEXT");
      expect(remote.get(accountA.id)?.data?.sources).toEqual([]);
      expect(blobs.has("purge-cleanup-switch-original")).toBe(settlement === "reject");
      expect(io.saveCloud).not.toHaveBeenCalled();
    },
  );

  function selectableWorkspace() {
    const workspace = createDemoWorkspace();
    const source = workspace.sources[0];
    source.deletedAt = "2026-09-14T00:00:00.000Z";
    const citation = {
      sourceId: source.id,
      versionId: source.versionId,
      chunkId: source.chunks[0].id,
      title: source.title,
      section: source.chunks[0].section,
      quote: source.chunks[0].text,
    };
    workspace.notes.push(
      note("另存的个人解释", { spaceId: workspace.spaces[0].id, citations: [citation] }),
    );
    workspace.notes.push(
      note("无关的个人正文", { id: "independent-note", spaceId: workspace.spaces[0].id }),
    );
    workspace.conversations.push({
      id: "conversation-a",
      title: "围绕资料的历史问答",
      resolved: false,
      scope: "document",
      sourceId: source.id,
      sourceIds: [source.id],
      spaceId: workspace.spaces[0].id,
      messages: [
        {
          id: "answer-a",
          role: "assistant",
          content: "个人历史回答",
          citations: [citation],
          createdAt: "2026-09-14T00:00:00.000Z",
        },
      ],
      updatedAt: "2026-09-14T00:00:00.000Z",
    });
    workspaceSchema.parse(workspace);
    return workspace;
  }

  function selectedPreview(
    workspace: WorkspaceData,
    selection: PermanentSourceDeletionSelection,
  ): SourcePurgePreview {
    const sourceId = workspace.sources[0].id;
    return {
      revision: 5,
      fingerprint: "c".repeat(64),
      impact: previewPermanentSourceDeletion(workspace, sourceId, selection),
      blockers: permanentSourceDeletionBlockers(workspace, sourceId, selection),
      contentSelection: previewPermanentSourceDeletionContent(workspace, sourceId, selection),
    };
  }

  it("previews and commits explicit saved-content choices through the canonical coordinator", async () => {
    const { coordinator, io, remote, disk } = setup();
    const workspace = selectableWorkspace();
    const selection = { noteIds: ["note-a"], conversationIds: ["conversation-a"] };
    remote.set(accountA.id, { data: structuredClone(workspace), revision: 5 });
    await coordinator.activate(accountA);
    const confirmed = selectedPreview(workspace, selection);
    vi.mocked(io.previewSourcePurge!).mockResolvedValue(confirmed);
    const controller = new AbortController();
    expect(
      await coordinator.previewSourcePurge(
        workspace.sources[0].id,
        coordinator.getSnapshot().token,
        selection,
        controller.signal,
      ),
    ).toEqual(confirmed);
    expect(io.previewSourcePurge).toHaveBeenCalledWith(
      workspace.sources[0].id,
      accountA.id,
      selection,
      controller.signal,
    );
    const returned = structuredClone(workspace);
    returned.sources.shift();
    returned.notes = returned.notes.filter((item) => item.id !== "note-a");
    returned.conversations = [];
    vi.mocked(io.requestSourcePurge!).mockResolvedValue({
      data: returned,
      revision: 6,
      purgeId: "f5d81be7-8cf9-437c-a371-8ea571c006ca",
      cleanupPending: false,
    });
    await coordinator.purgeSource(
      workspace.sources[0].id,
      confirmed,
      coordinator.getSnapshot().token,
    );
    expect(io.requestSourcePurge).toHaveBeenCalledExactlyOnceWith(
      workspace.sources[0].id,
      5,
      confirmed.fingerprint,
      accountA.id,
      selection,
    );
    expect(coordinator.getSnapshot().data).toEqual(returned);
    expect(disk.get(accountA.id)?.notes.map((item) => item.id)).toEqual(["independent-note"]);
    expect(io.saveCloud).not.toHaveBeenCalled();
  });

  it("rejects an unassociated saved-content ID before entering the deletion transaction", async () => {
    const { coordinator, io, remote } = setup();
    const workspace = selectableWorkspace();
    remote.set(accountA.id, { data: structuredClone(workspace), revision: 5 });
    await coordinator.activate(accountA);
    const confirmed = selectedPreview(workspace, { noteIds: [], conversationIds: [] });
    confirmed.contentSelection!.selection.noteIds = ["independent-note"];
    await expect(
      coordinator.purgeSource(workspace.sources[0].id, confirmed, coordinator.getSnapshot().token),
    ).rejects.toThrow();
    expect(io.requestSourcePurge).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot()).toMatchObject({
      ready: true,
      purging: false,
      status: "cloud",
    });
  });

  it("captures confirmed choices so mutation during the RPC cannot hide an incomplete result", async () => {
    const { coordinator, io, remote, disk } = setup();
    const workspace = selectableWorkspace();
    remote.set(accountA.id, { data: structuredClone(workspace), revision: 5 });
    await coordinator.activate(accountA);
    const confirmed = selectedPreview(workspace, { noteIds: ["note-a"], conversationIds: [] });
    const response =
      deferred<Awaited<ReturnType<NonNullable<WorkspaceIO["requestSourcePurge"]>>>>();
    vi.mocked(io.requestSourcePurge!).mockReturnValue(response.promise);
    const pending = coordinator.purgeSource(
      workspace.sources[0].id,
      confirmed,
      coordinator.getSnapshot().token,
    );
    confirmed.contentSelection!.selection.noteIds.length = 0;
    const returned = structuredClone(workspace);
    returned.sources.shift();
    response.resolve({
      data: returned,
      revision: 6,
      purgeId: "f5d81be7-8cf9-437c-a371-8ea571c006ca",
      cleanupPending: false,
    });
    await expect(pending).rejects.toThrow("删除结果尚未确认");
    expect(coordinator.getSnapshot()).toMatchObject({ status: "error", purging: false });
    expect(disk.get(accountA.id)?.sources[0].id).toBe(workspace.sources[0].id);
    expect(io.saveCloud).not.toHaveBeenCalled();
  });

  it("does not persist account A's selected purge response after switching to B", async () => {
    const { coordinator, io, remote, disk } = setup();
    const workspace = selectableWorkspace();
    remote.set(accountA.id, { data: structuredClone(workspace), revision: 5 });
    remote.set(accountB.id, { data: data("B的独立工作区"), revision: 1 });
    await coordinator.activate(accountA);
    const response =
      deferred<Awaited<ReturnType<NonNullable<WorkspaceIO["requestSourcePurge"]>>>>();
    vi.mocked(io.requestSourcePurge!).mockReturnValue(response.promise);
    const pending = coordinator.purgeSource(
      workspace.sources[0].id,
      selectedPreview(workspace, { noteIds: ["note-a"], conversationIds: [] }),
      coordinator.getSnapshot().token,
    );
    await coordinator.activate(accountB);
    response.resolve({
      data: data("A的删除结果"),
      revision: 6,
      purgeId: "f5d81be7-8cf9-437c-a371-8ea571c006ca",
      cleanupPending: false,
    });
    await expect(pending).rejects.toThrow("账号已改变");
    expect(coordinator.getSnapshot().data.spaces[0].name).toBe("B的独立工作区");
    expect(disk.get(accountA.id)?.sources[0].id).toBe(workspace.sources[0].id);
    expect(io.saveCloud).not.toHaveBeenCalled();
  });

  it("rejects a selection preview whose request was cancelled while the server was reading", async () => {
    const { coordinator, io, remote } = setup();
    const workspace = selectableWorkspace();
    remote.set(accountA.id, { data: structuredClone(workspace), revision: 5 });
    await coordinator.activate(accountA);
    const response = deferred<SourcePurgePreview>();
    vi.mocked(io.previewSourcePurge!).mockReturnValue(response.promise);
    const controller = new AbortController();
    const pending = coordinator.previewSourcePurge(
      workspace.sources[0].id,
      coordinator.getSnapshot().token,
      { noteIds: [], conversationIds: [] },
      controller.signal,
    );
    controller.abort();
    response.resolve(selectedPreview(workspace, { noteIds: [], conversationIds: [] }));
    await expect(pending).rejects.toThrow("核对已停止");
    expect(coordinator.getSnapshot()).toMatchObject({
      ready: true,
      status: "cloud",
      purging: false,
    });
  });

  it("persists the exact server version-purge result before safely releasing its historical original", async () => {
    const { coordinator, io, remote, disk, blobs } = setup();
    const workspace = createDemoWorkspace();
    const live = workspace.sources[0];
    const historical = {
      versionId: "version-old",
      title: live.title,
      filename: "old.txt",
      kind: live.kind,
      mime: live.mime,
      size: live.size,
      hash: live.hash,
      status: live.status,
      text: live.text,
      chunks: live.chunks.map((chunk) => ({ ...chunk, versionId: "version-old" })),
      createdAt: "2026-09-13T12:00:00.000Z",
      archivedAt: "2026-09-13T13:00:00.000Z",
      blobKey: "purge-historical-original",
      storagePath: "A/version-old/source.txt",
    } as const;
    workspace.sources[0] = { ...live, versions: [historical] };
    remote.set(accountA.id, { data: structuredClone(workspace), revision: 5 });
    blobs.set(historical.blobKey, new Blob(["historical original"]));
    await coordinator.activate(accountA);
    const confirmed = versionPreview(live.id, historical.versionId, 5);
    vi.mocked(io.previewSourceVersionPurge!).mockResolvedValue(confirmed);
    vi.mocked(io.requestSourceVersionPurge!).mockImplementation(async () => {
      const data = structuredClone(workspace);
      data.sources[0].versions = [];
      remote.set(accountA.id, { data, revision: 6 });
      return {
        data,
        revision: 6,
        purgeId: "f5d81be7-8cf9-437c-a371-8ea571c006ca",
        cleanupPending: true,
      };
    });

    await expect(
      coordinator.previewSourceVersionPurge(
        live.id,
        historical.versionId,
        coordinator.getSnapshot().token,
      ),
    ).resolves.toEqual(confirmed);
    await coordinator.purgeSourceVersion(
      live.id,
      historical.versionId,
      confirmed,
      coordinator.getSnapshot().token,
    );

    expect(coordinator.getSnapshot().data.sources[0].versions).toEqual([]);
    expect(coordinator.getSnapshot().status).toBe("cloud");
    expect(coordinator.getSnapshot().error).toContain("云端原件正在后台清理");
    expect(disk.get(accountA.id)?._conuoSync).toEqual({ revision: 6, dirty: false });
    expect(io.requestSourceVersionPurge).toHaveBeenCalledWith(
      live.id,
      historical.versionId,
      5,
      confirmed.fingerprint,
      accountA.id,
    );
    expect(io.saveCloud).not.toHaveBeenCalled();
    expect(io.deleteUnreferencedBlob).toHaveBeenCalledWith(historical.blobKey);
    expect(blobs.has(historical.blobKey)).toBe(false);
  });

  it.each(["resolve", "reject"] as const)(
    "reports an unconfirmed local copy when accounts switch while a version purge saves (%s)",
    async (settlement) => {
      const { coordinator, io, disk, remote, blobs } = setup();
      const workspace = createDemoWorkspace();
      const live = workspace.sources[0];
      const historical = {
        versionId: "version-old",
        title: live.title,
        filename: "old.txt",
        kind: live.kind,
        mime: live.mime,
        size: live.size,
        hash: live.hash,
        status: live.status,
        text: live.text,
        chunks: live.chunks.map((chunk) => ({ ...chunk, versionId: "version-old" })),
        createdAt: "2026-09-13T12:00:00.000Z",
        archivedAt: "2026-09-13T13:00:00.000Z",
        blobKey: "version-switch-original",
        storagePath: "A/version-old/source.txt",
      } as const;
      workspace.sources[0] = { ...live, versions: [historical] };
      remote.set(accountA.id, { data: structuredClone(workspace), revision: 5 });
      remote.set(accountB.id, { data: workspaceWithNote("B", "B_PRIVATE_TEXT"), revision: 1 });
      blobs.set(historical.blobKey, new Blob(["historical original"]));
      await coordinator.activate(accountA);
      const confirmed = versionPreview(live.id, historical.versionId, 5);
      vi.mocked(io.requestSourceVersionPurge!).mockImplementation(async () => {
        const data = structuredClone(workspace);
        data.sources[0].versions = [];
        remote.set(accountA.id, { data, revision: 6 });
        return { data, revision: 6, purgeId: "version-switch", cleanupPending: false };
      });
      const localWrite = deferred<void>();
      const started = deferred<void>();
      const saveLocal = io.saveLocal;
      io.saveLocal = vi.fn(async (snapshot, id, expectedRevision) => {
        if (id === accountA.id) {
          started.resolve();
          await localWrite.promise;
        }
        return saveLocal(snapshot, id, expectedRevision);
      });

      const outcome = coordinator
        .purgeSourceVersion(
          live.id,
          historical.versionId,
          confirmed,
          coordinator.getSnapshot().token,
        )
        .then(
          () => ({ error: null }),
          (error: unknown) => ({ error }),
        );
      await started.promise;
      await coordinator.activate(accountB);
      const activeB = structuredClone(coordinator.getSnapshot());
      if (settlement === "resolve") localWrite.resolve();
      else localWrite.reject(new Error("A local save failed"));

      // Resolving quietly would read as a confirmed cleanup, while this account
      // still has to verify or retry its own local copy. A full source purge
      // already reports this; both purge paths must agree.
      const completed = await outcome;
      expect(completed.error).toBeInstanceOf(Error);
      expect((completed.error as Error).message).toContain("账号已改变");
      expect((completed.error as Error).message).toContain("历史版本清理");
      expect(coordinator.getSnapshot()).toEqual(activeB);
      expect(disk.get(accountB.id)?.notes[0].content).toBe("B_PRIVATE_TEXT");
      expect(io.deleteUnreferencedBlob).not.toHaveBeenCalled();
      expect(blobs.has(historical.blobKey)).toBe(true);
      io.saveLocal = saveLocal;
    },
  );
});

function durableRequest(data: WorkspaceData, id: string): DurableOrganizationRequest {
  const source = data.sources[0]!;
  return {
    requestId: id,
    kind: "source",
    trigger: "manual",
    spaceId: data.spaces[0]!.id,
    sourceIds: [source.id],
    sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
  };
}

function durableJob(
  request: DurableOrganizationRequest,
  status: OrganizationJob["status"] = "queued",
  patch: Partial<OrganizationJob> = {},
): OrganizationJob {
  return {
    id: request.requestId,
    durable: true,
    request,
    status,
    createdAt: "2026-09-14T12:00:00.000Z",
    updatedAt: "2026-09-14T12:00:00.000Z",
    ...patch,
  };
}

function durableSourceResult(
  data: WorkspaceData,
  request: DurableOrganizationRequest,
): OrganizationResult {
  return bindOrganizationResult(
    JSON.stringify({
      status: "ready",
      kind: "source",
      summary: {
        title: "学习率摘要",
        paragraphs: [{ text: "学习率决定参数更新的步长。", evidenceIds: ["e1"], kind: "source" }],
      },
      tags: [{ label: "学习率", evidenceIds: ["e1"] }],
      topics: [{ label: "梯度下降", evidenceIds: ["e1"] }],
    }),
    buildOrganizationGrounding(data, request),
    request,
  );
}

function installDurableOrganizationQueue(
  io: WorkspaceIO,
  remote: Map<string, { data: WorkspaceData | null; revision: number }>,
) {
  io.enqueueOrganizationJob = vi.fn(
    async (request: DurableOrganizationRequest, revision: number, userId: string) => {
      const current = remote.get(userId);
      if (!current?.data || current.revision !== revision) throw new Error("409 conflict");
      const job = durableJob(request);
      const data: WorkspaceData = {
        ...structuredClone(current.data),
        organizationJobs: [...(current.data.organizationJobs ?? []), job],
      };
      remote.set(userId, { data, revision: revision + 1 });
      return { revision: revision + 1, job, created: true };
    },
  );
}

describe("durable organization queue integration", () => {
  it.each(["source", "knowledge"] as const)(
    "submits %s organization through the durable queue instead of the direct model route",
    async (kind) => {
      const { coordinator, io, remote } = setup();
      const data = createDemoWorkspace();
      remote.set(accountA.id, { data: structuredClone(data), revision: 1 });
      installDurableOrganizationQueue(io, remote);
      await coordinator.activate(accountA);

      const snapshot = coordinator.getSnapshot();
      const sourceIds =
        kind === "source"
          ? [snapshot.data.sources[0]!.id]
          : snapshot.data.sources.map((source) => source.id);
      await coordinator.organize(
        { kind, spaceId: snapshot.data.spaces[0]!.id, sourceIds },
        undefined,
        snapshot.token,
      );

      expect(io.enqueueOrganizationJob).toHaveBeenCalledWith(
        expect.objectContaining({ kind, trigger: "manual", sourceIds }),
        1,
        accountA.id,
        undefined,
      );
      expect(io.organizeCloud).not.toHaveBeenCalled();
      expect(io.getModelStatus).not.toHaveBeenCalled();
      expect(coordinator.getSnapshot()).toMatchObject({
        status: "cloud",
        data: {
          organizationJobs: [
            expect.objectContaining({
              durable: true,
              status: "queued",
              request: expect.objectContaining({ kind }),
            }),
          ],
        },
      });
      expect(remote.get(accountA.id)).toMatchObject({
        revision: 2,
        data: {
          organizationJobs: [expect.objectContaining({ durable: true, status: "queued" })],
        },
      });
    },
  );

  it("reconciles and reloads an active durable task to show a worker-published ready result", async () => {
    const { coordinator, io, remote, disk } = setup();
    const data = createDemoWorkspace();
    const request = durableRequest(data, "durable-check");
    const queued = durableJob(request);
    data.organizationJobs = [queued];
    remote.set(accountA.id, { data: structuredClone(data), revision: 2 });
    await coordinator.activate(accountA);
    const ready = durableJob(request, "ready", { result: durableSourceResult(data, request) });
    const workerData = { ...structuredClone(data), organizationJobs: [ready] };
    io.reconcileOrganizationJobs = vi.fn(async (userId: string) => {
      remote.set(userId, { data: workerData, revision: 3 });
      return { revision: 3, jobs: [] };
    });
    vi.mocked(io.loadCloud).mockClear();

    await coordinator.checkOrganization(request.requestId, coordinator.getSnapshot().token);

    expect(io.reconcileOrganizationJobs).toHaveBeenCalledWith(accountA.id, undefined);
    expect(io.loadCloud).toHaveBeenCalledWith(accountA.id);
    expect(io.organizeCloud).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot()).toMatchObject({
      status: "cloud",
      data: {
        organizationJobs: [
          expect.objectContaining({ durable: true, status: "ready", result: ready.result }),
        ],
      },
    });
    expect(disk.get(accountA.id)?._conuoSync).toEqual({ revision: 3, dirty: false });
  });

  it("cancels an active durable task through the queue and confirms the terminal projection locally", async () => {
    const { coordinator, io, remote, disk } = setup();
    const data = createDemoWorkspace();
    const request = durableRequest(data, "durable-cancel");
    const queued = durableJob(request);
    data.organizationJobs = [queued];
    remote.set(accountA.id, { data: structuredClone(data), revision: 2 });
    await coordinator.activate(accountA);
    const cancelled = durableJob(request, "cancelled", {
      error: "后台整理已停止，可稍后重新生成。",
      updatedAt: "2026-09-14T12:01:00.000Z",
    });
    const terminalData = { ...structuredClone(data), organizationJobs: [cancelled] };
    io.cancelOrganizationJob = vi.fn(async (jobId: string, revision: number, userId: string) => {
      if (jobId !== request.requestId || revision !== 2 || userId !== accountA.id)
        throw new Error("unexpected cancellation");
      remote.set(userId, { data: terminalData, revision: 3 });
      return { revision: 3, job: cancelled, cancelled: true };
    });

    await coordinator.stopOrganization(request.requestId, coordinator.getSnapshot().token);

    expect(io.cancelOrganizationJob).toHaveBeenCalledWith(request.requestId, 2, accountA.id);
    expect(io.organizeCloud).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot()).toMatchObject({
      status: "cloud",
      data: { organizationJobs: [expect.objectContaining({ status: "cancelled", durable: true })] },
    });
    expect(remote.get(accountA.id)?.data?.organizationJobs).toEqual([cancelled]);
    expect(disk.get(accountA.id)?._conuoSync).toEqual({ revision: 3, dirty: false });
  });

  it("reads a server-fenced terminal projection after an ordinary workspace save", async () => {
    const { coordinator, io, remote, disk } = setup();
    const data = createDemoWorkspace();
    const request = durableRequest(data, "durable-save-fence");
    const queued = durableJob(request);
    data.organizationJobs = [queued];
    remote.set(accountA.id, { data: structuredClone(data), revision: 2 });
    await coordinator.activate(accountA);
    const cancelled = durableJob(request, "cancelled", {
      error: "资料、版本或 AI 设置已改变，后台整理已停止。",
      updatedAt: "2026-09-14T12:02:00.000Z",
    });
    io.reconcileOrganizationJobs = vi.fn(async () => ({ revision: 3, jobs: [] }));
    io.saveCloud = vi.fn(async (snapshot, revision, userId) => {
      expect(revision).toBe(2);
      const canonical = { ...structuredClone(snapshot), organizationJobs: [cancelled] };
      remote.set(userId, { data: canonical, revision: 3 });
      return { revision: 3 };
    });

    coordinator.update(
      (current) => ({
        ...current,
        spaces: current.spaces.map((space, index) =>
          index ? space : { ...space, goal: "新的学习目标" },
        ),
      }),
      coordinator.getSnapshot().token,
    );

    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().data.organizationJobs).toEqual([
        expect.objectContaining({ id: request.requestId, durable: true, status: "cancelled" }),
      ]),
    );
    await vi.waitFor(() =>
      expect(disk.get(accountA.id)?._conuoSync).toEqual({ revision: 3, dirty: false }),
    );
    expect(io.reconcileOrganizationJobs).toHaveBeenCalledWith(accountA.id);
    expect(remote.get(accountA.id)?.data?.organizationJobs).toEqual([cancelled]);
  });
});
