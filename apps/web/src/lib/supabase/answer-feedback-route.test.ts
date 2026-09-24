import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/supabase/api";

const mock = vi.hoisted(() => ({ requireUser: vi.fn(), rpc: vi.fn() }));

vi.mock("@/lib/supabase/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase/api")>()),
  requireUser: mock.requireUser,
}));

import { DELETE, POST } from "@/app/api/v1/ai/feedback/route";

const ownerId = "owner-a";

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/v1/ai/feedback", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost",
      "X-Conuo-User": ownerId,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.requireUser.mockResolvedValue({ user: { id: ownerId }, supabase: { rpc: mock.rpc } });
  mock.rpc.mockResolvedValue({ data: { requestId: "request-a" }, error: null });
});

describe("answer feedback route", () => {
  it("validates the contract and sends the verified owner feedback to the RPC", async () => {
    const response = await POST(
      request({
        requestId: "request-a",
        conversationId: "conversation-a",
        messageId: "message-a",
        rating: "down",
        reasons: ["incorrect"],
        comment: "请重新核对。",
        includeContent: true,
        question: "问题",
        answer: "回答",
      }),
    );
    expect(response.status).toBe(200);
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("submit_answer_feedback", {
      p_feedback: expect.objectContaining({
        requestId: "request-a",
        rating: "down",
        reasons: ["incorrect"],
        includeContent: true,
        question: "问题",
        answer: "回答",
        contractVersion: expect.any(String),
      }),
    });
  });

  it("rejects content unless the explicit include-content checkbox is selected", async () => {
    const response = await POST(
      request({ requestId: "request-a", rating: "up", includeContent: false, question: "泄漏" }),
    );
    expect(response.status).toBe(400);
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it("requires a strict id and maps session changes to the existing 409 boundary", async () => {
    mock.requireUser.mockRejectedValueOnce(
      new ApiError(409, "SESSION_CHANGED", "当前账号已改变。"),
    );
    const response = await POST(request({ requestId: "request-a", rating: "up" }));
    expect(response.status).toBe(409);

    const invalid = await POST(request({ requestId: "bad id", rating: "up" }));
    expect(invalid.status).toBe(400);
  });

  it("withdraws feedback through the owner-bound RPC", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/v1/ai/feedback?requestId=request-a", {
        method: "DELETE",
        headers: { Origin: "http://localhost", "X-Conuo-User": ownerId },
      }),
    );
    expect(response.status).toBe(200);
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("withdraw_answer_feedback", {
      p_request_id: "request-a",
    });
  });
});
