import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  requireUser: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/api")>();
  return { ...actual, requireUser: mock.requireUser };
});

import { GET, PUT } from "@/app/api/v1/sources/[sourceId]/versions/[versionId]/outline/route";

const sourceId = "source-a";
const versionId = "version-a";
const context = { params: Promise.resolve({ sourceId, versionId }) };

function request(method: "GET" | "PUT", body?: unknown) {
  return new Request(`http://localhost/api/v1/sources/${sourceId}/versions/${versionId}/outline`, {
    method,
    headers: { "X-Conuo-User": "owner-a", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.requireUser.mockResolvedValue({ supabase: { rpc: mock.rpc }, user: { id: "owner-a" } });
});

describe("source outline route", () => {
  it("reads one source version outline through the owner-scoped RPC", async () => {
    mock.rpc.mockResolvedValue({
      data: [{ sourceId, versionId, method: "pdf-outline", items: [] }],
      error: null,
    });
    const response = await GET(request("GET"), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ sourceId, versionId, items: [] });
    expect(mock.rpc).toHaveBeenCalledWith("read_source_outlines", {
      p_refs: [{ sourceId, versionId }],
    });
  });

  it("validates and saves a bounded outline", async () => {
    const items = [{ title: "第一章", level: 1, page: 3 }];
    mock.rpc.mockResolvedValue({
      data: { sourceId, versionId, method: "pdf-outline", items },
      error: null,
    });
    const response = await PUT(request("PUT", { method: "pdf-outline", items }), context);
    expect(response.status).toBe(200);
    expect(mock.rpc).toHaveBeenCalledWith("save_source_outline", {
      p_source_id: sourceId,
      p_version_id: versionId,
      p_method: "pdf-outline",
      p_items: items,
    });
  });

  it("rejects malformed inputs before calling the database", async () => {
    const response = await PUT(
      request("PUT", { method: "pdf-outline", items: [{ title: "x", level: 7 }] }),
      context,
    );
    expect(response.status).toBe(400);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
});
