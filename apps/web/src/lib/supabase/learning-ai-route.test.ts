import { beforeEach, describe, expect, it, vi } from "vitest";

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
  readJson: vi.fn(async (request: Request) => JSON.parse(await request.text())),
  requireUser,
}));
vi.mock("@/lib/ai/features", () => ({ aiFeatureEnabled }));

import { POST as generate } from "@/app/api/v1/learning/generate/route";

describe("learning AI routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    aiFeatureEnabled.mockReturnValue(false);
    requireUser.mockResolvedValue({ supabase: { rpc: vi.fn() }, user: { id: "owner-a" } });
  });

  it("does not call the model or ledger while learning is disabled", async () => {
    const response = await generate(
      new Request("http://localhost/api/v1/learning/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "r1", source: { knowledgePageId: "note-1" }, count: 3 }),
      }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "LEARNING_DISABLED" });
  });
});
