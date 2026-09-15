import { describe, expect, it, vi } from "vitest";
import { WorkspaceCoordinator, type WorkspaceIO } from "./use-workspace";
import { automaticCandidates, type OrganizationInput } from "./organization-runner";
import {
  organizationCitations,
  organizationContextKey,
  organizationReviewReason,
} from "./organization";
import { snapshotKnowledgeNote } from "./knowledge-update";
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

const account = { id: "relation-owner", email: "relation@example.com" };
type RelationResult = Extract<OrganizationResult, { kind: "relations" }>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function citation(data: WorkspaceData, index: number): Citation {
  const source = data.sources[index],
    chunk = source.chunks[0];
  return {
    sourceId: source.id,
    versionId: source.versionId,
    chunkId: chunk.id,
    title: source.title,
    quote: chunk.text,
    section: chunk.section,
    page: chunk.page,
  };
}
function noRelations(data: WorkspaceData, request: OrganizationRequest): RelationResult {
  return {
    kind: "relations",
    mode: "model",
    target: snapshotKnowledgeNote(data.notes.find((note) => note.id === request.targetNote?.id)!),
    compare: snapshotKnowledgeNote(data.notes.find((note) => note.id === request.compareNote?.id)!),
    relations: [],
    coverage: "两份知识页与所选资料没有形成需保存的关系建议。",
  };
}
function relatedResult(data: WorkspaceData, request: OrganizationRequest): RelationResult {
  const result = noRelations(data, request);
  result.relations = [
    {
      id: "relation-1",
      type: "related",
      fromClaim: "学习率决定参数更新的步长。",
      toClaim: "学习率过大可能使损失振荡。",
      fromCondition: "梯度下降。",
      toCondition: "梯度下降。",
      explanation: "两页分别说明更新步长与可能的损失振荡，两者具有相关性。",
      fromCitations: [],
      toCitations: [],
    },
  ];
  return result;
}
async function setup() {
  const data = createDemoWorkspace();
  const from: Note = {
    id: "from-note",
    spaceId: data.spaces[0].id,
    title: "参数更新步长",
    content: "<p>学习率决定参数更新的步长。</p><p>条件：梯度下降。</p>",
    kind: "knowledge",
    status: "accepted",
    aiGenerated: true,
    contentRevision: 3,
    citations: [citation(data, 0)],
    versions: [],
    createdAt: "2026-09-12T11:00:00.000Z",
    updatedAt: "2026-09-12T11:02:00.000Z",
    deletedAt: null,
  };
  const to: Note = {
    ...structuredClone(from),
    id: "to-note",
    title: "损失振荡",
    content: "<p>学习率过大可能使损失振荡。</p><p>条件：梯度下降。</p>",
    contentRevision: undefined,
    citations: [citation(data, 1)],
  };
  data.notes = [from, to, { ...structuredClone(from), id: "unrelated-note" }];
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
    askCloud: vi.fn(async () => ({ content: "结果", citations: [], mode: "extractive" as const })),
    getModelStatus: vi.fn(async () => ({ mode: "model", message: "模型已配置" })),
    organizeCloud: vi.fn(async (request) => noRelations(cloud.get(account.id)!.data, request)),
    readLegacyMeta: vi.fn(() => null),
  };
  const coordinator = new WorkspaceCoordinator(io);
  await coordinator.activate(account);
  const token = coordinator.getSnapshot().token;
  const input: OrganizationInput = {
    kind: "relations",
    spaceId: from.spaceId,
    sourceIds: data.sources.map((source) => source.id),
    targetNoteId: from.id,
    compareNoteId: to.id,
    topic: "比较学习率的说明",
  };
  const request: OrganizationRequest = {
    requestId: "relations-request",
    kind: "relations",
    trigger: "manual",
    spaceId: from.spaceId,
    sourceIds: [...input.sourceIds],
    sourceVersions: data.sources.map((source) => ({
      sourceId: source.id,
      versionId: source.versionId,
    })),
    targetNote: { id: from.id, revision: 3, updatedAt: from.updatedAt },
    compareNote: { id: to.id, revision: 0, updatedAt: to.updatedAt },
    topic: input.topic,
  };
  const change = (mutate: (data: WorkspaceData) => void) => {
    coordinator.update((current) => {
      const next = structuredClone(current);
      mutate(next);
      return next;
    }, token);
  };
  return { data, from, to, coordinator, io, disk, cloud, saveCloud, token, input, request, change };
}
const observe = (promise: Promise<void>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

describe("relations coordinator endpoint baselines", () => {
  it("builds both current baselines and saves a no-relation result without creating knowledge or relations", async () => {
    const { coordinator, io, disk, data, from, to, input, token } = await setup();
    await coordinator.organize(
      {
        ...input,
        targetNote: { id: "forged", revision: 999, updatedAt: from.updatedAt },
        compareNote: { id: "forged-compare", revision: 999, updatedAt: to.updatedAt },
        target: { content: "伪造起点正文" },
        compare: { content: "伪造终点正文" },
      } as OrganizationInput,
      undefined,
      token,
    );
    const sent = vi.mocked(io.organizeCloud).mock.calls[0][0];
    expect(sent.targetNote).toEqual({ id: from.id, revision: 3, updatedAt: from.updatedAt });
    expect(sent.compareNote).toEqual({ id: to.id, revision: 0, updatedAt: to.updatedAt });
    for (const key of ["targetNoteId", "compareNoteId", "target", "compare"])
      expect(sent).not.toHaveProperty(key);
    const job = coordinator.getSnapshot().data.organizationJobs![0];
    expect(job).toMatchObject({
      status: "ready",
      result: { kind: "relations", mode: "model", relations: [] },
    });
    expect(disk.get(account.id)?.organizationJobs?.[0].result).toEqual(job.result);
    expect(coordinator.getSnapshot().data.notes).toEqual(data.notes);
    expect(
      automaticCandidates({ ...coordinator.getSnapshot().data, autoOrganize: true }),
    ).toHaveLength(2);
  });

  it.each(["targetNoteId", "compareNoteId"] as const)(
    "rejects a missing %s before provider disclosure",
    async (key) => {
      const { coordinator, io, input, token } = await setup();
      await expect(
        coordinator.organize({ ...input, [key]: "missing-note" }, undefined, token),
      ).rejects.toThrow("知识页");
      expect(io.organizeCloud).not.toHaveBeenCalled();
      expect(coordinator.getSnapshot().data.organizationJobs).toBeUndefined();
    },
  );

  it("requires two distinct endpoints and the old citation sources of both pages", async () => {
    const { coordinator, io, input, token } = await setup();
    await expect(
      coordinator.organize({ ...input, compareNoteId: input.targetNoteId }, undefined, token),
    ).rejects.toThrow();
    await expect(
      coordinator.organize({ ...input, sourceIds: [input.sourceIds[0]] }, undefined, token),
    ).rejects.toThrow();
    expect(io.organizeCloud).not.toHaveBeenCalled();
  });

  const endpointChanges: [string, (note: Note, data: WorkspaceData) => void][] = [
    [
      "body",
      (note) => {
        note.content += "<p>新的理解。</p>";
      },
    ],
    [
      "title",
      (note) => {
        note.title = "人工新标题";
      },
    ],
    [
      "revision",
      (note) => {
        note.contentRevision = (note.contentRevision ?? 0) + 1;
      },
    ],
    [
      "timestamp",
      (note) => {
        note.updatedAt = "2026-09-12T11:03:00.000Z";
      },
    ],
    [
      "review status",
      (note) => {
        note.status = "draft";
      },
    ],
    [
      "AI provenance",
      (note) => {
        note.aiGenerated = false;
      },
    ],
    [
      "citations",
      (note) => {
        note.citations = [];
      },
    ],
    [
      "space",
      (note) => {
        note.spaceId = "other-space";
      },
    ],
    [
      "deleted",
      (note) => {
        note.deletedAt = "2026-09-12T11:03:00.000Z";
      },
    ],
    [
      "kind",
      (note) => {
        note.kind = "note";
      },
    ],
    [
      "removed",
      (note, data) => {
        data.notes = data.notes.filter((item) => item.id !== note.id);
      },
    ],
  ];
  it.each(
    [0, 1].flatMap((index) =>
      endpointChanges.map(([name, mutate]) => [index, name, mutate] as const),
    ),
  )(
    "cancels when endpoint %i changes %s and refuses a late result",
    async (index, _name, mutate) => {
      const { coordinator, io, input, token, data, change } = await setup();
      const model = deferred<OrganizationResult>();
      vi.mocked(io.organizeCloud).mockReturnValueOnce(model.promise);
      const outcome = observe(coordinator.organize(input, undefined, token));
      await vi.waitFor(() => expect(io.organizeCloud).toHaveBeenCalledOnce());
      const [request, signal] = vi.mocked(io.organizeCloud).mock.calls[0];
      change((next) => mutate(next.notes[index], next));
      expect(signal?.aborted).toBe(true);
      expect(await outcome).toBeInstanceOf(Error);
      model.resolve(noRelations(data, request));
      await Promise.resolve();
      await Promise.resolve();
      expect(coordinator.getSnapshot().data.organizationJobs?.[0]).toMatchObject({
        status: "cancelled",
        result: undefined,
      });
    },
  );

  it.each([0, 1, "global"] as const)(
    "cancels source/global AI permission revocation: %s",
    async (index) => {
      const { coordinator, io, input, token, data, change } = await setup();
      const model = deferred<OrganizationResult>();
      vi.mocked(io.organizeCloud).mockReturnValueOnce(model.promise);
      const outcome = observe(coordinator.organize(input, undefined, token));
      await vi.waitFor(() => expect(io.organizeCloud).toHaveBeenCalledOnce());
      const [request, signal] = vi.mocked(io.organizeCloud).mock.calls[0];
      change((next) => {
        if (index === "global") next.aiEnabled = false;
        else next.sources[index].aiAllowed = false;
      });
      expect(signal?.aborted).toBe(true);
      expect(await outcome).toBeInstanceOf(Error);
      model.resolve(noRelations(data, request));
      await Promise.resolve();
      expect(coordinator.getSnapshot().data.organizationJobs?.[0].result).toBeUndefined();
    },
  );

  it("does not cancel for unrelated notes, note history or saved relation bookkeeping", async () => {
    const { coordinator, io, input, token, data, change } = await setup();
    const model = deferred<OrganizationResult>();
    vi.mocked(io.organizeCloud).mockReturnValueOnce(model.promise);
    const outcome = coordinator.organize(input, undefined, token);
    await vi.waitFor(() => expect(io.organizeCloud).toHaveBeenCalledOnce());
    const [request, signal] = vi.mocked(io.organizeCloud).mock.calls[0];
    change((next) => {
      next.notes[2].content = "<p>另一个主题。</p>";
      next.notes[0].versions.push({
        id: "history",
        title: "旧题",
        content: "旧文",
        savedAt: next.notes[0].createdAt,
      });
      next.organizationJobs![0].error = "任务界面元数据";
      const { id: _proposalId, ...draft } = relatedResult(data, request).relations[0];
      void _proposalId;
      next.conceptRelations = [
        {
          ...draft,
          id: "existing-relation",
          spaceId: input.spaceId,
          from: snapshotKnowledgeNote(next.notes[0]),
          to: snapshotKnowledgeNote(next.notes[1]),
          origin: "ai",
          revision: 1,
          createdAt: next.notes[0].createdAt,
          updatedAt: next.notes[0].updatedAt,
          deletedAt: null,
        },
      ];
    });
    expect(signal?.aborted).toBe(false);
    model.resolve(noRelations(data, request));
    await outcome;
    expect(coordinator.getSnapshot().data.organizationJobs?.[0].status).toBe("ready");
    expect(coordinator.getSnapshot().data.conceptRelations?.[0].id).toBe("existing-relation");
  });

  it.each([0, 1])(
    "waits for the complete endpoint %i to be acknowledged by cloud",
    async (index) => {
      const { coordinator, io, input, token, change, saveCloud } = await setup();
      const acknowledged = deferred<void>();
      vi.mocked(io.saveCloud).mockImplementationOnce(async (...args) => {
        await acknowledged.promise;
        return saveCloud(...args);
      });
      change((next) => {
        next.notes[index].content += "<p>正文修改未递增版本。</p>";
      });
      await expect(coordinator.organize(input, undefined, token)).rejects.toThrow("尚未同步");
      expect(io.organizeCloud).not.toHaveBeenCalled();
      acknowledged.resolve();
      await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
      await coordinator.organize(input, undefined, token);
      expect(coordinator.getSnapshot().data.organizationJobs?.[0].status).toBe("ready");
    },
  );

  it("does not require unrelated unsynced notes to delay the already confirmed pair", async () => {
    const { coordinator, io, input, token, change, saveCloud } = await setup();
    const acknowledged = deferred<void>();
    vi.mocked(io.saveCloud).mockImplementationOnce(async (...args) => {
      await acknowledged.promise;
      return saveCloud(...args);
    });
    change((next) => {
      next.notes[2].content = "<p>未同步的无关主题</p>";
    });
    await vi.waitFor(() => expect(io.saveCloud).toHaveBeenCalledOnce());
    await coordinator.organize(input, undefined, token);
    expect(coordinator.getSnapshot().data.organizationJobs?.[0].status).toBe("ready");
    acknowledged.resolve();
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
  });

  it.each(["target", "compare"] as const)(
    "stops during the model status check when %s changes",
    async (side) => {
      const { coordinator, io, input, token, change } = await setup();
      const modelStatus = deferred<{ mode: "model"; message: string }>();
      vi.mocked(io.getModelStatus).mockReturnValueOnce(modelStatus.promise);
      const outcome = observe(coordinator.organize(input, undefined, token));
      await vi.waitFor(() => expect(io.getModelStatus).toHaveBeenCalledOnce());
      change((next) => {
        next.notes[side === "target" ? 0 : 1].title += "已编辑";
      });
      expect(await outcome).toBeInstanceOf(Error);
      modelStatus.resolve({ mode: "model", message: "已配置" });
      await Promise.resolve();
      expect(io.organizeCloud).not.toHaveBeenCalled();
    },
  );

  const wrongBaselines: [string, (note: RelationResult["target"]) => void][] = [
    [
      "id",
      (note) => {
        note.id = "wrong-note";
      },
    ],
    [
      "content",
      (note) => {
        note.content += "<p>模型改过的基线</p>";
      },
    ],
    [
      "title",
      (note) => {
        note.title += "不同";
      },
    ],
    [
      "revision",
      (note) => {
        note.revision++;
      },
    ],
    [
      "updatedAt",
      (note) => {
        note.updatedAt = "2026-09-12T11:03:00.000Z";
      },
    ],
    [
      "status",
      (note) => {
        note.status = "draft";
      },
    ],
    [
      "provenance",
      (note) => {
        note.aiGenerated = false;
      },
    ],
    [
      "citations",
      (note) => {
        note.citations = [];
      },
    ],
    [
      "space",
      (note) => {
        note.spaceId = "wrong-space";
      },
    ],
  ];
  it.each(
    (["target", "compare"] as const).flatMap((side) =>
      wrongBaselines.map(([field, mutate]) => [side, field, mutate] as const),
    ),
  )("rejects a mismatched %s baseline %s", async (side, _field, mutate) => {
    const { coordinator, io, input, token, data } = await setup();
    vi.mocked(io.organizeCloud).mockImplementationOnce(async (request) => {
      const result = noRelations(data, request);
      mutate(result[side]);
      return result;
    });
    await expect(coordinator.organize(input, undefined, token)).rejects.toThrow("两份知识页");
    expect(coordinator.getSnapshot().data.organizationJobs?.[0]).toMatchObject({
      status: "failed",
      result: undefined,
    });
  });

  it("revalidates cached pair baselines and retries against both latest revisions", async () => {
    const { coordinator, io, input, token, data, change } = await setup();
    vi.mocked(io.organizeCloud).mockRejectedValueOnce(new Error("连接中断"));
    await expect(coordinator.organize(input, undefined, token)).rejects.toThrow("连接中断");
    const job = coordinator.getSnapshot().data.organizationJobs![0];
    vi.mocked(io.organizeCloud).mockImplementationOnce(async (request) => {
      const result = noRelations(data, request);
      result.compare.title = "错误缓存";
      return result;
    });
    await expect(coordinator.checkOrganization(job.id, token)).rejects.toThrow("两份知识页");
    expect(vi.mocked(io.organizeCloud).mock.calls[1][0].requestId).toBe(job.id);
    change((next) => {
      next.notes[0].contentRevision = 4;
      next.notes[1].contentRevision = 1;
      for (const note of next.notes.slice(0, 2)) {
        note.updatedAt = "2026-09-12T11:03:00.000Z";
        note.content += "<p>新的解释</p>";
      }
    });
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
    await expect(coordinator.checkOrganization(job.id, token)).rejects.toThrow();
    expect(io.organizeCloud).toHaveBeenCalledTimes(2);
    await coordinator.retryOrganization(job.id, token);
    const retried = vi.mocked(io.organizeCloud).mock.calls[2][0];
    expect(retried.requestId).not.toBe(job.id);
    expect(retried.targetNote).toMatchObject({ id: input.targetNoteId, revision: 4 });
    expect(retried.compareNote).toMatchObject({ id: input.compareNoteId, revision: 1 });
  });

  it("keeps an uncited related proposal visibly model-produced and does not auto-save a relationship", async () => {
    const { coordinator, io, input, token, data } = await setup();
    vi.mocked(io.organizeCloud).mockImplementationOnce(async (request) =>
      relatedResult(data, request),
    );
    await coordinator.organize(input, undefined, token);
    const job = coordinator.getSnapshot().data.organizationJobs![0];
    expect(job).toMatchObject({
      status: "ready",
      result: {
        kind: "relations",
        mode: "model",
        relations: [{ type: "related", fromCitations: [], toCitations: [] }],
      },
    });
    expect(coordinator.getSnapshot().data.conceptRelations).toBeUndefined();
    expect(coordinator.getSnapshot().data.notes).toEqual(data.notes);
  });

  it("accepts a cited proposal without requiring every selected source to be cited", async () => {
    const { coordinator, io, input, token, data } = await setup();
    vi.mocked(io.organizeCloud).mockImplementationOnce(async (request) => {
      const result = relatedResult(data, request);
      result.relations[0].fromCitations = [citation(data, 0)];
      return result;
    });
    await coordinator.organize(input, undefined, token);
    const result = coordinator.getSnapshot().data.organizationJobs![0].result!;
    expect(organizationCitations(result)).toEqual([citation(data, 0)]);
  });

  it("preserves both sides of a conflict proposal with distinct canonical evidence", async () => {
    const { coordinator, io, input, token, data } = await setup();
    vi.mocked(io.organizeCloud).mockImplementationOnce(async (request) => {
      const result = relatedResult(data, request);
      result.relations[0].type = "conflict";
      result.relations[0].fromCitations = [citation(data, 0)];
      result.relations[0].toCitations = [citation(data, 1)];
      return result;
    });
    await coordinator.organize(input, undefined, token);
    const result = coordinator.getSnapshot().data.organizationJobs![0].result!;
    expect(organizationCitations(result)).toEqual([citation(data, 0), citation(data, 1)]);
  });

  it.each(["no evidence", "one side", "same evidence", "missing condition", "identical claims"])(
    "rejects conflict proposals with %s",
    async (problem) => {
      const { coordinator, io, input, token, data } = await setup();
      vi.mocked(io.organizeCloud).mockImplementationOnce(async (request) => {
        const result = relatedResult(data, request),
          proposal = result.relations[0];
        proposal.type = "conflict";
        if (problem !== "no evidence") proposal.fromCitations = [citation(data, 0)];
        if (problem !== "no evidence" && problem !== "one side")
          proposal.toCitations = [citation(data, problem === "same evidence" ? 0 : 1)];
        if (problem === "missing condition") proposal.fromCondition = "";
        if (problem === "identical claims") proposal.toClaim = proposal.fromClaim;
        return result;
      });
      await expect(coordinator.organize(input, undefined, token)).rejects.toThrow();
      expect(coordinator.getSnapshot().data.organizationJobs?.[0]).toMatchObject({
        status: "failed",
        result: undefined,
      });
    },
  );

  it.each(["id", "type"] as const)("rejects duplicate proposal %s", async (field) => {
    const { coordinator, io, input, token, data } = await setup();
    vi.mocked(io.organizeCloud).mockImplementationOnce(async (request) => {
      const result = relatedResult(data, request);
      result.relations.push({
        ...structuredClone(result.relations[0]),
        id: field === "id" ? "relation-1" : "relation-2",
        type: field === "type" ? "related" : "synonym",
      });
      return result;
    });
    await expect(coordinator.organize(input, undefined, token)).rejects.toThrow("两份知识页");
    expect(coordinator.getSnapshot().data.organizationJobs?.[0].result).toBeUndefined();
  });

  const citationProblems: [string, (value: Citation) => void][] = [
    [
      "scope",
      (value) => {
        value.sourceId = "outside-source";
      },
    ],
    [
      "version",
      (value) => {
        value.versionId = "old-version";
      },
    ],
    [
      "quote",
      (value) => {
        value.quote = "不存在的原话。";
      },
    ],
    [
      "title",
      (value) => {
        value.title = "不正确的标题";
      },
    ],
    [
      "page",
      (value) => {
        value.page = 12345;
      },
    ],
    [
      "section",
      (value) => {
        value.section = "不正确的章节";
      },
    ],
  ];
  it.each(
    (["fromCitations", "toCitations"] as const).flatMap((side) =>
      citationProblems.map(([field, mutate]) => [side, field, mutate] as const),
    ),
  )("rejects noncanonical %s %s", async (side, _field, mutate) => {
    const { coordinator, io, input, token, data } = await setup();
    vi.mocked(io.organizeCloud).mockImplementationOnce(async (request) => {
      const result = relatedResult(data, request),
        ref = citation(data, side === "fromCitations" ? 0 : 1);
      mutate(ref);
      result.relations[0][side] = [ref];
      return result;
    });
    await expect(coordinator.organize(input, undefined, token)).rejects.toThrow(
      "引用与当前资料不一致",
    );
    expect(coordinator.getSnapshot().data.organizationJobs?.[0].result).toBeUndefined();
  });

  it("shares the in-flight AI boundary with questions and manual organization", async () => {
    const { coordinator, io, input, token, data } = await setup();
    const model = deferred<OrganizationResult>();
    vi.mocked(io.organizeCloud).mockReturnValueOnce(model.promise);
    const pending = coordinator.organize(input, undefined, token);
    await vi.waitFor(() => expect(io.organizeCloud).toHaveBeenCalledOnce());
    await expect(coordinator.organize(input, undefined, token)).rejects.toThrow("已有 AI");
    await expect(
      coordinator.ask(
        {
          question: "学习率",
          scope: "document",
          spaceId: input.spaceId,
          sourceId: input.sourceIds[0],
          sourceIds: [],
        },
        new AbortController().signal,
        token,
      ),
    ).rejects.toThrow("资料整理正在进行");
    expect(io.askCloud).not.toHaveBeenCalled();
    model.resolve(noRelations(data, vi.mocked(io.organizeCloud).mock.calls[0][0]));
    await pending;
  });

  it("cancels across accounts and does not write a late pair result to the new account", async () => {
    const { coordinator, io, input, token, data } = await setup();
    const model = deferred<OrganizationResult>();
    vi.mocked(io.organizeCloud).mockReturnValueOnce(model.promise);
    const outcome = observe(coordinator.organize(input, undefined, token));
    await vi.waitFor(() => expect(io.organizeCloud).toHaveBeenCalledOnce());
    const [request, signal] = vi.mocked(io.organizeCloud).mock.calls[0];
    await coordinator.activate({ id: "other-owner", email: "other@example.com" });
    expect(await outcome).toBeInstanceOf(Error);
    expect(signal?.aborted).toBe(true);
    model.resolve(noRelations(data, request));
    await Promise.resolve();
    expect(coordinator.getSnapshot().data.organizationJobs).toBeUndefined();
  });
});

describe("relations context and shared review", () => {
  it("compares both full endpoints without invalidating for irrelevant notes or request IDs", async () => {
    const { data, request } = await setup();
    const key = organizationContextKey(data, request);
    const same = structuredClone(data);
    same.notes[2].content = "无关的改动";
    expect(organizationContextKey(same, { ...request, requestId: "new-id" })).toBe(key);
    for (const index of [0, 1]) {
      const changed = structuredClone(data);
      changed.notes[index].content += "目标改动";
      expect(organizationContextKey(changed, request)).not.toBe(key);
    }
  });

  it("lets the relation domain own endpoint review while the shared guard still checks the source scope", async () => {
    const { data, request } = await setup();
    const result = noRelations(data, request);
    expect(organizationCitations(result)).toEqual([]);
    const next = structuredClone(data);
    next.notes[0].title = "手动改动";
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
    next.sources[1].deletedAt = "2026-09-12T11:03:00.000Z";
    expect(organizationReviewReason(next, job)).toContain("删除");
  });
});
