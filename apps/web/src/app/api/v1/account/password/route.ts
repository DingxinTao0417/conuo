import { z } from "zod";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const passwordRequest = z.object({ password: z.string().min(10).max(128) }).strict();

export async function POST(request: Request) {
  try {
    const { supabase } = await requireUser(request);
    const parsed = passwordRequest.safeParse(await readJson(request, 2048));
    if (!parsed.success) throw new ApiError(400, "INVALID_PASSWORD", "密码需要 10 至 128 个字符。");
    // This server client's cookies belong to this request. A different browser
    // tab switching accounts cannot redirect the password change to that account.
    const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
    if (error)
      throw new ApiError(
        400,
        "PASSWORD_UPDATE_FAILED",
        "密码更新未完成，请检查密码强度或重新发送重置邮件。",
      );
    return json({ updated: true });
  } catch (error) {
    return failure(error);
  }
}
