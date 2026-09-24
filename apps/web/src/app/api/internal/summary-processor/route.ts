import { z } from "zod";
import { aiFeatureEnabled } from "@/lib/ai/features";
import { ApiError, failure, json, readJson } from "@/lib/supabase/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireProcessorIdentity } from "@/lib/supabase/processor-auth";
import { runSummaryTasks } from "@/lib/supabase/summary-task-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const requestSchema = z
  .object({
    workerId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,80}$/)
      .default("manual-summary-processor"),
    maxJobs: z.number().int().min(1).max(2).default(1),
    maxSeconds: z.number().int().min(20).max(240).default(50),
  })
  .strict();

async function run(request: Request, input: { workerId: string; maxJobs: number; maxMs: number }) {
  requireProcessorIdentity(request);
  if (!aiFeatureEnabled("SECTION_SUMMARIES"))
    throw new ApiError(404, "SUMMARY_FEATURE_DISABLED", "分层摘要功能尚未开启。");
  const admin = createAdminClient();
  return json(await runSummaryTasks(admin, { ...input, signal: request.signal }));
}

export async function GET(request: Request) {
  try {
    return await run(request, { workerId: "vercel-summary-processor", maxJobs: 1, maxMs: 50_000 });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    requireProcessorIdentity(request);
    const parsed = requestSchema.safeParse(await readJson(request, 4096));
    if (!parsed.success)
      throw new ApiError(400, "INVALID_SUMMARY_PROCESSOR", "后台摘要处理请求格式无效。");
    return await run(request, {
      workerId: parsed.data.workerId,
      maxJobs: parsed.data.maxJobs,
      maxMs: parsed.data.maxSeconds * 1000,
    });
  } catch (error) {
    return failure(error);
  }
}
