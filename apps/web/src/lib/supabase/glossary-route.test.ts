import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ requireUser: vi.fn(), rpc: vi.fn() }));

vi.mock("@/lib/supabase/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase/api")>()),
  requireUser: mock.requireUser,
}));

import { GET, POST } from "@/app/api/v1/glossary/route";
import { DELETE as DELETE_TERM } from "@/app/api/v1/glossary/[termId]/route";

const term = {
  termId: "term-a",
  spaceId: "space-a",
  term: "梯度下降",
  aliases: ["gradient descent"],
  definition: {
    text: "一种优化算法。",
    chunkRefs: [{ sourceId: "source-a", versionId: "v1", chunkId: "chunk-a" }],
  },
  status: "accepted",
  origin: "user",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function request(method: string, body?: unknown) {
  return new Request("http://localhost/api/v1/glossary?spaceId=space-a", {
    method,
    headers: {
      "X-Conuo-User": "owner-a",
      ...(body === undefined
        ? {}
        : { "Content-Type": "application/json", Origin: "http://localhost" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.requireUser.mockResolvedValue({ user: { id: "owner-a" }, supabase: { rpc: mock.rpc } });
});

describe("glossary routes", () => {
  it("lists accepted and rejected terms through the owner-bound RPC", async () => {
    mock.rpc.mockResolvedValue({ data: [term], error: null });
    const response = await GET(request("GET"));
    expect(response.status).toBe(200);
    expect(mock.rpc).toHaveBeenCalledWith("list_glossary_terms", { p_space_id: "space-a" });
  });

  it("upserts a validated user edit without auto-saving suggestions", async () => {
    mock.rpc.mockResolvedValue({ data: term, error: null });
    const response = await POST(
      request("POST", {
        spaceId: term.spaceId,
        termId: term.termId,
        term: term.term,
        aliases: term.aliases,
        definition: term.definition,
        status: term.status,
        origin: term.origin,
      }),
    );
    expect(response.status).toBe(200);
    expect(mock.rpc).toHaveBeenCalledWith("upsert_glossary_term", {
      p_space_id: "space-a",
      p_term_id: "term-a",
      p_term: "梯度下降",
      p_aliases: ["gradient descent"],
      p_definition: term.definition,
      p_status: "accepted",
      p_origin: "user",
    });
  });

  it("deletes only the requested term", async () => {
    mock.rpc.mockResolvedValue({
      data: { deleted: true, termId: "term-a", spaceId: "space-a" },
      error: null,
    });
    const response = await DELETE_TERM(request("DELETE"), {
      params: Promise.resolve({ termId: "term-a" }),
    });
    expect(response.status).toBe(200);
    expect(mock.rpc).toHaveBeenCalledWith("delete_glossary_term", {
      p_space_id: "space-a",
      p_term_id: "term-a",
    });
  });

  it("rejects malformed edits before touching the RPC", async () => {
    const response = await POST(request("POST", { ...term, termId: "bad id" }));
    expect(response.status).toBe(400);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
});
