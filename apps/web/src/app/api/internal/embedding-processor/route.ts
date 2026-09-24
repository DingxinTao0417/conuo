import { z } from "zod";
import { readEmbeddingConfig } from "@/lib/ai/embeddings";
import { ApiError, failure, json, readJson } from "@/lib/supabase/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { runEmbeddingTasks } from "@/lib/supabase/embedding-task-runner";
import { requireProcessorIdentity } from "@/lib/supabase/processor-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const requestSchema = z
  .object({
    workerId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,80}$/)
      .default("manual-embedding-processor"),
    maxJobs: z.number().int().min(1).max(5).default(2),
    maxSeconds: z.number().int().min(10).max(240).default(50),
  })
  .strict();
const cronInput = { workerId: "vercel-embedding-processor", maxJobs: 2, maxMs: 50_000 };

async function runProcessor(
  request: Request,
  input: { workerId: string; maxJobs: number; maxMs: number },
) {
  requireProcessorIdentity(request);
  const config = readEmbeddingConfig();
  if (!config) throw new ApiError(503, "EMBEDDING_NOT_CONFIGURED", "语义检索模型尚未配置。");
  const admin = createAdminClient();
  return json(await runEmbeddingTasks(admin, config, { ...input, signal: request.signal }));
}

export async function GET(request: Request) {
  try {
    return await runProcessor(request, cronInput);
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    requireProcessorIdentity(request);
    const parsed = requestSchema.safeParse(await readJson(request, 4096));
    if (!parsed.success)
      throw new ApiError(400, "INVALID_EMBEDDING_PROCESSOR", "后台向量处理请求格式无效。");
    return await runProcessor(request, {
      workerId: parsed.data.workerId,
      maxJobs: parsed.data.maxJobs,
      maxMs: parsed.data.maxSeconds * 1000,
    });
  } catch (error) {
    return failure(error);
  }
}
