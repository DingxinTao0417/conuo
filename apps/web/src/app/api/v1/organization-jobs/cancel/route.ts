import {
  cancelOrganizationJobInputSchema,
  parseCancelOrganizationJobResult,
} from "@/lib/organization-jobs";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import { organizationJobRpcFailure, organizationJobsUnavailable } from "../route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cancels only the current account's durable task behind the workspace CAS. */
export async function POST(request: Request) {
  try {
    const { supabase } = await requireUser(request);
    const input = cancelOrganizationJobInputSchema.safeParse(await readJson(request, 2_048));
    if (!input.success)
      throw new ApiError(
        400,
        "INVALID_ORGANIZATION_JOB",
        "后台整理任务标识或云端版本号无效，请刷新后重试。",
      );
    const { data, error } = await supabase.rpc("cancel_organization_job", {
      p_job_id: input.data.jobId,
      p_expected_revision: input.data.expectedRevision,
    });
    if (error) organizationJobRpcFailure(error, "cancel");
    const result = parseCancelOrganizationJobResult(data);
    if (!result) throw organizationJobsUnavailable("后台整理服务返回无效结果，请稍后重试。");
    return json(result);
  } catch (error) {
    return failure(error);
  }
}
