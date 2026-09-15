import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ApiError, failure, json, readJson } from "@/lib/supabase/api";
import { createRequestStore } from "@/lib/ai/requests";
import { readEmbeddingConfig, reserveEmbeddingUsage } from "@/lib/ai/embeddings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const common = { profileFingerprint: z.string().regex(/^[0-9a-f]{64}$/) };
const lease = { ...common, jobId: z.uuid(), leaseToken: z.uuid() };
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const schema = z.discriminatedUnion("action", [
  z
    .object({
      ...common,
      action: z.literal("claim"),
      workerId: id,
      limit: z.number().int().min(1).max(5).default(1),
      leaseSeconds: z.number().int().min(30).max(300).default(120),
    })
    .strict(),
  z
    .object({
      ...lease,
      action: z.literal("read"),
      limit: z.number().int().min(1).max(16).default(16),
    })
    .strict(),
  z
    .object({
      ...lease,
      action: z.literal("commit"),
      start: z.number().int().min(0).max(20000),
      rows: z
        .array(
          z
            .object({
              chunkId: id,
              contentHash: z.string().regex(/^[0-9a-f]{64}$/),
              embedding: z.array(z.number().finite().min(-1e10).max(1e10)).length(1536),
            })
            .strict(),
        )
        .min(1)
        .max(16),
    })
    .strict(),
  z.object({ ...lease, action: z.literal("finish") }).strict(),
  z
    .object({
      ...lease,
      action: z.literal("heartbeat"),
      leaseSeconds: z.number().int().min(30).max(300).default(120),
    })
    .strict(),
  z
    .object({
      ...lease,
      action: z.literal("fail"),
      errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
      retryable: z.boolean(),
    })
    .strict(),
]);

export async function POST(request: Request) {
  try {
    const secret = process.env.CONUO_PROCESSOR_SECRET?.trim();
    if (!secret || secret.length < 32 || secret.length > 4096 || /[^\x21-\x7e]/.test(secret))
      throw new ApiError(503, "PROCESSOR_NOT_CONFIGURED", "索引处理入口尚未配置。");
    const header = request.headers.get("authorization") || "";
    const digest = (value: string) => createHash("sha256").update(value).digest();
    if (header.length > 8192 || !timingSafeEqual(digest(header), digest(`Bearer ${secret}`)))
      throw new ApiError(401, "PROCESSOR_UNAUTHORIZED", "索引处理身份无效。");
    const body = schema.safeParse(await readJson(request, 1_500_000));
    if (!body.success)
      throw new ApiError(400, "INVALID_INDEXING_REQUEST", "索引任务请求格式无效。");
    const config = readEmbeddingConfig();
    if (!config) throw new ApiError(503, "EMBEDDING_NOT_CONFIGURED", "语义检索模型尚未配置。");
    const input = body.data;
    if (input.profileFingerprint !== config.fingerprint)
      throw new ApiError(
        409,
        "EMBEDDING_PROFILE_CHANGED",
        "索引模型配置不一致，请检查处理器配置。",
      );
    if (request.signal.aborted) throw new ApiError(499, "REQUEST_CANCELLED", "任务请求已取消。");
    const store = createRequestStore();
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const result = await store.rpc(name, args);
      if (result.error)
        throw new ApiError(
          ["40001", "P0002"].includes(result.error.code)
            ? 409
            : result.error.code === "22023"
              ? 400
              : 503,
          "INDEXING_STATE_CHANGED",
          "索引任务状态已改变或服务暂不可用。",
        );
      return result.data;
    };
    if (input.action === "claim")
      return json(
        await rpc("claim_embedding_jobs", {
          p_worker_id: input.workerId,
          p_limit: input.limit,
          p_lease_seconds: input.leaseSeconds,
          p_profile_fingerprint: config.fingerprint,
        }),
      );
    const args = { p_job_id: input.jobId, p_lease_token: input.leaseToken };
    if (input.action === "read") {
      const batch = await rpc("read_embedding_batch", { ...args, p_limit: input.limit });
      const parsed = z
        .object({
          ownerId: z.uuid(),
          jobId: z.uuid(),
          cursor: z.number().int().min(0),
          totalChunks: z.number().int().min(0),
          chunks: z
            .array(
              z.object({
                chunkId: id,
                text: z.string().min(1).max(100000),
                contentHash: z.string().regex(/^[0-9a-f]{64}$/),
                ordinal: z.number().int(),
              }),
            )
            .max(16),
        })
        .safeParse(batch);
      if (!parsed.success || parsed.data.jobId !== input.jobId)
        throw new ApiError(503, "INVALID_INDEXING_BATCH", "索引内容批次无效。");
      if (parsed.data.chunks.length)
        await reserveEmbeddingUsage(
          parsed.data.ownerId,
          parsed.data.chunks.reduce((sum, chunk) => sum + [...chunk.text].length, 0),
          store,
        );
      if (Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > 1_000_000)
        throw new ApiError(
          422,
          "INDEXING_BATCH_TOO_LARGE",
          "索引批次超过正文传输上限，请减小批次。",
        );
      // Budget reservation may wait on another task. Recheck permission and lease before disclosure.
      await rpc("heartbeat_embedding_job", { ...args, p_lease_seconds: 120 });
      if (request.signal.aborted) throw new ApiError(499, "REQUEST_CANCELLED", "任务请求已取消。");
      return json(parsed.data);
    }
    if (input.action === "commit")
      return json(
        await rpc("commit_embedding_batch", { ...args, p_start: input.start, p_rows: input.rows }),
      );
    if (input.action === "finish") return json(await rpc("finish_embedding_job", args));
    if (input.action === "heartbeat")
      return json(
        await rpc("heartbeat_embedding_job", { ...args, p_lease_seconds: input.leaseSeconds }),
      );
    return json(
      await rpc("fail_embedding_job", {
        ...args,
        p_error_code: input.errorCode,
        p_retryable: input.retryable,
      }),
    );
  } catch (error) {
    return failure(error);
  }
}
