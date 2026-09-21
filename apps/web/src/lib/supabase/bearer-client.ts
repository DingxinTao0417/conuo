import "server-only";
import { createClient } from "@supabase/supabase-js";

/** One request, one caller token: verification and all RLS queries share this identity. */
export function createBearerClient(token: string, config: { url: string; key: string }) {
  return createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}
