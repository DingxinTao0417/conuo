import { z } from "zod";
import {
  bindDocumentSummaryOutput,
  bindSummaryOutput,
  buildSummarySections,
  documentSummaryPrompt,
  parseDocumentSummaryOutput,
  parseSummaryOutput,
  sectionSummaryPrompt,
  type BoundSummaryOutput,
} from "@/lib/ai/source-summary";
import { callModel } from "@/lib/ai/model";
import { readModelProfile } from "@/lib/ai/model";
import type { Chunk } from "@/lib/types";
import type { OutlineItem } from "@/lib/source-outline";
import { ApiError } from "./api";
import type { OrganizationTaskStore } from "./organization-task-runner";

export interface SummaryTaskRunnerInput {
  workerId: string;
  maxJobs: number;
  maxMs: number;
  dailyLimit?: number;
  signal?: AbortSignal;
}

export interface SummaryTaskRecord {
  jobId?: string;
  state: "completed" | "failed" | "deferred" | "stale" | "cancelled" | "idle";
  code: string;
}

type RpcFailure = { code?: string; message?: string } | null;
class RpcError extends Error {
  constructor(public rpcCode?: string) {
    super("summary RPC failed");
  }
}
class StaleError extends Error {}
class BudgetError extends Error {}
class QuotaError extends Error {}
class CancelledError extends Error {}

const claimSchema = z
  .object({
    jobs: z.array(
      z
        .object({
          jobId: z.string(),
          ownerId: z.string(),
          sourceId: z.string(),
          versionId: z.string(),
          profile: z.literal("summary-v1"),
          leaseToken: z.string(),
          leaseUntil: z.string(),
          sectionsDone: z.number().int().min(0).max(60),
          sectionsTotal: z.number().int().min(1).max(60).nullable(),
          attempt: z.number().int().min(1).max(5),
        })
        .strict(),
    ),
  })
  .strict();
const contextSchema = z
  .object({
    jobId: z.string(),
    ownerId: z.string(),
    sourceId: z.string(),
    versionId: z.string(),
    leaseToken: z.string(),
    leaseUntil: z.string(),
    sectionsDone: z.number().int().min(0).max(60),
    sectionsTotal: z.number().int().min(1).max(60).nullable(),
    chunks: z.array(
      z.object({
        id: z.string(),
        text: z.string().min(1),
        page: z.number().int().positive().nullable().optional(),
        ordinal: z.number().int().nonnegative(),
        section: z.string(),
      }),
    ),
    outline: z
      .object({
        items: z.array(
          z.object({
            title: z.string(),
            level: z.number().int(),
            page: z.number().int().positive().optional(),
          }),
        ),
      })
      .nullable(),
    summaries: z.array(
      z.object({
        level: z.enum(["section", "document"]),
        sectionIndex: z.number().int(),
        title: z.string(),
        pageStart: z.number().int().positive().nullable().optional(),
        pageEnd: z.number().int().positive().nullable().optional(),
        summary: z.record(z.string(), z.unknown()),
        chunkIds: z.array(z.string()),
        modelName: z.string().nullable().optional(),
      }),
    ),
  })
  .strict();
const boolSchema = z.object({ allowed: z.boolean() }).passthrough();
const heartbeatSchema = z.object({ leaseUntil: z.string() });
const stageSchema = z.object({ staged: z.literal(true), sectionsDone: z.number().int() });
const finishSchema = z.object({ state: z.literal("succeeded") });
const failureSchema = z.object({ state: z.enum(["queued", "failed", "cancelled"]) });

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
function validateInput(input: SummaryTaskRunnerInput) {
  if (
    !/^[a-zA-Z0-9_-]{1,80}$/.test(input.workerId) ||
    !Number.isInteger(input.maxJobs) ||
    input.maxJobs < 1 ||
    input.maxJobs > 2 ||
    !Number.isInteger(input.maxMs) ||
    input.maxMs < 10_000 ||
    input.maxMs > 240_000
  )
    throw new ApiError(400, "INVALID_SUMMARY_PROCESSOR", "后台摘要处理请求格式无效。");
}
function remaining(deadline: number, signal?: AbortSignal) {
  if (signal?.aborted) throw new CancelledError();
  const value = deadline - Date.now();
  if (value < 20_000) throw new BudgetError();
  return value;
}
async function heartbeat(
  store: OrganizationTaskStore,
  job: z.infer<typeof claimSchema>["jobs"][number],
) {
  const result = heartbeatSchema.parse(
    await rpc(store, "heartbeat_summary_job", {
      p_job_id: job.jobId,
      p_lease_token: job.leaseToken,
      p_lease_seconds: 120,
    }),
  );
  job.leaseUntil = result.leaseUntil;
  if (Date.parse(job.leaseUntil) <= Date.now()) throw new StaleError();
}
function modelMessages(section: { title: string; chunks: Chunk[] }) {
  const evidence = section.chunks.map((chunk, index) => ({
    id: `e${index + 1}`,
    text: chunk.text,
    page: chunk.page,
  }));
  return [
    { role: "system" as const, content: sectionSummaryPrompt },
    {
      role: "user" as const,
      content: JSON.stringify({ title: section.title, passages: evidence }),
    },
  ];
}
function reduceEvidence(
  sections: Array<{ id: string; title: string; summary: BoundSummaryOutput; chunks: Chunk[] }>,
) {
  const evidenceCounts = new Map<string, number>();
  for (const section of sections)
    for (const paragraph of section.summary.paragraphs)
      for (const id of paragraph.chunkIds)
        evidenceCounts.set(id, (evidenceCounts.get(id) ?? 0) + 1);
  return sections.flatMap((section) =>
    [...section.chunks]
      .sort((a, b) => (evidenceCounts.get(b.id) ?? 0) - (evidenceCounts.get(a.id) ?? 0))
      .slice(0, 2),
  );
}
function reduceMessages(
  sections: Array<{ id: string; title: string; summary: BoundSummaryOutput; chunks: Chunk[] }>,
) {
  const passages = reduceEvidence(sections).map((chunk, index) => ({
    id: `e${index + 1}`,
    text: chunk.text,
    section:
      sections.find((section) => section.chunks.some((item) => item.id === chunk.id))?.title ?? "",
  }));
  return [
    { role: "system" as const, content: documentSummaryPrompt },
    {
      role: "user" as const,
      content: JSON.stringify({
        sectionSummaries: sections.map((section) => ({
          id: section.id,
          title: section.title,
          text: section.summary.paragraphs.map((p) => p.text).join("\n"),
        })),
        passages,
      }),
    },
  ];
}
function mapEvidenceIds<T extends { evidenceIds: string[] }>(output: T, chunks: Chunk[]): T {
  return {
    ...output,
    evidenceIds: output.evidenceIds.map((id) => {
      const index = Number(id.slice(1)) - 1;
      return /^e\d+$/.test(id) && chunks[index] ? chunks[index]!.id : id;
    }),
  };
}

async function failJob(
  store: OrganizationTaskStore,
  job: z.infer<typeof claimSchema>["jobs"][number],
  code: string,
  retryable: boolean,
) {
  const failed = failureSchema.parse(
    await rpc(store, "fail_summary_job", {
      p_job_id: job.jobId,
      p_lease_token: job.leaseToken,
      p_error_code: code,
      p_retryable: retryable,
    }),
  );
  if (retryable ? !["queued", "failed"].includes(failed.state) : failed.state !== "failed")
    throw new StaleError();
}

async function processJob(
  store: OrganizationTaskStore,
  config: NonNullable<ReturnType<typeof readModelProfile>>["config"],
  job: z.infer<typeof claimSchema>["jobs"][number],
  deadline: number,
  input: SummaryTaskRunnerInput,
): Promise<SummaryTaskRecord> {
  try {
    const context = contextSchema.parse(
      await rpc(store, "read_summary_job_context", {
        p_job_id: job.jobId,
        p_lease_token: job.leaseToken,
      }),
    );
    if (
      context.jobId !== job.jobId ||
      context.ownerId !== job.ownerId ||
      context.leaseToken !== job.leaseToken
    )
      throw new StaleError();
    const chunks: Chunk[] = context.chunks.map((chunk) => ({
      id: chunk.id,
      sourceId: job.sourceId,
      versionId: job.versionId,
      text: chunk.text,
      section: chunk.section,
      order: chunk.ordinal,
      ...(chunk.page ? { page: chunk.page } : {}),
    }));
    const outline: OutlineItem[] | null = context.outline?.items ?? null;
    const sections = buildSummarySections(chunks, outline);
    if (!sections.length) throw new ApiError(422, "SUMMARY_EMPTY", "资料没有可摘要的正文。");
    if (sections.length > 60) throw new StaleError();
    const summaries = new Map<number, BoundSummaryOutput>();
    for (const row of context.summaries.filter((row) => row.level === "section"))
      summaries.set(row.sectionIndex, row.summary as unknown as BoundSummaryOutput);
    const sectionTotal = sections.length;
    for (let index = 0; index < sections.length; index += 1) {
      remaining(deadline, input.signal);
      await heartbeat(store, job);
      if (summaries.has(index)) continue;
      const quota = boolSchema.parse(
        await rpc(store, "reserve_summary_section", {
          p_owner: job.ownerId,
          p_daily_limit:
            input.dailyLimit ?? Number(process.env.CONUO_SUMMARY_DAILY_SECTION_LIMIT ?? 60),
        }),
      );
      if (!quota.allowed) throw new QuotaError();
      const section = sections[index]!;
      let promptTokens = 0;
      let completionTokens = 0;
      const raw = await callModel(config, modelMessages(section), input.signal, {
        onUsage: (usage) => {
          if (Number.isSafeInteger(usage.promptTokens) && usage.promptTokens! >= 0)
            promptTokens += usage.promptTokens!;
          if (Number.isSafeInteger(usage.completionTokens) && usage.completionTokens! >= 0)
            completionTokens += usage.completionTokens!;
        },
      });
      if (promptTokens || completionTokens)
        await rpc(store, "record_ai_token_usage", {
          p_owner: job.ownerId,
          p_request_id: `${job.jobId}-section-${index}`,
          p_route: "summary",
          p_prompt_tokens: promptTokens,
          p_completion_tokens: completionTokens,
        }).catch(() => undefined);
      const parsed = parseSummaryOutput(raw);
      const bound = bindSummaryOutput(
        {
          ...parsed,
          paragraphs: parsed.paragraphs.map((paragraph) =>
            mapEvidenceIds(paragraph, section.chunks),
          ),
        },
        section.chunks,
      );
      await stageSchema.parse(
        await rpc(store, "stage_summary_section", {
          p_job_id: job.jobId,
          p_lease_token: job.leaseToken,
          p_section: {
            index,
            title: bound.title,
            pageStart: section.pageStart ?? null,
            pageEnd: section.pageEnd ?? null,
            chunkIds: bound.paragraphs.flatMap((p) => p.chunkIds),
            summary: bound,
            modelName: config.model,
            sectionsTotal: sectionTotal,
          },
        }),
      );
      summaries.set(index, bound);
    }
    remaining(deadline, input.signal);
    const reduceInput = sections.map((section, index) => ({
      id: `s${index + 1}`,
      title: section.title,
      summary: summaries.get(index)!,
      chunks: section.chunks,
    }));
    let promptTokens = 0;
    let completionTokens = 0;
    const raw = await callModel(config, reduceMessages(reduceInput), input.signal, {
      onUsage: (usage) => {
        if (Number.isSafeInteger(usage.promptTokens) && usage.promptTokens! >= 0)
          promptTokens += usage.promptTokens!;
        if (Number.isSafeInteger(usage.completionTokens) && usage.completionTokens! >= 0)
          completionTokens += usage.completionTokens!;
      },
    });
    if (promptTokens || completionTokens)
      await rpc(store, "record_ai_token_usage", {
        p_owner: job.ownerId,
        p_request_id: `${job.jobId}-document`,
        p_route: "summary",
        p_prompt_tokens: promptTokens,
        p_completion_tokens: completionTokens,
      }).catch(() => undefined);
    const parsedDocument = parseDocumentSummaryOutput(raw);
    const documentEvidence = reduceEvidence(reduceInput);
    const document = bindDocumentSummaryOutput(
      {
        paragraphs: parsedDocument.paragraphs.map((paragraph) =>
          mapEvidenceIds(paragraph, documentEvidence),
        ),
      },
      documentEvidence,
    );
    await finishSchema.parse(
      await rpc(store, "finish_summary_job", {
        p_job_id: job.jobId,
        p_lease_token: job.leaseToken,
        p_document: {
          title: "全书摘要",
          summary: document,
          chunkIds: document.chunkIds,
          modelName: config.model,
        },
      }),
    );
    return { jobId: job.jobId, state: "completed", code: "PUBLISHED" };
  } catch (error) {
    if (error instanceof CancelledError)
      return { jobId: job.jobId, state: "cancelled", code: "CANCELLED" };
    if (error instanceof BudgetError)
      return { jobId: job.jobId, state: "deferred", code: "BUDGET_EXPIRED" };
    if (error instanceof QuotaError)
      return { jobId: job.jobId, state: "deferred", code: "SUMMARY_DAILY_LIMIT" };
    if (
      error instanceof StaleError ||
      (error instanceof RpcError && ["40001", "PT409", "P0002"].includes(error.rpcCode ?? ""))
    )
      return { jobId: job.jobId, state: "stale", code: "LEASE_OR_CONTEXT_CHANGED" };
    const code =
      error instanceof ApiError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
        ? error.code
        : "SUMMARY_WORKER_INTERNAL";
    try {
      await failJob(store, job, code, !(error instanceof ApiError && error.status < 500));
    } catch {
      return { jobId: job.jobId, state: "stale", code: "LEASE_OR_CONTEXT_CHANGED" };
    }
    return { jobId: job.jobId, state: "failed", code };
  }
}

export async function runSummaryTasks(
  store: OrganizationTaskStore,
  input: SummaryTaskRunnerInput,
): Promise<{ records: SummaryTaskRecord[] }> {
  validateInput(input);
  const selected = readModelProfile("default");
  if (!selected?.config)
    throw new ApiError(503, "MODEL_NOT_CONFIGURED", "尚未配置生成模型，暂不能生成摘要。");
  const deadline = Date.now() + input.maxMs;
  const records: SummaryTaskRecord[] = [];
  for (let count = 0; count < input.maxJobs; count += 1) {
    try {
      remaining(deadline, input.signal);
    } catch (error) {
      records.push(
        error instanceof CancelledError
          ? { state: "cancelled", code: "CANCELLED" }
          : { state: "deferred", code: "BUDGET_REMAINING_LOW" },
      );
      break;
    }
    const claimed = claimSchema.parse(
      await rpc(store, "claim_summary_jobs", { p_worker_id: input.workerId, p_lease_seconds: 120 }),
    );
    if (!claimed.jobs.length) {
      records.push({ state: "idle", code: "NO_WORK" });
      break;
    }
    records.push(await processJob(store, selected.config, claimed.jobs[0]!, deadline, input));
    if (records.at(-1)?.state !== "failed") break;
  }
  return { records };
}
