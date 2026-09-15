import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceCoordinator, type WorkspaceIO } from "./use-workspace";
import { createDemoWorkspace } from "./seed";
import { applyKnowledgeUpdate, snapshotKnowledgeNote } from "./knowledge-update";
import { previewKnowledgeUpdateWithdrawal } from "./knowledge-update-withdrawal";
import {
  persistKnowledgeUpdateWithdrawal,
  type PersistKnowledgeUpdateWithdrawalInput,
} from "./knowledge-update-withdrawal-operation";
import { reviseNote } from "./note-versions";
import type { WorkspaceData } from "./types";
import type { OrganizationJob } from "./organization-types";

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

const accountA = { id: "withdraw-owner-a", email: "a@example.com" };
const accountB = { id: "withdraw-owner-b", email: "b@example.com" };
const noteId = "withdraw-knowledge",
  jobId = "withdraw-job";
const original = "<p>原本的人工解释。</p><p>保留独立说明。</p>";
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const data = createDemoWorkspace(),
    source = data.sources[0],
    chunk = source.chunks[0];
  const citation = {
    sourceId: source.id,
    versionId: source.versionId,
    chunkId: chunk.id,
    title: source.title,
    quote: chunk.text,
    section: chunk.section,
    page: chunk.page,
  };
  const note = {
    id: noteId,
    spaceId: data.spaces[0].id,
    title: "学习记录",
    content: original,
    kind: "knowledge" as const,
    status: "accepted" as const,
    aiGenerated: false,
    contentRevision: 2,
    citations: [citation],
    versions: [],
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    deletedAt: null,
  };
  data.notes = [note];
  const job: OrganizationJob = {
    id: jobId,
    status: "ready",
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    request: {
      requestId: jobId,
      kind: "update",
      trigger: "manual",
      spaceId: note.spaceId,
      sourceIds: [source.id],
      sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
      targetNote: { id: noteId, revision: 2, updatedAt: note.updatedAt },
    },
    result: {
      kind: "update",
      mode: "model",
      target: snapshotKnowledgeNote(note),
      coverage: "所选资料",
      changes: [
        {
          id: "inserted",
          type: "insert_after",
          blockId: "b1",
          before: "<p>原本的人工解释。</p>",
          after: "模型新增说明。",
          reason: "补充",
          citations: [citation],
        },
      ],
    },
  };
  data.organizationJobs = [job];
  return applyKnowledgeUpdate(data, jobId, [{ changeId: "inserted", text: "模型新增说明。" }]);
}
async function setup() {
  const data = fixture();
  const disk = new Map<string, WorkspaceData>([
    [
      accountA.id,
      { ...structuredClone(data), _conuoSync: { revision: 1, dirty: false } } as WorkspaceData,
    ],
  ]);
  const remote = new Map<string, { data: WorkspaceData; revision: number }>([
    [accountA.id, { data: structuredClone(data), revision: 1 }],
  ]);
  const io: WorkspaceIO = {
    loadLocal: vi.fn(async (id = "local") => structuredClone(disk.get(id) ?? null)),
    saveLocal: vi.fn(async (value, id = "local") => {
      disk.set(id, structuredClone(value));
    }),
    loadCloud: vi.fn(async (id) => structuredClone(remote.get(id) ?? { data: null, revision: 0 })),
    saveCloud: vi.fn(async (value, revision, id) => {
      if ((remote.get(id)?.revision ?? 0) !== revision) throw new Error("409 conflict");
      remote.set(id, { data: structuredClone(value), revision: revision + 1 });
      return { revision: revision + 1 };
    }),
    getBlob: vi.fn(async () => undefined),
    uploadBlob: vi.fn(async () => "unused"),
    downloadBlob: vi.fn(async () => undefined),
    askCloud: vi.fn(async () => ({
      content: "unused",
      citations: [],
      mode: "extractive" as const,
    })),
    organizeCloud: vi.fn(async () => {
      throw new Error("Unexpected model request");
    }),
    getModelStatus: vi.fn(async () => ({ mode: "extractive", message: "本地测试" })),
    readLegacyMeta: vi.fn(() => null),
  };
  const coordinator = new WorkspaceCoordinator(io);
  await coordinator.activate(accountA);
  vi.mocked(io.saveLocal).mockClear();
  vi.mocked(io.saveCloud).mockClear();
  const token = coordinator.getSnapshot().token;
  const plan = await previewKnowledgeUpdateWithdrawal(coordinator.getSnapshot().data, jobId);
  expect(plan.reason).toBeFalsy();
  expect(plan.safeCount).toBe(1);
  const input: PersistKnowledgeUpdateWithdrawalInput = {
    getContext: () => {
      const view = coordinator.getSnapshot();
      return {
        token: view.token,
        userId: view.user?.id ?? null,
        localCacheMode: view.localCacheMode,
        ready: view.ready,
        noteId,
        data: view.data,
      };
    },
    expectedContext: { token, userId: accountA.id, localCacheMode: "normal", noteId },
    jobId,
    fingerprint: plan.fingerprint,
    selections: [{ changeId: "inserted", action: "restore" }],
    updateDurably: (reducer) => coordinator.updateDurably(reducer, token),
  };
  return { coordinator, io, disk, input, data, token };
}
afterEach(() => vi.restoreAllMocks());

describe("withdrawal durable WorkspaceCoordinator integration", () => {
  it("waits for local persistence and does not wait for cloud acknowledgement", async () => {
    const { coordinator, io, disk, input, data } = await setup(),
      local = deferred<void>(),
      cloud = deferred<{ revision: number }>();
    vi.mocked(io.saveLocal).mockImplementationOnce(async (value, id = "local") => {
      await local.promise;
      disk.set(id, structuredClone(value));
    });
    vi.mocked(io.saveCloud).mockReturnValueOnce(cloud.promise);
    let settled = false;
    const pending = persistKnowledgeUpdateWithdrawal(input).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(io.saveLocal).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(disk.get(accountA.id)?.notes[0].content).toBe(data.notes[0].content);
    expect(coordinator.getSnapshot().data.notes[0].content).toBe(original);
    local.resolve();
    await pending;
    expect(disk.get(accountA.id)?.notes[0].content).toBe(original);
    expect(coordinator.getSnapshot().data.notes[0].versions.at(-1)?.content).toBe(
      data.notes[0].content,
    );
    expect(
      coordinator.getSnapshot().data.organizationJobs![0].updateReview?.withdrawal,
    ).toBeDefined();
    await vi.waitFor(() => expect(io.saveCloud).toHaveBeenCalledOnce());
    expect(coordinator.getSnapshot().status).toBe("saving");
    cloud.resolve({ revision: 2 });
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
  });

  it("keeps the withdrawn page in memory on local failure without confirming success", async () => {
    const { coordinator, io, disk, input, data, token } = await setup();
    vi.mocked(io.saveLocal).mockRejectedValueOnce(new Error("IndexedDB quota reached"));
    await expect(persistKnowledgeUpdateWithdrawal(input)).rejects.toThrow("尚未保存到此浏览器");
    expect(coordinator.getSnapshot().data.notes[0].content).toBe(original);
    expect(coordinator.getSnapshot().status).toBe("error");
    expect(coordinator.hasUnsavedLocalChanges()).toBe(true);
    expect(disk.get(accountA.id)?.notes[0].content).toBe(data.notes[0].content);
    expect(io.saveCloud).not.toHaveBeenCalled();
    await coordinator.retry(token);
    expect(disk.get(accountA.id)?.notes[0].content).toBe(original);
  });

  it("rejects an A→B→A return after delayed local persistence without changing B", async () => {
    const { coordinator, io, disk, input, token } = await setup(),
      local = deferred<void>();
    vi.mocked(io.saveLocal).mockImplementationOnce(async (value, id = "local") => {
      await local.promise;
      disk.set(id, structuredClone(value));
    });
    const outcome = persistKnowledgeUpdateWithdrawal(input).catch((error: unknown) => error);
    await vi.waitFor(() => expect(io.saveLocal).toHaveBeenCalledOnce());
    await coordinator.activate(accountB);
    const b = structuredClone(coordinator.getSnapshot().data);
    const returning = coordinator.activate(accountA);
    expect(coordinator.getSnapshot().token).not.toBe(token);
    local.resolve();
    expect(await outcome).toBeInstanceOf(Error);
    await returning;
    expect(disk.get(accountB.id)?.notes).toEqual(b.notes);
    expect(coordinator.getSnapshot().user?.id).toBe(accountA.id);
  });

  it.each(["history", "manual excerpt"])(
    "rejects %s changes during asynchronous preparation",
    async (kind) => {
      const { coordinator, io, input, token, data } = await setup(),
        hashing = deferred<void>();
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
        await hashing.promise;
        return digest(...args);
      });
      const outcome = persistKnowledgeUpdateWithdrawal(input).catch((error: unknown) => error);
      await vi.waitFor(() => expect(crypto.subtle.digest).toHaveBeenCalledOnce());
      coordinator.update((current) => {
        const next = structuredClone(current),
          note = next.notes[0];
        if (kind === "history")
          note.versions.push({
            id: "independent-history",
            title: note.title,
            content: "独立保存的历史",
            savedAt: note.updatedAt,
          });
        else {
          const source = next.sources[1];
          note.manualExcerptRefs = [
            {
              sourceId: source.id,
              versionId: source.versionId,
              chunkId: source.chunks[0].id,
              selectionFingerprint: "a".repeat(16),
            },
          ];
        }
        return next;
      }, token);
      hashing.resolve();
      expect(await outcome).toBeInstanceOf(Error);
      expect(coordinator.getSnapshot().data.notes[0].content).toBe(data.notes[0].content);
      expect(
        coordinator.getSnapshot().data.organizationJobs![0].updateReview?.withdrawal,
      ).toBeUndefined();
      await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
      expect(io.saveLocal).toHaveBeenCalled();
    },
  );

  it("orders a later durable edit after withdrawal without reverting the disk to its old snapshot", async () => {
    const { coordinator, io, disk, input, token } = await setup(),
      firstSave = deferred<void>(),
      secondSave = deferred<void>();
    vi.mocked(io.saveLocal)
      .mockImplementationOnce(async (value, id = "local") => {
        await firstSave.promise;
        disk.set(id, structuredClone(value));
      })
      .mockImplementationOnce(async (value, id = "local") => {
        await secondSave.promise;
        disk.set(id, structuredClone(value));
      });
    const withdrawal = persistKnowledgeUpdateWithdrawal(input);
    await vi.waitFor(() => expect(io.saveLocal).toHaveBeenCalledOnce());
    const edit = coordinator.updateDurably(
      (current) => ({
        ...current,
        notes: current.notes.map((note) =>
          note.id === noteId
            ? reviseNote(note, { content: note.content + "<p>撤回后继续独立编辑。</p>" })
            : note,
        ),
      }),
      token,
    );
    firstSave.resolve();
    await withdrawal;
    await vi.waitFor(() => expect(io.saveLocal).toHaveBeenCalledTimes(2));
    expect(disk.get(accountA.id)?.notes[0].content).toBe(original);
    expect(coordinator.getSnapshot().data.notes[0].content).toContain("继续独立编辑");
    secondSave.resolve();
    await edit;
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
    expect(disk.get(accountA.id)?.notes[0].content).toBe(original + "<p>撤回后继续独立编辑。</p>");
  });
});
