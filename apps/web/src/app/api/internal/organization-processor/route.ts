import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ApiError, failure, json, readJson } from "@/lib/supabase/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { runOrganizationTasks } from "@/lib/supabase/organization-task-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const requestSchema = z
  .object({
    workerId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,80}$/)
      .default("manual-organization-processor"),
    limit: z.number().int().min(1).max(5).default(1),
    leaseSeconds: z.number().int().min(30).max(300).default(120),
  })
  .strict();
const cronInput = { workerId: "vercel-organization-processor", limit: 1, leaseSeconds: 120 };

function configuredSecrets() {
  return [process.env.CONUO_PROCESSOR_SECRET?.trim(), process.env.CRON_SECRET?.trim()].filter(
    (secret): secret is string =>
      !!secret && secret.length >= 32 && secret.length <= 4096 && !/[^\x21-\x7e]/.test(secret),
  );
}

function requireProcessorIdentity(request: Request) {
  const secrets = configuredSecrets();
  if (!secrets.length)
    throw new ApiError(503, "PROCESSOR_NOT_CONFIGURED", "后台整理入口尚未配置。");
  const header = request.headers.get("authorization") || "";
  if (header.length > 8192) throw new ApiError(401, "PROCESSOR_UNAUTHORIZED", "后台整理身份无效。");
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const actual = digest(header);
  const matched = secrets.some((secret) => timingSafeEqual(actual, digest(`Bearer ${secret}`)));
  if (!matched) throw new ApiError(401, "PROCESSOR_UNAUTHORIZED", "后台整理身份无效。");
}

async function runProcessor(request: Request, input: z.infer<typeof requestSchema>) {
  requireProcessorIdentity(request);
  const admin = createAdminClient();
  return json(await runOrganizationTasks(admin, { ...input, signal: request.signal }));
}

/** Vercel Cron may call this bounded endpoint with its Authorization bearer token. */
export async function GET(request: Request) {
  try {
    return await runProcessor(request, cronInput);
  } catch (error) {
    return failure(error);
  }
}

/** An operator or external scheduler can choose a smaller bounded batch. */
export async function POST(request: Request) {
  try {
    requireProcessorIdentity(request);
    const parsed = requestSchema.safeParse(await readJson(request, 4096));
    if (!parsed.success)
      throw new ApiError(400, "INVALID_ORGANIZATION_PROCESSOR", "后台整理请求格式无效。");
    const admin = createAdminClient();
    return json(await runOrganizationTasks(admin, { ...parsed.data, signal: request.signal }));
  } catch (error) {
    return failure(error);
  }
}
