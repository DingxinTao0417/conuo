import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next =
    url.searchParams.get("next") === "/auth/reset-password" ? "/auth/reset-password" : "/";
  if (code) {
    try {
      const supabase = await createClient();
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) {
        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();
        if (user && !userError)
          return NextResponse.redirect(new URL(next, url.origin), {
            headers: { "Cache-Control": "no-store" },
          });
      }
    } catch {
      /* Show a recoverable, non-sensitive result. */
    }
  }
  return NextResponse.redirect(new URL("/auth/error", url.origin), {
    headers: { "Cache-Control": "no-store" },
  });
}
