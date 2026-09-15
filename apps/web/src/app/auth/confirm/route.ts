import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  if (
    tokenHash &&
    tokenHash.length <= 2048 &&
    (type === "signup" || type === "recovery" || type === "email")
  ) {
    try {
      const supabase = await createClient();
      const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
      if (!error) {
        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();
        if (user && !userError)
          return NextResponse.redirect(
            new URL(type === "recovery" ? "/auth/reset-password" : "/", url.origin),
            { headers: { "Cache-Control": "no-store" } },
          );
      }
    } catch {
      /* Show a recoverable, non-sensitive result. */
    }
  }
  return NextResponse.redirect(new URL("/auth/error", url.origin), {
    headers: { "Cache-Control": "no-store" },
  });
}
