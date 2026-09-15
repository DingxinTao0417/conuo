import type { WorkspaceData } from "./types";

/**
 * The file-import lifecycle deliberately lives outside `Source` for now.
 * A source can be readable, partial, or failed, while an import job records
 * the resumable work that produced that version. Callers generate the source
 * and version IDs before creating a job, then persist both with the original
 * blob as their durable identity.
 */
export type ImportStage = "saving" | "parsing" | "indexing";
export type ImportJobStatus = "queued" | "running" | "failed" | "cancelled" | "completed";

export interface ImportJob {
  /** Deterministic from sourceId + versionId. It is never regenerated for a retry. */
  id: string;
  sourceId: string;
  versionId: string;
  filename: string;
  /** Empty string represents Inbox, matching the current import entry point. */
  spaceId: string;
  stage: ImportStage;
  status: ImportJobStatus;
  /** True only after the immutable original has been durably retained. */
  originalSaved: boolean;
  /** Number of starts, rather than number of queued retries. */
  attempt: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
  cancelledAt?: string;
  completedAt?: string;
}

export interface CreateImportJobInput {
  sourceId: string;
  versionId: string;
  filename: string;
  spaceId: string;
  at: string;
}

const stages: readonly ImportStage[] = ["saving", "parsing", "indexing"];

function stageIndex(stage: ImportStage): number {
  return stages.indexOf(stage);
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}不能为空。`);
  return normalized;
}

function requireTimestamp(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label}必须是有效时间。`);
  return value;
}

/**
 * Length-prefixing keeps the two IDs unambiguous even when an implementation
 * later accepts IDs containing the separator character. It is synchronous and
 * deterministic, so retries do not rely on browser crypto or current time.
 */
export function importJobId(sourceId: string, versionId: string): string {
  const source = requireNonEmpty(sourceId, "资料标识");
  const version = requireNonEmpty(versionId, "版本标识");
  return `import-${source.length}-${source}-${version}`;
}

function assertJob(job: ImportJob): void {
  if (job.id !== importJobId(job.sourceId, job.versionId))
    throw new Error("导入任务标识与资料版本不一致。");
  requireNonEmpty(job.filename, "文件名");
  requireTimestamp(job.createdAt, "创建时间");
  requireTimestamp(job.updatedAt, "更新时间");
  if (!Number.isSafeInteger(job.attempt) || job.attempt < 0)
    throw new Error("导入任务尝试次数无效。");
  if (!stages.includes(job.stage)) throw new Error("导入任务阶段无效。");
  if (!["queued", "running", "failed", "cancelled", "completed"].includes(job.status))
    throw new Error("导入任务状态无效。");
  if (job.status === "failed" && !job.error?.trim()) throw new Error("失败任务需要保留错误信息。");
  if (job.status !== "failed" && job.error !== undefined)
    throw new Error("只有失败任务可以保留错误信息。");
  if (job.status === "cancelled" && !job.cancelledAt)
    throw new Error("已取消任务需要保留取消时间。");
  if (job.status !== "cancelled" && job.cancelledAt !== undefined)
    throw new Error("只有已取消任务可以保留取消时间。");
  if (job.status === "completed") {
    if (!job.originalSaved || job.stage !== "indexing" || !job.completedAt)
      throw new Error("完成任务必须已保存原件并完成索引。");
  } else if (job.completedAt !== undefined) {
    throw new Error("未完成任务不能保留完成时间。");
  }
}

function transition(job: ImportJob, patch: Partial<ImportJob>): ImportJob {
  assertJob(job);
  const next = { ...job, ...patch };
  assertJob(next);
  return next;
}

/** Starts in saving state; source/version IDs must already be reserved by the caller. */
export function createImportJob(input: CreateImportJobInput): ImportJob {
  const at = requireTimestamp(input.at, "创建时间");
  const sourceId = requireNonEmpty(input.sourceId, "资料标识");
  const versionId = requireNonEmpty(input.versionId, "版本标识");
  const filename = requireNonEmpty(input.filename, "文件名");
  return {
    id: importJobId(sourceId, versionId),
    sourceId,
    versionId,
    filename,
    spaceId: input.spaceId.trim(),
    stage: "saving",
    status: "queued",
    originalSaved: false,
    attempt: 0,
    createdAt: at,
    updatedAt: at,
  };
}

/** Queue entries become active only through this transition. */
export function startImportJob(job: ImportJob, at: string): ImportJob {
  if (job.status !== "queued") throw new Error("只有排队中的导入任务可以开始。");
  return transition(job, {
    status: "running",
    attempt: job.attempt + 1,
    updatedAt: requireTimestamp(at, "开始时间"),
  });
}

/**
 * A stage can only move forward one step while running. Moving from saving to
 * parsing proves the original has been retained; it must remain true forever.
 */
export function advanceImportJob(job: ImportJob, stage: ImportStage, at: string): ImportJob {
  if (job.status !== "running") throw new Error("只有运行中的导入任务可以推进阶段。");
  if (stageIndex(stage) !== stageIndex(job.stage) + 1)
    throw new Error("导入任务阶段只能按保存、解析、索引顺序推进。");
  return transition(job, {
    stage,
    originalSaved: true,
    updatedAt: requireTimestamp(at, "阶段更新时间"),
  });
}

/** Failure preserves the current stage and original-retention fact for an exact retry. */
export function failImportJob(job: ImportJob, error: string, at: string): ImportJob {
  if (job.status !== "running") throw new Error("只有运行中的导入任务可以标记失败。");
  return transition(job, {
    status: "failed",
    error: requireNonEmpty(error, "失败原因"),
    updatedAt: requireTimestamp(at, "失败时间"),
  });
}

/** Cancellation never removes an already saved original or invents a new task ID. */
export function cancelImportJob(job: ImportJob, at: string): ImportJob {
  if (job.status === "cancelled") return { ...job };
  if (job.status !== "queued" && job.status !== "running")
    throw new Error("只有排队中或运行中的导入任务可以取消。");
  const cancelledAt = requireTimestamp(at, "取消时间");
  return transition(job, {
    status: "cancelled",
    cancelledAt,
    updatedAt: cancelledAt,
  });
}

/**
 * A source-level recycle tombstone covers its current and retained versions.
 * Cancel each pending job by source ID so a parser cannot remain queued for a
 * historical version after its owner has moved to the recycle bin. When the
 * current version was still parsing, return it to its durable "saved" state;
 * the original blob identifiers and retained versions are never changed.
 */
export function cancelImportJobsForRecycledSources(data: WorkspaceData, at: string): WorkspaceData {
  const recycledSourceIds = new Set(
    data.sources.filter((source) => !!source.deletedAt).map((source) => source.id),
  );
  if (!recycledSourceIds.size || !data.importJobs?.length) return data;
  const pendingJobs = data.importJobs.filter(
    (job) =>
      recycledSourceIds.has(job.sourceId) && (job.status === "queued" || job.status === "running"),
  );
  if (!pendingJobs.length) return data;

  const pendingCurrentVersions = new Set(
    pendingJobs.map((job) => JSON.stringify([job.sourceId, job.versionId])),
  );
  const sources = data.sources.map((source) => {
    if (
      !source.deletedAt ||
      source.status !== "parsing" ||
      !pendingCurrentVersions.has(JSON.stringify([source.id, source.versionId]))
    )
      return source;
    return {
      ...source,
      status: "saved" as const,
      text: "",
      chunks: [],
      error: "解析已因资料移入回收站而停止。恢复后可重新解析。",
      pageCount: undefined,
      parsedPages: undefined,
      coverage: { captureScope: "full" as const, parseState: "pending" as const },
      updatedAt: at,
    };
  });
  const pendingIds = new Set(pendingJobs.map((job) => job.id));
  const importJobs = data.importJobs.map((job) =>
    pendingIds.has(job.id) ? cancelImportJob(job, at) : job,
  );
  return { ...data, sources, importJobs };
}

/** Completion is valid only after durable original storage, parsing, and indexing. */
export function completeImportJob(job: ImportJob, at: string): ImportJob {
  if (job.status !== "running") throw new Error("只有运行中的导入任务可以完成。");
  if (!job.originalSaved || job.stage !== "indexing")
    throw new Error("导入任务尚未完成原件保存、解析和索引。");
  const completedAt = requireTimestamp(at, "完成时间");
  return transition(job, {
    status: "completed",
    completedAt,
    updatedAt: completedAt,
  });
}

/**
 * Only interrupted or failed work may be retried. The original source/version
 * identity and current safe stage remain intact; `attempt` increments on the
 * subsequent start rather than when a user clicks retry repeatedly.
 */
export function retryImportJob(job: ImportJob, at: string): ImportJob {
  if (job.status !== "failed" && job.status !== "cancelled")
    throw new Error("只有失败或已取消的导入任务可以重试。");
  return transition(job, {
    status: "queued",
    error: undefined,
    cancelledAt: undefined,
    updatedAt: requireTimestamp(at, "重试时间"),
  });
}

/** A browser reload may interrupt parsing; retain the original and queue the exact same job. */
export function resumeImportJob(job: ImportJob, at: string): ImportJob {
  if (job.status !== "queued" && job.status !== "running") return { ...job };
  return transition(job, {
    status: "queued",
    updatedAt: requireTimestamp(at, "恢复时间"),
  });
}

/** Return copies so a consumer cannot mutate a queue entry through a filtered view. */
export function importJobsForSource(
  jobs: readonly ImportJob[],
  sourceId: string,
  versionId?: string,
): ImportJob[] {
  const source = requireNonEmpty(sourceId, "资料标识");
  const version = versionId === undefined ? undefined : requireNonEmpty(versionId, "版本标识");
  return jobs
    .filter(
      (job) => job.sourceId === source && (version === undefined || job.versionId === version),
    )
    .map((job) => {
      assertJob(job);
      return { ...job };
    });
}

/**
 * Replace one queue entry without allowing duplicate jobs for the same source
 * version. The caller can use this with a workspace updater once the schema is
 * extended, while this module remains storage-agnostic today.
 */
export function replaceImportJob(jobs: readonly ImportJob[], nextJob: ImportJob): ImportJob[] {
  assertJob(nextJob);
  const sameIdentity = jobs.filter(
    (job) => job.sourceId === nextJob.sourceId && job.versionId === nextJob.versionId,
  );
  if (sameIdentity.length > 1) throw new Error("同一资料版本存在重复导入任务。");
  if (sameIdentity.length === 1 && sameIdentity[0].id !== nextJob.id)
    throw new Error("同一资料版本的导入任务标识不一致。");
  const found = jobs.some((job) => job.id === nextJob.id);
  if (found) return jobs.map((job) => (job.id === nextJob.id ? { ...nextJob } : { ...job }));
  return [...jobs.map((job) => ({ ...job })), { ...nextJob }];
}
