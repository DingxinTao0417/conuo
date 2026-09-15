import { describe, expect, it } from "vitest";
import {
  LOCAL_IMPORT_QUOTA_POLICY,
  MEBIBYTE,
  assessImportQuota,
  formatImportQuotaBytes,
  validateImportQuotaPolicy,
  workspaceImportStorageBreakdown,
  workspaceImportStorageUsage,
  type ImportFileMetadata,
  type ImportQuotaPolicy,
} from "./import-quota";
import type { Source, SourceVersion, WorkspaceData } from "./types";

const now = "2026-09-13T08:00:00.000Z";

function historical(versionId: string, size: number, originalMissing = false): SourceVersion {
  return {
    versionId,
    title: versionId,
    filename: `${versionId}.pdf`,
    kind: "pdf",
    mime: "application/pdf",
    size,
    hash: `${versionId}-hash`,
    status: "ready",
    text: "正文",
    chunks: [],
    originalMissing,
    createdAt: now,
    archivedAt: now,
  };
}

function source(id: string, size: number, patch: Partial<Source> = {}): Source {
  return {
    id,
    versionId: `${id}-current`,
    title: id,
    filename: `${id}.pdf`,
    kind: "pdf",
    mime: "application/pdf",
    size,
    hash: `${id}-hash`,
    spaceIds: [],
    tags: [],
    status: "ready",
    text: "正文",
    chunks: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    aiAllowed: true,
    starred: false,
    ...patch,
  };
}

function workspace(sources: Source[]): Pick<WorkspaceData, "sources"> {
  return { sources };
}

const smallPolicy: ImportQuotaPolicy = {
  maxFileBytes: 30,
  maxBatchFiles: 2,
  maxBatchBytes: 25,
  maxAccountBytes: 75,
};

describe("local import quota", () => {
  it("defines conservative, explicit browser limits", () => {
    expect(LOCAL_IMPORT_QUOTA_POLICY).toEqual({
      maxFileBytes: 30 * MEBIBYTE,
      maxBatchFiles: 20,
      maxBatchBytes: 150 * MEBIBYTE,
      maxAccountBytes: 512 * MEBIBYTE,
    });
    expect(formatImportQuotaBytes(30 * MEBIBYTE)).toBe("30 MiB");
  });

  it("counts retained current and historical originals, including recycle-bin items", () => {
    const data = workspace([
      source("active", 10, {
        versions: [historical("active-old", 5), historical("active-missing", 99, true)],
      }),
      source("recycled", 7, {
        deletedAt: now,
        versions: [historical("recycled-old", 3)],
      }),
    ]);
    const usage = workspaceImportStorageUsage(data);

    expect(usage).toEqual({ bytes: 25, originals: 4 });
    expect(workspaceImportStorageBreakdown(data)).toEqual({
      current: { bytes: 10, originals: 1 },
      history: { bytes: 5, originals: 1 },
      recycleBin: { bytes: 10, originals: 2 },
      total: { bytes: 25, originals: 4 },
    });
  });

  it("admits files in selection order and preserves later capacity after a rejection", () => {
    const result = assessImportQuota(
      workspace([source("existing", 40)]),
      [
        { name: "first.pdf", size: 20 },
        { name: "too-much.pdf", size: 20 },
        { name: "later-valid.pdf", size: 5 },
        { name: "over-count.pdf", size: 1 },
      ],
      smallPolicy,
    );

    expect(result.items.map((item) => item.accepted)).toEqual([true, false, true, false]);
    expect(result.items[1]).toMatchObject({
      rejections: expect.arrayContaining([
        expect.objectContaining({ code: "batch-byte-limit" }),
        expect.objectContaining({ code: "account-storage-limit" }),
      ]),
    });
    expect(result.items[3]).toMatchObject({
      rejections: expect.arrayContaining([
        expect.objectContaining({ code: "batch-file-limit" }),
        expect.objectContaining({ code: "batch-byte-limit" }),
      ]),
    });
    expect(result.usage).toMatchObject({
      bytes: 40,
      requestedFiles: 4,
      requestedBytes: 46,
      acceptedFiles: 2,
      acceptedBytes: 25,
      rejectedFiles: 2,
      projectedAccountBytes: 65,
      projectedAccountRemainingBytes: 10,
    });
  });

  it("does not let malformed metadata reserve quota needed by a valid file", () => {
    const malformed = { name: "  ", size: -1 } as ImportFileMetadata;
    const result = assessImportQuota(
      workspace([]),
      [malformed, { name: "valid.pdf", size: 10 }],
      smallPolicy,
    );

    expect(result.items[0]).toMatchObject({
      accepted: false,
      rejections: [{ code: "invalid-file-metadata" }],
    });
    expect(result.items[1]).toMatchObject({ accepted: true });
    expect(result.usage).toMatchObject({ requestedBytes: 10, acceptedBytes: 10 });
  });

  it("reports the account-capacity boundary before admitting an overage", () => {
    const result = assessImportQuota(
      workspace([source("existing", 35)]),
      [
        { name: "fits.pdf", size: 5 },
        { name: "overage.pdf", size: 1 },
      ],
      { ...smallPolicy, maxBatchFiles: 3, maxBatchBytes: 30, maxAccountBytes: 40 },
    );

    expect(result.items.map((item) => item.accepted)).toEqual([true, false]);
    expect(result.items[1]).toMatchObject({
      rejections: [expect.objectContaining({ code: "account-storage-limit" })],
    });
    expect(result.usage).toMatchObject({
      accountRemainingBytes: 5,
      projectedAccountBytes: 40,
      projectedAccountRemainingBytes: 0,
    });
  });

  it("can defer only the account-capacity decision until duplicate detection", () => {
    const result = assessImportQuota(
      workspace([source("existing", 40)]),
      [{ name: "possibly-duplicate.pdf", size: 1 }],
      { ...smallPolicy, maxAccountBytes: 40 },
      { deferAccountStorageLimit: true },
    );

    expect(result.accountStorageLimitDeferred).toBe(true);
    expect(result.items).toEqual([expect.objectContaining({ index: 0, accepted: true })]);
    expect(result.usage).toMatchObject({
      acceptedFiles: 1,
      acceptedBytes: 1,
      projectedAccountBytes: 41,
      projectedAccountRemainingBytes: 0,
    });
  });

  it("rejects invalid reusable policies before evaluating files", () => {
    expect(() => validateImportQuotaPolicy({ ...smallPolicy, maxBatchFiles: 0 })).toThrow(
      /maxBatchFiles/,
    );
  });
});
