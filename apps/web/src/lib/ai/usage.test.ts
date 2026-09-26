import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAiRequestUsage } from "./usage";

const ownerId = "68a62235-a0b4-4f89-922e-27a603c00cd2";
const fetchMock = vi.fn();
const store = createClient("https://usage.example.test", "test-server-key", {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-14T23:59:00.000Z"));
  vi.stubEnv("CONUO_AI_DAILY_REQUEST_LIMIT", "");
  vi.stubEnv("CONUO_AI_DAILY_TOKEN_LIMIT", "");
  fetchMock.mockReset();
  fetchMock
    .mockResolvedValueOnce(new Response(null, { headers: { "Content-Range": "0-4/5" } }))
    .mockResolvedValue(new Response(JSON.stringify({ promptTokens: 120, completionTokens: 30 })));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("AI reservation usage through the actual PostgREST client", () => {
  it("reads only an owner-scoped exact HEAD count for the UTC day, without selecting result content or state", async () => {
    const usage = await readAiRequestUsage(store, ownerId, new AbortController().signal);
    expect(usage).toEqual({
      usedCount: 5,
      dailyLimit: 50,
      remainingCount: 45,
      windowStart: "2026-09-14T00:00:00.000Z",
      resetsAt: "2026-09-15T00:00:00.000Z",
      checkedAt: "2026-09-14T23:59:00.000Z",
      counting: "reserved_requests",
      includesFailedAndCancelled: true,
      tokens: { promptTokens: 120, completionTokens: 30, limit: 0 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [address, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(address);
    expect(url.pathname).toBe("/rest/v1/ai_requests");
    expect(url.searchParams.get("select")).toBe("request_id");
    expect(url.searchParams.get("owner_id")).toBe(`eq.${ownerId}`);
    expect(url.searchParams.getAll("created_at")).toEqual([
      "gte.2026-09-14T00:00:00.000Z",
      "lt.2026-09-15T00:00:00.000Z",
    ]);
    expect(url.searchParams.has("state")).toBe(false);
    expect(init.method).toBe("HEAD");
    expect(new Headers(init.headers).get("Prefer")).toContain("count=exact");
    const tokenAddress = fetchMock.mock.calls[1][0] as string;
    expect(new URL(tokenAddress).pathname).toBe("/rest/v1/rpc/ai_token_usage_today");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ p_owner: ownerId });
    expect(JSON.stringify(usage)).not.toContain(ownerId);
  });

  it("resets to the next UTC window, independently of the local timezone", async () => {
    vi.setSystemTime(new Date("2026-09-15T00:00:00.000Z"));
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(new Response(null, { headers: { "Content-Range": "*/0" } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ promptTokens: 0, completionTokens: 0 })),
      );
    expect(await readAiRequestUsage(store, ownerId, new AbortController().signal)).toMatchObject({
      usedCount: 0,
      remainingCount: 50,
      windowStart: "2026-09-15T00:00:00.000Z",
      resetsAt: "2026-09-16T00:00:00.000Z",
    });
  });

  it("reads plan limits from the membership RPC when enforcement is on", async () => {
    vi.stubEnv("CONUO_MEMBERSHIP_ENFORCEMENT", "on");
    vi.stubEnv("CONUO_AI_DAILY_REQUEST_LIMIT", "500");
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            usedCount: 7,
            dailyLimit: 100,
            membership: {
              planCode: "pro",
              planName: "专业版",
              source: "promotion",
              endsAt: "2026-10-01T00:00:00+00:00",
              afterEnd: "free",
              grantId: "00000000-0000-4000-8000-000000000000",
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ promptTokens: 0, completionTokens: 0 })),
      );
    const usage = await readAiRequestUsage(store, ownerId, new AbortController().signal);
    expect(usage).toMatchObject({
      usedCount: 7,
      dailyLimit: 100,
      remainingCount: 93,
      membership: {
        planCode: "pro",
        planName: "专业版",
        source: "promotion",
        endsAt: "2026-10-01T00:00:00.000Z",
        afterEnd: "free",
        enforced: true,
      },
    });
    expect(JSON.stringify(usage)).not.toContain("grantId");
    const [address, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(address).pathname).toBe("/rest/v1/rpc/ai_membership_usage");
    expect(JSON.parse(String(init.body))).toEqual({
      p_owner: ownerId,
      p_global_cap: 500,
      p_enforcement: "on",
    });
  });

  it("keeps the real used count when the configured limit was lowered", async () => {
    vi.stubEnv("CONUO_AI_DAILY_REQUEST_LIMIT", "3");
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(new Response(null, { headers: { "Content-Range": "0-4/5" } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ promptTokens: 2, completionTokens: 1 })),
      );
    expect(await readAiRequestUsage(store, ownerId, new AbortController().signal)).toMatchObject({
      usedCount: 5,
      dailyLimit: 3,
      remainingCount: 0,
    });
  });

  it.each([undefined, "0-4/NaN", "0-4/-1", "0-4/9007199254740992"])(
    "does not turn a missing or malformed count into a zero balance: %s",
    async (range) => {
      fetchMock
        .mockReset()
        .mockResolvedValueOnce(
          new Response(null, { headers: range ? { "Content-Range": range } : {} }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ promptTokens: 0, completionTokens: 0 })),
        );
      await expect(
        readAiRequestUsage(store, ownerId, new AbortController().signal),
      ).rejects.toMatchObject({ status: 503, code: "AI_USAGE_UNAVAILABLE" });
    },
  );

  it("sanitizes database and network failures", async () => {
    fetchMock.mockRejectedValue(new Error("private SQL and server key"));
    const error = await readAiRequestUsage(store, ownerId, new AbortController().signal).catch(
      (cause: unknown) => cause,
    );
    expect(error).toMatchObject({ code: "AI_USAGE_UNAVAILABLE" });
    expect(String(error)).not.toContain("private SQL");
  });

  it("reads the configured daily token limit and rejects malformed token usage", async () => {
    vi.stubEnv("CONUO_AI_DAILY_TOKEN_LIMIT", "1000");
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(new Response(null, { headers: { "Content-Range": "0-0/1" } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ promptTokens: 1, completionTokens: 2 })),
      );
    await expect(
      readAiRequestUsage(store, ownerId, new AbortController().signal),
    ).resolves.toMatchObject({
      tokens: { promptTokens: 1, completionTokens: 2, limit: 1000 },
    });
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(new Response(null, { headers: { "Content-Range": "0-0/1" } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ promptTokens: -1, completionTokens: 2 })),
      );
    await expect(
      readAiRequestUsage(store, ownerId, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "AI_USAGE_UNAVAILABLE",
    });
  });

  it("rejects invalid limits before attempting the database", async () => {
    vi.stubEnv("CONUO_AI_DAILY_REQUEST_LIMIT", "2.5");
    await expect(
      readAiRequestUsage(store, ownerId, new AbortController().signal),
    ).rejects.toMatchObject({ code: "INVALID_AI_LIMIT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not read when already cancelled and suppresses a late count after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readAiRequestUsage(store, ownerId, controller.signal)).rejects.toMatchObject({
      status: 499,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const late = new AbortController();
    fetchMock.mockImplementation(async () => {
      late.abort();
      return new Response(null, { headers: { "Content-Range": "0-4/5" } });
    });
    await expect(readAiRequestUsage(store, ownerId, late.signal)).rejects.toMatchObject({
      status: 499,
    });
  });
});
