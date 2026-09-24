import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";

const mock = vi.hoisted(() => ({
  embedTexts: vi.fn(),
  reserveEmbeddingUsage: vi.fn(),
}));
vi.mock("@/lib/ai/embeddings", () => ({
  EMBEDDING_DIMENSIONS: 1536,
  embedTexts: mock.embedTexts,
  reserveEmbeddingUsage: mock.reserveEmbeddingUsage,
}));

import { runEmbeddingTasks } from "./embedding-task-runner";
import type { EmbeddingConfig } from "@/lib/ai/embeddings";

const ownerId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const leaseToken = "33333333-3333-4333-8333-333333333333";
const config: EmbeddingConfig = {
  baseUrl: "https://embedding.example/v1",
  apiKey: "provider-key",
  model: "embedding-model",
  fingerprint: "a".repeat(64),
  dimensionsParam: false,
  batchSize: 10,
};
const vector = () => [1, ...Array<number>(1535).fill(0)];
const leaseUntil = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
const job = (seconds = 120) => ({
  jobId,
  ownerId,
  sourceId: "source-1",
  versionId: "version-1",
  contentDigest: "c".repeat(64),
  profile: "embedding-v1",
  dimensions: 1536,
  leaseToken,
  leaseUntil: leaseUntil(seconds),
  cursor: 0,
  totalChunks: 1,
  attempt: 1,
});
const row = (index: number) => ({
  chunkId: `chunk-${index}`,
  text: `正文 ${index}`,
  contentHash: createHash("sha256").update(`正文 ${index}`).digest("hex"),
  ordinal: index,
});

function input(overrides: Partial<{ maxJobs: number; maxMs: number; signal: AbortSignal }> = {}) {
  return {
    workerId: "node-embedding-worker",
    maxJobs: 1,
    maxMs: 50_000,
    ...overrides,
  };
}

function baseStore(batchRows = [row(0)]) {
  const store = { rpc: vi.fn() };
  store.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "claim_embedding_jobs") return { data: { jobs: [job()] }, error: null };
    if (name === "read_embedding_batch")
      return {
        data: { jobId, ownerId, cursor: 0, totalChunks: batchRows.length, chunks: batchRows },
        error: null,
      };
    if (name === "commit_embedding_batch")
      return {
        data: { cursor: batchRows.length, totalChunks: batchRows.length, state: "running" },
        error: null,
      };
    if (name === "finish_embedding_job") return { data: { state: "succeeded" }, error: null };
    if (name === "heartbeat_embedding_job")
      return { data: { leaseUntil: leaseUntil(120) }, error: null };
    if (name === "fail_embedding_job")
      return {
        data: {
          state: args.p_retryable ? "queued" : "failed",
          nextAttemptAt: leaseUntil(15),
        },
        error: null,
      };
    throw new Error(`unexpected rpc ${name}`);
  });
  return store;
}

describe("embedding task runner", () => {
  it("processes all chunks in bounded batches and publishes only after finish", async () => {
    const firstRows = Array.from({ length: 16 }, (_, index) => row(index));
    const secondRows = [row(16), row(17)];
    const store = { rpc: vi.fn() };
    let readCount = 0;
    store.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "claim_embedding_jobs")
        return { data: { jobs: [{ ...job(), totalChunks: 18 }] }, error: null };
      if (name === "read_embedding_batch") {
        const rows = readCount++ === 0 ? firstRows : secondRows;
        return {
          data: { jobId, ownerId, cursor: readCount === 1 ? 0 : 16, totalChunks: 18, chunks: rows },
          error: null,
        };
      }
      if (name === "commit_embedding_batch") {
        const cursor = Number(args.p_start) + (args.p_rows as unknown[]).length;
        return { data: { cursor, totalChunks: 18, state: "running" }, error: null };
      }
      if (name === "finish_embedding_job") return { data: { state: "succeeded" }, error: null };
      if (name === "heartbeat_embedding_job")
        return { data: { leaseUntil: leaseUntil(120) }, error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    mock.reserveEmbeddingUsage.mockResolvedValue(undefined);
    mock.embedTexts.mockImplementation(async (_config: EmbeddingConfig, current: string[]) =>
      current.map(() => vector()),
    );

    const result = await runEmbeddingTasks(store, config, input());
    expect(result.records).toEqual([{ jobId, state: "completed", code: "PUBLISHED" }]);
    expect(mock.embedTexts).toHaveBeenCalledTimes(3);
    expect(store.rpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_embedding_jobs",
      "read_embedding_batch",
      "heartbeat_embedding_job",
      "commit_embedding_batch",
      "read_embedding_batch",
      "heartbeat_embedding_job",
      "commit_embedding_batch",
      "finish_embedding_job",
    ]);
    expect(mock.reserveEmbeddingUsage).toHaveBeenCalledTimes(2);
  });

  it("renews a lease that is close to expiry before reading", async () => {
    const store = baseStore();
    store.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_embedding_jobs") return { data: { jobs: [job(10)] }, error: null };
      if (name === "read_embedding_batch")
        return {
          data: { jobId, ownerId, cursor: 0, totalChunks: 1, chunks: [row(0)] },
          error: null,
        };
      if (name === "heartbeat_embedding_job")
        return { data: { leaseUntil: leaseUntil(120) }, error: null };
      if (name === "commit_embedding_batch")
        return { data: { cursor: 1, totalChunks: 1, state: "running" }, error: null };
      if (name === "finish_embedding_job") return { data: { state: "succeeded" }, error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    mock.reserveEmbeddingUsage.mockResolvedValue(undefined);
    mock.embedTexts.mockResolvedValue([vector()]);
    await expect(runEmbeddingTasks(store, config, input())).resolves.toMatchObject({
      records: [{ state: "completed" }],
    });
    expect(store.rpc.mock.calls.map(([name]) => name)).toContain("heartbeat_embedding_job");
  });

  it("fails retryable provider errors and continues with the next job", async () => {
    const store = baseStore();
    let claims = 0;
    let currentJobId = jobId;
    store.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_embedding_jobs") {
        claims += 1;
        currentJobId = jobId.slice(0, -1) + claims;
        return {
          data: { jobs: claims <= 2 ? [{ ...job(), jobId: currentJobId }] : [] },
          error: null,
        };
      }
      if (name === "read_embedding_batch")
        return {
          data: { jobId: currentJobId, ownerId, cursor: 0, totalChunks: 1, chunks: [row(0)] },
          error: null,
        };
      if (name === "fail_embedding_job")
        return { data: { state: "queued", nextAttemptAt: leaseUntil(15) }, error: null };
      if (name === "commit_embedding_batch")
        return { data: { cursor: 1, totalChunks: 1, state: "running" }, error: null };
      if (name === "finish_embedding_job") return { data: { state: "succeeded" }, error: null };
      if (name === "heartbeat_embedding_job")
        return { data: { leaseUntil: leaseUntil(120) }, error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    mock.reserveEmbeddingUsage.mockResolvedValue(undefined);
    mock.embedTexts.mockRejectedValueOnce(
      new ApiError(503, "EMBEDDING_PROVIDER_RETRYABLE", "retry"),
    );
    mock.embedTexts.mockResolvedValue([vector()]);
    const result = await runEmbeddingTasks(store, config, input({ maxJobs: 2 }));
    expect(result.records).toEqual([
      { jobId: `${jobId.slice(0, -1)}1`, state: "failed", code: "EMBEDDING_PROVIDER_RETRYABLE" },
      { jobId: `${jobId.slice(0, -1)}2`, state: "completed", code: "PUBLISHED" },
    ]);
    expect(store.rpc.mock.calls.map(([name]) => name)).toContain("fail_embedding_job");
  });

  it("stops after a non-retryable provider error", async () => {
    const store = baseStore();
    mock.reserveEmbeddingUsage.mockResolvedValue(undefined);
    mock.embedTexts.mockRejectedValue(new ApiError(502, "EMBEDDING_PROVIDER_REJECTED", "rejected"));
    const result = await runEmbeddingTasks(store, config, input({ maxJobs: 2 }));
    expect(result.records[0]).toMatchObject({
      state: "failed",
      code: "EMBEDDING_PROVIDER_REJECTED",
    });
    expect(store.rpc.mock.calls.filter(([name]) => name === "claim_embedding_jobs")).toHaveLength(
      1,
    );
  });

  it("marks a commit conflict stale without calling fail", async () => {
    const store = baseStore();
    store.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_embedding_jobs") return { data: { jobs: [job()] }, error: null };
      if (name === "read_embedding_batch")
        return {
          data: { jobId, ownerId, cursor: 0, totalChunks: 1, chunks: [row(0)] },
          error: null,
        };
      if (name === "commit_embedding_batch")
        return { data: null, error: { code: "PT409", message: "stale" } };
      if (name === "heartbeat_embedding_job")
        return { data: { leaseUntil: leaseUntil(120) }, error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    mock.reserveEmbeddingUsage.mockResolvedValue(undefined);
    mock.embedTexts.mockResolvedValue([vector()]);
    const result = await runEmbeddingTasks(store, config, input());
    expect(result.records).toEqual([{ jobId, state: "stale", code: "LEASE_OR_CONTEXT_CHANGED" }]);
    expect(store.rpc.mock.calls.map(([name]) => name)).not.toContain("fail_embedding_job");
  });
});
