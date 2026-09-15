import { z } from "zod";
import { reconcileOrganizationJobsResponseSchema } from "@/lib/organization-jobs";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import { organizationJobRpcFailure, organizationJobsUnavailable } from "../route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const emptyRequestSchema = z.object({}).strict();

/**
 * Reconciliation can repair an interrupted audit projection, so it remains a
 * JSON POST protected by the normal same-origin check rather than a GET with
 * hidden write side effects.
 */
export async function POST(request: Request) {
  try {
    const { supabase } = await requireUser(request);
    const input = emptyRequestSchema.safeParse(await readJson(request, 128));
    if (!input.success)
      throw new ApiError(
        400,
        "INVALID_ORGANIZATION_JOB",
        "后台整理核对请求格式无效，请刷新后重试。",
      );
    const { data, error } = await supabase.rpc("reconcile_organization_jobs", {});
    if (error) organizationJobRpcFailure(error, "reconcile");
    const result = reconcileOrganizationJobsResponseSchema.safeParse(data);
    if (!result.success) throw organizationJobsUnavailable("后台整理核对结果无效，请稍后重试。");
    return json(result.data);
  } catch (error) {
    return failure(error);
  }
}
