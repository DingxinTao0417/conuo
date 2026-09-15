import { z } from "zod";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import { assertWorkspaceOwner, workspaceSchema } from "@/lib/supabase/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const purgeRequestSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    fingerprint: fingerprintSchema,
  })
  .strict();
const previewSchema = z
  .object({
    revision: z.number().int().min(1),
    fingerprint: fingerprintSchema,
    impact: z.object({}).passthrough(),
    blockers: z.object({}).passthrough(),
  })
  .passthrough();
const resultSchema = z
  .object({
    revision: z.number().int().min(1),
    data: workspaceSchema,
    purgeId: z.string().uuid(),
    cleanupPending: z.boolean(),
  })
  .passthrough();

async function ids(context: { params: Promise<{ sourceId: string; versionId: string }> }) {
  const params = await context.params;
  const sourceId = idSchema.safeParse(params.sourceId);
  const versionId = idSchema.safeParse(params.versionId);
  if (!sourceId.success || !versionId.success)
    throw new ApiError(400, "INVALID_SOURCE_VERSION", "资料或版本标识格式无效，请刷新后重试。");
  return { sourceId: sourceId.data, versionId: versionId.data };
}

function purgeFailure(error: unknown): never {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  if (code === "40001")
    throw new ApiError(
      409,
      "PURGE_CONTEXT_CHANGED",
      "资料版本或影响范围已改变，请重新查看后再确认。",
    );
  if (code === "P0001")
    throw new ApiError(
      409,
      "PURGE_BLOCKED",
      "这个历史版本仍有已保存内容或进行中的任务，请先处理后再清理。",
    );
  if (code === "22023")
    throw new ApiError(
      409,
      "PURGE_UNAVAILABLE",
      "这个历史版本当前无法清理，请刷新版本记录后重试。",
    );
  throw error;
}

/** The database derives dependencies and the confirmation fingerprint from its current snapshot. */
export async function GET(
  request: Request,
  context: { params: Promise<{ sourceId: string; versionId: string }> },
) {
  try {
    const { supabase } = await requireUser(request);
    const target = await ids(context);
    const { data, error } = await supabase.rpc("preview_source_version_purge", {
      p_source_id: target.sourceId,
      p_version_id: target.versionId,
    });
    if (error) purgeFailure(error);
    const parsed = previewSchema.safeParse(data);
    if (!parsed.success)
      throw new ApiError(503, "PURGE_UNAVAILABLE", "历史版本清理服务尚未就绪，请完成数据库迁移。");
    return json(parsed.data);
  } catch (error) {
    return failure(error);
  }
}

/**
 * The browser submits no Storage path or dependency list. The cloud RPC atomically
 * removes the version projection and enqueues only canonical, now-unreferenced paths.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ sourceId: string; versionId: string }> },
) {
  try {
    const { supabase, user } = await requireUser(request);
    const target = await ids(context);
    const input = purgeRequestSchema.safeParse(await readJson(request, 2048));
    if (!input.success)
      throw new ApiError(400, "INVALID_PURGE", "请重新查看历史版本清理影响后再确认。");
    const { data, error } = await supabase.rpc("request_source_version_purge", {
      p_source_id: target.sourceId,
      p_version_id: target.versionId,
      p_expected_revision: input.data.expectedRevision,
      p_fingerprint: input.data.fingerprint,
    });
    if (error) purgeFailure(error);
    const parsed = resultSchema.safeParse(data);
    if (!parsed.success)
      throw new ApiError(503, "PURGE_UNAVAILABLE", "历史版本清理服务尚未就绪，请完成数据库迁移。");
    assertWorkspaceOwner(parsed.data.data, user.id);
    return json(parsed.data);
  } catch (error) {
    return failure(error);
  }
}
