import { createEmptyWorkspace } from "../seed";
import { assertWorkspaceOwner, workspaceSchema } from "../supabase/validation";
import {
  applyNoteSyncResolution,
  applyReadingProgressSyncResolution,
  applySafeNoteSyncChanges,
  planNoteSyncConflicts,
  planReadingProgressSyncConflicts,
  resolveNoteSyncConflict,
  type NoteSyncPlan,
  type ReadingProgressSyncPlan,
} from "../sync-conflicts";
import type { WorkspaceData } from "../types";
import type { WorkspaceCoordinator } from "./coordinator";
import { conflictRecordId, errorText } from "./errors";
import { unpack } from "./io";
import { sameData, sameDataOutsideNotes } from "./merge";
import { pendingFileKeys } from "./originals";
import type {
  NoteSyncConflictSelection,
  ReadingProgressSyncSelection,
  RemoteWorkspace,
  Session,
} from "./types";

/**
 * Owns everything that reads a newer cloud snapshot into this browser: the
 * foreground revision check, the fenced adoption write, the explicit
 * remote-recovery path, and the two reviewable conflict plans. Adoption is
 * only allowed while nothing else owns the session, which is what the long
 * `cloudUpdateBusy` predicate enumerates.
 */
export class CloudSyncController {
  private cloudUpdateTasks = new WeakMap<
    Session,
    { controller: AbortController; promise: Promise<void> }
  >();
  private pendingReadingPositions = new WeakMap<Session, Set<string>>();
  /** Ordinary editor callbacks cannot mutate a snapshot while a reviewed reading choice is saved. */
  private readingConflictResolutions = new WeakSet<Session>();

  constructor(private core: WorkspaceCoordinator) {}

  /** Stops an in-flight revision check; account exit and deletion both need this. */
  abortCloudUpdate(session: Session): void {
    this.cloudUpdateTasks.get(session)?.controller.abort();
  }

  isResolvingReadingConflicts(session: Session): boolean {
    return this.readingConflictResolutions.has(session);
  }

  noteSyncPlan(session: Session): NoteSyncPlan | null {
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
  readingProgressSyncPlan(session: Session): ReadingProgressSyncPlan | null {
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

  private cloudUpdateBusy(session: Session, explicit: boolean, committing = false): boolean {
    return (
      !this.core.isActive(session) ||
      !session.ready ||
      !session.user ||
      !session.knownRevision ||
      !session.confirmedCloud ||
      session.exiting ||
      session.pumping ||
      session.checking ||
      session.purging ||
      this.core.isCloudReadOnly(session) ||
      this.core.migration.migrationChoiceBlocksWrites(session) ||
      this.core.hasNewerLocalUpdate(session) ||
      session.loadingLocalUpdate ||
      (!committing &&
        (session.loadingCloudUpdate || !!this.core.atomicLocalWriteBarriers.get(session))) ||
      !!this.core.pendingLocalPersists.get(session)?.length ||
      !!this.core.pumpTasks.get(session) ||
      this.readingConflictResolutions.has(session) ||
      this.core.imports.hasFencedImportTransition(session) ||
      !!this.core.pendingRecoveryWrites.get(session)?.size ||
      this.core.backupRestore.hasSession(session) ||
      this.core.aiBusy(session.token) ||
      this.core.organization.hasPendingCloudOperations(session) ||
      pendingFileKeys.size > 0 ||
      this.core.imports.hasLeaseRetries(session) ||
      !!this.pendingReadingPositions.get(session)?.size ||
      this.core.questions.hasSession(session) ||
      this.core.organization.hasSession(session) ||
      this.core.imports.hasSession(session) ||
      this.core.imports.hasCancellations(session) ||
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
    const session = this.core.active;
    if (!session || session.token !== token || !this.core.isActive(session) || !readerKey) return;
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
    const session = this.core.active;
    if (
      !session?.user ||
      !session.ready ||
      session.token !== token ||
      session.exiting ||
      !this.core.io.loadCloudRevision ||
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
        if (!this.core.isActive(session)) return;
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
        if (this.core.isActive(session)) this.core.publish(session);
      });
    this.cloudUpdateTasks.set(session, { controller, promise: task });
    this.core.publish(session);
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
    const discovered = await read(this.core.io.loadCloudRevision!(userId, signal));
    if (!this.core.isActive(session) || signal.aborted) return;
    if (!Number.isSafeInteger(discovered.revision) || discovered.revision < 0)
      throw new Error("云端版本检查返回了无效数据，请稍后重试。");
    if (discovered.revision > session.revision)
      session.cloudUpdateRevision = Math.max(session.cloudUpdateRevision ?? 0, discovered.revision);
    if (session.cloudUpdateRevision !== null && session.cloudUpdateRevision <= session.revision)
      session.cloudUpdateRevision = null;
    this.core.publish(session);
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
      queue: this.core.queues.get(userId),
    };
    const unchanged = () =>
      session.data === boundary.data &&
      session.revision === boundary.revision &&
      session.localDirty === boundary.localDirty &&
      session.cloudDirty === boundary.cloudDirty &&
      session.confirmedCloud === boundary.confirmedCloud;
    const remote = await read(this.core.io.loadCloud(userId, signal));
    if (
      !this.core.isActive(session) ||
      signal.aborted ||
      !unchanged() ||
      session.localRevision !== boundary.localRevision ||
      this.core.queues.get(userId) !== boundary.queue ||
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
    this.core.reconcile(candidate, { data: parsed.data, revision: remote.revision }, true);
    if (candidate.blocked) {
      if (candidate.blocked === "conflict") {
        session.blocked = "conflict";
        session.status = "conflict";
        session.recovery = candidate.recovery;
        session.recoveryRevision = candidate.recoveryRevision;
        session.error = candidate.error;
        this.core.remember(session);
      } else session.cloudUpdateError = candidate.error;
      return;
    }
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.core.atomicLocalWriteBarriers.set(session, barrier);
    session.loadingCloudUpdate = true;
    const previous = this.core.queues.get(userId) ?? Promise.resolve();
    const write = previous.then(async () => {
      if (
        this.core.discardedSessions.has(session) ||
        signal.aborted ||
        !this.core.isActive(session) ||
        !unchanged() ||
        session.localRevision !== boundary.localRevision ||
        this.cloudUpdateBusy(session, explicit, true)
      )
        return;
      const savedRevision = await this.core.io.saveLocal(
        structuredClone(this.core.stored(candidate)),
        userId,
        session.localRevision,
      );
      if (typeof savedRevision === "number") this.core.setLocalRevision(session, savedRevision);
      if (this.core.discardedSessions.has(session)) return;
      if (
        this.core.isActive(session) &&
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
        this.core.remember(session);
        return;
      }
      // Ordinary editor input stays live during CAS. Deferred local persists
      // wait on our barrier, so repairs cannot be followed by an older queued
      // editor snapshot. Never give an edit from the old cloud base a new base.
      if (session.localDirty || this.core.isActive(session)) {
        session.localDirty = true;
        for (;;) {
          if (this.core.discardedSessions.has(session)) return;
          const data = session.data;
          const revision = session.revision;
          const dirty = session.cloudDirty;
          const base = session.confirmedCloud;
          const localRevision = await this.core.io.saveLocal(
            structuredClone(this.core.stored(session)),
            userId,
            session.localRevision,
          );
          if (typeof localRevision === "number") this.core.setLocalRevision(session, localRevision);
          if (
            data === session.data &&
            revision === session.revision &&
            dirty === session.cloudDirty &&
            base === session.confirmedCloud
          ) {
            session.localDirty = false;
            this.core.remember(session);
            break;
          }
        }
      }
    });
    this.core.queues.set(
      userId,
      write.catch(() => {}),
    );
    this.core.publish(session);
    try {
      await write;
    } catch (cause) {
      if (
        !this.core.discardedSessions.has(session) &&
        cause instanceof Error &&
        "code" in cause &&
        cause.code === "LOCAL_WORKSPACE_CONFLICT"
      ) {
        try {
          const latest = unpack(await this.core.io.loadLocal(userId));
          this.core.markNewerLocalUpdate(session, userId, {
            accountId: userId,
            localRevision: latest.localRevision,
            writerId: "cloud-update-conflict-readback",
          });
        } catch {
          /* Preserve the original local CAS failure. */
        }
      }
      if (!this.core.discardedSessions.has(session) && !unchanged()) {
        session.localDirty = true;
        session.status = "error";
        session.error =
          "当前编辑尚未保存到此浏览器：" + errorText(cause) + "。请重试或导出后再离开。";
      }
      throw cause;
    } finally {
      if (this.core.atomicLocalWriteBarriers.get(session) === barrier)
        this.core.atomicLocalWriteBarriers.delete(session);
      session.loadingCloudUpdate = false;
      release();
    }
    if (this.core.isActive(session) && session.cloudDirty && !session.localDirty)
      void this.core.pump(session);
  }

  async useRemote(
    token: number,
    preserveCurrent?: (snapshot: WorkspaceData) => Promise<boolean>,
  ): Promise<void> {
    const session = this.core.active;
    if (!session?.user || !session.ready || session.token !== token || !session.recovery) return;
    this.core.assertWorkspaceWritable(session);
    if (this.core.cloudOnly) {
      const boundary = session.data;
      const recovery = session.recovery;
      if (!preserveCurrent || !(await preserveCurrent(structuredClone(boundary))))
        throw new Error("当前页面的修改尚未完整导出，未载入云端副本。");
      if (
        !this.core.isActive(session) ||
        session.token !== token ||
        session.data !== boundary ||
        session.recovery !== recovery
      )
        throw new Error("导出期间账号或内容发生变化，请重新核对当前副本。");
    }
    session.ready = false;
    session.status = "loading";
    this.core.publish(session);
    try {
      const backupId = "recovery:" + session.user.id + ":" + Date.now() + ":" + session.token;
      const backup = structuredClone(this.core.stored(session));
      // Do not serialize recovery creation behind ordinary saving: useRemote
      // must be able to preserve its own conflict snapshot while an earlier
      // local confirmation is still in flight. The write is tracked separately
      // so discardAccount can still wait before clearing its recovery record.
      const write = this.core.discardedSessions.has(session)
        ? Promise.resolve()
        : this.core.io.saveLocal(backup, backupId, 0).then(() => {});
      this.core.trackRecoveryWrite(session, write);
      await write;
      if (!this.core.isActive(session)) return;
      const remote = await this.core.io.loadCloud(session.user.id);
      if (!this.core.isActive(session)) return;
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
      this.core.organization.recoverOrganizationJobs(session);
      this.core.imports.recoverImportJobs(session);
      this.core.remember(session);
      this.core.publish(session);
      await this.core.pump(session);
    } catch (cause) {
      if (!this.core.isActive(session)) return;
      session.ready = true;
      session.status = "error";
      session.error = "没有覆盖当前副本：" + errorText(cause);
      this.core.publish(session);
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
    const session = this.core.active;
    if (!session?.user || !session.ready || session.token !== token)
      throw new Error("当前账号已改变，请重新检查阅读位置冲突。 ");
    this.core.assertWorkspaceWritable(session);
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
        remote = await this.core.io.loadCloud(session.user.id);
      } catch (cause) {
        if (!this.core.isActive(session)) throw new Error("当前账号已改变，阅读位置尚未保存。 ");
        throw new Error("无法读取最新云端副本：" + errorText(cause));
      }
      if (!this.core.isActive(session)) throw new Error("当前账号已改变，阅读位置尚未保存。 ");
      if (session.data !== reviewedLocal)
        throw new Error("本机阅读位置已变化，请重新检查后再选择。 ");
      const candidate = remote.data || createEmptyWorkspace();
      if (remote.revision !== reviewedRevision || !sameData(candidate, reviewedRecovery)) {
        session.recovery = candidate;
        session.recoveryRevision = remote.revision;
        session.error = "云端版本已再次变化，已刷新待处理的阅读位置。";
        session.status = "conflict";
        this.core.remember(session);
        this.core.publish(session);
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
        await this.core.persist(session);
      } catch (cause) {
        if (!this.core.isActive(session)) throw new Error("当前账号已改变，阅读位置尚未保存。 ");
        Object.assign(session, previous);
        session.blocked = "conflict";
        session.status = "conflict";
        session.error = "所选阅读位置尚未保存在此浏览器：" + errorText(cause);
        this.core.remember(session);
        this.core.publish(session);
        throw new Error(session.error);
      }
      if (!this.core.isActive(session)) throw new Error("当前账号已改变，阅读位置尚未保存。 ");
      session.blocked = null;
      session.recovery = null;
      session.recoveryRevision = null;
      session.error = "";
      session.status = session.cloudDirty ? "saving" : "cloud";
      this.core.remember(session);
      this.core.publish(session);
      await this.core.pump(session);
      if (!this.core.isActive(session)) throw new Error("当前账号已改变，阅读位置保存结果未知。 ");
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
    const session = this.core.active;
    if (!session?.user || !session.ready || session.token !== token)
      throw new Error("当前账号已改变，请重新检查同步冲突。 ");
    this.core.assertWorkspaceWritable(session);
    if (session.blocked !== "conflict" || !session.recovery || session.recoveryRevision === null)
      throw new Error("当前没有可处理的笔记同步冲突。 ");

    const reviewedRecovery = session.recovery;
    const reviewedRevision = session.recoveryRevision;
    let remote: RemoteWorkspace;
    try {
      remote = await this.core.io.loadCloud(session.user.id);
    } catch (cause) {
      throw new Error("无法读取最新云端副本：" + errorText(cause));
    }
    if (!this.core.isActive(session)) return;
    const candidate = remote.data || createEmptyWorkspace();
    if (remote.revision !== reviewedRevision || !sameData(candidate, reviewedRecovery)) {
      session.recovery = candidate;
      session.recoveryRevision = remote.revision;
      session.error = "云端版本已再次变化，已刷新待处理的冲突内容。";
      session.status = "conflict";
      this.core.remember(session);
      this.core.publish(session);
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
      await this.core.persist(session);
    } catch (cause) {
      if (!this.core.isActive(session)) return;
      session.blocked = "conflict";
      session.status = "conflict";
      session.error = "合并结果尚未保存在此浏览器：" + errorText(cause);
      this.core.remember(session);
      this.core.publish(session);
      throw new Error(session.error);
    }
    if (!this.core.isActive(session)) return;
    session.blocked = null;
    session.recovery = null;
    session.recoveryRevision = null;
    session.error = "";
    session.status = "saving";
    this.core.remember(session);
    this.core.publish(session);
    await this.core.pump(session);
  }
}
