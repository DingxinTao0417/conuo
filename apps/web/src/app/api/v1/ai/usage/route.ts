import { createRequestStore } from "@/lib/ai/requests";
import { readAiRequestUsage } from "@/lib/ai/usage";
import { ApiError, failure, json, requireUser } from "@/lib/supabase/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { user } = await requireUser(request);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
    const usage = await readAiRequestUsage(createRequestStore(), user.id, signal);
    // Recheck the account-deletion gate before releasing the privileged count.
    const current = await requireUser(request);
    if (current.user.id !== user.id)
      throw new ApiError(409, "SESSION_CHANGED", "当前账号已改变，请重新读取 AI 用量。");
    if (signal.aborted)
      throw new ApiError(499, "REQUEST_CANCELLED", "用量检查已停止，请重新刷新。");
    return json(usage);
  } catch (error) {
    return failure(error);
  }
}
