import { createHash } from "node:crypto";
import { z } from "zod";
import {
  EMBEDDING_DIMENSIONS,
  embedTexts,
  reserveEmbeddingUsage,
  type EmbeddingConfig,
} from "@/lib/ai/embeddings";
import { ApiError } from "./api";
import type { OrganizationTaskStore } from "./organization-task-runner";

export interface EmbeddingTaskRunnerInput {
  workerId: string;
  maxJobs: number;
  maxMs: number;
  signal?: AbortSignal;
}

export interface EmbeddingTaskRecord {
  jobId?: string;
  state: "completed" | "failed" | "deferred" | "stale" | "cancelled" | "idle";
  code: string;
}

type RpcFailure = { code?: string; message?: string } | null;
class RpcError extends Error {
  constructor(public rpcCode?: string) {
    super("embedding RPC failed");
  }
}
class StaleError extends Error {}
class BudgetError extends Error {}
class CancelledError extends Error {}

const claimSchema = z.object({
  jobs: z.array(
    z.object({
      jobId: z.string(),
      ownerId: z.string(),
      sourceId: z.string(),
      versionId: z.string(),
      contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
      profile: z.literal("embedding-v1"),
      dimensions: z.literal(EMBEDDING_DIMENSIONS),
      leaseToken: z.string(),
      leaseUntil: z.string(),
      cursor: z.number().int().nonnegative(),
      totalChunks: z.number().int().nonnegative(),
      attempt: z.number().int().positive(),
    }),
  ),
});
const batchSchema = z.object({
  jobId: z.string(),
  ownerId: z.string(),
  cursor: z.number().int().nonnegative(),
  totalChunks: z.number().int().nonnegative(),
  chunks: z.array(
    z.object({
      chunkId: z.string(),
      text: z.string().min(1),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      ordinal: z.number().int().nonnegative(),
    }),
  ),
});
const heartbeatSchema = z.object({ leaseUntil: z.string() });
const commitSchema = z.object({
  cursor: z.number().int().nonnegative(),
  totalChunks: z.number().int().nonnegative(),
  state: z.string(),
});
const finishSchema = z.object({ state: z.string() });
const failSchema = z.object({ state: z.string(), nextAttemptAt: z.string() });

function errorCode(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined;
}

function isStateConflict(error: unknown): boolean {
  return error instanceof RpcError && ["40001", "PT409", "P0002"].includes(error.rpcCode || "");
}

async function rpc(store: OrganizationTaskStore, name: string, args: Record<string, unknown>) {
  let result: { data: unknown; error: RpcFailure };
  try {
    result = await store.rpc(name, args);
  } catch (error) {
    throw new RpcError(error instanceof Error ? error.message : undefined);
  }
  if (result.error) throw new RpcError(result.error.code);
  return result.data;
}

function validateInput(input: EmbeddingTaskRunnerInput) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input.workerId))
    throw new ApiError(400, "INVALID_EMBEDDING_PROCESSOR", "后台向量处理请求格式无效。");
  if (!Number.isInteger(input.maxJobs) || input.maxJobs < 1 || input.maxJobs > 5)
    throw new ApiError(400, "INVALID_EMBEDDING_PROCESSOR", "后台向量处理请求格式无效。");
  if (!Number.isInteger(input.maxMs) || input.maxMs < 10_000 || input.maxMs > 240_000)
    throw new ApiError(400, "INVALID_EMBEDDING_PROCESSOR", "后台向量处理请求格式无效。");
}

function remaining(deadline: number, signal?: AbortSignal): number {
  if (signal?.aborted) throw new CancelledError();
  const value = deadline - Date.now();
  if (value < 8_000) throw new BudgetError();
  return value;
}

async function renewIfNeeded(
  store: OrganizationTaskStore,
  job: z.infer<typeof claimSchema>["jobs"][number],
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new CancelledError();
  const until = Date.parse(job.leaseUntil);
  if (!Number.isFinite(until) || until <= Date.now()) throw new StaleError();
  if (until - Date.now() >= 35_000) return;
  await heartbeat(store, job);
}

async function heartbeat(
  store: OrganizationTaskStore,
  job: z.infer<typeof claimSchema>["jobs"][number],
) {
  const data = heartbeatSchema.parse(
    await rpc(store, "heartbeat_embedding_job", {
      p_job_id: job.jobId,
      p_lease_token: job.leaseToken,
      p_lease_seconds: 120,
    }),
  );
  job.leaseUntil = data.leaseUntil;
  if (Date.parse(job.leaseUntil) <= Date.now()) throw new StaleError();
}

async function failJob(
  store: OrganizationTaskStore,
  job: z.infer<typeof claimSchema>["jobs"][number],
  code: string,
  retryable: boolean,
) {
  const result = failSchema.parse(
    await rpc(store, "fail_embedding_job", {
      p_job_id: job.jobId,
      p_lease_token: job.leaseToken,
      p_error_code: code,
      p_retryable: retryable,
    }),
  );
  if (
    retryable ? result.state !== "queued" && result.state !== "failed" : result.state !== "failed"
  )
    throw new StaleError();
}

async function processJob(
  store: OrganizationTaskStore,
  config: EmbeddingConfig,
  job: z.infer<typeof claimSchema>["jobs"][number],
  deadline: number,
  signal?: AbortSignal,
): Promise<EmbeddingTaskRecord> {
  try {
    while (job.cursor < job.totalChunks) {
      remaining(deadline, signal);
      await renewIfNeeded(store, job, signal);
      const batch = batchSchema.parse(
        await rpc(store, "read_embedding_batch", {
          p_job_id: job.jobId,
          p_lease_token: job.leaseToken,
          p_limit: 16,
        }),
      );
      if (batch.jobId !== job.jobId || batch.ownerId !== job.ownerId || batch.cursor !== job.cursor)
        throw new StaleError();
      if (batch.totalChunks !== job.totalChunks || !batch.chunks.length) throw new StaleError();
      for (const chunk of batch.chunks) {
        const digest = createHash("sha256").update(chunk.text).digest("hex");
        if (digest !== chunk.contentHash) throw new StaleError();
      }
      await reserveEmbeddingUsage(
        job.ownerId,
        batch.chunks.reduce((sum, chunk) => sum + Array.from(chunk.text).length, 0),
        store as never,
      );
      await heartbeat(store, job);
      const rows: Array<{ chunkId: string; contentHash: string; embedding: number[] }> = [];
      for (let offset = 0; offset < batch.chunks.length; offset += config.batchSize) {
        remaining(deadline, signal);
        const chunks = batch.chunks.slice(offset, offset + config.batchSize);
        const vectors = await embedTexts(
          config,
          chunks.map((chunk) => chunk.text),
          signal,
        );
        if (vectors.length !== chunks.length)
          throw new ApiError(502, "EMBEDDING_PROVIDER_REJECTED", "语义检索服务返回的数据无效。");
        rows.push(
          ...chunks.map((chunk, index) => ({
            chunkId: chunk.chunkId,
            contentHash: chunk.contentHash,
            embedding: vectors[index],
          })),
        );
      }
      await renewIfNeeded(store, job, signal);
      const committed = commitSchema.parse(
        await rpc(store, "commit_embedding_batch", {
          p_job_id: job.jobId,
          p_lease_token: job.leaseToken,
          p_start: job.cursor,
          p_rows: rows,
        }),
      );
      if (
        committed.cursor !== job.cursor + rows.length ||
        committed.totalChunks !== job.totalChunks ||
        committed.state !== "running"
      )
        throw new StaleError();
      job.cursor = committed.cursor;
    }
    await renewIfNeeded(store, job, signal);
    const finished = finishSchema.parse(
      await rpc(store, "finish_embedding_job", {
        p_job_id: job.jobId,
        p_lease_token: job.leaseToken,
      }),
    );
    if (finished.state !== "succeeded") throw new StaleError();
    return { jobId: job.jobId, state: "completed", code: "PUBLISHED" };
  } catch (error) {
    if (error instanceof CancelledError)
      return { jobId: job.jobId, state: "cancelled", code: "CANCELLED" };
    if (error instanceof BudgetError)
      return { jobId: job.jobId, state: "deferred", code: "BUDGET_EXPIRED" };
    if (error instanceof StaleError || isStateConflict(error))
      return { jobId: job.jobId, state: "stale", code: "LEASE_OR_CONTEXT_CHANGED" };
    const code = errorCode(error);
    if (code === "EMBEDDING_PROVIDER_RETRYABLE") {
      await failJob(store, job, code, true);
      return { jobId: job.jobId, state: "failed", code };
    }
    if (code === "EMBEDDING_PROVIDER_REJECTED" || code === "EMBEDDING_INPUT_INVALID") {
      await failJob(store, job, code, false);
      return { jobId: job.jobId, state: "failed", code };
    }
    if (code === "EMBEDDING_CANCELLED")
      return { jobId: job.jobId, state: "cancelled", code: "CANCELLED" };
    return { jobId: job.jobId, state: "deferred", code: "WORKER_INTERNAL" };
  }
}

export async function runEmbeddingTasks(
  store: OrganizationTaskStore,
  config: EmbeddingConfig,
  input: EmbeddingTaskRunnerInput,
): Promise<{ records: EmbeddingTaskRecord[] }> {
  validateInput(input);
  const deadline = Date.now() + input.maxMs;
  const records: EmbeddingTaskRecord[] = [];
  const seenJobIds = new Set<string>();
  for (let count = 0; count < input.maxJobs; count += 1) {
    try {
      remaining(deadline, input.signal);
      const claimed = claimSchema.parse(
        await rpc(store, "claim_embedding_jobs", {
          p_worker_id: input.workerId,
          p_limit: 1,
          p_lease_seconds: 120,
          p_profile_fingerprint: config.fingerprint,
        }),
      );
      if (!claimed.jobs.length) {
        records.push({ state: "idle", code: "NO_WORK" });
        break;
      }
      if (seenJobIds.has(claimed.jobs[0].jobId)) {
        records.push({ jobId: claimed.jobs[0].jobId, state: "deferred", code: "DUPLICATE_CLAIM" });
        break;
      }
      seenJobIds.add(claimed.jobs[0].jobId);
      const record = await processJob(store, config, claimed.jobs[0], deadline, input.signal);
      records.push(record);
      if (record.state !== "failed" || record.code !== "EMBEDDING_PROVIDER_RETRYABLE") break;
    } catch (error) {
      if (error instanceof CancelledError) records.push({ state: "cancelled", code: "CANCELLED" });
      else if (error instanceof BudgetError)
        records.push({ state: "deferred", code: "BUDGET_REMAINING_LOW" });
      else if (isStateConflict(error))
        records.push({ state: "stale", code: "LEASE_OR_CONTEXT_CHANGED" });
      else records.push({ state: "deferred", code: "WORKER_INTERNAL" });
      break;
    }
  }
  return { records };
}
