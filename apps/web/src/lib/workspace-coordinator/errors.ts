import type { WorkspaceData } from "../types";
import { MAX_WORKSPACE_BYTES } from "../supabase/validation";

export class OriginalSyncError extends Error {}
export class BackupRestoreContextError extends Error {}
export class PurgeLocalPersistenceError extends Error {}

export function conflictRecordId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}:${uuid || `${Date.now()}:${Math.random().toString(36).slice(2)}`}`;
}

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : "保存失败，请重试。";
}

export function exceedsCloudWorkspaceCapacity(data: WorkspaceData): boolean {
  return new TextEncoder().encode(JSON.stringify(data)).byteLength > MAX_WORKSPACE_BYTES;
}

export function conflictError(cause: unknown): boolean {
  if (cause instanceof OriginalSyncError) return false;
  if (cause && typeof cause === "object" && "status" in cause && cause.status === 409) return true;
  return /409|conflict|冲突|版本/i.test(errorText(cause));
}

/**
 * A response that explicitly rejects the write before it can commit does not
 * need an immediate read-back. Transport failures, server failures and an
 * invalid success body can all hide a committed transaction, so they do.
 */
export function workspaceSaveNeedsReadBack(cause: unknown): boolean {
  if (cause instanceof OriginalSyncError) return false;
  if (!cause || typeof cause !== "object") return !conflictError(cause);
  const status = "status" in cause && typeof cause.status === "number" ? cause.status : null;
  const code = "code" in cause && typeof cause.code === "string" ? cause.code : "";
  if (status === 409 || code === "REVISION_CONFLICT" || code === "40001" || code === "PT409")
    return false;
  if (code === "WORKSPACE_BUSY") return false;
  if (status === null && !code) return !conflictError(cause);
  return status === null || status === 0 || status >= 500;
}
