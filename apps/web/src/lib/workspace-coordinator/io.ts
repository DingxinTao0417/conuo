import { subscribeConfirmedAccountDeletions } from "../account-deletion-observer";
import * as cloud from "../cloud";
import {
  askCloud,
  cancelImportParse,
  cancelOrganizationJob as cancelOrganizationJobCloud,
  claimImportParse,
  downloadSourceBlob,
  enqueueOrganizationJob as enqueueOrganizationJobCloud,
  finishImportParse,
  getModelStatus,
  heartbeatImportParse,
  loadCloudWorkspace,
  loadCloudWorkspaceRevision,
  organizeCloud,
  previewSourcePurge as previewSourcePurgeCloud,
  previewSourceVersionPurge as previewSourceVersionPurgeCloud,
  reconcileOrganizationJobs as reconcileOrganizationJobsCloud,
  releaseImportParse,
  requestSourcePurge as requestSourcePurgeCloud,
  requestSourceVersionPurge as requestSourceVersionPurgeCloud,
  retryImportParse,
  saveCloudWorkspace,
  uploadSourceBlob,
} from "../cloud";
import { parseImportSource, prepareImportFile } from "../import";
import {
  clearAccountLocalCache,
  commitLocalImport,
  deleteUnreferencedBlob,
  getBlob,
  isAccountLocallyDeleted,
  loadLocalWorkspaceRecord,
  markAccountLocalDeletion,
  putBlobIfAbsent,
  saveLocalWorkspace,
  shareAnonymousOriginals,
  subscribeLocalAccountDeletions,
  subscribeLocalWorkspaceCommits,
} from "../local-store";
import { workspaceSchema } from "../supabase/validation";
import type { WorkspaceData } from "../types";
import { webSessionStore } from "../web-session-store";
import type { ImportPipeline, StoredWorkspace, SyncMeta, User, WorkspaceIO } from "./types";

// A few focused tests provide a deliberately small cloud mock from the
// pre-membership contract. Avoid touching the optional export on those mocks;
// production's real module always provides it.
const accountMembershipReader = Object.prototype.hasOwnProperty.call(cloud, "getAccountMembership")
  ? cloud.getAccountMembership
  : undefined;

export const defaultImportPipeline: ImportPipeline = {
  prepare: prepareImportFile,
  parse: parseImportSource,
};

export function parseSyncMeta(value: unknown): SyncMeta | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("revision" in value) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    !("dirty" in value) ||
    typeof value.dirty !== "boolean"
  )
    return null;

  const revision = Number(value.revision);
  const meta: SyncMeta = { revision, dirty: value.dirty };
  if (
    value.dirty &&
    "baseRevision" in value &&
    value.baseRevision === revision &&
    "base" in value
  ) {
    const parsed = workspaceSchema.safeParse(value.base);
    if (parsed.success) {
      meta.baseRevision = revision;
      meta.base = parsed.data;
    }
  }
  return meta;
}

export function readLegacyMeta(id: string): SyncMeta | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem("conuo.sync." + id) || "null");
    return parseSyncMeta(value);
  } catch {
    return null;
  }
}

export const defaultIO: WorkspaceIO = {
  // Keep these adapters lazy so focused tests can provide a smaller
  // local-store module mock while injecting their own WorkspaceIO.
  loadLocal: (accountId) => loadLocalWorkspaceRecord(accountId),
  saveLocal: saveLocalWorkspace,
  commitLocalImport: (accountId, blobKey, blob, merge) =>
    commitLocalImport(accountId, blobKey, blob, merge),
  subscribeLocalCommits: subscribeLocalWorkspaceCommits,
  loadCloud: loadCloudWorkspace,
  loadCloudRevision: (accountId, signal) => loadCloudWorkspaceRevision(accountId, signal),
  saveCloud: saveCloudWorkspace,
  getBlob,
  getAccountBlob: (key, accountId) => getBlob(key, accountId),
  putBlobIfAbsent: (key, blob) => putBlobIfAbsent(key, blob),
  putAccountBlobIfAbsent: (key, blob, accountId) => putBlobIfAbsent(key, blob, accountId),
  shareAnonymousOriginals: (accountId, keys) => shareAnonymousOriginals(accountId, keys),
  deleteUnreferencedBlob: (key) => deleteUnreferencedBlob(key),
  deleteAccountUnreferencedBlob: (key, accountId) => deleteUnreferencedBlob(key, accountId),
  clearAccountLocalCache: (accountId) => clearAccountLocalCache(accountId),
  isAccountLocallyDeleted: (accountId) => isAccountLocallyDeleted(accountId),
  markAccountLocalDeletion: (accountId) => markAccountLocalDeletion(accountId),
  subscribeLocalAccountDeletions: (accountId, listener) =>
    subscribeLocalAccountDeletions(accountId, listener),
  subscribeConfirmedAccountDeletions: (listener) => subscribeConfirmedAccountDeletions(listener),
  uploadBlob: uploadSourceBlob,
  downloadBlob: downloadSourceBlob,
  previewSourcePurge: previewSourcePurgeCloud,
  requestSourcePurge: requestSourcePurgeCloud,
  previewSourceVersionPurge: previewSourceVersionPurgeCloud,
  requestSourceVersionPurge: requestSourceVersionPurgeCloud,
  claimImportParse,
  heartbeatImportParse,
  releaseImportParse,
  finishImportParse,
  cancelImportParse,
  retryImportParse,
  enqueueOrganizationJob: enqueueOrganizationJobCloud,
  cancelOrganizationJob: cancelOrganizationJobCloud,
  reconcileOrganizationJobs: reconcileOrganizationJobsCloud,
  askCloud,
  organizeCloud,
  getAccountMembership: accountMembershipReader,
  getModelStatus,
  readLegacyMeta,
};

/** Web business data is durable only after the existing cloud queue acknowledges it. */
export function createWebCloudWorkspaceIO(): WorkspaceIO {
  return {
    ...defaultIO,
    beginSession: webSessionStore.beginSession,
    clearSession: webSessionStore.clearSession,
    loadLocal: webSessionStore.loadLocal,
    saveLocal: webSessionStore.saveLocal,
    commitLocalImport: webSessionStore.commitLocalImport,
    subscribeLocalCommits: undefined,
    getBlob: webSessionStore.getBlob,
    getAccountBlob: webSessionStore.getBlob,
    putBlobIfAbsent: webSessionStore.putBlobIfAbsent,
    putAccountBlobIfAbsent: webSessionStore.putBlobIfAbsent,
    deleteUnreferencedBlob: webSessionStore.deleteUnreferencedBlob,
    deleteAccountUnreferencedBlob: webSessionStore.deleteUnreferencedBlob,
    shareAnonymousOriginals: undefined,
    clearAccountLocalCache: webSessionStore.clearAccountLocalCache,
    isAccountLocallyDeleted: webSessionStore.isAccountLocallyDeleted,
    markAccountLocalDeletion: webSessionStore.markAccountLocalDeletion,
    subscribeLocalAccountDeletions: webSessionStore.subscribeLocalAccountDeletions,
    readLegacyMeta: () => null,
  };
}

export const accountKey = (user: User | null) => user?.id || "local";

export function unpack(stored: WorkspaceData | null): {
  data: WorkspaceData | null;
  meta: SyncMeta | null;
  localRevision: number;
} {
  if (!stored) return { data: null, meta: null, localRevision: 0 };
  const { _conuoSync, _conuoLocalRevision, ...data } = stored as StoredWorkspace;
  const localRevision =
    Number.isSafeInteger(_conuoLocalRevision) && Number(_conuoLocalRevision) >= 0
      ? Number(_conuoLocalRevision)
      : 0;
  return { data, meta: parseSyncMeta(_conuoSync), localRevision };
}
