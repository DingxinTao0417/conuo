import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ requireUser: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/supabase/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase/api")>()),
  requireUser: mock.requireUser,
}));
vi.mock("@/lib/ai/features", () => ({ aiFeatureEnabled: () => true }));

import { GET, POST } from "@/app/api/v1/sources/[sourceId]/versions/[versionId]/summary/route";

const context = { params: Promise.resolve({ sourceId: "source-a", versionId: "v1" }) };
const request = (method = "GET") =>
  new Request("http://localhost/api/v1/sources/source-a/versions/v1/summary", {
    method,
    headers: {
      "X-Conuo-User": "owner-a",
      ...(method === "POST"
        ? { "Content-Type": "application/json", Origin: "http://localhost" }
        : {}),
    },
    ...(method === "POST" ? { body: "{}" } : {}),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mock.requireUser.mockResolvedValue({ supabase: { rpc: mock.rpc }, user: { id: "owner-a" } });
});

describe("source summary route", () => {
  it("requests an idempotent summary job", async () => {
    mock.rpc.mockResolvedValue({ data: { state: "queued" }, error: null });
    const response = await POST(request("POST"), context);
    expect(response.status).toBe(202);
    expect(mock.rpc).toHaveBeenCalledWith("request_source_summary", {
      p_source_id: "source-a",
      p_version_id: "v1",
    });
  });

  it("reads status and cached content", async () => {
    mock.rpc.mockResolvedValue({ data: { state: "succeeded", summaries: [] }, error: null });
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(mock.rpc).toHaveBeenCalledWith("source_summary_status", {
      p_source_id: "source-a",
      p_version_id: "v1",
    });
  });
});
