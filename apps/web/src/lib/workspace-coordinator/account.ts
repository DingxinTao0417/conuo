import { createEmptyWorkspace } from "../seed";
import type { WorkspaceCoordinator } from "./coordinator";
import { errorText } from "./errors";
import { noAnonymousWorkspaceMigration } from "./merge";
import type { Session } from "./types";

/**
 * Owns account-level access fences and local deletion. `discardedAccounts` is
 * identity-only and survives account switches, so a late continuation from a
 * deleted account can never recreate its IndexedDB document;
 * `unverifiedAccounts` is the weaker, recoverable form used when the deletion
 * marker itself could not be read.
 */
export class AccountController {
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

  constructor(private core: WorkspaceCoordinator) {}

  isDiscarded(accountId: string): boolean {
    return this.discardedAccounts.has(accountId);
  }

  isUnverified(accountId: string): boolean {
    return this.unverifiedAccounts.has(accountId);
  }

  /** A normal publish replaces the frozen deletion view. */
  clearDeletionView(): void {
    this.accountDeletionView = null;
  }

  /** Confirmed deletions are announced for every account, so subscribe once. */
  watchConfirmedDeletions(): void {
    if (
      !this.confirmedAccountDeletionUnsubscribe &&
      this.core.io.subscribeConfirmedAccountDeletions
    ) {
      this.confirmedAccountDeletionUnsubscribe = this.core.io.subscribeConfirmedAccountDeletions(
        (accountId) => this.discardAccount(accountId),
      );
    }
  }

  /** Releases both deletion subscriptions when the hook unmounts. */
  dispose(): void {
    this.stopAccountDeletionSubscription();
    const unsubscribe = this.confirmedAccountDeletionUnsubscribe;
    this.confirmedAccountDeletionUnsubscribe = null;
    try {
      unsubscribe?.();
    } catch {
      /* Disposal never authorizes old writes. */
    }
  }

  stopAccountDeletionSubscription(): void {
    const unsubscribe = this.accountDeletionUnsubscribe;
    this.accountDeletionUnsubscribe = null;
    try {
      unsubscribe?.();
    } catch {
      /* Authoritative checks do not rely on notifications. */
    }
  }

  startAccountDeletionSubscription(session: Session, accountId: string): void {
    this.stopAccountDeletionSubscription();
    if (!session.user) return;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = this.core.io.subscribeLocalAccountDeletions?.(accountId, () => {
        void this.discardAccount(accountId).catch(() => {});
      });
    } catch {
      /* Focus and activation still check the authoritative marker. */
    }
    const check = () => {
      if (this.core.isCurrent(session) && !session.exiting)
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

  checkAccountDeletionMarker(session: Session): Promise<void> {
    const existing = this.deletionMarkerChecks.get(session);
    if (existing) return existing;
    const task = (async () => {
      const accountId = session.user?.id;
      if (!accountId || !this.core.io.isAccountLocallyDeleted) return;
      try {
        if (await this.core.io.isAccountLocallyDeleted(accountId))
          await this.discardAccount(accountId);
        else if (this.core.isCurrent(session)) {
          this.unverifiedAccounts.delete(accountId);
          if (session.accountAccessVerificationFailed) await this.core.activate(session.user);
        }
      } catch (cause) {
        if (this.core.isCurrent(session)) {
          this.unverifiedAccounts.add(accountId);
          // A fresh activation has not read account data yet. It must not
          // replace a retained dirty session with its empty loading snapshot.
          if (session.ready) this.core.remember(session);
          session.accountAccessVerificationFailed = true;
          session.ready = false;
          this.core.cloudSync.abortCloudUpdate(session);
          session.status = "error";
          session.error = "无法核验本机账号注销状态，已暂停访问：" + errorText(cause);
          this.core.publish(session);
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
    if (this.core.active) collect(this.core.active);
    for (const session of this.core.memory.values()) collect(session);
    for (const session of this.core.pendingLocalPersists.keys()) collect(session);
    for (const session of this.core.pendingRecoveryWrites.keys()) collect(session);
    for (const session of this.core.pumpTasks.keys()) collect(session);
    this.core.questions.collectSessions(collect);
    this.core.organization.collectSessions(collect);
    this.core.imports.collectSessions(collect);
    this.core.memory.delete(accountId);
    const visible = this.core.active?.user?.id === accountId;
    if (visible) {
      this.core.stopLocalCommitSubscription();
      this.stopAccountDeletionSubscription();
      this.core.active = null;
    }
    for (const session of sessions) {
      this.core.discardedSessions.add(session);
      this.core.pendingLocalPersists.delete(session);
      this.core.backupRestore.redactSession(session);
      this.core.cloudSync.abortCloudUpdate(session);
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
      this.core.imports.redactSession(session);
    }
    const stopped = new DOMException("账号注销请求已提交，本次操作已停止。", "AbortError");
    this.core.questions.redactAccount(accountId, stopped);
    this.core.organization.redactAccount(accountId, stopped);
    this.core.imports.redactAccount(accountId, stopped);
    if (!visible) {
      const prior = this.accountDeletionView;
      if (
        prior?.accountId === accountId &&
        this.core.view.token === prior.token &&
        !this.core.active
      ) {
        this.core.view = {
          ...this.core.view,
          accountDeletionState: "clearing",
          error: "账号已停止访问，正在重试本机清理。",
        };
        this.core.listeners.forEach((listener) => listener());
        return { sessions, token: prior.token };
      }
      return { sessions, token: null };
    }
    const token = ++this.core.token;
    this.accountDeletionView = { accountId, token };
    this.core.view = {
      ...this.core.view,
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
    this.core.listeners.forEach((listener) => listener());
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
          await this.core.io.markAccountLocalDeletion?.(accountId);
        } catch (cause) {
          errors.push("本机注销标记保存失败：" + errorText(cause));
        }
        for (;;) {
          const tail = this.core.queues.get(accountId);
          await tail?.catch(() => {});
          if (this.core.queues.get(accountId) === tail) break;
        }
        const recoveryWrites = [...sessions].flatMap((session) => [
          ...(this.core.pendingRecoveryWrites.get(session) ?? []),
        ]);
        await Promise.all(recoveryWrites.map((write) => write.catch(() => {})));
        try {
          await this.core.io.clearAccountLocalCache?.(accountId);
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
      if (token !== null && this.core.view.token === token && !this.core.active) {
        const error = this.accountDeletionErrors.get(accountId);
        this.core.view = {
          ...this.core.view,
          accountDeletionState: error ? "cleanup-failed" : "blocked",
          error: error
            ? "账号已停止访问，但本机清理尚未完成：" + error
            : "账号已提交注销，本机副本已清理并停止访问。",
        };
        this.core.listeners.forEach((listener) => listener());
      }
    }
  }

  async retryAccountLocalDeletion(): Promise<void> {
    const target = this.accountDeletionView;
    if (!target || this.core.view.token !== target.token || this.core.active)
      throw new Error("当前账号状态已改变，请重新打开账号设置核对。");
    await this.discardAccount(target.accountId);
  }
}
