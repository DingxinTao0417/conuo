import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceCoordinator, type WorkspaceIO } from "./use-workspace";
import {
  OrganizationRunner,
  automaticCandidates,
  automaticOrganizationRequest,
} from "./organization-runner";
import { createDemoWorkspace } from "./seed";
import { deleteLearningSpace } from "./space-lifecycle";
import type { OrganizationRequest, OrganizationResult } from "./organization-types";
import type { WorkspaceData } from "./types";

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
const account = { id: "owner-a", email: "a@example.com" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function modelResult(data: WorkspaceData, request: OrganizationRequest): OrganizationResult {
  const source = data.sources.find((item) => item.id === request.sourceIds[0])!;
  const chunk = source.chunks.find((item) => item.text.includes("学习率太大")) ?? source.chunks[0];
  const citation = {
    sourceId: source.id,
    versionId: source.versionId,
    chunkId: chunk.id,
    title: source.title,
    quote: chunk.text,
    section: chunk.section,
    page: chunk.page,
  };
  return {
    kind: "source",
    mode: "model",
    summary: {
      title: "学习率摘要",
      content: "学习率控制参数更新的步长。 [1]",
      citations: [citation],
    },
    tags: [{ label: "自动标签建议", citations: [citation] }],
    topics: [],
    coverage: "当前资料的已解析片段。",
  };
}
function knowledgeResult(data: WorkspaceData, request: OrganizationRequest): OrganizationResult {
  const source = modelResult(data, request);
  if (source.kind !== "source") throw new Error("expected source fixture");
  return {
    kind: "knowledge",
    mode: "model",
    pages: [source.summary],
    coverage: source.coverage,
  };
}
const runners: OrganizationRunner[] = [];
afterEach(() => {
  runners.splice(0).forEach((runner) => runner.stop());
  vi.unstubAllEnvs();
});
async function setup(
  autoOrganize = false,
  prepare?: (workspace: WorkspaceData) => void,
  capabilities?: {
    durableOrganizationProcessorEnabled?: boolean;
    localDevelopmentOrganizationRunnerEnabled?: boolean;
  },
) {
  const data = createDemoWorkspace();
  data.sources = [data.sources[0]];
  data.autoOrganize = autoOrganize;
  prepare?.(data);
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
    organizeCloud: vi.fn(async (request) => modelResult(cloud.get(account.id)!.data, request)),
    readLegacyMeta: vi.fn(() => null),
  };
  const coordinator = new WorkspaceCoordinator(io, undefined, capabilities);
  await coordinator.activate(account);
  const input = {
    kind: "source" as const,
    sourceIds: [data.sources[0].id],
    spaceId: data.spaces[0].id,
  };
  const startRunner = () => {
    const runner = new OrganizationRunner(coordinator);
    runners.push(runner);
    runner.start();
    return runner;
  };
  return { coordinator, io, disk, cloud, data, input, saveCloud, startRunner };
}
function token(coordinator: WorkspaceCoordinator) {
  return coordinator.getSnapshot().token;
}
function observe(promise: Promise<void>) {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe("organization coordinator persistence and disclosure boundaries", () => {
  it("does not create automatic or manual durable tasks until the processor is declared", async () => {
    const { coordinator, io, input } = await setup(true, undefined, {
      durableOrganizationProcessorEnabled: false,
    });
    const runner = new OrganizationRunner(coordinator, false);
    runners.push(runner);
    runner.start();

    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().organizationStatus.message).toContain(
        "后台自动整理等待部署",
      ),
    );
    expect(io.organizeCloud).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().data.organizationJobs).toBeUndefined();

    await expect(coordinator.organize(input, undefined, token(coordinator))).rejects.toThrow(
      "后台整理等待部署",
    );
    expect(io.organizeCloud).not.toHaveBeenCalled();
  });

  it.each(["source", "knowledge"] as const)(
    "runs a manually started %s task through the development page runner instead of enqueueing it",
    async (kind) => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("NEXT_PUBLIC_CONUO_LOCAL_ORGANIZATION_RUNNER_ENABLED", "true");
      const { coordinator, io, input, data } = await setup(false, undefined, {
        durableOrganizationProcessorEnabled: false,
        localDevelopmentOrganizationRunnerEnabled: true,
      });
      io.enqueueOrganizationJob = vi.fn(async () => {
        throw new Error("local development runner must not enqueue a durable task");
      });
      if (kind === "knowledge")
        vi.mocked(io.organizeCloud).mockImplementationOnce(async (request) =>
          knowledgeResult(data, request),
        );

      await coordinator.organize({ ...input, kind }, undefined, token(coordinator));

      expect(io.enqueueOrganizationJob).not.toHaveBeenCalled();
      expect(io.organizeCloud).toHaveBeenCalledOnce();
      const job = coordinator.getSnapshot().data.organizationJobs?.[0];
      expect(job).not.toHaveProperty("durable");
      expect(job).toMatchObject({
        status: "ready",
        request: { kind, trigger: "manual" },
      });
    },
  );

  it("keeps source/knowledge fail-closed in production even if a caller supplies the local capability", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_CONUO_LOCAL_ORGANIZATION_RUNNER_ENABLED", "true");
    const { coordinator, io, input } = await setup(false, undefined, {
      durableOrganizationProcessorEnabled: false,
      localDevelopmentOrganizationRunnerEnabled: true,
    });

    await expect(coordinator.organize(input, undefined, token(coordinator))).rejects.toThrow(
      "后台整理等待部署",
    );
    expect(io.getModelStatus).not.toHaveBeenCalled();
    expect(io.organizeCloud).not.toHaveBeenCalled();
  });

  it("rejects automatic source work in the development page runner before reserving a model call", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_CONUO_LOCAL_ORGANIZATION_RUNNER_ENABLED", "true");
    const { coordinator, io, input, data } = await setup(false, undefined, {
      durableOrganizationProcessorEnabled: false,
      localDevelopmentOrganizationRunnerEnabled: true,
    });
    const source = data.sources[0]!;
    await expect(
      coordinator.runAutomaticOrganization(
        {
          requestId: "development-local-automatic",
          kind: "source",
          trigger: "automatic",
          spaceId: input.spaceId,
          sourceIds: [source.id],
          sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
        },
        new AbortController().signal,
        token(coordinator),
      ),
    ).rejects.toThrow("只支持用户手动发起");
    expect(io.getModelStatus).not.toHaveBeenCalled();
    expect(io.organizeCloud).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().data.organizationJobs).toBeUndefined();
  });

  it("stops an in-flight development page task when the page lifecycle stops organizations", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_CONUO_LOCAL_ORGANIZATION_RUNNER_ENABLED", "true");
    const { coordinator, io, input, data } = await setup(false, undefined, {
      durableOrganizationProcessorEnabled: false,
      localDevelopmentOrganizationRunnerEnabled: true,
    });
    const model = deferred<OrganizationResult>();
    vi.mocked(io.organizeCloud).mockReturnValueOnce(model.promise);
    const outcome = observe(coordinator.organize(input, undefined, token(coordinator)));

    await vi.waitFor(() => expect(io.organizeCloud).toHaveBeenCalledOnce());
    coordinator.stopOrganizations();

    expect(vi.mocked(io.organizeCloud).mock.calls[0][1]?.aborted).toBe(true);
    expect((await outcome) as Error).toMatchObject({ name: "AbortError" });
    const job = coordinator.getSnapshot().data.organizationJobs?.[0];
    expect(job).not.toHaveProperty("durable");
    expect(job).toMatchObject({
      status: "cancelled",
      result: undefined,
    });
    model.resolve(modelResult(data, vi.mocked(io.organizeCloud).mock.calls[0][0]));
  });

  it("persists a reviewed-later result using canonical versions and leaves manual tags untouched", async () => {
    const { coordinator, io, disk, input, data } = await setup();
    await coordinator.organize(input, undefined, token(coordinator));
    const job = coordinator.getSnapshot().data.organizationJobs![0];
    expect(job.status).toBe("ready");
    expect(job.request.trigger).toBe("manual");
    expect(job.request.sourceVersions).toEqual([
      { sourceId: data.sources[0].id, versionId: data.sources[0].versionId },
    ]);
    expect(disk.get(account.id)?.organizationJobs?.[0].result).toEqual(job.result);
    expect(coordinator.getSnapshot().data.sources[0].tags).toEqual(data.sources[0].tags);
    expect(coordinator.getSnapshot().data.notes).toEqual([]);
    expect(io.organizeCloud).toHaveBeenCalledOnce();
  });

  it("does not disclose evidence before the request attempt is durably recorded locally", async () => {
    const { coordinator, io, disk, input } = await setup();
    const local = deferred<void>();
    vi.mocked(io.saveLocal).mockImplementationOnce(async (snapshot, id = "local") => {
      await local.promise;
      disk.set(id, structuredClone(snapshot));
    });
    const pending = coordinator.organize(input, undefined, token(coordinator));
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().data.organizationJobs?.[0].status).toBe("queued"),
    );
    expect(io.organizeCloud).not.toHaveBeenCalled();
    local.resolve();
    await pending;
    expect(io.organizeCloud).toHaveBeenCalledOnce();
  });

  it("fails before calling the model when the local attempt record cannot be saved", async () => {
    const { coordinator, io, input } = await setup();
    vi.mocked(io.saveLocal).mockRejectedValue(new Error("磁盘写入失败"));
    await expect(coordinator.organize(input, undefined, token(coordinator))).rejects.toThrow(
      "磁盘写入失败",
    );
    expect(io.organizeCloud).not.toHaveBeenCalled();
    expect(coordinator.hasUnsavedLocalChanges()).toBe(true);
  });

  it("allows job metadata still syncing while already confirmed evidence is analyzed", async () => {
    const { coordinator, io, input, saveCloud } = await setup();
    const cloudWrite = deferred<void>();
    vi.mocked(io.saveCloud).mockImplementationOnce(async (...args) => {
      await cloudWrite.promise;
      return saveCloud(...args);
    });
    await coordinator.organize(input, undefined, token(coordinator));
    expect(io.organizeCloud).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot().data.organizationJobs?.[0].status).toBe("ready");
    expect(coordinator.getSnapshot().status).toBe("saving");
    cloudWrite.resolve();
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
  });

  it("refuses source text that has not been acknowledged by cloud", async () => {
    const { coordinator, io, input } = await setup();
    coordinator.update(
      (data) => ({
        ...data,
        sources: data.sources.map((source) => ({ ...source, text: source.text + "新证据" })),
      }),
      token(coordinator),
    );
    await expect(coordinator.organize(input, undefined, token(coordinator))).rejects.toThrow(
      "尚未同步",
    );
    expect(io.organizeCloud).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().data.organizationJobs).toBeUndefined();
  });

  it("does not call the organization endpoint with an unconfigured model", async () => {
    const { coordinator, io, input } = await setup();
    vi.mocked(io.getModelStatus).mockResolvedValue({
      mode: "extractive",
      message: "未配置生成模型",
    });
    await expect(coordinator.organize(input, undefined, token(coordinator))).rejects.toThrow(
      "未配置",
    );
    expect(io.organizeCloud).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().data.organizationJobs?.[0].status).toBe("failed");
  });

  const changes: [string, (data: WorkspaceData) => void][] = [
    [
      "deleted source",
      (data) => {
        data.sources[0].deletedAt = new Date().toISOString();
      },
    ],
    [
      "revoked source permission",
      (data) => {
        data.sources[0].aiAllowed = false;
      },
    ],
    [
      "global AI shutdown",
      (data) => {
        data.aiEnabled = false;
      },
    ],
    [
      "replacement version",
      (data) => {
        data.sources[0].versionId = "replacement-version";
      },
    ],
    [
      "changed space membership",
      (data) => {
        data.sources[0].spaceIds = [];
      },
    ],
  ];
  it.each(changes)(
    "cancels %s immediately and does not publish a late result",
    async (_label, mutate) => {
      const { coordinator, io, input, data } = await setup();
      const model = deferred<OrganizationResult>();
      vi.mocked(io.organizeCloud).mockReturnValueOnce(model.promise);
      const outcome = observe(coordinator.organize(input, undefined, token(coordinator)));
      await vi.waitFor(() => expect(io.organizeCloud).toHaveBeenCalledOnce());
      const request = vi.mocked(io.organizeCloud).mock.calls[0][0];
      coordinator.update((data) => {
        const next = structuredClone(data);
        mutate(next);
        return next;
      }, token(coordinator));
      expect(vi.mocked(io.organizeCloud).mock.calls[0][1]?.aborted).toBe(true);
      expect(await outcome).toBeInstanceOf(Error);
      model.resolve(modelResult(data, request));
      await Promise.resolve();
      await Promise.resolve();
      expect(coordinator.getSnapshot().data.organizationJobs?.[0]).toMatchObject({
        status: "cancelled",
        result: undefined,
      });
    },
  );

  it("keeps a shared-source job running when a different learning space is deleted", async () => {
    const removedSpaceId = "removed-space";
    const { coordinator, io, input, data } = await setup(false, (workspace) => {
      workspace.spaces.push({
        ...workspace.spaces[0],
        id: removedSpaceId,
        name: "将删除的知识库",
      });
      workspace.sources[0].spaceIds.push(removedSpaceId);
    });
    const model = deferred<OrganizationResult>();
    vi.mocked(io.organizeCloud).mockReturnValueOnce(model.promise);
    const outcome = observe(coordinator.organize(input, undefined, token(coordinator)));
    await vi.waitFor(() => expect(io.organizeCloud).toHaveBeenCalledOnce());
    const request = vi.mocked(io.organizeCloud).mock.calls[0][0];

    coordinator.update(
      (workspace) =>
        deleteLearningSpace(workspace, removedSpaceId, { recycleExclusiveSources: true }),
      token(coordinator),
    );

    expect(vi.mocked(io.organizeCloud).mock.calls[0][1]?.aborted).toBe(false);
    expect(coordinator.getSnapshot().data.sources[0]).toMatchObject({
      spaceIds: [input.spaceId],
      deletedAt: null,
    });
    model.resolve(modelResult(data, request));
    expect(await outcome).toBeNull();
    expect(coordinator.getSnapshot().data.organizationJobs?.[0]).toMatchObject({ status: "ready" });
  });

  it("cancels an in-flight organization request when its own learning space is deleted", async () => {
    const { coordinator, io, input, data } = await setup();
    const model = deferred<OrganizationResult>();
    vi.mocked(io.organizeCloud).mockReturnValueOnce(model.promise);
    const outcome = observe(coordinator.organize(input, undefined, token(coordinator)));
    await vi.waitFor(() => expect(io.organizeCloud).toHaveBeenCalledOnce());
    const request = vi.mocked(io.organizeCloud).mock.calls[0][0];

    coordinator.update(
      (workspace) => deleteLearningSpace(workspace, input.spaceId),
      token(coordinator),
    );

    expect(vi.mocked(io.organizeCloud).mock.calls[0][1]?.aborted).toBe(true);
    expect(await outcome).toBeInstanceOf(Error);
    expect(coordinator.getSnapshot().data.spaces).toHaveLength(0);
    expect(
      coordinator.getSnapshot().data.organizationJobs?.some((job) => job.id === request.requestId),
    ).toBe(false);

    model.resolve(modelResult(data, request));
    await Promise.resolve();
    await Promise.resolve();
    expect(
      coordinator.getSnapshot().data.organizationJobs?.some((job) => job.id === request.requestId),
    ).toBe(false);
  });

  it("preserves cancellation across account changes and does not write the other account", async () => {
    const { coordinator, io, input, data } = await setup();
    const model = deferred<OrganizationResult>();
    vi.mocked(io.organizeCloud).mockReturnValueOnce(model.promise);
    const outcome = observe(coordinator.organize(input, undefined, token(coordinator)));
    await vi.waitFor(() => expect(io.organizeCloud).toHaveBeenCalledOnce());
    const request = vi.mocked(io.organizeCloud).mock.calls[0][0];
    await coordinator.activate({ id: "owner-b", email: "b@example.com" });
    expect(await outcome).toBeInstanceOf(Error);
    expect(vi.mocked(io.organizeCloud).mock.calls[0][1]?.aborted).toBe(true);
    model.resolve(modelResult(data, request));
    await Promise.resolve();
    expect(coordinator.getSnapshot().data.organizationJobs).toBeUndefined();
  });

  it("stops manually and honors external abort even if the provider ignores it", async () => {
    const { coordinator, io, input, data } = await setup();
    const model = deferred<OrganizationResult>();
    vi.mocked(io.organizeCloud).mockReturnValueOnce(model.promise);
    const controller = new AbortController();
    const outcome = observe(coordinator.organize(input, controller.signal, token(coordinator)));
    await vi.waitFor(() => expect(io.organizeCloud).toHaveBeenCalledOnce());
    controller.abort();
    expect(((await outcome) as Error).name).toBe("AbortError");
    expect(coordinator.getSnapshot().data.organizationJobs?.[0].status).toBe("cancelled");
    model.resolve(modelResult(data, vi.mocked(io.organizeCloud).mock.calls[0][0]));
  });

  it("rejects result citations from outside the chosen sources", async () => {
    const { coordinator, io, input, data } = await setup();
    vi.mocked(io.organizeCloud).mockImplementationOnce(async (request) => {
      const result = modelResult(data, request);
      if (result.kind === "source") result.summary.citations[0].sourceId = "other-source";
      return result;
    });
    await expect(coordinator.organize(input, undefined, token(coordinator))).rejects.toThrow(
      "引用与当前资料不一致",
    );
    expect(coordinator.getSnapshot().data.organizationJobs?.[0].status).toBe("failed");
  });

  it("uses the same ID to continue but a new manual ID when explicitly regenerating", async () => {
    const { coordinator, io, input } = await setup();
    vi.mocked(io.organizeCloud).mockRejectedValueOnce(new Error("连接中断"));
    await expect(coordinator.organize(input, undefined, token(coordinator))).rejects.toThrow(
      "连接中断",
    );
    const id = coordinator.getSnapshot().data.organizationJobs![0].id;
    await coordinator.checkOrganization(id, token(coordinator));
    expect(vi.mocked(io.organizeCloud).mock.calls[1][0].requestId).toBe(id);
    await coordinator.retryOrganization(id, token(coordinator));
    expect(vi.mocked(io.organizeCloud).mock.calls[2][0].requestId).not.toBe(id);
    expect(vi.mocked(io.organizeCloud).mock.calls[2][0].trigger).toBe("manual");
    expect(coordinator.getSnapshot().data.organizationJobs).toHaveLength(2);
  });
});

describe("organization persistence and scheduler regressions", () => {
  it("shows a local persistence error even while the normal save pump awaits cloud", async () => {
    const { coordinator, io, input, saveCloud } = await setup();
    const cloudWrite = deferred<void>();
    vi.mocked(io.saveCloud).mockImplementationOnce(async (...args) => {
      await cloudWrite.promise;
      return saveCloud(...args);
    });
    coordinator.update(
      (data) => ({ ...data, sources: data.sources.map((source) => ({ ...source, readPage: 2 })) }),
      token(coordinator),
    );
    await vi.waitFor(() => expect(io.saveCloud).toHaveBeenCalledOnce());
    vi.mocked(io.saveLocal).mockRejectedValue(new Error("本地存储已满"));
    await expect(coordinator.organize(input, undefined, token(coordinator))).rejects.toThrow(
      "本地存储已满",
    );
    expect(io.organizeCloud).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot()).toMatchObject({
      status: "error",
      error: expect.stringContaining("尚未保存到此浏览器"),
    });
    expect(coordinator.hasUnsavedLocalChanges()).toBe(true);
    cloudWrite.resolve();
  });

  it.each(["page", "section"] as const)(
    "rejects an inaccurate citation %s locator",
    async (field) => {
      const { coordinator, io, input, data } = await setup();
      vi.mocked(io.organizeCloud).mockImplementationOnce(async (request) => {
        const result = modelResult(data, request);
        if (result.kind === "source") {
          if (field === "page") result.summary.citations[0].page = 999;
          else result.summary.citations[0].section = "并不存在的章节";
        }
        return result;
      });
      await expect(coordinator.organize(input, undefined, token(coordinator))).rejects.toThrow(
        "引用与当前资料不一致",
      );
      expect(coordinator.getSnapshot().data.organizationJobs?.[0].result).toBeUndefined();
    },
  );

  it("requires knowledge results to cite every selected source", async () => {
    const { coordinator, io, input, data } = await setup();
    const second = structuredClone(data.sources[0]);
    second.id = "second-source";
    second.chunks = second.chunks.map((chunk) => ({
      ...chunk,
      id: "second-" + chunk.id,
      sourceId: second.id,
    }));
    coordinator.update(
      (current) => ({ ...current, sources: [...current.sources, second] }),
      token(coordinator),
    );
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
    vi.mocked(io.organizeCloud).mockImplementationOnce(async (request) => {
      const sourceResult = modelResult(data, request);
      if (sourceResult.kind !== "source") throw new Error("bad fixture");
      return {
        kind: "knowledge",
        mode: "model",
        pages: [sourceResult.summary],
        coverage: "两份资料",
      };
    });
    await expect(
      coordinator.organize(
        { ...input, kind: "knowledge", sourceIds: [input.sourceIds[0], second.id] },
        undefined,
        token(coordinator),
      ),
    ).rejects.toThrow("引用与当前资料不一致");
    expect(coordinator.getSnapshot().data.organizationJobs?.[0].status).toBe("failed");
  });

  it("skips empty source bodies and already completed manual analyses", async () => {
    const { coordinator, data, input } = await setup();
    const empty = structuredClone(data);
    empty.autoOrganize = true;
    empty.sources[0].text = " \n ";
    expect(automaticCandidates(empty)).toEqual([]);
    await coordinator.organize(input, undefined, token(coordinator));
    expect(automaticCandidates({ ...coordinator.getSnapshot().data, autoOrganize: true })).toEqual(
      [],
    );
    const archived = structuredClone(coordinator.getSnapshot().data);
    archived.autoOrganize = true;
    archived.organizationJobs![0].status = "dismissed";
    expect(automaticCandidates(archived)).toEqual([]);
  });

  it("waits for an existing question before automatic analysis without preempting it", async () => {
    const { coordinator, io, input, startRunner } = await setup(true);
    const answer = deferred<{ content: string; citations: []; mode: "extractive" }>();
    vi.mocked(io.askCloud).mockReturnValueOnce(answer.promise);
    const pending = coordinator.ask(
      {
        question: "学习率",
        scope: "document",
        sourceId: input.sourceIds[0],
        sourceIds: [],
        spaceId: input.spaceId,
      },
      new AbortController().signal,
      token(coordinator),
    );
    startRunner();
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().organizationStatus.message).toContain(
        "等待当前 AI 请求结束",
      ),
    );
    expect(io.organizeCloud).not.toHaveBeenCalled();
    await expect(coordinator.organize(input, undefined, token(coordinator))).rejects.toThrow(
      "已有 AI 问答或整理",
    );
    answer.resolve({ content: "摘录", citations: [], mode: "extractive" });
    await pending;
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().data.organizationJobs?.[0].status).toBe("ready"),
    );
    expect(io.organizeCloud).toHaveBeenCalledOnce();
  });

  it("does not start a question while an organization request is in flight", async () => {
    const { coordinator, io, input, startRunner, data } = await setup(true);
    const model = deferred<OrganizationResult>();
    vi.mocked(io.organizeCloud).mockReturnValueOnce(model.promise);
    startRunner();
    await vi.waitFor(() => expect(io.organizeCloud).toHaveBeenCalledOnce());
    await expect(
      coordinator.ask(
        {
          question: "学习率",
          scope: "document",
          sourceId: input.sourceIds[0],
          sourceIds: [],
          spaceId: input.spaceId,
        },
        new AbortController().signal,
        token(coordinator),
      ),
    ).rejects.toThrow("资料整理正在进行");
    expect(io.askCloud).not.toHaveBeenCalled();
    model.resolve(modelResult(data, vi.mocked(io.organizeCloud).mock.calls[0][0]));
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().data.organizationJobs?.[0].status).toBe("ready"),
    );
  });

  it("holds unsynced automatic evidence without polling or consuming quota", async () => {
    const { coordinator, io, startRunner, saveCloud } = await setup(true);
    const cloudWrite = deferred<void>();
    vi.mocked(io.saveCloud).mockImplementationOnce(async (...args) => {
      await cloudWrite.promise;
      return saveCloud(...args);
    });
    coordinator.update(
      (data) => ({
        ...data,
        sources: data.sources.map((source) => ({ ...source, text: source.text + "新内容" })),
      }),
      token(coordinator),
    );
    startRunner();
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().organizationStatus.message).toContain(
        "等待资料和 AI 设置同步",
      ),
    );
    expect(io.getModelStatus).toHaveBeenCalledOnce();
    expect(io.organizeCloud).not.toHaveBeenCalled();
    cloudWrite.resolve();
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().data.organizationJobs?.[0].status).toBe("ready"),
    );
    expect(io.organizeCloud).toHaveBeenCalledOnce();
  });
});

describe("browser automatic organization scheduling", () => {
  it("does not create automatic jobs until the user enables the setting", async () => {
    const { coordinator, io, startRunner } = await setup();
    startRunner();
    await vi.waitFor(() => expect(coordinator.getSnapshot().organizationStatus.ready).toBe(true));
    expect(io.organizeCloud).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().data.organizationJobs).toBeUndefined();
  });

  it("keeps unconfigured generation disabled without creating an attempted job", async () => {
    const { coordinator, io, startRunner } = await setup(true);
    vi.mocked(io.getModelStatus).mockResolvedValue({ mode: "extractive", message: "没有配置模型" });
    startRunner();
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().organizationStatus.message).toBe("没有配置模型"),
    );
    expect(coordinator.getSnapshot().organizationStatus.ready).toBe(false);
    expect(io.organizeCloud).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().data.organizationJobs).toBeUndefined();
  });

  it("automatically analyzes each version once and does not retry on refresh", async () => {
    const { coordinator, io, startRunner } = await setup(true);
    const runner = startRunner();
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().data.organizationJobs?.[0].status).toBe("ready"),
    );
    expect(io.organizeCloud).toHaveBeenCalledOnce();
    const job = coordinator.getSnapshot().data.organizationJobs![0];
    expect(job.id).toMatch(/^auto-[a-f0-9]{64}$/);
    runner.stop();
    const refreshed = new WorkspaceCoordinator(io);
    await refreshed.activate(account);
    const second = new OrganizationRunner(refreshed);
    runners.push(second);
    second.start();
    await vi.waitFor(() => expect(refreshed.getSnapshot().organizationStatus.ready).toBe(true));
    expect(automaticCandidates(refreshed.getSnapshot().data)).toEqual([]);
    expect(io.organizeCloud).toHaveBeenCalledOnce();
  });

  it("recovers an interrupted job without automatically charging for another attempt", async () => {
    const { coordinator, io, cloud, data } = await setup(true);
    const request = await automaticOrganizationRequest(data, data.sources[0]);
    const now = new Date().toISOString();
    const restored = {
      ...data,
      organizationJobs: [
        {
          id: request.requestId,
          request,
          status: "running" as const,
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    cloud.set(account.id, { data: restored, revision: 2 });
    await coordinator.activate(account);
    expect(coordinator.getSnapshot().data.organizationJobs?.[0].status).toBe("cancelled");
    expect(automaticCandidates(coordinator.getSnapshot().data)).toEqual([]);
    const runner = new OrganizationRunner(coordinator);
    runners.push(runner);
    runner.start();
    await vi.waitFor(() => expect(coordinator.getSnapshot().organizationStatus.ready).toBe(true));
    expect(io.organizeCloud).not.toHaveBeenCalled();
    await coordinator.checkOrganization(request.requestId, token(coordinator));
    expect(vi.mocked(io.organizeCloud).mock.calls[0][0].requestId).toBe(request.requestId);
  });

  it("keeps durable source and knowledge jobs pending when the browser reloads", async () => {
    const { coordinator, cloud, data } = await setup(true);
    const sourceRequest = await automaticOrganizationRequest(data, data.sources[0]);
    const knowledgeRequest: OrganizationRequest = {
      ...sourceRequest,
      requestId: "durable-knowledge",
      kind: "knowledge",
      trigger: "manual",
    };
    const now = new Date().toISOString();
    cloud.set(account.id, {
      data: {
        ...data,
        organizationJobs: [
          {
            id: sourceRequest.requestId,
            durable: true,
            request: sourceRequest,
            status: "queued",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: knowledgeRequest.requestId,
            durable: true,
            request: knowledgeRequest,
            status: "running",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "legacy-running",
            request: { ...sourceRequest, requestId: "legacy-running" },
            status: "running",
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
      revision: 2,
    });

    await coordinator.activate(account);

    expect(coordinator.getSnapshot().data.organizationJobs?.map((job) => job.status)).toEqual([
      "queued",
      "running",
      "cancelled",
    ]);
  });

  it("pauses after a failed automatic attempt instead of repeatedly consuming quota", async () => {
    const { coordinator, io, startRunner } = await setup(true);
    vi.mocked(io.organizeCloud).mockRejectedValueOnce(new Error("今日额度已用完"));
    const runner = startRunner();
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().organizationStatus.message).toContain("自动整理已暂停"),
    );
    expect(coordinator.getSnapshot().data.organizationJobs?.[0].status).toBe("failed");
    runner.refresh();
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().organizationStatus.message).toContain("没有待自动分析"),
    );
    expect(io.organizeCloud).toHaveBeenCalledOnce();
  });

  it("stops ongoing automatic work when the setting is turned off", async () => {
    const { coordinator, io, startRunner, data } = await setup(true);
    const model = deferred<OrganizationResult>();
    vi.mocked(io.organizeCloud).mockReturnValueOnce(model.promise);
    startRunner();
    await vi.waitFor(() => expect(io.organizeCloud).toHaveBeenCalledOnce());
    coordinator.update((current) => ({ ...current, autoOrganize: false }), token(coordinator));
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().data.organizationJobs?.[0].status).toBe("cancelled"),
    );
    expect(vi.mocked(io.organizeCloud).mock.calls[0][1]?.aborted).toBe(true);
    model.resolve(modelResult(data, vi.mocked(io.organizeCloud).mock.calls[0][0]));
  });

  it("stops when the page runner ends and does not start new requests", async () => {
    const { coordinator, io, startRunner, data } = await setup(true);
    const model = deferred<OrganizationResult>();
    vi.mocked(io.organizeCloud).mockReturnValueOnce(model.promise);
    const runner = startRunner();
    await vi.waitFor(() => expect(io.organizeCloud).toHaveBeenCalledOnce());
    runner.stop();
    coordinator.stopOrganizations();
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().data.organizationJobs?.[0].status).toBe("cancelled"),
    );
    model.resolve(modelResult(data, vi.mocked(io.organizeCloud).mock.calls[0][0]));
    expect(io.organizeCloud).toHaveBeenCalledOnce();
  });

  it("does not cancel a durable job when the page closes", async () => {
    const { coordinator, io, cloud, data } = await setup();
    const request: OrganizationRequest = {
      ...(await automaticOrganizationRequest(data, data.sources[0])),
      trigger: "manual",
    };
    const now = new Date().toISOString();
    cloud.set(account.id, {
      data: {
        ...data,
        organizationJobs: [
          {
            id: request.requestId,
            durable: true,
            request,
            status: "queued",
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
      revision: 2,
    });
    await coordinator.activate(account);
    io.reconcileOrganizationJobs = vi.fn(async () => ({
      revision: 2,
      jobs: [{ id: request.requestId, state: "queued" as const, updatedAt: now }],
    }));

    await coordinator.checkOrganization(request.requestId, token(coordinator));
    expect(io.reconcileOrganizationJobs).toHaveBeenCalledWith(account.id, undefined);
    expect(io.organizeCloud).not.toHaveBeenCalled();

    coordinator.stopOrganizations();

    expect(coordinator.getSnapshot().data.organizationJobs?.[0].status).toBe("queued");
    expect(io.cancelOrganizationJob).toBeUndefined();
  });

  it("uses stable short automatic IDs even for maximum-length source/version IDs", async () => {
    const { data } = await setup(true);
    data.sources[0].id = "s".repeat(100);
    data.sources[0].versionId = "v".repeat(100);
    const first = await automaticOrganizationRequest(data, data.sources[0]);
    expect(first.requestId.length).toBeLessThanOrEqual(100);
    expect(
      (await automaticOrganizationRequest(structuredClone(data), data.sources[0])).requestId,
    ).toBe(first.requestId);
    data.sources[0].versionId = "w".repeat(100);
    expect((await automaticOrganizationRequest(data, data.sources[0])).requestId).not.toBe(
      first.requestId,
    );
  });
});
