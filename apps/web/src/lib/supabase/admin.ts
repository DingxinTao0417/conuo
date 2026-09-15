import "server-only";
import { createClient } from "@supabase/supabase-js";
import { ApiError } from "./api";
import { getSupabaseConfig } from "./config";

/**
 * Creates a Supabase client for narrowly scoped internal maintenance endpoints.
 * It is never used by browser-facing routes: those must use the caller session
 * and RLS through `requireUser` instead.
 */
export function createAdminClient() {
  const config = getSupabaseConfig();
  const secret =
    process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!config || !secret)
    throw new ApiError(
      503,
      "CLOUD_ADMIN_NOT_CONFIGURED",
      "云端维护服务尚未配置，请完成服务端环境变量设置。",
    );
  return createClient(config.url, secret, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
