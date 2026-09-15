import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabaseConfig } from "./config";

// Used only by Route Handlers, where refreshed session cookies can be written.
export async function createClient() {
  const config = getSupabaseConfig();
  if (!config) throw new Error("CLOUD_NOT_CONFIGURED");
  const cookieStore = await cookies();
  return createServerClient(config.url, config.key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (values) =>
        values.forEach(({ name, value, options }) => cookieStore.set(name, value, options)),
    },
  });
}
