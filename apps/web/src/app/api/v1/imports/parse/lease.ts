import { z } from "zod";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import {
  assertWorkspaceOwner,
  MAX_WORKSPACE_BYTES,
  workspaceSchema,
} from "@/lib/supabase/validation";

const identifierSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const leaseTokenSchema = z.uuid();
const expectedRevisionSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);
const identitySchema = z
  .object({
    sourceId: identifierSchema,
    versionId: identifierSchema,
  })
  .strict();
const leaseSchema = identitySchema.extend({ leaseToken: leaseTokenSchema }).strict();
const finishSchema = leaseSchema
  .extend({
    data: workspaceSchema,
    expectedRevision: expectedRevisionSchema,
  })
  .strict();
const retrySchema = identitySchema
  .extend({
    data: workspaceSchema,
    expectedRevision: expectedRevisionSchema,
  })
  .strict();
const cancelSchema = retrySchema;
const timestampSchema = z.string().datetime({ offset: true });

export type ImportParseLease = {
  status: "claimed" | "held" | "unavailable";
  leaseToken?: string;
  leaseUntil?: string;
};

const leaseOutputSchema = z
  .object({
    status: z.string().max(64),
    leaseToken: leaseTokenSchema.optional(),
    lease_token: leaseTokenSchema.optional(),
    leaseUntil: timestampSchema.optional(),
    lease_until: timestampSchema.optional(),
  })
  .passthrough();
const heartbeatOutputSchema = z
  .object({
    status: z.string().max(64).optional(),
    leaseUntil: timestampSchema.optional(),
    lease_until: timestampSchema.optional(),
  })
  .passthrough();
const releaseOutputSchema = z
  .object({
    status: z.string().max(64).optional(),
    released: z.boolean().optional(),
  })
  .passthrough();
const finishOutputSchema = z.union([
  z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  z.object({ revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).passthrough(),
]);

type ParseAction = "claim" | "heartbeat" | "release" | "finish" | "cancel" | "retry";

function unavailable(message = "资料解析租约服务暂不可用，请稍后重试。") {
  return new ApiError(503, "IMPORT_PARSE_UNAVAILABLE", message);
}

function requestInvalid(action: ParseAction): ApiError {
  const message =
    action === "finish" || action === "cancel" || action === "retry"
      ? "解析结果或资料版本已变化，请重新打开资料后再试。"
      : "资料解析租约请求格式无效，请刷新后重试。";
  return new ApiError(400, "INVALID_IMPORT_PARSE_REQUEST", message);
}

function rpcFailure(error: unknown, action: ParseAction): never {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  if (code === "40001") {
    const message =
      action === "finish" || action === "cancel" || action === "retry"
        ? "资料、解析任务或云端版本已改变，未保存本次解析结果。请重新打开后再试。"
        : "解析租约已失效或资料状态已改变，请重新打开资料后再试。";
    const conflictCode =
      action === "finish"
        ? "IMPORT_PARSE_FINISH_CONFLICT"
        : action === "cancel"
          ? "IMPORT_PARSE_CANCEL_CONFLICT"
          : action === "retry"
            ? "IMPORT_PARSE_RETRY_CONFLICT"
            : "IMPORT_PARSE_LEASE_CHANGED";
    throw new ApiError(409, conflictCode, message);
  }
  if (code === "22023") throw requestInvalid(action);
  throw unavailable();
}

function normalizeClaim(value: unknown): ImportParseLease {
  const parsed = leaseOutputSchema.safeParse(value);
  if (!parsed.success) throw unavailable("资料解析租约服务返回无效结果，请稍后重试。");
  const status = parsed.data.status.toLowerCase();
  const leaseToken = parsed.data.leaseToken ?? parsed.data.lease_token;
  const leaseUntil = parsed.data.leaseUntil ?? parsed.data.lease_until;
  if (status === "claimed") {
    if (!leaseToken || !leaseUntil) throw unavailable("资料解析租约服务返回无效结果，请稍后重试。");
    return { status: "claimed", leaseToken, leaseUntil };
  }
  if (status === "busy" || status === "held")
    return { status: "held", ...(leaseUntil ? { leaseUntil } : {}) };
  if (status === "unavailable") return { status: "unavailable" };
  throw unavailable("资料解析租约服务返回无效结果，请稍后重试。");
}

function normalizeHeartbeat(value: unknown): ImportParseLease {
  const parsed = heartbeatOutputSchema.safeParse(value);
  if (!parsed.success) throw unavailable("资料解析租约服务返回无效结果，请稍后重试。");
  const status = parsed.data.status?.toLowerCase();
  const leaseUntil = parsed.data.leaseUntil ?? parsed.data.lease_until;
  if (status === "unavailable") return { status: "unavailable" };
  if (status && !["claimed", "renewed", "active"].includes(status))
    throw unavailable("资料解析租约服务返回无效结果，请稍后重试。");
  if (!leaseUntil) throw unavailable("资料解析租约服务返回无效结果，请稍后重试。");
  return { status: "claimed", leaseUntil };
}

function normalizeRelease(value: unknown): { released: true } {
  const parsed = releaseOutputSchema.safeParse(value);
  if (!parsed.success) throw unavailable("资料解析租约服务返回无效结果，请稍后重试。");
  if (parsed.data.released === true || parsed.data.status?.toLowerCase() === "released")
    return { released: true };
  throw unavailable("资料解析租约服务返回无效结果，请稍后重试。");
}

function normalizeFinish(value: unknown): { revision: number } {
  const parsed = finishOutputSchema.safeParse(value);
  if (!parsed.success) throw unavailable("资料解析结果服务返回无效结果，请稍后重试。");
  return { revision: typeof parsed.data === "number" ? parsed.data : parsed.data.revision };
}

function assertFinishTarget(
  data: z.infer<typeof workspaceSchema>,
  sourceId: string,
  versionId: string,
) {
  const source = data.sources.find((item) => item.id === sourceId);
  const job = data.importJobs?.find(
    (item) => item.sourceId === sourceId && item.versionId === versionId,
  );
  const succeeded =
    !!source &&
    !source.deletedAt &&
    !source.originalMissing &&
    source.versionId === versionId &&
    (source.status === "ready" || source.status === "partial") &&
    !!job &&
    job.status === "completed" &&
    job.stage === "indexing" &&
    job.originalSaved;
  const failed =
    !!source &&
    !source.deletedAt &&
    !source.originalMissing &&
    source.versionId === versionId &&
    source.status === "failed" &&
    !!job &&
    job.status === "failed" &&
    job.stage === "parsing" &&
    job.originalSaved;
  if (!succeeded && !failed) throw requestInvalid("finish");
}

function importTarget(data: z.infer<typeof workspaceSchema>, sourceId: string, versionId: string) {
  const source = data.sources.find((item) => item.id === sourceId);
  const job = data.importJobs?.find(
    (item) => item.sourceId === sourceId && item.versionId === versionId,
  );
  return { source, job };
}

function assertCancelledImportTarget(
  data: z.infer<typeof workspaceSchema>,
  sourceId: string,
  versionId: string,
) {
  const { source, job } = importTarget(data, sourceId, versionId);
  if (
    !source ||
    source.deletedAt ||
    source.originalMissing ||
    source.versionId !== versionId ||
    source.status !== "saved" ||
    !job ||
    job.status !== "cancelled" ||
    job.stage !== "parsing" ||
    !job.originalSaved
  )
    throw requestInvalid("cancel");
}

function assertRetryImportTarget(
  data: z.infer<typeof workspaceSchema>,
  sourceId: string,
  versionId: string,
) {
  const { source, job } = importTarget(data, sourceId, versionId);
  if (
    !source ||
    source.deletedAt ||
    source.originalMissing ||
    source.versionId !== versionId ||
    source.status !== "parsing" ||
    !job ||
    (job.status !== "queued" && job.status !== "running") ||
    job.stage !== "parsing" ||
    !job.originalSaved
  )
    throw requestInvalid("retry");
}

export async function claimImportParseRoute(request: Request) {
  try {
    const { supabase } = await requireUser(request);
    const input = identitySchema.safeParse(await readJson(request, 2048));
    if (!input.success) throw requestInvalid("claim");
    const { data, error } = await supabase.rpc("claim_import_parse", {
      p_source_id: input.data.sourceId,
      p_version_id: input.data.versionId,
    });
    if (error) rpcFailure(error, "claim");
    return json(normalizeClaim(data));
  } catch (error) {
    return failure(error);
  }
}

export async function heartbeatImportParseRoute(request: Request) {
  try {
    const { supabase } = await requireUser(request);
    const input = leaseSchema.safeParse(await readJson(request, 2048));
    if (!input.success) throw requestInvalid("heartbeat");
    const { data, error } = await supabase.rpc("heartbeat_import_parse", {
      p_source_id: input.data.sourceId,
      p_version_id: input.data.versionId,
      p_lease_token: input.data.leaseToken,
    });
    if (error) rpcFailure(error, "heartbeat");
    return json(normalizeHeartbeat(data));
  } catch (error) {
    return failure(error);
  }
}

export async function releaseImportParseRoute(request: Request) {
  try {
    const { supabase } = await requireUser(request);
    const input = leaseSchema.safeParse(await readJson(request, 2048));
    if (!input.success) throw requestInvalid("release");
    const { data, error } = await supabase.rpc("release_import_parse", {
      p_source_id: input.data.sourceId,
      p_version_id: input.data.versionId,
      p_lease_token: input.data.leaseToken,
    });
    if (error) rpcFailure(error, "release");
    return json(normalizeRelease(data));
  } catch (error) {
    return failure(error);
  }
}

export async function finishImportParseRoute(request: Request) {
  try {
    const { supabase, user } = await requireUser(request);
    const input = finishSchema.safeParse(await readJson(request, MAX_WORKSPACE_BYTES + 1024));
    if (!input.success) throw requestInvalid("finish");
    try {
      assertWorkspaceOwner(input.data.data, user.id);
    } catch {
      throw requestInvalid("finish");
    }
    if (new TextEncoder().encode(JSON.stringify(input.data.data)).byteLength > MAX_WORKSPACE_BYTES)
      throw new ApiError(
        413,
        "TOO_LARGE",
        "工作区文字与历史记录超过当前 3 MiB 云端上限，请先导出备份。",
      );
    assertFinishTarget(input.data.data, input.data.sourceId, input.data.versionId);
    // Only this fenced RPC can persist parser output: it atomically checks
    // source/version, lease token, and workspace revision before saving data.
    const { data, error } = await supabase.rpc("finish_import_parse", {
      p_data: input.data.data,
      p_expected_revision: input.data.expectedRevision,
      p_source_id: input.data.sourceId,
      p_version_id: input.data.versionId,
      p_lease_token: input.data.leaseToken,
    });
    if (error) rpcFailure(error, "finish");
    return json(normalizeFinish(data));
  } catch (error) {
    return failure(error);
  }
}

/** Stores a cancellation and invalidates any active same-owner token in one database transaction. */
export async function cancelImportParseRoute(request: Request) {
  try {
    const { supabase, user } = await requireUser(request);
    const input = cancelSchema.safeParse(await readJson(request, MAX_WORKSPACE_BYTES + 1024));
    if (!input.success) throw requestInvalid("cancel");
    try {
      assertWorkspaceOwner(input.data.data, user.id);
    } catch {
      throw requestInvalid("cancel");
    }
    if (new TextEncoder().encode(JSON.stringify(input.data.data)).byteLength > MAX_WORKSPACE_BYTES)
      throw new ApiError(
        413,
        "TOO_LARGE",
        "工作区文字与历史记录超过当前 3 MiB 云端上限，请先导出备份。",
      );
    assertCancelledImportTarget(input.data.data, input.data.sourceId, input.data.versionId);
    const { data, error } = await supabase.rpc("cancel_import_parse", {
      p_data: input.data.data,
      p_expected_revision: input.data.expectedRevision,
      p_source_id: input.data.sourceId,
      p_version_id: input.data.versionId,
    });
    if (error) rpcFailure(error, "cancel");
    return json(normalizeFinish(data));
  } catch (error) {
    return failure(error);
  }
}

/** Reopens a terminal import using the server-controlled immutable-version transition. */
export async function retryImportParseRoute(request: Request) {
  try {
    const { supabase, user } = await requireUser(request);
    const input = retrySchema.safeParse(await readJson(request, MAX_WORKSPACE_BYTES + 1024));
    if (!input.success) throw requestInvalid("retry");
    try {
      assertWorkspaceOwner(input.data.data, user.id);
    } catch {
      throw requestInvalid("retry");
    }
    if (new TextEncoder().encode(JSON.stringify(input.data.data)).byteLength > MAX_WORKSPACE_BYTES)
      throw new ApiError(
        413,
        "TOO_LARGE",
        "工作区文字与历史记录超过当前 3 MiB 云端上限，请先导出备份。",
      );
    assertRetryImportTarget(input.data.data, input.data.sourceId, input.data.versionId);
    const { data, error } = await supabase.rpc("retry_import_parse", {
      p_data: input.data.data,
      p_expected_revision: input.data.expectedRevision,
      p_source_id: input.data.sourceId,
      p_version_id: input.data.versionId,
    });
    if (error) rpcFailure(error, "retry");
    return json(normalizeFinish(data));
  } catch (error) {
    return failure(error);
  }
}
