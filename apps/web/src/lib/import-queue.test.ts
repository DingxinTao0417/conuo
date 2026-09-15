import { describe, expect, it } from "vitest";
import {
  advanceImportJob,
  cancelImportJob,
  cancelImportJobsForRecycledSources,
  completeImportJob,
  createImportJob,
  failImportJob,
  importJobId,
  importJobsForSource,
  replaceImportJob,
  resumeImportJob,
  retryImportJob,
  startImportJob,
} from "./import-queue";
import type { Source, WorkspaceData } from "./types";

const timestamps = {
  created: "2026-09-13T08:00:00.000Z",
  started: "2026-09-13T08:00:01.000Z",
  saved: "2026-09-13T08:00:02.000Z",
  parsed: "2026-09-13T08:00:03.000Z",
  ended: "2026-09-13T08:00:04.000Z",
  retry: "2026-09-13T08:00:05.000Z",
  restarted: "2026-09-13T08:00:06.000Z",
} as const;

function created(sourceId = "source-a", versionId = "version-a") {
  return createImportJob({
    sourceId,
    versionId,
    filename: "学习率.pdf",
    spaceId: "space-a",
    at: timestamps.created,
  });
}

function indexed() {
  return advanceImportJob(
    advanceImportJob(startImportJob(created(), timestamps.started), "parsing", timestamps.saved),
    "indexing",
    timestamps.parsed,
  );
}

function source(id: string, versionId: string, patch: Partial<Source> = {}): Source {
  return {
    id,
    versionId,
    title: `${id} 标题`,
    filename: `${id}.txt`,
    kind: "text",
    mime: "text/plain",
    size: 12,
    hash: `${id}-hash`,
    spaceIds: [],
    tags: [],
    status: "parsing",
    text: "未完成的解析内容",
    chunks: [],
    createdAt: timestamps.created,
    updatedAt: timestamps.started,
    deletedAt: null,
    aiAllowed: true,
    starred: false,
    ...patch,
  };
}

describe("persistent import job lifecycle", () => {
  it("derives an unambiguous stable ID and creates a queued saving job", () => {
    const job = created("source-a-b", "version-c");
    const same = created("source-a-b", "version-c");
    const differentTuple = created("source-a", "b-version-c");

    expect(job).toMatchObject({
      id: "import-10-source-a-b-version-c",
      sourceId: "source-a-b",
      versionId: "version-c",
      spaceId: "space-a",
      stage: "saving",
      status: "queued",
      originalSaved: false,
      attempt: 0,
      createdAt: timestamps.created,
      updatedAt: timestamps.created,
    });
    expect(same.id).toBe(job.id);
    expect(differentTuple.id).not.toBe(job.id);
    expect(importJobId("source-a-b", "version-c")).toBe(job.id);
  });

  it("moves only forward through saving, parsing, indexing, then completion", () => {
    const queued = created();
    const running = startImportJob(queued, timestamps.started);
    const parsing = advanceImportJob(running, "parsing", timestamps.saved);
    const indexing = advanceImportJob(parsing, "indexing", timestamps.parsed);
    const complete = completeImportJob(indexing, timestamps.ended);

    expect(queued).toMatchObject({ status: "queued", stage: "saving", attempt: 0 });
    expect(running).toMatchObject({ status: "running", stage: "saving", attempt: 1 });
    expect(parsing).toMatchObject({
      status: "running",
      stage: "parsing",
      originalSaved: true,
    });
    expect(indexing).toMatchObject({ status: "running", stage: "indexing" });
    expect(complete).toMatchObject({
      status: "completed",
      originalSaved: true,
      completedAt: timestamps.ended,
    });
    expect(() => advanceImportJob(running, "indexing", timestamps.parsed)).toThrow(/顺序/);
    expect(() => completeImportJob(parsing, timestamps.ended)).toThrow(/尚未完成/);
  });

  it("retries an exact failed parsing job without making another identity", () => {
    const running = startImportJob(created(), timestamps.started);
    const parsing = advanceImportJob(running, "parsing", timestamps.saved);
    const failed = failImportJob(parsing, "PDF 文字层损坏", timestamps.ended);
    const retried = retryImportJob(failed, timestamps.retry);
    const restarted = startImportJob(retried, timestamps.restarted);

    expect(failed).toMatchObject({
      status: "failed",
      stage: "parsing",
      originalSaved: true,
      attempt: 1,
      error: "PDF 文字层损坏",
    });
    expect(retried).toMatchObject({
      id: failed.id,
      sourceId: failed.sourceId,
      versionId: failed.versionId,
      status: "queued",
      stage: "parsing",
      originalSaved: true,
      attempt: 1,
    });
    expect(retried.error).toBeUndefined();
    expect(restarted).toMatchObject({ status: "running", attempt: 2, stage: "parsing" });
  });

  it("preserves a saved original on cancellation and rejects late completion", () => {
    const running = startImportJob(created(), timestamps.started);
    const parsing = advanceImportJob(running, "parsing", timestamps.saved);
    const cancelled = cancelImportJob(parsing, timestamps.ended);
    const duplicateCancel = cancelImportJob(cancelled, timestamps.retry);
    const retried = retryImportJob(cancelled, timestamps.retry);

    expect(cancelled).toMatchObject({
      status: "cancelled",
      stage: "parsing",
      originalSaved: true,
      cancelledAt: timestamps.ended,
    });
    expect(duplicateCancel).toEqual(cancelled);
    expect(retried).toMatchObject({
      id: cancelled.id,
      status: "queued",
      stage: "parsing",
      originalSaved: true,
    });
    expect(retried.cancelledAt).toBeUndefined();
    expect(() => completeImportJob(cancelled, timestamps.retry)).toThrow(/只有运行中的/);
    expect(() => failImportJob(cancelled, "迟到错误", timestamps.retry)).toThrow(/只有运行中的/);
  });

  it("requeues interrupted parsing without changing its source/version identity", () => {
    const running = advanceImportJob(
      startImportJob(created(), timestamps.started),
      "parsing",
      timestamps.saved,
    );
    const resumed = resumeImportJob(running, timestamps.retry);
    expect(resumed).toMatchObject({
      id: running.id,
      sourceId: running.sourceId,
      versionId: running.versionId,
      status: "queued",
      stage: "parsing",
      originalSaved: true,
    });
  });

  it("filters exact source/version entries without exposing mutable queue entries", () => {
    const current = created("source-a", "version-a");
    const historical = created("source-a", "version-old");
    const other = created("source-b", "version-a");
    const jobs = [current, historical, other];

    const sourceJobs = importJobsForSource(jobs, "source-a");
    const versionJobs = importJobsForSource(jobs, "source-a", "version-a");
    sourceJobs[0].filename = "外部改写.pdf";

    expect(sourceJobs.map((job) => job.versionId)).toEqual(["version-a", "version-old"]);
    expect(versionJobs.map((job) => job.id)).toEqual([current.id]);
    expect(jobs[0].filename).toBe("学习率.pdf");
  });

  it("replaces one queue entry safely and rejects duplicate or terminal retries", () => {
    const current = created();
    const started = startImportJob(current, timestamps.started);
    const jobs = replaceImportJob([current], started);
    const completed = completeImportJob(indexed(), timestamps.ended);

    expect(jobs).toEqual([started]);
    expect(jobs[0]).not.toBe(started);
    expect(() => retryImportJob(completed, timestamps.retry)).toThrow(/失败或已取消/);
    expect(() => startImportJob(started, timestamps.retry)).toThrow(/排队中/);
    expect(() =>
      replaceImportJob([current, { ...current }], startImportJob(current, timestamps.started)),
    ).toThrow(/重复/);
  });

  it("cancels pending imports for recycled current and retained versions without losing originals", () => {
    const current = advanceImportJob(
      startImportJob(created("recycled", "current"), timestamps.started),
      "parsing",
      timestamps.saved,
    );
    const historical = advanceImportJob(
      startImportJob(created("recycled", "previous"), timestamps.started),
      "parsing",
      timestamps.saved,
    );
    const readyCurrentHistoricalJob = advanceImportJob(
      startImportJob(created("ready-current", "previous"), timestamps.started),
      "parsing",
      timestamps.saved,
    );
    const shared = advanceImportJob(
      startImportJob(created("shared", "current"), timestamps.started),
      "parsing",
      timestamps.saved,
    );
    const completed = completeImportJob(
      advanceImportJob(shared, "indexing", timestamps.parsed),
      timestamps.ended,
    );
    const otherRunning = advanceImportJob(
      startImportJob(created("not-recycled", "current"), timestamps.started),
      "parsing",
      timestamps.saved,
    );
    const currentVersions = [
      {
        versionId: "previous",
        title: "recycled 历史版本",
        filename: "recycled-previous.txt",
        kind: "text" as const,
        mime: "text/plain",
        size: 8,
        hash: "recycled-previous-hash",
        status: "saved" as const,
        text: "",
        chunks: [],
        blobKey: "originals/recycled/previous",
        storagePath: "account/originals/recycled/previous",
        createdAt: timestamps.created,
        archivedAt: timestamps.started,
      },
    ];
    const before: WorkspaceData = {
      schemaVersion: 1,
      spaces: [],
      sources: [
        source("recycled", "current", {
          deletedAt: timestamps.ended,
          blobKey: "originals/recycled/current",
          storagePath: "account/originals/recycled/current",
          coverage: {
            captureScope: "full",
            parseState: "pending",
            unavailablePageRanges: [{ start: 3, end: 5 }],
          },
          versions: currentVersions,
        }),
        source("ready-current", "current", {
          deletedAt: timestamps.ended,
          status: "ready",
          text: "已完成的新版本内容",
          chunks: [],
          versions: [
            {
              ...currentVersions[0],
              versionId: "previous",
              blobKey: "originals/ready-current/previous",
              storagePath: "account/originals/ready-current/previous",
            },
          ],
        }),
        source("shared", "current", { status: "ready", text: "共享资料" }),
        source("not-recycled", "current"),
      ],
      notes: [],
      annotations: [],
      conversations: [],
      aiEnabled: true,
      importJobs: [current, historical, readyCurrentHistoricalJob, completed, otherRunning],
    };

    const after = cancelImportJobsForRecycledSources(before, timestamps.ended);

    expect(after.importJobs?.map((job) => [job.id, job.status])).toEqual([
      [current.id, "cancelled"],
      [historical.id, "cancelled"],
      [readyCurrentHistoricalJob.id, "cancelled"],
      [completed.id, "completed"],
      [otherRunning.id, "running"],
    ]);
    expect(after.sources[0]).toMatchObject({
      status: "saved",
      text: "",
      error: "解析已因资料移入回收站而停止。恢复后可重新解析。",
      blobKey: "originals/recycled/current",
      storagePath: "account/originals/recycled/current",
      versions: currentVersions,
    });
    expect(after.sources[0].coverage).toEqual({ captureScope: "full", parseState: "pending" });
    expect(after.sources[1]).toMatchObject({
      status: "ready",
      text: "已完成的新版本内容",
    });
    expect(before.importJobs?.slice(0, 3).every((job) => job.status === "running")).toBe(true);
    expect(before.sources[0].status).toBe("parsing");
  });
});
