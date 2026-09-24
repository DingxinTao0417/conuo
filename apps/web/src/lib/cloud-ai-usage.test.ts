import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAiRequestUsage, askCloud, organizeCloud } from "./cloud";
import { aiRequestUsageSchema, AI_USAGE_CHANGED_EVENT } from "./ai-request-usage";

vi.mock("./supabase/config", () => ({
  getSupabaseConfig: () => ({ url: "https://project.example.test", key: "test-key" }),
}));
const fetchMock = vi.fn();
const usage = {
  usedCount: 8,
  dailyLimit: 50,
  remainingCount: 42,
  windowStart: "2026-09-14T00:00:00.000Z",
  resetsAt: "2026-09-15T00:00:00.000Z",
  checkedAt: "2026-09-14T16:00:00.000Z",
  counting: "reserved_requests",
  includesFailedAndCancelled: true,
  tokens: { promptTokens: 120, completionTokens: 30, limit: 0 },
};
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("AI usage client and boundary contract", () => {
  it("uses the expected owner header and abort signal without browser caching", async () => {
    fetchMock.mockResolvedValue(Response.json(usage));
    const controller = new AbortController();
    const signal = controller.signal;
    expect(await getAiRequestUsage("owner-a", signal)).toEqual(usage);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/v1/ai/usage",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        credentials: "same-origin",
        cache: "no-store",
        headers: expect.objectContaining({ "X-Conuo-User": "owner-a" }),
      }),
    );
    const sentSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    controller.abort();
    expect(sentSignal.aborted).toBe(true);
  });

  it.each([
    { ...usage, usedCount: null },
    { ...usage, usedCount: -1 },
    { ...usage, usedCount: 2.5 },
    { ...usage, usedCount: 8, remainingCount: 50 },
    { ...usage, resetsAt: "2026-09-14T00:00:00.000Z" },
    { ...usage, checkedAt: "2026-09-15T00:00:00.000Z" },
    { ...usage, windowStart: "2026-09-14T08:00:00.000Z" },
    { ...usage, includesFailedAndCancelled: false },
    { ...usage, result: { private: "question contents" } },
  ])("rejects invalid aggregates rather than displaying misleading counters %#", async (body) => {
    fetchMock.mockResolvedValue(Response.json(body));
    await expect(getAiRequestUsage("owner-a")).rejects.toMatchObject({
      code: "INVALID_AI_USAGE_RESPONSE",
    });
  });

  it("keeps ledger/service failures as errors, never fabricates a zero response", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { code: "MODEL_LEDGER_NOT_CONFIGURED", error: "尚未配置请求记录服务。" },
        { status: 503 },
      ),
    );
    await expect(getAiRequestUsage("owner-a")).rejects.toMatchObject({
      status: 503,
      code: "MODEL_LEDGER_NOT_CONFIGURED",
    });
  });

  it("accepts a real used count above a lowered daily limit", () => {
    expect(
      aiRequestUsageSchema.safeParse({ ...usage, usedCount: 64, dailyLimit: 10, remainingCount: 0 })
        .success,
    ).toBe(true);
  });

  it("refreshes usage after settled generation attempts but never after a usage read", async () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const changed = vi.fn();
    target.addEventListener(AI_USAGE_CHANGED_EVENT, changed);
    fetchMock.mockResolvedValue(Response.json(usage));
    await getAiRequestUsage("owner-a");
    expect(changed).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(
      Response.json({ content: "学习回答", citations: [], mode: "model" }),
    );
    await askCloud(
      {
        scope: "document",
        spaceId: "space-a",
        sourceId: "source-a",
        sourceIds: [],
        question: "为什么？",
      },
      undefined,
      "owner-a",
    );
    expect(changed).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValue(
      Response.json({ error: "请求已失败", code: "MODEL_FAILED" }, { status: 502 }),
    );
    await expect(
      organizeCloud(
        {
          requestId: "job-a",
          kind: "source",
          trigger: "manual",
          spaceId: "space-a",
          sourceIds: ["source-a"],
          sourceVersions: [{ sourceId: "source-a", versionId: "v-a" }],
        },
        undefined,
        "owner-a",
      ),
    ).rejects.toMatchObject({ code: "MODEL_FAILED" });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(changed.mock.calls)).not.toContain("owner-a");
    expect(JSON.stringify(changed.mock.calls)).not.toContain("为什么");
  });
});
