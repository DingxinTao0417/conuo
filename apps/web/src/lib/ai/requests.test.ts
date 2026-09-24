import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnswerResult } from "@/lib/types";

const mock = vi.hoisted(() => ({
  createClient: vi.fn(),
  getSupabaseConfig: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient: mock.createClient }));
vi.mock("@/lib/supabase/config", () => ({ getSupabaseConfig: mock.getSupabaseConfig }));

import { ApiError } from "@/lib/supabase/api";
import { createRequestStore, finishRequest, reserveRequest } from "./requests";

const ownerId = "86d5eaa8-3ab9-4d1b-bd73-210f353e8052";
const requestId = "current-request";
const fingerprint = "a".repeat(64);
const answer: AnswerResult = { content: "已核对资料的回答。", citations: [], mode: "model" };
const client = { rpc: mock.rpc } as unknown as ReturnType<typeof createRequestStore>;

beforeEach(() => {
  Object.values(mock).forEach((fn) => fn.mockReset());
  vi.stubEnv("SUPABASE_SECRET_KEY", "");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
  vi.stubEnv("CONUO_AI_DAILY_REQUEST_LIMIT", "");
  vi.stubEnv("CONUO_AI_DAILY_TOKEN_LIMIT", "");
  mock.getSupabaseConfig.mockReturnValue({
    url: "https://project.example.test",
    key: "publishable-test-key",
  });
  mock.createClient.mockReturnValue(client);
  mock.rpc.mockResolvedValue({ data: { status: "reserved" }, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("model request store configuration", () => {
  it("requires a server key and never substitutes the browser publishable key", () => {
    expect(() => createRequestStore()).toThrowError(ApiError);
    try {
      createRequestStore();
    } catch (error) {
      expect(error).toMatchObject({ status: 503, code: "MODEL_LEDGER_NOT_CONFIGURED" });
      expect(String(error)).not.toContain("publishable-test-key");
    }
    expect(mock.createClient).not.toHaveBeenCalled();
  });

  it("requires the Supabase project configuration as well", () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", "secret-test-key");
    mock.getSupabaseConfig.mockReturnValue(null);
    expect(() => createRequestStore()).toThrowError(ApiError);
    expect(mock.createClient).not.toHaveBeenCalled();
  });

  it("creates a server client with no persisted or automatically refreshed session", () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", " secret-test-key ");
    expect(createRequestStore()).toBe(client);
    expect(mock.createClient).toHaveBeenCalledExactlyOnceWith(
      "https://project.example.test",
      "secret-test-key",
      {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      },
    );
  });

  it("supports the legacy service role key when the new secret key is absent", () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", " legacy-service-role ");
    createRequestStore();
    expect(mock.createClient.mock.calls[0][1]).toBe("legacy-service-role");
  });

  it("prefers the new secret key when both are present", () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", "current-secret");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "legacy-secret");
    createRequestStore();
    expect(mock.createClient.mock.calls[0][1]).toBe("current-secret");
  });
});

describe("model request reservations", () => {
  it("reserves through the atomic RPC with owner, request identity, fingerprint, and default quota", async () => {
    expect(await reserveRequest(client, ownerId, requestId, fingerprint)).toEqual({
      kind: "reserved",
    });
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("reserve_ai_request", {
      p_owner: ownerId,
      p_request_id: requestId,
      p_fingerprint: fingerprint,
      p_daily_limit: 50,
      p_daily_token_limit: 0,
    });
  });

  it.each(["1", "100", "500"])("passes a configured daily limit of %s", async (value) => {
    vi.stubEnv("CONUO_AI_DAILY_REQUEST_LIMIT", value);
    await reserveRequest(client, ownerId, requestId, fingerprint);
    expect(mock.rpc.mock.calls[0][1].p_daily_limit).toBe(Number(value));
  });

  it.each(["1", "100000000"])("passes a configured daily token limit of %s", async (value) => {
    vi.stubEnv("CONUO_AI_DAILY_TOKEN_LIMIT", value);
    await reserveRequest(client, ownerId, requestId, fingerprint);
    expect(mock.rpc.mock.calls[0][1].p_daily_token_limit).toBe(Number(value));
  });

  it.each(["-1", "100000001", "2.5", "NaN", "Infinity", "not a number", " "])(
    "rejects invalid token quota %s before reserving or invoking the database",
    async (value) => {
      vi.stubEnv("CONUO_AI_DAILY_TOKEN_LIMIT", value);
      await expect(reserveRequest(client, ownerId, requestId, fingerprint)).rejects.toMatchObject({
        status: 503,
        code: "INVALID_AI_LIMIT",
      });
      expect(mock.rpc).not.toHaveBeenCalled();
    },
  );

  it.each(["0", "501", "-1", "2.5", "NaN", "Infinity", "not a number", " "])(
    "rejects invalid quota %s before reserving or invoking the database",
    async (value) => {
      vi.stubEnv("CONUO_AI_DAILY_REQUEST_LIMIT", value);
      await expect(reserveRequest(client, ownerId, requestId, fingerprint)).rejects.toMatchObject({
        status: 503,
        code: "INVALID_AI_LIMIT",
      });
      expect(mock.rpc).not.toHaveBeenCalled();
    },
  );

  it("returns a completed result as cached without reserving a new invocation", async () => {
    mock.rpc.mockResolvedValue({ data: { status: "completed", result: answer }, error: null });
    expect(await reserveRequest(client, ownerId, requestId, fingerprint)).toEqual({
      kind: "cached",
      result: answer,
    });
    expect(mock.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([{ status: "completed", result: null }, { status: "completed" }])(
    "never turns an expired or missing completed result into permission to call the model again %#",
    async (data) => {
      mock.rpc.mockResolvedValue({ data, error: null });
      const result = await reserveRequest(client, ownerId, requestId, fingerprint);
      expect(result.kind).toBe("cached");
      expect(result).toHaveProperty("result", "result" in data ? data.result : undefined);
      expect(mock.rpc).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["failed", 409, "REQUEST_FINISHED"],
    ["running", 409, "REQUEST_RUNNING"],
    ["busy", 409, "REQUEST_RUNNING"],
    ["mismatch", 409, "REQUEST_CHANGED"],
    ["limited", 429, "AI_DAILY_LIMIT"],
    ["token_limited", 429, "AI_DAILY_TOKEN_LIMIT"],
  ])(
    "rejects %s without turning it into a new reservation",
    async (reservationStatus, status, code) => {
      mock.rpc.mockResolvedValue({
        data: { status: reservationStatus, errorCode: "private-upstream-error" },
        error: null,
      });
      const error = await reserveRequest(client, ownerId, requestId, fingerprint).catch(
        (error: unknown) => error,
      );
      expect(error).toMatchObject({ status, code });
      expect(String(error)).not.toContain("private-upstream-error");
      expect(mock.rpc).toHaveBeenCalledTimes(1);
    },
  );

  it("sanitizes an RPC error and does not retry the reservation", async () => {
    mock.rpc.mockResolvedValue({
      data: null,
      error: { message: "private SQL and secret", code: "42883" },
    });
    const error = await reserveRequest(client, ownerId, requestId, fingerprint).catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({ status: 503, code: "MODEL_LEDGER_UNAVAILABLE" });
    expect(String(error)).not.toContain("private SQL");
    expect(mock.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    undefined,
    {},
    [],
    { status: "unknown" },
    { status: "reserved", errorCode: { sql: "private" } },
  ])("rejects malformed RPC payload %# before granting a reservation", async (data) => {
    mock.rpc.mockResolvedValue({ data, error: null });
    await expect(reserveRequest(client, ownerId, requestId, fingerprint)).rejects.toMatchObject({
      status: 503,
      code: "MODEL_LEDGER_UNAVAILABLE",
    });
    expect(mock.rpc).toHaveBeenCalledTimes(1);
  });
});

describe("finalizing model request records", () => {
  it("stores a completed answer only against the matching owner's running request", async () => {
    mock.rpc.mockResolvedValue({ data: { requestId }, error: null });
    await finishRequest(client, ownerId, requestId, answer);
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("finish_ai_request", {
      p_owner: ownerId,
      p_request_id: requestId,
      p_result: answer,
      p_error_code: null,
    });
  });

  it("stores failure without content through the same fenced database operation", async () => {
    mock.rpc.mockResolvedValue({ data: { requestId }, error: null });
    await finishRequest(client, ownerId, requestId, undefined, "MODEL_TIMEOUT");
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("finish_ai_request", {
      p_owner: ownerId,
      p_request_id: requestId,
      p_result: null,
      p_error_code: "MODEL_TIMEOUT",
    });
  });

  it("records an unspecified failure with no fabricated error code", async () => {
    mock.rpc.mockResolvedValue({ data: { requestId }, error: null });
    await finishRequest(client, ownerId, requestId);
    expect(mock.rpc).toHaveBeenCalledWith("finish_ai_request", {
      p_owner: ownerId,
      p_request_id: requestId,
      p_result: null,
      p_error_code: null,
    });
  });

  it.each([
    { data: null, error: null },
    { data: undefined, error: null },
    { data: null, error: { message: "private database details", code: "XX000" } },
    {
      data: { requestId: 123 },
      error: { message: "private database details", code: "XX000" },
    },
  ])("does not report completion unless the database confirms a saved row %#", async (result) => {
    mock.rpc.mockResolvedValue(result);
    const error = await finishRequest(client, ownerId, requestId, answer).catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({ status: 503, code: "MODEL_RESULT_NOT_SAVED" });
    expect(String(error)).not.toContain("private database");
    expect(mock.rpc).toHaveBeenCalledTimes(1);
  });
});
