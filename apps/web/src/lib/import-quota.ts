import type { Source, WorkspaceData } from "./types";

/** Binary megabytes keep the UI limit aligned with the existing file importer. */
export const MEBIBYTE = 1024 * 1024;

export interface ImportQuotaPolicy {
  /** Maximum size of one selected local original. */
  maxFileBytes: number;
  /** Number of files that may be admitted from one selection. */
  maxBatchFiles: number;
  /** Total bytes admitted from one selection. */
  maxBatchBytes: number;
  /** Retained current and historical original bytes for one local account. */
  maxAccountBytes: number;
}

/**
 * Conservative browser-mode limits. They are a logical admission policy, not a
 * promise that a browser's IndexedDB quota is available; persistence still has
 * to report its own storage failures.
 */
export const LOCAL_IMPORT_QUOTA_POLICY: Readonly<ImportQuotaPolicy> = Object.freeze({
  maxFileBytes: 30 * MEBIBYTE,
  maxBatchFiles: 20,
  maxBatchBytes: 150 * MEBIBYTE,
  maxAccountBytes: 512 * MEBIBYTE,
});

/** `File` satisfies this shape, so UI code need not convert browser files first. */
export interface ImportFileMetadata {
  name: string;
  size: number;
}

export type ImportQuotaRejectionCode =
  | "invalid-file-metadata"
  | "file-too-large"
  | "batch-file-limit"
  | "batch-byte-limit"
  | "account-storage-limit";

export interface ImportQuotaRejection {
  code: ImportQuotaRejectionCode;
  message: string;
}

export interface WorkspaceImportStorageUsage {
  /** Original bytes currently retained by this account, including the recycle bin and history. */
  bytes: number;
  /** Current or historical originals that contribute bytes. */
  originals: number;
}

export interface WorkspaceImportStorageBreakdown {
  /** Current originals belonging to sources outside the recycle bin. */
  current: WorkspaceImportStorageUsage;
  /** Historical originals belonging to sources outside the recycle bin. */
  history: WorkspaceImportStorageUsage;
  /** Current and historical originals retained for recoverable sources. */
  recycleBin: WorkspaceImportStorageUsage;
  /** Every retained original counted by the local admission policy. */
  total: WorkspaceImportStorageUsage;
}

export interface ImportQuotaUsage extends WorkspaceImportStorageUsage {
  accountLimitBytes: number;
  accountRemainingBytes: number;
  batchFileLimit: number;
  batchByteLimit: number;
  requestedFiles: number;
  requestedBytes: number;
  acceptedFiles: number;
  acceptedBytes: number;
  rejectedFiles: number;
  projectedAccountBytes: number;
  projectedAccountRemainingBytes: number;
}

export interface AcceptedImportQuotaItem {
  index: number;
  file: ImportFileMetadata;
  accepted: true;
}

export interface RejectedImportQuotaItem {
  index: number;
  file: ImportFileMetadata;
  accepted: false;
  rejections: ImportQuotaRejection[];
}

export type ImportQuotaItem = AcceptedImportQuotaItem | RejectedImportQuotaItem;

export interface ImportQuotaAssessment {
  items: ImportQuotaItem[];
  usage: ImportQuotaUsage;
  /**
   * True when account storage is intentionally left for the import coordinator
   * to decide after it knows the file hash. A normal duplicate reuses its
   * existing original and therefore does not need to reserve new bytes.
   */
  accountStorageLimitDeferred: boolean;
}

export interface ImportQuotaAssessmentOptions {
  /**
   * Skip only the account-wide original-file check. File and batch limits still
   * apply. Use this for a normal pick before its SHA-256 identity is known;
   * the coordinator must enforce the account cap after duplicate detection.
   */
  deferAccountStorageLimit?: boolean;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function checkedPositiveInteger(value: unknown, field: keyof ImportQuotaPolicy): number {
  if (!isNonNegativeSafeInteger(value) || value < 1)
    throw new TypeError(`${field} 必须是大于 0 的安全整数。`);
  return value;
}

/** Returns a detached, validated policy so callers cannot mutate a shared default. */
export function validateImportQuotaPolicy(policy: ImportQuotaPolicy): ImportQuotaPolicy {
  if (!policy || typeof policy !== "object") throw new TypeError("导入额度策略无效。");
  return {
    maxFileBytes: checkedPositiveInteger(policy.maxFileBytes, "maxFileBytes"),
    maxBatchFiles: checkedPositiveInteger(policy.maxBatchFiles, "maxBatchFiles"),
    maxBatchBytes: checkedPositiveInteger(policy.maxBatchBytes, "maxBatchBytes"),
    maxAccountBytes: checkedPositiveInteger(policy.maxAccountBytes, "maxAccountBytes"),
  };
}

function addBytes(total: number, value: number): number {
  return total > Number.MAX_SAFE_INTEGER - value ? Number.MAX_SAFE_INTEGER : total + value;
}

function retainedOriginalBytes(value: Pick<Source, "size" | "originalMissing">): number {
  return value.originalMissing || !isNonNegativeSafeInteger(value.size) ? 0 : value.size;
}

function addRetainedOriginal(
  bucket: WorkspaceImportStorageUsage,
  value: Pick<Source, "size" | "originalMissing">,
) {
  const retainedBytes = retainedOriginalBytes(value);
  if (!retainedBytes) return;
  bucket.bytes = addBytes(bucket.bytes, retainedBytes);
  bucket.originals++;
}

/**
 * Separates the locally enforced original-file budget into mutually exclusive
 * groups. Versions of a recycled source stay in the recycle-bin group because
 * restoring that source brings the whole retained history back together.
 */
export function workspaceImportStorageBreakdown(
  data: Pick<WorkspaceData, "sources">,
): WorkspaceImportStorageBreakdown {
  const current: WorkspaceImportStorageUsage = { bytes: 0, originals: 0 };
  const history: WorkspaceImportStorageUsage = { bytes: 0, originals: 0 };
  const recycleBin: WorkspaceImportStorageUsage = { bytes: 0, originals: 0 };

  for (const source of data.sources) {
    if (source.deletedAt) {
      addRetainedOriginal(recycleBin, source);
      for (const version of source.versions || []) addRetainedOriginal(recycleBin, version);
      continue;
    }

    addRetainedOriginal(current, source);
    for (const version of source.versions || []) addRetainedOriginal(history, version);
  }

  const total = {
    bytes: addBytes(addBytes(current.bytes, history.bytes), recycleBin.bytes),
    originals: current.originals + history.originals + recycleBin.originals,
  };
  return { current, history, recycleBin, total };
}

/**
 * Counts every retained source version, including recoverable sources in the
 * recycle bin. A restored record that explicitly lacks its original bytes does
 * not consume the original-file budget.
 */
export function workspaceImportStorageUsage(
  data: Pick<WorkspaceData, "sources">,
): WorkspaceImportStorageUsage {
  return workspaceImportStorageBreakdown(data).total;
}

/** Formats a validated byte count for a human-readable quota message. */
export function formatImportQuotaBytes(bytes: number): string {
  if (!isNonNegativeSafeInteger(bytes)) return "无效容量";
  if (bytes >= MEBIBYTE) {
    const value = bytes / MEBIBYTE;
    return `${Number.isInteger(value) ? value : value.toFixed(1)} MiB`;
  }
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function validMetadata(file: ImportFileMetadata): boolean {
  return (
    !!file &&
    typeof file.name === "string" &&
    file.name.trim().length > 0 &&
    isNonNegativeSafeInteger(file.size)
  );
}

function exceeds(total: number, next: number, limit: number): boolean {
  return total > limit - next;
}

/**
 * Evaluates a selection in its original order. Only admitted files reserve
 * batch capacity, so an invalid or rejected selection cannot block later valid
 * files. Callers can display every item result without mutating workspace data.
 */
export function assessImportQuota(
  data: Pick<WorkspaceData, "sources">,
  files: readonly ImportFileMetadata[],
  policy: ImportQuotaPolicy = LOCAL_IMPORT_QUOTA_POLICY,
  options: ImportQuotaAssessmentOptions = {},
): ImportQuotaAssessment {
  const limits = validateImportQuotaPolicy(policy);
  const accountStorageLimitDeferred = !!options.deferAccountStorageLimit;
  const stored = workspaceImportStorageUsage(data);
  const items: ImportQuotaItem[] = [];
  let requestedBytes = 0;
  let acceptedFiles = 0;
  let acceptedBytes = 0;

  files.forEach((file, index) => {
    const rejections: ImportQuotaRejection[] = [];
    if (!validMetadata(file)) {
      rejections.push({
        code: "invalid-file-metadata",
        message: "文件名称不能为空，文件大小必须是非负安全整数。",
      });
    } else {
      requestedBytes = addBytes(requestedBytes, file.size);
      if (file.size > limits.maxFileBytes)
        rejections.push({
          code: "file-too-large",
          message: `单个文件超过 ${formatImportQuotaBytes(limits.maxFileBytes)} 本机上限。`,
        });
      if (acceptedFiles >= limits.maxBatchFiles)
        rejections.push({
          code: "batch-file-limit",
          message: `本批最多可导入 ${limits.maxBatchFiles} 个文件。`,
        });
      if (exceeds(acceptedBytes, file.size, limits.maxBatchBytes))
        rejections.push({
          code: "batch-byte-limit",
          message: `本批累计原件超过 ${formatImportQuotaBytes(limits.maxBatchBytes)} 上限。`,
        });
      if (
        !accountStorageLimitDeferred &&
        exceeds(addBytes(stored.bytes, acceptedBytes), file.size, limits.maxAccountBytes)
      )
        rejections.push({
          code: "account-storage-limit",
          message: `账号保留原件超过 ${formatImportQuotaBytes(limits.maxAccountBytes)} 本机上限。`,
        });
    }

    if (rejections.length) {
      items.push({ index, file, accepted: false, rejections });
      return;
    }
    acceptedFiles++;
    acceptedBytes = addBytes(acceptedBytes, file.size);
    items.push({ index, file, accepted: true });
  });

  const projectedAccountBytes = addBytes(stored.bytes, acceptedBytes);
  const accountRemainingBytes = Math.max(0, limits.maxAccountBytes - stored.bytes);
  return {
    items,
    accountStorageLimitDeferred,
    usage: {
      ...stored,
      accountLimitBytes: limits.maxAccountBytes,
      accountRemainingBytes,
      batchFileLimit: limits.maxBatchFiles,
      batchByteLimit: limits.maxBatchBytes,
      requestedFiles: files.length,
      requestedBytes,
      acceptedFiles,
      acceptedBytes,
      rejectedFiles: files.length - acceptedFiles,
      projectedAccountBytes,
      projectedAccountRemainingBytes: Math.max(0, limits.maxAccountBytes - projectedAccountBytes),
    },
  };
}
