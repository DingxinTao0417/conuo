import type { DurableOrganizationRequest } from "../cloud";
import type { OrganizationJob, OrganizationRequest } from "../organization-types";
import type { WorkspaceData } from "../types";

export function keepsRunningAfterBrowserExit(job: OrganizationJob): boolean {
  return (
    job.durable === true &&
    (job.request.kind === "source" || job.request.kind === "knowledge") &&
    (job.status === "queued" || job.status === "running")
  );
}

export function isDurableOrganizationRequest(
  request: OrganizationRequest,
): request is DurableOrganizationRequest {
  return request.kind === "source" || request.kind === "knowledge";
}

export function isInterruptedBrowserOrganization(job: OrganizationJob): boolean {
  return (
    (job.status === "queued" || job.status === "running") && !keepsRunningAfterBrowserExit(job)
  );
}

/**
 * A normal workspace save can legitimately turn an active durable task into a
 * terminal server projection when its evidence boundary changes. Preserve a
 * newer local edit, but never let it carry that old active projection into a
 * later full-snapshot save.
 */
export function reconcileDurableOrganizationProjections(
  local: WorkspaceData,
  canonical: WorkspaceData,
): WorkspaceData {
  const terminalById = new Map(
    (canonical.organizationJobs ?? [])
      .filter((job) => job.durable === true && !keepsRunningAfterBrowserExit(job))
      .map((job) => [job.id, job]),
  );
  let changed = false;
  const jobs = (local.organizationJobs ?? []).map((job) => {
    const terminal = terminalById.get(job.id);
    if (!keepsRunningAfterBrowserExit(job) || !terminal) return job;
    changed = true;
    return terminal;
  });
  return changed ? { ...local, organizationJobs: jobs } : local;
}
