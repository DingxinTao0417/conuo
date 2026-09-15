import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationJob } from "./organization-types";
import type { DurableOrganizationRequest } from "./organization-jobs";

const mock = vi.hoisted(() => ({ config: vi.fn(), fetch: vi.fn<typeof fetch>() }));
vi.mock("./supabase/config", () => ({ getSupabaseConfig: mock.config }));
vi.mock("./supabase/client", () => ({ createClient: vi.fn() }));

import {
  cancelOrganizationJob,
  CloudError,
  enqueueOrganizationJob,
  reconcileOrganizationJobs,
} from "./cloud";

const ownerId = "owner-a";
const now = "2026-09-14T12:00:00.000Z";
const request: DurableOrganizationRequest = {
  requestId: "organization-job-a",
  kind: "source",
  trigger: "manual",
  spaceId: "inbox",
  sourceIds: ["source-a"],
  sourceVersions: [{ sourceId: "source-a", versionId: "version-a" }],
};
const job: OrganizationJob = {
  id: request.requestId,
  durable: true,
  request,
  status: "ready",
  createdAt: now,
  updatedAt: now,
  result: {
    kind: "source",
    mode: "model",
    summary: {
      title: "总结",
      content: "不应透过任务 API 返回。",
      citations: [
        {
          sourceId: "source-a",
          versionId: "version-a",
          chunkId: "chunk-a",
          title: "资料",
          quote: "模型私有内容。",
          section: "正文",
        },
      ],
    },
    tags: [],
    topics: [],
    coverage: "测试覆盖范围。",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mock.fetch);
  mock.config.mockReturnValue({ url: "https://project.example.test", key: "publishable-test-key" });
});
afterEach(() => vi.unstubAllGlobals());

describe("durable organization job cloud adapter", () => {
  it("sends only a request and revision, while redacting returned model results", async () => {
    mock.fetch.mockResolvedValue(Response.json({ revision: 8, job, created: false }));

    const result = await enqueueOrganizationJob(request, 7, ownerId);

    expect(result).toMatchObject({ revision: 8, created: false, job: { id: request.requestId } });
    expect(result.job).not.toHaveProperty("result");
    expect(mock.fetch).toHaveBeenCalledExactlyOnceWith(
      "/api/v1/organization-jobs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ request, expectedRevision: 7 }),
        credentials: "same-origin",
        cache: "no-store",
        headers: expect.objectContaining({ "X-Conuo-User": ownerId }),
      }),
    );
  });

  it("validates the durable request before network transport", async () => {
    const error = await enqueueOrganizationJob(
      { ...request, kind: "relations" } as DurableOrganizationRequest,
      7,
      ownerId,
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CloudError);
    expect(error).toMatchObject({ status: 400, code: "INVALID_ORGANIZATION_JOB" });
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it("uses distinct cancellation and reconciliation contracts", async () => {
    mock.fetch.mockResolvedValueOnce(Response.json({ revision: 8, job, cancelled: false }));
    await expect(cancelOrganizationJob(request.requestId, 7, ownerId)).resolves.toMatchObject({
      revision: 8,
      cancelled: false,
    });
    expect(mock.fetch).toHaveBeenLastCalledWith(
      "/api/v1/organization-jobs/cancel",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ jobId: request.requestId, expectedRevision: 7 }),
      }),
    );

    mock.fetch.mockResolvedValueOnce(
      Response.json({
        revision: 8,
        jobs: [{ id: request.requestId, state: "queued", updatedAt: now }],
      }),
    );
    await expect(reconcileOrganizationJobs(ownerId)).resolves.toEqual({
      revision: 8,
      jobs: [{ id: request.requestId, state: "queued", updatedAt: now }],
    });
    expect(mock.fetch).toHaveBeenLastCalledWith(
      "/api/v1/organization-jobs/reconcile",
      expect.objectContaining({ method: "POST", body: JSON.stringify({}) }),
    );
  });

  it("fails closed on malformed success contracts", async () => {
    mock.fetch.mockResolvedValue(Response.json({ revision: 8, created: true }));

    await expect(enqueueOrganizationJob(request, 7, ownerId)).rejects.toMatchObject({
      status: 503,
      code: "ORGANIZATION_JOBS_UNAVAILABLE",
    });
  });
});
