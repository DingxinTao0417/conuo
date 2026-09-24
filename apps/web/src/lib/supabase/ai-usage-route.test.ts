import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import type { AiRequestUsage } from "@/lib/ai-request-usage";

const mock = vi.hoisted(() => ({
  requireUser: vi.fn(),
  createRequestStore: vi.fn(),
  readAiRequestUsage: vi.fn(),
}));
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  requireUser: mock.requireUser,
}));
vi.mock("@/lib/ai/requests", () => ({ createRequestStore: mock.createRequestStore }));
vi.mock("@/lib/ai/usage", () => ({ readAiRequestUsage: mock.readAiRequestUsage }));
import { GET } from "@/app/api/v1/ai/usage/route";

const usage: AiRequestUsage = {
  usedCount: 12,
  dailyLimit: 50,
  remainingCount: 38,
  windowStart: "2026-09-14T00:00:00.000Z",
  resetsAt: "2026-09-15T00:00:00.000Z",
  checkedAt: "2026-09-14T12:00:00.000Z",
  counting: "reserved_requests",
  includesFailedAndCancelled: true,
  tokens: { promptTokens: 120, completionTokens: 30, limit: 0 },
};
const store = { test: "privileged-store" };
function request(query = "", signal?: AbortSignal) {
  return new Request(`http://localhost/api/v1/ai/usage${query}`, {
    headers: { "X-Conuo-User": "owner-a" },
    signal,
  });
}
beforeEach(() => {
  Object.values(mock).forEach((fn) => fn.mockReset());
  mock.requireUser.mockResolvedValue({ user: { id: "owner-a" } });
  mock.createRequestStore.mockReturnValue(store);
  mock.readAiRequestUsage.mockResolvedValue(usage);
});

describe("AI usage route authorization", () => {
  it("uses the verified owner, never query input, and returns only a private non-cacheable aggregate", async () => {
    const response = await GET(request("?ownerId=owner-b&owner_id=owner-b"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(usage);
    expect(mock.readAiRequestUsage).toHaveBeenCalledExactlyOnceWith(
      store,
      "owner-a",
      expect.any(AbortSignal),
    );
    expect(mock.requireUser).toHaveBeenCalledTimes(2);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Vary")).toBe("Cookie, Authorization");
  });

  it.each([
    new ApiError(401, "UNAUTHENTICATED", "请先登录。"),
    new ApiError(409, "SESSION_CHANGED", "当前账号已改变。"),
    new ApiError(423, "ACCOUNT_DELETION_PENDING", "账号正在注销。"),
  ])("does not create a privileged client before caller authorization: $code", async (error) => {
    mock.requireUser.mockRejectedValue(error);
    const response = await GET(request());
    expect(response.status).toBe(error.status);
    expect(mock.createRequestStore).not.toHaveBeenCalled();
    expect(mock.readAiRequestUsage).not.toHaveBeenCalled();
  });

  it("reports unconfigured service as unknown, with no fabricated counts", async () => {
    mock.createRequestStore.mockImplementation(() => {
      throw new ApiError(503, "MODEL_LEDGER_NOT_CONFIGURED", "请求记录服务尚未配置。");
    });
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "MODEL_LEDGER_NOT_CONFIGURED",
      error: "请求记录服务尚未配置。",
    });
  });

  it("suppresses the count when deletion or an account change wins the final check", async () => {
    mock.requireUser
      .mockResolvedValueOnce({ user: { id: "owner-a" } })
      .mockRejectedValueOnce(new ApiError(423, "ACCOUNT_DELETION_PENDING", "账号正在注销。"));
    expect((await GET(request())).status).toBe(423);
    mock.requireUser
      .mockResolvedValueOnce({ user: { id: "owner-a" } })
      .mockResolvedValueOnce({ user: { id: "owner-b" } });
    const response = await GET(request());
    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty("usedCount");
  });

  it("does not publish a completed aggregate after cancellation", async () => {
    const controller = new AbortController();
    mock.readAiRequestUsage.mockImplementation(async () => {
      controller.abort();
      return usage;
    });
    const response = await GET(request("", controller.signal));
    expect(response.status).toBe(499);
    expect(await response.json()).not.toHaveProperty("remainingCount");
  });

  it("does not forward raw privileged errors", async () => {
    mock.readAiRequestUsage.mockRejectedValue(new Error("private database result"));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("private database");
  });
});
