import { describe, expect, it } from "vitest";
import { createDemoWorkspace } from "./seed";
import {
  createImportJob,
  startImportJob,
  advanceImportJob,
  failImportJob,
  retryImportJob,
  cancelImportJob,
  completeImportJob,
} from "./import-queue";
import { addSourcesToLearningSpaces } from "./source-space-association";
import { recycleSourcesWithResult } from "./space-lifecycle";
import { MAX_WORKSPACE_BYTES, workspaceSchema } from "./supabase/validation";
import {
  applyBulkSourceAction,
  confirmBulkSourceAction,
  retryBulkSourceAction,
  snapshotRetryBulkSourceAction,
} from "./bulk-source-actions";
import type { BulkSourceActionRequest } from "./bulk-source-actions";
const at = "2026-09-15T09:00:00.000Z",
  later = "2026-09-15T10:00:00.000Z";
function fixture() {
  const data = createDemoWorkspace(),
    base = data.sources[0],
    space = data.spaces[0];
  data.spaces = [
    { ...space, id: "alpha" },
    { ...space, id: "beta" },
  ];
  data.sources = ["safe", "parsing", "job-parsing", "old-history", "noop", "deleted"].map((id) => ({
    ...base,
    id,
    versionId: `${id}-current`,
    title: id,
    spaceIds: [],
    deletedAt: null,
    chunks: base.chunks.map((chunk, i) => ({
      ...chunk,
      id: `${id}-chunk-${i}`,
      sourceId: id,
      versionId: `${id}-current`,
    })),
  }));
  data.sources[1].status = "parsing";
  data.sources[4].spaceIds = ["alpha", "beta"];
  data.sources[5].deletedAt = at;
  data.sources[0].blobKey = "safe-original";
  const old = data.sources[3];
  old.versions = [
    {
      versionId: "old-history-retained",
      title: "真实保留旧版",
      filename: old.filename,
      kind: old.kind,
      mime: old.mime,
      size: old.size,
      hash: old.hash,
      status: "ready",
      text: old.text,
      chunks: old.chunks.map((chunk, i) => ({
        ...chunk,
        id: `old-retained-chunk-${i}`,
        versionId: "old-history-retained",
      })),
      blobKey: "retained-original",
      createdAt: old.createdAt,
      archivedAt: at,
    },
  ];
  const job = (sourceId: string, versionId: string) =>
    advanceImportJob(
      startImportJob(
        createImportJob({ sourceId, versionId, filename: `${sourceId}.txt`, spaceId: "", at }),
        at,
      ),
      "parsing",
      at,
    );
  data.importJobs = [
    retryImportJob(failImportJob(job("job-parsing", "job-parsing-current"), "需重试", at), at),
    job("old-history", "old-history-retained"),
  ];
  return data;
}
describe("durable bulk source action receipts", () => {
  it("protects current active parses per item while associating safe sources and reporting exact noop/missing/deleted rows", () => {
    const data = fixture(),
      before = structuredClone(data);
    expect(addSourcesToLearningSpaces(data, ["parsing"], ["alpha"], at).addedSourceIds).toEqual([
      "parsing",
    ]);
    const applied = applyBulkSourceAction(
      data,
      {
        kind: "associate",
        sourceIds: [
          "safe",
          "parsing",
          "job-parsing",
          "old-history",
          "noop",
          "deleted",
          "missing",
          "safe",
        ],
        spaceIds: ["alpha", "beta", "alpha"],
      },
      at,
    );
    expect(applied.result.selectedCount).toBe(7);
    expect(applied.result.items.map((item) => item.status)).toEqual([
      "accepted",
      "failed",
      "failed",
      "accepted",
      "noop",
      "failed",
      "failed",
    ]);
    expect(applied.result.acceptedSourceIds).toEqual(["safe", "old-history"]);
    expect(applied.result.addedSourceIds).toEqual(["safe", "old-history"]);
    expect(applied.result.addedAssociations).toBe(4);
    expect(applied.result.items[1].reason).toMatch(/解析/);
    expect(applied.result.items[2].reason).toMatch(/解析/);
    expect(applied.data.sources[1]).toEqual(data.sources[1]);
    expect(confirmBulkSourceAction(applied.data, applied.result)).toBe(applied.result);
    expect(workspaceSchema.safeParse(applied.data)).toMatchObject({ success: true });
    expect(data).toEqual(before);
  });
  it("soft-recycles only safe selections, preserving bytes/history and cancelling historical pending jobs through the real existing domain", () => {
    const data = fixture(),
      before = structuredClone(data);
    expect(recycleSourcesWithResult(data, ["parsing"], at).recycledSourceIds).toEqual(["parsing"]);
    const applied = applyBulkSourceAction(
      data,
      {
        kind: "recycle",
        sourceIds: ["safe", "parsing", "job-parsing", "old-history", "deleted", "missing"],
      },
      later,
    );
    expect(applied.result.items.map((item) => item.status)).toEqual([
      "accepted",
      "failed",
      "failed",
      "accepted",
      "noop",
      "failed",
    ]);
    expect(applied.result.recycledSourceIds).toEqual(["safe", "old-history"]);
    expect(applied.data.sources[0]).toMatchObject({
      deletedAt: later,
      updatedAt: later,
      text: before.sources[0].text,
      blobKey: before.sources[0].blobKey,
    });
    expect(applied.data.sources[3].versions).toEqual(before.sources[3].versions);
    expect(workspaceSchema.safeParse(applied.data)).toMatchObject({ success: true });
    expect(applied.data.importJobs?.find((job) => job.sourceId === "old-history")).toMatchObject({
      status: "cancelled",
      cancelledAt: later,
    });
    expect(applied.data.importJobs?.find((job) => job.sourceId === "job-parsing")?.status).toBe(
      "queued",
    );
    expect(confirmBulkSourceAction(applied.data, applied.result)).toBe(applied.result);
    expect(data).toEqual(before);
  });
  it.each(["associate", "recycle"] as const)(
    "preserves first real accepted IDs for a failed-disk %s snapshot retry without replaying business actions",
    (kind) => {
      const data = fixture(),
        request: BulkSourceActionRequest =
          kind === "associate"
            ? { kind, sourceIds: ["safe", "noop"], spaceIds: ["alpha", "beta"] }
            : { kind, sourceIds: ["safe", "deleted"] };
      const first = applyBulkSourceAction(data, request, at),
        memory = {
          ...first.data,
          aiEnabled: false,
          sources: first.data.sources.map((source) => ({
            ...source,
            tags: ["later independent metadata"],
          })),
        };
      const snapshot = snapshotRetryBulkSourceAction(memory, first.result);
      expect(snapshot.data).not.toBe(memory);
      expect(snapshot.data.aiEnabled).toBe(false);
      expect(snapshot.data.sources[0].tags).toEqual(["later independent metadata"]);
      expect(snapshot.result).toBe(first.result);
      expect(snapshot.result.acceptedSourceIds).toEqual(["safe"]);
      expect(snapshot.result.at).toBe(at);
      const confirmed = confirmBulkSourceAction(snapshot.data, snapshot.result);
      expect(confirmed.acceptedSourceIds).toEqual(["safe"]);
      expect(kind === "associate" ? confirmed.addedSourceIds : confirmed.recycledSourceIds).toEqual(
        ["safe"],
      );
      expect(() => snapshotRetryBulkSourceAction(snapshot.data, confirmed)).toThrow(/确认|保存/);
    },
  );
  it("only retries previously failed sources against the current data after the first snapshot was confirmed", () => {
    const first = applyBulkSourceAction(
      fixture(),
      { kind: "associate", sourceIds: ["safe", "parsing", "job-parsing"], spaceIds: ["alpha"] },
      at,
    );
    expect(() => retryBulkSourceAction(first.data, first.result, later)).toThrow(/确认/);
    confirmBulkSourceAction(first.data, first.result);
    const current = {
      ...first.data,
      importJobs: [],
      sources: first.data.sources.map((source) => ({
        ...source,
        status: "ready" as const,
        tags: ["current tags"],
      })),
    };
    const retried = retryBulkSourceAction(current, first.result, later);
    expect(retried.result.acceptedSourceIds).toEqual(["safe", "parsing", "job-parsing"]);
    expect(retried.result.addedAssociations).toBe(3);
    expect(retried.result.items[0]).toEqual(first.result.items[0]);
    expect(retried.result.items[0].at).toBe(at);
    expect(retried.result.items[1].at).toBe(later);
    expect(retried.data.sources[0]).toEqual(current.sources[0]);
    confirmBulkSourceAction(retried.data, retried.result);
    expect(retryBulkSourceAction(retried.data, retried.result).data).toBe(retried.data);
  });
  it("cannot confirm or retry a forged, mutated, undone or replaced successful association", () => {
    const first = applyBulkSourceAction(
      fixture(),
      { kind: "associate", sourceIds: ["safe"], spaceIds: ["alpha"] },
      at,
    );
    expect(Object.isFrozen(first.result.request.sourceIds)).toBe(true);
    expect(Object.isFrozen(first.result.items[0])).toBe(true);
    expect(() => confirmBulkSourceAction(first.data, structuredClone(first.result))).toThrow(
      /身份|结果/,
    );
    for (const patch of [{ spaceIds: [] }, { versionId: "new-version" }, { deletedAt: later }]) {
      const changed = {
        ...first.data,
        sources: first.data.sources.map((source) =>
          source.id === "safe" ? { ...source, ...patch } : source,
        ),
      };
      expect(() => confirmBulkSourceAction(changed, first.result)).toThrow(/变化|改变/);
      expect(() => snapshotRetryBulkSourceAction(changed, first.result)).toThrow(/变化|改变/);
    }
    expect(() =>
      confirmBulkSourceAction(
        { ...first.data, spaces: first.data.spaces.map((space) => ({ ...space, archived: true })) },
        first.result,
      ),
    ).toThrow(/空间|变化/);
  });
  it("rejects a restored or re-recycled source after a provisional delete instead of resurrecting the old success", () => {
    const first = applyBulkSourceAction(fixture(), { kind: "recycle", sourceIds: ["safe"] }, at);
    for (const deletedAt of [null, later]) {
      const changed = {
        ...first.data,
        sources: first.data.sources.map((source) =>
          source.id === "safe" ? { ...source, deletedAt } : source,
        ),
      };
      expect(() => snapshotRetryBulkSourceAction(changed, first.result)).toThrow(/变化|改变/);
      expect(() => confirmBulkSourceAction(changed, first.result)).toThrow(/变化|改变/);
    }
  });
  it("validates all selected targets first and atomically rejects whole-workspace UTF8 overflow", () => {
    const data = fixture(),
      before = structuredClone(data);
    for (const request of [
      { kind: "associate", sourceIds: ["safe"], spaceIds: [] },
      { kind: "associate", sourceIds: ["safe"], spaceIds: ["missing"] },
      { kind: "recycle", sourceIds: ["bad/id"] },
      { kind: "recycle", sourceIds: [], spaceIds: ["alpha"] },
    ])
      expect(() => applyBulkSourceAction(data, request as BulkSourceActionRequest, at)).toThrow();
    expect(data).toEqual(before);
    const size = new TextEncoder().encode(JSON.stringify(data)).byteLength;
    data.sources[0].text += "x".repeat(MAX_WORKSPACE_BYTES - size - 2);
    const largeBefore = structuredClone(data);
    expect(new TextEncoder().encode(JSON.stringify(data)).byteLength).toBeLessThanOrEqual(
      MAX_WORKSPACE_BYTES,
    );
    expect(workspaceSchema.safeParse(data)).toMatchObject({ success: true });
    expect(() =>
      applyBulkSourceAction(
        data,
        { kind: "associate", sourceIds: ["safe"], spaceIds: ["alpha", "beta"] },
        at,
      ),
    ).toThrow(/容量/);
    expect(data).toEqual(largeBefore);
  });
  it("accepts a legal 5000-source selection and 500 requested spaces without silently truncating either boundary", () => {
    const data = fixture(),
      base = data.sources[0];
    data.importJobs = [];
    data.sources = Array.from({ length: 5000 }, (_, i) => ({
      ...base,
      id: `source-${i}`,
      versionId: `version-${i}`,
      title: "",
      filename: "",
      text: "",
      chunks: [],
      tags: [],
      mime: "",
      size: 0,
      blobKey: undefined,
      spaceIds: ["alpha"],
    }));
    const all = applyBulkSourceAction(
      data,
      {
        kind: "associate",
        sourceIds: data.sources.map((source) => source.id),
        spaceIds: ["alpha"],
      },
      at,
    );
    expect(all.result.selectedCount).toBe(5000);
    expect(all.result.items).toHaveLength(5000);
    expect(all.result.noopSourceIds).toHaveLength(5000);
    expect(all.data).toBe(data);
    confirmBulkSourceAction(all.data, all.result);
    expect(workspaceSchema.safeParse(data)).toMatchObject({ success: true });
    data.sources = [{ ...base, spaceIds: [] }];
    data.spaces = Array.from({ length: 500 }, (_, i) => ({ ...data.spaces[0], id: `space-${i}` }));
    const many = applyBulkSourceAction(
      data,
      { kind: "associate", sourceIds: [base.id], spaceIds: data.spaces.map((space) => space.id) },
      at,
    );
    expect(many.result.addedAssociations).toBe(500);
    expect(many.data.sources[0].spaceIds).toEqual(data.spaces.map((space) => space.id));
    expect(workspaceSchema.safeParse(many.data)).toMatchObject({ success: true });
    expect(() =>
      applyBulkSourceAction(
        data,
        { kind: "recycle", sourceIds: Array.from({ length: 5001 }, (_, i) => `source-${i}`) },
        at,
      ),
    ).toThrow(/5000/);
    expect(() =>
      applyBulkSourceAction(
        data,
        {
          kind: "associate",
          sourceIds: [base.id],
          spaceIds: Array.from({ length: 501 }, (_, i) => `space-${i}`),
        },
        at,
      ),
    ).toThrow(/500/);
  });
  it("does not treat saving, indexing, failed or cancelled imports as a current active parse lock, and fixed AI tags never lock human actions", () => {
    const data = fixture(),
      base = data.sources[0];
    data.sources = [
      "queued-saving",
      "running-saving",
      "indexing",
      "failed",
      "cancelled",
      "completed",
    ].map((id) => ({
      ...base,
      id,
      versionId: `${id}-current`,
      chunks: base.chunks.map((chunk, i) => ({
        ...chunk,
        id: `${id}-chunk-${i}`,
        sourceId: id,
        versionId: `${id}-current`,
      })),
      tagsLocked: true,
      aiAllowed: false,
    }));
    data.aiEnabled = false;
    data.importJobs = data.sources.map((source, i) => {
      const queued = createImportJob({
          sourceId: source.id,
          versionId: source.versionId,
          filename: source.filename,
          spaceId: "",
          at,
        }),
        saving = startImportJob(queued, at),
        parsing = advanceImportJob(saving, "parsing", at),
        indexing = advanceImportJob(parsing, "indexing", at);
      return i === 0
        ? queued
        : i === 1
          ? saving
          : i === 2
            ? indexing
            : i === 3
              ? failImportJob(parsing, "解析失败", at)
              : i === 4
                ? cancelImportJob(parsing, at)
                : completeImportJob(indexing, at);
    });
    expect(workspaceSchema.safeParse(data)).toMatchObject({ success: true });
    for (const kind of ["associate", "recycle"] as const) {
      const applied = applyBulkSourceAction(
        data,
        kind === "associate"
          ? { kind, sourceIds: data.sources.map((source) => source.id), spaceIds: ["alpha"] }
          : { kind, sourceIds: data.sources.map((source) => source.id) },
        later,
      );
      expect(applied.result.acceptedSourceIds).toEqual(data.sources.map((source) => source.id));
      expect(applied.result.failedSourceIds).toEqual([]);
      expect(workspaceSchema.safeParse(applied.data)).toMatchObject({ success: true });
    }
  });
  it("retains old successes and newly accepted failed retries through a second failed-disk snapshot without replay or losing cumulative handoff identities", () => {
    const first = applyBulkSourceAction(
      fixture(),
      { kind: "associate", sourceIds: ["safe", "parsing", "missing"], spaceIds: ["alpha", "beta"] },
      at,
    );
    confirmBulkSourceAction(first.data, first.result);
    const current = {
      ...first.data,
      sources: first.data.sources.map((source) =>
        source.id === "parsing" ? { ...source, status: "ready" as const } : source,
      ),
    };
    const retried = retryBulkSourceAction(current, first.result, later);
    expect(retried.result.addedSourceIds).toEqual(["safe", "parsing"]);
    expect(retried.result.addedAssociations).toBe(4);
    expect(retried.result.failedSourceIds).toEqual(["missing"]);
    const latest = {
        ...retried.data,
        aiEnabled: false,
        sources: retried.data.sources.map((source) => ({ ...source, tags: ["用户后续编辑"] })),
      },
      snapshot = snapshotRetryBulkSourceAction(latest, retried.result);
    expect(snapshot.data.sources).toBe(latest.sources);
    expect(snapshot.data.aiEnabled).toBe(false);
    expect(snapshot.result).toBe(retried.result);
    expect(snapshot.result.items[0].at).toBe(at);
    expect(snapshot.result.items[1].at).toBe(later);
    expect(snapshot.result.addedAssociations).toBe(4);
    confirmBulkSourceAction(snapshot.data, snapshot.result);
    const failedStill = retryBulkSourceAction(snapshot.data, snapshot.result, later);
    expect(failedStill.data).toBe(snapshot.data);
    expect(failedStill.result.addedSourceIds).toEqual(["safe", "parsing"]);
    expect(failedStill.result.failedSourceIds).toEqual(["missing"]);
  });
  it("keeps immutable retry requests and prior rows, and can accept a previously failed source's current version after explicit retry", () => {
    const data = fixture(),
      request = { kind: "associate" as const, sourceIds: ["safe", "parsing"], spaceIds: ["alpha"] },
      first = applyBulkSourceAction(data, request, at);
    confirmBulkSourceAction(first.data, first.result);
    request.sourceIds.push("deleted");
    request.spaceIds.push("beta");
    expect(first.result.request.sourceIds).toEqual(["safe", "parsing"]);
    expect(first.result.request).toMatchObject({ spaceIds: ["alpha"] });
    expect(Object.isFrozen(first.result.items[0].addedSpaceIds)).toBe(true);
    expect(() => first.result.items[0].addedSpaceIds.push("beta")).toThrow();
    const current = {
        ...first.data,
        sources: first.data.sources.map((source) =>
          source.id === "parsing"
            ? {
                ...source,
                versionId: "replacement",
                status: "ready" as const,
                chunks: source.chunks.map((chunk) => ({ ...chunk, versionId: "replacement" })),
              }
            : source,
        ),
      },
      next = retryBulkSourceAction(current, first.result, later);
    expect(next.result.items[1]).toMatchObject({
      sourceId: "parsing",
      versionId: "replacement",
      status: "accepted",
    });
    expect(next.result.items[0]).toEqual(first.result.items[0]);
    expect(next.data.sources[0]).toBe(current.sources[0]);
    confirmBulkSourceAction(next.data, next.result);
  });
  it("atomically rejects an oversized failed-only retry and refuses to re-save an oversized provisional snapshot while keeping historical success receipts intact", () => {
    const first = applyBulkSourceAction(
      fixture(),
      { kind: "associate", sourceIds: ["safe", "parsing"], spaceIds: ["alpha"] },
      at,
    );
    confirmBulkSourceAction(first.data, first.result);
    const current = {
        ...first.data,
        sources: first.data.sources.map((source) =>
          source.id === "parsing" ? { ...source, status: "ready" as const } : { ...source },
        ),
      },
      size = new TextEncoder().encode(JSON.stringify(current)).byteLength;
    current.sources[0].text += "x".repeat(MAX_WORKSPACE_BYTES - size - 2);
    const before = structuredClone(current),
      receiptBefore = structuredClone(first.result);
    expect(workspaceSchema.safeParse(current)).toMatchObject({ success: true });
    expect(() => retryBulkSourceAction(current, first.result, later)).toThrow(/容量/);
    expect(current).toEqual(before);
    expect(first.result).toEqual(receiptBefore);
    const pending = applyBulkSourceAction(fixture(), { kind: "recycle", sourceIds: ["safe"] }, at),
      tooLarge = {
        ...pending.data,
        sources: pending.data.sources.map((source) => ({ ...source })),
      },
      bytes = new TextEncoder().encode(JSON.stringify(tooLarge)).byteLength;
    tooLarge.sources[0].text += "x".repeat(MAX_WORKSPACE_BYTES - bytes + 1);
    expect(() => snapshotRetryBulkSourceAction(tooLarge, pending.result)).toThrow(/容量/);
    expect(pending.result.recycledSourceIds).toEqual(["safe"]);
    expect(confirmBulkSourceAction(pending.data, pending.result)).toBe(pending.result);
  });
});
