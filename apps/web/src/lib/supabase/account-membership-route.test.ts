import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";

const mock = vi.hoisted(() => ({
  requireUser: vi.fn(),
  rpc: vi.fn(),
  plans: vi.fn(),
  readModelProfile: vi.fn(),
}));
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  requireUser: mock.requireUser,
}));
vi.mock("@/lib/ai/model", () => ({ readModelProfile: mock.readModelProfile }));
import { GET } from "@/app/api/v1/account/membership/route";

const allFeatures = {
  vision_region: true,
  organization: true,
  learning_ai: true,
  deep_thinking: true,
  tutor_mode: true,
};
const resolved = {
  planCode: "pro",
  planName: "专业版",
  tierRank: 10,
  source: "promotion",
  grantId: "00000000-0000-4000-8000-000000000001",
  startsAt: "2026-09-25T00:00:00+00:00",
  endsAt: "2026-10-25T00:00:00.123456+00:00",
  afterEnd: "free",
  limits: { aiDailyRequests: 100, learningSpaces: 500 },
  features: { ...allFeatures, learning_ai: false },
};
const planRows = [
  {
    code: "free",
    name: "免费版",
    description: "基础",
    ai_daily_request_limit: 20,
    learning_space_limit: 500,
  },
  {
    code: "pro",
    name: "专业版",
    description: "高频",
    ai_daily_request_limit: 100,
    learning_space_limit: 500,
  },
];

function request() {
  return new Request("http://localhost/api/v1/account/membership?owner=owner-b", {
    headers: { "X-Conuo-User": "owner-a" },
  });
}

beforeEach(() => {
  Object.values(mock).forEach((fn) => fn.mockReset());
  vi.stubEnv("CONUO_MEMBERSHIP_ENFORCEMENT", "");
  vi.stubEnv("CONUO_FEATURE_LEARNING", "on");
  vi.stubEnv("CONUO_FEATURE_DEEP_THINKING", "off");
  vi.stubEnv("CONUO_FEATURE_TUTOR_MODE", "on");
  mock.readModelProfile.mockReturnValue({ profile: "vision", config: {} });
  mock.rpc.mockReturnValue({ abortSignal: () => Promise.resolve({ data: resolved, error: null }) });
  mock.plans.mockReturnValue(Promise.resolve({ data: planRows, error: null }));
  const supabase = {
    rpc: mock.rpc,
    from: () => ({
      select: () => ({ order: () => ({ abortSignal: mock.plans }) }),
    }),
  };
  mock.requireUser.mockResolvedValue({ supabase, user: { id: "owner-a" } });
});
afterEach(() => vi.unstubAllEnvs());

describe("account membership route", () => {
  it("resolves the caller's own plan through the session RPC and hides grant identifiers", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("my_membership");
    expect(body).toEqual({
      planCode: "pro",
      planName: "专业版",
      source: "promotion",
      startsAt: "2026-09-25T00:00:00.000Z",
      endsAt: "2026-10-25T00:00:00.123Z",
      afterEnd: "free",
      enforcement: "off",
      limits: { aiDailyRequests: 100, learningSpaces: 500 },
      // off: plan switches are not enforced, so only deployment switches apply.
      features: { ...allFeatures, deep_thinking: false },
      plans: [
        {
          code: "free",
          name: "免费版",
          description: "基础",
          limits: { aiDailyRequests: 20, learningSpaces: 500 },
        },
        {
          code: "pro",
          name: "专业版",
          description: "高频",
          limits: { aiDailyRequests: 100, learningSpaces: 500 },
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("grantId");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("combines deployment and plan switches when enforcement is on", async () => {
    vi.stubEnv("CONUO_MEMBERSHIP_ENFORCEMENT", "on");
    mock.readModelProfile.mockReturnValue(null);
    const body = await (await GET(request())).json();
    expect(body.enforcement).toBe("on");
    expect(body.features).toEqual({
      vision_region: false,
      organization: true,
      learning_ai: false,
      deep_thinking: false,
      tutor_mode: true,
    });
  });

  it("reports an unavailable membership without inventing a free plan", async () => {
    mock.rpc.mockReturnValue({
      abortSignal: () =>
        Promise.resolve({ data: null, error: { code: "PGRST202", message: "private" } }),
    });
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "MEMBERSHIP_UNAVAILABLE" });
  });

  it("propagates authentication failures before reading membership", async () => {
    mock.requireUser.mockRejectedValue(new ApiError(401, "UNAUTHENTICATED", "请先登录。"));
    expect((await GET(request())).status).toBe(401);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
});
