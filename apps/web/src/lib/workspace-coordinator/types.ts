import type { AnswerRequest, SaveState, Source, WorkspaceData } from "../types";
import type {
  askCloud,
  cancelImportParse,
  cancelOrganizationJob,
  claimImportParse,
  downloadSourceBlob,
  enqueueOrganizationJob,
  finishImportParse,
  getModelStatus,
  getAccountMembership,
  heartbeatImportParse,
  loadCloudWorkspace,
  loadCloudWorkspaceRevision,
  organizeCloud,
  previewSourcePurge,
  previewSourceVersionPurge,
  reconcileOrganizationJobs,
  releaseImportParse,
  requestSourcePurge,
  requestSourceVersionPurge,
  retryImportParse,
  saveCloudWorkspace,
  uploadSourceBlob,
} from "../cloud";
import type {
  clearAccountLocalCache,
  commitLocalImport,
  deleteUnreferencedBlob,
  getBlob,
  isAccountLocallyDeleted,
  markAccountLocalDeletion,
  putBlobIfAbsent,
  shareAnonymousOriginals,
  StoredLocalWorkspace,
  subscribeLocalAccountDeletions,
  subscribeLocalWorkspaceCommits,
} from "../local-store";
import type { subscribeConfirmedAccountDeletions } from "../account-deletion-observer";
import type { parseImportSource, prepareImportFile } from "../import";
import type { ImportJob } from "../import-queue";
import type { OrganizationRequest } from "../organization-types";
import type { OrganizationStatus } from "../organization-runner";
import type {
  NoteConflictResolutionChoice,
  NoteSyncPlan,
  ReadingProgressConflictChoice,
  ReadingProgressSyncPlan,
} from "../sync-conflicts";

export type User = { id: string; email: string };
export type SyncMeta = {
  revision: number;
  dirty: boolean;
  /** Exact cloud snapshot acknowledged at `baseRevision`; persisted only while dirty. */
  base?: WorkspaceData;
  baseRevision?: number;
};
export type StoredWorkspace = WorkspaceData & {
  _conuoSync?: SyncMeta;
  _conuoLocalRevision?: number;
};
export type RemoteWorkspace = { data: WorkspaceData | null; revision: number };
/**
 * The account panel uses this to decide whether signing out can safely happen
 * now, or whether the current account needs an explicit protection choice.
 */
export type WorkspaceSignOutState = {
  kind: "ready" | "syncing" | "unsynced" | "conflict" | "local-error";
  message?: string;
  canSync: boolean;
  canKeepLocalDraft: boolean;
};

/**
 * A logged-in account never silently absorbs the browser's anonymous library.
 * The UI can use this state to present one explicit migration decision before
 * normal account writes are allowed to bootstrap an otherwise empty workspace.
 */
export type AnonymousWorkspaceMigrationState = {
  kind:
    "none" | "pending" | "migrating" | "migrated" | "dismissed" | "requires-export" | "unavailable";
  canMigrate: boolean;
  message?: string;
  sourceCount?: number;
  noteCount?: number;
  /** True only after a local migration has been confirmed but cloud sync is still pending. */
  pendingCloudConfirmation?: boolean;
};

/**
 * `cloud-readonly` is a recovery state, not an alternate persistence mode.
 * We show only an already-confirmed remote snapshot while IndexedDB cannot be
 * read, and never use that condition as permission to write a replacement.
 */
export type LocalCacheMode = "normal" | "cloud-readonly";

export type View = {
  accountDeletionState?: "clearing" | "blocked" | "cleanup-failed" | null;
  accountAccessVerificationFailed?: boolean;
  data: WorkspaceData;
  user: User | null;
  status: SaveState;
  error: string;
  ready: boolean;
  recovery: WorkspaceData | null;
  /** Revision of the remote snapshot held for an explicit conflict decision. */
  recoveryRevision: number | null;
  /** Present only when the conflict is limited to safely reviewable live notes. */
  noteSyncPlan: NoteSyncPlan | null;
  /** Present only when both browsers changed otherwise-identical reading positions. */
  readingProgressSyncPlan: ReadingProgressSyncPlan | null;
  token: number;
  organizationStatus: OrganizationStatus;
  /** Server-side purge locks the workspace until its atomic result is persisted locally. */
  purging: boolean;
  /** Whether this browser can safely write its account-scoped local cache. */
  localCacheMode: LocalCacheMode;
  /** Newest committed IndexedDB revision announced by another browser tab. */
  localUpdateRevision: number | null;
  /** Locks edits while the explicit cross-tab reload coordinates pending writes. */
  loadingLocalUpdate: boolean;
  cloudUpdateRevision: number | null;
  checkingCloudUpdate: boolean;
  /** Coordinates the short local commit; ordinary editor input is still retained. */
  loadingCloudUpdate: boolean;
  cloudUpdateError: string;
  /** Increments only after a newer authoritative snapshot is durably adopted. */
  cloudAdoptionSequence: number;
  signOutState: WorkspaceSignOutState;
  anonymousMigration: AnonymousWorkspaceMigrationState;
};
export type Session = Omit<View, "noteSyncPlan" | "readingProgressSyncPlan" | "signOutState"> & {
  /** IndexedDB compare-and-swap revision for this account's local workspace record. */
  localRevision: number;
  revision: number;
  knownRevision: boolean;
  localDirty: boolean;
  cloudDirty: boolean;
  blocked: "error" | "conflict" | null;
  pumping: boolean;
  checking: boolean;
  /** Prevents late UI, import and model callbacks from changing a just-exited account. */
  exiting: boolean;
  confirmedCloud: WorkspaceData | null;
  /** Kept only while an explicit anonymous-library decision is pending. */
  anonymousWorkspace: WorkspaceData | null;
};
export type PendingLocalPersist = {
  data: WorkspaceData;
  revision: number;
  cloudDirty: boolean;
  confirmedCloud: WorkspaceData | null;
  promise: Promise<void>;
};
export type PendingQuestion = {
  session: Session;
  request: AnswerRequest;
  contextKey: string;
  controller: AbortController;
};
export type PendingOrganization = {
  session: Session;
  request: OrganizationRequest;
  contextKey: string;
  controller: AbortController;
};

export type PendingImport = {
  session: Session;
  jobId: string;
  controller: AbortController;
  lease?: ActiveImportLease;
  /**
   * A terminal or restart transition has staged this exact pair locally. It
   * keeps the normal import-state observer from aborting the transition just
   * because the job has left its running state.
   */
  transitionTarget?: { source: Source; job: ImportJob };
  /** A user cancellation owns the transition until its fenced RPC settles. */
  cancelling?: boolean;
};
export type QueuedImport = Pick<PendingImport, "session" | "jobId">;
export type ActiveImportLease = {
  sourceId: string;
  versionId: string;
  token: string;
  leaseUntil: string;
  heartbeatTimer?: ReturnType<typeof setTimeout>;
  renewing: boolean;
  /** A renewal or ownership fence failed, so the worker must discard its output. */
  lost?: Error;
  release?: Promise<void>;
};
export type ImportTransitionAction = "finish" | "cancel" | "retry";
export type RecoverableImportTransition = {
  action: ImportTransitionAction;
  jobId: string;
  sourceId: string;
  versionId: string;
};

export type NoteSyncConflictSelection = {
  conflictId: string;
  choice: NoteConflictResolutionChoice;
  /** Empty string is a valid manually merged note body. */
  content?: string;
};

export type ReadingProgressSyncSelection = {
  conflictId: string;
  choice: ReadingProgressConflictChoice;
};

export type ImportStartResult =
  { kind: "duplicate"; source: Source } | { kind: "queued"; job: ImportJob };
export type AtomicPreparedImportResult = {
  start: ImportStartResult;
  /** Exact source written or associated by the transaction, used to repair an in-flight page edit. */
  source: Source;
  job?: ImportJob;
  changed: boolean;
};
export interface ImportPipeline {
  prepare: typeof prepareImportFile;
  parse: typeof parseImportSource;
}

export interface WorkspaceIO {
  beginSession?: (accountId: string) => void;
  clearSession?: (accountId?: string) => void;
  loadLocal: (accountId?: string) => Promise<StoredLocalWorkspace | null>;
  saveLocal: (
    data: WorkspaceData,
    accountId?: string,
    expectedLocalRevision?: number,
  ) => Promise<number | void>;
  /** Atomically rechecks and publishes one prepared import against the newest local snapshot. */
  commitLocalImport?: typeof commitLocalImport;
  /** Account-scoped invalidation only; workspace contents remain in IndexedDB. */
  subscribeLocalCommits?: typeof subscribeLocalWorkspaceCommits;
  loadCloud: typeof loadCloudWorkspace;
  loadCloudRevision?: typeof loadCloudWorkspaceRevision;
  saveCloud: typeof saveCloudWorkspace;
  getBlob: typeof getBlob;
  /** Production local reads require provenance recorded with the bytes. */
  getAccountBlob?: typeof getBlob;
  putBlobIfAbsent?: typeof putBlobIfAbsent;
  putAccountBlobIfAbsent?: typeof putBlobIfAbsent;
  shareAnonymousOriginals?: typeof shareAnonymousOriginals;
  deleteUnreferencedBlob?: typeof deleteUnreferencedBlob;
  deleteAccountUnreferencedBlob?: typeof deleteUnreferencedBlob;
  /** Removes a deleted cloud account's IndexedDB snapshot and safe-to-delete originals. */
  clearAccountLocalCache?: typeof clearAccountLocalCache;
  isAccountLocallyDeleted?: typeof isAccountLocallyDeleted;
  markAccountLocalDeletion?: typeof markAccountLocalDeletion;
  subscribeLocalAccountDeletions?: typeof subscribeLocalAccountDeletions;
  subscribeConfirmedAccountDeletions?: typeof subscribeConfirmedAccountDeletions;
  uploadBlob: typeof uploadSourceBlob;
  downloadBlob: typeof downloadSourceBlob;
  previewSourcePurge?: typeof previewSourcePurge;
  requestSourcePurge?: typeof requestSourcePurge;
  previewSourceVersionPurge?: typeof previewSourceVersionPurge;
  requestSourceVersionPurge?: typeof requestSourceVersionPurge;
  /** Optional to preserve a safe local-only import path in tests and offline mode. */
  claimImportParse?: typeof claimImportParse;
  heartbeatImportParse?: typeof heartbeatImportParse;
  releaseImportParse?: typeof releaseImportParse;
  finishImportParse?: typeof finishImportParse;
  cancelImportParse?: typeof cancelImportParse;
  retryImportParse?: typeof retryImportParse;
  /** Optional while an older deployed API has not yet received the durable-task migration. */
  enqueueOrganizationJob?: typeof enqueueOrganizationJob;
  cancelOrganizationJob?: typeof cancelOrganizationJob;
  reconcileOrganizationJobs?: typeof reconcileOrganizationJobs;
  askCloud: typeof askCloud;
  organizeCloud: typeof organizeCloud;
  getModelStatus: typeof getModelStatus;
  /** Reads the account quota before a UI operation that can add active spaces. */
  getAccountMembership?: typeof getAccountMembership;
  readLegacyMeta: (id: string) => SyncMeta | null;
}
