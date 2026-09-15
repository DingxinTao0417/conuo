"use client";

import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseConfig } from "./config";

export function createClient() {
  const config = getSupabaseConfig();
  if (!config) throw new Error("尚未配置云端服务，请联系管理员完成配置后重试。");
  return createBrowserClient(config.url, config.key);
}
