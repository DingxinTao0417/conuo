import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ callModel: vi.fn(), readModelProfile: vi.fn() }));
vi.mock("@/lib/ai/model", () => ({
  callModel: mock.callModel,
  readModelProfile: mock.readModelProfile,
}));

import { runSummaryTasks } from "./summary-task-runner";

const jobId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const leaseToken = "33333333-3333-4333-8333-333333333333";
const leaseUntil = () => new Date(Date.now() + 120_000).toISOString();
const config = {
  baseUrl: "https://model.example",
  apiKey: "key",
  model: "model",
  jsonMode: true,
  tokenLimitParameter: "max_tokens" as const,
  timeoutMs: 10_000,
};

function store(overrides: Partial<Record<string, unknown>> = {}) {
  const rpc = vi.fn(async (name: string) => {
    if (name === "claim_summary_jobs")
      return {
        data: {
          jobs: [
            {
              jobId,
              ownerId,
              sourceId: "source-a",
              versionId: "v1",
              profile: "summary-v1",
              leaseToken,
              leaseUntil: leaseUntil(),
              sectionsDone: 0,
              sectionsTotal: 1,
              attempt: 1,
            },
          ],
        },
        error: null,
      };
    if (name === "read_summary_job_context")
      return {
        data: {
          jobId,
          ownerId,
          sourceId: "source-a",
          versionId: "v1",
          leaseToken,
          leaseUntil: leaseUntil(),
          sectionsDone: 0,
          sectionsTotal: 1,
          chunks: [{ id: "c1", text: "原文", page: 1, ordinal: 0, section: "第一章" }],
          outline: null,
          summaries: [],
        },
        error: null,
      };
    if (name === "heartbeat_summary_job")
      return { data: { leaseUntil: leaseUntil() }, error: null };
    if (name === "reserve_summary_section")
      return { data: { allowed: overrides.quota !== false }, error: null };
    if (name === "stage_summary_section")
      return { data: { staged: true, sectionsDone: 1 }, error: null };
    if (name === "finish_summary_job") return { data: { state: "succeeded" }, error: null };
    return { data: { state: "failed" }, error: null };
  });
  return { rpc };
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.readModelProfile.mockReturnValue({ profile: "default", config });
  mock.callModel
    .mockResolvedValueOnce(
      '{"title":"第一章","paragraphs":[{"text":"结论","evidenceIds":["e1"]},{"text":"条件","evidenceIds":["e1"]}]}',
    )
    .mockResolvedValueOnce(
      '{"paragraphs":[{"text":"一","evidenceIds":["e1"]},{"text":"二","evidenceIds":["e1"]},{"text":"三","evidenceIds":["e1"]}]}',
    );
});

describe("summary task runner", () => {
  it("stages sections and then finishes a document summary", async () => {
    const result = await runSummaryTasks(store(), {
      workerId: "summary-worker",
      maxJobs: 1,
      maxMs: 60_000,
      dailyLimit: 60,
    });
    expect(result.records).toEqual([{ jobId, state: "completed", code: "PUBLISHED" }]);
    expect(mock.callModel).toHaveBeenCalledTimes(2);
  });

  it("defers on quota exhaustion without failing the job", async () => {
    const result = await runSummaryTasks(store({ quota: false }), {
      workerId: "summary-worker",
      maxJobs: 1,
      maxMs: 60_000,
      dailyLimit: 1,
    });
    expect(result.records).toEqual([{ jobId, state: "deferred", code: "SUMMARY_DAILY_LIMIT" }]);
  });
});
