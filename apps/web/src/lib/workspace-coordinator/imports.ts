import type { ImportParseLease } from "../cloud";
import { assessImportQuota } from "../import-quota";
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
} from "../import-queue";
import { createEmptyWorkspace } from "../seed";
import type { Source, WorkspaceData } from "../types";
import type { WorkspaceCoordinator } from "./coordinator";
import { conflictError, errorText } from "./errors";
import { accountKey, unpack } from "./io";
import { sameData } from "./merge";
import { pendingFileKeys, verifyOriginal } from "./originals";
import type {
  AtomicPreparedImportResult,
  ImportStartResult,
  PendingImport,
  QueuedImport,
  RecoverableImportTransition,
  RemoteWorkspace,
  Session,
} from "./types";

// SHA-256 identity is the user-visible duplicate rule. Serialize only the
// short reservation/persistence transaction so two simultaneous file picks
// cannot both miss the same existing source before either one is published.
const importHashQueues = new Map<string, Promise<void>>();

export async function withImportHashReservation<T>(
  hash: string,
  operation: () => Promise<T>,
): Promise<T> {
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

export async function withImportAccountReservation<T>(
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

/**
 * Owns the import queue and everything that fences a parse: the server lease,
 * the local transition fence, and the cancellation set. Every field here is
 * keyed by `${session.token}:${jobId}` or by the session itself, so a switched
 * account can be redacted without touching another account's in-flight parse.
 */
export class ImportsController {
  private pendingImports = new Map<string, PendingImport>();
  private queuedImports: QueuedImport[] = [];
  private drainingImports = false;
  /** Pairs staged for a dedicated parse transition; generic saves must wait. */
  private importTransitionFences = new Map<Session, Set<string>>();
  /** Prevents a queued worker from claiming while an owner-level cancel is in flight. */
  private cancellingImports = new Set<string>();
  /** A held lease may expire after the other browser closes; retry without reparsing early. */
  private importLeaseRetries = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private core: WorkspaceCoordinator) {}

  /** True while this session still owns a running or queued parse. */
  hasSession(session: Session): boolean {
    return (
      [...this.pendingImports.values()].some((pending) => pending.session === session) ||
      this.queuedImports.some((pending) => pending.session === session)
    );
  }

  hasLeaseRetries(session: Session): boolean {
    return [...this.importLeaseRetries.keys()].some((key) => key.startsWith(`${session.token}:`));
  }

  hasCancellations(session: Session): boolean {
    return [...this.cancellingImports].some((key) => key.startsWith(`${session.token}:`));
  }

  /** Stops every worker whose source/job pair no longer matches the session. */
  abortInvalidated(): void {
    for (const pending of this.pendingImports.values()) {
      const error = this.importError(pending);
      if (error && !pending.controller.signal.aborted) pending.controller.abort(error);
    }
  }

  collectSessions(collect: (session: Session) => void): void {
    for (const pending of this.pendingImports.values()) collect(pending.session);
    for (const pending of this.queuedImports) collect(pending.session);
  }

  /** Drops the local fences a redacted session owned, without touching other accounts. */
  redactSession(session: Session): void {
    this.clearImportLeaseRetries(session);
    this.importTransitionFences.delete(session);
    for (const key of this.cancellingImports) {
      if (key.startsWith(`${session.token}:`)) this.cancellingImports.delete(key);
    }
  }

  redactAccount(accountId: string, stopped: DOMException): void {
    for (const [key, pending] of this.pendingImports) {
      if (pending.session.user?.id === accountId) {
        pending.controller.abort(stopped);
        this.pendingImports.delete(key);
      }
    }
    this.queuedImports = this.queuedImports.filter(
      (pending) => pending.session.user?.id !== accountId,
    );
  }

  private importLeaseEnabled(session: Session): boolean {
    return !!(
      session.user &&
      this.core.io.claimImportParse &&
      this.core.io.heartbeatImportParse &&
      this.core.io.releaseImportParse &&
      this.core.io.finishImportParse
    );
  }

  hasFencedImportTransition(session: Session): boolean {
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
  protectedImportMutation(session: Session, next: WorkspaceData): string | null {
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
  recoverableImportTransition(
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
  async replayImportTransition(
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
      !this.core.isActive(session) ||
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
      this.core.remember(session);
      this.core.publish(session);

      let saved: { revision: number };
      if (transition.action === "finish") {
        const claim = this.core.io.claimImportParse;
        const finish = this.core.io.finishImportParse;
        if (!claim || !finish) throw new Error("当前云端尚未支持解析结果恢复，请完成迁移后重试。");
        const claimed = await claim(transition.sourceId, transition.versionId, user.id);
        if (claimed.status === "held")
          throw new Error("另一台设备正在解析这份资料，请等待它完成或稍后重新连接。");
        if (claimed.status !== "claimed" || !claimed.leaseToken)
          throw new Error("暂时无法重新认领解析任务，请稍后重新连接。");
        leaseToken = claimed.leaseToken;
        if (!this.core.isActive(session) || !session.ready || !targetMatches()) return false;
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
          transition.action === "cancel"
            ? this.core.io.cancelImportParse
            : this.core.io.retryImportParse;
        if (!send) throw new Error("当前云端尚未支持此解析状态恢复，请完成迁移后重试。");
        if (!this.core.isActive(session) || !session.ready || !targetMatches()) return false;
        const payload = session.data;
        saved = await send(
          payload,
          session.revision,
          transition.sourceId,
          transition.versionId,
          user.id,
        );
      }
      if (!this.core.isActive(session) || !targetMatches()) return false;
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
      this.core.remember(session);
      this.core.publish(session);
      try {
        await this.core.persist(session);
      } catch (cause) {
        if (this.core.isActive(session)) {
          session.status = "error";
          session.error = `${label}已保存到云端，但尚未确认保存在此浏览器：` + errorText(cause);
          this.core.publish(session);
        }
      }
      return true;
    } catch (cause) {
      if (!this.core.isActive(session)) return false;
      session.localDirty = true;
      session.cloudDirty = true;
      if (conflictError(cause)) {
        session.blocked = "conflict";
        try {
          const latest = await this.core.io.loadCloud(user.id);
          if (!this.core.isActive(session)) return false;
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
      this.core.remember(session);
      this.core.publish(session);
      return false;
    } finally {
      this.unfenceImportTransition(session, transition.jobId);
      if (!committed && leaseToken && this.core.io.releaseImportParse && user) {
        try {
          await this.core.io.releaseImportParse(
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
      if (committed && transition.action === "retry" && this.core.isActive(session))
        this.enqueueImport(session, transition.jobId);
      if (
        this.core.isActive(session) &&
        !session.blocked &&
        (session.localDirty || session.cloudDirty)
      )
        void this.core.pump(session);
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
        !this.core.isActive(session) ||
        !session.ready ||
        this.core.writesBlocked(session) ||
        !this.importLeaseEnabled(session)
      )
        return false;
      if (this.importMatchesConfirmedCloud(session, jobId)) return true;
      if (session.blocked || session.checking) return false;
      await this.core.pump(session);
      if (this.importMatchesConfirmedCloud(session, jobId)) return true;
      // A clean but non-matching cloud snapshot means this job was changed by
      // another device. It must be reconciled, never parsed from stale state.
      if (session.blocked || (!session.localDirty && !session.cloudDirty)) return false;
    }
    return false;
  }

  private scheduleImportLeaseRetry(session: Session, jobId: string, leaseUntil?: string): void {
    if (
      !this.core.isActive(session) ||
      this.core.writesBlocked(session) ||
      !this.importLeaseEnabled(session)
    )
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
      if (!this.core.isActive(session) || session.blocked || this.core.writesBlocked(session))
        return;
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
    const heartbeat = this.core.io.heartbeatImportParse;
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
    const release = this.core.io.releaseImportParse;
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
    const finish = this.core.io.finishImportParse;
    const user = session.user;
    if (!lease || !finish || !user || !this.core.isActive(session) || !session.ready) return false;
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
      this.core.remember(session);
      this.core.publish(session);
      await this.core.persist(session);
      if (
        !this.core.isActive(session) ||
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
      if (!this.core.isActive(session)) return false;
      committed = true;
      session.confirmedCloud = structuredClone(payload);
      session.revision = saved.revision;
      session.knownRevision = true;
      session.cloudDirty = session.data !== payload;
      session.localDirty = true;
      session.blocked = null;
      session.error = "";
      session.status = session.cloudDirty ? "saving" : "cloud";
      this.core.remember(session);
      this.core.publish(session);
      try {
        await this.core.persist(session);
      } catch (cause) {
        if (this.core.isActive(session)) {
          session.status = "error";
          session.error = "解析结果已保存到云端，但尚未确认保存在此浏览器：" + errorText(cause);
          this.core.publish(session);
        }
      }
      return true;
    } catch (cause) {
      if (!this.core.isActive(session)) return false;
      session.localDirty = true;
      session.cloudDirty = true;
      if (conflictError(cause)) {
        session.blocked = "conflict";
        try {
          const remote = await this.core.io.loadCloud(user.id);
          if (!this.core.isActive(session)) return false;
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
      this.core.remember(session);
      this.core.publish(session);
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
        this.core.isActive(session) &&
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
        this.core.remember(session);
        this.core.publish(session);
      }
      if (
        this.core.isActive(session) &&
        !pending.cancelling &&
        !session.blocked &&
        (session.localDirty || session.cloudDirty)
      )
        void this.core.pump(session);
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
    const send =
      action === "cancel" ? this.core.io.cancelImportParse : this.core.io.retryImportParse;
    const initial = this.importState(session, jobId);
    const target = this.importStateFrom(next, jobId);
    if (
      !user ||
      !send ||
      !initial ||
      !target ||
      initial.job.sourceId !== target.job.sourceId ||
      initial.job.versionId !== target.job.versionId ||
      !this.core.isActive(session) ||
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
      this.core.remember(session);
      this.core.publish(session);
      await this.core.persist(session);
      if (!this.core.isActive(session) || !session.ready || session.blocked || !targetMatches())
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
      if (!this.core.isActive(session)) return false;
      committed = true;
      session.confirmedCloud = structuredClone(payload);
      session.revision = saved.revision;
      session.knownRevision = true;
      session.cloudDirty = session.data !== payload;
      session.localDirty = true;
      session.blocked = null;
      session.error = "";
      session.status = session.cloudDirty ? "saving" : "cloud";
      this.core.remember(session);
      this.core.publish(session);
      try {
        await this.core.persist(session);
      } catch (cause) {
        if (this.core.isActive(session)) {
          session.status = "error";
          session.error = `${label}已保存到云端，但尚未确认保存在此浏览器：` + errorText(cause);
          this.core.publish(session);
        }
      }
      return true;
    } catch (cause) {
      if (!this.core.isActive(session)) return false;
      session.localDirty = true;
      session.cloudDirty = true;
      if (conflictError(cause)) {
        session.blocked = "conflict";
        try {
          const remote = await this.core.io.loadCloud(user.id);
          if (!this.core.isActive(session)) return false;
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
      this.core.remember(session);
      this.core.publish(session);
      return false;
    } finally {
      const transitionStillStaged = targetMatches();
      this.unfenceImportTransition(session, jobId);
      if (!committed && transitionStillStaged && this.core.isActive(session) && !session.blocked) {
        session.localDirty = true;
        session.cloudDirty = true;
        session.blocked = "error";
        session.status = "error";
        session.error = `${label}尚未通过云端确认，已保留在本机。请重新连接后检查同步状态。`;
        this.core.remember(session);
        this.core.publish(session);
      }
      if (
        this.core.isActive(session) &&
        !session.blocked &&
        (session.localDirty || session.cloudDirty)
      )
        void this.core.pump(session);
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
    if (
      this.core.isActive(session) &&
      current?.job.status === "queued" &&
      !current.source.deletedAt
    )
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
      if (this.core.isActive(session) && !session.blocked) {
        session.status = "error";
        session.error = "取消解析失败：" + errorText(cause);
        this.core.publish(session);
      }
    } finally {
      this.cancellingImports.delete(this.importKey(session, jobId));
    }
  }

  /** Flush unrelated edits before fencing the parsed pair at the current CAS revision. */
  private async readyToFinishLeasedImport(pending: PendingImport): Promise<boolean> {
    await this.core.pump(pending.session);
    if (
      !this.core.isActive(pending.session) ||
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
      !this.core.isActive(session) ||
      !session.ready ||
      this.core.writesBlocked(session) ||
      next === session.data
    )
      return false;
    session.data = next;
    session.localDirty = true;
    if (session.user) session.cloudDirty = true;
    this.core.remember(session);
    this.core.publish(session);
    void this.core.pump(session);
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
    if (!this.core.isActive(session) || !session.ready) return false;
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
    if (!this.core.isActive(pending.session) || !pending.session.ready)
      return new Error("当前账号已改变，导入已停止。请在当前账号重新选择文件。");
    if (this.core.isCloudReadOnly(pending.session)) return new Error(this.core.readOnlyMessage());
    if (this.core.hasNewerLocalUpdate(pending.session) || pending.session.loadingLocalUpdate)
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
    if (this.core.writesBlocked(session)) return;
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
        if (this.core.writesBlocked(next.session)) continue;
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
    const claim = this.core.io.claimImportParse;
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
      if (conflictError(cause)) void this.core.retry(session.token).catch(() => {});
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
        await this.core.io.releaseImportParse!(
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
        await this.core.io.releaseImportParse!(
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
      const blob = source ? await this.core.originals.sourceBlob(source, session.token) : undefined;
      const afterRead = this.importError(pending);
      if (afterRead) throw afterRead;
      if (!source?.blobKey || !blob)
        throw new Error("原文件在此浏览器中不可用，无法继续解析。请重新选择原文件。");
      const parsed = await this.core.pipeline.parse(source, blob, {
        signal: pending.controller.signal,
      });
      const afterParse = this.importError(pending);
      if (afterParse) throw afterParse;
      if (parsed.id !== source.id || parsed.versionId !== source.versionId)
        throw new Error("解析结果身份不一致，未保存到其他资料。");
      if (!(await this.readyToFinishLeasedImport(pending))) return;
      const next = this.terminalImportData(session, jobId, parsed);
      if (next) await this.finishLeasedImport(pending, next);
    } catch (cause) {
      if (pending.controller.signal.aborted || pending.lease?.lost) {
        if (this.core.isActive(session) && pending.lease?.lost)
          this.scheduleImportLeaseRetry(session, jobId, pending.lease.leaseUntil);
        return;
      }
      const current = this.importState(session, jobId);
      if (
        !current ||
        !this.core.isActive(session) ||
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
    if (this.core.writesBlocked(session)) return;
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
      const blob = source ? await this.core.originals.sourceBlob(source, session.token) : undefined;
      const afterRead = this.importError(pending);
      if (afterRead) throw afterRead;
      if (!source?.blobKey || !blob)
        throw new Error("原文件在此浏览器中不可用，无法继续解析。请重新选择原文件。");
      const parsed = await this.core.pipeline.parse(source, blob, {
        signal: pending.controller.signal,
      });
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
        !this.core.isActive(session) ||
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

  recoverImportJobs(session: Session) {
    if (
      !this.core.isActive(session) ||
      !session.ready ||
      this.core.writesBlocked(session) ||
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
    const session = this.core.active;
    if (!session?.ready || session.token !== token)
      throw new Error("当前账号已改变，请重新选择需要导入的文件。");
    this.core.assertWorkspaceWritable(session);
    return withImportAccountReservation(accountKey(session.user), async () => {
      if (!this.core.isActive(session) || !session.ready || session.token !== token)
        throw new Error("当前账号已改变，未导入这份文件。");
      this.core.assertWorkspaceWritable(session);
      // A normal pick can be a duplicate, so only reject structural limits
      // before hashing. A requested independent copy always needs new bytes,
      // and can be rejected against the account limit immediately.
      this.assertImportQuota(session, file, { deferAccountStorageLimit: !keepDuplicate });
      const prepared = await this.core.pipeline.prepare(file, spaceId, aiAllowed);
      if (!this.core.isActive(session) || !session.ready || session.token !== token)
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
    const commit = this.core.io.commitLocalImport;
    if (!commit) throw new Error("当前环境无法原子保存导入资料。");
    const blobKey = prepared.blobKey!;
    await verifyOriginal(prepared, file);
    if (!this.core.isActive(session) || !session.ready || session.token !== token)
      throw new Error("当前账号已改变，未导入这份文件。");
    this.core.assertWorkspaceWritable(session);

    // Flush this page first. The transaction below then merges against the
    // newest persisted account record, including a commit from another tab.
    while (session.localDirty) {
      await this.core.persist(session);
      if (!this.core.isActive(session) || !session.ready || session.token !== token)
        throw new Error("当前账号已改变，未导入这份文件。");
    }
    this.core.assertWorkspaceWritable(session);
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
    this.core.atomicLocalWriteBarriers.set(session, atomicBarrier);
    let barrierReleased = false;
    const openBarrier = () => {
      if (barrierReleased) return;
      barrierReleased = true;
      if (this.core.atomicLocalWriteBarriers.get(session) === atomicBarrier)
        this.core.atomicLocalWriteBarriers.delete(session);
      releaseAtomicBarrier();
    };

    try {
      const previous = this.core.queues.get(accountId) || Promise.resolve();
      const transaction = previous.then(() => {
        if (
          this.core.discardedSessions.has(session) ||
          !this.core.isActive(session) ||
          !session.ready ||
          session.token !== token
        )
          throw new Error("当前账号已改变，未导入这份文件。");
        this.core.assertWorkspaceWritable(session);
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
              workspace: this.core.storedAtomicImport(session, latestStored, latest, next, changed),
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
            workspace: this.core.storedAtomicImport(session, latestStored, latest, next, true),
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
      this.core.queues.set(
        accountId,
        transaction.then(
          () => {},
          () => {},
        ),
      );
      const committed = await transaction;
      if (this.core.discardedSessions.has(session))
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
        ? this.core.mergeConcurrentImportCommit(session.data, stored.data, boundaryData)
        : stored.data;
      if (!mergedData) {
        session.localDirty = true;
        session.blocked = "error";
        session.status = "error";
        session.error =
          "导入任务已保留在本机，但另一标签页同时修改了相同资料。当前页面的修改未覆盖较新副本；请先导出需要保留的内容，再重新载入。";
        this.core.remember(session);
        this.core.publish(session);
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
      this.core.setLocalRevision(session, committed.localRevision);
      session.localDirty = needsRepairPersist;
      if (needsRepairPersist && session.user)
        session.cloudDirty = session.cloudDirty || storedChangedAtBoundary;
      this.core.remember(session);
      this.core.publish(session);
      // Waiting editor/cloud callbacks now see the adopted revision and merged
      // snapshot. This repair is enqueued synchronously before they resume, so
      // all callers coalesce on the same safe full-workspace save.
      openBarrier();
      if (needsRepairPersist) {
        await this.core.persist(session);
        this.core.publish(session);
      }
      if (!this.core.isActive(session) || !session.ready || session.token !== token)
        throw new Error("当前账号已改变，导入任务已保留在原账号的本机副本中。");
      void this.core.pump(session);
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
    if (!this.core.isActive(session) || !session.ready || session.token !== token)
      throw new Error("当前账号已改变，未导入这份文件。");
    this.core.assertWorkspaceWritable(session);
    if (this.core.io.commitLocalImport) {
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
        !this.core.update(
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
    if (!this.core.io.putBlobIfAbsent)
      throw new Error("当前环境无法安全保存原文件，请重新载入后重试。资料未导入。");
    const blobKey = prepared.blobKey!;
    if (pendingFileKeys.has(blobKey)) throw new Error("这份文件正在保存，请等待完成。");
    pendingFileKeys.add(blobKey);
    let created = false;
    let published = false;
    try {
      await verifyOriginal(prepared, file);
      created = await this.core.originals.putLocalOriginal(session, blobKey, file);
      if (!created) throw new Error("原文件标识已存在，请重新选择文件后重试。已有原件未被覆盖。");
      const stored = await this.core.originals.readLocalOriginal(session, blobKey);
      if (!stored) throw new Error("原文件尚未确认保存在此浏览器，资料未导入。");
      await verifyOriginal(prepared, stored);
      if (!this.core.isActive(session) || !session.ready)
        throw new Error("当前账号已改变，未将这份文件写入新账号。");
      this.core.assertWorkspaceWritable(session);
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
      await this.core.persist(session);
      if (!this.core.isActive(session) || !session.ready)
        throw new Error("当前账号已改变，导入任务已保留在原账号的本机副本中。");
      this.enqueueImport(session, job.id);
      return { kind: "queued", job };
    } catch (cause) {
      if (!published && created && this.core.io.deleteUnreferencedBlob) {
        try {
          await this.core.originals.deleteLocalOriginal(session, blobKey);
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
    const session = this.core.active;
    if (!session?.ready || session.token !== token)
      throw new Error("当前账号已改变，请重新打开导入记录。");
    this.core.assertWorkspaceWritable(session);
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
    if (this.importLeaseEnabled(session) && this.core.io.retryImportParse) {
      await this.retryCloudImport(session, jobId);
      return;
    }
    if (!this.commitImportData(session, next))
      throw new Error("导入资料已变化，请重新打开后重试。");
    await this.core.persist(session);
    if (!this.core.isActive(session) || !session.ready)
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
    const session = this.core.active;
    if (!session?.ready || session.token !== token || this.core.writesBlocked(session)) return;
    const key = this.importKey(session, jobId);
    const current = this.importState(session, jobId);
    const canCancelInCloud =
      !!current &&
      !current.source.deletedAt &&
      current.job.originalSaved &&
      current.job.stage === "parsing" &&
      (current.job.status === "queued" || current.job.status === "running");
    if (this.importLeaseEnabled(session) && this.core.io.cancelImportParse && canCancelInCloud) {
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
}
