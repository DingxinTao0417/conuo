import { cancelImportParseRoute } from "../lease";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return cancelImportParseRoute(request);
}
