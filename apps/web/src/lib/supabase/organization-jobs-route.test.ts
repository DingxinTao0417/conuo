import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationJob, OrganizationRequest } from "../organization-types";

const mock = vi.hoisted(() => ({
  requireUser: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/api")>();
  return { ...actual, requireUser: mock.requireUser };
});

import { POST as cancel } from "@/app/api/v1/organization-jobs/cancel/route";
import { POST as enqueue } from "@/app/api/v1/organization-jobs/route";
import { POST as reconcile } from "@/app/api/v1/organization-jobs/reconcile/route";

const ownerId = "owner-a";
const now = "2026-09-14T12:00:00.000Z";
const request: OrganizationRequest = {
  requestId: "organization-job-a",
  kind: "source",
  trigger: "manual",
  spaceId: "inbox",
  sourceIds: ["source-a"],
  sourceVersions: [{ sourceId: "source-a", versionId: "version-a" }],
};
const queuedJob: OrganizationJob = {
  id: request.requestId,
  durable: true,
  request,
  status: "queued",
  createdAt: now,
  updatedAt: now,
};
const completedJob: OrganizationJob = {
  ...queuedJob,
  status: "ready",
  result: {
    kind: "source",
    mode: "model",
    summary: {
      title: "总结",
      content: "这是一条模型结果。",
      citations: [
        {
          sourceId: "source-a",
          versionId: "version-a",
          chunkId: "chunk-a",
          title: "资料",
          quote: "仅用于测试的模型内容。",
          section: "正文",
        },
      ],
    },
    tags: [],
    topics: [],
    coverage: "测试覆盖范围。",
  },
};

function jsonRequest(path: string, payload: unknown) {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Conuo-User": ownerId },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.requireUser.mockResolvedValue({ supabase: { rpc: mock.rpc }, user: { id: ownerId } });
});

describe("durable organization job API boundary", () => {
  it("enqueues only a bounded request and revision, then returns a redacted projection", async () => {
    mock.rpc.mockResolvedValue({
      data: { revision: 8, job: queuedJob, created: true },
      error: null,
    });

    const response = await enqueue(
      jsonRequest("/api/v1/organization-jobs", { request, expectedRevision: 7 }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      revision: 8,
      job: queuedJob,
      created: true,
    });
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("enqueue_organization_job", {
      p_request: request,
      p_expected_revision: 7,
    });
  });

  it("rejects update/relations, unknown fields, and invalid revisions before SQL", async () => {
    const unsupported = await enqueue(
      jsonRequest("/api/v1/organization-jobs", {
        request: { ...request, kind: "update" },
        expectedRevision: 7,
      }),
    );
    expect(unsupported.status).toBe(400);

    const extra = await enqueue(
      jsonRequest("/api/v1/organization-jobs", {
        request,
        expectedRevision: 0,
        workspace: { private: "must-not-send" },
      }),
    );
    expect(extra.status).toBe(400);
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["40001", 409, "ORGANIZATION_JOB_CONTEXT_CHANGED"],
    ["PT409", 409, "ORGANIZATION_JOB_CONTEXT_CHANGED"],
    ["22023", 400, "INVALID_ORGANIZATION_JOB"],
    ["55P03", 503, "ORGANIZATION_JOB_BUSY"],
  ])("maps enqueue SQL %s without exposing its message", async (code, status, expectedCode) => {
    mock.rpc.mockResolvedValue({
      data: null,
      error: { code, message: "private database query and data" },
    });

    const response = await enqueue(
      jsonRequest("/api/v1/organization-jobs", { request, expectedRevision: 7 }),
    );

    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.code).toBe(expectedCode);
    expect(JSON.stringify(body)).not.toContain("private database");
  });

  it("fails closed when the enqueue RPC returns an incomplete projection", async () => {
    mock.rpc.mockResolvedValue({ data: { revision: 8, created: true }, error: null });

    const response = await enqueue(
      jsonRequest("/api/v1/organization-jobs", { request, expectedRevision: 7 }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "ORGANIZATION_JOBS_UNAVAILABLE" });
  });

  it("cancels behind the revision fence and never returns an already generated model result", async () => {
    mock.rpc.mockResolvedValue({
      data: { revision: 8, job: completedJob, cancelled: false },
      error: null,
    });

    const response = await cancel(
      jsonRequest("/api/v1/organization-jobs/cancel", {
        jobId: request.requestId,
        expectedRevision: 7,
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ revision: 8, cancelled: false, job: { id: request.requestId } });
    expect(body.job).not.toHaveProperty("result");
    expect(JSON.stringify(body)).not.toContain("仅用于测试的模型内容");
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("cancel_organization_job", {
      p_job_id: request.requestId,
      p_expected_revision: 7,
    });
  });

  it("reconciles through a protected empty JSON request and returns only status summaries", async () => {
    mock.rpc.mockResolvedValue({
      data: {
        revision: 8,
        jobs: [{ id: request.requestId, state: "running", updatedAt: now }],
      },
      error: null,
    });

    const response = await reconcile(jsonRequest("/api/v1/organization-jobs/reconcile", {}));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      revision: 8,
      jobs: [{ id: request.requestId, state: "running", updatedAt: now }],
    });
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("reconcile_organization_jobs", {});
  });
});
