import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  readEmbeddingConfig: vi.fn(),
  runEmbeddingTasks: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mock.createAdminClient }));
vi.mock("@/lib/ai/embeddings", () => ({ readEmbeddingConfig: mock.readEmbeddingConfig }));
vi.mock("@/lib/supabase/embedding-task-runner", () => ({
  runEmbeddingTasks: mock.runEmbeddingTasks,
}));

import { GET, POST } from "@/app/api/internal/embedding-processor/route";

const secret = "processor-secret-for-route-tests-123456789012345";
const config = { fingerprint: "a".repeat(64) };
const request = (body?: unknown, signal?: AbortSignal) =>
  new Request("http://localhost/api/internal/embedding-processor", {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });

beforeEach(() => {
  vi.stubEnv("CONUO_PROCESSOR_SECRET", secret);
  mock.createAdminClient.mockReturnValue({ rpc: vi.fn() });
  mock.readEmbeddingConfig.mockReturnValue(config);
  mock.runEmbeddingTasks.mockResolvedValue({ records: [{ state: "idle", code: "NO_WORK" }] });
});
afterEach(() => vi.unstubAllEnvs());

describe("embedding processor route", () => {
  it("uses the bounded GET defaults", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(mock.runEmbeddingTasks).toHaveBeenCalledWith(
      mock.createAdminClient.mock.results[0].value,
      config,
      {
        workerId: "vercel-embedding-processor",
        maxJobs: 2,
        maxMs: 50_000,
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("validates a strict bounded POST and shares processor identity", async () => {
    const response = await POST(
      request({ workerId: "operator-worker", maxJobs: 3, maxSeconds: 30 }),
    );
    expect(response.status).toBe(200);
    expect(mock.runEmbeddingTasks).toHaveBeenCalledWith(expect.anything(), config, {
      workerId: "operator-worker",
      maxJobs: 3,
      maxMs: 30_000,
      signal: expect.any(AbortSignal),
    });
  });

  it("rejects invalid identity, body and missing embedding configuration before the runner", async () => {
    const invalidIdentity = new Request("http://localhost/api/internal/embedding-processor", {
      method: "POST",
      headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" },
      body: "{}",
    });
    expect((await POST(invalidIdentity)).status).toBe(401);
    expect(mock.runEmbeddingTasks).not.toHaveBeenCalled();

    const invalidBody = await POST(request({ workerId: "bad/worker" }));
    expect(invalidBody.status).toBe(400);
    expect(mock.runEmbeddingTasks).not.toHaveBeenCalled();

    mock.readEmbeddingConfig.mockReturnValue(null);
    const notConfigured = await GET(request());
    expect(notConfigured.status).toBe(503);
    expect(mock.runEmbeddingTasks).not.toHaveBeenCalled();
  });
});
