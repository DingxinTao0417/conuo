import type { OrganizationJob } from "./organization-types";
import type { WorkspaceData } from "./types";

export const ORGANIZATION_HISTORY_LIMIT = 1000;

export type CleanableOrganizationStatus = Extract<
  OrganizationJob["status"],
  "dismissed" | "failed" | "cancelled"
>;

export interface OrganizationHistoryCleanupImpact {
  total: number;
  removable: number;
  retained: number;
  byStatus: Record<CleanableOrganizationStatus, number>;
  byKind: Record<OrganizationJob["request"]["kind"], number>;
}

const cleanableStatuses = new Set<OrganizationJob["status"]>(["dismissed", "failed", "cancelled"]);

export function isOrganizationHistoryCleanable(job: OrganizationJob): boolean {
  return cleanableStatuses.has(job.status);
}

export function organizationHistoryCleanupImpact(
  jobs: OrganizationJob[] = [],
): OrganizationHistoryCleanupImpact {
  const removableJobs = jobs.filter(isOrganizationHistoryCleanable);
  return {
    total: jobs.length,
    removable: removableJobs.length,
    retained: jobs.length - removableJobs.length,
    byStatus: {
      dismissed: removableJobs.filter((job) => job.status === "dismissed").length,
      failed: removableJobs.filter((job) => job.status === "failed").length,
      cancelled: removableJobs.filter((job) => job.status === "cancelled").length,
    },
    byKind: {
      source: removableJobs.filter((job) => job.request.kind === "source").length,
      knowledge: removableJobs.filter((job) => job.request.kind === "knowledge").length,
      update: removableJobs.filter((job) => job.request.kind === "update").length,
      relations: removableJobs.filter((job) => job.request.kind === "relations").length,
    },
  };
}

export function cleanupOrganizationHistory(data: WorkspaceData): {
  data: WorkspaceData;
  impact: OrganizationHistoryCleanupImpact;
} {
  const jobs = data.organizationJobs ?? [];
  const impact = organizationHistoryCleanupImpact(jobs);
  if (!impact.removable) return { data, impact };

  const organizationJobs = jobs.filter((job) => !isOrganizationHistoryCleanable(job));
  if (organizationJobs.length) return { data: { ...data, organizationJobs }, impact };

  const withoutOrganizationJobs = { ...data };
  delete withoutOrganizationJobs.organizationJobs;
  return { data: withoutOrganizationJobs, impact };
}
