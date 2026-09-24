"use client";

import type { AnswerRequest, AnswerResult, Source, WorkspaceData } from "./types";
import {
  accountDeletionConfirmationSchema,
  accountDeletionPrepareSchema,
  accountDeletionPreviewSchema,
  type AccountDeletionConfirmation,
  type AccountDeletionPreparation,
  type AccountDeletionPreview,
} from "./account-deletion";
import type { OrganizationRequest, OrganizationResult } from "./organization-types";
import {
  cancelOrganizationJobInputSchema,
  enqueueOrganizationJobInputSchema,
  parseCancelOrganizationJobResult,
  parseEnqueueOrganizationJobResult,
  reconcileOrganizationJobsResponseSchema,
  type CancelOrganizationJobResult,
  type DurableOrganizationRequest,
  type EnqueueOrganizationJobResult,
  type ReconcileOrganizationJobsResult,
} from "./organization-jobs";
import type {
  PermanentSourceDeletionBlockers,
  PermanentSourceDeletionImpact,
  PermanentSourceDeletionContent,
  PermanentSourceDeletionSelection,
} from "./permanent-deletion";
import {
  sameSourcePurgeSelection,
  sourcePurgePreviewSchema,
  sourcePurgeSelectionSchema,
} from "./source-purge-contract";
import type {
  ArchivedSourceVersionDeletionBlockers,
  ArchivedSourceVersionDeletionImpact,
} from "./source-version-deletion";
import { createClient } from "./supabase/client";
import { getSupabaseConfig } from "./supabase/config";
import { assertWorkspaceOwner, MAX_WORKSPACE_BYTES, workspaceSchema } from "./supabase/validation";
import { z } from "zod";
import { searchCandidatesSchema, type SearchRequest } from "./search-types";
import {
  ANSWER_STREAM_LIMITS,
  AnswerStreamError,
  answerCancelled,
  readAnswerResponse,
} from "./answer-stream";
import type { OnAnswerProgress } from "./answer-stream-types";
import { aiRequestUsageSchema, notifyAiUsageChanged } from "./ai-request-usage";
import { observeAccountDeletionFailure } from "./account-deletion-observer";
import { citationSchema } from "./citation-schema";
import {
  learningIdSchema,
  learningItemSchema,
  learningSettingsSchema,
  reviewRequestSchema,
} from "./learning/schema";
import type { LearningItem } from "./learning/types";
import { learningOverviewSchema, type LearningOverview } from "./learning/overview";

export type CloudUser = { id: string; email: string };
export class CloudError extends Error {
  /** An explicit account gate was confirmed, but browser cleanup could not finish. */
  localCleanupFailed = false;
  constructor(
    message: string,
    public status = 500,
    public code = "CLOUD_ERROR",
  ) {
    super(message);
    this.name = "CloudError";
  }
}
export type SourcePurgePreview = {
  revision: number;
  fingerprint: string;
  impact: PermanentSourceDeletionImpact;
  blockers: PermanentSourceDeletionBlockers;
  contentSelection?: PermanentSourceDeletionContent;
};
export type SourcePurgeResult = {
  revision: number;
  data: WorkspaceData;
  purgeId: string;
  /** Metadata is gone; a trusted worker still needs to remove Storage objects. */
  cleanupPending: boolean;
};
export type SourceVersionPurgePreview = {
  revision: number;
  fingerprint: string;
  impact: ArchivedSourceVersionDeletionImpact;
  blockers: ArchivedSourceVersionDeletionBlockers;
};
export type SourceVersionPurgeResult = SourcePurgeResult;
export type { AccountDeletionConfirmation, AccountDeletionPreparation, AccountDeletionPreview };
export type {
  CancelOrganizationJobResult,
  DurableOrganizationJob,
  DurableOrganizationRequest,
  EnqueueOrganizationJobResult,
  ReconcileOrganizationJobsResult,
} from "./organization-jobs";
export function isCloudConfigured() {
  return Boolean(getSupabaseConfig());
}

export function subscribeSession(
  listener: (user: CloudUser | null) => void,
  onIdentityHint?: (rawId: string | null) => void,
): () => void {
  if (!isCloudConfigured()) {
    listener(null);
    return () => {};
  }
  const client = createClient();
  let active = true;
  let eventVersion = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const verify = () => {
    const version = ++eventVersion;
    void client.auth
      .getUser()
      .then(({ data, error }) => {
        if (active && eventVersion === version)
          listener(!error && data.user ? { id: data.user.id, email: data.user.email ?? "" } : null);
      })
      .catch(() => {
        if (active && eventVersion === version) listener(null);
      });
  };
  // The callback stays synchronous. Verification is deferred until Supabase's
  // auth lock is released; INITIAL_SESSION never authorizes from cached cookies.
  const {
    data: { subscription },
  } = client.auth.onAuthStateChange((event, session) => {
    if (!active) return;
    // Cached event identity can invalidate an old operation, never authorize
    // a new login. INITIAL_SESSION is only a hint; getUser remains required.
    if (onIdentityHint) {
      const hintedId = session?.user?.id;
      try {
        onIdentityHint(
          event === "SIGNED_OUT" || typeof hintedId !== "string" || !hintedId ? null : hintedId,
        );
      } catch {
        /* A failed UI hint must not suppress authoritative verification. */
      }
    }
    if (event === "INITIAL_SESSION") return;
    ++eventVersion;
    clearTimeout(timer);
    if (event === "SIGNED_OUT") listener(null);
    else timer = setTimeout(verify, 0);
  });
  verify();
  return () => {
    active = false;
    clearTimeout(timer);
    subscription.unsubscribe();
  };
}

async function cloudRequest<T>(
  path: string,
  expectedUserId: string,
  init: RequestInit = {},
): Promise<T> {
  if (!isCloudConfigured()) throw new CloudError("尚未配置云端服务。", 503, "CLOUD_NOT_CONFIGURED");
  if (!expectedUserId) throw new CloudError("请先登录账号。", 401, "UNAUTHENTICATED");
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: {
      ...init.headers,
      "Content-Type": "application/json",
      "X-Conuo-User": expectedUserId,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : "云端请求失败，请稍后重试。";
    const code =
      body && typeof body === "object" && "code" in body && typeof body.code === "string"
        ? body.code
        : "CLOUD_ERROR";
    const error = new CloudError(message, response.status, code);
    const observation = await observeAccountDeletionFailure(error, expectedUserId);
    error.localCleanupFailed = observation.cleanupFailed;
    throw error;
  }
  return body as T;
}

const workspaceRevisionSchema = z
  .object({
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export async function loadCloudWorkspaceRevision(
  expectedUserId: string,
  signal?: AbortSignal,
): Promise<{ revision: number }> {
  const result = await cloudRequest<unknown>("/api/v1/workspace/revision", expectedUserId, {
    signal,
  });
  const parsed = workspaceRevisionSchema.safeParse(result);
  if (!parsed.success)
    throw new CloudError(
      "云端版本检查返回了无效数据，请稍后重试。",
      502,
      "INVALID_WORKSPACE_REVISION_RESPONSE",
    );
  return parsed.data;
}

export async function getAiRequestUsage(expectedUserId: string, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(15_000);
  const readSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let result: unknown;
  try {
    result = await cloudRequest<unknown>("/api/v1/ai/usage", expectedUserId, {
      signal: readSignal,
    });
  } catch (error) {
    if (timeout.aborted && !signal?.aborted)
      throw new CloudError("AI 用量读取超时，请稍后刷新。", 504, "AI_USAGE_TIMEOUT");
    throw error;
  }
  if (readSignal.aborted)
    throw new CloudError("AI 用量检查已停止，请重新刷新。", 499, "REQUEST_CANCELLED");
  const parsed = aiRequestUsageSchema.safeParse(result);
  if (!parsed.success)
    throw new CloudError("AI 用量返回了无效数据，请稍后刷新。", 502, "INVALID_AI_USAGE_RESPONSE");
  return parsed.data;
}

export async function loadCloudWorkspace(
  expectedUserId: string,
  signal?: AbortSignal,
): Promise<{ data: WorkspaceData | null; revision: number }> {
  const result = await cloudRequest<unknown>("/api/v1/workspace", expectedUserId, { signal });
  const parsed = z
    .object({
      data: workspaceSchema.nullable(),
      revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    })
    .strict()
    .safeParse(result);
  if (
    !parsed.success ||
    (parsed.data.data === null ? parsed.data.revision !== 0 : parsed.data.revision === 0)
  )
    throw new CloudError(
      "云端工作区格式与当前版本不兼容，请保留本机资料。",
      502,
      "INVALID_WORKSPACE_RESPONSE",
    );
  if (parsed.data.data) assertWorkspaceOwner(parsed.data.data, expectedUserId);
  return parsed.data;
}
const workspaceSaveResultSchema = z
  .object({
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export async function saveCloudWorkspace(
  data: WorkspaceData,
  expectedRevision: number,
  expectedUserId: string,
): Promise<{ revision: number }> {
  const result = await cloudRequest<unknown>("/api/v1/workspace", expectedUserId, {
    method: "PUT",
    body: JSON.stringify({ data, expectedRevision }),
  });
  const parsed = workspaceSaveResultSchema.safeParse(result);
  if (!parsed.success || parsed.data.revision !== expectedRevision + 1)
    throw new CloudError(
      "云端已响应，但保存确认格式无效；本机修改仍然保留，正在核对本次提交。",
      502,
      "INVALID_WORKSPACE_SAVE_RESPONSE",
    );
  return parsed.data;
}

const learningItemResponseSchema = learningItemSchema
  .extend({
    createdAt: z.string().datetime({ offset: true }).optional(),
    updatedAt: z.string().datetime({ offset: true }).optional(),
    deletedAt: z.string().datetime({ offset: true }).nullable().optional(),
    card: z.record(z.string(), z.unknown()).nullable().optional(),
    dueAt: z.string().datetime({ offset: true }).nullable().optional(),
    version: z.number().int().min(0).nullable().optional(),
    reps: z.number().int().min(0).nullable().optional(),
    lapses: z.number().int().min(0).nullable().optional(),
    lastReviewAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();
const learningQueueResponseSchema = z
  .object({ items: z.array(learningItemResponseSchema) })
  .strict();
const learningGradeResponseSchema = z
  .object({
    verdict: z.enum(["correct", "partial", "incorrect", "cannot_judge"]),
    covered: z.array(z.number().int().min(0)).max(12),
    missing: z.array(z.number().int().min(0)).max(12),
    misconceptions: z
      .array(
        z
          .object({
            text: z.string().trim().min(1).max(300),
            citations: z.array(citationSchema).max(3),
          })
          .strict(),
      )
      .max(3),
    feedback: z.string().trim().min(1).max(800),
    evidence: z.array(citationSchema).max(6),
  })
  .strict();
const learningGradeRequestSchema = z
  .object({
    requestId: learningIdSchema,
    itemId: learningIdSchema,
    answer: z.string().trim().min(1).max(4_000),
  })
  .strict();

export type LearningGradeResult = z.infer<typeof learningGradeResponseSchema>;
export type LearningSettings = z.infer<typeof learningSettingsSchema>;
export type LearningReviewInput = z.infer<typeof reviewRequestSchema>;

function learningRequestId(value: string, message: string) {
  const parsed = learningIdSchema.safeParse(value);
  if (!parsed.success) throw new CloudError(message, 400, "INVALID_LEARNING_REQUEST");
  return parsed.data;
}

function parseLearningItemResponse(value: unknown, code: string) {
  const parsed = learningItemResponseSchema.safeParse(value);
  if (!parsed.success) throw new CloudError("学习服务返回了无效题目。", 502, code);
  return parsed.data as LearningItem;
}

/** Loads the server-selected active cards for one learning space. */
export async function getLearningQueue(
  spaceId: string,
  expectedUserId: string,
  limit = 100,
  signal?: AbortSignal,
): Promise<LearningItem[]> {
  const id = learningRequestId(spaceId, "学习空间地址无效。");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new CloudError("学习队列参数无效。", 400, "INVALID_LEARNING_REQUEST");
  const result = await cloudRequest<unknown>(
    `/api/v1/learning/queue?spaceId=${encodeURIComponent(id)}&limit=${limit}`,
    expectedUserId,
    { signal },
  );
  const parsed = learningQueueResponseSchema.safeParse(result);
  if (!parsed.success)
    throw new CloudError(
      "学习队列返回了无效数据，请稍后刷新。",
      502,
      "INVALID_LEARNING_QUEUE_RESPONSE",
    );
  return parsed.data.items as LearningItem[];
}

export async function getLearningSettings(
  expectedUserId: string,
  signal?: AbortSignal,
): Promise<LearningSettings> {
  const result = await cloudRequest<unknown>("/api/v1/learning/settings", expectedUserId, {
    signal,
  });
  const parsed = learningSettingsSchema.safeParse(result);
  if (!parsed.success)
    throw new CloudError(
      "学习设置返回了无效数据，请稍后重试。",
      502,
      "INVALID_LEARNING_SETTINGS_RESPONSE",
    );
  return parsed.data;
}

export async function getLearningOverview(
  spaceId: string,
  expectedUserId: string,
  signal?: AbortSignal,
): Promise<LearningOverview> {
  const result = await cloudRequest<unknown>(
    `/api/v1/learning/overview?spaceId=${encodeURIComponent(spaceId)}`,
    expectedUserId,
    { signal },
  );
  const parsed = learningOverviewSchema.safeParse(result);
  if (!parsed.success)
    throw new CloudError(
      "学习概览返回了无效数据，请稍后刷新。",
      502,
      "INVALID_LEARNING_OVERVIEW_RESPONSE",
    );
  return parsed.data;
}

export async function saveLearningSettings(
  expectedUserId: string,
  settings: LearningSettings,
  signal?: AbortSignal,
): Promise<LearningSettings> {
  const input = learningSettingsSchema.safeParse(settings);
  if (!input.success) throw new CloudError("学习设置格式无效。", 400, "INVALID_LEARNING_REQUEST");
  const result = await cloudRequest<unknown>("/api/v1/learning/settings", expectedUserId, {
    method: "PUT",
    body: JSON.stringify(input.data),
    signal,
  });
  const parsed = learningSettingsSchema.safeParse(result);
  if (!parsed.success)
    throw new CloudError(
      "学习设置保存结果无效，请稍后重试。",
      502,
      "INVALID_LEARNING_SETTINGS_RESPONSE",
    );
  return parsed.data;
}

export async function recordLearningReview(
  expectedUserId: string,
  input: LearningReviewInput,
  signal?: AbortSignal,
): Promise<LearningItem> {
  const parsedInput = reviewRequestSchema.safeParse(input);
  if (!parsedInput.success)
    throw new CloudError("复习记录格式无效。", 400, "INVALID_LEARNING_REQUEST");
  const result = await cloudRequest<unknown>("/api/v1/learning/reviews", expectedUserId, {
    method: "POST",
    body: JSON.stringify(parsedInput.data),
    signal,
  });
  return parseLearningItemResponse(result, "INVALID_LEARNING_REVIEW_RESPONSE");
}

export async function gradeLearningAnswer(
  expectedUserId: string,
  input: { requestId: string; itemId: string; answer: string },
  signal?: AbortSignal,
): Promise<LearningGradeResult> {
  const parsedInput = learningGradeRequestSchema.safeParse(input);
  if (!parsedInput.success)
    throw new CloudError("批改请求格式无效。", 400, "INVALID_LEARNING_REQUEST");
  const result = await cloudRequest<unknown>("/api/v1/learning/grade", expectedUserId, {
    method: "POST",
    body: JSON.stringify(parsedInput.data),
    signal,
  });
  const parsed = learningGradeResponseSchema.safeParse(result);
  if (!parsed.success)
    throw new CloudError("批改结果格式无效，请稍后重试。", 502, "INVALID_LEARNING_GRADE_RESPONSE");
  return parsed.data;
}

export type ImportParseLease = {
  status: "claimed" | "held" | "unavailable";
  leaseToken?: string;
  leaseUntil?: string;
};

const importParseIdentifierSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const importParseIdentitySchema = z
  .object({
    sourceId: importParseIdentifierSchema,
    versionId: importParseIdentifierSchema,
  })
  .strict();
const importParseLeaseTokenSchema = z.uuid();
const importParseRevisionSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);
const importParseLeaseResultSchema = z
  .object({
    status: z.enum(["claimed", "held", "unavailable"]),
    leaseToken: importParseLeaseTokenSchema.optional(),
    leaseUntil: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
const importParseReleaseResultSchema = z.object({ released: z.literal(true) }).strict();
const importParseFinishResultSchema = z
  .object({ revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
  .strict();

function importParseIdentity(sourceId: string, versionId: string) {
  const parsed = importParseIdentitySchema.safeParse({ sourceId, versionId });
  if (!parsed.success)
    throw new CloudError(
      "资料或版本标识格式无效，请刷新后重试。",
      400,
      "INVALID_IMPORT_PARSE_REQUEST",
    );
  return parsed.data;
}

function importParseLeaseToken(leaseToken: string) {
  const parsed = importParseLeaseTokenSchema.safeParse(leaseToken);
  if (!parsed.success)
    throw new CloudError(
      "解析租约已失效，请重新打开资料后再试。",
      400,
      "INVALID_IMPORT_PARSE_REQUEST",
    );
  return parsed.data;
}

function importParseFinishInput(
  data: WorkspaceData,
  expectedRevision: number,
  sourceId: string,
  versionId: string,
  leaseToken: string,
) {
  const identity = importParseIdentity(sourceId, versionId);
  const token = importParseLeaseToken(leaseToken);
  const revision = importParseRevisionSchema.safeParse(expectedRevision);
  const workspace = workspaceSchema.safeParse(data);
  if (!revision.success || !workspace.success)
    throw new CloudError(
      "解析结果或资料版本已变化，请重新打开资料后再试。",
      400,
      "INVALID_IMPORT_PARSE_REQUEST",
    );
  if (new TextEncoder().encode(JSON.stringify(workspace.data)).byteLength > MAX_WORKSPACE_BYTES)
    throw new CloudError(
      "工作区文字与历史记录超过当前 3 MiB 云端上限，请先导出备份。",
      413,
      "TOO_LARGE",
    );
  return { ...identity, leaseToken: token, expectedRevision: revision.data, data: workspace.data };
}

function importParseLeaseResult(value: unknown, action: "claim" | "heartbeat"): ImportParseLease {
  const parsed = importParseLeaseResultSchema.safeParse(value);
  if (
    !parsed.success ||
    (parsed.data.status === "claimed" &&
      (!parsed.data.leaseUntil || (action === "claim" && !parsed.data.leaseToken)))
  )
    throw new CloudError("资料解析租约结果格式无效，请稍后重试。", 503, "CLOUD_ERROR");
  // The server may expose additional lease states internally. This stable
  // client boundary intentionally keeps only claimed, held, and unavailable.
  return parsed.data;
}

/** Claim a server-owned parse lease for one immutable current source version. */
export async function claimImportParse(
  sourceId: string,
  versionId: string,
  expectedUserId: string,
): Promise<ImportParseLease> {
  const input = importParseIdentity(sourceId, versionId);
  const result = await cloudRequest<unknown>("/api/v1/imports/parse/claim", expectedUserId, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return importParseLeaseResult(result, "claim");
}

/** Renew the exact lease token; a 409 means the parser must stop without saving. */
export async function heartbeatImportParse(
  sourceId: string,
  versionId: string,
  leaseToken: string,
  expectedUserId: string,
): Promise<ImportParseLease> {
  const input = {
    ...importParseIdentity(sourceId, versionId),
    leaseToken: importParseLeaseToken(leaseToken),
  };
  const result = await cloudRequest<unknown>("/api/v1/imports/parse/heartbeat", expectedUserId, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return importParseLeaseResult(result, "heartbeat");
}

/** Best-effort release of an unconsumed lease token. Lease loss is reported as a safe 409. */
export async function releaseImportParse(
  sourceId: string,
  versionId: string,
  leaseToken: string,
  expectedUserId: string,
): Promise<void> {
  const input = {
    ...importParseIdentity(sourceId, versionId),
    leaseToken: importParseLeaseToken(leaseToken),
  };
  const result = await cloudRequest<unknown>("/api/v1/imports/parse/release", expectedUserId, {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!importParseReleaseResultSchema.safeParse(result).success)
    throw new CloudError("资料解析租约结果格式无效，请稍后重试。", 503, "CLOUD_ERROR");
}

/** Atomically fences a finished parser result behind its lease token and workspace revision. */
export async function finishImportParse(
  data: WorkspaceData,
  expectedRevision: number,
  sourceId: string,
  versionId: string,
  leaseToken: string,
  expectedUserId: string,
): Promise<{ revision: number }> {
  const input = importParseFinishInput(data, expectedRevision, sourceId, versionId, leaseToken);
  const result = await cloudRequest<unknown>("/api/v1/imports/parse/finish", expectedUserId, {
    method: "POST",
    body: JSON.stringify(input),
  });
  const parsed = importParseFinishResultSchema.safeParse(result);
  if (!parsed.success)
    throw new CloudError("资料解析结果格式无效，请刷新资料后重试。", 503, "CLOUD_ERROR");
  return parsed.data;
}

/** Atomically cancels a source version and invalidates any active parse lease for its owner. */
export async function cancelImportParse(
  data: WorkspaceData,
  expectedRevision: number,
  sourceId: string,
  versionId: string,
  expectedUserId: string,
): Promise<{ revision: number }> {
  const identity = importParseIdentity(sourceId, versionId);
  const revision = importParseRevisionSchema.safeParse(expectedRevision);
  const workspace = workspaceSchema.safeParse(data);
  if (!revision.success || !workspace.success)
    throw new CloudError(
      "解析取消的资料或版本已变化，请重新打开资料后再试。",
      400,
      "INVALID_IMPORT_PARSE_REQUEST",
    );
  if (new TextEncoder().encode(JSON.stringify(workspace.data)).byteLength > MAX_WORKSPACE_BYTES)
    throw new CloudError(
      "工作区文字与历史记录超过当前 3 MiB 云端上限，请先导出备份。",
      413,
      "TOO_LARGE",
    );
  const result = await cloudRequest<unknown>("/api/v1/imports/parse/cancel", expectedUserId, {
    method: "POST",
    body: JSON.stringify({ ...identity, expectedRevision: revision.data, data: workspace.data }),
  });
  const parsed = importParseFinishResultSchema.safeParse(result);
  if (!parsed.success)
    throw new CloudError("解析取消结果格式无效，请刷新资料后重试。", 503, "CLOUD_ERROR");
  return parsed.data;
}

/** Reopens a failed or cancelled source version through the server-owned transition. */
export async function retryImportParse(
  data: WorkspaceData,
  expectedRevision: number,
  sourceId: string,
  versionId: string,
  expectedUserId: string,
): Promise<{ revision: number }> {
  const identity = importParseIdentity(sourceId, versionId);
  const revision = importParseRevisionSchema.safeParse(expectedRevision);
  const workspace = workspaceSchema.safeParse(data);
  if (!revision.success || !workspace.success)
    throw new CloudError(
      "重新解析的资料或版本已变化，请重新打开资料后再试。",
      400,
      "INVALID_IMPORT_PARSE_REQUEST",
    );
  if (new TextEncoder().encode(JSON.stringify(workspace.data)).byteLength > MAX_WORKSPACE_BYTES)
    throw new CloudError(
      "工作区文字与历史记录超过当前 3 MiB 云端上限，请先导出备份。",
      413,
      "TOO_LARGE",
    );
  const result = await cloudRequest<unknown>("/api/v1/imports/parse/retry", expectedUserId, {
    method: "POST",
    body: JSON.stringify({ ...identity, expectedRevision: revision.data, data: workspace.data }),
  });
  const parsed = importParseFinishResultSchema.safeParse(result);
  if (!parsed.success)
    throw new CloudError("重新解析结果格式无效，请刷新资料后重试。", 503, "CLOUD_ERROR");
  return parsed.data;
}

const purgeResultSchema = z.object({
  revision: z.number().int().positive(),
  data: workspaceSchema,
  purgeId: z.string().uuid(),
  cleanupPending: z.boolean(),
});
const sourceVersionPurgePreviewSchema = z.object({
  revision: z.number().int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  impact: z.object({
    source: z.object({ id: z.string(), title: z.string() }),
    version: z.object({
      versionId: z.string(),
      filename: z.string(),
      createdAt: z.string(),
      archivedAt: z.string(),
    }),
    annotations: z.number().int().nonnegative(),
    blockingAnnotations: z.number().int().nonnegative(),
    retainedNotes: z.number().int().nonnegative(),
    retainedNoteCitations: z.number().int().nonnegative(),
    retainedConversations: z.number().int().nonnegative(),
    retainedConversationCitations: z.number().int().nonnegative(),
    organizationJobs: z.number().int().nonnegative(),
    blockingOrganizationJobs: z.number().int().nonnegative(),
    conceptRelations: z.number().int().nonnegative(),
    blockingConceptRelations: z.number().int().nonnegative(),
    importJobs: z.number().int().nonnegative(),
    blockingImportJobs: z.number().int().nonnegative(),
    localOriginals: z.number().int().nonnegative(),
    cloudOriginals: z.number().int().nonnegative(),
  }),
  blockers: z.object({
    annotations: z.array(z.string()),
    conceptRelations: z.array(z.string()),
    organizationJobs: z.array(z.string()),
    importJobs: z.array(z.string()),
  }),
});
function purgePath(sourceId: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(sourceId))
    throw new CloudError("资料标识格式无效。", 400, "INVALID_SOURCE");
  return `/api/v1/sources/${encodeURIComponent(sourceId)}/purge`;
}
function sourceVersionPurgePath(sourceId: string, versionId: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(sourceId) || !/^[a-zA-Z0-9_-]{1,100}$/.test(versionId))
    throw new CloudError("资料或版本标识格式无效。", 400, "INVALID_SOURCE_VERSION");
  return `/api/v1/sources/${encodeURIComponent(sourceId)}/versions/${encodeURIComponent(versionId)}/purge`;
}
export async function previewSourcePurge(
  sourceId: string,
  expectedUserId: string,
  selection?: PermanentSourceDeletionSelection,
  signal?: AbortSignal,
): Promise<SourcePurgePreview> {
  const timeout = AbortSignal.timeout(15_000);
  const readSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  if (readSignal.aborted) throw new CloudError("删除范围核对已停止。", 499, "REQUEST_CANCELLED");
  const selected =
    selection === undefined ? undefined : sourcePurgeSelectionSchema.safeParse(selection);
  if (selected && !selected.success)
    throw new CloudError("删除选择格式无效，请重新核对。", 400, "INVALID_PURGE_SELECTION");
  let result: unknown;
  try {
    result = await cloudRequest<unknown>(
      purgePath(sourceId) + (selected ? "/preview" : ""),
      expectedUserId,
      {
        ...(selected?.success ? { method: "POST", body: JSON.stringify(selected.data) } : {}),
        signal: readSignal,
      },
    );
  } catch (cause) {
    if (signal?.aborted) throw new CloudError("删除范围核对已停止。", 499, "REQUEST_CANCELLED");
    if (timeout.aborted)
      throw new CloudError("删除范围核对超时，请重新核对。", 504, "PURGE_PREVIEW_TIMEOUT");
    throw cause;
  }
  if (readSignal.aborted) throw new CloudError("删除范围核对已停止。", 499, "REQUEST_CANCELLED");
  const parsed = sourcePurgePreviewSchema.safeParse(result);
  if (!parsed.success) throw new CloudError("彻底删除预览格式无效，请刷新回收站后重试。");
  if (
    parsed.data.impact.source.id !== sourceId ||
    (selected?.success &&
      (!parsed.data.contentSelection ||
        !sameSourcePurgeSelection(parsed.data.contentSelection.selection, selected.data)))
  )
    throw new CloudError("删除范围与所选记录不一致，请重新核对。", 502, "INVALID_PURGE_PREVIEW");
  if (
    !selected &&
    parsed.data.contentSelection &&
    (parsed.data.contentSelection.selection.noteIds.length ||
      parsed.data.contentSelection.selection.conversationIds.length)
  )
    throw new CloudError(
      "默认删除预览不能预选另存内容，请重新核对。",
      502,
      "INVALID_PURGE_PREVIEW",
    );
  return parsed.data;
}
export async function requestSourcePurge(
  sourceId: string,
  expectedRevision: number,
  fingerprint: string,
  expectedUserId: string,
  selection?: PermanentSourceDeletionSelection,
): Promise<SourcePurgeResult> {
  const selected =
    selection === undefined ? undefined : sourcePurgeSelectionSchema.safeParse(selection);
  if (selected && !selected.success)
    throw new CloudError("删除选择格式无效，请重新核对。", 400, "INVALID_PURGE_SELECTION");
  const result = await cloudRequest<unknown>(purgePath(sourceId), expectedUserId, {
    method: "POST",
    body: JSON.stringify({
      expectedRevision,
      fingerprint,
      ...(selected?.success ? { selection: selected.data } : {}),
    }),
  });
  const parsed = purgeResultSchema.safeParse(result);
  if (!parsed.success) throw new CloudError("彻底删除结果格式无效，请刷新资料库后重试。");
  if (
    parsed.data.revision <= expectedRevision ||
    parsed.data.data.sources.some((source) => source.id === sourceId) ||
    (selected?.success &&
      (selected.data.noteIds.some((id) => parsed.data.data.notes.some((note) => note.id === id)) ||
        selected.data.conversationIds.some((id) =>
          parsed.data.data.conversations.some((conversation) => conversation.id === id),
        )))
  )
    throw new CloudError(
      "删除结果尚未确认，已暂停同步，请刷新资料库。",
      502,
      "INVALID_PURGE_RESULT",
    );
  return parsed.data;
}
export async function previewSourceVersionPurge(
  sourceId: string,
  versionId: string,
  expectedUserId: string,
): Promise<SourceVersionPurgePreview> {
  const result = await cloudRequest<unknown>(
    sourceVersionPurgePath(sourceId, versionId),
    expectedUserId,
  );
  const parsed = sourceVersionPurgePreviewSchema.safeParse(result);
  if (!parsed.success) throw new CloudError("历史版本清理预览格式无效，请刷新版本记录后重试。");
  return parsed.data;
}
export async function requestSourceVersionPurge(
  sourceId: string,
  versionId: string,
  expectedRevision: number,
  fingerprint: string,
  expectedUserId: string,
): Promise<SourceVersionPurgeResult> {
  const result = await cloudRequest<unknown>(
    sourceVersionPurgePath(sourceId, versionId),
    expectedUserId,
    {
      method: "POST",
      body: JSON.stringify({ expectedRevision, fingerprint }),
    },
  );
  const parsed = purgeResultSchema.safeParse(result);
  if (!parsed.success) throw new CloudError("历史版本清理结果格式无效，请刷新资料库后重试。");
  return parsed.data;
}
export async function previewAccountDeletion(
  expectedUserId: string,
  signal?: AbortSignal,
): Promise<AccountDeletionPreview> {
  const result = await cloudRequest<unknown>("/api/v1/account/deletion", expectedUserId, {
    signal,
  });
  const parsed = accountDeletionPreviewSchema.safeParse(result);
  if (!parsed.success) throw new CloudError("账号注销影响预览格式无效，请刷新账号设置后重试。");
  return parsed.data;
}
export async function requestAccountDeletion(
  input: AccountDeletionConfirmation,
  expectedUserId: string,
): Promise<AccountDeletionPreparation> {
  const confirmation = accountDeletionConfirmationSchema.safeParse(input);
  if (!confirmation.success)
    throw new CloudError(
      "请填写当前邮箱、密码，并输入 DELETE 后再确认注销。",
      400,
      "INVALID_ACCOUNT_DELETION_CONFIRMATION",
    );
  const result = await cloudRequest<unknown>("/api/v1/account/deletion", expectedUserId, {
    method: "POST",
    body: JSON.stringify(confirmation.data),
  });
  const parsed = accountDeletionPrepareSchema.safeParse(result);
  if (!parsed.success) throw new CloudError("账号注销结果格式无效，请稍后重新查看账号状态。");
  return parsed.data;
}
export async function askCloud(
  request: AnswerRequest,
  signal: AbortSignal | undefined,
  expectedUserId: string,
  onProgress?: OnAnswerProgress,
): Promise<AnswerResult> {
  if (!isCloudConfigured()) throw new CloudError("尚未配置云端服务。", 503, "CLOUD_NOT_CONFIGURED");
  if (!expectedUserId) throw new CloudError("请先登录账号。", 401, "UNAUTHENTICATED");
  if (signal?.aborted) throw answerCancelled();
  const controller = new AbortController();
  let expired = false;
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  let rejectAbort!: (cause: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(answerCancelled());
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, ANSWER_STREAM_LIMITS.timeoutMs);
  try {
    const response = await Promise.race([
      fetch("/api/v1/ask", {
        method: "POST",
        body: JSON.stringify(request),
        signal: controller.signal,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "X-Conuo-User": expectedUserId,
        },
      }).then((value) => {
        if (controller.signal.aborted) {
          void value.body?.cancel().catch(() => {});
          throw answerCancelled();
        }
        return value;
      }),
      aborted,
    ]);
    return await readAnswerResponse(response, { signal: controller.signal, onProgress });
  } catch (cause) {
    if (expired)
      throw new CloudError("问答响应超时，未保存未完成的回答。", 504, "ANSWER_STREAM_TIMEOUT");
    if (signal?.aborted) throw answerCancelled();
    if (cause instanceof AnswerStreamError) {
      const error = new CloudError(cause.message, cause.status, cause.code);
      const observation = await observeAccountDeletionFailure(error, expectedUserId);
      error.localCleanupFailed = observation.cleanupFailed;
      throw error;
    }
    throw new CloudError("云端问答连接失败，未保存未完成的回答。", 502, "ANSWER_CONNECTION_FAILED");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    controller.signal.removeEventListener("abort", onAbort);
    notifyAiUsageChanged();
  }
}

export type AnswerFeedbackInput = {
  requestId: string;
  conversationId?: string;
  messageId?: string;
  rating: "up" | "down";
  reasons: Array<
    | "wrong_citation"
    | "not_answered"
    | "incorrect"
    | "incomplete"
    | "format"
    | "too_long"
    | "grading_wrong"
    | "other"
  >;
  comment?: string;
  includeContent: boolean;
  question?: string;
  answer?: string;
};

const answerFeedbackResponseSchema = z
  .object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) })
  .strict();

export async function submitAnswerFeedback(
  input: AnswerFeedbackInput,
  expectedUserId: string,
): Promise<{ requestId: string }> {
  const result = await cloudRequest<unknown>("/api/v1/ai/feedback", expectedUserId, {
    method: "POST",
    body: JSON.stringify(input),
  });
  const parsed = answerFeedbackResponseSchema.safeParse(result);
  if (!parsed.success)
    throw new CloudError("反馈保存结果格式无效，请稍后重试。", 502, "INVALID_FEEDBACK_RESPONSE");
  return parsed.data;
}

export async function withdrawAnswerFeedback(
  requestId: string,
  expectedUserId: string,
): Promise<{ requestId: string }> {
  const result = await cloudRequest<unknown>(
    `/api/v1/ai/feedback?requestId=${encodeURIComponent(requestId)}`,
    expectedUserId,
    { method: "DELETE" },
  );
  const parsed = answerFeedbackResponseSchema.safeParse(result);
  if (!parsed.success)
    throw new CloudError("反馈撤回结果格式无效，请稍后重试。", 502, "INVALID_FEEDBACK_RESPONSE");
  return parsed.data;
}

export async function searchCloud(
  request: SearchRequest,
  mode: "keyword" | "semantic",
  expectedUserId: string,
  signal?: AbortSignal,
) {
  const body = await cloudRequest("/api/v1/search", expectedUserId, {
    method: "POST",
    body: JSON.stringify({ request, mode }),
    signal,
  });
  const parsed = z
    .object({
      candidates: searchCandidatesSchema,
      mode: z.enum(["keyword", "semantic"]),
      revision: z.number().int().positive(),
    })
    .safeParse(body);
  if (!parsed.success || parsed.data.mode !== mode) throw new CloudError("云端搜索结果格式无效。");
  return parsed.data;
}

export async function indexingRequest(
  expectedUserId: string,
  action?: { jobId: string; action: "cancel" | "retry" },
  signal?: AbortSignal,
): Promise<unknown> {
  return cloudRequest(
    "/api/v1/indexing",
    expectedUserId,
    action ? { method: "POST", body: JSON.stringify(action), signal } : { signal },
  );
}

export async function getModelStatus(expectedUserId: string, signal?: AbortSignal) {
  const result = await cloudRequest<{ mode: string; message: string }>(
    "/api/v1/ask",
    expectedUserId,
    { signal },
  );
  if (!["model", "extractive"].includes(result.mode) || typeof result.message !== "string")
    throw new CloudError("无法读取模型配置状态，请稍后重试。");
  return result;
}
export function organizeCloud(
  request: OrganizationRequest,
  signal: AbortSignal | undefined,
  expectedUserId: string,
): Promise<OrganizationResult> {
  return cloudRequest<OrganizationResult>("/api/v1/organize", expectedUserId, {
    method: "POST",
    body: JSON.stringify(request),
    signal,
  }).finally(notifyAiUsageChanged);
}

/** Queues a bounded source/knowledge task without sending a workspace snapshot. */
export async function enqueueOrganizationJob(
  request: DurableOrganizationRequest,
  expectedRevision: number,
  expectedUserId: string,
  signal?: AbortSignal,
): Promise<EnqueueOrganizationJobResult> {
  const input = enqueueOrganizationJobInputSchema.safeParse({ request, expectedRevision });
  if (!input.success)
    throw new CloudError(
      "后台整理的资料范围、版本或云端版本号无效，请刷新后重新发起。",
      400,
      "INVALID_ORGANIZATION_JOB",
    );
  const result = await cloudRequest<unknown>("/api/v1/organization-jobs", expectedUserId, {
    method: "POST",
    body: JSON.stringify(input.data),
    signal,
  });
  const parsed = parseEnqueueOrganizationJobResult(result);
  if (!parsed)
    throw new CloudError(
      "后台整理服务返回无效结果，请稍后重试。",
      503,
      "ORGANIZATION_JOBS_UNAVAILABLE",
    );
  return parsed;
}

/** Cancels a durable task behind the exact cloud workspace revision. */
export async function cancelOrganizationJob(
  jobId: string,
  expectedRevision: number,
  expectedUserId: string,
  signal?: AbortSignal,
): Promise<CancelOrganizationJobResult> {
  const input = cancelOrganizationJobInputSchema.safeParse({ jobId, expectedRevision });
  if (!input.success)
    throw new CloudError(
      "后台整理任务标识或云端版本号无效，请刷新后重试。",
      400,
      "INVALID_ORGANIZATION_JOB",
    );
  const result = await cloudRequest<unknown>("/api/v1/organization-jobs/cancel", expectedUserId, {
    method: "POST",
    body: JSON.stringify(input.data),
    signal,
  });
  const parsed = parseCancelOrganizationJobResult(result);
  if (!parsed)
    throw new CloudError(
      "后台整理服务返回无效结果，请稍后重试。",
      503,
      "ORGANIZATION_JOBS_UNAVAILABLE",
    );
  return parsed;
}

/** Reconciles only durable task statuses; it never returns a workspace or model result. */
export async function reconcileOrganizationJobs(
  expectedUserId: string,
  signal?: AbortSignal,
): Promise<ReconcileOrganizationJobsResult> {
  const result = await cloudRequest<unknown>(
    "/api/v1/organization-jobs/reconcile",
    expectedUserId,
    {
      method: "POST",
      body: JSON.stringify({}),
      signal,
    },
  );
  const parsed = reconcileOrganizationJobsResponseSchema.safeParse(result);
  if (!parsed.success)
    throw new CloudError(
      "后台整理核对结果无效，请稍后重试。",
      503,
      "ORGANIZATION_JOBS_UNAVAILABLE",
    );
  return parsed.data;
}
export function updateCloudPassword(
  password: string,
  expectedUserId: string,
): Promise<{ updated: true }> {
  return cloudRequest("/api/v1/account/password", expectedUserId, {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

async function storageClient(expectedUserId: string) {
  const client = createClient();
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (error || !user) throw new CloudError("登录已失效，请重新登录。", 401, "UNAUTHENTICATED");
  if (user.id !== expectedUserId)
    throw new CloudError("当前账号已改变，请重新载入资料。", 409, "SESSION_CHANGED");
  return client;
}

function sourcePath(source: Source, expectedUserId: string) {
  for (const component of [expectedUserId, source.versionId, source.id]) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(component))
      throw new CloudError("资料标识格式无效。", 400, "INVALID_SOURCE");
  }
  const ext = { pdf: "pdf", docx: "docx", markdown: "md", text: "txt", web: "html" }[source.kind];
  return `${expectedUserId}/${source.versionId}/${source.id}.${ext}`;
}
async function digest(blob: Blob) {
  const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const originalUploadId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const originalUploadHash = z.string().regex(/^[a-f0-9]{64}$/);
const originalUploadReservationSchema = z
  .object({
    status: z.enum(["reserved", "uploaded", "committed"]),
    intentId: z.uuid(),
    storagePath: z.string().min(1).max(512),
    reservationToken: z.uuid().nullable(),
    reservationUntil: z.string().min(1).max(80).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.status === "reserved" || value.status === "uploaded") &&
      (!value.reservationToken || !value.reservationUntil)
    )
      context.addIssue({
        code: "custom",
        message: "An active original upload must include a reservation lease.",
      });
    if (value.status === "committed" && (value.reservationToken || value.reservationUntil))
      context.addIssue({
        code: "custom",
        message: "A committed original upload cannot expose a reservation lease.",
      });
  });
const originalUploadCompletionSchema = z
  .object({
    status: z.enum(["uploaded", "committed"]),
    intentId: z.uuid(),
    storagePath: z.string().min(1).max(512),
    reservationUntil: z.string().min(1).max(80).nullable(),
  })
  .strict();

type OriginalUploadReservation = z.infer<typeof originalUploadReservationSchema>;

function originalUploadFailure(
  error: { code?: string | null; message?: string | null; status?: number | null } | null,
  stage: "reserve" | "complete",
): CloudError {
  const code = error?.code || "CLOUD_ERROR";
  if (code === "42501") return new CloudError("登录已失效，请重新登录。", 401, "UNAUTHENTICATED");
  if (code === "55P03")
    return new CloudError("云端正在处理这份原件，请稍后重试。", 503, "ORIGINAL_UPLOAD_BUSY");
  if (code === "40001" || code === "PT409")
    return new CloudError(
      stage === "reserve"
        ? "这份原件的云端状态已变化，请稍后重试。"
        : "云端尚未确认这份原件，请稍后重试。",
      409,
      "ORIGINAL_UPLOAD_STATE_CHANGED",
    );
  if (code === "22023")
    return new CloudError(
      stage === "reserve"
        ? "这份原件不符合当前云端上传容量或身份要求。"
        : "云端原件校验未通过，请重新上传。",
      400,
      "INVALID_ORIGINAL_UPLOAD",
    );
  return new CloudError(
    "原件云端确认失败，文件仍保存在本机。请稍后重试。",
    Number(error?.status) >= 400 && Number(error?.status) < 600 ? Number(error?.status) : 502,
    "ORIGINAL_UPLOAD_UNAVAILABLE",
  );
}

function missingOriginalUploadContract(
  error: {
    code?: string | null;
    message?: string | null;
  } | null,
) {
  return (
    error?.code === "42883" ||
    (error?.code === "PGRST202" && /reserve_original_upload/u.test(error.message || ""))
  );
}

function originalUploadInput(source: Source, blob: Blob, expectedUserId: string) {
  const identity = z
    .object({
      id: originalUploadId,
      versionId: originalUploadId,
      kind: z.enum(["pdf", "docx", "markdown", "text", "web"]),
      size: z
        .number()
        .int()
        .min(0)
        .max(30 * 1024 * 1024),
      hash: originalUploadHash,
      mime: z.string().trim().min(1).max(200),
    })
    .safeParse(source);
  if (!identity.success || blob.size !== source.size)
    throw new CloudError("原件大小或内容指纹无效，尚未开始云端上传。", 400, "INVALID_SOURCE");
  return {
    ...identity.data,
    storagePath: sourcePath(source, expectedUserId),
    contentType: blob.type || identity.data.mime || "application/octet-stream",
  };
}

async function reserveOriginalUpload(
  source: Source,
  blob: Blob,
  expectedUserId: string,
): Promise<{
  client: Awaited<ReturnType<typeof storageClient>>;
  reservation: OriginalUploadReservation | null;
}> {
  const input = originalUploadInput(source, blob, expectedUserId);
  const client = await storageClient(expectedUserId);
  const { data, error } = await client.rpc("reserve_original_upload", {
    p_source_id: input.id,
    p_version_id: input.versionId,
    p_kind: input.kind,
    p_expected_bytes: input.size,
    p_expected_sha256: input.hash,
    p_content_type: input.contentType,
  });
  // Existing deployments can briefly serve this client before the migration has
  // reached the RPC schema cache. Preserve the previous immutable retry behavior
  // during that rollout window; once the contract exists, no direct path bypasses it.
  if (missingOriginalUploadContract(error)) return { client, reservation: null };
  if (error) throw originalUploadFailure(error, "reserve");
  const parsed = originalUploadReservationSchema.safeParse(data);
  if (!parsed.success || parsed.data.storagePath !== input.storagePath)
    throw new CloudError(
      "云端原件预留返回无效，文件仍保存在本机。",
      502,
      "INVALID_ORIGINAL_UPLOAD_RESPONSE",
    );
  return { client, reservation: parsed.data };
}

async function uploadOriginalToStorage(
  client: Awaited<ReturnType<typeof storageClient>>,
  path: string,
  blob: Blob,
): Promise<void> {
  const { error } = await client.storage
    .from("originals")
    // A Blob makes storage-js send multipart/form-data. Send raw bytes so the
    // Storage RLS preflight sees the exact original Content-Length, not a
    // multipart envelope or unknown file length. Completion still checks size.
    .upload(path, await blob.arrayBuffer(), {
      contentType: blob.type || "application/octet-stream",
      upsert: false,
    });
  if (!error) return;
  // Immutable paths make retries safe. An existing path is accepted only after
  // comparing the actual stored bytes, never simply because the filename matches.
  if ("statusCode" in error && ["409", "400"].includes(String(error.statusCode))) {
    const { data: existing, error: downloadError } = await client.storage
      .from("originals")
      .download(path);
    if (
      !downloadError &&
      existing &&
      existing.size === blob.size &&
      (await digest(existing)) === (await digest(blob))
    )
      return;
  }
  // An upload response can be lost after Storage commits the immutable object.
  // Keep the intent live for a retry or the server cleanup worker; never free it
  // based only on this ambiguous browser-side error.
  throw new CloudError(
    "原件上传失败，仍保存在本机。请检查网络与云端存储配置。",
    502,
    "UPLOAD_FAILED",
  );
}

async function completeOriginalUpload(
  client: Awaited<ReturnType<typeof storageClient>>,
  reservation: OriginalUploadReservation,
  expectedPath: string,
): Promise<void> {
  if (!reservation.reservationToken)
    throw new CloudError(
      "云端原件预留已失效，文件仍保存在本机。",
      409,
      "ORIGINAL_UPLOAD_STATE_CHANGED",
    );
  const { data, error } = await client.rpc("complete_original_upload", {
    p_intent_id: reservation.intentId,
    p_reservation_token: reservation.reservationToken,
  });
  if (error) throw originalUploadFailure(error, "complete");
  const parsed = originalUploadCompletionSchema.safeParse(data);
  if (!parsed.success || parsed.data.storagePath !== expectedPath)
    throw new CloudError(
      "云端原件确认返回无效，文件仍保存在本机。",
      502,
      "INVALID_ORIGINAL_UPLOAD_RESPONSE",
    );
}

export async function uploadSourceBlob(
  source: Source,
  blob: Blob,
  expectedUserId: string,
): Promise<string> {
  if (blob.size > 30 * 1024 * 1024)
    throw new CloudError("当前单份原件上限为 30 MiB。", 413, "FILE_TOO_LARGE");
  const { client, reservation } = await reserveOriginalUpload(source, blob, expectedUserId);
  const path = sourcePath(source, expectedUserId);
  if (!reservation) {
    await uploadOriginalToStorage(client, path, blob);
    return path;
  }
  if (reservation.storagePath !== path)
    throw new CloudError(
      "云端原件预留路径无效，文件仍保存在本机。",
      502,
      "INVALID_ORIGINAL_UPLOAD_RESPONSE",
    );
  if (reservation.status === "committed") return path;
  if (reservation.status === "uploaded") {
    await completeOriginalUpload(client, reservation, path);
    return path;
  }
  await uploadOriginalToStorage(client, path, blob);
  await completeOriginalUpload(client, reservation, path);
  return path;
}

export async function downloadSourceBlob(
  source: Source,
  expectedUserId: string,
): Promise<Blob | undefined> {
  if (!source.storagePath) return undefined;
  const client = await storageClient(expectedUserId);
  if (source.storagePath !== sourcePath(source, expectedUserId))
    throw new CloudError("原件路径与当前账号或版本不符。", 403, "INVALID_SOURCE_PATH");
  const { data, error } = await client.storage.from("originals").download(source.storagePath);
  if (error)
    throw new CloudError("暂时无法下载这份原件，请检查网络后重试。", 502, "DOWNLOAD_FAILED");
  return data;
}

export async function deleteSourceBlob(source: Source, expectedUserId: string): Promise<void> {
  if (!source.storagePath) return;
  const client = await storageClient(expectedUserId);
  if (source.storagePath !== sourcePath(source, expectedUserId))
    throw new CloudError("原件路径与当前账号或版本不符。", 403, "INVALID_SOURCE_PATH");
  const { error } = await client.storage.from("originals").remove([source.storagePath]);
  if (error) throw new CloudError("原件删除未完成，请稍后重试。", 502, "DELETE_FAILED");
}
