import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createDemoWorkspace } from "@/lib/seed";
import { bindOrganizationResult, buildOrganizationGrounding } from "@/lib/ai/organization";
import type { OrganizationRequest, OrganizationResult } from "@/lib/organization-types";
import type { WorkspaceData } from "@/lib/types";
import { ApiError } from "./api";

const mock = vi.hoisted(() => ({
  taskRpc: vi.fn(),
  readModelConfig: vi.fn(),
  callModel: vi.fn(),
  createRequestStore: vi.fn(),
  reserveRequest: vi.fn(),
  finishRequest: vi.fn(),
}));

vi.mock("@/lib/ai/model", () => ({
  readModelConfig: mock.readModelConfig,
  callModel: mock.callModel,
}));
vi.mock("@/lib/ai/requests", () => ({
  createRequestStore: mock.createRequestStore,
  reserveRequest: mock.reserveRequest,
  finishRequest: mock.finishRequest,
}));

import { runOrganizationTasks, type OrganizationTaskStore } from "./organization-task-runner";

const ownerId = "11111111-1111-4111-8111-111111111111";
const leaseToken = "22222222-2222-4222-8222-222222222222";
const leaseUntil = "2026-09-14T12:00:00.000Z";
const contextDigest = "a".repeat(64);
const modelConfig = {
  baseUrl: "https://model.example/v1",
  apiKey: "test-key",
  model: "test-model",
  jsonMode: true,
  tokenLimitParameter: "max_completion_tokens",
  timeoutMs: 45_000,
};
const ledger = { name: "test-ledger" };

let workspace: WorkspaceData;
let organizationRequest: OrganizationRequest;

function generatedSource() {
  return JSON.stringify({
    status: "ready",
    kind: "source",
    summary: {
      title: "学习率摘要",
      paragraphs: [{ text: "学习率决定每次更新的步长。", evidenceIds: ["e1"], kind: "source" }],
    },
    tags: [{ label: "学习率", evidenceIds: ["e1"] }],
    topics: [{ label: "梯度下降", evidenceIds: ["e1"] }],
  });
}

function claim(result = false) {
  return {
    jobId: organizationRequest.requestId,
    ownerId,
    leaseToken,
    leaseUntil,
    hasResult: result,
    attempt: 0,
  };
}

function context(result: OrganizationResult | null = null) {
  return {
    jobId: organizationRequest.requestId,
    ownerId,
    leaseToken,
    leaseUntil,
    request: organizationRequest,
    workspace,
    contextDigest,
    result,
  };
}

function taskStore(): OrganizationTaskStore {
  return { rpc: mock.taskRpc } as unknown as OrganizationTaskStore;
}

function rpcResponse(data: unknown) {
  return { data, error: null };
}

function taskRpcWithContext(result: OrganizationResult | null = null) {
  mock.taskRpc.mockImplementation(async (name: string) => {
    switch (name) {
      case "claim_organization_jobs":
        return rpcResponse({ jobs: [claim(Boolean(result))] });
      case "read_organization_job_context":
        return rpcResponse(context(result));
      case "heartbeat_organization_job":
        return rpcResponse({ leaseUntil });
      case "stage_organization_job_result":
        return rpcResponse({ staged: true, resultDigest: "b".repeat(64) });
      case "publish_organization_job":
        return rpcResponse({ state: "succeeded", revision: 2 });
      case "fail_organization_job":
        return rpcResponse({ state: "queued", revision: null });
      default:
        throw new Error(`unexpected RPC ${name}`);
    }
  });
}

beforeEach(() => {
  Object.values(mock).forEach((fn) => fn.mockReset());
  workspace = createDemoWorkspace();
  workspace.autoOrganize = true;
  const source = workspace.sources[0];
  organizationRequest = {
    requestId: "organization-task-1",
    kind: "source",
    trigger: "automatic",
    spaceId: workspace.spaces[0].id,
    sourceIds: [source.id],
    sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
  };
  mock.readModelConfig.mockReturnValue(modelConfig);
  mock.createRequestStore.mockReturnValue(ledger);
  mock.reserveRequest.mockResolvedValue({ kind: "reserved" });
  mock.finishRequest.mockResolvedValue(undefined);
  mock.callModel.mockResolvedValue(generatedSource());
});

describe("runOrganizationTasks", () => {
  it("keeps the worker protocol while versions of the model contract invalidate old fingerprints", async () => {
    taskRpcWithContext();
    await runOrganizationTasks(taskStore(), {
      workerId: "organization-worker-1",
      limit: 1,
      leaseSeconds: 60,
    });
    const fingerprintFor = (semanticVersion?: string) =>
      createHash("sha256")
        .update(
          JSON.stringify([
            "organization-worker-v1",
            ...(semanticVersion ? [semanticVersion] : []),
            modelConfig.baseUrl,
            modelConfig.model,
            modelConfig.jsonMode,
            ...(semanticVersion ? [null] : []),
            contextDigest,
          ]),
        )
        .digest("hex");
    expect(mock.reserveRequest.mock.calls[0][3]).toBe(fingerprintFor("organization-v2"));
    expect(mock.reserveRequest.mock.calls[0][3]).not.toBe(fingerprintFor());
    expect(mock.callModel).toHaveBeenCalledOnce();
  });

  it("gives omitted, enabled and disabled thinking modes distinct worker-v1 and model-v2 identities", async () => {
    taskRpcWithContext();
    const fingerprints: string[] = [];
    const expected: string[] = [];
    for (const [index, mode] of ([undefined, "enabled", "disabled"] as const).entries()) {
      const effectiveConfig =
        mode === undefined ? modelConfig : { ...modelConfig, thinkingMode: mode };
      mock.readModelConfig.mockReturnValue(effectiveConfig);
      const summary = await runOrganizationTasks(taskStore(), {
        workerId: "organization-worker-1",
        limit: 1,
        leaseSeconds: 60,
      });
      expect(summary).toMatchObject({ claimed: 1, staged: 1, published: 1, failed: 0 });
      fingerprints.push(mock.reserveRequest.mock.calls[index][3]);
      expected.push(
        createHash("sha256")
          .update(
            JSON.stringify([
              "organization-worker-v1",
              "organization-v2",
              modelConfig.baseUrl,
              modelConfig.model,
              modelConfig.jsonMode,
              mode ?? null,
              contextDigest,
            ]),
          )
          .digest("hex"),
      );
      expect(mock.callModel.mock.calls[index][0]).toEqual(effectiveConfig);
    }
    expect(new Set(fingerprints).size).toBe(3);
    expect(fingerprints).toEqual(expected);
    expect(mock.reserveRequest).toHaveBeenCalledTimes(3);
    expect(mock.callModel).toHaveBeenCalledTimes(3);
    expect(mock.finishRequest).toHaveBeenCalledTimes(3);
  });

  it.each([
    [undefined, "enabled"],
    [undefined, "disabled"],
    ["enabled", "disabled"],
  ] as const)("fails a cached job when thinking changes from %s to %s", async (before, after) => {
    taskRpcWithContext();
    mock.readModelConfig.mockReturnValue(
      before === undefined ? modelConfig : { ...modelConfig, thinkingMode: before },
    );
    const runnerInput = { workerId: "organization-worker-1", limit: 1, leaseSeconds: 60 };
    const first = await runOrganizationTasks(taskStore(), runnerInput);
    expect(first).toMatchObject({ staged: 1, published: 1 });
    const cached = mock.finishRequest.mock.calls[0][3];
    const firstFingerprint = mock.reserveRequest.mock.calls[0][3];
    mock.reserveRequest.mockImplementationOnce(async (_ledger, _owner, _request, fingerprint) => {
      if (fingerprint === firstFingerprint) return { kind: "cached", result: cached };
      throw new ApiError(409, "REQUEST_CHANGED", "请重新发起模型请求。");
    });
    const taskRpc = mock.taskRpc.getMockImplementation()!;
    mock.taskRpc.mockImplementation(async (...args) =>
      args[0] === "fail_organization_job"
        ? rpcResponse({ state: "failed", revision: 2 })
        : taskRpc(...args),
    );
    mock.readModelConfig.mockReturnValue({ ...modelConfig, thinkingMode: after });
    const second = await runOrganizationTasks(taskStore(), runnerInput);
    expect(second).toMatchObject({ claimed: 1, failed: 1, staged: 0, published: 0, retrying: 0 });
    expect(mock.reserveRequest.mock.calls[1][3]).not.toBe(firstFingerprint);
    expect(mock.callModel).toHaveBeenCalledOnce();
    expect(mock.finishRequest).toHaveBeenCalledOnce();
    expect(
      mock.taskRpc.mock.calls.find(([name]) => name === "fail_organization_job")?.[1],
    ).toMatchObject({ p_error_code: "REQUEST_CHANGED", p_retryable: false });
  });

  it("cannot consume a cached v1 model result after the shared semantic contract changes", async () => {
    taskRpcWithContext();
    const taskRpc = mock.taskRpc.getMockImplementation()!;
    mock.taskRpc.mockImplementation(async (...args) =>
      args[0] === "fail_organization_job"
        ? rpcResponse({ state: "failed", revision: 2 })
        : taskRpc(...args),
    );
    const oldFingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          "organization-worker-v1",
          modelConfig.baseUrl,
          modelConfig.model,
          modelConfig.jsonMode,
          contextDigest,
        ]),
      )
      .digest("hex");
    const cached = bindOrganizationResult(
      generatedSource(),
      buildOrganizationGrounding(workspace, organizationRequest),
      organizationRequest,
    );
    mock.reserveRequest.mockImplementation(async (_ledger, _owner, _request, fingerprint) => {
      if (fingerprint === oldFingerprint) return { kind: "cached", result: cached };
      throw new ApiError(409, "REQUEST_CHANGED", "资料或请求内容已改变，请重新发起模型请求。");
    });
    const summary = await runOrganizationTasks(taskStore(), {
      workerId: "organization-worker-1",
      limit: 1,
      leaseSeconds: 60,
    });
    expect(summary).toMatchObject({ claimed: 1, failed: 1, retrying: 0, staged: 0, published: 0 });
    expect(mock.reserveRequest).toHaveBeenCalledOnce();
    expect(mock.callModel).not.toHaveBeenCalled();
    expect(mock.finishRequest).not.toHaveBeenCalled();
    expect(
      mock.taskRpc.mock.calls.find(([name]) => name === "fail_organization_job")?.[1],
    ).toMatchObject({
      p_error_code: "REQUEST_CHANGED",
      p_retryable: false,
    });
    expect(mock.taskRpc.mock.calls.map(([name]) => name)).not.toContain(
      "stage_organization_job_result",
    );
  });

  it("claims, validates, stages, and publishes a freshly generated result", async () => {
    taskRpcWithContext();

    const summary = await runOrganizationTasks(taskStore(), {
      workerId: "organization-worker-1",
      limit: 1,
      leaseSeconds: 60,
    });

    expect(summary).toEqual({
      claimed: 1,
      published: 1,
      staged: 1,
      retrying: 0,
      failed: 0,
      cancelled: 0,
      capacityPending: 0,
    });
    expect(mock.taskRpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_organization_jobs",
      "read_organization_job_context",
      "heartbeat_organization_job",
      "heartbeat_organization_job",
      "stage_organization_job_result",
      "publish_organization_job",
    ]);
    expect(mock.reserveRequest).toHaveBeenCalledWith(
      ledger,
      ownerId,
      organizationRequest.requestId,
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
    expect(mock.callModel).toHaveBeenCalledOnce();
    expect(mock.finishRequest).toHaveBeenCalledWith(
      ledger,
      ownerId,
      organizationRequest.requestId,
      expect.objectContaining({ kind: "source", mode: "model" }),
    );
    const stage = mock.taskRpc.mock.calls.find(
      ([name]) => name === "stage_organization_job_result",
    );
    expect(stage?.[1]).toMatchObject({
      p_owner: ownerId,
      p_job_id: organizationRequest.requestId,
      p_lease_token: leaseToken,
      p_result: { kind: "source", mode: "model" },
    });
  });

  it("processes a multi-item lease batch serially instead of overlapping model calls", async () => {
    const secondRequest: OrganizationRequest = {
      ...organizationRequest,
      requestId: "organization-task-2",
    };
    const first = claim();
    const second = {
      ...claim(),
      jobId: secondRequest.requestId,
      leaseToken: "33333333-3333-4333-8333-333333333333",
    };
    const contextFor = (job: typeof first, request: OrganizationRequest) => ({
      ...context(),
      jobId: job.jobId,
      leaseToken: job.leaseToken,
      request,
    });
    mock.taskRpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      switch (name) {
        case "claim_organization_jobs":
          return rpcResponse({ jobs: [first, second] });
        case "read_organization_job_context":
          return rpcResponse(
            args.p_job_id === first.jobId
              ? contextFor(first, organizationRequest)
              : contextFor(second, secondRequest),
          );
        case "heartbeat_organization_job":
          return rpcResponse({ leaseUntil });
        case "stage_organization_job_result":
          return rpcResponse({ staged: true, resultDigest: "b".repeat(64) });
        case "publish_organization_job":
          return rpcResponse({ state: "succeeded", revision: 2 });
        default:
          throw new Error(`unexpected RPC ${name}`);
      }
    });
    let releaseFirst!: (result: string) => void;
    const firstModel = new Promise<string>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    mock.callModel.mockImplementation(() => {
      calls += 1;
      return calls === 1 ? firstModel : Promise.resolve(generatedSource());
    });

    const pending = runOrganizationTasks(taskStore(), {
      workerId: "organization-worker-1",
      limit: 5,
      leaseSeconds: 60,
    });
    await vi.waitFor(() => expect(mock.callModel).toHaveBeenCalledOnce());
    expect(
      mock.taskRpc.mock.calls.filter(
        ([name, args]) =>
          name === "read_organization_job_context" &&
          (args as Record<string, unknown>).p_job_id === second.jobId,
      ),
    ).toEqual([]);

    releaseFirst(generatedSource());
    await expect(pending).resolves.toMatchObject({ claimed: 2, staged: 2, published: 2 });
    expect(mock.callModel).toHaveBeenCalledTimes(2);
  });

  it("publishes an already staged result without reserving or calling the model", async () => {
    const staged = bindOrganizationResult(
      generatedSource(),
      buildOrganizationGrounding(workspace, organizationRequest),
      organizationRequest,
    );
    taskRpcWithContext(staged);

    const summary = await runOrganizationTasks(taskStore(), {
      workerId: "organization-worker-1",
      limit: 1,
      leaseSeconds: 60,
    });

    expect(summary).toMatchObject({ claimed: 1, published: 1, staged: 0 });
    expect(mock.taskRpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_organization_jobs",
      "read_organization_job_context",
      "publish_organization_job",
    ]);
    expect(mock.reserveRequest).not.toHaveBeenCalled();
    expect(mock.callModel).not.toHaveBeenCalled();
    expect(mock.finishRequest).not.toHaveBeenCalled();
  });

  it("records a retryable provider failure through the durable task RPC", async () => {
    taskRpcWithContext();
    mock.callModel.mockRejectedValue(
      new ApiError(503, "MODEL_UNAVAILABLE", "模型服务暂时不可用，请稍后重试。"),
    );

    const summary = await runOrganizationTasks(taskStore(), {
      workerId: "organization-worker-1",
      limit: 1,
      leaseSeconds: 60,
    });

    expect(summary).toMatchObject({ claimed: 1, retrying: 1, staged: 0, published: 0 });
    const failure = mock.taskRpc.mock.calls.find(([name]) => name === "fail_organization_job");
    expect(failure?.[1]).toMatchObject({
      p_owner: ownerId,
      p_job_id: organizationRequest.requestId,
      p_lease_token: leaseToken,
      p_error_code: "MODEL_UNAVAILABLE",
      p_retryable: true,
    });
    expect(mock.taskRpc.mock.calls.map(([name]) => name)).not.toContain(
      "stage_organization_job_result",
    );
    expect(mock.taskRpc.mock.calls.map(([name]) => name)).not.toContain("publish_organization_job");
  });

  it("requeues a durable task when a same-owner question owns the AI ledger", async () => {
    taskRpcWithContext();
    mock.reserveRequest.mockRejectedValue(
      new ApiError(409, "REQUEST_RUNNING", "已有模型请求正在处理，请等待完成或稍后重试。"),
    );

    const summary = await runOrganizationTasks(taskStore(), {
      workerId: "organization-worker-1",
      limit: 1,
      leaseSeconds: 60,
    });

    expect(summary).toMatchObject({ claimed: 1, retrying: 1, staged: 0, published: 0 });
    expect(
      mock.taskRpc.mock.calls.find(([name]) => name === "fail_organization_job")?.[1],
    ).toMatchObject({
      p_owner: ownerId,
      p_job_id: organizationRequest.requestId,
      p_lease_token: leaseToken,
      p_error_code: "REQUEST_RUNNING",
      p_retryable: true,
    });
    expect(mock.callModel).not.toHaveBeenCalled();
    expect(mock.taskRpc.mock.calls.map(([name]) => name)).not.toContain(
      "stage_organization_job_result",
    );
  });

  it("fails an invalid queue context before it can reach the model", async () => {
    mock.taskRpc.mockImplementation(async (name: string) => {
      if (name === "claim_organization_jobs") return rpcResponse({ jobs: [claim()] });
      if (name === "read_organization_job_context")
        return rpcResponse({ ...context(), contextDigest: "not-a-digest" });
      if (name === "fail_organization_job") return rpcResponse({ state: "failed", revision: 2 });
      throw new Error(`unexpected RPC ${name}`);
    });

    const summary = await runOrganizationTasks(taskStore(), {
      workerId: "organization-worker-1",
      limit: 1,
      leaseSeconds: 60,
    });

    expect(summary).toMatchObject({ claimed: 1, failed: 1, staged: 0, published: 0 });
    expect(mock.taskRpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_organization_jobs",
      "read_organization_job_context",
      "fail_organization_job",
    ]);
    expect(
      mock.taskRpc.mock.calls.find(([name]) => name === "fail_organization_job")?.[1],
    ).toMatchObject({
      p_error_code: "ORGANIZATION_PROCESSOR_INVALID",
      p_retryable: true,
    });
    expect(mock.readModelConfig).not.toHaveBeenCalled();
    expect(mock.callModel).not.toHaveBeenCalled();
  });

  it("rejects invalid processor inputs before queue access", async () => {
    await expect(
      runOrganizationTasks(taskStore(), {
        workerId: "",
        limit: 1,
        leaseSeconds: 60,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ORGANIZATION_PROCESSOR", status: 400 });

    expect(mock.taskRpc).not.toHaveBeenCalled();
    expect(mock.callModel).not.toHaveBeenCalled();
  });

  it("stops after a lease heartbeat aborts and never calls the model or failure RPC", async () => {
    const controller = new AbortController();
    taskRpcWithContext();
    mock.taskRpc.mockImplementation(async (name: string) => {
      if (name === "heartbeat_organization_job") controller.abort();
      if (name === "claim_organization_jobs") return rpcResponse({ jobs: [claim()] });
      if (name === "read_organization_job_context") return rpcResponse(context());
      if (name === "heartbeat_organization_job") return rpcResponse({ leaseUntil });
      throw new Error(`unexpected RPC ${name}`);
    });

    const summary = await runOrganizationTasks(taskStore(), {
      workerId: "organization-worker-1",
      limit: 1,
      leaseSeconds: 60,
      signal: controller.signal,
    });

    expect(summary).toMatchObject({ claimed: 1, staged: 0, published: 0, failed: 0 });
    expect(mock.taskRpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_organization_jobs",
      "read_organization_job_context",
      "heartbeat_organization_job",
    ]);
    expect(mock.reserveRequest).not.toHaveBeenCalled();
    expect(mock.callModel).not.toHaveBeenCalled();
  });
});
