import {
  enqueueOrganizationJobInputSchema,
  parseEnqueueOrganizationJobResult,
} from "@/lib/organization-jobs";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import { organizationJobRpcFailure, organizationJobsUnavailable } from "./route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Creates a bounded durable task. The browser supplies only an immutable
 * organization request plus its current workspace revision; SQL owns task
 * insertion and the matching queue projection atomically.
 */
export async function POST(request: Request) {
  try {
    const { supabase } = await requireUser(request);
    const input = enqueueOrganizationJobInputSchema.safeParse(await readJson(request, 12_000));
    if (!input.success)
      throw new ApiError(
        400,
        "INVALID_ORGANIZATION_JOB",
        "后台整理的资料范围、版本或云端版本号无效，请刷新后重新发起。",
      );
    const { data, error } = await supabase.rpc("enqueue_organization_job", {
      p_request: input.data.request,
      p_expected_revision: input.data.expectedRevision,
    });
    if (error) organizationJobRpcFailure(error, "enqueue");
    const result = parseEnqueueOrganizationJobResult(data);
    if (!result) throw organizationJobsUnavailable("后台整理服务返回无效结果，请稍后重试。");
    return json(result);
  } catch (error) {
    return failure(error);
  }
}
