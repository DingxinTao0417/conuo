import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getItems } from "@/app/api/v1/learning/items/route";
import { GET as getOverview } from "@/app/api/v1/learning/overview/route";

const requireUser = vi.hoisted(() => vi.fn());
const aiFeatureEnabled = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/api", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
  failure: (error: unknown) =>
    Response.json(
      { code: (error as { code?: string }).code ?? "CLOUD_ERROR" },
      { status: (error as { status?: number }).status ?? 500 },
    ),
  json: (data: unknown, status = 200) => Response.json(data, { status }),
  readJson: vi.fn(),
  requireUser,
}));
vi.mock("@/lib/ai/features", () => ({ aiFeatureEnabled }));

describe("learning routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireUser.mockResolvedValue({ supabase: { rpc: vi.fn() } });
  });

  it("returns LEARNING_DISABLED before touching the RPC when the switch is off", async () => {
    aiFeatureEnabled.mockReturnValue(false);
    const response = await getItems(new Request("http://localhost/api/v1/learning/items"));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "LEARNING_DISABLED" });
    expect(requireUser).toHaveBeenCalledTimes(1);
  });

  it("reads the learning overview through the owner-scoped RPC", async () => {
    aiFeatureEnabled.mockReturnValue(true);
    const rpc = vi.fn().mockResolvedValue({
      data: { dueCount: 2, newCount: 1, reviewsLast7d: 4, weakConcepts: [] },
      error: null,
    });
    requireUser.mockResolvedValue({ supabase: { rpc } });

    const response = await getOverview(
      new Request("http://localhost/api/v1/learning/overview?spaceId=space-1"),
    );

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("learning_overview", { p_space_id: "space-1" });
    expect(await response.json()).toMatchObject({ dueCount: 2, newCount: 1 });
  });
});
