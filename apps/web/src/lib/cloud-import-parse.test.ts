import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ config: vi.fn(), fetch: vi.fn<typeof fetch>() }));
vi.mock("./supabase/config", () => ({ getSupabaseConfig: mock.config }));
vi.mock("./supabase/client", () => ({ createClient: vi.fn() }));

import {
  cancelImportParse,
  claimImportParse,
  CloudError,
  finishImportParse,
  heartbeatImportParse,
  releaseImportParse,
  retryImportParse,
} from "./cloud";
import {
  advanceImportJob,
  completeImportJob,
  createImportJob,
  startImportJob,
} from "./import-queue";
import { createEmptyWorkspace } from "./seed";
import { MAX_WORKSPACE_BYTES } from "./supabase/validation";
import type { Source, WorkspaceData } from "./types";

const ownerId = "owner-a";
const sourceId = "source-a";
const versionId = "version-a";
const leaseToken = "11111111-1111-4111-8111-111111111111";
const leaseUntil = "2026-09-13T12:02:00.000Z";
const now = "2026-09-13T12:00:00.000Z";

function completedWorkspace(): WorkspaceData {
  const data = createEmptyWorkspace();
  const source: Source = {
    id: sourceId,
    versionId,
    title: "资料",
    filename: "study.txt",
    kind: "text",
    mime: "text/plain",
    size: 12,
    hash: "hash",
    spaceIds: [],
    tags: [],
    status: "ready",
    text: "已完成解析的正文。",
    chunks: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    aiAllowed: true,
    starred: false,
  };
  let job = createImportJob({
    sourceId,
    versionId,
    filename: source.filename,
    spaceId: "",
    at: now,
  });
  job = startImportJob(job, now);
  job = advanceImportJob(job, "parsing", now);
  job = advanceImportJob(job, "indexing", now);
  job = completeImportJob(job, now);
  return { ...data, sources: [source], importJobs: [job] };
}

function cancelledWorkspace(): WorkspaceData {
  const data = completedWorkspace();
  data.sources[0] = {
    ...data.sources[0],
    status: "saved",
    text: "",
    chunks: [],
    error: "解析已取消。",
  };
  data.importJobs![0] = {
    ...data.importJobs![0],
    status: "cancelled",
    stage: "parsing",
    cancelledAt: now,
    completedAt: undefined,
    error: undefined,
  };
  return data;
}

function retryWorkspace(): WorkspaceData {
  const data = cancelledWorkspace();
  data.sources[0] = {
    ...data.sources[0],
    status: "parsing",
    error: undefined,
  };
  data.importJobs![0] = {
    ...data.importJobs![0],
    status: "queued",
    stage: "parsing",
    cancelledAt: undefined,
  };
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mock.fetch);
  mock.config.mockReturnValue({ url: "https://project.example.test", key: "publishable-test-key" });
});
afterEach(() => vi.unstubAllGlobals());

describe("import parse lease cloud adapter", () => {
  it("sends only a source/version identity and returns a claimed lease", async () => {
    mock.fetch.mockResolvedValue(Response.json({ status: "claimed", leaseToken, leaseUntil }));

    await expect(claimImportParse(sourceId, versionId, ownerId)).resolves.toEqual({
      status: "claimed",
      leaseToken,
      leaseUntil,
    });
    expect(mock.fetch).toHaveBeenCalledExactlyOnceWith(
      "/api/v1/imports/parse/claim",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ sourceId, versionId }),
        credentials: "same-origin",
        cache: "no-store",
        headers: expect.objectContaining({ "X-Conuo-User": ownerId }),
      }),
    );
  });

  it("keeps the stable held status and validates renewal/release response contracts", async () => {
    mock.fetch.mockResolvedValueOnce(Response.json({ status: "held" }));
    await expect(claimImportParse(sourceId, versionId, ownerId)).resolves.toEqual({
      status: "held",
    });

    mock.fetch.mockResolvedValueOnce(Response.json({ status: "claimed", leaseUntil }));
    await expect(heartbeatImportParse(sourceId, versionId, leaseToken, ownerId)).resolves.toEqual({
      status: "claimed",
      leaseUntil,
    });

    mock.fetch.mockResolvedValueOnce(Response.json({ released: true }));
    await expect(
      releaseImportParse(sourceId, versionId, leaseToken, ownerId),
    ).resolves.toBeUndefined();
  });

  it("validates a complete workspace/capacity before issuing a fenced finish", async () => {
    const invalid = await finishImportParse(
      createEmptyWorkspace(),
      -1,
      "bad/id",
      versionId,
      "not-a-uuid",
      ownerId,
    ).catch((error: unknown) => error);
    expect(invalid).toBeInstanceOf(CloudError);
    expect(invalid).toMatchObject({ status: 400, code: "INVALID_IMPORT_PARSE_REQUEST" });

    const tooLarge = completedWorkspace();
    tooLarge.sources[0] = { ...tooLarge.sources[0], text: "字".repeat(MAX_WORKSPACE_BYTES) };
    await expect(
      finishImportParse(tooLarge, 6, sourceId, versionId, leaseToken, ownerId),
    ).rejects.toMatchObject({ status: 413, code: "TOO_LARGE" });
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it("sends a typed fenced snapshot and accepts only a revision result", async () => {
    const data = completedWorkspace();
    mock.fetch.mockResolvedValue(Response.json({ revision: 7 }));

    await expect(
      finishImportParse(data, 6, sourceId, versionId, leaseToken, ownerId),
    ).resolves.toEqual({
      revision: 7,
    });
    expect(mock.fetch).toHaveBeenCalledWith(
      "/api/v1/imports/parse/finish",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(JSON.parse(String(mock.fetch.mock.calls[0][1]?.body))).toEqual({
      data,
      expectedRevision: 6,
      sourceId,
      versionId,
      leaseToken,
    });
  });

  it("sends distinct typed cancellation and retry transitions", async () => {
    const cancellation = cancelledWorkspace();
    mock.fetch.mockResolvedValueOnce(Response.json({ revision: 7 }));
    await expect(cancelImportParse(cancellation, 6, sourceId, versionId, ownerId)).resolves.toEqual(
      { revision: 7 },
    );
    expect(mock.fetch).toHaveBeenLastCalledWith(
      "/api/v1/imports/parse/cancel",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(String(mock.fetch.mock.calls[0][1]?.body))).toEqual({
      data: cancellation,
      expectedRevision: 6,
      sourceId,
      versionId,
    });

    const retryData = retryWorkspace();
    mock.fetch.mockResolvedValueOnce(Response.json({ revision: 8 }));
    await expect(retryImportParse(retryData, 7, sourceId, versionId, ownerId)).resolves.toEqual({
      revision: 8,
    });
    expect(mock.fetch).toHaveBeenLastCalledWith(
      "/api/v1/imports/parse/retry",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(String(mock.fetch.mock.calls[1][1]?.body))).toEqual({
      data: retryData,
      expectedRevision: 7,
      sourceId,
      versionId,
    });
  });

  it("fails closed for malformed success and error JSON without echoing server objects", async () => {
    mock.fetch.mockResolvedValueOnce(Response.json({ status: "claimed", leaseToken }));
    await expect(claimImportParse(sourceId, versionId, ownerId)).rejects.toMatchObject({
      status: 503,
      code: "CLOUD_ERROR",
    });

    mock.fetch.mockResolvedValueOnce(
      Response.json(
        { error: { private: "do-not-copy" }, code: { private: "do-not-copy" } },
        { status: 500 },
      ),
    );
    const error = await claimImportParse(sourceId, versionId, ownerId).catch(
      (cause: unknown) => cause,
    );
    expect(error).toMatchObject({
      status: 500,
      code: "CLOUD_ERROR",
      message: "云端请求失败，请稍后重试。",
    });
    expect(String(error)).not.toContain("do-not-copy");
  });
});
