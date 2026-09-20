import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      service: "conuo-web",
      release: {
        environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
        branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
        commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
