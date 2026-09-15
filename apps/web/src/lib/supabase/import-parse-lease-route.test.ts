import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  requireUser: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("@/lib/supabase/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/api")>();
  return { ...actual, requireUser: mock.requireUser };
});

import { POST as claim } from "@/app/api/v1/imports/parse/claim/route";
import { POST as cancel } from "@/app/api/v1/imports/parse/cancel/route";
import { POST as finish } from "@/app/api/v1/imports/parse/finish/route";
import { POST as heartbeat } from "@/app/api/v1/imports/parse/heartbeat/route";
import { POST as release } from "@/app/api/v1/imports/parse/release/route";
import { POST as retry } from "@/app/api/v1/imports/parse/retry/route";
import {
  advanceImportJob,
  completeImportJob,
  createImportJob,
  startImportJob,
} from "../import-queue";
import { createEmptyWorkspace } from "../seed";
import { MAX_WORKSPACE_BYTES } from "./validation";
import type { Source, WorkspaceData } from "../types";

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

function request(
  path: string,
  payload: unknown,
  options: { body?: string; headers?: HeadersInit } = {},
) {
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Conuo-User": ownerId,
  });
  new Headers(options.headers).forEach((value, key) => headers.set(key, value));
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers,
    body: options.body ?? JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.requireUser.mockResolvedValue({ supabase: { rpc: mock.rpc }, user: { id: ownerId } });
  mock.rpc.mockResolvedValue({
    data: { status: "claimed", lease_token: leaseToken, lease_until: leaseUntil },
    error: null,
  });
});

describe("import parse lease API boundary", () => {
  it("claims a current source-version lease and exposes only the normalized token fields", async () => {
    const response = await claim(request("/api/v1/imports/parse/claim", { sourceId, versionId }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "claimed", leaseToken, leaseUntil });
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("claim_import_parse", {
      p_source_id: sourceId,
      p_version_id: versionId,
    });
  });

  it("maps a database busy lease to the stable held client state without exposing a token", async () => {
    mock.rpc.mockResolvedValue({
      data: {
        status: "busy",
        leaseToken: "22222222-2222-4222-8222-222222222222",
        leaseUntil,
      },
      error: null,
    });

    const response = await claim(request("/api/v1/imports/parse/claim", { sourceId, versionId }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "held", leaseUntil });
  });

  it("renews and releases only the exact source/version/token tuple", async () => {
    mock.rpc.mockResolvedValueOnce({ data: { leaseUntil }, error: null });
    const heart = await heartbeat(
      request("/api/v1/imports/parse/heartbeat", { sourceId, versionId, leaseToken }),
    );
    expect(heart.status).toBe(200);
    await expect(heart.json()).resolves.toEqual({ status: "claimed", leaseUntil });
    expect(mock.rpc).toHaveBeenLastCalledWith("heartbeat_import_parse", {
      p_source_id: sourceId,
      p_version_id: versionId,
      p_lease_token: leaseToken,
    });

    mock.rpc.mockResolvedValueOnce({ data: { released: true }, error: null });
    const released = await release(
      request("/api/v1/imports/parse/release", { sourceId, versionId, leaseToken }),
    );
    expect(released.status).toBe(200);
    await expect(released.json()).resolves.toEqual({ released: true });
    expect(mock.rpc).toHaveBeenLastCalledWith("release_import_parse", {
      p_source_id: sourceId,
      p_version_id: versionId,
      p_lease_token: leaseToken,
    });
  });

  it("fences a terminal parser snapshot by source/version/token and workspace revision", async () => {
    const data = completedWorkspace();
    mock.rpc.mockResolvedValue({ data: { revision: 7 }, error: null });

    const response = await finish(
      request("/api/v1/imports/parse/finish", {
        data,
        expectedRevision: 6,
        sourceId,
        versionId,
        leaseToken,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revision: 7 });
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("finish_import_parse", {
      p_data: data,
      p_expected_revision: 6,
      p_source_id: sourceId,
      p_version_id: versionId,
      p_lease_token: leaseToken,
    });
  });

  it("accepts a failed terminal parser snapshot so it can be saved and its lease released atomically", async () => {
    const data = completedWorkspace();
    data.sources[0] = { ...data.sources[0], status: "failed", error: "无法读取正文。" };
    data.importJobs![0] = {
      ...data.importJobs![0],
      status: "failed",
      stage: "parsing",
      completedAt: undefined,
      error: "无法读取正文。",
    };
    mock.rpc.mockResolvedValue({ data: 7, error: null });

    const response = await finish(
      request("/api/v1/imports/parse/finish", {
        data,
        expectedRevision: 6,
        sourceId,
        versionId,
        leaseToken,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revision: 7 });
  });

  it("cancels a current source/version transition atomically without exposing another device's lease", async () => {
    const data = cancelledWorkspace();
    mock.rpc.mockResolvedValue({ data: { revision: 7 }, error: null });

    const response = await cancel(
      request("/api/v1/imports/parse/cancel", {
        data,
        expectedRevision: 6,
        sourceId,
        versionId,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revision: 7 });
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("cancel_import_parse", {
      p_data: data,
      p_expected_revision: 6,
      p_source_id: sourceId,
      p_version_id: versionId,
    });
  });

  it("retries only a terminal source through the controlled immutable-version transition", async () => {
    const data = retryWorkspace();
    mock.rpc.mockResolvedValue({ data: { revision: 7 }, error: null });

    const response = await retry(
      request("/api/v1/imports/parse/retry", {
        data,
        expectedRevision: 6,
        sourceId,
        versionId,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revision: 7 });
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("retry_import_parse", {
      p_data: data,
      p_expected_revision: 6,
      p_source_id: sourceId,
      p_version_id: versionId,
    });
  });

  it("rejects malformed identifiers, token, revision, and nonterminal snapshots before calling SQL", async () => {
    const invalidLease = await heartbeat(
      request("/api/v1/imports/parse/heartbeat", { sourceId: "bad/id", versionId, leaseToken }),
    );
    expect(invalidLease.status).toBe(400);

    const invalidFinish = await finish(
      request("/api/v1/imports/parse/finish", {
        data: createEmptyWorkspace(),
        expectedRevision: -1,
        sourceId,
        versionId,
        leaseToken: "not-a-uuid",
      }),
    );
    expect(invalidFinish.status).toBe(400);

    const foreignStoragePath = completedWorkspace();
    foreignStoragePath.sources[0] = {
      ...foreignStoragePath.sources[0],
      storagePath: "another-owner/version-a/source-a.txt",
    };
    const foreignResult = await finish(
      request("/api/v1/imports/parse/finish", {
        data: foreignStoragePath,
        expectedRevision: 6,
        sourceId,
        versionId,
        leaseToken,
      }),
    );
    expect(foreignResult.status).toBe(400);
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it("enforces the full workspace request capacity before a fenced finish can reach SQL", async () => {
    const data = completedWorkspace();
    data.sources[0] = { ...data.sources[0], text: "字".repeat(MAX_WORKSPACE_BYTES) };

    const response = await finish(
      request("/api/v1/imports/parse/finish", {
        data,
        expectedRevision: 6,
        sourceId,
        versionId,
        leaseToken,
      }),
    );

    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe("TOO_LARGE");
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it.each([
    [
      "claim",
      () => claim(request("/api/v1/imports/parse/claim", { sourceId, versionId })),
      "IMPORT_PARSE_LEASE_CHANGED",
    ],
    [
      "finish",
      () =>
        finish(
          request("/api/v1/imports/parse/finish", {
            data: completedWorkspace(),
            expectedRevision: 6,
            sourceId,
            versionId,
            leaseToken,
          }),
        ),
      "IMPORT_PARSE_FINISH_CONFLICT",
    ],
    [
      "cancel",
      () =>
        cancel(
          request("/api/v1/imports/parse/cancel", {
            data: cancelledWorkspace(),
            expectedRevision: 6,
            sourceId,
            versionId,
          }),
        ),
      "IMPORT_PARSE_CANCEL_CONFLICT",
    ],
    [
      "retry",
      () =>
        retry(
          request("/api/v1/imports/parse/retry", {
            data: retryWorkspace(),
            expectedRevision: 6,
            sourceId,
            versionId,
          }),
        ),
      "IMPORT_PARSE_RETRY_CONFLICT",
    ],
  ] as const)(
    "maps a %s 40001 database fence to a clear redacted conflict",
    async (_name, call, expectedCode) => {
      mock.rpc.mockResolvedValue({
        data: null,
        error: { code: "40001", message: "private SQL details" },
      });

      const response = await call();

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.code).toBe(expectedCode);
      expect(JSON.stringify(body)).not.toContain("private SQL details");
    },
  );

  it("maps invalid SQL parameters to 400 and never returns SQL error text", async () => {
    mock.rpc.mockResolvedValue({
      data: null,
      error: { code: "22023", message: "private parameter detail" },
    });

    const response = await claim(request("/api/v1/imports/parse/claim", { sourceId, versionId }));

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("INVALID_IMPORT_PARSE_REQUEST");
  });

  it("fails closed on malformed or unexpected SQL output", async () => {
    mock.rpc.mockResolvedValue({ data: { status: "claimed", leaseToken }, error: null });

    const response = await claim(request("/api/v1/imports/parse/claim", { sourceId, versionId }));

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("IMPORT_PARSE_UNAVAILABLE");
  });
});
