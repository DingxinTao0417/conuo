import { describe, expect, it, vi } from "vitest";
import { WorkspaceCoordinator, type WorkspaceIO } from "./use-workspace";
import { automaticCandidates, type OrganizationInput } from "./organization-runner";
import { organizationContextKey, organizationReviewReason } from "./organization";
import { knowledgeBlocks, snapshotKnowledgeNote } from "./knowledge-update";
import { createDemoWorkspace } from "./seed";
import type { OrganizationRequest, OrganizationResult } from "./organization-types";
import type { Citation, Note, WorkspaceData } from "./types";

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

const account = { id: "update-owner", email: "update@example.com" };
type UpdateResult = Extract<OrganizationResult, { kind: "update" }>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function updateResult(data: WorkspaceData, request: OrganizationRequest): UpdateResult {
  const note = data.notes.find((item) => item.id === request.targetNote?.id)!;
  return {
    kind: "update",
    mode: "model",
    target: snapshotKnowledgeNote(note),
    changes: [],
    coverage: "当前资料范围未提供需要修改知识页的新增依据。",
  };
}
function sourceCitation(data: WorkspaceData, sourceIndex = 0): Citation {
  const source = data.sources[sourceIndex];
  const chunk = source.chunks[0];
  return {
    sourceId: source.id,
    versionId: source.versionId,
    chunkId: chunk.id,
    title: source.title,
    quote: chunk.text,
    page: chunk.page,
    section: chunk.section,
  };
}
function changedResult(data: WorkspaceData, request: OrganizationRequest): UpdateResult {
  const result = updateResult(data, request);
  const block = knowledgeBlocks(result.target.content)[0];
  result.changes = [
    {
      id: "supplement-1",
      type: "insert_after",
      blockId: block.id,
      before: block.html,
      after: "学习率过高可能导致损失振荡。",
      reason: "补充所选资料中的说明。",
      citations: [sourceCitation(data)],
    },
  ];
  return result;
}
async function setup() {
  const data = createDemoWorkspace();
  const note: Note = {
    id: "target-knowledge",
    spaceId: data.spaces[0].id,
    title: "学习率知识页",
    content: "<p>学习率决定每次参数更新的步长。</p><p>学习率太大可能导致损失振荡。</p>",
    kind: "knowledge",
    status: "accepted",
    aiGenerated: false,
    contentRevision: 3,
    citations: [],
    versions: [],
    createdAt: "2026-09-12T10:00:00.000Z",
    updatedAt: "2026-09-12T10:02:00.000Z",
    deletedAt: null,
  };
  data.notes = [note, { ...structuredClone(note), id: "other-knowledge", title: "另一份知识页" }];
  const disk = new Map<string, WorkspaceData>();
  const cloud = new Map<string, { data: WorkspaceData; revision: number }>([
    [account.id, { data: structuredClone(data), revision: 1 }],
  ]);
  const saveCloud: WorkspaceIO["saveCloud"] = async (snapshot, revision, id) => {
    if ((cloud.get(id)?.revision ?? 0) !== revision) throw new Error("409 conflict");
    cloud.set(id, { data: structuredClone(snapshot), revision: revision + 1 });
    return { revision: revision + 1 };
  };
  const io: WorkspaceIO = {
    loadLocal: vi.fn(async (id = "local") => structuredClone(disk.get(id) ?? null)),
    saveLocal: vi.fn(async (snapshot, id = "local") => {
      disk.set(id, structuredClone(snapshot));
    }),
    loadCloud: vi.fn(async (id) => structuredClone(cloud.get(id) ?? { data: null, revision: 0 })),
    saveCloud: vi.fn(saveCloud),
    getBlob: vi.fn(async () => undefined),
    uploadBlob: vi.fn(async () => "unused"),
    downloadBlob: vi.fn(async () => undefined),
    askCloud: vi.fn(async () => ({
      content: "检索结果",
      citations: [],
      mode: "extractive" as const,
    })),
    getModelStatus: vi.fn(async () => ({ mode: "model", message: "模型已配置" })),
    organizeCloud: vi.fn(async (request) => updateResult(cloud.get(account.id)!.data, request)),
    readLegacyMeta: vi.fn(() => null),
  };
  const coordinator = new WorkspaceCoordinator(io);
  await coordinator.activate(account);
  const token = coordinator.getSnapshot().token;
  const input: OrganizationInput = {
    kind: "update",
    spaceId: data.spaces[0].id,
    sourceIds: data.sources.map((source) => source.id),
    targetNoteId: note.id,
    topic: "检查学习率的解释",
  };
  const request: OrganizationRequest = {
    kind: "update",
    requestId: "update-request",
    trigger: "manual",
    spaceId: input.spaceId,
    sourceIds: [...input.sourceIds],
    sourceVersions: data.sources.map((source) => ({
      sourceId: source.id,
      versionId: source.versionId,
    })),
    topic: input.topic,
    targetNote: { id: note.id, revision: note.contentRevision!, updatedAt: note.updatedAt },
  };
  const change = (mutate: (data: WorkspaceData) => void) => {
    coordinator.update((current) => {
      const next = structuredClone(current);
      mutate(next);
      return next;
    }, token);
  };
  return { data, note, coordinator, io, disk, cloud, saveCloud, token, input, request, change };
}
function observe(promise: Promise<void>) {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe("knowledge update coordinator baselines", () => {
  it("uses the current note baseline and permits no-change results without modifying the note", async () => {
    const { coordinator, io, disk, input, token, data, note } = await setup();
    await coordinator.organize(
      {
        ...input,
        targetNote: { id: "forged-note", revision: 999, updatedAt: note.updatedAt },
        content: "调用者提供的假正文",
      } as OrganizationInput,
      undefined,
      token,
    );
    const sent = vi.mocked(io.organizeCloud).mock.calls[0][0];
    expect(sent.targetNote).toEqual({ id: note.id, revision: 3, updatedAt: note.updatedAt });
    expect(sent).not.toHaveProperty("targetNoteId");
    expect(sent).not.toHaveProperty("content");
    expect(sent.sourceIds).toHaveLength(2);
    const job = coordinator.getSnapshot().data.organizationJobs![0];
    expect(job).toMatchObject({ status: "ready", result: { kind: "update", changes: [] } });
    expect(disk.get(account.id)?.organizationJobs?.[0].result).toEqual(job.result);
    expect(coordinator.getSnapshot().data.notes).toEqual(data.notes);
    expect(
      automaticCandidates({ ...coordinator.getSnapshot().data, autoOrganize: true }),
    ).toHaveLength(2);
  });

  it.each([
    [
      "missing target",
      (data: WorkspaceData) => {
        data.notes = [];
      },
    ],
    [
      "deleted target",
      (data: WorkspaceData) => {
        data.notes[0].deletedAt = "2026-09-12T10:03:00.000Z";
      },
    ],
    [
      "moved target",
      (data: WorkspaceData) => {
        data.notes[0].spaceId = "other-space";
      },
    ],
    [
      "ordinary note",
      (data: WorkspaceData) => {
        data.notes[0].kind = "note";
      },
    ],
  ] as const)("rejects %s before any model call", async (_label, mutate) => {
    const { coordinator, io, input, token, change } = await setup();
    change(mutate);
    await expect(coordinator.organize(input, undefined, token)).rejects.toThrow();
    expect(io.organizeCloud).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().data.organizationJobs).toBeUndefined();
  });

  const targetMutations: [string, (data: WorkspaceData) => void][] = [
    [
      "body changed without revision",
      (data) => {
        data.notes[0].content += "<p>刚修改的正文。</p>";
      },
    ],
    [
      "title changed",
      (data) => {
        data.notes[0].title = "新的标题";
      },
    ],
    [
      "revision changed after restoring identical text",
      (data) => {
        data.notes[0].contentRevision!++;
      },
    ],
    [
      "updatedAt changed",
      (data) => {
        data.notes[0].updatedAt = "2026-09-12T10:03:00.000Z";
      },
    ],
    [
      "review status changed",
      (data) => {
        data.notes[0].status = "draft";
      },
    ],
    [
      "AI provenance changed",
      (data) => {
        data.notes[0].aiGenerated = true;
      },
    ],
    [
      "target citations changed",
      (data) => {
        data.notes[0].citations.push(sourceCitation(data));
      },
    ],
    [
      "target moved",
      (data) => {
        data.notes[0].spaceId = "other-space";
      },
    ],
    [
      "target deleted",
      (data) => {
        data.notes[0].deletedAt = "2026-09-12T10:03:00.000Z";
      },
    ],
    [
      "target removed",
      (data) => {
        data.notes.shift();
      },
    ],
    [
      "target changed kind",
      (data) => {
        data.notes[0].kind = "note";
      },
    ],
    [
      "global AI revoked",
      (data) => {
        data.aiEnabled = false;
      },
    ],
    [
      "source AI revoked",
      (data) => {
        data.sources[0].aiAllowed = false;
      },
    ],
  ];
  it.each(targetMutations)("cancels a delayed response when %s", async (_label, mutate) => {
    const { coordinator, io, input, token, change, data } = await setup();
    const model = deferred<OrganizationResult>();
    vi.mocked(io.organizeCloud).mockReturnValueOnce(model.promise);
    const outcome = observe(coordinator.organize(input, undefined, token));
    await vi.waitFor(() => expect(io.organizeCloud).toHaveBeenCalledOnce());
    const [request, signal] = vi.mocked(io.organizeCloud).mock.calls[0];
    change(mutate);
    expect(signal?.aborted).toBe(true);
    expect(await outcome).toBeInstanceOf(Error);
    model.resolve(updateResult(data, request));
    await Promise.resolve();
    await Promise.resolve();
    expect(coordinator.getSnapshot().data.organizationJobs?.[0]).toMatchObject({
      status: "cancelled",
      result: undefined,
    });
  });

  it("does not cancel a request for another note edit or revision-history bookkeeping", async () => {
    const { coordinator, io, input, token, change, data } = await setup();
    const model = deferred<OrganizationResult>();
    vi.mocked(io.organizeCloud).mockReturnValueOnce(model.promise);
    const outcome = coordinator.organize(input, undefined, token);
    await vi.waitFor(() => expect(io.organizeCloud).toHaveBeenCalledOnce());
    const [request, signal] = vi.mocked(io.organizeCloud).mock.calls[0];
    change((next) => {
      next.notes[1].content = "<p>另一个主题的新内容。</p>";
      next.notes[1].contentRevision!++;
      next.notes[0].versions.push({
        id: "history-only",
        title: "旧标题",
        content: "<p>旧正文</p>",
        savedAt: data.notes[0].createdAt,
      });
    });
    expect(signal?.aborted).toBe(false);
    model.resolve(updateResult(data, request));
    await outcome;
    expect(coordinator.getSnapshot().data.organizationJobs?.[0].status).toBe("ready");
    expect(coordinator.getSnapshot().data.notes[1].content).toContain("另一个主题");
  });

  it("stops before provider disclosure when the target is edited during the model status check", async () => {
    const { coordinator, io, input, token, change } = await setup();
    const status = deferred<{ mode: "model"; message: string }>();
    vi.mocked(io.getModelStatus).mockReturnValueOnce(status.promise);
    const outcome = observe(coordinator.organize(input, undefined, token));
    await vi.waitFor(() => expect(io.getModelStatus).toHaveBeenCalledOnce());
    change((next) => {
      next.notes[0].contentRevision!++;
    });
    expect(await outcome).toBeInstanceOf(Error);
    status.resolve({ mode: "model", message: "模型已配置" });
    await Promise.resolve();
    expect(io.organizeCloud).not.toHaveBeenCalled();
  });

  it.each([
    [
      "content",
      (result: UpdateResult) => {
        result.target.content = "<p>错误基线正文</p>";
      },
    ],
    [
      "title",
      (result: UpdateResult) => {
        result.target.title = "错误基线标题";
      },
    ],
    [
      "revision",
      (result: UpdateResult) => {
        result.target.revision++;
      },
    ],
    [
      "updatedAt",
      (result: UpdateResult) => {
        result.target.updatedAt = "2026-09-12T10:03:00.000Z";
      },
    ],
    [
      "status",
      (result: UpdateResult) => {
        result.target.status = "draft";
      },
    ],
    [
      "provenance",
      (result: UpdateResult) => {
        result.target.aiGenerated = true;
      },
    ],
    [
      "space",
      (result: UpdateResult) => {
        result.target.spaceId = "other-space";
      },
    ],
    [
      "id",
      (result: UpdateResult) => {
        result.target.id = "other-knowledge";
      },
    ],
    [
      "citations",
      (result: UpdateResult) => {
        result.target.citations.push({
          sourceId: "wrong-source",
          versionId: "wrong-version",
          chunkId: "wrong-chunk",
          title: "假引用",
          quote: "假引用正文",
          section: "正文",
        });
      },
    ],
  ] as const)("rejects a response with forged baseline %s", async (_field, mutate) => {
    const { coordinator, io, input, token, data } = await setup();
    vi.mocked(io.organizeCloud).mockImplementationOnce(async (request) => {
      const result = updateResult(data, request);
      mutate(result);
      return result;
    });
    await expect(coordinator.organize(input, undefined, token)).rejects.toThrow("目标知识页");
    expect(coordinator.getSnapshot().data.organizationJobs?.[0]).toMatchObject({
      status: "failed",
      result: undefined,
    });
  });

  it("checks the cached response baseline and retries with the latest note revision", async () => {
    const { coordinator, io, input, token, data, change } = await setup();
    vi.mocked(io.organizeCloud).mockRejectedValueOnce(new Error("连接中断"));
    await expect(coordinator.organize(input, undefined, token)).rejects.toThrow("连接中断");
    const job = coordinator.getSnapshot().data.organizationJobs![0];
    vi.mocked(io.organizeCloud).mockImplementationOnce(async (request) => {
      const result = updateResult(data, request);
      result.target.content += "<p>缓存的错误正文</p>";
      return result;
    });
    await expect(coordinator.checkOrganization(job.id, token)).rejects.toThrow("目标知识页");
    expect(vi.mocked(io.organizeCloud).mock.calls[1][0].requestId).toBe(job.id);
    change((next) => {
      next.notes[0].contentRevision = 4;
      next.notes[0].content += "<p>用户新补充的内容</p>";
      next.notes[0].updatedAt = "2026-09-12T10:03:00.000Z";
    });
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
    await expect(coordinator.checkOrganization(job.id, token)).rejects.toThrow();
    expect(io.organizeCloud).toHaveBeenCalledTimes(2);
    await coordinator.retryOrganization(job.id, token);
    const retried = vi.mocked(io.organizeCloud).mock.calls[2][0];
    expect(retried.requestId).not.toBe(job.id);
    expect(retried.targetNote).toEqual({
      id: input.targetNoteId,
      revision: 4,
      updatedAt: "2026-09-12T10:03:00.000Z",
    });
    expect(coordinator.getSnapshot().data.organizationJobs?.[1].status).toBe("ready");
  });

  it("accepts valid changes citing a subset of selected sources without applying them", async () => {
    const { coordinator, io, input, token, data } = await setup();
    vi.mocked(io.organizeCloud).mockImplementationOnce(async (request) =>
      changedResult(data, request),
    );
    await coordinator.organize(input, undefined, token);
    const job = coordinator.getSnapshot().data.organizationJobs![0];
    expect(job).toMatchObject({
      status: "ready",
      result: { kind: "update", changes: [{ id: "supplement-1" }] },
    });
    expect(input.sourceIds).toHaveLength(2);
    expect(coordinator.getSnapshot().data.notes).toEqual(data.notes);
  });

  it.each([
    [
      "unknown block",
      (result: UpdateResult) => {
        result.changes[0].blockId = "b99";
      },
    ],
    [
      "wrong before HTML",
      (result: UpdateResult) => {
        result.changes[0].before = "<p>另外的段落</p>";
      },
    ],
    [
      "overlapping anchors",
      (result: UpdateResult) => {
        result.changes.push({ ...structuredClone(result.changes[0]), id: "supplement-2" });
      },
    ],
    [
      "no-op replacement",
      (result: UpdateResult) => {
        result.changes[0].type = "replace";
        result.changes[0].after = knowledgeBlocks(result.target.content)[0].text;
      },
    ],
  ] as const)("rejects semantically invalid changes: %s", async (_label, mutate) => {
    const { coordinator, io, input, token, data } = await setup();
    vi.mocked(io.organizeCloud).mockImplementationOnce(async (request) => {
      const result = changedResult(data, request);
      mutate(result);
      return result;
    });
    await expect(coordinator.organize(input, undefined, token)).rejects.toThrow("目标知识页");
    expect(coordinator.getSnapshot().data.organizationJobs?.[0].result).toBeUndefined();
  });

  it.each([
    [
      "source boundary",
      (citation: Citation) => {
        citation.sourceId = "outside-source";
      },
    ],
    [
      "source version",
      (citation: Citation) => {
        citation.versionId = "old-version";
      },
    ],
    [
      "chunk quote",
      (citation: Citation) => {
        citation.quote = "这段文字不在任何资料中。";
      },
    ],
    [
      "title",
      (citation: Citation) => {
        citation.title = "伪造标题";
      },
    ],
    [
      "page",
      (citation: Citation) => {
        citation.page = 999;
      },
    ],
    [
      "section",
      (citation: Citation) => {
        citation.section = "不正确的章节";
      },
    ],
  ] as const)("rejects noncanonical update citation %s", async (_label, mutate) => {
    const { coordinator, io, input, token, data } = await setup();
    vi.mocked(io.organizeCloud).mockImplementationOnce(async (request) => {
      const result = changedResult(data, request);
      mutate(result.changes[0].citations[0]);
      return result;
    });
    await expect(coordinator.organize(input, undefined, token)).rejects.toThrow(
      "引用与当前资料不一致",
    );
    expect(coordinator.getSnapshot().data.organizationJobs?.[0].result).toBeUndefined();
  });

  it("waits for a newly created target to be acknowledged before sending its content", async () => {
    const { coordinator, io, input, token, change, saveCloud } = await setup();
    const acknowledged = deferred<void>();
    vi.mocked(io.saveCloud).mockImplementationOnce(async (...args) => {
      await acknowledged.promise;
      return saveCloud(...args);
    });
    change((next) => {
      next.notes.push({
        ...structuredClone(next.notes[0]),
        id: "new-target",
        contentRevision: undefined,
      });
    });
    const newInput = { ...input, targetNoteId: "new-target" };
    await expect(coordinator.organize(newInput, undefined, token)).rejects.toThrow("尚未同步");
    expect(io.organizeCloud).not.toHaveBeenCalled();
    acknowledged.resolve();
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
    await coordinator.organize(newInput, undefined, token);
    expect(vi.mocked(io.organizeCloud).mock.calls[0][0].targetNote?.revision).toBe(0);
  });

  it("requires cloud confirmation of the complete target, even if its revision was not bumped", async () => {
    const { coordinator, io, input, token, change, saveCloud } = await setup();
    const acknowledged = deferred<void>();
    vi.mocked(io.saveCloud).mockImplementationOnce(async (...args) => {
      await acknowledged.promise;
      return saveCloud(...args);
    });
    change((next) => {
      next.notes[0].content += "<p>尚未同步的正文</p>";
    });
    await expect(coordinator.organize(input, undefined, token)).rejects.toThrow("尚未同步");
    expect(io.organizeCloud).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().data.organizationJobs).toBeUndefined();
    acknowledged.resolve();
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
    await coordinator.organize(input, undefined, token);
    expect(coordinator.getSnapshot().data.organizationJobs?.[0].status).toBe("ready");
  });

  it("allows an unrelated note to remain unsynced while the target is already confirmed", async () => {
    const { coordinator, io, input, token, change, saveCloud } = await setup();
    const acknowledged = deferred<void>();
    vi.mocked(io.saveCloud).mockImplementationOnce(async (...args) => {
      await acknowledged.promise;
      return saveCloud(...args);
    });
    change((next) => {
      next.notes[1].content += "<p>其他主题未同步</p>";
    });
    await vi.waitFor(() => expect(io.saveCloud).toHaveBeenCalledOnce());
    await coordinator.organize(input, undefined, token);
    expect(coordinator.getSnapshot().data.organizationJobs?.[0].status).toBe("ready");
    expect(coordinator.getSnapshot().status).toBe("saving");
    acknowledged.resolve();
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
  });

  it("rejects late update responses after an account switch", async () => {
    const { coordinator, io, input, token, data } = await setup();
    const model = deferred<OrganizationResult>();
    vi.mocked(io.organizeCloud).mockReturnValueOnce(model.promise);
    const outcome = observe(coordinator.organize(input, undefined, token));
    await vi.waitFor(() => expect(io.organizeCloud).toHaveBeenCalledOnce());
    const [request, signal] = vi.mocked(io.organizeCloud).mock.calls[0];
    await coordinator.activate({ id: "other-owner", email: "other@example.com" });
    expect(await outcome).toBeInstanceOf(Error);
    expect(signal?.aborted).toBe(true);
    model.resolve(updateResult(data, request));
    await Promise.resolve();
    expect(coordinator.getSnapshot().data.organizationJobs).toBeUndefined();
    expect(coordinator.getSnapshot().data.notes).toEqual([]);
  });
});

describe("update context and review boundaries", () => {
  it("includes the full target snapshot but not unrelated notes or request IDs", async () => {
    const { data, request } = await setup();
    const key = organizationContextKey(data, request);
    const same = structuredClone(data);
    same.notes[1].title = "无关主题";
    same.notes[0].versions.push({
      id: "v1",
      title: "旧版本",
      content: "旧正文",
      savedAt: same.notes[0].createdAt,
    });
    expect(organizationContextKey(same, { ...request, requestId: "retry-id" })).toBe(key);
    same.notes[0].content += "<p>目标新正文</p>";
    expect(organizationContextKey(same, request)).not.toBe(key);
  });

  it("leaves target-baseline review to the update domain while still checking source boundaries", async () => {
    const { data, request } = await setup();
    const result = updateResult(data, request);
    const next = structuredClone(data);
    next.notes[0].content += "<p>另行修改过的知识页</p>";
    next.aiEnabled = false;
    const job = {
      id: request.requestId,
      request,
      result,
      status: "ready" as const,
      createdAt: data.notes[0].createdAt,
      updatedAt: data.notes[0].updatedAt,
    };
    expect(organizationReviewReason(next, job)).toBe("");
    next.sources[0].deletedAt = "2026-09-12T10:03:00.000Z";
    expect(organizationReviewReason(next, job)).toContain("删除");
  });
});
