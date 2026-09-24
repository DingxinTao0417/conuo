import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  requireProcessorIdentity: vi.fn(),
  createAdminClient: vi.fn(),
  runSummaryTasks: vi.fn(),
}));
vi.mock("@/lib/supabase/processor-auth", () => ({
  requireProcessorIdentity: mock.requireProcessorIdentity,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mock.createAdminClient }));
vi.mock("@/lib/supabase/summary-task-runner", () => ({ runSummaryTasks: mock.runSummaryTasks }));
vi.mock("@/lib/ai/features", () => ({ aiFeatureEnabled: () => true }));

import { GET, POST } from "@/app/api/internal/summary-processor/route";

beforeEach(() => {
  vi.clearAllMocks();
  mock.createAdminClient.mockReturnValue({});
  mock.runSummaryTasks.mockResolvedValue({ records: [{ state: "idle", code: "NO_WORK" }] });
});

describe("summary processor route", () => {
  it("uses shared processor auth and one bounded job", async () => {
    const response = await GET(new Request("http://localhost/api/internal/summary-processor"));
    expect(response.status).toBe(200);
    expect(mock.requireProcessorIdentity).toHaveBeenCalled();
    expect(mock.runSummaryTasks).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ maxJobs: 1, maxMs: 50_000 }),
    );
  });

  it("rejects malformed manual input before running", async () => {
    const response = await POST(
      new Request("http://localhost/api/internal/summary-processor", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost" },
        body: JSON.stringify({ maxJobs: 4 }),
      }),
    );
    expect(response.status).toBe(400);
    expect(mock.runSummaryTasks).not.toHaveBeenCalled();
  });
});
