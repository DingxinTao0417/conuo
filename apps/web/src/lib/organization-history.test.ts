import { describe, expect, it } from "vitest";
import { createDemoWorkspace } from "./seed";
import type { OrganizationJob } from "./organization-types";
import {
  cleanupOrganizationHistory,
  organizationHistoryCleanupImpact,
} from "./organization-history";

function job(
  id: string,
  status: OrganizationJob["status"],
  kind: OrganizationJob["request"]["kind"],
): OrganizationJob {
  return {
    id,
    status,
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    request: {
      requestId: id,
      kind,
      trigger: "manual",
      spaceId: "space-one",
      sourceIds: ["source-one"],
      sourceVersions: [{ sourceId: "source-one", versionId: "version-one" }],
    },
  };
}

describe("organization history cleanup", () => {
  it("reports terminal history by status and request kind", () => {
    const impact = organizationHistoryCleanupImpact([
      job("dismissed-source", "dismissed", "source"),
      job("failed-update", "failed", "update"),
      job("cancelled-relations", "cancelled", "relations"),
      job("ready-knowledge", "ready", "knowledge"),
      job("running-source", "running", "source"),
    ]);

    expect(impact).toEqual({
      total: 5,
      removable: 3,
      retained: 2,
      byStatus: { dismissed: 1, failed: 1, cancelled: 1 },
      byKind: { source: 1, knowledge: 0, update: 1, relations: 1 },
    });
  });

  it("removes only terminal history without changing accepted workspace content", () => {
    const data = createDemoWorkspace();
    data.organizationJobs = [
      job("dismissed-source", "dismissed", "source"),
      job("failed-update", "failed", "update"),
      job("cancelled-relations", "cancelled", "relations"),
      job("ready-knowledge", "ready", "knowledge"),
      job("queued-source", "queued", "source"),
    ];
    const notes = structuredClone(data.notes);
    const sources = structuredClone(data.sources);
    const conceptRelations = structuredClone(data.conceptRelations);

    const result = cleanupOrganizationHistory(data);

    expect(result.impact.removable).toBe(3);
    expect(result.data.organizationJobs?.map((item) => item.id)).toEqual([
      "ready-knowledge",
      "queued-source",
    ]);
    expect(result.data.notes).toEqual(notes);
    expect(result.data.sources).toEqual(sources);
    expect(result.data.conceptRelations).toEqual(conceptRelations);
    expect(data.organizationJobs).toHaveLength(5);
  });

  it("keeps the workspace identity when there is nothing safe to remove", () => {
    const data = createDemoWorkspace();
    data.organizationJobs = [job("ready-knowledge", "ready", "knowledge")];

    const result = cleanupOrganizationHistory(data);

    expect(result.data).toBe(data);
    expect(result.impact).toMatchObject({ total: 1, removable: 0, retained: 1 });
  });

  it("omits the optional collection after removing the last terminal record", () => {
    const data = createDemoWorkspace();
    data.organizationJobs = [job("failed-source", "failed", "source")];

    const result = cleanupOrganizationHistory(data);

    expect(result.data.organizationJobs).toBeUndefined();
  });
});
