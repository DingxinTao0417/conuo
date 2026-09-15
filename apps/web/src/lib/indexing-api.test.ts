import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  rpc: vi.fn(),
  store: vi.fn(),
  config: vi.fn(),
  reserve: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("./supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("./ai/requests", () => ({ createRequestStore: mock.store }));
vi.mock("./ai/embeddings", () => ({
  readEmbeddingConfig: mock.config,
  reserveEmbeddingUsage: mock.reserve,
}));

import { POST } from "@/app/api/internal/indexing/route";
import { ApiError } from "./supabase/api";

const secret = "processor-private-credential-123456789";
const fingerprint = "a".repeat(64);
const jobId = "11111111-1111-4111-8111-111111111111";
const leaseToken = "22222222-2222-4222-8222-222222222222";
const ownerId = "33333333-3333-4333-8333-333333333333";
const lease = { profileFingerprint: fingerprint, jobId, leaseToken };
const store = { rpc: mock.rpc };
const row = () => ({
  chunkId: "chunk-1",
  contentHash: "b".repeat(64),
  embedding: [1, ...Array<number>(1535).fill(0)],
});
const batch = () => ({
  ownerId,
  jobId,
  cursor: 0,
  totalChunks: 1,
  chunks: [{ chunkId: "chunk-1", text: "保密正文😀", contentHash: "b".repeat(64), ordinal: 0 }],
});
function request(
  input: unknown,
  options: { headers?: HeadersInit; signal?: AbortSignal; body?: string } = {},
) {
  const headers = new Headers({
    "Content-Type": "application/json",
    Authorization: `Bearer ${secret}`,
  });
  new Headers(options.headers).forEach((value, key) => headers.set(key, value));
  return new Request("http://localhost:3000/api/internal/indexing", {
    method: "POST",
    headers,
    body: options.body ?? JSON.stringify(input),
    signal: options.signal,
  });
}
const claim = () => ({ action: "claim", workerId: "worker-one", profileFingerprint: fingerprint });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONUO_PROCESSOR_SECRET", secret);
  vi.stubGlobal("fetch", mock.fetch);
  mock.config.mockReturnValue({ fingerprint });
  mock.store.mockReturnValue(store);
  mock.reserve.mockResolvedValue(undefined);
  mock.rpc.mockImplementation(async (name) => ({
    data: name === "read_embedding_batch" ? batch() : { state: "running" },
    error: null,
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("internal indexing identity and strict request boundary", () => {
  it.each(["", "short", "a".repeat(4097), "secret with spaces in the middle 12345"])(
    "rejects missing or unsafe processor configuration before reading jobs",
    async (value) => {
      vi.stubEnv("CONUO_PROCESSOR_SECRET", value);
      const res = await POST(request(claim()));
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("PROCESSOR_NOT_CONFIGURED");
      expect(mock.store).not.toHaveBeenCalled();
    },
  );

  it.each(["", "Bearer wrong", `bearer ${secret}`, `Bearer ${secret}x`, "x".repeat(8193)])(
    "requires exact processor identity before parsing body",
    async (authorization) => {
      const res = await POST(
        request(null, { headers: { Authorization: authorization }, body: "{" }),
      );
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain(secret);
      expect(mock.config).not.toHaveBeenCalled();
      expect(mock.rpc).not.toHaveBeenCalled();
    },
  );

  it("rejects a different embedding profile before opening the service-role store", async () => {
    const res = await POST(request({ ...claim(), profileFingerprint: "b".repeat(64) }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("EMBEDDING_PROFILE_CHANGED");
    expect(mock.store).not.toHaveBeenCalled();
  });

  it("requires a configured embedding profile", async () => {
    mock.config.mockReturnValue(null);
    const res = await POST(request(claim()));
    expect(res.status).toBe(503);
    expect(mock.store).not.toHaveBeenCalled();
  });

  it.each([
    { ...claim(), ownerId },
    { ...claim(), limit: 0 },
    { ...claim(), limit: 6 },
    { ...claim(), leaseSeconds: 301 },
    { ...claim(), workerId: "bad/worker" },
    { action: "read", ...lease, limit: 17 },
    { action: "read", ...lease, leaseToken: "not-a-uuid" },
    { action: "commit", ...lease, start: -1, rows: [row()] },
    { action: "commit", ...lease, start: 0, rows: [{ ...row(), embedding: [1] }] },
    { action: "commit", ...lease, start: 0, rows: [{ ...row(), ownerId }] },
    { action: "fail", ...lease, errorCode: "private-provider-message", retryable: true },
    { action: "fail", ...lease, errorCode: "E".repeat(65), retryable: true },
  ])("does not forward invalid or caller-injected SQL parameters", async (input) => {
    const res = await POST(request(input));
    expect(res.status).toBe(400);
    expect(mock.store).not.toHaveBeenCalled();
  });

  it.each([
    [{ "Content-Type": "application/x-www-form-urlencoded" }, "{}", 415],
    [{ Origin: "https://other.example" }, "{}", 403],
    [{ "Sec-Fetch-Site": "cross-site" }, "{}", 403],
    [{ "Content-Length": "1500001" }, "{}", 413],
    [{}, "{", 400],
  ] as const)("rejects unsafe body transport before RPC", async (headers, body, status) => {
    const res = await POST(request(null, { headers, body }));
    expect(res.status).toBe(status);
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it("rejects cancellation before requesting a lease", async () => {
    const controller = new AbortController();
    controller.abort();
    const res = await POST(request(claim(), { signal: controller.signal }));
    expect(res.status).toBe(499);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
});

describe("indexing read disclosure gate (mock SQL transport only)", () => {
  it("reserves code-point usage and rechecks the lease before disclosing text", async () => {
    const order: string[] = [];
    mock.rpc.mockImplementation(async (name) => {
      order.push(name);
      return { data: name === "read_embedding_batch" ? batch() : {}, error: null };
    });
    mock.reserve.mockImplementation(async () => {
      order.push("budget");
    });
    const res = await POST(request({ action: "read", ...lease, limit: 1 }));
    expect(res.status).toBe(200);
    expect(order).toEqual(["read_embedding_batch", "budget", "heartbeat_embedding_job"]);
    expect(mock.rpc).toHaveBeenNthCalledWith(1, "read_embedding_batch", {
      p_job_id: jobId,
      p_lease_token: leaseToken,
      p_limit: 1,
    });
    expect(mock.reserve).toHaveBeenCalledWith(ownerId, 5, store);
    expect(mock.rpc).toHaveBeenNthCalledWith(2, "heartbeat_embedding_job", {
      p_job_id: jobId,
      p_lease_token: leaseToken,
      p_lease_seconds: 120,
    });
    expect(await res.json()).toEqual(batch());
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it("never returns text when quota reservation fails", async () => {
    mock.reserve.mockRejectedValue(new ApiError(429, "EMBEDDING_DAILY_LIMIT", "额度已满"));
    const res = await POST(request({ action: "read", ...lease }));
    expect(res.status).toBe(429);
    expect(await res.text()).not.toContain("保密正文");
    expect(mock.rpc.mock.calls.map((call) => call[0])).toEqual(["read_embedding_batch"]);
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it("does not disclose a batch whose lease/source permission was revoked while reserving budget", async () => {
    mock.rpc.mockImplementation(async (name) =>
      name === "read_embedding_batch"
        ? { data: batch(), error: null }
        : { data: null, error: { code: "40001", message: "private revoked source SQL" } },
    );
    const res = await POST(request({ action: "read", ...lease }));
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).not.toContain("保密正文");
    expect(body).not.toContain("private revoked");
    expect(mock.reserve).toHaveBeenCalledOnce();
  });

  it.each(["budget", "heartbeat"])(
    "does not disclose after cancellation during %s",
    async (stage) => {
      const controller = new AbortController();
      if (stage === "budget") mock.reserve.mockImplementation(async () => controller.abort());
      else
        mock.rpc.mockImplementation(async (name) => {
          if (name === "heartbeat_embedding_job") controller.abort();
          return { data: name === "read_embedding_batch" ? batch() : {}, error: null };
        });
      const res = await POST(request({ action: "read", ...lease }, { signal: controller.signal }));
      expect(res.status).toBe(499);
      expect(await res.text()).not.toContain("保密正文");
    },
  );

  it.each([
    { ...batch(), jobId: ownerId },
    { ...batch(), ownerId: "wrong-owner" },
    { ...batch(), chunks: [{ ...batch().chunks[0], contentHash: "invalid" }] },
    { ...batch(), chunks: [{ ...batch().chunks[0], text: "" }] },
  ])("refuses malformed or unrelated SQL batch before budget/disclosure", async (value) => {
    mock.rpc.mockResolvedValue({ data: value, error: null });
    const res = await POST(request({ action: "read", ...lease }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("INVALID_INDEXING_BATCH");
    expect(mock.reserve).not.toHaveBeenCalled();
    expect(mock.rpc).toHaveBeenCalledOnce();
  });

  it("checks the lease even for an empty completed batch, without reserving zero characters", async () => {
    mock.rpc.mockImplementation(async (name) => ({
      data: name === "read_embedding_batch" ? { ...batch(), cursor: 1, chunks: [] } : {},
      error: null,
    }));
    const res = await POST(request({ action: "read", ...lease }));
    expect(res.status).toBe(200);
    expect(mock.reserve).not.toHaveBeenCalled();
    expect(mock.rpc.mock.calls.map((call) => call[0])).toEqual([
      "read_embedding_batch",
      "heartbeat_embedding_job",
    ]);
  });

  it("refuses a UTF-8 oversized batch without returning its source text", async () => {
    mock.rpc.mockResolvedValue({
      data: {
        ...batch(),
        totalChunks: 4,
        chunks: Array.from({ length: 4 }, (_, i) => ({
          ...batch().chunks[0],
          chunkId: `chunk-${i}`,
          text: "密".repeat(90000),
        })),
      },
      error: null,
    });
    const res = await POST(request({ action: "read", ...lease }));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("INDEXING_BATCH_TOO_LARGE");
    expect(mock.rpc).toHaveBeenCalledOnce();
  });
});

describe("indexing mutation RPC contract", () => {
  it.each([
    [
      claim(),
      "claim_embedding_jobs",
      {
        p_worker_id: "worker-one",
        p_profile_fingerprint: fingerprint,
        p_limit: 1,
        p_lease_seconds: 120,
      },
    ],
    [
      { action: "finish", ...lease },
      "finish_embedding_job",
      { p_job_id: jobId, p_lease_token: leaseToken },
    ],
    [
      { action: "heartbeat", ...lease, leaseSeconds: 60 },
      "heartbeat_embedding_job",
      { p_job_id: jobId, p_lease_token: leaseToken, p_lease_seconds: 60 },
    ],
    [
      { action: "fail", ...lease, errorCode: "PROVIDER_TIMEOUT", retryable: true },
      "fail_embedding_job",
      {
        p_job_id: jobId,
        p_lease_token: leaseToken,
        p_error_code: "PROVIDER_TIMEOUT",
        p_retryable: true,
      },
    ],
  ])("forwards only SQL-owned identity/lease fields", async (input, name, args) => {
    const res = await POST(request(input));
    expect(res.status).toBe(200);
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith(name, args);
    expect(mock.reserve).not.toHaveBeenCalled();
  });

  it("binds a commit to cursor, chunk ID, content hash, and exact vector", async () => {
    const rows = [row()];
    const res = await POST(request({ action: "commit", ...lease, start: 3, rows }));
    expect(res.status).toBe(200);
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("commit_embedding_batch", {
      p_job_id: jobId,
      p_lease_token: leaseToken,
      p_start: 3,
      p_rows: rows,
    });
  });

  it("redacts unexpected database failures", async () => {
    mock.rpc.mockRejectedValue(new Error("private-service-role-key: SQL source body"));
    const res = await POST(request(claim()));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("CLOUD_ERROR");
  });
});
