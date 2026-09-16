import { isAccountDeletionPendingError } from "../account-deletion";
import type { OnAnswerProgress } from "../answer-stream-types";
import type { RestorePlan } from "../backup-types";
import type { SourcePurgePreview, SourceVersionPurgePreview } from "../cloud";
import {
  LocalAccountDeletedError,
  type LocalWorkspaceCommitEvent,
  type StoredLocalWorkspace,
} from "../local-store";
import type { OrganizationInput, OrganizationStatus } from "../organization-runner";
import type { OrganizationRequest } from "../organization-types";
import type { PermanentSourceDeletionSelection } from "../permanent-deletion";
import { createEmptyWorkspace } from "../seed";
import { getSourceVersion } from "../source-versions";
import { mergeReadingProgressConflict, rebaseIndependentWorkspaceChanges } from "../sync-conflicts";
import type { AnswerRequest, Source, SourceBlobReadOptions, WorkspaceData } from "../types";
import {
  conflictError,
  errorText,
  exceedsCloudWorkspaceCapacity,
  OriginalSyncError,
  workspaceSaveNeedsReadBack,
} from "./errors";
import { BackupRestoreController } from "./backup-restore";
import { CloudSyncController } from "./cloud-sync";
import { ImportsController } from "./imports";
import { accountKey, defaultImportPipeline, defaultIO, unpack } from "./io";
import {
  anonymousMigrationSummary,
  hasMeaningfulWorkspaceContent,
  mergeConcurrentWorkspace,
  noAnonymousWorkspaceMigration,
  sameData,
  withoutAnonymousCloudPaths,
} from "./merge";
import {
  keepsRunningAfterBrowserExit,
  OrganizationController,
  reconcileDurableOrganizationProjections,
} from "./organization";
import {
  mergeOriginalPath,
  originalIdentity,
  OriginalsController,
  verifyOriginal,
} from "./originals";
import { PurgeController } from "./purge";
import { QuestionsController } from "./questions";
import type {
  ImportPipeline,
  ImportStartResult,
  LocalCacheMode,
  NoteSyncConflictSelection,
  PendingLocalPersist,
  ReadingProgressSyncSelection,
  RemoteWorkspace,
  Session,
  StoredWorkspace,
  SyncMeta,
  User,
  View,
  WorkspaceIO,
  WorkspaceSignOutState,
} from "./types";

/**
 * Account-scoped save coordinator. React callbacks carry an activation token,
 * so an upload/edit callback from a previous account cannot edit a new account.
 * Sync metadata is stored atomically WITH its IndexedDB document, never in a
 * separate localStorage transaction.
 */
export class WorkspaceCoordinator {
  /** Internal to this directory: sub-controllers read the live session here. */
  active: Session | null = null;
  private token = 0;
  listeners = new Set<() => void>();
  queues = new Map<string, Promise<void>>();
  /** Defers same-page full-snapshot saves until an atomic import is adopted. */
  atomicLocalWriteBarriers = new WeakMap<Session, Promise<void>>();
  /** Coalesces callers waiting for the same exact local snapshot and sync metadata. */
  pendingLocalPersists = new Map<Session, PendingLocalPersist[]>();
  /** Lets callers await an in-flight persistence pass instead of racing it. */
  pumpTasks = new Map<Session, Promise<void>>();
  memory = new Map<string, Session>();
  // A removed session may still be unwinding an IndexedDB or model promise.
  // Never let that continuation re-register a stale in-memory snapshot.
  discardedSessions = new WeakSet<Session>();
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
  /** Question requests and their evidence-boundary fences. */
  readonly questions = new QuestionsController(this);
  /** Page-run and durable organization tasks. */
  readonly organization = new OrganizationController(this);
  /** Import queue, parse leases, transition fences and cancellations. */
  readonly imports = new ImportsController(this);
  /** Original bytes: local reads/writes, cloud download and reference checks. */
  readonly originals = new OriginalsController(this);
  /** Permanent deletion of a source or one of its historical versions. */
  readonly purge = new PurgeController(this);
  /** Adds a backup copy into the current workspace, never replacing it. */
  readonly backupRestore = new BackupRestoreController(this);
  /** Cloud revision checks, fenced adoption, remote recovery and conflict plans. */
  readonly cloudSync = new CloudSyncController(this);
  // Recovery snapshots are intentionally independent from ordinary workspace
  // persistence, but account deletion still has to await them before clearing
  // IndexedDB. Keep only live writes for the owning session.
  pendingRecoveryWrites = new Map<Session, Set<Promise<void>>>();
  private localCommitUnsubscribe: (() => void) | null = null;
  private localReloadTasks = new WeakMap<Session, Promise<boolean>>();
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
    public io: WorkspaceIO = defaultIO,
    public pipeline: ImportPipeline = defaultImportPipeline,
    public capabilities: {
      storageMode?: "hybrid" | "cloud";
      durableOrganizationProcessorEnabled?: boolean;
      /** Only `useWorkspace` supplies this from the development-only public capability. */
      localDevelopmentOrganizationRunnerEnabled?: boolean;
    } = {},
  ) {
    this.io = this.accountAwareIO(io);
  }

  get cloudOnly(): boolean {
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
  hasNewerLocalUpdate(session: Session): boolean {
    return (
      session.localUpdateRevision !== null && session.localUpdateRevision > session.localRevision
    );
  }
  setLocalRevision(session: Session, localRevision: number): void {
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
  markNewerLocalUpdate(
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
    if (this.active) this.cloudSync.abortCloudUpdate(this.active);
    if (this.cloudOnly) {
      this.active = null;
      this.memory.clear();
      this.io.clearSession?.();
    }
  }
  isActive(session: Session): boolean {
    return (
      this.active === session &&
      !session.exiting &&
      !session.accountAccessVerificationFailed &&
      !this.discardedAccounts.has(accountKey(session.user))
    );
  }
  isCurrent(session: Session): boolean {
    return this.active === session && !this.discardedAccounts.has(accountKey(session.user));
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
  publish(session: Session) {
    // A signing-out session deliberately rejects writes but still needs to
    // publish its frozen status while the Auth event replaces it.
    if (!this.isCurrent(session)) return;
    this.accountDeletionView = null;
    // Updates, cloud reconciliation, recovery and account changes all publish
    // through here. Stop old evidence requests as soon as their boundary changes.
    this.questions.abortInvalidated();
    this.organization.abortInvalidated();
    this.imports.abortInvalidated();
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
      noteSyncPlan: verificationFailed ? null : this.cloudSync.noteSyncPlan(session),
      readingProgressSyncPlan: verificationFailed
        ? null
        : this.cloudSync.readingProgressSyncPlan(session),
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
  remember(session: Session) {
    if (this.cloudOnly && this.active !== session) return;
    if (this.discardedSessions.has(session) || this.discardedAccounts.has(accountKey(session.user)))
      return;
    const id = accountKey(session.user);
    const previous = this.memory.get(id);
    if (!previous || previous.token <= session.token) this.memory.set(id, session);
  }
  syncMeta(session: Session): SyncMeta {
    const meta: SyncMeta = { revision: session.revision, dirty: session.cloudDirty };
    if (session.cloudDirty && session.confirmedCloud) {
      meta.baseRevision = session.revision;
      meta.base = structuredClone(session.confirmedCloud);
    }
    return meta;
  }
  stored(session: Session, data = session.data): StoredWorkspace {
    return session.user ? { ...data, _conuoSync: this.syncMeta(session) } : { ...data };
  }
  /**
   * A local import changes a workspace that may already contain unsynced cloud
   * work from another tab. Preserve that exact fence; when the latest local
   * record was clean, its pre-import data becomes the three-way merge base.
   */
  storedAtomicImport(
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
  mergeConcurrentImportCommit(
    current: WorkspaceData,
    committed: WorkspaceData,
    boundary: WorkspaceData,
  ): WorkspaceData | null {
    return mergeConcurrentWorkspace(current, committed, boundary);
  }
  isCloudReadOnly(session: Session): boolean {
    return session.localCacheMode === "cloud-readonly";
  }
  readOnlyMessage(): string {
    return "此浏览器的本机副本暂时无法读取，当前仅可查看已确认的云端资料。请重新连接后再编辑、导入或整理。";
  }
  assertWritable(session: Session): void {
    if (this.discardedAccounts.has(accountKey(session.user))) throw new LocalAccountDeletedError();
    if (
      session.accountAccessVerificationFailed ||
      this.unverifiedAccounts.has(accountKey(session.user))
    )
      throw new Error("本机账号状态尚未核验，已暂停访问；请重新核验后继续。");
    if (this.isCloudReadOnly(session)) throw new Error(this.readOnlyMessage());
  }
  persist(session: Session): Promise<void> {
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

  trackRecoveryWrite(session: Session, write: Promise<void>): Promise<void> {
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
          this.cloudSync.abortCloudUpdate(session);
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
    this.questions.collectSessions(collect);
    this.organization.collectSessions(collect);
    this.imports.collectSessions(collect);
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
      this.backupRestore.redactSession(session);
      this.cloudSync.abortCloudUpdate(session);
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
      this.imports.redactSession(session);
    }
    const stopped = new DOMException("账号注销请求已提交，本次操作已停止。", "AbortError");
    this.questions.redactAccount(accountId, stopped);
    this.organization.redactAccount(accountId, stopped);
    this.imports.redactAccount(accountId, stopped);
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

  migrationChoiceBlocksWrites(session: Session): boolean {
    return (
      session.anonymousMigration.kind === "pending" ||
      session.anonymousMigration.kind === "migrating"
    );
  }

  writesBlocked(session: Session): boolean {
    return (
      this.isCloudReadOnly(session) ||
      this.migrationChoiceBlocksWrites(session) ||
      this.hasNewerLocalUpdate(session) ||
      session.loadingLocalUpdate ||
      session.loadingCloudUpdate
    );
  }

  assertWorkspaceWritable(session: Session): void {
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
    if (previous) this.cloudSync.abortCloudUpdate(previous);
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
      this.organization.recoverOrganizationJobs(session);
      this.imports.recoverImportJobs(session);
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

  reconcile(session: Session, remote: RemoteWorkspace, hasCached: boolean) {
    const dirty = hasCached && session.cloudDirty;
    const transition = dirty ? this.imports.recoverableImportTransition(session, remote) : null;
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

  adoptSafeWorkspaceConflict(session: Session, remote: RemoteWorkspace): boolean {
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
    this.organization.recoverOrganizationJobs(session);
    this.imports.recoverImportJobs(session);
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

  applyUpdate(
    updater: (data: WorkspaceData) => WorkspaceData,
    token: number,
  ): { session: Session; data: WorkspaceData } | null {
    const session = this.active;
    if (
      !session?.ready ||
      session.exiting ||
      session.token !== token ||
      this.cloudSync.isResolvingReadingConflicts(session) ||
      this.isCloudReadOnly(session) ||
      this.migrationChoiceBlocksWrites(session)
    )
      return null;
    const next = updater(session.data);
    if (next === session.data) return null;
    const protectedMutation = this.imports.protectedImportMutation(session, next);
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

  async confirmWebCloudSave(session: Session): Promise<void> {
    await this.pump(session);
    if (!this.isActive(session)) throw new Error("当前账号已改变，未确认本次云端保存。");
    if (session.localDirty || session.cloudDirty || session.blocked || session.status !== "cloud")
      throw new Error(
        session.error || "尚未确认保存到云端。修改仅暂存在当前页面，请重新连接后重试。",
      );
  }

  pump(session: Session): Promise<void> {
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
          !this.imports.hasFencedImportTransition(session)
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
                const blob = await this.originals.readLocalOriginal(session, source.blobKey!);
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
              ? this.imports.hasFencedImportTransition(session)
                ? "saving"
                : "error"
              : "cloud"
            : "local");
        if (
          !session.blocked &&
          (!session.cloudDirty || this.imports.hasFencedImportTransition(session))
        )
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
        this.organization.recoverOrganizationJobs(session);
        this.imports.recoverImportJobs(session);
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
    this.cloudSync.abortCloudUpdate(session);
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
      this.imports.recoverImportJobs(session);
      return;
    }
    session.checking = true;
    session.status = "loading";
    this.publish(session);
    try {
      const remote = await this.io.loadCloud(session.user.id);
      if (!this.isActive(session)) return;
      session.checking = false;
      const transition = this.imports.recoverableImportTransition(session, remote);
      if (transition) {
        const restored = await this.imports.replayImportTransition(session, remote, transition);
        if (restored && this.isActive(session)) this.imports.recoverImportJobs(session);
        return;
      }
      this.reconcile(session, remote, true);
      this.remember(session);
      this.publish(session);
      await this.pump(session);
      this.imports.recoverImportJobs(session);
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

  checkCloudUpdates(token: number, signal?: AbortSignal): Promise<void> {
    return this.cloudSync.checkCloudUpdates(token, signal);
  }

  loadCloudUpdate(token: number, signal?: AbortSignal): Promise<void> {
    return this.cloudSync.loadCloudUpdate(token, signal);
  }

  setPendingReadingPosition(token: number, readerKey: string, pending: boolean): void {
    this.cloudSync.setPendingReadingPosition(token, readerKey, pending);
  }

  useRemote(
    token: number,
    preserveCurrent?: (snapshot: WorkspaceData) => Promise<boolean>,
  ): Promise<void> {
    return this.cloudSync.useRemote(token, preserveCurrent);
  }

  resolveReadingProgressConflicts(
    selections: readonly ReadingProgressSyncSelection[],
    token: number,
  ): Promise<void> {
    return this.cloudSync.resolveReadingProgressConflicts(selections, token);
  }

  resolveNoteConflicts(
    selections: readonly NoteSyncConflictSelection[],
    token: number,
  ): Promise<void> {
    return this.cloudSync.resolveNoteConflicts(selections, token);
  }

  restoreBackup(plan: RestorePlan, token: number): Promise<void> {
    return this.backupRestore.restoreBackup(plan, token);
  }

  previewSourcePurge(
    sourceId: string,
    token: number,
    selection?: PermanentSourceDeletionSelection,
    signal?: AbortSignal,
  ): Promise<SourcePurgePreview> {
    return this.purge.previewSourcePurge(sourceId, token, selection, signal);
  }

  purgeSource(sourceId: string, preview: SourcePurgePreview, token: number): Promise<void> {
    return this.purge.purgeSource(sourceId, preview, token);
  }

  previewSourceVersionPurge(
    sourceId: string,
    versionId: string,
    token: number,
  ): Promise<SourceVersionPurgePreview> {
    return this.purge.previewSourceVersionPurge(sourceId, versionId, token);
  }

  purgeSourceVersion(
    sourceId: string,
    versionId: string,
    preview: SourceVersionPurgePreview,
    token: number,
  ): Promise<void> {
    return this.purge.purgeSourceVersion(sourceId, versionId, preview, token);
  }

  sourceBlob(
    source: Source,
    token: number,
    options: SourceBlobReadOptions = {},
  ): Promise<Blob | undefined> {
    return this.originals.sourceBlob(source, token, options);
  }

  replaceFile(
    sourceId: string,
    expectedVersionId: string,
    candidate: Source,
    blob: Blob,
    token: number,
  ): Promise<void> {
    return this.originals.replaceFile(sourceId, expectedVersionId, candidate, blob, token);
  }

  importFile(
    file: File,
    spaceId: string,
    token: number,
    keepDuplicate = false,
    aiAllowed = false,
  ): Promise<ImportStartResult> {
    return this.imports.importFile(file, spaceId, token, keepDuplicate, aiAllowed);
  }

  retryImport(jobId: string, token: number): Promise<void> {
    return this.imports.retryImport(jobId, token);
  }

  cancelImport(jobId: string, token: number): void {
    this.imports.cancelImport(jobId, token);
  }

  ask(request: AnswerRequest, signal: AbortSignal, token: number, onProgress?: OnAnswerProgress) {
    return this.questions.ask(request, signal, token, onProgress);
  }

  setOrganizationStatus(status: OrganizationStatus, token: number) {
    this.organization.setOrganizationStatus(status, token);
  }

  organizationModelStatus(signal: AbortSignal, token: number) {
    return this.organization.organizationModelStatus(signal, token);
  }

  organizationBusy(token: number) {
    return this.organization.organizationBusy(token);
  }

  aiBusy(token: number) {
    return this.organization.organizationBusy(token) || this.questions.busy(token);
  }

  canOrganize(request: OrganizationRequest, token: number) {
    return this.organization.canOrganize(request, token);
  }

  organize(input: OrganizationInput, signal: AbortSignal | undefined, token: number) {
    return this.organization.organize(input, signal, token);
  }

  runAutomaticOrganization(request: OrganizationRequest, signal: AbortSignal, token: number) {
    return this.organization.runAutomaticOrganization(request, signal, token);
  }

  checkOrganization(jobId: string, token: number) {
    return this.organization.checkOrganization(jobId, token);
  }

  retryOrganization(jobId: string, token: number) {
    return this.organization.retryOrganization(jobId, token);
  }

  stopOrganization(jobId: string, token: number) {
    return this.organization.stopOrganization(jobId, token);
  }

  stopOrganizations() {
    this.organization.stopOrganizations();
  }
}
