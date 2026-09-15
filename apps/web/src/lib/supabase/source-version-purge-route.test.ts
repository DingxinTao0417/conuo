import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  requireUser: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/api")>();
  return { ...actual, requireUser: mock.requireUser };
});

import { GET, POST } from "@/app/api/v1/sources/[sourceId]/versions/[versionId]/purge/route";
import { createEmptyWorkspace } from "../seed";

const owner = "owner-a";
const sourceId = "source-a";
const versionId = "version-old";
const fingerprint = "a".repeat(64);
const purgeId = "f5d81be7-8cf9-437c-a371-8ea571c006ca";
const context = { params: Promise.resolve({ sourceId, versionId }) };

function request(method: "GET" | "POST", body?: unknown) {
  return new Request(
    `http://localhost:3000/api/v1/sources/${sourceId}/versions/${versionId}/purge`,
    {
      method,
      headers: {
        "X-Conuo-User": owner,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.requireUser.mockResolvedValue({ supabase: { rpc: mock.rpc }, user: { id: owner } });
});

describe("source version purge route", () => {
  it("returns a server-derived preview for the exact historical version", async () => {
    mock.rpc.mockResolvedValue({
      data: {
        revision: 7,
        fingerprint,
        impact: { version: { versionId }, blockingImportJobs: 0 },
        blockers: { annotations: [], conceptRelations: [], organizationJobs: [], importJobs: [] },
      },
      error: null,
    });

    const response = await GET(request("GET"), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ revision: 7, fingerprint });
    expect(mock.rpc).toHaveBeenCalledWith("preview_source_version_purge", {
      p_source_id: sourceId,
      p_version_id: versionId,
    });
  });

  it("submits only revision and fingerprint and accepts the returned workspace", async () => {
    mock.rpc.mockResolvedValue({
      data: { revision: 8, data: createEmptyWorkspace(), purgeId, cleanupPending: true },
      error: null,
    });

    const response = await POST(request("POST", { expectedRevision: 7, fingerprint }), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      revision: 8,
      purgeId,
      cleanupPending: true,
    });
    expect(mock.rpc).toHaveBeenCalledWith("request_source_version_purge", {
      p_source_id: sourceId,
      p_version_id: versionId,
      p_expected_revision: 7,
      p_fingerprint: fingerprint,
    });
  });

  it("does not expose blocker details from the database", async () => {
    mock.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "private detail" } });

    const response = await POST(request("POST", { expectedRevision: 7, fingerprint }), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "这个历史版本仍有已保存内容或进行中的任务，请先处理后再清理。",
      code: "PURGE_BLOCKED",
    });
  });

  it("rejects malformed target and confirmation input before an RPC", async () => {
    const badContext = { params: Promise.resolve({ sourceId, versionId: "not valid" }) };
    const badTarget = await GET(request("GET"), badContext);
    expect(badTarget.status).toBe(400);
    const badInput = await POST(
      request("POST", { expectedRevision: 0, fingerprint: "wrong" }),
      context,
    );
    expect(badInput.status).toBe(400);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
});
