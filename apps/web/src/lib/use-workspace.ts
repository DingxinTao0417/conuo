"use client";
import { isAccountDeletionPendingError } from "./account-deletion";
import { subscribeConfirmedAccountDeletions } from "./account-deletion-observer";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  AnswerNoteEvidence,
  AnswerRequest,
  Source,
  SourceBlobReadOptions,
  WorkspaceData,
} from "./types";
import type {
  DurableOrganizationRequest,
  ImportParseLease,
  SourcePurgePreview,
  SourceVersionPurgePreview,
} from "./cloud";
import { createEmptyWorkspace } from "./seed";
import { webSessionStore } from "./web-session-store";
import {
  commitLocalImport,
  getBlob,
  loadLocalWorkspaceRecord,
  saveLocalWorkspace,
  subscribeLocalWorkspaceCommits,
  putBlobIfAbsent,
  deleteUnreferencedBlob,
  clearAccountLocalCache,
  LocalAccountDeletedError,
  isAccountLocallyDeleted,
  markAccountLocalDeletion,
  subscribeLocalAccountDeletions,
  shareAnonymousOriginals,
  type LocalWorkspaceCommitEvent,
  type StoredLocalWorkspace,
} from "./local-store";
import {
  askCloud,
  cancelOrganizationJob as cancelOrganizationJobCloud,
  cancelImportParse,
  claimImportParse,
  downloadSourceBlob,
  enqueueOrganizationJob as enqueueOrganizationJobCloud,
  finishImportParse,
  heartbeatImportParse,
  isCloudConfigured,
  loadCloudWorkspace,
  loadCloudWorkspaceRevision,
  getModelStatus,
  organizeCloud,
  previewSourcePurge as previewSourcePurgeCloud,
  previewSourceVersionPurge as previewSourceVersionPurgeCloud,
  requestSourcePurge as requestSourcePurgeCloud,
  requestSourceVersionPurge as requestSourceVersionPurgeCloud,
  reconcileOrganizationJobs as reconcileOrganizationJobsCloud,
  releaseImportParse,
  retryImportParse,
  saveCloudWorkspace,
  subscribeSession,
  uploadSourceBlob,
} from "./cloud";
import {
  resolveAnswerNoteEvidence,
  retrieveEvidence,
  resolveCitation,
  selectedDocumentNoteEvidence,
  selectedSources,
} from "./retrieval";
import { answerStreamEventSchema, streamedAnswerSchema } from "./answer-stream";
import type { OnAnswerProgress } from "./answer-stream-types";
import { getSourceVersion, replaceFileSource } from "./source-versions";
import { parseImportSource, prepareImportFile } from "./import";
import { assessImportQuota } from "./import-quota";
import { assertWorkspaceOwner, MAX_WORKSPACE_BYTES, workspaceSchema } from "./supabase/validation";
import { startForegroundCloudUpdateChecks } from "./foreground-cloud-updates";
import {
  previewPermanentSourceDeletionContent,
  type PermanentSourceDeletionSelection,
} from "./permanent-deletion";
import { sameSourcePurgeSelection, sourcePurgeSelectionSchema } from "./source-purge-contract";
import {
  advanceImportJob,
  cancelImportJob,
  cancelImportJobsForRecycledSources,
  completeImportJob,
  createImportJob,
  failImportJob,
  replaceImportJob,
  resumeImportJob,
  retryImportJob,
  startImportJob,
  type ImportJob,
} from "./import-queue";
import { mergeBackupRestore } from "./backup-restore";
import type { RestorePlan } from "./backup-types";
import { questionContextKey } from "./question-context";
import {
  isCrossLibraryAnswerRequest,
  validateCrossLibraryAnswerRequest,
} from "./cross-library-ask";
import type { OrganizationJob, OrganizationRequest } from "./organization-types";
import { organizationResultSchema } from "./organization-schema";
import { knowledgeNoteKey, validateKnowledgeChanges } from "./knowledge-update";
import { validateRelationProposals } from "./concept-relations";
import {
  organizationCitations,
  organizationContextKey,
  organizationUnavailableReason,
} from "./organization";
import {
  OrganizationRunner,
  type OrganizationInput,
  type OrganizationStatus,
} from "./organization-runner";
import {
  isLocalDevelopmentOrganizationRunnerEnabled,
  isOrganizationProcessorEnabled,
  localDevelopmentOrganizationRunnerStateFromEnvironment,
  organizationProcessorAvailabilityMessage,
  organizationProcessorStateFromEnvironment,
} from "./organization-processor-capability";
import {
  applyReadingProgressSyncResolution,
  applyNoteSyncResolution,
  applySafeNoteSyncChanges,
  mergeReadingProgressConflict,
  planReadingProgressSyncConflicts,
  planNoteSyncConflicts,
  rebaseIndependentWorkspaceChanges,
  resolveNoteSyncConflict,
  type NoteSyncPlan,
  type ReadingProgressSyncPlan,
} from "./sync-conflicts";
import {
  anonymousMigrationSummary,
  hasMeaningfulWorkspaceContent,
  mergeConcurrentWorkspace,
  noAnonymousWorkspaceMigration,
  sameData,
  sameDataOutsideNotes,
  withoutAnonymousCloudPaths,
} from "./workspace-coordinator/merge";
import type {
  AtomicPreparedImportResult,
  ImportPipeline,
  ImportStartResult,
  LocalCacheMode,
  NoteSyncConflictSelection,
  PendingImport,
  PendingLocalPersist,
  PendingOrganization,
  PendingQuestion,
  QueuedImport,
  ReadingProgressSyncSelection,
  RecoverableImportTransition,
  RemoteWorkspace,
  Session,
  StoredWorkspace,
  SyncMeta,
  User,
  View,
  WorkspaceIO,
  WorkspaceSignOutState,
} from "./workspace-coordinator/types";

export type {
  AnonymousWorkspaceMigrationState,
  ImportPipeline,
  ImportStartResult,
  LocalCacheMode,
  NoteSyncConflictSelection,
  ReadingProgressSyncSelection,
  WorkspaceIO,
  WorkspaceSignOutState,
} from "./workspace-coordinator/types";

function keepsRunningAfterBrowserExit(job: OrganizationJob): boolean {
  return (
    job.durable === true &&
    (job.request.kind === "source" || job.request.kind === "knowledge") &&
    (job.status === "queued" || job.status === "running")
  );
}

function isDurableOrganizationRequest(
  request: OrganizationRequest,
): request is DurableOrganizationRequest {
  return request.kind === "source" || request.kind === "knowledge";
}

function isInterruptedBrowserOrganization(job: OrganizationJob): boolean {
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
function reconcileDurableOrganizationProjections(
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

const defaultImportPipeline: ImportPipeline = {
  prepare: prepareImportFile,
  parse: parseImportSource,
};

function parseSyncMeta(value: unknown): SyncMeta | null {
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
function readLegacyMeta(id: string): SyncMeta | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem("conuo.sync." + id) || "null");
    return parseSyncMeta(value);
  } catch {
    return null;
  }
}
const defaultIO: WorkspaceIO = {
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
const accountKey = (user: User | null) => user?.id || "local";
function unpack(stored: WorkspaceData | null): {
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
function conflictRecordId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}:${uuid || `${Date.now()}:${Math.random().toString(36).slice(2)}`}`;
}
function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : "保存失败，请重试。";
}
function exceedsCloudWorkspaceCapacity(data: WorkspaceData): boolean {
  return new TextEncoder().encode(JSON.stringify(data)).byteLength > MAX_WORKSPACE_BYTES;
}
function conflictError(cause: unknown): boolean {
  if (cause instanceof OriginalSyncError) return false;
  if (cause && typeof cause === "object" && "status" in cause && cause.status === 409) return true;
  return /409|conflict|冲突|版本/i.test(errorText(cause));
}

/**
 * A response that explicitly rejects the write before it can commit does not
 * need an immediate read-back. Transport failures, server failures and an
 * invalid success body can all hide a committed transaction, so they do.
 */
function workspaceSaveNeedsReadBack(cause: unknown): boolean {
  if (cause instanceof OriginalSyncError) return false;
  if (!cause || typeof cause !== "object") return !conflictError(cause);
  const status = "status" in cause && typeof cause.status === "number" ? cause.status : null;
  const code = "code" in cause && typeof cause.code === "string" ? cause.code : "";
  if (status === 409 || code === "REVISION_CONFLICT" || code === "40001") return false;
  if (code === "WORKSPACE_BUSY") return false;
  if (status === null && !code) return !conflictError(cause);
  return status === null || status === 0 || status >= 500;
}

// Shared across coordinators in this page; IndexedDB's atomic add handles other tabs.
const pendingFileKeys = new Set<string>();
// SHA-256 identity is the user-visible duplicate rule. Serialize only the
// short reservation/persistence transaction so two simultaneous file picks
// cannot both miss the same existing source before either one is published.
const importHashQueues = new Map<string, Promise<void>>();
async function withImportHashReservation<T>(hash: string, operation: () => Promise<T>): Promise<T> {
  const previous = importHashQueues.get(hash) ?? Promise.resolve();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(() => barrier);
  importHashQueues.set(hash, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (importHashQueues.get(hash) === current) importHashQueues.delete(hash);
  }
}
// Quota is calculated from the live workspace, so serialize admission and its
// persistence per account. Otherwise two different hashes can both see the
// same remaining bytes and each publish an over-limit original.
const importAccountQueues = new Map<string, Promise<void>>();
async function withImportAccountReservation<T>(
  accountId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = importAccountQueues.get(accountId) ?? Promise.resolve();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(() => barrier);
  importAccountQueues.set(accountId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (importAccountQueues.get(accountId) === current) importAccountQueues.delete(accountId);
  }
}
class OriginalSyncError extends Error {}
class BackupRestoreContextError extends Error {}
class PurgeLocalPersistenceError extends Error {}
function originalIdentity(source: Pick<Source, "kind" | "blobKey" | "hash" | "size">): string {
  return JSON.stringify([source.kind, source.blobKey, source.hash, source.size]);
}
async function verifyOriginal(source: Pick<Source, "hash" | "size">, blob: Blob): Promise<void> {
  if (source.size !== blob.size || !/^[a-f0-9]{64}$/i.test(source.hash))
    throw new OriginalSyncError(
      "原文件大小或内容指纹与已解析版本不符，尚未上传或替换，请重新选择文件。",
    );
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const actual = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (actual !== source.hash.toLowerCase())
    throw new OriginalSyncError("原文件内容与已解析版本不符，尚未上传或替换，请重新选择文件。");
}

/** A completed upload follows its original into history, never another version or changed file. */
function mergeOriginalPath(
  data: WorkspaceData,
  uploaded: Source,
  storagePath: string,
): WorkspaceData {
  const live = data.sources.find((source) => source.id === uploaded.id);
  if (!live) return data;
  const current = getSourceVersion(live, uploaded.versionId);
  if (!current) return data;
  if (
    originalIdentity(current) !== originalIdentity(uploaded) ||
    (current.storagePath && current.storagePath !== storagePath)
  )
    throw new OriginalSyncError(
      "上传期间原件记录已变化，未将上传结果绑定到其他内容。请检查资料并重试。",
    );
  if (current.storagePath === storagePath) return data;
  return {
    ...data,
    sources: data.sources.map((source) =>
      source.id !== uploaded.id
        ? source
        : source.versionId === uploaded.versionId
          ? { ...source, storagePath }
          : {
              ...source,
              versions: source.versions!.map((version) =>
                version.versionId === uploaded.versionId ? { ...version, storagePath } : version,
              ),
            },
    ),
  };
}

function originalKeys(source: Source): string[] {
  return [
    ...new Set(
      [source, ...(source.versions ?? [])].flatMap((version) =>
        version.blobKey ? [version.blobKey] : [],
      ),
    ),
  ];
}

/**
 * Account-scoped save coordinator. React callbacks carry an activation token,
 * so an upload/edit callback from a previous account cannot edit a new account.
 * Sync metadata is stored atomically WITH its IndexedDB document, never in a
 * separate localStorage transaction.
 */
export class WorkspaceCoordinator {
  private active: Session | null = null;
  private token = 0;
  private listeners = new Set<() => void>();
  private queues = new Map<string, Promise<void>>();
  /** Defers same-page full-snapshot saves until an atomic import is adopted. */
  private atomicLocalWriteBarriers = new WeakMap<Session, Promise<void>>();
  /** Coalesces callers waiting for the same exact local snapshot and sync metadata. */
  private pendingLocalPersists = new Map<Session, PendingLocalPersist[]>();
  /** Lets callers await an in-flight persistence pass instead of racing it. */
  private pumpTasks = new Map<Session, Promise<void>>();
  private memory = new Map<string, Session>();
  // A removed session may still be unwinding an IndexedDB or model promise.
  // Never let that continuation re-register a stale in-memory snapshot.
  private discardedSessions = new WeakSet<Session>();
  /** Identity-only fences survive switches; no deleted account body remains in memory. */
  private discardedAccounts = new Set<string>();
  /** Temporary uncertainty blocks access without discarding unsynced account data. */
  private unverifiedAccounts = new Set<string>();
  private accountDeletionTasks = new Map<string, Promise<void>>();
  private accountDeletionErrors = new Map<string, string>();
  private accountDeletionView: { accountId: string; token: number } | null = null;
  private accountDeletionUnsubscribe: (() => void) | null = null;
  private confirmedAccountDeletionUnsubscribe: (() => void) | null = null;
  private deletionMarkerChecks = new WeakMap<Session, Promise<void>>();
  /** Ordinary editor callbacks cannot mutate a snapshot while a reviewed reading choice is saved. */
  private readingConflictResolutions = new WeakSet<Session>();
  private pendingQuestions = new Set<PendingQuestion>();
  private pendingOrganizations = new Set<PendingOrganization>();
  private pendingImports = new Map<string, PendingImport>();
  private queuedImports: QueuedImport[] = [];
  private drainingImports = false;
  /** Pairs staged for a dedicated parse transition; generic saves must wait. */
  private importTransitionFences = new Map<Session, Set<string>>();
  /** Prevents a queued worker from claiming while an owner-level cancel is in flight. */
  private cancellingImports = new Set<string>();
  /** A held lease may expire after the other browser closes; retry without reparsing early. */
  private importLeaseRetries = new Map<string, ReturnType<typeof setTimeout>>();
  // Recovery snapshots are intentionally independent from ordinary workspace
  // persistence, but account deletion still has to await them before clearing
  // IndexedDB. Keep only live writes for the owning session.
  private pendingRecoveryWrites = new Map<Session, Set<Promise<void>>>();
  private pendingBackupRestores = new Map<
    string,
    { fingerprint: string; promise: Promise<void> }
  >();
  private localCommitUnsubscribe: (() => void) | null = null;
  private localReloadTasks = new WeakMap<Session, Promise<boolean>>();
  private cloudUpdateTasks = new WeakMap<
    Session,
    { controller: AbortController; promise: Promise<void> }
  >();
  private pendingReadingPositions = new WeakMap<Session, Set<string>>();
  private pendingCloudOperations = new WeakMap<Session, number>();
  private view: View = {
    data: createEmptyWorkspace(),
    user: null,
    status: "loading",
    error: "",
    ready: false,
    recovery: null,
    recoveryRevision: null,
    noteSyncPlan: null,
    readingProgressSyncPlan: null,
    token: 0,
    organizationStatus: { ready: false, running: false, message: "正在读取资料…" },
    purging: false,
    localCacheMode: "normal",
    localUpdateRevision: null,
    loadingLocalUpdate: false,
    cloudUpdateRevision: null,
    checkingCloudUpdate: false,
    loadingCloudUpdate: false,
    cloudUpdateError: "",
    cloudAdoptionSequence: 0,
    signOutState: { kind: "syncing", canSync: false, canKeepLocalDraft: false },
    anonymousMigration: noAnonymousWorkspaceMigration(),
  };
  constructor(
    private io: WorkspaceIO = defaultIO,
    private imports: ImportPipeline = defaultImportPipeline,
    private capabilities: {
      storageMode?: "hybrid" | "cloud";
      durableOrganizationProcessorEnabled?: boolean;
      /** Only `useWorkspace` supplies this from the development-only public capability. */
      localDevelopmentOrganizationRunnerEnabled?: boolean;
    } = {},
  ) {
    this.io = this.accountAwareIO(io);
  }

  private get cloudOnly(): boolean {
    return this.capabilities.storageMode === "cloud";
  }

  /** Observe explicit owner arguments, never infer ownership from document text. */
  private accountAwareIO(io: WorkspaceIO): WorkspaceIO {
    const ownerArguments: Partial<Record<keyof WorkspaceIO, number>> = {
      loadLocal: 0,
      saveLocal: 1,
      commitLocalImport: 0,
      loadCloud: 0,
      loadCloudRevision: 0,
      saveCloud: 2,
      getAccountBlob: 1,
      putAccountBlobIfAbsent: 2,
      shareAnonymousOriginals: 0,
      deleteAccountUnreferencedBlob: 1,
      uploadBlob: 2,
      downloadBlob: 1,
      previewSourcePurge: 1,
      requestSourcePurge: 3,
      previewSourceVersionPurge: 2,
      requestSourceVersionPurge: 4,
      claimImportParse: 2,
      heartbeatImportParse: 3,
      releaseImportParse: 3,
      finishImportParse: 5,
      cancelImportParse: 4,
      retryImportParse: 4,
      enqueueOrganizationJob: 2,
      cancelOrganizationJob: 2,
      reconcileOrganizationJobs: 0,
      askCloud: 2,
      organizeCloud: 2,
      getModelStatus: 0,
    };
    return new Proxy(io, {
      get: (target, property, receiver) => {
        const value: unknown = Reflect.get(target, property, receiver);
        const position = ownerArguments[property as keyof WorkspaceIO];
        if (typeof value !== "function" || position === undefined) return value;
        return async (...args: unknown[]) => {
          const argument = args[position];
          let owner = typeof argument === "string" ? argument : "local";
          if (owner.startsWith("recovery:")) {
            const body = owner.slice("recovery:".length);
            owner = body.slice(0, body.lastIndexOf(":", body.lastIndexOf(":") - 1));
          }
          if (this.discardedAccounts.has(owner)) throw new LocalAccountDeletedError();
          if (this.unverifiedAccounts.has(owner))
            throw new Error("本机账号状态尚未核验，已暂停访问；请重新核验后继续。");
          try {
            const result: unknown = await Reflect.apply(value, target, args);
            if (this.discardedAccounts.has(owner)) throw new LocalAccountDeletedError();
            if (this.unverifiedAccounts.has(owner))
              throw new Error("本机账号状态尚未核验，已暂停访问；请重新核验后继续。");
            return result;
          } catch (cause) {
            const confirmed =
              isAccountDeletionPendingError(cause) ||
              (cause instanceof Error && "code" in cause && cause.code === "LOCAL_ACCOUNT_DELETED");
            if (owner !== "local" && confirmed) void this.discardAccount(owner).catch(() => {});
            throw cause;
          }
        };
      },
    });
  }

  getSnapshot = (): View => this.view;
  /** Read the live visible snapshot after async work, never an older React render. */
  readCurrentData(
    token: number,
    userId: string | null,
    localCacheMode: LocalCacheMode,
  ): WorkspaceData {
    const current = this.getSnapshot();
    if (
      !current.ready ||
      !this.active ||
      this.active.exiting ||
      current.token !== token ||
      (current.user?.id ?? null) !== userId ||
      current.localCacheMode !== localCacheMode
    )
      throw new Error("当前账号、会话或缓存状态已改变，请重新核对操作结果。");
    return current.data;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private hasNewerLocalUpdate(session: Session): boolean {
    return (
      session.localUpdateRevision !== null && session.localUpdateRevision > session.localRevision
    );
  }
  private setLocalRevision(session: Session, localRevision: number): void {
    session.localRevision = localRevision;
    if (session.localUpdateRevision !== null && session.localUpdateRevision <= localRevision)
      session.localUpdateRevision = null;
  }
  private stopLocalCommitSubscription(): void {
    const unsubscribe = this.localCommitUnsubscribe;
    this.localCommitUnsubscribe = null;
    try {
      unsubscribe?.();
    } catch {
      // A broken optional notification channel cannot affect persistence.
    }
  }
  private markNewerLocalUpdate(
    session: Session,
    accountId: string,
    event: LocalWorkspaceCommitEvent,
  ): void {
    if (
      !this.isActive(session) ||
      accountKey(session.user) !== accountId ||
      event.accountId !== accountId ||
      !Number.isSafeInteger(event.localRevision) ||
      event.localRevision <= session.localRevision
    )
      return;
    session.localUpdateRevision = Math.max(session.localUpdateRevision ?? 0, event.localRevision);
    this.publish(session);
  }
  private startLocalCommitSubscription(session: Session, accountId: string): void {
    this.stopLocalCommitSubscription();
    if (!this.io.subscribeLocalCommits) return;
    try {
      this.localCommitUnsubscribe = this.io.subscribeLocalCommits(accountId, (event) =>
        this.markNewerLocalUpdate(session, accountId, event),
      );
    } catch {
      this.localCommitUnsubscribe = null;
    }
  }
  /** Releases browser resources owned by the coordinator when its hook unmounts. */
  dispose(): void {
    this.stopLocalCommitSubscription();
    this.stopAccountDeletionSubscription();
    const unsubscribe = this.confirmedAccountDeletionUnsubscribe;
    this.confirmedAccountDeletionUnsubscribe = null;
    try {
      unsubscribe?.();
    } catch {
      /* Disposal never authorizes old writes. */
    }
    if (this.active) this.cloudUpdateTasks.get(this.active)?.controller.abort();
    if (this.cloudOnly) {
      this.active = null;
      this.memory.clear();
      this.io.clearSession?.();
    }
  }
  private isActive(session: Session): boolean {
    return (
      this.active === session &&
      !session.exiting &&
      !session.accountAccessVerificationFailed &&
      !this.discardedAccounts.has(accountKey(session.user))
    );
  }
  private isCurrent(session: Session): boolean {
    return this.active === session && !this.discardedAccounts.has(accountKey(session.user));
  }
  private noteSyncPlan(session: Session): NoteSyncPlan | null {
    if (
      session.blocked !== "conflict" ||
      !session.recovery ||
      !sameDataOutsideNotes(session.data, session.recovery)
    )
      return null;
    try {
      const plan = planNoteSyncConflicts(session.data, session.recovery, session.confirmedCloud);
      // Tombstone and missing-record conflicts require a durable conflict
      // snapshot collection. Until that exists, keep the conservative whole
      // workspace recovery path instead of implying that either side vanished.
      if (plan.conflicts.some((conflict) => conflict.kind !== "both-edited")) return null;
      return plan.conflicts.length || plan.safe.some((change) => change.side === "local")
        ? plan
        : null;
    } catch {
      // Invalid or duplicate legacy note records remain recoverable through
      // export/remote recovery, but must not be rewritten by a best effort merge.
      return null;
    }
  }
  private readingProgressSyncPlan(session: Session): ReadingProgressSyncPlan | null {
    if (
      session.blocked !== "conflict" ||
      !session.recovery ||
      session.recoveryRevision === null ||
      !session.confirmedCloud
    )
      return null;
    try {
      const plan = planReadingProgressSyncConflicts(
        session.data,
        session.recovery,
        session.confirmedCloud,
      );
      return plan?.conflicts.length ? plan : null;
    } catch {
      return null;
    }
  }
  private signOutState(session: Session): WorkspaceSignOutState {
    if (!session.user) return { kind: "ready", canSync: false, canKeepLocalDraft: false };
    if (this.cloudOnly) {
      if (!session.ready && !session.knownRevision)
        return { kind: "ready", canSync: false, canKeepLocalDraft: false };
      if (session.exiting || session.localDirty || session.pumping || session.checking)
        return {
          kind: "syncing",
          message: "正在保存到云端，请等待完成后退出。尚未确认的修改仅暂存在当前页面。",
          canSync: false,
          canKeepLocalDraft: false,
        };
      if (session.blocked === "conflict")
        return {
          kind: "conflict",
          message: "当前页面的修改与云端版本存在冲突，请先处理冲突或导出备份。",
          canSync: false,
          canKeepLocalDraft: false,
        };
      if (session.cloudDirty || session.blocked === "error")
        return {
          kind: "unsynced",
          message: "部分修改尚未保存到云端，请重新连接并完成保存后退出。",
          canSync: true,
          canKeepLocalDraft: false,
        };
      return { kind: "ready", canSync: false, canKeepLocalDraft: false };
    }
    if (
      session.anonymousMigration.kind === "pending" ||
      session.anonymousMigration.kind === "migrating"
    )
      return {
        kind: "syncing",
        message: "请先迁移或暂不迁移此浏览器中的匿名资料。",
        canSync: false,
        canKeepLocalDraft: false,
      };
    if (session.exiting)
      return {
        kind: "syncing",
        message: "正在安全退出当前账号，请稍候。",
        canSync: false,
        canKeepLocalDraft: false,
      };
    if (!session.ready)
      return {
        kind: "syncing",
        message: "正在完成当前保存，请稍候。",
        canSync: false,
        canKeepLocalDraft: false,
      };
    // The snapshot comes directly from the cloud and no local write is
    // pending. Direct sign-out remains safe even while IndexedDB is down.
    if (this.isCloudReadOnly(session))
      return { kind: "ready", canSync: false, canKeepLocalDraft: false };
    if (session.localDirty)
      return {
        kind: "local-error",
        message: "当前修改尚未安全保存到此浏览器。",
        canSync: false,
        canKeepLocalDraft: false,
      };
    if (session.pumping || session.checking)
      return {
        kind: "syncing",
        message: "正在与云端同步。本机副本已经保存，可选择保留草稿后退出。",
        canSync: false,
        canKeepLocalDraft: true,
      };
    if (session.blocked === "conflict")
      return { kind: "conflict", canSync: false, canKeepLocalDraft: true };
    if (session.cloudDirty || session.blocked === "error")
      return { kind: "unsynced", canSync: true, canKeepLocalDraft: true };
    return { kind: "ready", canSync: false, canKeepLocalDraft: false };
  }
  private publish(session: Session) {
    // A signing-out session deliberately rejects writes but still needs to
    // publish its frozen status while the Auth event replaces it.
    if (!this.isCurrent(session)) return;
    this.accountDeletionView = null;
    // Updates, cloud reconciliation, recovery and account changes all publish
    // through here. Stop old evidence requests as soon as their boundary changes.
    for (const pending of this.pendingQuestions) {
      const error = this.questionError(pending);
      if (error) pending.controller.abort(error);
    }
    for (const pending of this.pendingOrganizations) {
      const error = this.organizationError(pending);
      if (error) pending.controller.abort(error);
    }
    for (const pending of this.pendingImports.values()) {
      const error = this.importError(pending);
      if (error && !pending.controller.signal.aborted) pending.controller.abort(error);
    }
    const anonymousMigration =
      session.anonymousMigration.kind === "migrated"
        ? {
            ...session.anonymousMigration,
            pendingCloudConfirmation: session.cloudDirty || session.pumping || session.checking,
          }
        : session.anonymousMigration;
    const verificationFailed = !!session.accountAccessVerificationFailed;
    this.view = {
      accountDeletionState: null,
      accountAccessVerificationFailed: verificationFailed,
      data: verificationFailed ? { ...createEmptyWorkspace(), spaces: [] } : session.data,
      user: session.user,
      status: verificationFailed ? "error" : session.status,
      error: verificationFailed
        ? "无法核验本机账号注销状态，已暂停资料访问。内部草稿已保留，请重新核验后继续。"
        : session.error,
      ready: !verificationFailed && session.ready,
      recovery: verificationFailed ? null : session.recovery,
      recoveryRevision: verificationFailed ? null : session.recoveryRevision,
      noteSyncPlan: verificationFailed ? null : this.noteSyncPlan(session),
      readingProgressSyncPlan: verificationFailed ? null : this.readingProgressSyncPlan(session),
      token: session.token,
      organizationStatus: verificationFailed
        ? { ready: false, running: false, message: "账号状态尚未核验，资料访问已暂停。" }
        : session.organizationStatus,
      purging: session.purging,
      localCacheMode: session.localCacheMode,
      localUpdateRevision: session.localUpdateRevision,
      loadingLocalUpdate: session.loadingLocalUpdate,
      cloudUpdateRevision: session.cloudUpdateRevision,
      checkingCloudUpdate: session.checkingCloudUpdate,
      loadingCloudUpdate: session.loadingCloudUpdate,
      cloudUpdateError: verificationFailed ? "" : session.cloudUpdateError,
      cloudAdoptionSequence: session.cloudAdoptionSequence,
      signOutState: this.signOutState(session),
      anonymousMigration: verificationFailed ? noAnonymousWorkspaceMigration() : anonymousMigration,
    };
    this.listeners.forEach((listener) => listener());
  }
  private remember(session: Session) {
    if (this.cloudOnly && this.active !== session) return;
    if (this.discardedSessions.has(session) || this.discardedAccounts.has(accountKey(session.user)))
      return;
    const id = accountKey(session.user);
    const previous = this.memory.get(id);
    if (!previous || previous.token <= session.token) this.memory.set(id, session);
  }
  private syncMeta(session: Session): SyncMeta {
    const meta: SyncMeta = { revision: session.revision, dirty: session.cloudDirty };
    if (session.cloudDirty && session.confirmedCloud) {
      meta.baseRevision = session.revision;
      meta.base = structuredClone(session.confirmedCloud);
    }
    return meta;
  }
  private stored(session: Session, data = session.data): StoredWorkspace {
    return session.user ? { ...data, _conuoSync: this.syncMeta(session) } : { ...data };
  }
  /**
   * A local import changes a workspace that may already contain unsynced cloud
   * work from another tab. Preserve that exact fence; when the latest local
   * record was clean, its pre-import data becomes the three-way merge base.
   */
  private storedAtomicImport(
    session: Session,
    latestStored: StoredLocalWorkspace | null,
    latestData: WorkspaceData,
    nextData: WorkspaceData,
    changed: boolean,
  ): StoredLocalWorkspace {
    if (!session.user || !changed) return changed ? { ...nextData } : latestStored || nextData;

    const latestMeta = unpack(latestStored).meta;
    if (latestMeta?.dirty) {
      return { ...nextData, _conuoSync: structuredClone(latestMeta) };
    }

    const revision = latestMeta?.revision ?? session.revision;
    const base = latestMeta ? latestData : session.knownRevision ? session.confirmedCloud : null;
    return {
      ...nextData,
      _conuoSync: {
        revision,
        dirty: true,
        ...(base
          ? {
              baseRevision: revision,
              base: structuredClone(base),
            }
          : {}),
      },
    };
  }

  /** Safely replays same-page changes across the latest transaction snapshot. */
  private mergeConcurrentImportCommit(
    current: WorkspaceData,
    committed: WorkspaceData,
    boundary: WorkspaceData,
  ): WorkspaceData | null {
    return mergeConcurrentWorkspace(current, committed, boundary);
  }
  private isCloudReadOnly(session: Session): boolean {
    return session.localCacheMode === "cloud-readonly";
  }
  private readOnlyMessage(): string {
    return "此浏览器的本机副本暂时无法读取，当前仅可查看已确认的云端资料。请重新连接后再编辑、导入或整理。";
  }
  private assertWritable(session: Session): void {
    if (this.discardedAccounts.has(accountKey(session.user))) throw new LocalAccountDeletedError();
    if (
      session.accountAccessVerificationFailed ||
      this.unverifiedAccounts.has(accountKey(session.user))
    )
      throw new Error("本机账号状态尚未核验，已暂停访问；请重新核验后继续。");
    if (this.isCloudReadOnly(session)) throw new Error(this.readOnlyMessage());
  }
  private persist(session: Session): Promise<void> {
    if (
      session.accountAccessVerificationFailed ||
      this.unverifiedAccounts.has(accountKey(session.user))
    )
      return Promise.reject(new Error("本机账号状态尚未核验，已暂停访问；请重新核验后继续。"));
    if (this.isCloudReadOnly(session)) return Promise.reject(new Error(this.readOnlyMessage()));
    if (this.hasNewerLocalUpdate(session))
      return Promise.reject(new Error("另一个标签页已保存更新。请先载入最新数据，再继续编辑。"));
    if (this.discardedSessions.has(session) || this.discardedAccounts.has(accountKey(session.user)))
      return Promise.reject(new LocalAccountDeletedError());
    const atomicBarrier = this.atomicLocalWriteBarriers.get(session);
    if (atomicBarrier) return atomicBarrier.then(() => this.persist(session));
    const id = accountKey(session.user);
    const data = session.data;
    const revision = session.revision;
    const dirty = session.cloudDirty;
    const confirmedCloud = session.confirmedCloud;
    const matching = this.pendingLocalPersists
      .get(session)
      ?.find(
        (pending) =>
          pending.data === data &&
          pending.revision === revision &&
          pending.cloudDirty === dirty &&
          pending.confirmedCloud === confirmedCloud,
      );
    if (matching) return matching.promise;
    const stored = structuredClone(this.stored(session, data));
    const previous = this.queues.get(id) || Promise.resolve();
    const write = previous.then(async () => {
      // Web page memory belongs to the current session, including same-account re-logins.
      // Hybrid sessions may still flush a protected outgoing local draft.
      if (this.cloudOnly && this.active !== session) return;
      // A write that had not reached IndexedDB when account deletion began
      // must not recreate the just-cleared account document.
      if (this.discardedSessions.has(session) || this.discardedAccounts.has(id)) return;
      if (session.accountAccessVerificationFailed || this.unverifiedAccounts.has(id))
        throw new Error("本机账号状态尚未核验，已暂停访问；请重新核验后继续。");
      const savedRevision = await this.io.saveLocal(stored, id, session.localRevision);
      if (typeof savedRevision === "number") this.setLocalRevision(session, savedRevision);
    });
    // A failed write must not prevent a later retry or account-specific flush.
    this.queues.set(
      id,
      write.catch(() => {}),
    );
    const promise = write
      .then(() => {
        if (session.data === data && session.revision === revision && session.cloudDirty === dirty)
          session.localDirty = false;
        this.remember(session);
      })
      .catch(async (cause) => {
        if (this.discardedAccounts.has(id)) throw cause;
        session.localDirty = true;
        if (
          (cause instanceof Error &&
            "code" in cause &&
            cause.code === "LOCAL_WORKSPACE_CONFLICT") ||
          /另一个标签页已更新本机工作区/u.test(errorText(cause))
        ) {
          try {
            const latest = unpack(await this.io.loadLocal(id));
            if (latest.localRevision > session.localRevision)
              this.markNewerLocalUpdate(session, id, {
                accountId: id,
                localRevision: latest.localRevision,
                writerId: "local-conflict-readback",
              });
          } catch {
            // The original CAS failure remains actionable even if readback fails.
          }
        }
        this.remember(session);
        throw cause;
      });
    const pending = this.pendingLocalPersists.get(session) ?? [];
    const record: PendingLocalPersist = {
      data,
      revision,
      cloudDirty: dirty,
      confirmedCloud,
      promise,
    };
    pending.push(record);
    this.pendingLocalPersists.set(session, pending);
    const release = () => {
      const current = this.pendingLocalPersists.get(session);
      if (!current) return;
      const next = current.filter((item) => item !== record);
      if (next.length) this.pendingLocalPersists.set(session, next);
      else this.pendingLocalPersists.delete(session);
    };
    void promise.then(release, release);
    return promise;
  }

  private trackRecoveryWrite(session: Session, write: Promise<void>): Promise<void> {
    const writes = this.pendingRecoveryWrites.get(session) ?? new Set<Promise<void>>();
    writes.add(write);
    this.pendingRecoveryWrites.set(session, writes);
    const release = () => {
      writes.delete(write);
      if (!writes.size) this.pendingRecoveryWrites.delete(session);
    };
    // Handle both paths rather than using finally(), whose returned rejected
    // promise could otherwise become an unobserved error in the coordinator.
    void write.then(release, release);
    return write;
  }

  private stopAccountDeletionSubscription(): void {
    const unsubscribe = this.accountDeletionUnsubscribe;
    this.accountDeletionUnsubscribe = null;
    try {
      unsubscribe?.();
    } catch {
      /* Authoritative checks do not rely on notifications. */
    }
  }

  private startAccountDeletionSubscription(session: Session, accountId: string): void {
    this.stopAccountDeletionSubscription();
    if (!session.user) return;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = this.io.subscribeLocalAccountDeletions?.(accountId, () => {
        void this.discardAccount(accountId).catch(() => {});
      });
    } catch {
      /* Focus and activation still check the authoritative marker. */
    }
    const check = () => {
      if (this.isCurrent(session) && !session.exiting)
        void this.checkAccountDeletionMarker(session).catch(() => {});
    };
    const visibility = () => {
      if (document.visibilityState === "visible") check();
    };
    if (typeof window !== "undefined") window.addEventListener("focus", check);
    if (typeof window !== "undefined") window.addEventListener("pageshow", check);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", visibility);
    this.accountDeletionUnsubscribe = () => {
      unsubscribe?.();
      if (typeof window !== "undefined") window.removeEventListener("focus", check);
      if (typeof window !== "undefined") window.removeEventListener("pageshow", check);
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", visibility);
    };
  }

  private checkAccountDeletionMarker(session: Session): Promise<void> {
    const existing = this.deletionMarkerChecks.get(session);
    if (existing) return existing;
    const task = (async () => {
      const accountId = session.user?.id;
      if (!accountId || !this.io.isAccountLocallyDeleted) return;
      try {
        if (await this.io.isAccountLocallyDeleted(accountId)) await this.discardAccount(accountId);
        else if (this.isCurrent(session)) {
          this.unverifiedAccounts.delete(accountId);
          if (session.accountAccessVerificationFailed) await this.activate(session.user);
        }
      } catch (cause) {
        if (this.isCurrent(session)) {
          this.unverifiedAccounts.add(accountId);
          // A fresh activation has not read account data yet. It must not
          // replace a retained dirty session with its empty loading snapshot.
          if (session.ready) this.remember(session);
          session.accountAccessVerificationFailed = true;
          session.ready = false;
          this.cloudUpdateTasks.get(session)?.controller.abort();
          session.status = "error";
          session.error = "无法核验本机账号注销状态，已暂停访问：" + errorText(cause);
          this.publish(session);
        }
        throw cause;
      }
    })();
    this.deletionMarkerChecks.set(session, task);
    const release = () => this.deletionMarkerChecks.delete(session);
    void task.then(release, release);
    return task;
  }

  private redactDeletedAccount(accountId: string): {
    sessions: Set<Session>;
    token: number | null;
  } {
    this.discardedAccounts.add(accountId);
    this.unverifiedAccounts.delete(accountId);
    const sessions = new Set<Session>();
    const collect = (session: Session) => {
      if (session.user?.id === accountId) sessions.add(session);
    };
    if (this.active) collect(this.active);
    for (const session of this.memory.values()) collect(session);
    for (const session of this.pendingLocalPersists.keys()) collect(session);
    for (const session of this.pendingRecoveryWrites.keys()) collect(session);
    for (const session of this.pumpTasks.keys()) collect(session);
    for (const pending of this.pendingQuestions) collect(pending.session);
    for (const pending of this.pendingOrganizations) collect(pending.session);
    for (const pending of this.pendingImports.values()) collect(pending.session);
    for (const pending of this.queuedImports) collect(pending.session);
    this.memory.delete(accountId);
    const visible = this.active?.user?.id === accountId;
    if (visible) {
      this.stopLocalCommitSubscription();
      this.stopAccountDeletionSubscription();
      this.active = null;
    }
    for (const session of sessions) {
      this.discardedSessions.add(session);
      this.pendingLocalPersists.delete(session);
      for (const key of this.pendingBackupRestores.keys()) {
        if (key.startsWith(`[${session.token},`)) this.pendingBackupRestores.delete(key);
      }
      this.cloudUpdateTasks.get(session)?.controller.abort();
      session.data = { ...createEmptyWorkspace(), spaces: [] };
      session.recovery = null;
      session.recoveryRevision = null;
      session.confirmedCloud = null;
      session.anonymousWorkspace = null;
      session.anonymousMigration = noAnonymousWorkspaceMigration();
      session.error = "";
      session.accountAccessVerificationFailed = false;
      session.ready = false;
      session.localDirty = false;
      session.cloudDirty = false;
      session.purging = false;
      this.clearImportLeaseRetries(session);
      this.importTransitionFences.delete(session);
      for (const key of this.cancellingImports) {
        if (key.startsWith(`${session.token}:`)) this.cancellingImports.delete(key);
      }
    }
    const stopped = new DOMException("账号注销请求已提交，本次操作已停止。", "AbortError");
    for (const pending of this.pendingQuestions) {
      if (pending.session.user?.id === accountId) {
        pending.controller.abort(stopped);
        this.pendingQuestions.delete(pending);
      }
    }
    for (const pending of this.pendingOrganizations) {
      if (pending.session.user?.id === accountId) {
        pending.controller.abort(stopped);
        this.pendingOrganizations.delete(pending);
      }
    }
    for (const [key, pending] of this.pendingImports) {
      if (pending.session.user?.id === accountId) {
        pending.controller.abort(stopped);
        this.pendingImports.delete(key);
      }
    }
    this.queuedImports = this.queuedImports.filter(
      (pending) => pending.session.user?.id !== accountId,
    );
    if (!visible) {
      const prior = this.accountDeletionView;
      if (prior?.accountId === accountId && this.view.token === prior.token && !this.active) {
        this.view = {
          ...this.view,
          accountDeletionState: "clearing",
          error: "账号已停止访问，正在重试本机清理。",
        };
        this.listeners.forEach((listener) => listener());
        return { sessions, token: prior.token };
      }
      return { sessions, token: null };
    }
    const token = ++this.token;
    this.accountDeletionView = { accountId, token };
    this.view = {
      ...this.view,
      data: { ...createEmptyWorkspace(), spaces: [] },
      user: null,
      status: "error",
      error: "账号已提交注销，本机资料已停止访问，正在清理本机副本。",
      ready: false,
      recovery: null,
      recoveryRevision: null,
      noteSyncPlan: null,
      readingProgressSyncPlan: null,
      token,
      purging: false,
      organizationStatus: { ready: false, running: false, message: "账号已停止访问。" },
      localCacheMode: "normal",
      localUpdateRevision: null,
      loadingLocalUpdate: false,
      cloudUpdateRevision: null,
      checkingCloudUpdate: false,
      loadingCloudUpdate: false,
      cloudUpdateError: "",
      cloudAdoptionSequence: 0,
      signOutState: { kind: "ready", canSync: false, canKeepLocalDraft: false },
      anonymousMigration: noAnonymousWorkspaceMigration(),
      accountDeletionState: "clearing",
      accountAccessVerificationFailed: false,
    };
    this.listeners.forEach((listener) => listener());
    return { sessions, token };
  }

  /** Fence and redact synchronously, then persist the marker before draining old writes. */
  async discardAccount(accountId: string): Promise<void> {
    if (
      !accountId ||
      accountId.trim() !== accountId ||
      accountId === "local" ||
      accountId.startsWith("recovery:")
    )
      throw new Error("清理失败：账户身份无效。");
    const { sessions, token } = this.redactDeletedAccount(accountId);
    let task = this.accountDeletionTasks.get(accountId);
    if (!task) {
      task = (async () => {
        const errors: string[] = [];
        try {
          await this.io.markAccountLocalDeletion?.(accountId);
        } catch (cause) {
          errors.push("本机注销标记保存失败：" + errorText(cause));
        }
        for (;;) {
          const tail = this.queues.get(accountId);
          await tail?.catch(() => {});
          if (this.queues.get(accountId) === tail) break;
        }
        const recoveryWrites = [...sessions].flatMap((session) => [
          ...(this.pendingRecoveryWrites.get(session) ?? []),
        ]);
        await Promise.all(recoveryWrites.map((write) => write.catch(() => {})));
        try {
          await this.io.clearAccountLocalCache?.(accountId);
        } catch (cause) {
          errors.push("本机副本清理失败：" + errorText(cause));
        }
        if (errors.length) {
          this.accountDeletionErrors.set(accountId, errors.join("；"));
          throw new Error(errors.join("；"));
        }
        this.accountDeletionErrors.delete(accountId);
      })();
      this.accountDeletionTasks.set(accountId, task);
      const release = () => {
        if (this.accountDeletionTasks.get(accountId) === task)
          this.accountDeletionTasks.delete(accountId);
      };
      void task.then(release, release);
    }
    try {
      await task;
    } finally {
      if (token !== null && this.view.token === token && !this.active) {
        const error = this.accountDeletionErrors.get(accountId);
        this.view = {
          ...this.view,
          accountDeletionState: error ? "cleanup-failed" : "blocked",
          error: error
            ? "账号已停止访问，但本机清理尚未完成：" + error
            : "账号已提交注销，本机副本已清理并停止访问。",
        };
        this.listeners.forEach((listener) => listener());
      }
    }
  }

  async retryAccountLocalDeletion(): Promise<void> {
    const target = this.accountDeletionView;
    if (!target || this.view.token !== target.token || this.active)
      throw new Error("当前账号状态已改变，请重新打开账号设置核对。");
    await this.discardAccount(target.accountId);
  }

  /**
   * Looks for a meaningful anonymous library only after this account's local
   * and cloud copies have both been reconciled. A read failure is deliberately
   * non-destructive: the account keeps its own normal load path and no
   * anonymous data is inferred from a failed IndexedDB read.
   */
  private async discoverAnonymousWorkspaceMigration(session: Session): Promise<void> {
    if (this.cloudOnly) return;
    if (!session.user || !this.isActive(session)) return;
    try {
      const anonymous = unpack(await this.io.loadLocal("local")).data;
      if (!this.isActive(session)) return;
      if (!anonymous || !hasMeaningfulWorkspaceContent(anonymous)) return;

      if (!session.knownRevision || session.blocked) {
        session.anonymousMigration = anonymousMigrationSummary(
          "unavailable",
          anonymous,
          "当前账号的云端状态尚未确认，未迁移此浏览器中的匿名资料。请先重新连接，或导出后再恢复。",
        );
        return;
      }
      if (hasMeaningfulWorkspaceContent(session.data)) {
        // A successful migration deliberately leaves the anonymous local copy
        // intact. On a later reload, recognize only an exact normalized match
        // (cloud object paths excluded) as that same copied library. Any edit
        // on either side falls through to the conservative export/recovery
        // state instead of making a new overwrite decision automatically.
        if (
          sameData(withoutAnonymousCloudPaths(session.data), withoutAnonymousCloudPaths(anonymous))
        ) {
          session.anonymousMigration = anonymousMigrationSummary(
            "migrated",
            anonymous,
            "当前账号已包含与此浏览器匿名副本一致的资料；匿名副本仍保留在本机。",
          );
          return;
        }
        session.anonymousMigration = anonymousMigrationSummary(
          "requires-export",
          anonymous,
          "当前账号已有资料，匿名资料不会自动覆盖。请先导出匿名副本，或恢复到空账号后再迁移。",
        );
        return;
      }

      session.anonymousWorkspace = structuredClone(anonymous);
      session.anonymousMigration = anonymousMigrationSummary(
        "pending",
        anonymous,
        "发现此浏览器中的匿名资料。迁移会复制到当前账号，匿名副本仍会保留在本机。",
        true,
      );
    } catch (cause) {
      if (!this.isActive(session)) return;
      session.anonymousWorkspace = null;
      session.anonymousMigration = {
        kind: "unavailable",
        canMigrate: false,
        message: "无法读取此浏览器中的匿名资料，未进行迁移：" + errorText(cause),
      };
    }
  }

  private migrationChoiceBlocksWrites(session: Session): boolean {
    return (
      session.anonymousMigration.kind === "pending" ||
      session.anonymousMigration.kind === "migrating"
    );
  }

  private writesBlocked(session: Session): boolean {
    return (
      this.isCloudReadOnly(session) ||
      this.migrationChoiceBlocksWrites(session) ||
      this.hasNewerLocalUpdate(session) ||
      session.loadingLocalUpdate ||
      session.loadingCloudUpdate
    );
  }

  private importLeaseEnabled(session: Session): boolean {
    return !!(
      session.user &&
      this.io.claimImportParse &&
      this.io.heartbeatImportParse &&
      this.io.releaseImportParse &&
      this.io.finishImportParse
    );
  }

  private hasFencedImportTransition(session: Session): boolean {
    return !!this.importTransitionFences.get(session)?.size;
  }

  private fenceImportTransition(session: Session, jobId: string): void {
    const jobs = this.importTransitionFences.get(session) ?? new Set<string>();
    jobs.add(jobId);
    this.importTransitionFences.set(session, jobs);
  }

  private unfenceImportTransition(session: Session, jobId: string): void {
    const jobs = this.importTransitionFences.get(session);
    if (!jobs) return;
    jobs.delete(jobId);
    if (!jobs.size) this.importTransitionFences.delete(session);
  }

  private clearImportLeaseRetry(session: Session, jobId: string): void {
    const key = this.importKey(session, jobId);
    const timer = this.importLeaseRetries.get(key);
    if (timer) clearTimeout(timer);
    this.importLeaseRetries.delete(key);
  }

  private clearImportLeaseRetries(session: Session): void {
    for (const [key, timer] of this.importLeaseRetries) {
      if (!key.startsWith(`${session.token}:`)) continue;
      clearTimeout(timer);
      this.importLeaseRetries.delete(key);
    }
  }

  private assertWorkspaceWritable(session: Session): void {
    this.assertWritable(session);
    if (session.loadingCloudUpdate)
      throw new Error("正在保存云端更新，请稍后再操作；当前编辑仍会保留。");
    if (this.migrationChoiceBlocksWrites(session))
      throw new Error("请先迁移或暂不迁移此浏览器中的匿名资料。");
    if (this.hasNewerLocalUpdate(session) || session.loadingLocalUpdate)
      throw new Error("另一个标签页已保存更新。请先载入最新数据，再继续编辑。");
  }

  async activate(user: User | null): Promise<void> {
    if (!this.confirmedAccountDeletionUnsubscribe && this.io.subscribeConfirmedAccountDeletions) {
      this.confirmedAccountDeletionUnsubscribe = this.io.subscribeConfirmedAccountDeletions(
        (accountId) => this.discardAccount(accountId),
      );
    }
    const previous = this.active;
    if (previous) this.cloudUpdateTasks.get(previous)?.controller.abort();
    if (
      previous?.localDirty &&
      this.memory.get(accountKey(previous.user)) === previous &&
      !this.migrationChoiceBlocksWrites(previous)
    ) {
      // Capture the outgoing account and its latest edit before changing identity.
      // This is a local-only flush; never upload using the next account's session.
      void this.persist(previous).catch(() => {});
    }
    this.stopLocalCommitSubscription();
    this.stopAccountDeletionSubscription();
    const id = accountKey(user);
    const retained = this.memory.get(id);
    const session: Session = {
      data: createEmptyWorkspace(),
      user,
      status: "loading",
      error: "",
      ready: false,
      recovery: null,
      recoveryRevision: null,
      token: ++this.token,
      localRevision: 0,
      revision: 0,
      knownRevision: false,
      localDirty: false,
      cloudDirty: !!user,
      blocked: null,
      pumping: false,
      checking: false,
      exiting: false,
      confirmedCloud: null,
      anonymousMigration: noAnonymousWorkspaceMigration(),
      anonymousWorkspace: null,
      organizationStatus: { ready: false, running: false, message: "正在读取资料…" },
      purging: false,
      localCacheMode: "normal",
      localUpdateRevision: null,
      loadingLocalUpdate: false,
      cloudUpdateRevision: null,
      checkingCloudUpdate: false,
      loadingCloudUpdate: false,
      cloudUpdateError: "",
      cloudAdoptionSequence: 0,
    };
    this.active = session;
    if (this.cloudOnly) {
      if (!user) {
        this.memory.clear();
        this.io.clearSession?.();
        session.cloudDirty = false;
        session.localDirty = false;
        session.status = "error";
        session.error = "网页版需要登录后访问云端资料库。";
        this.publish(session);
        return;
      }
      this.io.beginSession?.(user.id);
    }
    this.startLocalCommitSubscription(session, id);
    this.publish(session);
    this.startAccountDeletionSubscription(session, id);
    if (user && this.discardedAccounts.has(id)) {
      await this.discardAccount(id).catch(() => {});
      return;
    }
    try {
      await this.checkAccountDeletionMarker(session);
    } catch {
      return;
    }
    if (!this.isActive(session)) return;
    let cached: WorkspaceData | null = null;
    let meta: SyncMeta | null = null;
    let diskLocalRevision = 0;
    let loadError = "";
    // Let outgoing writes to THIS account settle before reading its cache.
    for (;;) {
      const tail = this.queues.get(id);
      await tail;
      await Promise.resolve();
      if (this.queues.get(id) === tail) break;
    }
    if (!this.isActive(session)) return;
    try {
      const disk = unpack(await this.io.loadLocal(id));
      cached = disk.data;
      meta = disk.meta || (user && !this.cloudOnly ? this.io.readLegacyMeta(id) : null);
      diskLocalRevision = disk.localRevision;
      this.setLocalRevision(session, disk.localRevision);
    } catch (cause) {
      loadError = errorText(cause);
    }
    if (!this.isActive(session)) return;
    // Memory wins only when it contains work that is not safely replaceable by
    // a remote snapshot. A clean retained view is not a substitute for a
    // failed IndexedDB read: it must take the cloud-readonly path below.
    const retainedDirty =
      !!retained && (retained.localDirty || retained.cloudDirty || retained.blocked === "conflict");
    if (retainedDirty && retained) {
      cached = retained.data;
      meta = this.syncMeta(retained);
      this.setLocalRevision(session, retained.localRevision);
      if (diskLocalRevision > retained.localRevision)
        session.localUpdateRevision = Math.max(session.localUpdateRevision ?? 0, diskLocalRevision);
      session.confirmedCloud = retained.confirmedCloud
        ? structuredClone(retained.confirmedCloud)
        : null;
      session.localDirty = true;
    }
    if (loadError && !cached) {
      // A failed read is never evidence of an empty cache. For a signed-in
      // account, an already-confirmed remote snapshot remains useful for
      // reading, but must stay strictly read-only until IndexedDB recovers.
      if (user) {
        try {
          const remote = await this.io.loadCloud(user.id);
          if (!this.isActive(session)) return;
          if (remote.data) {
            session.data = structuredClone(remote.data);
            session.revision = remote.revision;
            session.knownRevision = true;
            session.localDirty = false;
            session.cloudDirty = false;
            session.blocked = null;
            session.recovery = null;
            session.recoveryRevision = null;
            session.confirmedCloud = structuredClone(remote.data);
            session.localCacheMode = "cloud-readonly";
            session.ready = true;
            // Do not present this as an ordinary successful save. The remote
            // data is confirmed, but this browser cannot safely edit it.
            session.status = "error";
            session.error =
              "本机副本读取失败：" +
              loadError +
              "。当前仅可查看已确认的云端资料；请重新连接后再编辑、导入或整理。";
            this.publish(session);
            return;
          }
        } catch {
          // Preserve the existing unresolved-cache error below. A failed
          // cloud lookup cannot justify showing or creating an empty library.
        }
        if (!this.isActive(session)) return;
      }
      // Do not replace an unreadable cache with a newly created workspace.
      session.status = "error";
      session.error = "无法读取此浏览器的副本：" + loadError + "。尚未覆盖缓存，请重试。";
      this.publish(session);
      return;
    }
    session.data = cached || createEmptyWorkspace();
    session.revision = meta?.revision ?? 0;
    session.knownRevision = !!meta;
    session.cloudDirty = !!user && (meta?.dirty ?? true);
    session.localDirty ||= !cached || !!loadError;
    // A clean account snapshot is itself the last acknowledged cloud base.
    // While dirty, only a schema-valid base tied to the exact expected
    // revision can authorize an object-level rebase after a refresh.
    if (!session.confirmedCloud && cached && meta) {
      if (!meta.dirty) session.confirmedCloud = structuredClone(cached);
      else if (meta.base && meta.baseRevision === meta.revision)
        session.confirmedCloud = structuredClone(meta.base);
    }

    if (user) {
      try {
        const remote = await this.io.loadCloud(user.id);
        if (!this.isActive(session)) return;
        this.reconcile(session, remote, !!cached);
      } catch (cause) {
        if (!this.isActive(session)) return;
        session.blocked = "error";
        if (this.cloudOnly && !cached) {
          session.ready = false;
          session.localDirty = false;
          session.cloudDirty = false;
          session.status = "error";
          session.error =
            "无法读取云端资料库：" + errorText(cause) + "。请重新连接；未创建本地资料库。";
          this.publish(session);
          return;
        }
        session.error =
          errorText(cause) +
          (this.cloudOnly
            ? " 尚未保存的修改仅暂存在当前页面，请重新连接。"
            : " 修改将继续尝试保存在此浏览器。");
      }
    }
    if (!this.isActive(session)) return;
    session.ready = true;
    await this.discoverAnonymousWorkspaceMigration(session);
    if (!this.isActive(session)) return;
    if (!this.migrationChoiceBlocksWrites(session)) {
      this.recoverOrganizationJobs(session);
      this.recoverImportJobs(session);
    }
    if (loadError) {
      session.error = "本地副本读取失败：" + loadError + "。当前修改尚未确认保存在此浏览器。";
      session.localDirty = true;
    }
    this.remember(session);
    this.publish(session);
    // A pending choice is intentionally a save barrier. Without it, the fresh
    // account's generated default workspace could be uploaded before the user
    // has decided what to do with the anonymous library.
    if (this.migrationChoiceBlocksWrites(session)) return;
    await this.pump(session);
  }

  private reconcile(session: Session, remote: RemoteWorkspace, hasCached: boolean) {
    const dirty = hasCached && session.cloudDirty;
    const transition = dirty ? this.recoverableImportTransition(session, remote) : null;
    if (transition && remote.data) {
      // A prior finish/cancel/retry request may have failed before the server
      // saw it. Keep the staged projection behind an explicit recovery action
      // rather than allowing activation to feed it into save_workspace.
      session.confirmedCloud = structuredClone(remote.data);
      session.revision = remote.revision;
      session.knownRevision = true;
      session.localDirty = true;
      session.cloudDirty = true;
      session.blocked = "error";
      session.recovery = null;
      session.recoveryRevision = null;
      session.error =
        "上一次解析状态变更尚未得到云端确认，已保留本机副本。请点击重新连接继续恢复。";
      return;
    }
    if (dirty && remote.data && !sameData(session.data, remote.data)) {
      const revisionMatches = session.knownRevision && session.revision === remote.revision;
      const baseMatchesRemote =
        !!session.confirmedCloud && sameData(session.confirmedCloud, remote.data);
      // A revision number alone cannot prove that a legacy or damaged cache
      // was edited from this exact remote snapshot. Only an exact persisted
      // base may authorize saving at the same revision.
      if (!revisionMatches || !baseMatchesRemote) {
        if (remote.revision > session.revision && this.adoptSafeWorkspaceConflict(session, remote))
          return;
        session.blocked = "conflict";
        session.recovery = remote.data;
        session.recoveryRevision = remote.revision;
        session.error = "此浏览器的修改与云端版本不同。当前展示本地副本，两个版本均已保留。";
        return;
      }
    } else if (
      dirty &&
      !remote.data &&
      session.knownRevision &&
      session.revision !== remote.revision
    ) {
      session.blocked = "conflict";
      session.recovery = createEmptyWorkspace();
      session.recoveryRevision = remote.revision;
      session.error = "云端工作区已变化，当前本地副本已保留，请选择恢复方式。";
      return;
    }
    // Keep the last acknowledged cloud snapshot as the common base for a
    // later object-level conflict resolution. In the conflict branches above,
    // `remote` is only a candidate recovery copy and must not overwrite it.
    session.confirmedCloud = remote.data ? structuredClone(remote.data) : null;
    if (!dirty || (remote.data && sameData(session.data, remote.data))) {
      session.data = remote.data || session.data;
      session.cloudDirty = !remote.data;
    }
    // A missing remote snapshot must first be PUT and acknowledged. Merely
    // receiving revision 0 is never displayed as "saved to cloud".
    session.revision = remote.revision;
    session.knownRevision = true;
    session.localDirty = true;
    session.blocked = null;
    session.recovery = null;
    session.recoveryRevision = null;
    session.error = "";
  }

  private adoptReadingProgressConflict(session: Session, remote: RemoteWorkspace): boolean {
    if (!remote.data) return false;
    const merged = mergeReadingProgressConflict(session.data, remote.data, session.confirmedCloud);
    if (!merged) return false;
    session.data = merged;
    session.confirmedCloud = structuredClone(remote.data);
    session.revision = remote.revision;
    session.knownRevision = true;
    session.localDirty = true;
    session.cloudDirty = !sameData(merged, remote.data);
    session.blocked = null;
    session.recovery = null;
    session.recoveryRevision = null;
    session.error = "";
    return true;
  }

  private adoptIndependentWorkspaceConflict(session: Session, remote: RemoteWorkspace): boolean {
    if (!remote.data || !session.confirmedCloud) return false;
    const merged = rebaseIndependentWorkspaceChanges(
      session.data,
      remote.data,
      session.confirmedCloud,
    );
    if (!merged) return false;
    session.data = merged;
    session.confirmedCloud = structuredClone(remote.data);
    session.revision = remote.revision;
    session.knownRevision = true;
    session.localDirty = true;
    session.cloudDirty = !sameData(merged, remote.data);
    session.blocked = null;
    session.recovery = null;
    session.recoveryRevision = null;
    session.error = "";
    return true;
  }

  private adoptSafeWorkspaceConflict(session: Session, remote: RemoteWorkspace): boolean {
    return (
      this.adoptReadingProgressConflict(session, remote) ||
      this.adoptIndependentWorkspaceConflict(session, remote)
    );
  }

  /**
   * Explicitly copies the anonymous browser workspace into an otherwise empty
   * signed-in account. This never deletes or rewrites the `local` workspace.
   */
  async migrateAnonymousWorkspace(token: number): Promise<void> {
    const session = this.active;
    if (
      !session?.user ||
      !session.ready ||
      session.token !== token ||
      session.anonymousMigration.kind !== "pending"
    )
      throw new Error("当前账号或匿名资料已改变，请重新检查迁移提示。");
    this.assertWritable(session);
    const userId = session.user.id;
    const initial = {
      data: session.data,
      revision: session.revision,
      knownRevision: session.knownRevision,
      localDirty: session.localDirty,
      cloudDirty: session.cloudDirty,
      blocked: session.blocked,
      recovery: session.recovery,
      recoveryRevision: session.recoveryRevision,
      confirmedCloud: session.confirmedCloud,
      status: session.status,
      error: session.error,
    };
    const pending = session.anonymousMigration;
    const restorePending = (message: string) => {
      if (!this.isActive(session) || session.user?.id !== userId || session.token !== token) return;
      session.data = initial.data;
      session.revision = initial.revision;
      session.knownRevision = initial.knownRevision;
      session.localDirty = initial.localDirty;
      session.cloudDirty = initial.cloudDirty;
      session.blocked = initial.blocked;
      session.recovery = initial.recovery;
      session.recoveryRevision = initial.recoveryRevision;
      session.confirmedCloud = initial.confirmedCloud;
      session.ready = true;
      session.status = "error";
      session.error = message;
      session.anonymousMigration = {
        ...pending,
        kind: "pending",
        canMigrate: true,
        message: "匿名资料仍保留在本机；迁移前检查未完成，可在问题解决后重新尝试。",
      };
      this.remember(session);
      this.publish(session);
    };

    // Freeze ordinary writes before reading the current account again. The
    // rechecks below are intentionally fresh: the discovery result alone is
    // never permission to overwrite a library changed in another tab/device.
    session.ready = false;
    session.status = "saving";
    session.error = "";
    session.anonymousMigration = { ...pending, kind: "migrating", canMigrate: false };
    this.publish(session);

    let targetLocal: WorkspaceData | null;
    let remote: RemoteWorkspace;
    let anonymous: WorkspaceData | null;
    try {
      const [localStored, loadedRemote, anonymousStored] = await Promise.all([
        this.io.loadLocal(userId),
        this.io.loadCloud(userId),
        this.io.loadLocal("local"),
      ]);
      targetLocal = unpack(localStored).data;
      remote = loadedRemote;
      anonymous = unpack(anonymousStored).data;
    } catch (cause) {
      if (!this.isActive(session) || session.user?.id !== userId || session.token !== token) return;
      const message = "迁移前无法确认本机或云端副本：" + errorText(cause) + "。未迁移任何资料。";
      restorePending(message);
      throw new Error(message);
    }
    if (!this.isActive(session) || session.user?.id !== userId || session.token !== token) return;

    if (!anonymous || !hasMeaningfulWorkspaceContent(anonymous)) {
      session.ready = true;
      session.anonymousWorkspace = null;
      session.anonymousMigration = noAnonymousWorkspaceMigration();
      session.status = initial.status;
      session.error = "";
      this.remember(session);
      this.publish(session);
      await this.pump(session);
      throw new Error("此浏览器中的匿名资料已不可用，未迁移任何资料。");
    }

    if (
      hasMeaningfulWorkspaceContent(session.data) ||
      (!!targetLocal && hasMeaningfulWorkspaceContent(targetLocal)) ||
      (!!remote.data && hasMeaningfulWorkspaceContent(remote.data))
    ) {
      session.ready = true;
      session.anonymousWorkspace = structuredClone(anonymous);
      session.anonymousMigration = anonymousMigrationSummary(
        "requires-export",
        anonymous,
        "当前账号已有资料，匿名资料不会自动覆盖。请先导出匿名副本，或恢复到空账号后再迁移。",
      );
      session.status = "error";
      session.error = "当前账号已有资料，未迁移匿名副本。";
      this.remember(session);
      this.publish(session);
      throw new Error(session.error);
    }

    // Only this explicit local-library action can share local-owner originals.
    // Cloud references and ordinary account snapshots cannot grant this access.
    if (this.io.shareAnonymousOriginals) {
      try {
        await this.io.shareAnonymousOriginals(
          userId,
          anonymous.sources.flatMap((source) =>
            [source, ...(source.versions ?? [])].flatMap((version) =>
              version.blobKey ? [version.blobKey] : [],
            ),
          ),
        );
      } catch (cause) {
        if (!this.isActive(session) || session.user?.id !== userId || session.token !== token)
          return;
        const message =
          "匿名原件迁移未得到本机确认：" + errorText(cause) + "。匿名副本仍保留，可重试。";
        restorePending(message);
        throw new Error(message);
      }
      if (!this.isActive(session) || session.user?.id !== userId || session.token !== token) return;
    }
    const migrated = withoutAnonymousCloudPaths(anonymous);
    session.data = migrated;
    session.revision = remote.revision;
    session.knownRevision = true;
    session.localDirty = true;
    session.cloudDirty = true;
    session.blocked = null;
    session.recovery = null;
    session.recoveryRevision = null;
    session.confirmedCloud = remote.data ? structuredClone(remote.data) : null;
    try {
      await this.persist(session);
    } catch (cause) {
      if (!this.isActive(session) || session.user?.id !== userId || session.token !== token) return;
      const message =
        "匿名资料副本尚未确认保存在当前账号：" + errorText(cause) + "。未开始云端同步。";
      restorePending(message);
      throw new Error(message);
    }
    if (!this.isActive(session) || session.user?.id !== userId || session.token !== token) return;

    session.ready = true;
    session.status = "saving";
    session.error = "";
    session.anonymousWorkspace = null;
    session.anonymousMigration = {
      ...anonymousMigrationSummary(
        "migrated",
        migrated,
        "匿名资料已复制到当前账号的本机副本，正在等待云端确认。匿名副本仍保留在此浏览器。",
      ),
      pendingCloudConfirmation: true,
    };
    this.recoverOrganizationJobs(session);
    this.recoverImportJobs(session);
    this.remember(session);
    this.publish(session);
    await this.pump(session);
  }

  /** Keeps the anonymous copy untouched and resumes normal empty-account setup. */
  async skipAnonymousWorkspaceMigration(token: number): Promise<void> {
    const session = this.active;
    if (!session?.user || !session.ready || session.token !== token)
      throw new Error("当前账号已改变，请重新检查匿名资料迁移提示。");
    this.assertWritable(session);
    if (session.anonymousMigration.kind !== "pending") return;
    session.anonymousWorkspace = null;
    session.anonymousMigration = {
      ...session.anonymousMigration,
      kind: "dismissed",
      canMigrate: false,
      message: "已暂不迁移。匿名资料仍保留在此浏览器，之后重新登录时可再次处理。",
    };
    this.remember(session);
    this.publish(session);
    await this.pump(session);
  }

  private applyUpdate(
    updater: (data: WorkspaceData) => WorkspaceData,
    token: number,
  ): { session: Session; data: WorkspaceData } | null {
    const session = this.active;
    if (
      !session?.ready ||
      session.exiting ||
      session.token !== token ||
      this.readingConflictResolutions.has(session) ||
      this.isCloudReadOnly(session) ||
      this.migrationChoiceBlocksWrites(session)
    )
      return null;
    const next = updater(session.data);
    if (next === session.data) return null;
    const protectedMutation = this.protectedImportMutation(session, next);
    if (protectedMutation) {
      session.error = protectedMutation;
      this.publish(session);
      return null;
    }
    session.data = next;
    session.localDirty = true;
    if (session.user) session.cloudDirty = true;
    this.remember(session);
    return { session, data: next };
  }

  update(updater: (data: WorkspaceData) => WorkspaceData, token: number): boolean {
    const applied = this.applyUpdate(updater, token);
    if (!applied) return false;
    const { session } = applied;
    this.publish(session);
    void this.pump(session);
    return true;
  }

  /**
   * Publishes one atomic workspace mutation immediately, but resolves only
   * after that exact snapshot and its current sync metadata reach IndexedDB.
   * Cloud persistence remains asynchronous and is represented by the normal
   * save status, so callers must not treat resolution as cloud confirmation.
   */
  async updateDurably(
    updater: (data: WorkspaceData) => WorkspaceData,
    token: number,
  ): Promise<boolean> {
    const applied = this.applyUpdate(updater, token);
    if (!applied) return false;
    const { session } = applied;
    // Enqueue before publishing. A synchronous listener may issue another
    // update; it must be ordered after this operation instead of allowing an
    // older durable snapshot to overwrite the newer one.
    const localWrite = this.persist(session);
    session.status = "saving";
    this.publish(session);
    try {
      await localWrite;
    } catch (cause) {
      if (!this.isActive(session) || session.token !== token)
        throw new Error("当前账号已改变，无法确认本次操作仍属于当前工作区。");
      session.status = "error";
      session.error =
        "操作结果尚未保存到此浏览器：" +
        errorText(cause) +
        "。修改仍保留在当前页面，请重试或导出后再离开。";
      this.remember(session);
      this.publish(session);
      throw new Error(session.error);
    }
    if (!this.isActive(session) || session.token !== token)
      throw new Error("当前账号已改变，请切回原工作区检查本次操作结果。");
    if (this.cloudOnly) await this.confirmWebCloudSave(session);
    else void this.pump(session);
    return true;
  }

  private assertPurgeReady(session: Session, sourceId: string, token: number): Source {
    this.assertWorkspaceWritable(session);
    if (!this.isActive(session) || !session.user || !session.ready || session.token !== token)
      throw new Error("当前账号已改变，请重新打开回收站后再操作。");
    if (session.purging) throw new Error("这份资料正在彻底删除，请等待当前操作完成后再继续。");
    if (
      session.pumping ||
      session.checking ||
      session.localDirty ||
      session.cloudDirty ||
      session.blocked ||
      !session.knownRevision ||
      !session.confirmedCloud ||
      !sameData(session.data, session.confirmedCloud)
    )
      throw new Error("请等待当前资料同步完成，再查看彻底删除的影响范围。");
    if (
      this.aiBusy(token) ||
      [...this.pendingImports.values()].some((pending) => pending.session === session) ||
      this.queuedImports.some((pending) => pending.session === session)
    )
      throw new Error("请等待当前问答、整理或导入结束后再彻底删除资料。");
    const source = session.data.sources.find((item) => item.id === sourceId);
    if (!source?.deletedAt) throw new Error("请先将资料移入回收站，再执行彻底删除。");
    return source;
  }

  private assertSourceVersionPurgeReady(
    session: Session,
    sourceId: string,
    versionId: string,
    token: number,
  ): { source: Source; version: NonNullable<Source["versions"]>[number] } {
    this.assertWorkspaceWritable(session);
    if (!this.isActive(session) || !session.user || !session.ready || session.token !== token)
      throw new Error("当前账号已改变，请重新打开版本记录后再操作。");
    if (session.purging) throw new Error("正在清理资料版本，请等待当前操作完成后再继续。");
    if (
      session.pumping ||
      session.checking ||
      session.localDirty ||
      session.cloudDirty ||
      session.blocked ||
      !session.knownRevision ||
      !session.confirmedCloud ||
      !sameData(session.data, session.confirmedCloud)
    )
      throw new Error("请等待资料同步完成，再查看历史版本清理的影响范围。");
    if (
      this.aiBusy(token) ||
      [...this.pendingImports.values()].some((pending) => pending.session === session) ||
      this.queuedImports.some((pending) => pending.session === session)
    )
      throw new Error("请等待当前问答、整理或导入结束后再清理历史版本。");
    const source = session.data.sources.find((item) => item.id === sourceId);
    if (!source || source.deletedAt) throw new Error("这份资料已不可用，请返回资料库检查。");
    if (source.versionId === versionId)
      throw new Error("当前版本不能单独清理，请先恢复其他版本或彻底删除资料。");
    const versions = source.versions?.filter((item) => item.versionId === versionId) ?? [];
    if (versions.length !== 1) throw new Error("这个历史版本已改变，请刷新版本记录后重试。");
    return { source, version: versions[0] };
  }

  /** The server owns the preview so browser state cannot omit a dependency. */
  async previewSourcePurge(
    sourceId: string,
    token: number,
    selection?: PermanentSourceDeletionSelection,
    signal?: AbortSignal,
  ): Promise<SourcePurgePreview> {
    const session = this.active;
    if (!session) throw new Error("当前账号已改变，请重新打开回收站后再操作。");
    const source = this.assertPurgeReady(session, sourceId, token);
    if (signal?.aborted) throw new Error("删除范围核对已停止，请重新核对后再确认。");
    const choices =
      selection === undefined
        ? undefined
        : previewPermanentSourceDeletionContent(session.data, sourceId, selection).selection;
    if (!this.io.previewSourcePurge)
      throw new Error("当前云端尚未支持彻底删除，请完成数据库迁移后重试。");
    const snapshot = session.data;
    const revision = session.revision;
    const preview =
      choices === undefined && signal === undefined
        ? await this.io.previewSourcePurge(source.id, session.user!.id)
        : await this.io.previewSourcePurge(source.id, session.user!.id, choices, signal);
    if (signal?.aborted) throw new Error("删除范围核对已停止，请重新核对后再确认。");
    if (
      !this.isActive(session) ||
      session.data !== snapshot ||
      session.revision !== revision ||
      session.purging
    )
      throw new Error("资料或账号已改变，请重新查看彻底删除的影响范围。");
    if (preview.revision !== revision || preview.impact.source.id !== source.id)
      throw new Error("云端资料已变化，请重新查看彻底删除的影响范围。");
    if (
      choices &&
      (!preview.contentSelection ||
        !sameSourcePurgeSelection(preview.contentSelection.selection, choices))
    )
      throw new Error("云端核对范围与删除选择不一致，请重新查看后再确认。");
    if (
      !choices &&
      preview.contentSelection &&
      (preview.contentSelection.selection.noteIds.length ||
        preview.contentSelection.selection.conversationIds.length)
    )
      throw new Error("默认预览不能预选另存内容，请重新核对删除范围。");
    return preview;
  }

  /**
   * Do not route this through the regular snapshot pump. The database makes
   * the metadata change atomically, then this coordinator persists exactly
   * that returned snapshot before it considers any local original removable.
   */
  async purgeSource(sourceId: string, preview: SourcePurgePreview, token: number): Promise<void> {
    const session = this.active;
    if (!session) throw new Error("当前账号已改变，请重新打开回收站后再操作。");
    const source = this.assertPurgeReady(session, sourceId, token);
    if (!this.io.requestSourcePurge)
      throw new Error("当前云端尚未支持彻底删除，请完成数据库迁移后重试。");
    if (preview.revision !== session.revision || preview.impact.source.id !== source.id)
      throw new Error("删除影响范围已过期，请重新查看后再确认。");
    if (preview.blockers.annotations.length || preview.blockers.conceptRelations.length)
      throw new Error("所选范围仍有需要另存或明确删除的批注／手工关系，请先处理后重新核对。");
    let choices: PermanentSourceDeletionSelection | undefined;
    if (preview.contentSelection) {
      const parsed = sourcePurgeSelectionSchema.safeParse(preview.contentSelection.selection);
      if (!parsed.success) throw new Error("删除选择格式已改变，请重新核对影响范围。");
      choices = previewPermanentSourceDeletionContent(
        session.data,
        sourceId,
        parsed.data,
      ).selection;
    }
    const userId = session.user!.id;
    const localKeys = originalKeys(source);
    session.purging = true;
    session.ready = false;
    session.status = "saving";
    session.error = "";
    this.remember(session);
    // A disabled session rejects late import/AI writes while the server holds
    // its deletion transaction. We only enter this state when no regular pump
    // or async write is already in flight.
    this.publish(session);
    try {
      const args = [source.id, session.revision, preview.fingerprint, userId] as const;
      const result = choices
        ? await this.io.requestSourcePurge(...args, structuredClone(choices))
        : await this.io.requestSourcePurge(...args);
      if (!this.isActive(session) || session.user?.id !== userId)
        throw new Error("账号已改变，云端资料已刷新；请重新打开当前账号的资料库。");
      if (result.data.sources.some((item) => item.id === source.id))
        throw new Error("云端彻底删除结果不完整，已暂停同步，请刷新资料库后重试。");
      if (
        result.revision <= session.revision ||
        (choices &&
          (choices.noteIds.some((id) => result.data.notes.some((note) => note.id === id)) ||
            choices.conversationIds.some((id) =>
              result.data.conversations.some((conversation) => conversation.id === id),
            )))
      )
        throw new Error("云端所选内容的删除结果尚未确认，已暂停同步，请刷新资料库后重试。");
      session.data = result.data;
      session.confirmedCloud = structuredClone(result.data);
      session.revision = result.revision;
      session.knownRevision = true;
      session.localDirty = true;
      session.cloudDirty = false;
      session.blocked = null;
      session.recovery = null;
      session.recoveryRevision = null;
      this.remember(session);
      try {
        // Keeping ready=false here prevents a late editor callback from writing
        // the former source while IndexedDB still contains the old snapshot.
        await this.persist(session);
      } catch (cause) {
        if (!this.isActive(session) || session.user?.id !== userId)
          throw new PurgeLocalPersistenceError(
            "账号已改变；云端已完成彻底删除，但原账号新的本机副本未能确认保存：" +
              errorText(cause) +
              "。请重新打开原账号核对并重试保存。",
          );
        session.purging = false;
        session.ready = true;
        session.blocked = "error";
        session.status = "error";
        session.error =
          "云端已完成彻底删除，但新的本地副本尚未保存：" +
          errorText(cause) +
          "。已暂停同步，请先重试保存。";
        this.remember(session);
        this.publish(session);
        throw new PurgeLocalPersistenceError(session.error);
      }
      if (!this.isActive(session) || session.user?.id !== userId)
        throw new Error("账号已改变，云端已完成彻底删除；请重新打开原账号查看结果。");
      session.purging = false;
      session.ready = true;
      session.status = "cloud";
      session.error = result.cleanupPending
        ? "资料元数据已彻底删除；云端原件正在后台清理。"
        : "资料已彻底删除。";
      this.remember(session);
      this.publish(session);
      for (const key of localKeys) {
        if (this.referencesBlob(key) || !this.io.deleteUnreferencedBlob) continue;
        try {
          await this.deleteLocalOriginal(session, key);
        } catch {
          // The deletion is already durable. A future reference-safe cleanup
          // may retry; never report a physical local cleanup we cannot prove.
        }
        if (!this.isActive(session) || session.user?.id !== userId)
          throw new Error("账号已改变，云端已完成彻底删除；请重新打开原账号查看结果。");
      }
      if (!this.isActive(session) || session.user?.id !== userId)
        throw new Error("账号已改变，云端已完成彻底删除；请重新打开原账号查看结果。");
    } catch (cause) {
      if (!this.isActive(session)) throw cause;
      // The server has already returned its committed snapshot. Preserve the
      // more precise local-persistence state instead of downgrading it to an
      // ambiguous network outcome.
      if (cause instanceof PurgeLocalPersistenceError) throw cause;
      session.purging = false;
      session.ready = true;
      session.blocked = "error";
      session.status = "error";
      session.error =
        "无法确认云端是否已完成彻底删除，已暂停同步。" +
        errorText(cause) +
        " 请刷新资料库后再继续。";
      this.remember(session);
      this.publish(session);
      throw cause;
    }
  }

  /**
   * The server owns the exact dependency preview. A historical version cannot be
   * removed locally because its normalized chunks and Storage object must follow the
   * same transaction and cleanup outbox as the browser snapshot.
   */
  async previewSourceVersionPurge(
    sourceId: string,
    versionId: string,
    token: number,
  ): Promise<SourceVersionPurgePreview> {
    const session = this.active;
    if (!session) throw new Error("当前账号已改变，请重新打开版本记录后再操作。");
    const target = this.assertSourceVersionPurgeReady(session, sourceId, versionId, token);
    if (!this.io.previewSourceVersionPurge)
      throw new Error("当前云端尚未支持历史版本清理，请完成数据库迁移后重试。");
    const snapshot = session.data;
    const revision = session.revision;
    const preview = await this.io.previewSourceVersionPurge(
      target.source.id,
      target.version.versionId,
      session.user!.id,
    );
    if (
      !this.isActive(session) ||
      session.data !== snapshot ||
      session.revision !== revision ||
      session.purging
    )
      throw new Error("资料版本或账号已改变，请重新查看历史版本清理的影响范围。");
    if (
      preview.revision !== revision ||
      preview.impact.source.id !== target.source.id ||
      preview.impact.version.versionId !== target.version.versionId
    )
      throw new Error("云端资料版本已变化，请重新查看历史版本清理的影响范围。");
    return preview;
  }

  async purgeSourceVersion(
    sourceId: string,
    versionId: string,
    preview: SourceVersionPurgePreview,
    token: number,
  ): Promise<void> {
    const session = this.active;
    if (!session) throw new Error("当前账号已改变，请重新打开版本记录后再操作。");
    const target = this.assertSourceVersionPurgeReady(session, sourceId, versionId, token);
    if (!this.io.requestSourceVersionPurge)
      throw new Error("当前云端尚未支持历史版本清理，请完成数据库迁移后重试。");
    if (
      preview.revision !== session.revision ||
      preview.impact.source.id !== target.source.id ||
      preview.impact.version.versionId !== target.version.versionId
    )
      throw new Error("历史版本清理影响范围已过期，请重新查看后再确认。");
    const userId = session.user!.id;
    const localKeys = target.version.blobKey ? [target.version.blobKey] : [];
    session.purging = true;
    session.ready = false;
    session.status = "saving";
    session.error = "";
    this.remember(session);
    this.publish(session);
    try {
      const result = await this.io.requestSourceVersionPurge(
        target.source.id,
        target.version.versionId,
        session.revision,
        preview.fingerprint,
        userId,
      );
      if (!this.isActive(session) || session.user?.id !== userId)
        throw new Error("账号已改变，云端资料已刷新；请重新打开当前账号的资料库。");
      const source = result.data.sources.find((item) => item.id === target.source.id);
      if (
        !source ||
        source.versionId !== target.source.versionId ||
        source.versions?.some((item) => item.versionId === target.version.versionId)
      )
        throw new Error("云端历史版本清理结果不完整，已暂停同步，请刷新资料库后重试。");
      session.data = result.data;
      session.confirmedCloud = structuredClone(result.data);
      session.revision = result.revision;
      session.knownRevision = true;
      session.localDirty = true;
      session.cloudDirty = false;
      session.blocked = null;
      session.recovery = null;
      session.recoveryRevision = null;
      this.remember(session);
      try {
        await this.persist(session);
      } catch (cause) {
        if (!this.isActive(session)) return;
        session.purging = false;
        session.ready = true;
        session.blocked = "error";
        session.status = "error";
        session.error =
          "云端已完成历史版本清理，但新的本地副本尚未保存：" +
          errorText(cause) +
          "。已暂停同步，请先重试保存。";
        this.remember(session);
        this.publish(session);
        throw new PurgeLocalPersistenceError(session.error);
      }
      if (!this.isActive(session)) return;
      session.purging = false;
      session.ready = true;
      session.status = "cloud";
      session.error = result.cleanupPending
        ? "历史版本元数据已清理；云端原件正在后台清理。"
        : "历史版本已清理。";
      this.remember(session);
      this.publish(session);
      for (const key of localKeys) {
        if (this.referencesBlob(key) || !this.io.deleteUnreferencedBlob) continue;
        try {
          await this.deleteLocalOriginal(session, key);
        } catch {
          // The cloud metadata is durable. A later reference-safe cleanup may retry.
        }
      }
    } catch (cause) {
      if (!this.isActive(session)) throw cause;
      if (cause instanceof PurgeLocalPersistenceError) throw cause;
      session.purging = false;
      session.ready = true;
      session.blocked = "error";
      session.status = "error";
      session.error =
        "无法确认云端是否已完成历史版本清理，已暂停同步。" +
        errorText(cause) +
        " 请刷新资料库后再继续。";
      this.remember(session);
      this.publish(session);
      throw cause;
    }
  }

  private referencesBlob(key: string): boolean {
    const sessions = new Set([...this.memory.values(), ...(this.active ? [this.active] : [])]);
    return [...sessions].some((session) =>
      [session.data, session.confirmedCloud, session.recovery].some((data) =>
        data?.sources.some(
          (source) =>
            source.blobKey === key || source.versions?.some((version) => version.blobKey === key),
        ),
      ),
    );
  }

  async replaceFile(
    sourceId: string,
    expectedVersionId: string,
    candidate: Source,
    blob: Blob,
    token: number,
  ): Promise<void> {
    const session = this.active;
    if (!session?.ready || session.token !== token)
      throw new Error("当前账号已改变，请重新打开文件替换面板。");
    this.assertWorkspaceWritable(session);
    const prepared = structuredClone(candidate);
    const validate = () => {
      if (!this.isActive(session) || !session.ready)
        throw new Error("当前账号已改变，请重新打开文件替换面板。");
      return replaceFileSource(session.data, sourceId, expectedVersionId, prepared);
    };
    validate();
    const key = prepared.blobKey!;
    if (!this.io.putBlobIfAbsent || !this.io.deleteUnreferencedBlob)
      throw new Error("当前环境无法安全保存替换原件，请重新载入后重试。原资料未修改。");
    if (pendingFileKeys.has(key)) throw new Error("这个文件正在保存，请等待完成，勿重复提交。");
    if (this.referencesBlob(key))
      throw new Error("新文件原件标识已被使用，请重新选择文件，避免覆盖已有原件。");
    pendingFileKeys.add(key);
    let created = false;
    let applied = false;
    let attemptedWrite = false;
    try {
      await verifyOriginal(prepared, blob);
      validate();
      attemptedWrite = true;
      created = await this.putLocalOriginal(session, key, blob);
      if (!created) {
        const existing = await this.readLocalOriginal(session, key);
        if (existing) await verifyOriginal(prepared, existing);
        throw new Error("这个原件标识已经存在，请重新选择文件生成新预览。已有原件未被覆盖。");
      }
      // Read back the immutable reservation before publishing a workspace that
      // depends on it. A failed write must never create a dangling current page.
      const persisted = await this.readLocalOriginal(session, key);
      if (!persisted) throw new Error("替换原件尚未确认保存在此浏览器，原资料未修改。");
      await verifyOriginal(prepared, persisted);
      validate();
      // Saving and reading back the immutable original can take long enough for
      // another tab to commit a newer workspace. Recheck that boundary before
      // publishing replacement metadata from this page's now-stale snapshot.
      this.assertWorkspaceWritable(session);
      const durableWrite = this.updateDurably(
        (data) => replaceFileSource(data, sourceId, expectedVersionId, prepared),
        token,
      );
      // updateDurably applies synchronously before awaiting IndexedDB. Read the
      // live references now so a later local-write failure keeps an original
      // already adopted by the in-memory recovery snapshot.
      applied = this.referencesBlob(key);
      if (!(await durableWrite))
        throw new Error(session.error || "当前资料正在解析或账号已改变，原资料未修改。");
      // A successful replacement promise now means its metadata is durable in
      // IndexedDB. Cloud upload still follows the ordinary background status.
    } catch (cause) {
      let cleanup = "";
      if (!applied && created) {
        try {
          const stored = await this.readLocalOriginal(session, key);
          if (stored) await verifyOriginal(prepared, stored);
          if (this.referencesBlob(key) || !(await this.deleteLocalOriginal(session, key)))
            cleanup = " 暂存原件可能仍被引用，已保留，未清理。";
        } catch {
          cleanup = " 无法确认暂存原件可安全删除，已保留，未清理。";
        }
      } else if (!applied && attemptedWrite && !created) {
        cleanup = " 未确认由本次操作创建的原件均未清理。";
      }
      const message =
        !this.isActive(session) || !session.ready
          ? "当前账号已改变，未将此次文件替换写入新账号。"
          : errorText(cause);
      throw new Error(message + cleanup);
    } finally {
      pendingFileKeys.delete(key);
    }
  }

  /** Resolves after the added copy is persisted locally; cloud sync keeps its usual status. */
  async restoreBackup(plan: RestorePlan, token: number): Promise<void> {
    const session = this.active;
    if (!session?.ready || session.token !== token)
      throw new Error("当前账号已改变，请重新打开备份恢复面板。");
    this.assertWorkspaceWritable(session);
    const key = JSON.stringify([session.token, plan.id]);
    const pending = this.pendingBackupRestores.get(key);
    if (pending) {
      if (pending.fingerprint !== plan.fingerprint)
        throw new Error("备份确认内容已改变，请重新选择备份文件。");
      return pending.promise;
    }
    const prepared = structuredClone(plan);
    const promise = (async () => {
      await this.commitBackupRestore(prepared, session);
      if (this.cloudOnly) {
        await this.confirmWebCloudSave(session);
        if (
          !session.confirmedCloud ||
          mergeBackupRestore(session.confirmedCloud, prepared) !== session.confirmedCloud
        )
          throw new Error("恢复副本尚未得到云端确认，请保留旧版备份并重试当前恢复计划。");
      }
    })();
    this.pendingBackupRestores.set(key, { fingerprint: prepared.fingerprint, promise });
    try {
      await promise;
    } finally {
      if (this.pendingBackupRestores.get(key)?.promise === promise)
        this.pendingBackupRestores.delete(key);
    }
  }

  private async commitBackupRestore(plan: RestorePlan, session: Session): Promise<void> {
    const validate = () => {
      if (!this.isActive(session) || !session.ready)
        throw new Error("当前账号已改变，未将备份副本写入新账号。");
      this.assertWorkspaceWritable(session);
      return mergeBackupRestore(session.data, plan);
    };
    const confirmPresent = () => {
      if (validate() !== session.data)
        throw new BackupRestoreContextError(
          "恢复副本已从当前工作区移出，无法确认本次恢复完成；请检查当前副本或重新恢复。已保存原件不会被清理。",
        );
    };
    if (
      plan.data.sources.some((source) => source.aiAllowed) ||
      plan.data.organizationJobs?.some((job) => ["queued", "running"].includes(job.status))
    )
      throw new Error("备份副本不能继承 AI 授权或正在执行的任务，请重新生成恢复预览。");
    const versions = plan.data.sources.flatMap((source) =>
      [source, ...(source.versions ?? [])].map((version) => ({ source, version })),
    );
    const entries = plan.blobs.map((entry) => {
      const source = plan.data.sources.find((item) => item.id === entry.sourceId);
      const version = source && getSourceVersion(source, entry.versionId);
      if (
        !version ||
        entry.key !== version.blobKey ||
        entry.key !== `original:${entry.sourceId}:${entry.versionId}`
      )
        throw new Error("备份原件与恢复版本不一致，请重新选择备份文件。");
      return { ...entry, version };
    });
    if (
      new Set(entries.map((entry) => entry.key)).size !== entries.length ||
      versions.some(
        ({ source, version }) =>
          version.storagePath !== undefined ||
          (version.blobKey &&
            !entries.some(
              (entry) =>
                entry.sourceId === source.id &&
                entry.versionId === version.versionId &&
                entry.key === version.blobKey,
            )),
      )
    )
      throw new Error("备份包含未重映射的云路径或缺失的原件，请重新生成恢复预览。");
    const initial = validate();
    if (initial === session.data) {
      // A previous attempt may have published the copy but failed its local write.
      // The pure merge preserves subsequent edits and detects partial ID collisions.
      await this.confirmBackupLocal(session);
      confirmPresent();
      void this.pump(session);
      return;
    }
    if (entries.length && (!this.io.putBlobIfAbsent || !this.io.deleteUnreferencedBlob))
      throw new Error("当前环境无法安全保存备份原件，请重新载入后重试。现有资料未修改。");
    if (entries.some((entry) => pendingFileKeys.has(entry.key) || this.referencesBlob(entry.key)))
      throw new Error("恢复原件标识正在使用，请重新生成恢复预览。已有原件未被覆盖。");
    const created = new Set<string>();
    const attempted = new Set<string>();
    let applied = false;
    entries.forEach((entry) => pendingFileKeys.add(entry.key));
    try {
      // Verify all bytes before the first write; ZIP parsing itself never persists files.
      for (const entry of entries) {
        await verifyOriginal(entry.version, entry.blob);
        validate();
      }
      for (const entry of entries) {
        attempted.add(entry.key);
        const added = await this.putLocalOriginal(session, entry.key, entry.blob);
        if (!added) throw new Error("恢复原件标识已经存在，请重新生成恢复预览。已有原件未被覆盖。");
        created.add(entry.key);
        validate();
        const stored = await this.readLocalOriginal(session, entry.key);
        if (!stored) throw new Error("备份原件尚未确认保存在此浏览器，现有资料未修改。");
        await verifyOriginal(entry.version, stored);
        validate();
      }
      // Hashing and IndexedDB may have yielded to an editor or another import.
      // Recheck capacity and append to the latest data, never the preview snapshot.
      applied = this.update((current) => mergeBackupRestore(current, plan), session.token);
      if (!applied) throw new Error("当前账号已改变，未将备份副本写入新账号。");
      await this.confirmBackupLocal(session);
      confirmPresent();
      void this.pump(session);
    } catch (cause) {
      let cleanup = "";
      if (!applied) {
        if (attempted.size > created.size)
          cleanup = " 未确认由本次操作创建的原件均已保留，未清理。";
        for (const entry of entries) {
          if (!created.has(entry.key)) continue;
          try {
            const stored = await this.readLocalOriginal(session, entry.key);
            if (stored) await verifyOriginal(entry.version, stored);
            if (
              this.referencesBlob(entry.key) ||
              !(await this.deleteLocalOriginal(session, entry.key))
            )
              cleanup = " 无法确认可安全清理的暂存原件已保留。";
          } catch {
            cleanup = " 无法确认可安全清理的暂存原件已保留。";
          }
        }
      }
      const message =
        cause instanceof BackupRestoreContextError
          ? cause.message
          : !this.isActive(session) || !session.ready
            ? "当前账号已改变，未将备份副本写入新账号；已加入原账号的副本仍按原保存队列保留。"
            : applied
              ? "备份副本已加入，但本机保存尚未确认，请重试。原件和当前修改仍然保留。 " +
                errorText(cause)
              : errorText(cause);
      throw new Error(message + cleanup);
    } finally {
      entries.forEach((entry) => pendingFileKeys.delete(entry.key));
    }
  }

  private async confirmBackupLocal(session: Session): Promise<void> {
    try {
      await this.persist(session);
    } catch (cause) {
      if (this.isActive(session)) {
        session.status = session.blocked || "error";
        session.error =
          "备份副本尚未确认保存在此浏览器，请重试；原件和当前修改仍然保留。 " + errorText(cause);
        this.publish(session);
      }
      throw cause;
    }
  }

  /**
   * A failed HTTP exchange is not proof that the database rejected the write.
   * Read the authoritative snapshot once before asking the user to retry. This
   * method never resends the PUT: an unchanged remote stays dirty and blocked,
   * while a different newer remote is preserved for the normal conflict UI.
   */
  private async readBackUnconfirmedWorkspaceSave(
    session: Session,
    sent: WorkspaceData,
    expectedRevision: number,
    saveCause: unknown,
  ): Promise<boolean> {
    const userId = session.user?.id;
    if (!userId) return false;
    try {
      const remote = await this.io.loadCloud(userId);
      if (
        !this.isActive(session) ||
        session.user?.id !== userId ||
        session.revision !== expectedRevision
      )
        return false;

      if (remote.revision > expectedRevision && remote.data && sameData(remote.data, sent)) {
        // The exact snapshot reached the server. A later local edit remains
        // dirty and is saved against the newly acknowledged revision.
        session.confirmedCloud = structuredClone(remote.data);
        session.revision = remote.revision;
        session.knownRevision = true;
        session.cloudDirty = !sameData(session.data, sent);
        session.localDirty = true;
        session.blocked = null;
        session.recovery = null;
        session.recoveryRevision = null;
        session.error = "";
        this.remember(session);
        this.publish(session);
        return true;
      }

      const remoteMatchesBase =
        remote.revision === expectedRevision &&
        (remote.data
          ? !!session.confirmedCloud && sameData(remote.data, session.confirmedCloud)
          : session.confirmedCloud === null);
      if (remote.revision < expectedRevision) {
        session.blocked = "error";
        session.recovery = null;
        session.recoveryRevision = null;
        session.error =
          errorText(saveCause) +
          (this.cloudOnly
            ? " 云端返回了较旧的版本，无法确认这次保存；修改仅暂存在当前页面，请先导出备份，再重新连接。系统没有自动重复提交。"
            : " 云端返回了较旧的版本，无法确认这次保存；本机修改仍然保留，系统没有自动重复提交。请稍后重新连接。");
        this.remember(session);
        this.publish(session);
        return false;
      }
      if (remote.revision > expectedRevision || !remoteMatchesBase) {
        session.blocked = "conflict";
        session.recovery = remote.data || createEmptyWorkspace();
        session.recoveryRevision = remote.revision;
        session.error = this.cloudOnly
          ? "保存响应未能确认，且云端副本已经变化。当前修改仅暂存在页面，云端版本仍在；请检查差异并导出备份后再处理。"
          : "保存响应未能确认，且云端副本已经变化。当前本机修改与云端版本均已保留，请检查后再同步。";
        this.remember(session);
        this.publish(session);
        return false;
      }

      session.blocked = "error";
      session.recovery = null;
      session.recoveryRevision = null;
      session.error =
        errorText(saveCause) +
        (this.cloudOnly
          ? " 云端尚未确认收到这次保存；修改仅暂存在当前页面，请先导出备份，再重新连接。系统没有自动重复提交。"
          : " 云端尚未确认收到这次保存；本机修改仍然保留，系统没有自动重复提交。请稍后重新连接。");
      this.remember(session);
      this.publish(session);
      return false;
    } catch (readCause) {
      if (!this.isActive(session) || session.user?.id !== userId) return false;
      session.blocked = "error";
      session.recovery = null;
      session.recoveryRevision = null;
      session.error =
        errorText(saveCause) +
        (this.cloudOnly
          ? " 云端可能已经收到这次保存，但暂时无法核对结果；修改仅暂存在当前页面，请先导出备份，再重新连接。系统没有自动重复提交。"
          : " 云端可能已经收到这次保存，但暂时无法核对结果；本机修改仍然保留，系统没有自动重复提交。") +
        ` ${errorText(readCause)}`;
      this.remember(session);
      this.publish(session);
      return false;
    }
  }

  private async confirmWebCloudSave(session: Session): Promise<void> {
    await this.pump(session);
    if (!this.isActive(session)) throw new Error("当前账号已改变，未确认本次云端保存。");
    if (session.localDirty || session.cloudDirty || session.blocked || session.status !== "cloud")
      throw new Error(
        session.error || "尚未确认保存到云端。修改仅暂存在当前页面，请重新连接后重试。",
      );
  }

  private pump(session: Session): Promise<void> {
    const active = this.pumpTasks.get(session);
    if (active) return active;
    // `runPump()` sets this synchronously before it publishes. Keep this guard
    // for a re-entrant listener that fires in that small setup window.
    if (session.pumping || !session.ready || this.writesBlocked(session)) return Promise.resolve();
    const task = this.runPump(session);
    this.pumpTasks.set(session, task);
    const release = () => {
      if (this.pumpTasks.get(session) === task) this.pumpTasks.delete(session);
    };
    // Do not use `finally()` here: its rejected derived promise could become
    // unobserved when a caller intentionally starts a background save.
    void task.then(release, release);
    return task;
  }

  private async runPump(session: Session): Promise<void> {
    if (session.pumping || !session.ready || this.writesBlocked(session)) return;
    session.pumping = true;
    let safeWorkspaceRebases = 0;
    try {
      while (this.isActive(session)) {
        if (this.hasNewerLocalUpdate(session) || session.loadingLocalUpdate) return;
        if (session.localDirty) {
          session.status = "saving";
          this.publish(session);
          try {
            await this.persist(session);
          } catch (cause) {
            if (!this.isActive(session)) return;
            session.status = "error";
            session.error =
              "尚未保存到此浏览器：" +
              errorText(cause) +
              "。修改仍保留在当前页面，请重试或导出后再离开。";
            this.publish(session);
            return;
          }
          if (!this.isActive(session)) return;
          // An edit can arrive during IndexedDB write. Persist that newer edit
          // before uploading or declaring the local copy saved.
          if (session.localDirty) continue;
        }
        if (
          session.user &&
          session.cloudDirty &&
          !session.blocked &&
          !session.checking &&
          session.knownRevision &&
          !this.hasFencedImportTransition(session)
        ) {
          session.status = "saving";
          this.publish(session);
          const snapshot = session.data;
          const expectedRevision = session.revision;
          let saveAttempted = false;
          try {
            // The server enforces the same limit, but reject locally before
            // this snapshot starts another Storage upload or snapshot request.
            // Keep cloudDirty set so this exact local snapshot survives and
            // can be retried after cleanup.
            if (exceedsCloudWorkspaceCapacity(snapshot))
              throw new Error(
                this.cloudOnly
                  ? "当前工作区超过 3 MiB 云端保存容量。未保存的修改仅暂存在当前页面，请先导出备份或整理后重新连接。"
                  : "当前工作区超过 3 MiB 云端保存容量。资料已保存在此浏览器，请导出或整理后点击重新连接。",
              );
            for (const live of snapshot.sources) {
              for (const version of [live, ...(live.versions ?? [])]) {
                if (!this.isActive(session)) return;
                if (!version.blobKey || version.storagePath) continue;
                const source = getSourceVersion(live, version.versionId);
                if (!source)
                  throw new OriginalSyncError("资料历史版本身份无效，尚未上传，请检查版本记录。");
                const blob = await this.readLocalOriginal(session, source.blobKey!);
                if (!this.isActive(session)) return;
                if (!blob)
                  throw new OriginalSyncError(
                    "原文件「" +
                      source.title +
                      "」（版本 " +
                      source.versionId +
                      "）在此浏览器中不可用，请保留资料并找回原件后重试。",
                  );
                await verifyOriginal(source, blob);
                if (!this.isActive(session)) return;
                const latestLive = session.data.sources.find((item) => item.id === source.id);
                const latest = latestLive && getSourceVersion(latestLive, source.versionId);
                if (!latest) continue;
                if (originalIdentity(latest) !== originalIdentity(source))
                  throw new OriginalSyncError(
                    "上传期间原件记录已变化，尚未上传，请检查资料后重试。",
                  );
                if (latest.storagePath) continue;
                const storagePath = await this.io.uploadBlob(source, blob, session.user.id);
                if (!this.isActive(session)) return;
                const merged = mergeOriginalPath(session.data, source, storagePath);
                if (merged !== session.data) {
                  session.data = merged;
                  session.localDirty = true;
                  this.remember(session);
                  this.publish(session);
                  // Keep an acknowledged immutable path across a later upload
                  // or cloud-snapshot failure, including after a browser restart.
                  await this.persist(session);
                  if (!this.isActive(session)) return;
                }
              }
            }
            if (!this.isActive(session)) return;
            // A replaced current page may now be historical, or another file
            // may have arrived. Persist and cover the complete latest version
            // chain before sending a cloud snapshot with all original handles.
            if (session.data !== snapshot) continue;
            saveAttempted = true;
            const saved = await this.io.saveCloud(snapshot, expectedRevision, session.user.id);
            if (!this.isActive(session)) return;
            if (
              snapshot.organizationJobs?.some(keepsRunningAfterBrowserExit) &&
              this.io.reconcileOrganizationJobs
            ) {
              try {
                // The server may have fenced an active task while accepting
                // this ordinary full-snapshot save. Read its canonical
                // projection before another browser save can revive it.
                await this.io.reconcileOrganizationJobs(session.user.id);
                const canonical = await this.io.loadCloud(session.user.id);
                if (!this.isActive(session)) return;
                if (!canonical.data || canonical.revision < saved.revision)
                  throw new Error("云端未返回本次保存后的后台整理状态。");
                const current =
                  session.data === snapshot
                    ? canonical.data
                    : reconcileDurableOrganizationProjections(session.data, canonical.data);
                session.data = current;
                session.confirmedCloud = structuredClone(canonical.data);
                session.revision = canonical.revision;
                session.knownRevision = true;
                session.cloudDirty = !sameData(current, canonical.data);
                session.localDirty = true;
                session.blocked = null;
                session.recovery = null;
                session.recoveryRevision = null;
                session.error = "";
                this.remember(session);
                this.publish(session);
                continue;
              } catch (cause) {
                if (!this.isActive(session)) return;
                // The edit itself is confirmed, but a second snapshot write
                // must wait until its durable-task projection is read back.
                session.confirmedCloud = null;
                session.revision = saved.revision;
                session.knownRevision = true;
                session.cloudDirty = session.data !== snapshot;
                session.localDirty = true;
                session.blocked = "error";
                session.recovery = null;
                session.recoveryRevision = null;
                session.error =
                  "资料已保存到云端，但无法核对后台整理状态。为了避免覆盖任务结果，请重新连接后再继续编辑：" +
                  errorText(cause);
                this.remember(session);
                this.publish(session);
                continue;
              }
            }
            session.confirmedCloud = structuredClone(snapshot);
            session.revision = saved.revision;
            session.cloudDirty = session.data !== snapshot;
            session.localDirty = true;
            this.remember(session);
            this.publish(session);
            continue;
          } catch (cause) {
            if (!this.isActive(session)) return;
            // Check an indeterminate write before the legacy text-based
            // conflict fallback. A malformed 2xx body may mention a revision
            // while still hiding a transaction that actually committed.
            if (saveAttempted && workspaceSaveNeedsReadBack(cause)) {
              const confirmed = await this.readBackUnconfirmedWorkspaceSave(
                session,
                snapshot,
                expectedRevision,
                cause,
              );
              if (!this.isActive(session)) return;
              if (confirmed) safeWorkspaceRebases = 0;
              continue;
            }
            if (!conflictError(cause)) {
              session.blocked = "error";
              session.error = errorText(cause);
              continue;
            }
            try {
              const remote = await this.io.loadCloud(session.user.id);
              if (!this.isActive(session)) return;
              // The API also uses 409 for import-lease guards. Only a strictly
              // newer revision proves this was a workspace CAS race. Bound
              // repeated safe rebases so another active browser cannot
              // keep this save loop spinning indefinitely.
              if (
                safeWorkspaceRebases < 3 &&
                remote.revision > session.revision &&
                this.adoptSafeWorkspaceConflict(session, remote)
              ) {
                safeWorkspaceRebases += 1;
                this.remember(session);
                this.publish(session);
                continue;
              }
              if (remote.revision <= session.revision) {
                session.blocked = "error";
                session.recovery = null;
                session.recoveryRevision = null;
                session.error = this.cloudOnly
                  ? remote.revision === session.revision
                    ? "云端暂时无法接受本次保存，修改仅暂存在当前页面。请先导出备份，再重新连接。"
                    : "云端返回了较旧的版本状态，修改仅暂存在当前页面。请先导出备份，再重新连接。"
                  : remote.revision === session.revision
                    ? "云端暂时无法接受本次保存，当前修改仍保留在此浏览器。请稍后重新连接。"
                    : "云端返回了较旧的版本状态，当前修改仍保留在此浏览器。请稍后重新连接。";
                continue;
              }
              // Keep local work in memory and expose the exact newest candidate
              // rather than offering a blind whole-workspace overwrite.
              session.blocked = "conflict";
              session.recovery = remote.data || createEmptyWorkspace();
              session.recoveryRevision = remote.revision;
              session.error = "云端副本已变化。请检查并解决冲突后再同步。";
            } catch (recoveryCause) {
              if (!this.isActive(session)) return;
              session.blocked = "conflict";
              session.error = "云端版本冲突，且暂时无法读取最新副本：" + errorText(recoveryCause);
            }
          }
        }
        session.status =
          session.blocked ||
          (session.user
            ? session.cloudDirty
              ? this.hasFencedImportTransition(session)
                ? "saving"
                : "error"
              : "cloud"
            : "local");
        if (!session.blocked && (!session.cloudDirty || this.hasFencedImportTransition(session)))
          session.error = "";
        this.publish(session);
        return;
      }
    } finally {
      session.pumping = false;
      // The final in-loop publish happens while `pumping` is still true. Publish
      // once more so account-exit controls can become actionable as soon as the
      // current write settles.
      this.publish(session);
    }
  }

  hasUnsavedLocalChanges = (): boolean =>
    [...this.memory.values()].some((session) =>
      this.cloudOnly
        ? session.ready && (session.localDirty || session.cloudDirty)
        : session.localDirty,
    );

  private signOutSession(token: number): Session {
    const session = this.active;
    if (!session?.user || !session.ready || session.exiting || session.token !== token)
      throw new Error("当前账号已改变，请重新打开账号设置后再退出。");
    return session;
  }

  private async drainLocalWritesForReload(
    session: Session,
    accountId: string,
    token: number,
  ): Promise<void> {
    for (;;) {
      const atomicWrite = this.atomicLocalWriteBarriers.get(session);
      const pump = this.pumpTasks.get(session);
      const pending = [...(this.pendingLocalPersists.get(session) ?? [])];
      const queue = this.queues.get(accountId);
      await Promise.all([
        atomicWrite?.catch(() => {}),
        pump?.catch(() => {}),
        ...pending.map((item) => item.promise.catch(() => {})),
        queue?.catch(() => {}),
      ]);
      // Let release handlers remove their map entries, then verify that a late
      // continuation did not install a replacement task or queue tail.
      await Promise.resolve();
      if (!this.isActive(session) || session.token !== token)
        throw new Error("当前账号已改变，未载入其他标签页的数据。");
      if (
        !this.atomicLocalWriteBarriers.get(session) &&
        !this.pumpTasks.get(session) &&
        !(this.pendingLocalPersists.get(session)?.length ?? 0) &&
        this.queues.get(accountId) === queue
      )
        return;
    }
  }

  /**
   * Replaces a stale tab with the newest committed IndexedDB snapshot. Any
   * local write already in flight settles first. If that leaves an unsaved
   * in-memory snapshot, the caller must make it retrievable before replacement.
   */
  async loadLatestLocal(
    token: number,
    preserveLocalChanges?: (snapshot: WorkspaceData) => Promise<boolean>,
  ): Promise<boolean> {
    const session = this.active;
    if (!session?.ready || session.exiting || session.token !== token)
      throw new Error("当前账号已改变，请重新检查其他标签页的更新。");
    if (!this.hasNewerLocalUpdate(session)) return false;
    const activeReload = this.localReloadTasks.get(session);
    if (activeReload) return activeReload;

    const task = (async () => {
      const id = accountKey(session.user);
      session.loadingLocalUpdate = true;
      this.publish(session);
      try {
        // Atomic imports and the save pump may enqueue an ordinary snapshot
        // before they settle, so drain them before reading the replacement.
        await this.drainLocalWritesForReload(session, id, token);

        // An earlier local write may have caught up with the announced revision.
        if (!this.hasNewerLocalUpdate(session)) {
          session.loadingLocalUpdate = false;
          this.publish(session);
          return false;
        }

        if (session.checking)
          throw new Error("正在核对云端状态，请等待完成后再载入其他标签页的数据。");
        const boundary = {
          data: session.data,
          localDirty: session.localDirty,
          revision: session.revision,
          cloudDirty: session.cloudDirty,
          confirmedCloud: session.confirmedCloud,
        };
        const boundaryUnchanged = () =>
          session.data === boundary.data &&
          session.localDirty === boundary.localDirty &&
          session.revision === boundary.revision &&
          session.cloudDirty === boundary.cloudDirty &&
          session.confirmedCloud === boundary.confirmedCloud;

        let preservedLocalChanges = false;
        if (session.localDirty) {
          if (!preserveLocalChanges)
            throw new Error("当前页面还有未保存修改。请先导出当前副本，再载入最新数据。");
          const preserved = await preserveLocalChanges(structuredClone(session.data));
          if (!preserved) throw new Error("当前页面的修改尚未导出，未载入其他标签页的数据。");
          preservedLocalChanges = true;
          if (!this.isActive(session) || session.token !== token)
            throw new Error("当前账号已改变，未载入其他标签页的数据。");
          if (!boundaryUnchanged())
            throw new Error("导出期间当前页面再次变化，未载入其他标签页的数据。请重新导出后重试。");
        }

        const disk = unpack(await this.io.loadLocal(id));
        if (!this.isActive(session) || session.token !== token)
          throw new Error("当前账号已改变，未载入其他标签页的数据。");
        if (!boundaryUnchanged())
          throw new Error("读取期间当前页面再次变化，未替换当前数据。请重试载入。");
        const requiredRevision = session.localUpdateRevision;
        if (!disk.data || requiredRevision === null || disk.localRevision < requiredRevision)
          throw new Error("尚未读取到其他标签页的最新数据，请稍后重试。");

        session.data = disk.data;
        this.setLocalRevision(session, disk.localRevision);
        session.revision = disk.meta?.revision ?? 0;
        session.knownRevision = !!disk.meta;
        session.cloudDirty = !!session.user && (disk.meta?.dirty ?? true);
        session.confirmedCloud = null;
        if (disk.meta) {
          if (!disk.meta.dirty) session.confirmedCloud = structuredClone(disk.data);
          else if (disk.meta.base && disk.meta.baseRevision === disk.meta.revision)
            session.confirmedCloud = structuredClone(disk.meta.base);
        }
        session.localDirty = false;
        session.blocked = null;
        session.recovery = null;
        session.recoveryRevision = null;
        session.error = "";
        session.localCacheMode = "normal";
        session.loadingLocalUpdate = false;
        session.status = session.user ? (session.cloudDirty ? "saving" : "cloud") : "local";
        this.recoverOrganizationJobs(session);
        this.recoverImportJobs(session);
        this.remember(session);
        this.publish(session);
        void this.pump(session);
        return preservedLocalChanges;
      } catch (cause) {
        if (this.isActive(session) && session.token === token) {
          session.loadingLocalUpdate = false;
          session.status = "error";
          session.error = "未载入其他标签页的数据：" + errorText(cause);
          this.remember(session);
          this.publish(session);
        }
        throw cause;
      }
    })();
    this.localReloadTasks.set(session, task);
    const release = () => {
      if (this.localReloadTasks.get(session) === task) this.localReloadTasks.delete(session);
    };
    void task.then(release, release);
    return task;
  }

  /**
   * Confirm the exact in-memory workspace in IndexedDB before a local account
   * exit. A later edit during the write keeps `localDirty` true, so it can never
   * be mistaken for a protected draft.
   */
  private async confirmSignOutDraft(session: Session): Promise<void> {
    if (!this.isCurrent(session) || (!session.exiting && (session.pumping || session.checking)))
      throw new Error("正在完成当前保存，请稍候再退出。");
    try {
      await this.persist(session);
    } catch (cause) {
      if (this.isCurrent(session)) {
        session.status = "error";
        session.error = "尚未安全保存到此浏览器：" + errorText(cause) + "。请重试或导出后再离开。";
        this.remember(session);
        this.publish(session);
      }
      throw cause;
    }
    if (!this.isCurrent(session) || session.localDirty)
      throw new Error("本机草稿仍在变化，尚未确认保存。请稍候再试。");
  }

  private lockSignOut(session: Session) {
    if (!this.isCurrent(session) || session.exiting)
      throw new Error("当前账号已改变，请重新打开账号设置后再退出。");
    // From this point no later callback may add an edit after the final local
    // durability check. `isActive()` becomes false, so existing question,
    // organization, import and pump continuations stop at their next guard.
    session.exiting = true;
    this.cloudUpdateTasks.get(session)?.controller.abort();
    session.status = "saving";
    session.error = "";
    this.publish(session);
  }

  private unlockSignOut(session: Session) {
    // Auth did not sign out, so restore the exact previous account session
    // instead of leaving it frozen. No writes occurred while it was locked.
    if (!this.isCurrent(session)) return;
    session.exiting = false;
    session.status = session.blocked || (session.cloudDirty ? "error" : "cloud");
    this.publish(session);
  }

  /**
   * Runs a caller-owned local auth sign-out only after the chosen durability
   * condition is true. Keeping authentication here as a callback lets this
   * coordinator remain independent of the Supabase client while preserving the
   * critical ordering: durable draft first, local sign-out second.
   */
  async signOut(
    token: number,
    strategy: "direct" | "sync" | "local",
    completeLocalSignOut: () => Promise<void>,
  ): Promise<void> {
    const session = this.signOutSession(token);
    if (this.cloudOnly && strategy === "local")
      throw new Error("网页版不提供本地工作区，请完成云端保存或导出备份后退出。");
    const initial = this.signOutState(session);
    if (strategy === "direct") {
      if (initial.kind !== "ready")
        throw new Error("当前资料尚未处于可安全退出的状态，请选择同步或保留本机草稿。");
    } else if (strategy === "local") {
      if (!initial.canKeepLocalDraft)
        throw new Error("本机草稿尚未安全保存，请解决保存问题后再退出。");
      // Lock before the final IndexedDB confirmation. This also lets a user
      // retain a draft while a slow cloud request is still in flight: its late
      // result can no longer mutate the frozen account session.
      this.lockSignOut(session);
      try {
        await this.confirmSignOutDraft(session);
        await completeLocalSignOut();
      } catch (cause) {
        this.unlockSignOut(session);
        throw cause;
      }
      return;
    } else {
      if (!initial.canSync) throw new Error("当前同步尚未可用，请等待当前保存完成或先处理冲突。");
      // `retry` refreshes a recoverable cloud error before pumping. Calling the
      // pump alone would keep an earlier transport error blocked forever.
      await this.retry(token);
      if (!this.isActive(session) || this.signOutState(session).kind !== "ready")
        throw new Error("同步未完成，当前账号仍保持登录。");
    }
    if (!this.isActive(session) || session.localDirty)
      throw new Error("本机草稿仍未确认保存，当前账号仍保持登录。");
    this.lockSignOut(session);
    try {
      await completeLocalSignOut();
    } catch (cause) {
      this.unlockSignOut(session);
      throw cause;
    }
  }

  async retry(token: number): Promise<void> {
    const session = this.active;
    if (!session || session.token !== token) return;
    if (session.accountAccessVerificationFailed) {
      await this.activate(session.user);
      return;
    }
    // A cloud-readonly session has no trustworthy IndexedDB baseline to
    // reconcile against. Retry must restart activation so it re-reads the
    // account cache before any normal conflict or save path can run.
    if (this.isCloudReadOnly(session)) {
      await this.activate(session.user);
      return;
    }
    if (this.migrationChoiceBlocksWrites(session))
      throw new Error("请先迁移或暂不迁移此浏览器中的匿名资料。");
    if (!session.ready) {
      await this.activate(session.user);
      return;
    }
    if (session.pumping || session.loadingCloudUpdate) return;
    if (!session.user) {
      await this.pump(session);
      this.recoverImportJobs(session);
      return;
    }
    session.checking = true;
    session.status = "loading";
    this.publish(session);
    try {
      const remote = await this.io.loadCloud(session.user.id);
      if (!this.isActive(session)) return;
      session.checking = false;
      const transition = this.recoverableImportTransition(session, remote);
      if (transition) {
        const restored = await this.replayImportTransition(session, remote, transition);
        if (restored && this.isActive(session)) this.recoverImportJobs(session);
        return;
      }
      this.reconcile(session, remote, true);
      this.remember(session);
      this.publish(session);
      await this.pump(session);
      this.recoverImportJobs(session);
    } catch (cause) {
      if (!this.isActive(session)) return;
      session.checking = false;
      session.blocked = "error";
      session.status = "error";
      session.error = errorText(cause);
      this.publish(session);
      // A failed reconnect must not block local persistence of edits.
      if (session.localDirty) await this.pump(session);
    }
  }

  private cloudUpdateBusy(session: Session, explicit: boolean, committing = false): boolean {
    return (
      !this.isActive(session) ||
      !session.ready ||
      !session.user ||
      !session.knownRevision ||
      !session.confirmedCloud ||
      session.exiting ||
      session.pumping ||
      session.checking ||
      session.purging ||
      this.isCloudReadOnly(session) ||
      this.migrationChoiceBlocksWrites(session) ||
      this.hasNewerLocalUpdate(session) ||
      session.loadingLocalUpdate ||
      (!committing &&
        (session.loadingCloudUpdate || !!this.atomicLocalWriteBarriers.get(session))) ||
      !!this.pendingLocalPersists.get(session)?.length ||
      !!this.pumpTasks.get(session) ||
      this.readingConflictResolutions.has(session) ||
      this.hasFencedImportTransition(session) ||
      !!this.pendingRecoveryWrites.get(session)?.size ||
      [...this.pendingBackupRestores.keys()].some((key) => key.startsWith(`[${session.token},`)) ||
      this.aiBusy(session.token) ||
      !!this.pendingCloudOperations.get(session) ||
      pendingFileKeys.size > 0 ||
      [...this.importLeaseRetries.keys()].some((key) => key.startsWith(`${session.token}:`)) ||
      !!this.pendingReadingPositions.get(session)?.size ||
      [...this.pendingQuestions].some((item) => item.session === session) ||
      [...this.pendingOrganizations].some((item) => item.session === session) ||
      [...this.pendingImports.values()].some((item) => item.session === session) ||
      this.queuedImports.some((item) => item.session === session) ||
      [...this.cancellingImports].some((key) => key.startsWith(`${session.token}:`)) ||
      (!explicit &&
        (session.localDirty ||
          session.cloudDirty ||
          !!session.blocked ||
          !sameData(session.data, session.confirmedCloud)))
    );
  }

  checkCloudUpdates(token: number, signal?: AbortSignal): Promise<void> {
    return this.startCloudUpdateCheck(token, false, signal);
  }

  /** Reader-local staging fence; this never changes workspace data or starts a save. */
  setPendingReadingPosition(token: number, readerKey: string, pending: boolean): void {
    const session = this.active;
    if (!session || session.token !== token || !this.isActive(session) || !readerKey) return;
    const keys = this.pendingReadingPositions.get(session) ?? new Set<string>();
    if (pending) keys.add(readerKey);
    else keys.delete(readerKey);
    if (keys.size) this.pendingReadingPositions.set(session, keys);
    else this.pendingReadingPositions.delete(session);
  }

  loadCloudUpdate(token: number, signal?: AbortSignal): Promise<void> {
    return this.startCloudUpdateCheck(token, true, signal);
  }

  private startCloudUpdateCheck(
    token: number,
    explicit: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const session = this.active;
    if (
      !session?.user ||
      !session.ready ||
      session.token !== token ||
      session.exiting ||
      !this.io.loadCloudRevision ||
      signal?.aborted
    )
      return Promise.resolve();
    const existing = this.cloudUpdateTasks.get(session);
    if (existing) return existing.promise;
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 12_000);
    session.checkingCloudUpdate = true;
    session.cloudUpdateError = "";
    const task = Promise.resolve()
      .then(() => this.runCloudUpdateCheck(session, explicit, controller.signal))
      .catch((cause: unknown) => {
        if (!this.isActive(session)) return;
        if (!controller.signal.aborted || timedOut)
          session.cloudUpdateError = timedOut ? "云端版本检查超时，请稍后重试。" : errorText(cause);
      })
      .finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        if (this.cloudUpdateTasks.get(session)?.controller === controller)
          this.cloudUpdateTasks.delete(session);
        session.checkingCloudUpdate = false;
        session.loadingCloudUpdate = false;
        if (this.isActive(session)) this.publish(session);
      });
    this.cloudUpdateTasks.set(session, { controller, promise: task });
    this.publish(session);
    return task;
  }

  private async runCloudUpdateCheck(
    session: Session,
    explicit: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const userId = session.user!.id;
    const read = async <T>(operation: Promise<T>): Promise<T> => {
      signal.throwIfAborted();
      let cancel!: () => void;
      const aborted = new Promise<never>((_, reject) => {
        cancel = () => reject(new DOMException("云端检查已取消。", "AbortError"));
        signal.addEventListener("abort", cancel, { once: true });
      });
      try {
        return await Promise.race([operation, aborted]);
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    };
    const discovered = await read(this.io.loadCloudRevision!(userId, signal));
    if (!this.isActive(session) || signal.aborted) return;
    if (!Number.isSafeInteger(discovered.revision) || discovered.revision < 0)
      throw new Error("云端版本检查返回了无效数据，请稍后重试。");
    if (discovered.revision > session.revision)
      session.cloudUpdateRevision = Math.max(session.cloudUpdateRevision ?? 0, discovered.revision);
    if (session.cloudUpdateRevision !== null && session.cloudUpdateRevision <= session.revision)
      session.cloudUpdateRevision = null;
    this.publish(session);
    if (session.cloudUpdateRevision === null) return;
    if (this.cloudUpdateBusy(session, explicit)) {
      if (explicit)
        session.cloudUpdateError = "当前编辑或任务仍在保存，请等待操作完成后再载入云端更新。";
      return;
    }
    const boundary = {
      data: session.data,
      revision: session.revision,
      localRevision: session.localRevision,
      localDirty: session.localDirty,
      cloudDirty: session.cloudDirty,
      confirmedCloud: session.confirmedCloud,
      queue: this.queues.get(userId),
    };
    const unchanged = () =>
      session.data === boundary.data &&
      session.revision === boundary.revision &&
      session.localDirty === boundary.localDirty &&
      session.cloudDirty === boundary.cloudDirty &&
      session.confirmedCloud === boundary.confirmedCloud;
    const remote = await read(this.io.loadCloud(userId, signal));
    if (
      !this.isActive(session) ||
      signal.aborted ||
      !unchanged() ||
      session.localRevision !== boundary.localRevision ||
      this.queues.get(userId) !== boundary.queue ||
      this.cloudUpdateBusy(session, explicit)
    )
      return;
    if (
      !Number.isSafeInteger(remote.revision) ||
      remote.revision < 1 ||
      !remote.data ||
      remote.revision <= session.revision ||
      remote.revision < session.cloudUpdateRevision
    )
      throw new Error("尚未读到已发现的云端新版本，请稍后重试；当前内容仍然保留。");
    const parsed = workspaceSchema.safeParse(remote.data);
    if (!parsed.success) throw new Error("云端工作区格式不兼容，请保留本机资料。");
    assertWorkspaceOwner(parsed.data, userId);
    const candidate: Session = { ...session };
    this.reconcile(candidate, { data: parsed.data, revision: remote.revision }, true);
    if (candidate.blocked) {
      if (candidate.blocked === "conflict") {
        session.blocked = "conflict";
        session.status = "conflict";
        session.recovery = candidate.recovery;
        session.recoveryRevision = candidate.recoveryRevision;
        session.error = candidate.error;
        this.remember(session);
      } else session.cloudUpdateError = candidate.error;
      return;
    }
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.atomicLocalWriteBarriers.set(session, barrier);
    session.loadingCloudUpdate = true;
    const previous = this.queues.get(userId) ?? Promise.resolve();
    const write = previous.then(async () => {
      if (
        this.discardedSessions.has(session) ||
        signal.aborted ||
        !this.isActive(session) ||
        !unchanged() ||
        session.localRevision !== boundary.localRevision ||
        this.cloudUpdateBusy(session, explicit, true)
      )
        return;
      const savedRevision = await this.io.saveLocal(
        structuredClone(this.stored(candidate)),
        userId,
        session.localRevision,
      );
      if (typeof savedRevision === "number") this.setLocalRevision(session, savedRevision);
      if (this.discardedSessions.has(session)) return;
      if (
        this.isActive(session) &&
        !signal.aborted &&
        unchanged() &&
        !this.cloudUpdateBusy(session, explicit, true)
      ) {
        session.data = candidate.data;
        session.revision = candidate.revision;
        session.knownRevision = true;
        session.confirmedCloud = candidate.confirmedCloud;
        session.cloudDirty = candidate.cloudDirty;
        session.localDirty = false;
        session.blocked = null;
        session.recovery = null;
        session.recoveryRevision = null;
        session.error = "";
        session.status = candidate.cloudDirty ? "saving" : "cloud";
        session.cloudAdoptionSequence += 1;
        if ((session.cloudUpdateRevision ?? 0) <= remote.revision)
          session.cloudUpdateRevision = null;
        this.remember(session);
        return;
      }
      // Ordinary editor input stays live during CAS. Deferred local persists
      // wait on our barrier, so repairs cannot be followed by an older queued
      // editor snapshot. Never give an edit from the old cloud base a new base.
      if (session.localDirty || this.isActive(session)) {
        session.localDirty = true;
        for (;;) {
          if (this.discardedSessions.has(session)) return;
          const data = session.data;
          const revision = session.revision;
          const dirty = session.cloudDirty;
          const base = session.confirmedCloud;
          const localRevision = await this.io.saveLocal(
            structuredClone(this.stored(session)),
            userId,
            session.localRevision,
          );
          if (typeof localRevision === "number") this.setLocalRevision(session, localRevision);
          if (
            data === session.data &&
            revision === session.revision &&
            dirty === session.cloudDirty &&
            base === session.confirmedCloud
          ) {
            session.localDirty = false;
            this.remember(session);
            break;
          }
        }
      }
    });
    this.queues.set(
      userId,
      write.catch(() => {}),
    );
    this.publish(session);
    try {
      await write;
    } catch (cause) {
      if (
        !this.discardedSessions.has(session) &&
        cause instanceof Error &&
        "code" in cause &&
        cause.code === "LOCAL_WORKSPACE_CONFLICT"
      ) {
        try {
          const latest = unpack(await this.io.loadLocal(userId));
          this.markNewerLocalUpdate(session, userId, {
            accountId: userId,
            localRevision: latest.localRevision,
            writerId: "cloud-update-conflict-readback",
          });
        } catch {
          /* Preserve the original local CAS failure. */
        }
      }
      if (!this.discardedSessions.has(session) && !unchanged()) {
        session.localDirty = true;
        session.status = "error";
        session.error =
          "当前编辑尚未保存到此浏览器：" + errorText(cause) + "。请重试或导出后再离开。";
      }
      throw cause;
    } finally {
      if (this.atomicLocalWriteBarriers.get(session) === barrier)
        this.atomicLocalWriteBarriers.delete(session);
      session.loadingCloudUpdate = false;
      release();
    }
    if (this.isActive(session) && session.cloudDirty && !session.localDirty)
      void this.pump(session);
  }

  async useRemote(
    token: number,
    preserveCurrent?: (snapshot: WorkspaceData) => Promise<boolean>,
  ): Promise<void> {
    const session = this.active;
    if (!session?.user || !session.ready || session.token !== token || !session.recovery) return;
    this.assertWorkspaceWritable(session);
    if (this.cloudOnly) {
      const boundary = session.data;
      const recovery = session.recovery;
      if (!preserveCurrent || !(await preserveCurrent(structuredClone(boundary))))
        throw new Error("当前页面的修改尚未完整导出，未载入云端副本。");
      if (
        !this.isActive(session) ||
        session.token !== token ||
        session.data !== boundary ||
        session.recovery !== recovery
      )
        throw new Error("导出期间账号或内容发生变化，请重新核对当前副本。");
    }
    session.ready = false;
    session.status = "loading";
    this.publish(session);
    try {
      const backupId = "recovery:" + session.user.id + ":" + Date.now() + ":" + session.token;
      const backup = structuredClone(this.stored(session));
      // Do not serialize recovery creation behind ordinary saving: useRemote
      // must be able to preserve its own conflict snapshot while an earlier
      // local confirmation is still in flight. The write is tracked separately
      // so discardAccount can still wait before clearing its recovery record.
      const write = this.discardedSessions.has(session)
        ? Promise.resolve()
        : this.io.saveLocal(backup, backupId, 0).then(() => {});
      this.trackRecoveryWrite(session, write);
      await write;
      if (!this.isActive(session)) return;
      const remote = await this.io.loadCloud(session.user.id);
      if (!this.isActive(session)) return;
      session.data = remote.data || createEmptyWorkspace();
      session.confirmedCloud = remote.data ? structuredClone(remote.data) : null;
      session.revision = remote.revision;
      session.knownRevision = true;
      session.cloudDirty = !remote.data;
      session.localDirty = true;
      session.blocked = null;
      session.recovery = null;
      session.recoveryRevision = null;
      session.error = "";
      session.ready = true;
      this.recoverOrganizationJobs(session);
      this.recoverImportJobs(session);
      this.remember(session);
      this.publish(session);
      await this.pump(session);
    } catch (cause) {
      if (!this.isActive(session)) return;
      session.ready = true;
      session.status = "error";
      session.error = "没有覆盖当前副本：" + errorText(cause);
      this.publish(session);
    }
  }

  /**
   * Resolve a reading-only race against the exact cloud snapshot shown in the
   * chooser. Reading timestamps remain display metadata; the user's explicit
   * per-source choice is the only authority when both browsers moved.
   */
  async resolveReadingProgressConflicts(
    selections: readonly ReadingProgressSyncSelection[],
    token: number,
  ): Promise<void> {
    const session = this.active;
    if (!session?.user || !session.ready || session.token !== token)
      throw new Error("当前账号已改变，请重新检查阅读位置冲突。 ");
    this.assertWorkspaceWritable(session);
    if (session.blocked !== "conflict" || !session.recovery || session.recoveryRevision === null)
      throw new Error("当前没有可处理的阅读位置冲突。 ");
    if (this.readingConflictResolutions.has(session))
      throw new Error("正在保存所选阅读位置，请等待当前操作完成。 ");

    this.readingConflictResolutions.add(session);
    try {
      const reviewedLocal = session.data;
      const reviewedRecovery = session.recovery;
      const reviewedRevision = session.recoveryRevision;
      let remote: RemoteWorkspace;
      try {
        remote = await this.io.loadCloud(session.user.id);
      } catch (cause) {
        if (!this.isActive(session)) throw new Error("当前账号已改变，阅读位置尚未保存。 ");
        throw new Error("无法读取最新云端副本：" + errorText(cause));
      }
      if (!this.isActive(session)) throw new Error("当前账号已改变，阅读位置尚未保存。 ");
      if (session.data !== reviewedLocal)
        throw new Error("本机阅读位置已变化，请重新检查后再选择。 ");
      const candidate = remote.data || createEmptyWorkspace();
      if (remote.revision !== reviewedRevision || !sameData(candidate, reviewedRecovery)) {
        session.recovery = candidate;
        session.recoveryRevision = remote.revision;
        session.error = "云端版本已再次变化，已刷新待处理的阅读位置。";
        session.status = "conflict";
        this.remember(session);
        this.publish(session);
        throw new Error("云端版本已再次变化，请检查刷新后的阅读位置。 ");
      }

      const plan = planReadingProgressSyncConflicts(
        session.data,
        candidate,
        session.confirmedCloud,
      );
      if (!plan?.conflicts.length)
        throw new Error(
          "此冲突还包含资料内容、版本或其他工作区修改，不能只选择阅读位置。请先导出当前副本，再选择云端恢复。",
        );
      const next = applyReadingProgressSyncResolution(candidate, plan, selections);

      const previous = {
        data: session.data,
        confirmedCloud: session.confirmedCloud,
        revision: session.revision,
        knownRevision: session.knownRevision,
        localDirty: session.localDirty,
        cloudDirty: session.cloudDirty,
      };
      session.data = next;
      session.confirmedCloud = remote.data ? structuredClone(remote.data) : null;
      session.revision = remote.revision;
      session.knownRevision = true;
      session.localDirty = true;
      session.cloudDirty = !sameData(next, candidate);
      // Keep the reviewed recovery attached until the chosen positions are
      // durable in IndexedDB. If that write fails, restore both visible sides.
      try {
        await this.persist(session);
      } catch (cause) {
        if (!this.isActive(session)) throw new Error("当前账号已改变，阅读位置尚未保存。 ");
        Object.assign(session, previous);
        session.blocked = "conflict";
        session.status = "conflict";
        session.error = "所选阅读位置尚未保存在此浏览器：" + errorText(cause);
        this.remember(session);
        this.publish(session);
        throw new Error(session.error);
      }
      if (!this.isActive(session)) throw new Error("当前账号已改变，阅读位置尚未保存。 ");
      session.blocked = null;
      session.recovery = null;
      session.recoveryRevision = null;
      session.error = "";
      session.status = session.cloudDirty ? "saving" : "cloud";
      this.remember(session);
      this.publish(session);
      await this.pump(session);
      if (!this.isActive(session)) throw new Error("当前账号已改变，阅读位置保存结果未知。 ");
      if (session.blocked === "conflict")
        throw new Error("保存期间云端版本再次变化，请检查新的阅读位置冲突。 ");
      if (session.blocked === "error" || session.cloudDirty)
        throw new Error(session.error || "阅读位置尚未确认保存到云端，请重试。 ");
    } finally {
      this.readingConflictResolutions.delete(session);
    }
  }

  /**
   * Rebase disclosed note-only changes on the exact cloud revision the user
   * reviewed. Other workspace objects deliberately stay on the explicit
   * export/remote-recovery path; guessing across files, sources, or tasks
   * could make source evidence disappear without a review surface.
   */
  async resolveNoteConflicts(
    selections: readonly NoteSyncConflictSelection[],
    token: number,
  ): Promise<void> {
    const session = this.active;
    if (!session?.user || !session.ready || session.token !== token)
      throw new Error("当前账号已改变，请重新检查同步冲突。 ");
    this.assertWorkspaceWritable(session);
    if (session.blocked !== "conflict" || !session.recovery || session.recoveryRevision === null)
      throw new Error("当前没有可处理的笔记同步冲突。 ");

    const reviewedRecovery = session.recovery;
    const reviewedRevision = session.recoveryRevision;
    let remote: RemoteWorkspace;
    try {
      remote = await this.io.loadCloud(session.user.id);
    } catch (cause) {
      throw new Error("无法读取最新云端副本：" + errorText(cause));
    }
    if (!this.isActive(session)) return;
    const candidate = remote.data || createEmptyWorkspace();
    if (remote.revision !== reviewedRevision || !sameData(candidate, reviewedRecovery)) {
      session.recovery = candidate;
      session.recoveryRevision = remote.revision;
      session.error = "云端版本已再次变化，已刷新待处理的冲突内容。";
      session.status = "conflict";
      this.remember(session);
      this.publish(session);
      throw new Error("云端版本已再次变化，请检查刷新后的冲突内容。 ");
    }

    const plan = this.noteSyncPlan(session);
    if (!plan)
      throw new Error(
        "此冲突包含资料、空间或删除记录，暂不能安全自动合并。请先导出当前副本，再选择云端恢复。",
      );
    const choices = new Map<string, NoteSyncConflictSelection>();
    for (const selection of selections) {
      if (choices.has(selection.conflictId)) throw new Error("同一笔记的冲突只能选择一次。 ");
      choices.set(selection.conflictId, selection);
    }
    const known = new Set(plan.conflicts.map((conflict) => conflict.id));
    for (const id of choices.keys()) {
      if (!known.has(id)) throw new Error("冲突列表已改变，请重新检查后再提交。 ");
    }
    const unresolved = plan.conflicts.find((conflict) => !choices.has(conflict.id));
    if (unresolved) throw new Error(`请先处理笔记「${unresolved.noteId}」的两个版本。`);

    const at = new Date().toISOString();
    let next = applySafeNoteSyncChanges(
      candidate,
      plan.safe.filter((change) => change.side === "local"),
    );
    for (const conflict of plan.conflicts) {
      const selection = choices.get(conflict.id)!;
      const resolution = resolveNoteSyncConflict(conflict, {
        choice: selection.choice,
        content: selection.content,
        at,
        preservedVersionIds: {
          local: conflictRecordId("local-conflict-version"),
          remote: conflictRecordId("remote-conflict-version"),
        },
      });
      // The plan only exposes live-vs-live conflicts. Keep this guard so a
      // stale or malformed input can never discard an undisclosed tombstone.
      if (resolution.preservedSnapshots.length)
        throw new Error("这项选择包含未保存的删除快照，不能自动覆盖。请导出后使用云端恢复。 ");
      next = applyNoteSyncResolution(next, resolution);
    }

    session.data = next;
    session.confirmedCloud = remote.data ? structuredClone(remote.data) : null;
    session.revision = remote.revision;
    session.knownRevision = true;
    session.localDirty = true;
    session.cloudDirty = true;
    // Leave the reviewed remote snapshot attached until the merged data is
    // durably written to IndexedDB. A close or failed write therefore cannot
    // turn a recoverable conflict into an untracked in-memory edit.
    try {
      await this.persist(session);
    } catch (cause) {
      if (!this.isActive(session)) return;
      session.blocked = "conflict";
      session.status = "conflict";
      session.error = "合并结果尚未保存在此浏览器：" + errorText(cause);
      this.remember(session);
      this.publish(session);
      throw new Error(session.error);
    }
    if (!this.isActive(session)) return;
    session.blocked = null;
    session.recovery = null;
    session.recoveryRevision = null;
    session.error = "";
    session.status = "saving";
    this.remember(session);
    this.publish(session);
    await this.pump(session);
  }

  private readLocalOriginal(session: Session, key: string): Promise<Blob | undefined> {
    return this.io.getAccountBlob
      ? this.io.getAccountBlob(key, accountKey(session.user))
      : this.io.getBlob(key);
  }

  private deleteLocalOriginal(session: Session, key: string): Promise<boolean> {
    return this.io.deleteAccountUnreferencedBlob
      ? this.io.deleteAccountUnreferencedBlob(key, accountKey(session.user))
      : this.io.deleteUnreferencedBlob!(key);
  }

  private putLocalOriginal(session: Session, key: string, blob: Blob): Promise<boolean> {
    return this.io.putAccountBlobIfAbsent
      ? this.io.putAccountBlobIfAbsent(key, blob, accountKey(session.user))
      : this.io.putBlobIfAbsent!(key, blob);
  }

  async sourceBlob(
    source: Source,
    token: number,
    options: SourceBlobReadOptions = {},
  ): Promise<Blob | undefined> {
    const session = this.active;
    if (!session?.ready || session.token !== token) {
      throw new Error("当前账号或资料版本已改变，请重新打开资料。");
    }
    // Only immutable identity comes from the caller. Originals, including a
    // retained version's handles, must come from this account's live record.
    const sourceId = source.id;
    const versionId = source.versionId;
    const ownedVersion = () => {
      if (!this.isActive(session) || !session.ready)
        throw new Error("当前账号已改变，请重新打开资料。");
      const live = session.data.sources.find((item) => item.id === sourceId);
      const version = live && getSourceVersion(live, versionId);
      if (!version) throw new Error("当前账号或资料版本已改变，请重新打开资料。");
      // Deleted records remain readable here for the user's recoverable backup.
      return version;
    };
    const canonical = { ...ownedVersion() };
    const originalKey = (item: Source) =>
      JSON.stringify([item.kind, item.blobKey, item.storagePath, item.hash, item.size]);
    const expectedKey = originalKey(canonical);
    const assertUnchanged = () => {
      if (originalKey(ownedVersion()) !== expectedKey)
        throw new Error("资料原件记录已变化，请重新打开对应版本后重试。");
    };
    try {
      if (!options.preferCloud) {
        const local = canonical.blobKey
          ? await this.readLocalOriginal(session, canonical.blobKey)
          : undefined;
        assertUnchanged();
        if (local) return local;
      }
      if (session.user && canonical.storagePath) {
        const blob = await this.io.downloadBlob(canonical, session.user.id);
        assertUnchanged();
        return blob;
      }
      return undefined;
    } catch (cause) {
      // A late failure can contain the old account's object details. Validate
      // the active session before allowing either bytes or that error to escape.
      assertUnchanged();
      throw cause;
    }
  }

  private importStateFrom(
    data: WorkspaceData,
    jobId: string,
  ): { job: ImportJob; source: Source } | null {
    const job = data.importJobs?.find((item) => item.id === jobId);
    const source = job && data.sources.find((item) => item.id === job.sourceId);
    if (!job || !source || source.versionId !== job.versionId) return null;
    return { job, source };
  }

  /** Mirrors the SQL lease guard's exact current-source/current-job pair. */
  private importPairFingerprint(data: WorkspaceData, sourceId: string, versionId: string): string {
    return JSON.stringify({
      sources: data.sources.filter(
        (source) => source.id === sourceId && source.versionId === versionId,
      ),
      jobs: (data.importJobs ?? []).filter(
        (job) => job.sourceId === sourceId && job.versionId === versionId,
      ),
    });
  }

  private transitionTargetMatches(pending: PendingImport): boolean {
    const target = pending.transitionTarget;
    const current = target && this.importState(pending.session, pending.jobId);
    return (
      !!target &&
      !!current &&
      JSON.stringify(current.source) === JSON.stringify(target.source) &&
      JSON.stringify(current.job) === JSON.stringify(target.job)
    );
  }

  /**
   * Generic saves may edit unrelated workspace data during a parse, but they
   * must never alter the source/job pair protected by a current or likely
   * remote lease. The server repeats this check; doing it here avoids showing
   * a successful local edit which would inevitably be rejected later.
   */
  private protectedImportMutation(session: Session, next: WorkspaceData): string | null {
    if (!this.importLeaseEnabled(session)) return null;
    const pairs = new Map<string, { sourceId: string; versionId: string; owned: boolean }>();
    const mark = (sourceId: string, versionId: string, owned: boolean) => {
      const key = JSON.stringify([sourceId, versionId]);
      const existing = pairs.get(key);
      pairs.set(key, { sourceId, versionId, owned: owned || !!existing?.owned });
    };
    for (const job of session.data.importJobs ?? []) {
      const source = session.data.sources.find(
        (item) => item.id === job.sourceId && item.versionId === job.versionId,
      );
      if (
        source &&
        !source.deletedAt &&
        job.originalSaved &&
        job.stage === "parsing" &&
        (job.status === "queued" || job.status === "running")
      )
        mark(job.sourceId, job.versionId, false);
    }
    for (const pending of this.pendingImports.values()) {
      if (pending.session === session && pending.lease)
        mark(pending.lease.sourceId, pending.lease.versionId, true);
    }
    for (const jobId of this.importTransitionFences.get(session) ?? []) {
      const current = this.importState(session, jobId);
      if (current) mark(current.job.sourceId, current.job.versionId, true);
    }
    for (const pair of pairs.values()) {
      if (
        this.importPairFingerprint(session.data, pair.sourceId, pair.versionId) !==
        this.importPairFingerprint(next, pair.sourceId, pair.versionId)
      )
        return pair.owned
          ? "这份资料正在此浏览器解析。请先取消解析，或等待解析完成后再修改资料。"
          : "这份资料正在解析，暂不能修改。请等待解析完成，或在持有解析任务的设备上取消。";
    }
    return null;
  }

  /** True only for the active parser state accepted by the lease RPC. */
  private importParseIsActive(state: { source: Source; job: ImportJob } | null): boolean {
    return !!(
      state &&
      !state.source.deletedAt &&
      !state.source.originalMissing &&
      (state.source.status === "saved" || state.source.status === "parsing") &&
      state.job.originalSaved &&
      state.job.stage === "parsing" &&
      (state.job.status === "queued" || state.job.status === "running")
    );
  }

  /** A parser result can be completed/indexed or a durable parsing failure. */
  private importParseIsFinished(state: { source: Source; job: ImportJob } | null): boolean {
    return !!(
      state &&
      !state.source.deletedAt &&
      !state.source.originalMissing &&
      state.job.originalSaved &&
      (((state.source.status === "ready" || state.source.status === "partial") &&
        state.job.status === "completed" &&
        state.job.stage === "indexing") ||
        (state.source.status === "failed" &&
          state.job.status === "failed" &&
          state.job.stage === "parsing"))
    );
  }

  private importParseIsCancelled(state: { source: Source; job: ImportJob } | null): boolean {
    return !!(
      state &&
      !state.source.deletedAt &&
      !state.source.originalMissing &&
      state.source.status === "saved" &&
      state.job.originalSaved &&
      state.job.status === "cancelled" &&
      state.job.stage === "parsing"
    );
  }

  private importParseIsRetryable(state: { source: Source; job: ImportJob } | null): boolean {
    return this.importParseIsFinished(state) || this.importParseIsCancelled(state);
  }

  /**
   * A dedicated parser RPC can have reached the database while its response
   * was lost, or it can have failed before the database received it. The
   * locally persisted target plus an unchanged remote revision is enough to
   * distinguish the latter from a normal user-edit conflict and retry the
   * same dedicated transition. Never let that snapshot enter save_workspace.
   */
  private recoverableImportTransition(
    session: Session,
    remote: RemoteWorkspace,
  ): RecoverableImportTransition | null {
    if (
      !this.importLeaseEnabled(session) ||
      !session.user ||
      !remote.data ||
      !session.cloudDirty ||
      remote.revision !== session.revision
    )
      return null;
    for (const localJob of session.data.importJobs ?? []) {
      const local = this.importStateFrom(session.data, localJob.id);
      const current = this.importStateFrom(remote.data, localJob.id);
      if (
        !local ||
        !current ||
        local.job.sourceId !== current.job.sourceId ||
        local.job.versionId !== current.job.versionId ||
        local.source.versionId !== current.source.versionId
      )
        continue;
      const identity = {
        jobId: local.job.id,
        sourceId: local.job.sourceId,
        versionId: local.job.versionId,
      };
      if (this.importParseIsFinished(local) && this.importParseIsActive(current))
        return { ...identity, action: "finish" };
      if (this.importParseIsCancelled(local) && this.importParseIsActive(current))
        return { ...identity, action: "cancel" };
      if (this.importParseIsActive(local) && this.importParseIsRetryable(current))
        return { ...identity, action: "retry" };
    }
    return null;
  }

  /**
   * Retain a locally staged import transition after a network ambiguity. This
   * is deliberately called only after a fresh cloud read proves the remote
   * workspace is still at the exact revision from which the transition began.
   */
  private async replayImportTransition(
    session: Session,
    remote: RemoteWorkspace,
    transition: RecoverableImportTransition,
  ): Promise<boolean> {
    const user = session.user;
    const remoteData = remote.data;
    const target = this.importState(session, transition.jobId);
    if (
      !user ||
      !remoteData ||
      remote.revision !== session.revision ||
      !target ||
      target.job.sourceId !== transition.sourceId ||
      target.job.versionId !== transition.versionId ||
      !this.isActive(session) ||
      !session.ready
    )
      return false;

    const targetMatches = () => {
      const current = this.importState(session, transition.jobId);
      return (
        !!current &&
        JSON.stringify(current.source) === JSON.stringify(target.source) &&
        JSON.stringify(current.job) === JSON.stringify(target.job)
      );
    };
    const label =
      transition.action === "finish"
        ? "解析结果"
        : transition.action === "cancel"
          ? "取消解析"
          : "重新解析";
    this.fenceImportTransition(session, transition.jobId);
    let leaseToken: string | undefined;
    let committed = false;
    try {
      // Keep the acknowledged remote snapshot as the CAS base while retaining
      // the local transition payload. The fence makes unrelated edits safe but
      // prevents this source/job pair from being changed beneath the replay.
      session.confirmedCloud = structuredClone(remoteData);
      session.revision = remote.revision;
      session.knownRevision = true;
      session.status = "saving";
      session.error = "";
      session.blocked = null;
      this.remember(session);
      this.publish(session);

      let saved: { revision: number };
      if (transition.action === "finish") {
        const claim = this.io.claimImportParse;
        const finish = this.io.finishImportParse;
        if (!claim || !finish) throw new Error("当前云端尚未支持解析结果恢复，请完成迁移后重试。");
        const claimed = await claim(transition.sourceId, transition.versionId, user.id);
        if (claimed.status === "held")
          throw new Error("另一台设备正在解析这份资料，请等待它完成或稍后重新连接。");
        if (claimed.status !== "claimed" || !claimed.leaseToken)
          throw new Error("暂时无法重新认领解析任务，请稍后重新连接。");
        leaseToken = claimed.leaseToken;
        if (!this.isActive(session) || !session.ready || !targetMatches()) return false;
        const payload = session.data;
        saved = await finish(
          payload,
          session.revision,
          transition.sourceId,
          transition.versionId,
          leaseToken,
          user.id,
        );
      } else {
        const send =
          transition.action === "cancel" ? this.io.cancelImportParse : this.io.retryImportParse;
        if (!send) throw new Error("当前云端尚未支持此解析状态恢复，请完成迁移后重试。");
        if (!this.isActive(session) || !session.ready || !targetMatches()) return false;
        const payload = session.data;
        saved = await send(
          payload,
          session.revision,
          transition.sourceId,
          transition.versionId,
          user.id,
        );
      }
      if (!this.isActive(session) || !targetMatches()) return false;
      const payload = session.data;
      committed = true;
      session.confirmedCloud = structuredClone(payload);
      session.revision = saved.revision;
      session.knownRevision = true;
      session.cloudDirty = session.data !== payload;
      session.localDirty = true;
      session.blocked = null;
      session.error = "";
      session.status = session.cloudDirty ? "saving" : "cloud";
      this.remember(session);
      this.publish(session);
      try {
        await this.persist(session);
      } catch (cause) {
        if (this.isActive(session)) {
          session.status = "error";
          session.error = `${label}已保存到云端，但尚未确认保存在此浏览器：` + errorText(cause);
          this.publish(session);
        }
      }
      return true;
    } catch (cause) {
      if (!this.isActive(session)) return false;
      session.localDirty = true;
      session.cloudDirty = true;
      if (conflictError(cause)) {
        session.blocked = "conflict";
        try {
          const latest = await this.io.loadCloud(user.id);
          if (!this.isActive(session)) return false;
          session.recovery = latest.data || createEmptyWorkspace();
          session.recoveryRevision = latest.revision;
          session.error = `${label}恢复时云端资料已变化。请检查冲突后再同步。`;
        } catch {
          session.error = `${label}恢复与云端版本冲突，暂时无法读取最新副本。`;
        }
      } else {
        session.blocked = "error";
        session.error = `${label}尚未通过云端确认：` + errorText(cause);
      }
      session.status = session.blocked;
      this.remember(session);
      this.publish(session);
      return false;
    } finally {
      this.unfenceImportTransition(session, transition.jobId);
      if (!committed && leaseToken && this.io.releaseImportParse && user) {
        try {
          await this.io.releaseImportParse(
            transition.sourceId,
            transition.versionId,
            leaseToken,
            user.id,
          );
        } catch {
          // A short-lived token can only be used by its exact holder and will
          // expire; leave the local transition recoverable for the next retry.
        }
      }
      if (committed && transition.action === "retry" && this.isActive(session))
        this.enqueueImport(session, transition.jobId);
      if (this.isActive(session) && !session.blocked && (session.localDirty || session.cloudDirty))
        void this.pump(session);
    }
  }

  private importMatchesConfirmedCloud(session: Session, jobId: string): boolean {
    if (
      !session.confirmedCloud ||
      session.cloudDirty ||
      session.localDirty ||
      session.blocked ||
      !session.knownRevision
    )
      return false;
    const local = this.importState(session, jobId);
    const remote = this.importStateFrom(session.confirmedCloud, jobId);
    return (
      !!local &&
      !!remote &&
      JSON.stringify(local.source) === JSON.stringify(remote.source) &&
      JSON.stringify(local.job) === JSON.stringify(remote.job)
    );
  }

  /**
   * A parser may only claim work which is already in the acknowledged cloud
   * snapshot. Otherwise a second browser could legitimately see no task and
   * the server would have nothing to fence. The shared pump promise makes this
   * wait for an in-flight Storage upload/snapshot save instead of racing it.
   */
  private async awaitImportCloudRegistration(session: Session, jobId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (
        !this.isActive(session) ||
        !session.ready ||
        this.writesBlocked(session) ||
        !this.importLeaseEnabled(session)
      )
        return false;
      if (this.importMatchesConfirmedCloud(session, jobId)) return true;
      if (session.blocked || session.checking) return false;
      await this.pump(session);
      if (this.importMatchesConfirmedCloud(session, jobId)) return true;
      // A clean but non-matching cloud snapshot means this job was changed by
      // another device. It must be reconciled, never parsed from stale state.
      if (session.blocked || (!session.localDirty && !session.cloudDirty)) return false;
    }
    return false;
  }

  private scheduleImportLeaseRetry(session: Session, jobId: string, leaseUntil?: string): void {
    if (!this.isActive(session) || this.writesBlocked(session) || !this.importLeaseEnabled(session))
      return;
    const key = this.importKey(session, jobId);
    if (this.importLeaseRetries.has(key)) return;
    const until = leaseUntil ? Date.parse(leaseUntil) : Number.NaN;
    // Lease duration is bounded server-side; use a capped retry so an expired
    // holder can be taken over while avoiding a busy claim loop.
    const delay = Number.isFinite(until)
      ? Math.max(1_000, Math.min(30_000, until - Date.now() + 250))
      : 15_000;
    const timer = setTimeout(() => {
      this.importLeaseRetries.delete(key);
      if (!this.isActive(session) || session.blocked || this.writesBlocked(session)) return;
      const current = this.importState(session, jobId);
      if (
        current &&
        current.job.originalSaved &&
        (current.job.status === "queued" || current.job.status === "running") &&
        !current.source.deletedAt
      )
        this.enqueueImport(session, jobId);
    }, delay);
    this.importLeaseRetries.set(key, timer);
  }

  private startImportLeaseHeartbeat(pending: PendingImport): void {
    const lease = pending.lease;
    const heartbeat = this.io.heartbeatImportParse;
    const user = pending.session.user;
    if (!lease || !heartbeat || !user) return;
    const renew = async (): Promise<void> => {
      if (
        lease.renewing ||
        lease.lost ||
        pending.controller.signal.aborted ||
        this.pendingImports.get(this.importKey(pending.session, pending.jobId)) !== pending
      )
        return;
      lease.renewing = true;
      try {
        const result = await heartbeat(lease.sourceId, lease.versionId, lease.token, user.id);
        if (result.status !== "claimed" || !result.leaseUntil)
          throw new Error("资料解析租约未能续期，已停止保存本次结果。");
        lease.leaseUntil = result.leaseUntil;
      } catch (cause) {
        const error =
          cause instanceof Error ? cause : new Error("资料解析租约未能续期，已停止保存本次结果。");
        lease.lost = error;
        if (!pending.controller.signal.aborted) pending.controller.abort(error);
      } finally {
        lease.renewing = false;
      }
    };
    const schedule = () => {
      if (lease.lost || pending.controller.signal.aborted || lease.heartbeatTimer) return;
      const until = Date.parse(lease.leaseUntil);
      const delay = Number.isFinite(until)
        ? Math.max(5_000, Math.min(30_000, Math.floor((until - Date.now()) / 2)))
        : 30_000;
      lease.heartbeatTimer = setTimeout(() => {
        lease.heartbeatTimer = undefined;
        void renew().then(schedule, () => {});
      }, delay);
    };
    schedule();
  }

  private stopImportLeaseHeartbeat(pending: PendingImport): void {
    const timer = pending.lease?.heartbeatTimer;
    if (timer) clearTimeout(timer);
    if (pending.lease) pending.lease.heartbeatTimer = undefined;
  }

  private releaseImportLease(pending: PendingImport): Promise<void> {
    const lease = pending.lease;
    if (!lease) return Promise.resolve();
    if (lease.release) return lease.release;
    this.stopImportLeaseHeartbeat(pending);
    const release = this.io.releaseImportParse;
    const user = pending.session.user;
    if (!release || !user) return Promise.resolve();
    lease.release = release(lease.sourceId, lease.versionId, lease.token, user.id);
    return lease.release;
  }

  private terminalImportData(
    session: Session,
    jobId: string,
    parsed: Source | null,
    failure?: string,
  ): WorkspaceData | null {
    const latest = this.importState(session, jobId);
    if (!latest || latest.source.deletedAt) return null;
    let running = latest.job;
    if (running.status === "queued") {
      try {
        running = startImportJob(running, new Date().toISOString());
      } catch {
        return null;
      }
    }
    if (running.status !== "running" || running.stage !== "parsing") return null;
    const validResult =
      !!parsed &&
      parsed.id === latest.source.id &&
      parsed.versionId === latest.source.versionId &&
      (parsed.status === "ready" || parsed.status === "partial");
    let job: ImportJob;
    let source: Source;
    if (validResult && parsed) {
      const indexing = advanceImportJob(running, "indexing", new Date().toISOString());
      job = completeImportJob(indexing, new Date().toISOString());
      source = parsed;
    } else {
      const detail =
        failure?.trim() ||
        parsed?.error?.trim() ||
        "原文件已保存，但未提取出可用文字。可检查原文件后重试。";
      job = failImportJob(running, detail, new Date().toISOString());
      const base = parsed && parsed.id === latest.source.id ? parsed : latest.source;
      source = {
        ...base,
        status: "failed",
        coverage:
          base.coverage?.captureScope === "full" &&
          base.coverage.parseState === "failed" &&
          base.coverage.unavailablePageRanges?.length
            ? {
                captureScope: "full",
                parseState: "failed",
                unavailablePageRanges: base.coverage.unavailablePageRanges,
              }
            : { captureScope: "full", parseState: "failed" },
        error: base.error || `原文件已保存，解析未完成：${detail}`,
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      ...session.data,
      importJobs: replaceImportJob(session.data.importJobs ?? [], job),
      sources: session.data.sources.map((item) => (item.id === source.id ? source : item)),
    };
  }

  private async finishLeasedImport(pending: PendingImport, next: WorkspaceData): Promise<boolean> {
    const { session, jobId, lease } = pending;
    const finish = this.io.finishImportParse;
    const user = session.user;
    if (!lease || !finish || !user || !this.isActive(session) || !session.ready) return false;
    const initial = this.importState(session, jobId);
    const target = this.importStateFrom(next, jobId);
    if (
      !initial ||
      !target ||
      initial.job.sourceId !== lease.sourceId ||
      initial.job.versionId !== lease.versionId ||
      target.job.sourceId !== lease.sourceId ||
      target.job.versionId !== lease.versionId
    )
      return false;
    this.fenceImportTransition(session, jobId);
    pending.transitionTarget = target;
    let committed = false;
    try {
      // Persist a recoverable local copy before sending the irreversible remote
      // result. The fence keeps a generic workspace save from racing this RPC.
      session.data = next;
      session.localDirty = true;
      session.cloudDirty = true;
      this.remember(session);
      this.publish(session);
      await this.persist(session);
      if (
        !this.isActive(session) ||
        !session.ready ||
        pending.controller.signal.aborted ||
        lease.lost ||
        !this.transitionTargetMatches(pending)
      )
        return false;
      // An allowed unrelated generic save may have started just before the
      // local fence. It can legitimately advance the workspace revision while
      // this local copy is being written. Use that newly acknowledged revision
      // and the latest staged snapshot, never release into the generic writer.
      const payload = session.data;
      const expectedRevision = session.revision;
      const saved = await finish(
        payload,
        expectedRevision,
        initial.job.sourceId,
        initial.job.versionId,
        lease.token,
        user.id,
      );
      if (!this.isActive(session)) return false;
      committed = true;
      session.confirmedCloud = structuredClone(payload);
      session.revision = saved.revision;
      session.knownRevision = true;
      session.cloudDirty = session.data !== payload;
      session.localDirty = true;
      session.blocked = null;
      session.error = "";
      session.status = session.cloudDirty ? "saving" : "cloud";
      this.remember(session);
      this.publish(session);
      try {
        await this.persist(session);
      } catch (cause) {
        if (this.isActive(session)) {
          session.status = "error";
          session.error = "解析结果已保存到云端，但尚未确认保存在此浏览器：" + errorText(cause);
          this.publish(session);
        }
      }
      return true;
    } catch (cause) {
      if (!this.isActive(session)) return false;
      session.localDirty = true;
      session.cloudDirty = true;
      if (conflictError(cause)) {
        session.blocked = "conflict";
        try {
          const remote = await this.io.loadCloud(user.id);
          if (!this.isActive(session)) return false;
          session.recovery = remote.data || createEmptyWorkspace();
          session.recoveryRevision = remote.revision;
          session.error = "云端资料或解析任务已变化。请检查冲突后再同步本次结果。";
        } catch {
          session.error = "解析结果与云端版本冲突，暂时无法读取最新副本。";
        }
      } else {
        session.blocked = "error";
        session.error = "解析结果尚未保存到云端：" + errorText(cause);
      }
      session.status = session.blocked;
      this.remember(session);
      this.publish(session);
      return false;
    } finally {
      const terminalStillStaged = this.transitionTargetMatches(pending);
      pending.transitionTarget = undefined;
      this.unfenceImportTransition(session, jobId);
      if (!committed) {
        try {
          await this.releaseImportLease(pending);
        } catch {
          // The short server lease eventually expires; preserve the local
          // snapshot and never turn a failed release into a generic save.
        }
      }
      if (
        !committed &&
        terminalStillStaged &&
        !pending.cancelling &&
        this.isActive(session) &&
        !session.blocked
      ) {
        // The source-version projection deliberately refuses terminal parse
        // data through save_workspace. Keep this recoverable local copy behind
        // an explicit error instead of releasing it into the generic writer.
        session.localDirty = true;
        session.cloudDirty = true;
        session.blocked = "error";
        session.status = "error";
        session.error = "解析结果尚未通过云端租约确认，已保留在本机。请重新连接后检查同步状态。";
        this.remember(session);
        this.publish(session);
      }
      if (
        this.isActive(session) &&
        !pending.cancelling &&
        !session.blocked &&
        (session.localDirty || session.cloudDirty)
      )
        void this.pump(session);
    }
  }

  /**
   * Cancelling and retrying replace a source-version manifest, just like a
   * completed parse. They therefore use their dedicated owner-authorized RPCs
   * rather than falling through to save_workspace's immutable projection.
   */
  private async commitOwnerImportTransition(
    session: Session,
    jobId: string,
    next: WorkspaceData,
    action: "cancel" | "retry",
  ): Promise<boolean> {
    const user = session.user;
    const send = action === "cancel" ? this.io.cancelImportParse : this.io.retryImportParse;
    const initial = this.importState(session, jobId);
    const target = this.importStateFrom(next, jobId);
    if (
      !user ||
      !send ||
      !initial ||
      !target ||
      initial.job.sourceId !== target.job.sourceId ||
      initial.job.versionId !== target.job.versionId ||
      !this.isActive(session) ||
      !session.ready
    )
      return false;
    const targetMatches = () => {
      const current = this.importState(session, jobId);
      return (
        !!current &&
        JSON.stringify(current.source) === JSON.stringify(target.source) &&
        JSON.stringify(current.job) === JSON.stringify(target.job)
      );
    };
    const label = action === "cancel" ? "取消解析" : "重新解析";
    this.fenceImportTransition(session, jobId);
    let committed = false;
    try {
      session.data = next;
      session.localDirty = true;
      session.cloudDirty = true;
      this.remember(session);
      this.publish(session);
      await this.persist(session);
      if (!this.isActive(session) || !session.ready || session.blocked || !targetMatches())
        return false;
      // See finishLeasedImport: an already-running unrelated save may have
      // advanced our locally acknowledged revision while this local copy wrote.
      const payload = session.data;
      const saved = await send(
        payload,
        session.revision,
        initial.job.sourceId,
        initial.job.versionId,
        user.id,
      );
      if (!this.isActive(session)) return false;
      committed = true;
      session.confirmedCloud = structuredClone(payload);
      session.revision = saved.revision;
      session.knownRevision = true;
      session.cloudDirty = session.data !== payload;
      session.localDirty = true;
      session.blocked = null;
      session.error = "";
      session.status = session.cloudDirty ? "saving" : "cloud";
      this.remember(session);
      this.publish(session);
      try {
        await this.persist(session);
      } catch (cause) {
        if (this.isActive(session)) {
          session.status = "error";
          session.error = `${label}已保存到云端，但尚未确认保存在此浏览器：` + errorText(cause);
          this.publish(session);
        }
      }
      return true;
    } catch (cause) {
      if (!this.isActive(session)) return false;
      session.localDirty = true;
      session.cloudDirty = true;
      if (conflictError(cause)) {
        session.blocked = "conflict";
        try {
          const remote = await this.io.loadCloud(user.id);
          if (!this.isActive(session)) return false;
          session.recovery = remote.data || createEmptyWorkspace();
          session.recoveryRevision = remote.revision;
          session.error = `${label}时云端资料已变化。请检查冲突后再同步。`;
        } catch {
          session.error = `${label}与云端版本冲突，暂时无法读取最新副本。`;
        }
      } else {
        session.blocked = "error";
        session.error = `${label}尚未保存到云端：` + errorText(cause);
      }
      session.status = session.blocked;
      this.remember(session);
      this.publish(session);
      return false;
    } finally {
      const transitionStillStaged = targetMatches();
      this.unfenceImportTransition(session, jobId);
      if (!committed && transitionStillStaged && this.isActive(session) && !session.blocked) {
        session.localDirty = true;
        session.cloudDirty = true;
        session.blocked = "error";
        session.status = "error";
        session.error = `${label}尚未通过云端确认，已保留在本机。请重新连接后检查同步状态。`;
        this.remember(session);
        this.publish(session);
      }
      if (this.isActive(session) && !session.blocked && (session.localDirty || session.cloudDirty))
        void this.pump(session);
    }
  }

  private async retryCloudImport(session: Session, jobId: string): Promise<void> {
    if (!(await this.awaitImportCloudRegistration(session, jobId)))
      throw new Error("请等待当前资料同步完成，再重新解析。");
    const next = this.retryImportData(session, jobId);
    if (!next) throw new Error("导入资料已变化，请重新打开后重试。");
    if (!(await this.commitOwnerImportTransition(session, jobId, next, "retry"))) {
      if (!session.blocked) throw new Error("导入资料已变化，请重新打开后重试。");
      throw new Error(session.error || "重新解析尚未保存到云端。");
    }
    const current = this.importState(session, jobId);
    if (this.isActive(session) && current?.job.status === "queued" && !current.source.deletedAt)
      this.enqueueImport(session, jobId);
  }

  private async cancelCloudImport(session: Session, jobId: string): Promise<void> {
    try {
      if (!(await this.awaitImportCloudRegistration(session, jobId)))
        throw new Error("请等待当前资料同步完成后再取消解析。");
      const next = this.cancelledImportData(session, jobId);
      if (!next) throw new Error("导入资料已变化，请重新打开后再取消。");
      if (!(await this.commitOwnerImportTransition(session, jobId, next, "cancel"))) {
        if (!session.blocked) throw new Error("导入资料已变化，请重新打开后再取消。");
        throw new Error(session.error || "取消解析尚未保存到云端。");
      }
      this.queuedImports = this.queuedImports.filter(
        (item) => this.importKey(item.session, item.jobId) !== this.importKey(session, jobId),
      );
      this.clearImportLeaseRetry(session, jobId);
    } catch (cause) {
      if (this.isActive(session) && !session.blocked) {
        session.status = "error";
        session.error = "取消解析失败：" + errorText(cause);
        this.publish(session);
      }
    } finally {
      this.cancellingImports.delete(this.importKey(session, jobId));
    }
  }

  /** Flush unrelated edits before fencing the parsed pair at the current CAS revision. */
  private async readyToFinishLeasedImport(pending: PendingImport): Promise<boolean> {
    await this.pump(pending.session);
    if (
      !this.isActive(pending.session) ||
      !pending.session.ready ||
      pending.controller.signal.aborted ||
      pending.lease?.lost ||
      pending.session.blocked ||
      pending.session.localDirty ||
      pending.session.cloudDirty
    )
      return false;
    return !this.importError(pending);
  }

  private commitImportData(session: Session, next: WorkspaceData): boolean {
    if (
      !this.isActive(session) ||
      !session.ready ||
      this.writesBlocked(session) ||
      next === session.data
    )
      return false;
    session.data = next;
    session.localDirty = true;
    if (session.user) session.cloudDirty = true;
    this.remember(session);
    this.publish(session);
    void this.pump(session);
    return true;
  }

  private importKey(session: Session, jobId: string) {
    return `${session.token}:${jobId}`;
  }

  private importState(session: Session, jobId: string): { job: ImportJob; source: Source } | null {
    return this.importStateFrom(session.data, jobId);
  }

  private updateImportState(session: Session, job: ImportJob, source?: Source): boolean {
    const current = this.importState(session, job.id);
    if (
      !current ||
      current.job.sourceId !== job.sourceId ||
      current.job.versionId !== job.versionId ||
      (source && (source.id !== job.sourceId || source.versionId !== job.versionId))
    )
      return false;
    return this.commitImportData(session, {
      ...session.data,
      importJobs: replaceImportJob(session.data.importJobs ?? [], job),
      ...(source
        ? {
            sources: session.data.sources.map((item) => (item.id === source.id ? source : item)),
          }
        : {}),
    });
  }

  private addImportState(session: Session, source: Source, job: ImportJob): boolean {
    if (!this.isActive(session) || !session.ready) return false;
    if (
      session.data.sources.some((item) => item.id === source.id) ||
      session.data.importJobs?.some((item) => item.id === job.id)
    )
      return false;
    return this.commitImportData(session, {
      ...session.data,
      sources: [source, ...session.data.sources],
      importJobs: [...(session.data.importJobs ?? []), job],
    });
  }

  private importError(pending: PendingImport): Error | null {
    if (!this.isActive(pending.session) || !pending.session.ready)
      return new Error("当前账号已改变，导入已停止。请在当前账号重新选择文件。");
    if (this.isCloudReadOnly(pending.session)) return new Error(this.readOnlyMessage());
    if (this.hasNewerLocalUpdate(pending.session) || pending.session.loadingLocalUpdate)
      return new Error("另一个标签页已保存更新，导入已暂停。请载入最新数据后重试。");
    if (pending.controller.signal.aborted) return new DOMException("导入已取消。", "AbortError");
    if (pending.lease?.lost) return pending.lease.lost;
    const current = this.importState(pending.session, pending.jobId);
    if (!current) return new Error("导入资料或任务已变化，未保存迟到的解析结果。");
    // A fenced finish/cancel/retry intentionally replaces the normal running
    // state before its dedicated RPC settles. Accept only the exact staged pair;
    // any independent edit remains a late-result boundary and aborts the worker.
    if (this.transitionTargetMatches(pending)) return null;
    if (current.job.status === "cancelled") return new DOMException("导入已取消。", "AbortError");
    if (current.job.status !== "running" && !(pending.lease && current.job.status === "queued"))
      return new Error("导入任务状态已改变，未保存迟到的解析结果。");
    if (current.source.deletedAt)
      return new Error("资料已移入回收站，解析已停止。恢复后可重新开始解析。");
    return null;
  }

  private enqueueImport(session: Session, jobId: string) {
    if (this.writesBlocked(session)) return;
    const key = this.importKey(session, jobId);
    // A just-cancelled worker may still be unwinding. Permit one successor in
    // the FIFO queue so an immediate retry is not lost behind that cleanup.
    if (this.queuedImports.some((item) => this.importKey(item.session, item.jobId) === key)) return;
    this.queuedImports.push({ session, jobId });
    void this.drainImports();
  }

  private async drainImports(): Promise<void> {
    if (this.drainingImports) return;
    this.drainingImports = true;
    try {
      while (this.queuedImports.length) {
        const next = this.queuedImports.shift()!;
        if (this.writesBlocked(next.session)) continue;
        await this.runImport(next.session, next.jobId);
      }
    } finally {
      this.drainingImports = false;
      // A task may have been appended between the final queue check and the
      // finally block in a synchronous test double.
      if (this.queuedImports.length) void this.drainImports();
    }
  }

  private async runLeasedImport(session: Session, jobId: string): Promise<void> {
    const claim = this.io.claimImportParse;
    const user = session.user;
    if (!claim || !user || !this.importLeaseEnabled(session)) return;
    const key = this.importKey(session, jobId);
    if (this.cancellingImports.has(key)) return;
    const queued = this.importState(session, jobId);
    if (
      !queued ||
      !queued.job.originalSaved ||
      (queued.job.status !== "queued" && queued.job.status !== "running") ||
      queued.source.deletedAt
    )
      return;
    if (!(await this.awaitImportCloudRegistration(session, jobId))) return;
    if (this.cancellingImports.has(key)) return;

    let claimed: ImportParseLease;
    try {
      claimed = await claim(queued.job.sourceId, queued.job.versionId, user.id);
    } catch (cause) {
      // A completed/cancelled remote job is a normal cross-device race. Reload
      // that exact remote snapshot rather than treating a stale parser as an
      // import failure. Transport errors retain the durable pending job and
      // try again after a short delay.
      if (conflictError(cause)) void this.retry(session.token).catch(() => {});
      else this.scheduleImportLeaseRetry(session, jobId);
      return;
    }
    if (claimed.status === "held") {
      this.scheduleImportLeaseRetry(session, jobId, claimed.leaseUntil);
      return;
    }
    if (claimed.status !== "claimed" || !claimed.leaseToken || !claimed.leaseUntil) {
      this.scheduleImportLeaseRetry(session, jobId);
      return;
    }

    if (this.cancellingImports.has(key)) {
      try {
        await this.io.releaseImportParse!(
          queued.job.sourceId,
          queued.job.versionId,
          claimed.leaseToken,
          user.id,
        );
      } catch {
        // The owner-level cancellation RPC will invalidate this short lease.
      }
      return;
    }

    const latest = this.importState(session, jobId);
    if (
      !latest ||
      latest.source.deletedAt ||
      (latest.job.status !== "queued" && latest.job.status !== "running")
    ) {
      try {
        await this.io.releaseImportParse!(
          queued.job.sourceId,
          queued.job.versionId,
          claimed.leaseToken,
          user.id,
        );
      } catch {
        // The token expires shortly if this browser changed state after claim.
      }
      return;
    }
    this.clearImportLeaseRetry(session, jobId);
    const pending: PendingImport = {
      session,
      jobId,
      controller: new AbortController(),
      lease: {
        sourceId: latest.job.sourceId,
        versionId: latest.job.versionId,
        token: claimed.leaseToken,
        leaseUntil: claimed.leaseUntil,
        renewing: false,
      },
    };
    this.pendingImports.set(key, pending);
    this.startImportLeaseHeartbeat(pending);
    try {
      const initial = this.importError(pending);
      if (initial) throw initial;
      const source = this.importState(session, jobId)?.source;
      // Do not download the cloud original until this browser owns the server
      // lease. That is the actual duplicate-work fence, not merely the final
      // revision CAS.
      const blob = source ? await this.sourceBlob(source, session.token) : undefined;
      const afterRead = this.importError(pending);
      if (afterRead) throw afterRead;
      if (!source?.blobKey || !blob)
        throw new Error("原文件在此浏览器中不可用，无法继续解析。请重新选择原文件。");
      const parsed = await this.imports.parse(source, blob, { signal: pending.controller.signal });
      const afterParse = this.importError(pending);
      if (afterParse) throw afterParse;
      if (parsed.id !== source.id || parsed.versionId !== source.versionId)
        throw new Error("解析结果身份不一致，未保存到其他资料。");
      if (!(await this.readyToFinishLeasedImport(pending))) return;
      const next = this.terminalImportData(session, jobId, parsed);
      if (next) await this.finishLeasedImport(pending, next);
    } catch (cause) {
      if (pending.controller.signal.aborted || pending.lease?.lost) {
        if (this.isActive(session) && pending.lease?.lost)
          this.scheduleImportLeaseRetry(session, jobId, pending.lease.leaseUntil);
        return;
      }
      const current = this.importState(session, jobId);
      if (
        !current ||
        !this.isActive(session) ||
        !session.ready ||
        current.job.status === "cancelled" ||
        current.source.deletedAt
      )
        return;
      if (!(await this.readyToFinishLeasedImport(pending))) return;
      const next = this.terminalImportData(session, jobId, null, errorText(cause));
      if (next) await this.finishLeasedImport(pending, next);
    } finally {
      this.stopImportLeaseHeartbeat(pending);
      if (this.pendingImports.get(key) === pending) this.pendingImports.delete(key);
      try {
        // Success removes the token in the atomic finish RPC. Release is
        // intentionally idempotent, so this also closes any failed attempt.
        await this.releaseImportLease(pending);
      } catch {
        // Keep the local snapshot; a stale token cannot publish after expiry.
      }
    }
  }

  private async runImport(session: Session, jobId: string): Promise<void> {
    if (this.writesBlocked(session)) return;
    if (this.importLeaseEnabled(session)) {
      await this.runLeasedImport(session, jobId);
      return;
    }
    const queued = this.importState(session, jobId);
    if (
      !queued ||
      (queued.job.status !== "queued" && queued.job.status !== "running") ||
      !queued.job.originalSaved
    )
      return;
    let running = queued.job;
    if (queued.job.status === "queued") {
      try {
        running = startImportJob(queued.job, new Date().toISOString());
      } catch {
        return;
      }
      if (!this.updateImportState(session, running, queued.source)) return;
    }
    const pending: PendingImport = { session, jobId, controller: new AbortController() };
    const key = this.importKey(session, jobId);
    this.pendingImports.set(key, pending);
    try {
      const initial = this.importError(pending);
      if (initial) throw initial;
      const source = this.importState(session, jobId)?.source;
      // A resumed account can have a durable Storage original before this
      // browser has cached it. `sourceBlob` first checks IndexedDB, then only
      // downloads the exact current account/version path after revalidating it.
      const blob = source ? await this.sourceBlob(source, session.token) : undefined;
      const afterRead = this.importError(pending);
      if (afterRead) throw afterRead;
      if (!source?.blobKey || !blob)
        throw new Error("原文件在此浏览器中不可用，无法继续解析。请重新选择原文件。");
      const parsed = await this.imports.parse(source, blob, { signal: pending.controller.signal });
      const afterParse = this.importError(pending);
      if (afterParse) throw afterParse;
      if (parsed.id !== source.id || parsed.versionId !== source.versionId)
        throw new Error("解析结果身份不一致，未保存到其他资料。");
      const latest = this.importState(session, jobId);
      if (!latest || latest.job.status !== "running") return;
      if (parsed.status !== "ready" && parsed.status !== "partial") {
        const failed = failImportJob(
          latest.job,
          parsed.error || "原文件已保存，但未提取出可用文字。可检查原文件后重试。",
          new Date().toISOString(),
        );
        this.updateImportState(session, failed, {
          ...parsed,
          status: "failed",
          coverage:
            parsed.coverage?.captureScope === "full" &&
            parsed.coverage.parseState === "failed" &&
            parsed.coverage.unavailablePageRanges?.length
              ? {
                  captureScope: "full" as const,
                  parseState: "failed" as const,
                  unavailablePageRanges: parsed.coverage.unavailablePageRanges,
                }
              : { captureScope: "full" as const, parseState: "failed" as const },
        });
        return;
      }
      const indexing = advanceImportJob(latest.job, "indexing", new Date().toISOString());
      if (!this.updateImportState(session, indexing, parsed)) return;
      const completed = completeImportJob(indexing, new Date().toISOString());
      this.updateImportState(session, completed, parsed);
    } catch (cause) {
      const current = this.importState(session, jobId);
      if (
        !current ||
        !this.isActive(session) ||
        !session.ready ||
        current.job.status === "cancelled" ||
        current.source.deletedAt
      )
        return;
      if (current.job.status !== "running") return;
      const detail = errorText(cause).trim();
      const failed = failImportJob(
        current.job,
        detail || "导入失败，请重新解析原文件。",
        new Date().toISOString(),
      );
      const source = {
        ...current.source,
        status: "failed" as const,
        coverage: { captureScope: "full" as const, parseState: "failed" as const },
        error: current.source.error || `原文件已保存，解析未完成：${detail || "未知错误"}`,
        updatedAt: new Date().toISOString(),
      };
      this.updateImportState(session, failed, source);
    } finally {
      if (this.pendingImports.get(key) === pending) this.pendingImports.delete(key);
    }
  }

  private recoverImportJobs(session: Session) {
    if (
      !this.isActive(session) ||
      !session.ready ||
      this.writesBlocked(session) ||
      (session.blocked && this.importLeaseEnabled(session))
    )
      return;
    const coordinated = this.importLeaseEnabled(session);
    const now = new Date().toISOString();
    const normalized = cancelImportJobsForRecycledSources(session.data, now);
    if (normalized !== session.data) this.commitImportData(session, normalized);
    const jobs = session.data.importJobs;
    if (!jobs?.length) return;
    let changed = false;
    const sources = session.data.sources.map((source) => ({ ...source }));
    const nextJobs = jobs.map((job) => {
      // Recovery can also run after a local persistence retry. Do not reset a
      // parser that is already alive in this coordinator.
      if (this.pendingImports.has(this.importKey(session, job.id))) return job;
      if (job.status !== "queued" && job.status !== "running") return job;
      const source = sources.find(
        (item) => item.id === job.sourceId && item.versionId === job.versionId,
      );
      if (session.data.sources.some((item) => item.id === job.sourceId && item.deletedAt)) {
        changed = true;
        return cancelImportJob(job, now);
      }
      if (source && !source.deletedAt && job.originalSaved) {
        // A remotely coordinated job stays byte-for-byte identical until the
        // claimant owns a lease. Requeueing a running job here would make an
        // unrelated browser's generic snapshot write conflict with that lease.
        if (coordinated) return job;
        source.coverage = { captureScope: "full", parseState: "pending" };
        const resumed = resumeImportJob(job, now);
        changed ||= resumed !== job;
        return resumed;
      }
      const running = job.status === "queued" ? startImportJob(job, now) : job;
      const failed = failImportJob(
        running,
        source?.deletedAt
          ? "资料已移入回收站，未继续解析。恢复资料后可重新开始。"
          : "原文件尚未确认保存在此浏览器，无法继续解析。请重新选择原文件。",
        now,
      );
      if (source && !source.deletedAt) {
        source.status = "failed";
        source.coverage = { captureScope: "full", parseState: "failed" };
        source.error = failed.error;
        source.updatedAt = now;
      }
      changed = true;
      return failed;
    });
    if (changed) this.commitImportData(session, { ...session.data, sources, importJobs: nextJobs });
    for (const job of nextJobs) {
      if (
        job.originalSaved &&
        (job.status === "queued" || (coordinated && job.status === "running"))
      )
        if (!this.cancellingImports.has(this.importKey(session, job.id)))
          this.enqueueImport(session, job.id);
    }
  }

  /**
   * The import modal offers an early preview, but callers can bypass that UI.
   * A normal pick must reach SHA-256 duplicate detection before account storage
   * is decided: reusing an existing original consumes no new bytes. File and
   * batch limits remain safe to check before hashing.
   */
  private assertImportQuotaForData(
    data: WorkspaceData,
    file: File,
    options: { deferAccountStorageLimit?: boolean } = {},
  ): void {
    const [item] = assessImportQuota(data, [file], undefined, options).items;
    if (!item || item.accepted) return;
    const detail = item.rejections.map((rejection) => rejection.message).join(" ");
    throw new Error(detail || "这份文件不符合本机导入额度，请调整后重试。");
  }

  private assertImportQuota(
    session: Session,
    file: File,
    options: { deferAccountStorageLimit?: boolean } = {},
  ): void {
    this.assertImportQuotaForData(session.data, file, options);
  }

  async importFile(
    file: File,
    spaceId: string,
    token: number,
    keepDuplicate = false,
    aiAllowed = false,
  ): Promise<ImportStartResult> {
    const session = this.active;
    if (!session?.ready || session.token !== token)
      throw new Error("当前账号已改变，请重新选择需要导入的文件。");
    this.assertWorkspaceWritable(session);
    return withImportAccountReservation(accountKey(session.user), async () => {
      if (!this.isActive(session) || !session.ready || session.token !== token)
        throw new Error("当前账号已改变，未导入这份文件。");
      this.assertWorkspaceWritable(session);
      // A normal pick can be a duplicate, so only reject structural limits
      // before hashing. A requested independent copy always needs new bytes,
      // and can be rejected against the account limit immediately.
      this.assertImportQuota(session, file, { deferAccountStorageLimit: !keepDuplicate });
      const prepared = await this.imports.prepare(file, spaceId, aiAllowed);
      if (!this.isActive(session) || !session.ready || session.token !== token)
        throw new Error("当前账号已改变，未导入这份文件。");
      return withImportHashReservation(prepared.hash, () =>
        this.savePreparedImport(session, prepared, file, spaceId, token, keepDuplicate),
      );
    });
  }

  private async savePreparedImportAtomically(
    session: Session,
    prepared: Source,
    file: File,
    spaceId: string,
    token: number,
    keepDuplicate: boolean,
  ): Promise<ImportStartResult> {
    const commit = this.io.commitLocalImport;
    if (!commit) throw new Error("当前环境无法原子保存导入资料。");
    const blobKey = prepared.blobKey!;
    await verifyOriginal(prepared, file);
    if (!this.isActive(session) || !session.ready || session.token !== token)
      throw new Error("当前账号已改变，未导入这份文件。");
    this.assertWorkspaceWritable(session);

    // Flush this page first. The transaction below then merges against the
    // newest persisted account record, including a commit from another tab.
    while (session.localDirty) {
      await this.persist(session);
      if (!this.isActive(session) || !session.ready || session.token !== token)
        throw new Error("当前账号已改变，未导入这份文件。");
    }
    this.assertWorkspaceWritable(session);
    const boundaryData = session.data;
    const boundaryRevision = session.revision;
    const boundaryCloudDirty = session.cloudDirty;
    const boundaryConfirmedCloud = session.confirmedCloud;
    const boundaryKnownRevision = session.knownRevision;
    const accountId = accountKey(session.user);
    let releaseAtomicBarrier = () => {};
    const atomicBarrier = new Promise<void>((resolve) => {
      releaseAtomicBarrier = resolve;
    });
    this.atomicLocalWriteBarriers.set(session, atomicBarrier);
    let barrierReleased = false;
    const openBarrier = () => {
      if (barrierReleased) return;
      barrierReleased = true;
      if (this.atomicLocalWriteBarriers.get(session) === atomicBarrier)
        this.atomicLocalWriteBarriers.delete(session);
      releaseAtomicBarrier();
    };

    try {
      const previous = this.queues.get(accountId) || Promise.resolve();
      const transaction = previous.then(() => {
        if (
          this.discardedSessions.has(session) ||
          !this.isActive(session) ||
          !session.ready ||
          session.token !== token
        )
          throw new Error("当前账号已改变，未导入这份文件。");
        this.assertWorkspaceWritable(session);
        return commit<AtomicPreparedImportResult>(accountId, blobKey, file, (latestStored) => {
          const latest = unpack(latestStored).data;
          if (!latest) throw new Error("本机工作区尚未确认保存，未写入原文件。请重新载入后重试。");
          const duplicate = latest.sources.find(
            (source) => !source.deletedAt && !!source.hash && source.hash === prepared.hash,
          );
          if (duplicate && !keepDuplicate) {
            const spaceIds = [...new Set([...duplicate.spaceIds, ...(spaceId ? [spaceId] : [])])];
            const joined =
              spaceIds.length === duplicate.spaceIds.length
                ? duplicate
                : { ...duplicate, spaceIds };
            const changed = joined !== duplicate;
            const next = changed
              ? {
                  ...latest,
                  sources: latest.sources.map((source) =>
                    source.id === duplicate.id ? joined : source,
                  ),
                }
              : latest;
            return {
              workspace: this.storedAtomicImport(session, latestStored, latest, next, changed),
              storeBlob: false,
              result: {
                start: { kind: "duplicate", source: joined } as ImportStartResult,
                source: joined,
                changed,
              } satisfies AtomicPreparedImportResult,
            };
          }

          this.assertImportQuotaForData(latest, file);
          const now = new Date().toISOString();
          const createdJob = createImportJob({
            sourceId: prepared.id,
            versionId: prepared.versionId,
            filename: prepared.filename,
            spaceId,
            at: now,
          });
          const job = advanceImportJob(startImportJob(createdJob, now), "parsing", now);
          const source = {
            ...prepared,
            status: "parsing" as const,
            error: undefined,
            updatedAt: now,
          };
          if (
            latest.sources.some((item) => item.id === source.id) ||
            latest.importJobs?.some((item) => item.id === job.id)
          )
            throw new Error("导入资料标识已存在，未创建重复副本。");
          const next = {
            ...latest,
            sources: [source, ...latest.sources],
            importJobs: [...(latest.importJobs ?? []), job],
          };
          return {
            workspace: this.storedAtomicImport(session, latestStored, latest, next, true),
            storeBlob: true,
            result: {
              start: { kind: "queued", job } as ImportStartResult,
              source,
              job,
              changed: true,
            } satisfies AtomicPreparedImportResult,
          };
        });
      });
      // Account deletion waits for this write before removing the account cache;
      // later local snapshots are also serialized behind its exact result.
      this.queues.set(
        accountId,
        transaction.then(
          () => {},
          () => {},
        ),
      );
      const committed = await transaction;
      if (this.discardedSessions.has(session))
        throw new Error("当前账号已改变，导入任务已保留在原账号的本机副本中。");

      const stored = unpack(committed.workspace);
      if (!stored.data || stored.localRevision !== committed.localRevision)
        throw new Error("本机导入结果无法读取，请重新载入后检查资料。");
      const syncChangedWhileWaiting =
        session.revision !== boundaryRevision ||
        session.cloudDirty !== boundaryCloudDirty ||
        session.confirmedCloud !== boundaryConfirmedCloud ||
        session.knownRevision !== boundaryKnownRevision;
      const dataChangedWhileWaiting = session.data !== boundaryData;
      const storedChangedAtBoundary = !sameData(stored.data, boundaryData);
      const needsRepairPersist = dataChangedWhileWaiting || syncChangedWhileWaiting;
      const mergedData = needsRepairPersist
        ? this.mergeConcurrentImportCommit(session.data, stored.data, boundaryData)
        : stored.data;
      if (!mergedData) {
        session.localDirty = true;
        session.blocked = "error";
        session.status = "error";
        session.error =
          "导入任务已保留在本机，但另一标签页同时修改了相同资料。当前页面的修改未覆盖较新副本；请先导出需要保留的内容，再重新载入。";
        this.remember(session);
        this.publish(session);
        throw new Error(session.error);
      }

      if (session.user && !syncChangedWhileWaiting) {
        const meta = stored.meta;
        if (meta) {
          session.revision = meta.revision;
          session.knownRevision = true;
          session.cloudDirty = meta.dirty;
          session.confirmedCloud = meta.dirty
            ? meta.base && meta.baseRevision === meta.revision
              ? structuredClone(meta.base)
              : null
            : structuredClone(stored.data);
        } else if (committed.result.changed) session.cloudDirty = true;
      } else if (!session.user) {
        session.cloudDirty = false;
      }

      session.data = mergedData;
      this.setLocalRevision(session, committed.localRevision);
      session.localDirty = needsRepairPersist;
      if (needsRepairPersist && session.user)
        session.cloudDirty = session.cloudDirty || storedChangedAtBoundary;
      this.remember(session);
      this.publish(session);
      // Waiting editor/cloud callbacks now see the adopted revision and merged
      // snapshot. This repair is enqueued synchronously before they resume, so
      // all callers coalesce on the same safe full-workspace save.
      openBarrier();
      if (needsRepairPersist) {
        await this.persist(session);
        this.publish(session);
      }
      if (!this.isActive(session) || !session.ready || session.token !== token)
        throw new Error("当前账号已改变，导入任务已保留在原账号的本机副本中。");
      void this.pump(session);
      if (committed.result.start.kind === "queued")
        this.enqueueImport(session, committed.result.start.job.id);
      return committed.result.start;
    } finally {
      openBarrier();
    }
  }

  private async savePreparedImport(
    session: Session,
    prepared: Source,
    file: File,
    spaceId: string,
    token: number,
    keepDuplicate: boolean,
  ): Promise<ImportStartResult> {
    if (!this.isActive(session) || !session.ready || session.token !== token)
      throw new Error("当前账号已改变，未导入这份文件。");
    this.assertWorkspaceWritable(session);
    if (this.io.commitLocalImport) {
      const blobKey = prepared.blobKey!;
      if (pendingFileKeys.has(blobKey)) throw new Error("这份文件正在保存，请等待完成。");
      pendingFileKeys.add(blobKey);
      try {
        return await this.savePreparedImportAtomically(
          session,
          prepared,
          file,
          spaceId,
          token,
          keepDuplicate,
        );
      } finally {
        pendingFileKeys.delete(blobKey);
      }
    }
    const duplicate = session.data.sources.find(
      (source) => !source.deletedAt && !!source.hash && source.hash === prepared.hash,
    );
    if (duplicate && !keepDuplicate) {
      const spaceIds = [...new Set([...duplicate.spaceIds, ...(spaceId ? [spaceId] : [])])];
      const joined =
        spaceIds.length === duplicate.spaceIds.length ? duplicate : { ...duplicate, spaceIds };
      if (
        joined !== duplicate &&
        !this.update(
          (data) => ({
            ...data,
            sources: data.sources.map((source) => (source.id === duplicate.id ? joined : source)),
          }),
          token,
        )
      )
        throw new Error("这份资料正在解析，请先取消解析或等待完成后再添加到其他知识库。");
      return { kind: "duplicate", source: joined };
    }
    // `prepare` can be slow and other live workspace operations can happen
    // while it runs. Check again at the write boundary so a stale admission
    // cannot put an original over the account cap.
    this.assertImportQuota(session, file);
    if (!this.io.putBlobIfAbsent)
      throw new Error("当前环境无法安全保存原文件，请重新载入后重试。资料未导入。");
    const blobKey = prepared.blobKey!;
    if (pendingFileKeys.has(blobKey)) throw new Error("这份文件正在保存，请等待完成。");
    pendingFileKeys.add(blobKey);
    let created = false;
    let published = false;
    try {
      await verifyOriginal(prepared, file);
      created = await this.putLocalOriginal(session, blobKey, file);
      if (!created) throw new Error("原文件标识已存在，请重新选择文件后重试。已有原件未被覆盖。");
      const stored = await this.readLocalOriginal(session, blobKey);
      if (!stored) throw new Error("原文件尚未确认保存在此浏览器，资料未导入。");
      await verifyOriginal(prepared, stored);
      if (!this.isActive(session) || !session.ready)
        throw new Error("当前账号已改变，未将这份文件写入新账号。");
      this.assertWorkspaceWritable(session);
      const now = new Date().toISOString();
      const createdJob = createImportJob({
        sourceId: prepared.id,
        versionId: prepared.versionId,
        filename: prepared.filename,
        spaceId,
        at: now,
      });
      // The original has been read back before this state is published. Persist
      // a resumable parsing task rather than relying on the open import dialog.
      const running = startImportJob(createdJob, now);
      const parsing = advanceImportJob(running, "parsing", now);
      const job = parsing;
      const source = { ...prepared, status: "parsing" as const, error: undefined, updatedAt: now };
      published = this.addImportState(session, source, job);
      if (!published) throw new Error("导入资料已变化，未创建重复副本。");
      await this.persist(session);
      if (!this.isActive(session) || !session.ready)
        throw new Error("当前账号已改变，导入任务已保留在原账号的本机副本中。");
      this.enqueueImport(session, job.id);
      return { kind: "queued", job };
    } catch (cause) {
      if (!published && created && this.io.deleteUnreferencedBlob) {
        try {
          await this.deleteLocalOriginal(session, blobKey);
        } catch {
          // An unverified cleanup must never hide the original save failure.
        }
      }
      throw cause;
    } finally {
      pendingFileKeys.delete(blobKey);
    }
  }

  private retryImportData(session: Session, jobId: string): WorkspaceData | null {
    const current = this.importState(session, jobId);
    if (!current || current.source.deletedAt || !current.job.originalSaved) return null;
    const job = retryImportJob(current.job, new Date().toISOString());
    if (
      session.data.annotations.some(
        (annotation) =>
          annotation.sourceId === current.source.id &&
          annotation.versionId === current.source.versionId &&
          annotation.textAnchor !== undefined,
      )
    )
      throw new Error("此版本已有原文位置批注，请保留此版本并新建导入，避免重新解析改变批注原文。");
    const source = {
      ...current.source,
      status: "parsing" as const,
      text: "",
      chunks: [],
      error: undefined,
      pageCount: undefined,
      parsedPages: undefined,
      coverage: { captureScope: "full" as const, parseState: "pending" as const },
      updatedAt: new Date().toISOString(),
    };
    return {
      ...session.data,
      importJobs: replaceImportJob(session.data.importJobs ?? [], job),
      sources: session.data.sources.map((item) => (item.id === source.id ? source : item)),
    };
  }

  async retryImport(jobId: string, token: number): Promise<void> {
    const session = this.active;
    if (!session?.ready || session.token !== token)
      throw new Error("当前账号已改变，请重新打开导入记录。");
    this.assertWorkspaceWritable(session);
    const current = this.importState(session, jobId);
    if (!current || current.source.deletedAt)
      throw new Error("导入资料已不可用，请返回资料库检查。");
    if (!current.job.originalSaved)
      throw new Error("原文件尚未保存到此浏览器，请重新选择原文件后再导入。");
    const next = this.retryImportData(session, jobId);
    if (!next) throw new Error("导入资料已变化，请重新打开后重试。");
    // Retrying creates a new in-progress state for the same immutable source.
    // Confirm that state locally before allowing a parser to run again, just as
    // the initial import does.
    if (this.importLeaseEnabled(session) && this.io.retryImportParse) {
      await this.retryCloudImport(session, jobId);
      return;
    }
    if (!this.commitImportData(session, next))
      throw new Error("导入资料已变化，请重新打开后重试。");
    await this.persist(session);
    if (!this.isActive(session) || !session.ready)
      throw new Error("当前账号已改变，导入任务已保留在原账号的本机副本中。");
    this.enqueueImport(session, jobId);
  }

  private cancelledImportData(session: Session, jobId: string): WorkspaceData | null {
    const current = this.importState(session, jobId);
    if (!current || current.source.deletedAt) return null;
    let job: ImportJob;
    try {
      job = cancelImportJob(current.job, new Date().toISOString());
    } catch {
      return null;
    }
    const source = {
      ...current.source,
      status: "saved" as const,
      text: "",
      chunks: [],
      error: "解析已取消。原文件已保存，可继续解析。",
      pageCount: undefined,
      parsedPages: undefined,
      coverage: { captureScope: "full" as const, parseState: "pending" as const },
      updatedAt: new Date().toISOString(),
    };
    return {
      ...session.data,
      importJobs: replaceImportJob(session.data.importJobs ?? [], job),
      sources: session.data.sources.map((item) => (item.id === source.id ? source : item)),
    };
  }

  private applyImportCancellation(session: Session, jobId: string): boolean {
    const next = this.cancelledImportData(session, jobId);
    if (!next || !this.commitImportData(session, next)) return false;
    this.queuedImports = this.queuedImports.filter(
      (item) => this.importKey(item.session, item.jobId) !== this.importKey(session, jobId),
    );
    this.clearImportLeaseRetry(session, jobId);
    return true;
  }

  cancelImport(jobId: string, token: number): void {
    const session = this.active;
    if (!session?.ready || session.token !== token || this.writesBlocked(session)) return;
    const key = this.importKey(session, jobId);
    const current = this.importState(session, jobId);
    const canCancelInCloud =
      !!current &&
      !current.source.deletedAt &&
      current.job.originalSaved &&
      current.job.stage === "parsing" &&
      (current.job.status === "queued" || current.job.status === "running");
    if (this.importLeaseEnabled(session) && this.io.cancelImportParse && canCancelInCloud) {
      if (this.cancellingImports.has(key)) return;
      this.cancellingImports.add(key);
      const pending = this.pendingImports.get(key);
      if (pending) {
        pending.cancelling = true;
        if (!pending.controller.signal.aborted)
          pending.controller.abort(new DOMException("导入已取消。", "AbortError"));
      }
      this.queuedImports = this.queuedImports.filter(
        (item) => this.importKey(item.session, item.jobId) !== this.importKey(session, jobId),
      );
      this.clearImportLeaseRetry(session, jobId);
      // This owner-authorized RPC invalidates any same-account lease atomically.
      // It is safe even when another device currently owns the parser; a late
      // token-fenced finish then loses its lease instead of reviving the task.
      void this.cancelCloudImport(session, jobId);
      return;
    }
    if (!this.applyImportCancellation(session, jobId)) return;
    this.pendingImports.get(key)?.controller.abort(new DOMException("导入已取消。", "AbortError"));
  }

  async ask(
    request: AnswerRequest,
    signal: AbortSignal,
    token: number,
    onProgress?: OnAnswerProgress,
  ) {
    const session = this.active;
    if (!session?.ready || session.token !== token)
      throw new Error("当前账号已改变，请重新打开问答。");
    if (this.isCloudReadOnly(session)) throw new Error(this.readOnlyMessage());
    if (signal.aborted) throw new DOMException("已停止", "AbortError");
    if (this.organizationBusy(token))
      throw new Error("资料整理正在进行，请等待完成或先停止整理，再发起问答。");
    // The all-library panel validates before it creates a conversation, but a
    // current local snapshot can change before this adapter runs. Recheck the
    // exact cross-library range here for both local and cloud paths; never
    // send a stale range and let it silently narrow downstream.
    if (isCrossLibraryAnswerRequest(request)) {
      const checked = validateCrossLibraryAnswerRequest(session.data, request);
      if (!checked.ok) throw checked.error;
    }
    if (session.user) {
      const contextKey = questionContextKey(session.data, request);
      // Reader saves the question before calling ask(). That conversation write
      // may still be pending; only unsynced evidence must block disclosure.
      if (
        session.blocked ||
        !session.knownRevision ||
        !session.confirmedCloud ||
        questionContextKey(session.confirmedCloud, request) !== contextKey
      )
        throw new Error("资料尚未同步，请保存成功后再检索云端资料。");
      const userId = session.user.id;
      const pending: PendingQuestion = {
        session,
        request: structuredClone(request),
        contextKey,
        controller: new AbortController(),
      };
      const stop = () => pending.controller.abort(new DOMException("已停止", "AbortError"));
      signal.addEventListener("abort", stop, { once: true });
      let rejectAbort!: (reason: unknown) => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      const rejectStopped = () => rejectAbort(pending.controller.signal.reason);
      pending.controller.signal.addEventListener("abort", rejectStopped, { once: true });
      this.pendingQuestions.add(pending);
      this.publish(session);
      let settled = false;
      const report: OnAnswerProgress = (value) => {
        if (settled) return;
        try {
          const error = this.questionError(pending);
          if (error) throw error;
          const event = answerStreamEventSchema.safeParse(value);
          if (!event.success || (event.data.type !== "progress" && event.data.type !== "draft"))
            throw new Error("问答进度格式无效，本次回答已停止。");
          if (event.data.type === "draft") this.validateQuestionAnswer(pending, event.data.answer);
          // Progress is temporary UI state, never a workspace write. Extractive
          // responses and disabled AI do not imitate model generation.
          if (
            session.data.aiEnabled &&
            (event.data.type !== "draft" || event.data.answer.mode === "model")
          )
            onProgress?.(structuredClone(event.data));
          const changed = this.questionError(pending);
          if (changed) throw changed;
        } catch (cause) {
          // A late asynchronous adapter callback must not throw outside ask().
          // Aborting also settles the request when an adapter ignores its signal.
          pending.controller.abort(
            cause instanceof Error ? cause : new Error("问答进度处理失败。"),
          );
        }
      };
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => {
            const error = this.questionError(pending);
            if (error) throw error;
            return this.io.askCloud(pending.request, pending.controller.signal, userId, report);
          }),
          aborted,
        ]);
        const error = this.questionError(pending);
        if (error) throw error;
        return this.validateQuestionAnswer(pending, result);
      } catch (cause) {
        // A fetch rejection must not hide the more useful account/permission
        // change reason. An adapter ignoring abort must never publish late output.
        throw this.questionError(pending) ?? cause;
      } finally {
        settled = true;
        signal.removeEventListener("abort", stop);
        pending.controller.signal.removeEventListener("abort", rejectStopped);
        this.pendingQuestions.delete(pending);
        this.publish(session);
      }
    }
    const result = retrieveEvidence(session.data, request);
    if (signal.aborted) throw new DOMException("已停止", "AbortError");
    return result;
  }

  private validateQuestionAnswer(pending: PendingQuestion, value: unknown) {
    const answer = streamedAnswerSchema.safeParse(value);
    const data = pending.session.data;
    const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
    const available = new Map(
      selectedSources(data, pending.request).map((source) => [source.id, source]),
    );
    const noteKey = (item: AnswerNoteEvidence) =>
      JSON.stringify([
        item.noteId,
        item.spaceId,
        item.sourceId,
        item.sourceVersionId,
        item.revision,
        item.updatedAt,
        item.blockId,
        item.title,
        item.quote,
      ]);
    const availableNotes = new Set(
      selectedDocumentNoteEvidence(data, pending.request).map(noteKey),
    );
    if (
      !answer.success ||
      answer.data.citations.some((citation) => {
        const source = available.get(citation.sourceId);
        const resolved = resolveCitation(data, citation);
        return (
          !data.aiEnabled ||
          !source ||
          (source.status !== "ready" && source.status !== "partial") ||
          !resolved ||
          resolved.source !== source ||
          !normalize(source.text).includes(normalize(resolved.chunk.text)) ||
          citation.title !== source.title ||
          citation.page !== resolved.chunk.page ||
          citation.section !== resolved.chunk.section
        );
      }) ||
      answer.data.noteEvidence?.some(
        (evidence) =>
          !data.aiEnabled ||
          evidence.sourceId !== pending.request.sourceId ||
          !availableNotes.has(noteKey(evidence)) ||
          !resolveAnswerNoteEvidence(data, evidence),
      )
    )
      throw new Error("回答依据不属于当前范围的确切资料或笔记版本，本次回答已停止。");
    return answer.data;
  }

  private questionError(pending: PendingQuestion): Error | null {
    if (pending.controller.signal.aborted) return pending.controller.signal.reason as Error;
    if (!this.isActive(pending.session))
      return new Error("当前账号已改变，本次回答已停止。请在当前账号重新提问。");
    if (!pending.session.ready)
      return new Error("资料正在更新，本次回答已停止。请在更新完成后重新提问。");
    if (this.isCloudReadOnly(pending.session)) return new Error(this.readOnlyMessage());
    if (this.hasNewerLocalUpdate(pending.session) || pending.session.loadingLocalUpdate)
      return new Error("另一个标签页已保存更新，本次回答已停止。请载入最新数据后重新提问。");
    if (questionContextKey(pending.session.data, pending.request) !== pending.contextKey)
      return new Error("本次问答的资料、版本或 AI 权限已改变，回答已停止。请确认当前范围后重试。");
    return null;
  }

  setOrganizationStatus(status: OrganizationStatus, token: number) {
    const session = this.active;
    if (
      !session ||
      session.token !== token ||
      JSON.stringify(session.organizationStatus) === JSON.stringify(status)
    )
      return;
    session.organizationStatus = status;
    this.publish(session);
  }

  async organizationModelStatus(signal: AbortSignal, token: number) {
    const session = this.active;
    if (!session?.ready || !session.user || session.token !== token)
      throw new Error("请先登录账号。");
    if (this.isCloudReadOnly(session)) throw new Error(this.readOnlyMessage());
    const result = await this.io.getModelStatus(session.user.id, signal);
    if (!this.isActive(session) || signal.aborted)
      throw new DOMException("模型状态检查已停止", "AbortError");
    return result;
  }

  organizationBusy(token: number) {
    return [...this.pendingOrganizations].some((pending) => pending.session.token === token);
  }
  aiBusy(token: number) {
    return (
      this.organizationBusy(token) ||
      [...this.pendingQuestions].some((pending) => pending.session.token === token)
    );
  }
  canOrganize(request: OrganizationRequest, token: number) {
    const session = this.active;
    return (
      !!session?.ready &&
      session.token === token &&
      !!session.user &&
      !this.isCloudReadOnly(session) &&
      !session.blocked &&
      session.knownRevision &&
      !!session.confirmedCloud &&
      !organizationUnavailableReason(session.data, request) &&
      organizationContextKey(session.confirmedCloud, request) ===
        organizationContextKey(session.data, request)
    );
  }

  /**
   * Durable-task routes return only an audit projection, never model output.
   * Apply it only when this exact local snapshot was the server's CAS base;
   * otherwise a generic snapshot save could erase the newly inserted job.
   */
  private async applyDurableOrganizationJob(
    session: Session,
    expectedData: WorkspaceData,
    expectedRevision: number,
    job: OrganizationJob,
    revision: number,
  ): Promise<void> {
    if (
      !this.isActive(session) ||
      !session.user ||
      session.data !== expectedData ||
      session.revision !== expectedRevision
    )
      throw new Error("后台整理任务已提交到云端，但当前资料已改变。请刷新资料库查看结果。");
    const jobs = session.data.organizationJobs ?? [];
    const data: WorkspaceData = {
      ...session.data,
      organizationJobs: jobs.some((item) => item.id === job.id)
        ? jobs.map((item) => (item.id === job.id ? job : item))
        : [...jobs, job],
    };
    session.data = data;
    session.confirmedCloud = structuredClone(data);
    session.revision = revision;
    session.knownRevision = true;
    session.cloudDirty = false;
    session.localDirty = true;
    session.blocked = null;
    session.recovery = null;
    session.recoveryRevision = null;
    session.status = "cloud";
    session.error = "";
    this.remember(session);
    this.publish(session);
    try {
      await this.persist(session);
    } catch (cause) {
      if (this.isActive(session)) {
        session.status = "error";
        session.error =
          "云端任务已更新，但新的本地副本尚未保存：" +
          errorText(cause) +
          "。请重试保存或刷新资料库。";
        this.remember(session);
        this.publish(session);
      }
      throw cause;
    }
  }

  /**
   * A completed worker writes its result into the canonical cloud snapshot.
   * Read that snapshot only while the browser has made no concurrent edit, so
   * reviewing a result can never discard a local draft.
   */
  private async refreshDurableOrganizationWorkspace(
    session: Session,
    expectedData: WorkspaceData,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.trackCloudOperation(session, () =>
      this.runRefreshDurableOrganizationWorkspace(session, expectedData, expectedRevision, signal),
    );
  }

  private async trackCloudOperation<T>(session: Session, operation: () => Promise<T>): Promise<T> {
    this.pendingCloudOperations.set(session, (this.pendingCloudOperations.get(session) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const count = (this.pendingCloudOperations.get(session) ?? 1) - 1;
      if (count > 0) this.pendingCloudOperations.set(session, count);
      else this.pendingCloudOperations.delete(session);
    }
  }

  private async runRefreshDurableOrganizationWorkspace(
    session: Session,
    expectedData: WorkspaceData,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!session.user) throw new Error("请先登录云端账号，再查看后台整理状态。");
    if (!this.io.reconcileOrganizationJobs)
      throw new Error("当前云端尚未支持后台整理，请完成数据库迁移后重试。");
    const userId = session.user.id;
    await this.io.reconcileOrganizationJobs(userId, signal);
    const remote = await this.io.loadCloud(userId);
    if (!remote.data) throw new Error("云端资料库暂不可用，无法核对后台整理状态。请稍后重试。");
    if (
      !this.isActive(session) ||
      session.user?.id !== userId ||
      session.data !== expectedData ||
      session.revision !== expectedRevision
    )
      throw new Error("当前资料已改变，请刷新后查看后台整理结果。");
    session.data = remote.data;
    session.confirmedCloud = structuredClone(remote.data);
    session.revision = remote.revision;
    session.knownRevision = true;
    session.cloudDirty = false;
    session.localDirty = true;
    session.blocked = null;
    session.recovery = null;
    session.recoveryRevision = null;
    session.status = "cloud";
    session.error = "";
    this.remember(session);
    this.publish(session);
    try {
      await this.persist(session);
    } catch (cause) {
      if (this.isActive(session)) {
        session.status = "error";
        session.error =
          "云端已更新后台整理结果，但新的本地副本尚未保存：" +
          errorText(cause) +
          "。请重试保存或刷新资料库。";
        this.remember(session);
        this.publish(session);
      }
      throw cause;
    }
  }

  private async enqueueDurableOrganization(
    request: DurableOrganizationRequest,
    signal: AbortSignal | undefined,
    token: number,
  ): Promise<void> {
    const session = this.active;
    if (!session || session.token !== token) throw new Error("当前账号已改变，请重新打开整理。");
    return this.trackCloudOperation(session, () =>
      this.runEnqueueDurableOrganization(request, signal, token),
    );
  }

  private async runEnqueueDurableOrganization(
    request: DurableOrganizationRequest,
    signal: AbortSignal | undefined,
    token: number,
  ): Promise<void> {
    const session = this.active;
    if (!session?.ready || !session.user || session.token !== token)
      throw new Error("当前账号已改变，请重新打开整理。");
    this.assertWorkspaceWritable(session);
    if (!this.io.enqueueOrganizationJob)
      throw new Error("当前云端尚未支持后台整理，请完成数据库迁移后重试。");
    const snapshot = session.data;
    const revision = session.revision;
    const result = await this.io.enqueueOrganizationJob(request, revision, session.user.id, signal);
    if (!this.isActive(session) || session.token !== token)
      throw new Error("账号已改变，后台整理任务已交由原账号云端处理。");
    if (!result.created)
      return this.refreshDurableOrganizationWorkspace(session, snapshot, revision, signal);
    await this.applyDurableOrganizationJob(
      session,
      snapshot,
      revision,
      result.job,
      result.revision,
    );
  }

  private recoverOrganizationJobs(session: Session) {
    if (!this.isActive(session) || !session.ready || this.writesBlocked(session)) return;
    if (!session.data.organizationJobs?.some(isInterruptedBrowserOrganization)) return;
    session.data = {
      ...session.data,
      organizationJobs: session.data.organizationJobs.map((job) =>
        isInterruptedBrowserOrganization(job)
          ? {
              ...job,
              status: "cancelled",
              updatedAt: new Date().toISOString(),
              error: "页面已关闭或执行中断。可继续原请求检查结果，或手动重新生成。",
            }
          : job,
      ),
    };
    session.localDirty = true;
    if (session.user) session.cloudDirty = true;
  }

  private organizationError(pending: PendingOrganization): Error | null {
    if (pending.controller.signal.aborted) return pending.controller.signal.reason as Error;
    if (!this.isActive(pending.session))
      return new Error("账号已改变，整理已停止。本次结果不会写入当前账号。");
    if (!pending.session.ready)
      return new Error("资料正在更新，本次整理已停止。请基于当前资料重新生成。");
    if (this.isCloudReadOnly(pending.session)) return new Error(this.readOnlyMessage());
    if (this.hasNewerLocalUpdate(pending.session) || pending.session.loadingLocalUpdate)
      return new Error("另一个标签页已保存更新，本次整理已停止。请载入最新数据后重试。");
    const reason = organizationUnavailableReason(pending.session.data, pending.request);
    if (
      reason ||
      organizationContextKey(pending.session.data, pending.request) !== pending.contextKey
    )
      return new Error(reason || "资料、版本或 AI 权限已改变，整理已停止。请基于当前资料重试。");
    return null;
  }

  private changeOrganizationJob(session: Session, id: string, patch: Partial<OrganizationJob>) {
    this.update(
      (data) => ({
        ...data,
        organizationJobs: data.organizationJobs?.map((job) =>
          job.id === id ? { ...job, ...patch, updatedAt: new Date().toISOString() } : job,
        ),
      }),
      session.token,
    );
  }

  async organize(
    input: OrganizationInput,
    signal: AbortSignal | undefined,
    token: number,
  ): Promise<void> {
    const session = this.active;
    if (!session?.ready || session.token !== token)
      throw new Error("当前账号已改变，请重新打开整理。");
    this.assertWorkspaceWritable(session);
    const sourceIds = [...new Set(input.sourceIds)];
    const sourceVersions = sourceIds.map((sourceId) => {
      const source = session.data.sources.find((item) => item.id === sourceId);
      if (!source) throw new Error("部分所选资料已不可用，请重新选择。");
      return { sourceId, versionId: source.versionId };
    });
    const target =
      input.kind === "update" || input.kind === "relations"
        ? session.data.notes.find((note) => note.id === input.targetNoteId)
        : undefined;
    const compare =
      input.kind === "relations"
        ? session.data.notes.find((note) => note.id === input.compareNoteId)
        : undefined;
    if ((input.kind === "update" || input.kind === "relations") && !target)
      throw new Error("目标知识页已不可用，请重新选择。");
    if (input.kind === "relations" && !compare)
      throw new Error("用于比较的知识页已不可用，请重新选择。");
    await this.runOrganization(
      {
        kind: input.kind,
        spaceId: input.spaceId,
        ...(input.topic !== undefined ? { topic: input.topic } : {}),
        sourceIds,
        sourceVersions,
        requestId: crypto.randomUUID(),
        trigger: "manual",
        ...(target
          ? {
              targetNote: {
                id: target.id,
                revision: target.contentRevision ?? 0,
                updatedAt: target.updatedAt,
              },
            }
          : {}),
        ...(compare
          ? {
              compareNote: {
                id: compare.id,
                revision: compare.contentRevision ?? 0,
                updatedAt: compare.updatedAt,
              },
            }
          : {}),
      },
      signal,
      token,
    );
  }

  async runAutomaticOrganization(
    request: OrganizationRequest,
    signal: AbortSignal,
    token: number,
  ): Promise<void> {
    const session = this.active;
    if (session && this.isCloudReadOnly(session)) throw new Error(this.readOnlyMessage());
    if (
      session?.token === token &&
      session.data.organizationJobs?.some((job) => job.id === request.requestId)
    )
      return;
    await this.runOrganization(request, signal, token);
  }

  async checkOrganization(jobId: string, token: number): Promise<void> {
    const session = this.active;
    const job = session?.data.organizationJobs?.find((item) => item.id === jobId);
    if (!session || session.token !== token || !job)
      throw new Error("整理记录不可用，请重新打开。");
    this.assertWorkspaceWritable(session);
    if (job.restoredFromBackup)
      throw new Error("备份中的任务属于原工作区，无法检查原请求；可按当前资料重新生成。");
    if (job.status === "ready" || job.status === "dismissed")
      throw new Error("这项整理已有结果，请查看建议或手动重新生成。");
    if (job.durable) {
      if (!keepsRunningAfterBrowserExit(job))
        throw new Error("这项后台整理已结束，请查看记录或重新生成。");
      const snapshot = session.data;
      const revision = session.revision;
      await this.refreshDurableOrganizationWorkspace(session, snapshot, revision);
      return;
    }
    await this.runOrganization(job.request, undefined, token, true);
  }

  async retryOrganization(jobId: string, token: number): Promise<void> {
    const session = this.active;
    const job = session?.data.organizationJobs?.find((item) => item.id === jobId);
    if (!session || session.token !== token || !job)
      throw new Error("整理记录不可用，请重新打开。");
    this.assertWorkspaceWritable(session);
    const { kind, spaceId, sourceIds, topic, targetNote, compareNote } = job.request;
    await this.organize(
      {
        kind,
        spaceId,
        sourceIds,
        topic,
        targetNoteId: targetNote?.id,
        compareNoteId: compareNote?.id,
      },
      undefined,
      token,
    );
  }

  async stopOrganization(jobId: string, token: number): Promise<void> {
    const session = this.active;
    if (!session || session.token !== token) return;
    return this.trackCloudOperation(session, () => this.runStopOrganization(jobId, token));
  }

  private async runStopOrganization(jobId: string, token: number): Promise<void> {
    const session = this.active;
    if (!session || session.token !== token) return;
    this.assertWorkspaceWritable(session);
    const job = session.data.organizationJobs?.find((item) => item.id === jobId);
    if (job && keepsRunningAfterBrowserExit(job)) {
      if (!session.ready || !session.user)
        throw new Error("请先登录并载入云端资料，再停止后台整理任务。");
      if (!this.io.cancelOrganizationJob)
        throw new Error("当前云端尚未支持后台整理，请完成数据库迁移后重试。");
      const snapshot = session.data;
      const revision = session.revision;
      const result = await this.io.cancelOrganizationJob(job.id, revision, session.user.id);
      if (!this.isActive(session) || session.token !== token)
        throw new Error("账号已改变，请刷新后查看后台整理状态。");
      if (!result.cancelled) {
        await this.refreshDurableOrganizationWorkspace(session, snapshot, revision);
        return;
      }
      await this.applyDurableOrganizationJob(
        session,
        snapshot,
        revision,
        result.job,
        result.revision,
      );
      return;
    }
    const pending = [...this.pendingOrganizations].find(
      (item) => item.session === session && item.request.requestId === jobId,
    );
    if (pending)
      pending.controller.abort(
        new DOMException("整理已停止，可稍后继续原请求或重新生成。", "AbortError"),
      );
    else if (job && ["queued", "running"].includes(job.status))
      this.changeOrganizationJob(session, jobId, {
        status: "cancelled",
        error: "整理已停止，可稍后继续原请求或重新生成。",
      });
  }

  stopOrganizations() {
    for (const pending of this.pendingOrganizations) {
      const job = pending.session.data.organizationJobs?.find(
        (item) => item.id === pending.request.requestId,
      );
      if (job && keepsRunningAfterBrowserExit(job)) continue;
      pending.controller.abort(
        new DOMException("页面已关闭，整理已停止。可重新打开后继续原请求。", "AbortError"),
      );
    }
  }

  private async runOrganization(
    request: OrganizationRequest,
    signal: AbortSignal | undefined,
    token: number,
    existing = false,
  ): Promise<void> {
    const session = this.active;
    if (!session?.ready || session.token !== token || !session.user)
      throw new Error("请先登录云端账号，再整理资料。");
    this.assertWorkspaceWritable(session);
    if (signal?.aborted) throw new DOMException("整理已停止", "AbortError");
    const localDevelopmentPageRun =
      isDurableOrganizationRequest(request) &&
      this.capabilities.durableOrganizationProcessorEnabled === false &&
      this.capabilities.localDevelopmentOrganizationRunnerEnabled === true &&
      isLocalDevelopmentOrganizationRunnerEnabled(
        localDevelopmentOrganizationRunnerStateFromEnvironment(),
      );
    if (
      isDurableOrganizationRequest(request) &&
      this.capabilities.durableOrganizationProcessorEnabled === false &&
      !localDevelopmentPageRun
    )
      throw new Error(organizationProcessorAvailabilityMessage("not-deployed"));
    if (localDevelopmentPageRun && request.trigger !== "manual")
      throw new Error(
        "本地开发页面运行只支持用户手动发起；自动分析仍等待后台处理器部署，不会创建任务。",
      );
    const reason = organizationUnavailableReason(session.data, request);
    if (reason) throw new Error(reason);
    if (!this.canOrganize(request, token))
      throw new Error(
        request.kind === "relations"
          ? "资料、两份知识页或 AI 设置尚未同步，请保存成功后再整理。"
          : request.kind === "update"
            ? "资料、目标知识页或 AI 设置尚未同步，请保存成功后再整理。"
            : "资料或 AI 设置尚未同步，请保存成功后再整理。",
      );
    if (this.aiBusy(token)) throw new Error("已有 AI 问答或整理正在执行，请等待完成或先停止。");
    if (!existing && (session.data.organizationJobs?.length ?? 0) >= 1000)
      throw new Error("整理记录已达当前上限，暂不能新增任务。已保存建议仍可查看和导出。");
    if (
      isDurableOrganizationRequest(request) &&
      !localDevelopmentPageRun &&
      this.io.enqueueOrganizationJob
    ) {
      await this.enqueueDurableOrganization(request, signal, token);
      return;
    }
    const pending: PendingOrganization = {
      session,
      request: structuredClone(request),
      contextKey: organizationContextKey(session.data, request),
      controller: new AbortController(),
    };
    const stop = () => pending.controller.abort(new DOMException("整理已停止", "AbortError"));
    signal?.addEventListener("abort", stop, { once: true });
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const rejectStopped = () => rejectAbort(pending.controller.signal.reason);
    pending.controller.signal.addEventListener("abort", rejectStopped, { once: true });
    this.pendingOrganizations.add(pending);
    const current = () => {
      const error = this.organizationError(pending);
      if (error) throw error;
    };
    const persistJob = async () => {
      try {
        await this.persist(session);
      } catch (cause) {
        if (this.isActive(session)) {
          session.status = "error";
          session.error =
            "整理记录尚未保存到此浏览器：" + errorText(cause) + "。请重试保存或导出后再离开。";
          this.publish(session);
        }
        throw cause;
      }
    };
    const work = async () => {
      current();
      const now = new Date().toISOString();
      if (existing)
        this.changeOrganizationJob(session, request.requestId, {
          status: "queued",
          error: undefined,
          result: undefined,
        });
      else
        this.update(
          (data) => ({
            ...data,
            organizationJobs: [
              ...(data.organizationJobs ?? []),
              {
                id: request.requestId,
                request: pending.request,
                status: "queued",
                createdAt: now,
                updatedAt: now,
              },
            ],
          }),
          token,
        );
      // Record the attempt before any possible paid request. A refresh must never
      // invent a fresh automatic ID because a previous attempt was only in memory.
      await persistJob();
      current();
      const model = await this.io.getModelStatus(session.user!.id, pending.controller.signal);
      current();
      if (model.mode !== "model")
        throw new Error(model.message || "尚未配置生成模型，无法整理资料。");
      this.changeOrganizationJob(session, request.requestId, { status: "running" });
      await persistJob();
      current();
      const result = organizationResultSchema.parse(
        await this.io.organizeCloud(pending.request, pending.controller.signal, session.user!.id),
      );
      current();
      const allowed = new Set(request.sourceIds);
      const citations = organizationCitations(result);
      if (result.kind === "update") {
        const target = session.data.notes.find((note) => note.id === request.targetNote?.id);
        if (
          request.kind !== "update" ||
          !target ||
          !request.targetNote ||
          result.target.id !== request.targetNote.id ||
          result.target.revision !== request.targetNote.revision ||
          result.target.updatedAt !== request.targetNote.updatedAt ||
          knowledgeNoteKey(result.target) !== knowledgeNoteKey(target) ||
          !validateKnowledgeChanges(result.target, result.changes)
        )
          throw new Error("更新建议与目标知识页的当前版本不一致，本次建议未保存。");
      }
      if (result.kind === "relations") {
        const target = session.data.notes.find((note) => note.id === request.targetNote?.id);
        const compare = session.data.notes.find((note) => note.id === request.compareNote?.id);
        if (
          request.kind !== "relations" ||
          !target ||
          !compare ||
          !request.targetNote ||
          !request.compareNote ||
          result.target.id !== request.targetNote.id ||
          result.target.revision !== request.targetNote.revision ||
          result.target.updatedAt !== request.targetNote.updatedAt ||
          result.compare.id !== request.compareNote.id ||
          result.compare.revision !== request.compareNote.revision ||
          result.compare.updatedAt !== request.compareNote.updatedAt ||
          knowledgeNoteKey(result.target) !== knowledgeNoteKey(target) ||
          knowledgeNoteKey(result.compare) !== knowledgeNoteKey(compare) ||
          !validateRelationProposals(result.target, result.compare, result.relations)
        )
          throw new Error("关系建议与两份知识页的当前版本不一致，本次建议未保存。");
      }
      if (
        result.kind !== request.kind ||
        citations.some((citation) => {
          const canonical = resolveCitation(session.data, citation);
          return (
            !allowed.has(citation.sourceId) ||
            !canonical ||
            canonical.source.title !== citation.title ||
            canonical.chunk.page !== citation.page ||
            canonical.chunk.section !== citation.section
          );
        }) ||
        (request.kind !== "update" &&
          request.kind !== "relations" &&
          request.sourceIds.some((id) => !citations.some((citation) => citation.sourceId === id)))
      )
        throw new Error("整理结果的引用与当前资料不一致，本次建议未保存。");
      this.changeOrganizationJob(session, request.requestId, {
        status: "ready",
        result,
        error: undefined,
      });
      await persistJob();
      current();
    };
    try {
      await Promise.race([aborted, Promise.resolve().then(work)]);
    } catch (cause) {
      const error = this.organizationError(pending) ?? cause;
      if (this.isActive(session)) {
        this.changeOrganizationJob(session, request.requestId, {
          status: pending.controller.signal.aborted ? "cancelled" : "failed",
          result: undefined,
          error: error instanceof Error ? error.message : "整理失败，请稍后手动重试。",
        });
        try {
          await persistJob();
        } catch {
          /* persistJob published the local failure without hiding the request error. */
        }
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", stop);
      pending.controller.signal.removeEventListener("abort", rejectStopped);
      this.pendingOrganizations.delete(pending);
      this.publish(session);
    }
  }
}

export function useWorkspace(options: { storageMode?: "hybrid" | "cloud" } = {}) {
  const storageMode = options.storageMode ?? "hybrid";
  const organizationProcessorState = organizationProcessorStateFromEnvironment();
  const durableOrganizationProcessorEnabled = isOrganizationProcessorEnabled(
    organizationProcessorState,
  );
  const localDevelopmentOrganizationRunnerEnabled =
    !durableOrganizationProcessorEnabled &&
    isLocalDevelopmentOrganizationRunnerEnabled(
      localDevelopmentOrganizationRunnerStateFromEnvironment(),
    );
  const [coordinator] = useState(
    () =>
      new WorkspaceCoordinator(
        storageMode === "cloud" ? createWebCloudWorkspaceIO() : defaultIO,
        defaultImportPipeline,
        {
          storageMode,
          durableOrganizationProcessorEnabled,
          localDevelopmentOrganizationRunnerEnabled,
        },
      ),
  );
  const [organizationRunner] = useState(
    () => new OrganizationRunner(coordinator, durableOrganizationProcessorEnabled),
  );
  const acceptedSessionKey = useRef<string | undefined>(undefined);
  const view = useSyncExternalStore(
    coordinator.subscribe,
    coordinator.getSnapshot,
    coordinator.getSnapshot,
  );
  const cloudAccountId = view.user?.id;
  const activate = useCallback(
    (user: User | null) => {
      const key = accountKey(user);
      if (key === acceptedSessionKey.current) return Promise.resolve();
      acceptedSessionKey.current = key;
      return coordinator.activate(user);
    },
    [coordinator],
  );
  useEffect(() => {
    const accept = (user: User | null) => {
      void activate(user);
    };
    let unsubscribe = () => {};
    if (!isCloudConfigured()) {
      accept(null);
    } else {
      unsubscribe = subscribeSession(accept);
    }
    return () => {
      unsubscribe();
      acceptedSessionKey.current = undefined;
      coordinator.dispose();
    };
  }, [activate, coordinator]);
  useEffect(() => {
    organizationRunner.start();
    const stop = () => {
      organizationRunner.stop();
      coordinator.stopOrganizations();
    };
    const resume = () => organizationRunner.start();
    window.addEventListener("pagehide", stop);
    window.addEventListener("pageshow", resume);
    return () => {
      window.removeEventListener("pagehide", stop);
      window.removeEventListener("pageshow", resume);
      stop();
    };
  }, [coordinator, organizationRunner]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (coordinator.hasUnsavedLocalChanges()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [coordinator]);
  useEffect(() => {
    if (!cloudAccountId || !view.ready) return;
    const token = view.token;
    return startForegroundCloudUpdateChecks((signal) =>
      coordinator.checkCloudUpdates(token, signal),
    );
  }, [coordinator, cloudAccountId, view.ready, view.token]);
  const update = useCallback(
    (updater: (data: WorkspaceData) => WorkspaceData) => coordinator.update(updater, view.token),
    [coordinator, view.token],
  );
  const updateDurably = useCallback(
    (updater: (data: WorkspaceData) => WorkspaceData) =>
      coordinator.updateDurably(updater, view.token),
    [coordinator, view.token],
  );
  const getCurrentWorkspaceData = useCallback(
    () => coordinator.readCurrentData(view.token, view.user?.id ?? null, view.localCacheMode),
    [coordinator, view.token, view.user?.id, view.localCacheMode],
  );
  const retry = useCallback(() => coordinator.retry(view.token), [coordinator, view.token]);
  const useRemote = useCallback(
    (preserveCurrent?: (snapshot: WorkspaceData) => Promise<boolean>) =>
      coordinator.useRemote(view.token, preserveCurrent),
    [coordinator, view.token],
  );
  const loadLatestLocal = useCallback(
    (preserveLocalChanges?: (snapshot: WorkspaceData) => Promise<boolean>) =>
      coordinator.loadLatestLocal(view.token, preserveLocalChanges),
    [coordinator, view.token],
  );
  const checkCloudUpdates = useCallback(
    () => coordinator.checkCloudUpdates(view.token),
    [coordinator, view.token],
  );
  const loadCloudUpdate = useCallback(
    () => coordinator.loadCloudUpdate(view.token),
    [coordinator, view.token],
  );
  const setPendingReadingPosition = useCallback(
    (readerKey: string, pending: boolean) =>
      coordinator.setPendingReadingPosition(view.token, readerKey, pending),
    [coordinator, view.token],
  );
  const migrateAnonymousWorkspace = useCallback(
    () => coordinator.migrateAnonymousWorkspace(view.token),
    [coordinator, view.token],
  );
  const skipAnonymousWorkspaceMigration = useCallback(
    () => coordinator.skipAnonymousWorkspaceMigration(view.token),
    [coordinator, view.token],
  );
  const resolveNoteConflicts = useCallback(
    (selections: readonly NoteSyncConflictSelection[]) =>
      coordinator.resolveNoteConflicts(selections, view.token),
    [coordinator, view.token],
  );
  const resolveReadingProgressConflicts = useCallback(
    (selections: readonly ReadingProgressSyncSelection[]) =>
      coordinator.resolveReadingProgressConflicts(selections, view.token),
    [coordinator, view.token],
  );
  const previewSourcePurge = useCallback(
    (sourceId: string, selection?: PermanentSourceDeletionSelection, signal?: AbortSignal) =>
      coordinator.previewSourcePurge(sourceId, view.token, selection, signal),
    [coordinator, view.token],
  );
  const purgeSource = useCallback(
    (sourceId: string, preview: SourcePurgePreview) =>
      coordinator.purgeSource(sourceId, preview, view.token),
    [coordinator, view.token],
  );
  const previewSourceVersionPurge = useCallback(
    (sourceId: string, versionId: string) =>
      coordinator.previewSourceVersionPurge(sourceId, versionId, view.token),
    [coordinator, view.token],
  );
  const purgeSourceVersion = useCallback(
    (sourceId: string, versionId: string, preview: SourceVersionPurgePreview) =>
      coordinator.purgeSourceVersion(sourceId, versionId, preview, view.token),
    [coordinator, view.token],
  );
  const sourceBlob = useCallback(
    (source: Source, options?: SourceBlobReadOptions) =>
      coordinator.sourceBlob(source, view.token, options),
    [coordinator, view.token],
  );
  const replaceFile = useCallback(
    (sourceId: string, expectedVersionId: string, candidate: Source, blob: Blob) =>
      coordinator.replaceFile(sourceId, expectedVersionId, candidate, blob, view.token),
    [coordinator, view.token],
  );
  const importFile = useCallback(
    (file: File, spaceId: string, keepDuplicate = false, aiAllowed = false) =>
      coordinator.importFile(file, spaceId, view.token, keepDuplicate, aiAllowed),
    [coordinator, view.token],
  );
  const retryImport = useCallback(
    (jobId: string) => coordinator.retryImport(jobId, view.token),
    [coordinator, view.token],
  );
  const cancelImport = useCallback(
    (jobId: string) => coordinator.cancelImport(jobId, view.token),
    [coordinator, view.token],
  );
  const restoreBackup = useCallback(
    (plan: RestorePlan) => coordinator.restoreBackup(plan, view.token),
    [coordinator, view.token],
  );
  const ask = useCallback(
    (request: AnswerRequest, signal: AbortSignal, onProgress?: OnAnswerProgress) =>
      coordinator.ask(request, signal, view.token, onProgress),
    [coordinator, view.token],
  );
  const organize = useCallback(
    (input: OrganizationInput, signal?: AbortSignal) =>
      coordinator.organize(input, signal, view.token),
    [coordinator, view.token],
  );
  const stopOrganization = useCallback(
    (id: string) => coordinator.stopOrganization(id, view.token),
    [coordinator, view.token],
  );
  const checkOrganization = useCallback(
    (id: string) => coordinator.checkOrganization(id, view.token),
    [coordinator, view.token],
  );
  const retryOrganization = useCallback(
    (id: string) => coordinator.retryOrganization(id, view.token),
    [coordinator, view.token],
  );
  const refreshOrganizationStatus = useCallback(
    () => organizationRunner.refresh(),
    [organizationRunner],
  );
  const discardAccount = useCallback(
    (accountId: string) => coordinator.discardAccount(accountId),
    [coordinator],
  );
  const retryAccountLocalDeletion = useCallback(
    () => coordinator.retryAccountLocalDeletion(),
    [coordinator],
  );
  const signOut = useCallback(
    async (strategy: "direct" | "sync" | "local", completeLocalSignOut: () => Promise<void>) => {
      await coordinator.signOut(view.token, strategy, completeLocalSignOut);
      // Auth normally emits SIGNED_OUT, but moving the coordinator explicitly
      // also clears the frozen account view if that event is delivered late.
      await activate(null);
    },
    [activate, coordinator, view.token],
  );
  return {
    ...view,
    update,
    updateDurably,
    getCurrentWorkspaceData,
    retry,
    useRemote,
    loadLatestLocal,
    checkCloudUpdates,
    loadCloudUpdate,
    setPendingReadingPosition,
    migrateAnonymousWorkspace,
    skipAnonymousWorkspaceMigration,
    resolveNoteConflicts,
    resolveReadingProgressConflicts,
    previewSourcePurge,
    purgeSource,
    previewSourceVersionPurge,
    purgeSourceVersion,
    sourceBlob,
    replaceFile,
    importFile,
    retryImport,
    cancelImport,
    restoreBackup,
    ask,
    organize,
    stopOrganization,
    checkOrganization,
    retryOrganization,
    refreshOrganizationStatus,
    discardAccount,
    retryAccountLocalDeletion,
    signOut,
  };
}
