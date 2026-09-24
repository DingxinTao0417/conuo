import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  assertOrganizationScope,
  bindOrganizationResult,
  buildOrganizationGrounding,
  organizationMessages,
  validateOrganizationResult,
  ORGANIZATION_MODEL_CONTRACT_VERSION,
  type SummaryRows,
} from "@/lib/ai/organization";
import { callModel, readModelProfile, type ModelProfileName } from "@/lib/ai/model";
import { selectFastProfile } from "@/lib/ai/model-routing";
import { aiFeatureEnabled } from "@/lib/ai/features";
import type { SummaryRow } from "@/lib/ai/grounding";
import { createRequestStore, finishRequest, reserveRequest } from "@/lib/ai/requests";
import { createTraceRecorder } from "@/lib/ai/traces";
import { organizationRequestSchema, organizationResultSchema } from "@/lib/organization-schema";
import { ApiError } from "@/lib/supabase/api";
import { workspaceSchema } from "@/lib/supabase/validation";

type RpcFailure = { code?: string; message?: string } | null;
type RpcResponse = { data: unknown; error: RpcFailure };
export interface OrganizationTaskStore {
  // Supabase returns a PostgREST builder that is awaitable, rather than a native
  // Promise. Keeping this to PromiseLike lets the worker accept both the real
  // service client and small deterministic test stores.
  rpc(name: string, args: Record<string, unknown>): PromiseLike<RpcResponse>;
}

type SummaryQueryResponse = { data: unknown; error: RpcFailure };
type SummaryQuery = {
  select(columns: string): SummaryQuery;
  eq(column: string, value: string): SummaryQuery;
  then<TResult1 = SummaryQueryResponse, TResult2 = never>(
    onfulfilled?: ((value: SummaryQueryResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2>;
};

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const workerId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const claimSchema = z
  .object({
    jobs: z.array(
      z
        .object({
          jobId: id,
          ownerId: z.uuid(),
          leaseToken: z.uuid(),
          leaseUntil: z.string().datetime({ offset: true }),
          hasResult: z.boolean(),
          attempt: z.number().int().min(0).max(5),
        })
        .strict(),
    ),
  })
  .strict();
const contextSchema = z
  .object({
    jobId: id,
    ownerId: z.uuid(),
    leaseToken: z.uuid(),
    leaseUntil: z.string().datetime({ offset: true }),
    request: organizationRequestSchema,
    workspace: workspaceSchema,
    contextDigest: z.string().regex(/^[a-f0-9]{64}$/),
    result: organizationResultSchema.nullable(),
  })
  .strict();
const heartbeatSchema = z.object({ leaseUntil: z.string().datetime({ offset: true }) }).strict();
const stageSchema = z
  .object({ staged: z.literal(true), resultDigest: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
const publishSchema = z
  .object({
    state: z.enum(["succeeded", "cancelled", "pending_capacity"]),
    revision: z.number().int().positive().optional(),
  })
  .strict();
const failureSchema = z
  .object({
    state: z.enum(["queued", "failed", "cancelled"]),
    revision: z.number().int().positive().nullable().optional(),
  })
  .strict();
const summaryRowSchema = z
  .object({
    level: z.enum(["section", "document"]),
    section_index: z.number().int().min(0).max(1000),
    title: z.string().min(1).max(200),
    page_start: z.number().int().positive().nullable(),
    page_end: z.number().int().positive().nullable(),
    chunk_ids: z.array(z.string()).min(1).max(400),
    summary: z
      .object({
        paragraphs: z
          .array(z.object({ text: z.string(), chunkIds: z.array(z.string()).min(1).max(6) }))
          .max(8),
      })
      .passthrough(),
    model_name: z.string().nullable(),
    created_at: z.string(),
  })
  .strict();

export type OrganizationTaskRunnerInput = {
  workerId: string;
  limit: number;
  leaseSeconds: number;
  signal?: AbortSignal;
};
export type OrganizationTaskRunnerSummary = {
  claimed: number;
  published: number;
  staged: number;
  retrying: number;
  failed: number;
  cancelled: number;
  capacityPending: number;
};

function stateError(error: RpcFailure, message: string): ApiError {
  if (error?.code === "22023") return new ApiError(400, "ORGANIZATION_STATE_INVALID", message);
  if (error?.code === "40001" || error?.code === "PT409")
    return new ApiError(409, "ORGANIZATION_STATE_CHANGED", message);
  if (error?.code === "42501")
    return new ApiError(503, "ORGANIZATION_PROCESSOR_FORBIDDEN", "后台整理权限尚未配置。");
  return new ApiError(503, "ORGANIZATION_PROCESSOR_UNAVAILABLE", message);
}

async function rpc<T>(
  store: OrganizationTaskStore,
  name: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
  message: string,
): Promise<T> {
  const response = await store.rpc(name, args);
  if (response.error) throw stateError(response.error, message);
  const parsed = schema.safeParse(response.data);
  if (!parsed.success)
    throw new ApiError(503, "ORGANIZATION_PROCESSOR_INVALID", "后台整理任务返回格式无效。");
  return parsed.data;
}

function retryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  // A direct question can temporarily own this account's shared AI ledger.
  // The durable task has not called the provider in that case, so retry after
  // the SQL backoff rather than recording a terminal failure.
  return error.code === "REQUEST_RUNNING" || [429, 502, 503, 504].includes(error.status);
}

function stableErrorCode(error: unknown): string {
  if (error instanceof ApiError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)) return error.code;
  return "ORGANIZATION_PROCESSING_FAILED";
}

async function readOrganizationSummaries(
  store: OrganizationTaskStore,
  ownerId: string,
  workspace: z.infer<typeof workspaceSchema>,
  request: z.infer<typeof organizationRequestSchema>,
): Promise<Map<string, SummaryRows>> {
  const result = new Map<string, SummaryRows>();
  if (!aiFeatureEnabled("SECTION_SUMMARIES")) return result;
  const from = (store as unknown as { from?: (relation: string) => SummaryQuery }).from;
  if (!from) return result;
  for (const source of workspace.sources.filter((item) => request.sourceIds.includes(item.id))) {
    try {
      const response = await from("source_version_summaries")
        .select(
          "level,section_index,title,page_start,page_end,chunk_ids,summary,model_name,created_at",
        )
        .eq("owner_id", ownerId)
        .eq("source_id", source.id)
        .eq("version_id", source.versionId)
        .eq("profile", "summary-v1");
      if (response.error || !Array.isArray(response.data)) continue;
      const rows = response.data.flatMap((value: unknown) => {
        const parsed = summaryRowSchema.safeParse(value);
        if (!parsed.success) return [];
        const row = parsed.data;
        return [
          {
            level: row.level,
            sectionIndex: row.section_index,
            title: row.title,
            pageStart: row.page_start,
            pageEnd: row.page_end,
            chunkIds: row.chunk_ids,
            summary: row.summary,
            modelName: row.model_name,
            createdAt: row.created_at,
          } as SummaryRow,
        ];
      });
      if (rows.length) result.set(source.id, rows);
    } catch {
      // A missing optional summary read leaves the original organization path intact.
    }
  }
  return result;
}

async function heartbeat(
  store: OrganizationTaskStore,
  ownerId: string,
  jobId: string,
  leaseToken: string,
  leaseSeconds: number,
) {
  return rpc(
    store,
    "heartbeat_organization_job",
    {
      p_owner: ownerId,
      p_job_id: jobId,
      p_lease_token: leaseToken,
      p_lease_seconds: leaseSeconds,
    },
    heartbeatSchema,
    "后台整理状态已改变，请稍后刷新。",
  );
}

type ClaimedJob = z.infer<typeof claimSchema>["jobs"][number];

async function processClaim(
  store: OrganizationTaskStore,
  job: ClaimedJob,
  input: OrganizationTaskRunnerInput,
  summary: OrganizationTaskRunnerSummary,
) {
  let staged = false;
  let traceRecorder: ReturnType<typeof createTraceRecorder> | undefined;
  let traceOutcome:
    "completed" | "insufficient" | "failed" | "cancelled" | "cached" | "extractive" = "failed";
  let traceErrorCode: string | undefined;
  let traceModelName: string | undefined;
  let traceModelProfile: ModelProfileName | undefined;
  try {
    const context = await rpc(
      store,
      "read_organization_job_context",
      { p_owner: job.ownerId, p_job_id: job.jobId, p_lease_token: job.leaseToken },
      contextSchema,
      "后台整理状态已改变，请稍后刷新。",
    );
    if (
      context.ownerId !== job.ownerId ||
      context.jobId !== job.jobId ||
      context.leaseToken !== job.leaseToken ||
      (context.request.kind !== "source" && context.request.kind !== "knowledge")
    )
      throw new ApiError(503, "ORGANIZATION_PROCESSOR_INVALID", "后台整理任务内容无效。");

    traceRecorder = createTraceRecorder("organization-job", job.ownerId, context.request.requestId);

    if (context.result) {
      const published = await rpc(
        store,
        "publish_organization_job",
        { p_owner: job.ownerId, p_job_id: job.jobId, p_lease_token: job.leaseToken },
        publishSchema,
        "后台整理发布状态已改变，请稍后刷新。",
      );
      if (published.state === "succeeded") summary.published += 1;
      else if (published.state === "cancelled") summary.cancelled += 1;
      else summary.capacityPending += 1;
      traceOutcome = "cached";
      void traceRecorder.finish(traceOutcome);
      return;
    }

    if (input.signal?.aborted) {
      traceOutcome = "cancelled";
      void traceRecorder.finish(traceOutcome);
      return;
    }
    await heartbeat(store, job.ownerId, job.jobId, job.leaseToken, input.leaseSeconds);
    if (input.signal?.aborted) {
      traceOutcome = "cancelled";
      void traceRecorder.finish(traceOutcome);
      return;
    }

    // All evidence is rebuilt from the worker-read current snapshot. The caller
    // never supplies source text, pages, quotations or target note bodies.
    assertOrganizationScope(context.workspace, context.request);
    const requestedProfile = process.env.CONUO_ORGANIZATION_MODEL_PROFILE?.trim() || "default";
    if (requestedProfile !== "default" && requestedProfile !== "fast")
      throw new ApiError(503, "MODEL_CONFIGURATION", "模型服务配置不完整或无效，请联系管理员。");
    const selectedProfile =
      requestedProfile === "fast" ? selectFastProfile() : readModelProfile("default");
    const config = selectedProfile?.config;
    if (!selectedProfile || !config)
      throw new ApiError(503, "MODEL_NOT_CONFIGURED", "尚未配置生成模型，暂不能生成整理建议。");
    const summaries = await readOrganizationSummaries(
      store,
      job.ownerId,
      context.workspace,
      context.request,
    );
    const summaryVersionRows = [...summaries.entries()].flatMap(([sourceId, rows]) =>
      rows.map((row) => [sourceId, row.level, row.sectionIndex, row.createdAt ?? ""]),
    );
    const summaryVersion = summaryVersionRows.length
      ? JSON.stringify(
          summaryVersionRows.sort((left, right) => left.join("/").localeCompare(right.join("/"))),
        )
      : null;
    const grounding = buildOrganizationGrounding(context.workspace, context.request, {
      summaries,
      maxRequestBytes: config.maxRequestBytes,
    });
    const fingerprintParts: unknown[] = [
      "organization-worker-v1",
      ORGANIZATION_MODEL_CONTRACT_VERSION,
      config.baseUrl,
      config.model,
      config.jsonMode,
      config.thinkingMode ?? null,
      selectedProfile.profile,
      context.contextDigest,
    ];
    if (summaryVersion) fingerprintParts.push(summaryVersion);
    const fingerprint = createHash("sha256").update(JSON.stringify(fingerprintParts)).digest("hex");
    const ledger = createRequestStore();
    const reserved = await reserveRequest(
      ledger,
      job.ownerId,
      context.request.requestId,
      fingerprint,
    );
    // Reserve may wait behind a shared request. Re-check the lease and source
    // scope before a provider call so an old worker never discloses evidence.
    await heartbeat(store, job.ownerId, job.jobId, job.leaseToken, input.leaseSeconds);
    if (input.signal?.aborted) return;
    let result;
    if (reserved.kind === "cached") {
      traceOutcome = "cached";
      result = validateOrganizationResult(reserved.result, grounding, context.request);
    } else {
      traceRecorder.mark("modelStart");
      result = bindOrganizationResult(
        await callModel(config, organizationMessages(grounding, context.request), input.signal, {
          onUsage: (usage) => traceRecorder?.addUsage(usage),
        }),
        grounding,
        context.request,
      );
      traceRecorder.mark("modelEnd");
      traceOutcome = "completed";
    }
    traceModelName = config.model;
    traceModelProfile = selectedProfile.profile;
    const stagedResult = await rpc(
      store,
      "stage_organization_job_result",
      {
        p_owner: job.ownerId,
        p_job_id: job.jobId,
        p_lease_token: job.leaseToken,
        p_result: result,
      },
      stageSchema,
      "后台整理状态已改变，请稍后刷新。",
    );
    if (!stagedResult.staged)
      throw new ApiError(503, "ORGANIZATION_PROCESSOR_INVALID", "整理结果未能暂存。");
    staged = true;
    summary.staged += 1;
    // The durable task has the result now. If the short-lived model ledger is
    // unavailable, leave it staged for a later publish instead of discarding a
    // completed answer or retrying the provider call.
    if (reserved.kind === "reserved") {
      try {
        await finishRequest(ledger, job.ownerId, context.request.requestId, result);
      } catch {
        return;
      }
    }
    const published = await rpc(
      store,
      "publish_organization_job",
      { p_owner: job.ownerId, p_job_id: job.jobId, p_lease_token: job.leaseToken },
      publishSchema,
      "后台整理发布状态已改变，请稍后刷新。",
    );
    if (published.state === "succeeded") summary.published += 1;
    else if (published.state === "cancelled") summary.cancelled += 1;
    else summary.capacityPending += 1;
    void traceRecorder.finish(traceOutcome, {
      modelProfile: traceModelProfile ?? "default",
      modelName: traceModelName,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      traceErrorCode = error.code;
      if (error.code === "REQUEST_CANCELLED" || error.code === "MODEL_CANCELLED")
        traceOutcome = "cancelled";
    }
    void traceRecorder?.finish(traceOutcome, {
      errorCode: traceErrorCode,
      modelProfile: traceModelProfile ?? "default",
      modelName: traceModelName,
    });
    if (input.signal?.aborted || staged) return;
    try {
      const failed = await rpc(
        store,
        "fail_organization_job",
        {
          p_owner: job.ownerId,
          p_job_id: job.jobId,
          p_lease_token: job.leaseToken,
          p_error_code: stableErrorCode(error),
          p_retryable: retryable(error),
        },
        failureSchema,
        "后台整理状态已改变，请稍后刷新。",
      );
      if (failed.state === "queued") summary.retrying += 1;
      else if (failed.state === "cancelled") summary.cancelled += 1;
      else summary.failed += 1;
    } catch {
      // The lease will expire and the SQL outbox will safely re-evaluate it.
      summary.failed += 1;
    }
  }
}

export async function runOrganizationTasks(
  store: OrganizationTaskStore,
  input: OrganizationTaskRunnerInput,
): Promise<OrganizationTaskRunnerSummary> {
  if (!workerId.safeParse(input.workerId).success)
    throw new ApiError(400, "INVALID_ORGANIZATION_PROCESSOR", "后台整理处理器标识无效。");
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 5)
    throw new ApiError(400, "INVALID_ORGANIZATION_PROCESSOR", "后台整理批量大小无效。");
  if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 30 || input.leaseSeconds > 300)
    throw new ApiError(400, "INVALID_ORGANIZATION_PROCESSOR", "后台整理租约无效。");
  const summary: OrganizationTaskRunnerSummary = {
    claimed: 0,
    published: 0,
    staged: 0,
    retrying: 0,
    failed: 0,
    cancelled: 0,
    capacityPending: 0,
  };
  if (input.signal?.aborted) return summary;
  const claim = await rpc(
    store,
    "claim_organization_jobs",
    {
      p_worker_id: input.workerId,
      p_limit: input.limit,
      p_lease_seconds: input.leaseSeconds,
    },
    claimSchema,
    "后台整理队列暂不可用。",
  );
  summary.claimed = claim.jobs.length;
  for (const job of claim.jobs) {
    if (input.signal?.aborted) break;
    await processClaim(store, job, input, summary);
  }
  return summary;
}
