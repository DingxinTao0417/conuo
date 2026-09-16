import type { DurableOrganizationRequest } from "../cloud";
import { validateRelationProposals } from "../concept-relations";
import { knowledgeNoteKey, validateKnowledgeChanges } from "../knowledge-update";
import {
  organizationCitations,
  organizationContextKey,
  organizationUnavailableReason,
} from "../organization";
import {
  isLocalDevelopmentOrganizationRunnerEnabled,
  localDevelopmentOrganizationRunnerStateFromEnvironment,
  organizationProcessorAvailabilityMessage,
} from "../organization-processor-capability";
import { organizationResultSchema } from "../organization-schema";
import type { OrganizationInput, OrganizationStatus } from "../organization-runner";
import type { OrganizationJob, OrganizationRequest } from "../organization-types";
import { resolveCitation } from "../retrieval";
import type { WorkspaceData } from "../types";
import type { WorkspaceCoordinator } from "./coordinator";
import { errorText } from "./errors";
import type { PendingOrganization, Session } from "./types";

export function keepsRunningAfterBrowserExit(job: OrganizationJob): boolean {
  return (
    job.durable === true &&
    (job.request.kind === "source" || job.request.kind === "knowledge") &&
    (job.status === "queued" || job.status === "running")
  );
}

export function isDurableOrganizationRequest(
  request: OrganizationRequest,
): request is DurableOrganizationRequest {
  return request.kind === "source" || request.kind === "knowledge";
}

export function isInterruptedBrowserOrganization(job: OrganizationJob): boolean {
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
export function reconcileDurableOrganizationProjections(
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

/**
 * Owns organization tasks: both the page-run jobs tracked in
 * `pendingOrganizations` and the durable server-side ones whose projection is
 * read back through `pendingCloudOperations`. The coordinator keeps its public
 * methods as forwarding wrappers so `OrganizationHost` stays unchanged.
 */
export class OrganizationController {
  private pendingOrganizations = new Set<PendingOrganization>();
  private pendingCloudOperations = new WeakMap<Session, number>();

  constructor(private core: WorkspaceCoordinator) {}

  hasSession(session: Session): boolean {
    return [...this.pendingOrganizations].some((item) => item.session === session);
  }

  hasPendingCloudOperations(session: Session): boolean {
    return !!this.pendingCloudOperations.get(session);
  }

  /** Stops every task whose evidence boundary no longer matches the session. */
  abortInvalidated(): void {
    for (const pending of this.pendingOrganizations) {
      const error = this.organizationError(pending);
      if (error) pending.controller.abort(error);
    }
  }

  collectSessions(collect: (session: Session) => void): void {
    for (const pending of this.pendingOrganizations) collect(pending.session);
  }

  redactAccount(accountId: string, stopped: DOMException): void {
    for (const pending of this.pendingOrganizations) {
      if (pending.session.user?.id === accountId) {
        pending.controller.abort(stopped);
        this.pendingOrganizations.delete(pending);
      }
    }
  }

  setOrganizationStatus(status: OrganizationStatus, token: number) {
    const session = this.core.active;
    if (
      !session ||
      session.token !== token ||
      JSON.stringify(session.organizationStatus) === JSON.stringify(status)
    )
      return;
    session.organizationStatus = status;
    this.core.publish(session);
  }

  async organizationModelStatus(signal: AbortSignal, token: number) {
    const session = this.core.active;
    if (!session?.ready || !session.user || session.token !== token)
      throw new Error("请先登录账号。");
    if (this.core.isCloudReadOnly(session)) throw new Error(this.core.readOnlyMessage());
    const result = await this.core.io.getModelStatus(session.user.id, signal);
    if (!this.core.isActive(session) || signal.aborted)
      throw new DOMException("模型状态检查已停止", "AbortError");
    return result;
  }

  organizationBusy(token: number) {
    return [...this.pendingOrganizations].some((pending) => pending.session.token === token);
  }

  canOrganize(request: OrganizationRequest, token: number) {
    const session = this.core.active;
    return (
      !!session?.ready &&
      session.token === token &&
      !!session.user &&
      !this.core.isCloudReadOnly(session) &&
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
      !this.core.isActive(session) ||
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
    this.core.remember(session);
    this.core.publish(session);
    try {
      await this.core.persist(session);
    } catch (cause) {
      if (this.core.isActive(session)) {
        session.status = "error";
        session.error =
          "云端任务已更新，但新的本地副本尚未保存：" +
          errorText(cause) +
          "。请重试保存或刷新资料库。";
        this.core.remember(session);
        this.core.publish(session);
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
    if (!this.core.io.reconcileOrganizationJobs)
      throw new Error("当前云端尚未支持后台整理，请完成数据库迁移后重试。");
    const userId = session.user.id;
    await this.core.io.reconcileOrganizationJobs(userId, signal);
    const remote = await this.core.io.loadCloud(userId);
    if (!remote.data) throw new Error("云端资料库暂不可用，无法核对后台整理状态。请稍后重试。");
    if (
      !this.core.isActive(session) ||
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
    this.core.remember(session);
    this.core.publish(session);
    try {
      await this.core.persist(session);
    } catch (cause) {
      if (this.core.isActive(session)) {
        session.status = "error";
        session.error =
          "云端已更新后台整理结果，但新的本地副本尚未保存：" +
          errorText(cause) +
          "。请重试保存或刷新资料库。";
        this.core.remember(session);
        this.core.publish(session);
      }
      throw cause;
    }
  }

  private async enqueueDurableOrganization(
    request: DurableOrganizationRequest,
    signal: AbortSignal | undefined,
    token: number,
  ): Promise<void> {
    const session = this.core.active;
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
    const session = this.core.active;
    if (!session?.ready || !session.user || session.token !== token)
      throw new Error("当前账号已改变，请重新打开整理。");
    this.core.assertWorkspaceWritable(session);
    if (!this.core.io.enqueueOrganizationJob)
      throw new Error("当前云端尚未支持后台整理，请完成数据库迁移后重试。");
    const snapshot = session.data;
    const revision = session.revision;
    const result = await this.core.io.enqueueOrganizationJob(
      request,
      revision,
      session.user.id,
      signal,
    );
    if (!this.core.isActive(session) || session.token !== token)
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

  recoverOrganizationJobs(session: Session) {
    if (!this.core.isActive(session) || !session.ready || this.core.writesBlocked(session)) return;
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
    if (!this.core.isActive(pending.session))
      return new Error("账号已改变，整理已停止。本次结果不会写入当前账号。");
    if (!pending.session.ready)
      return new Error("资料正在更新，本次整理已停止。请基于当前资料重新生成。");
    if (this.core.isCloudReadOnly(pending.session)) return new Error(this.core.readOnlyMessage());
    if (this.core.hasNewerLocalUpdate(pending.session) || pending.session.loadingLocalUpdate)
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
    this.core.update(
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
    const session = this.core.active;
    if (!session?.ready || session.token !== token)
      throw new Error("当前账号已改变，请重新打开整理。");
    this.core.assertWorkspaceWritable(session);
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
    const session = this.core.active;
    if (session && this.core.isCloudReadOnly(session)) throw new Error(this.core.readOnlyMessage());
    if (
      session?.token === token &&
      session.data.organizationJobs?.some((job) => job.id === request.requestId)
    )
      return;
    await this.runOrganization(request, signal, token);
  }

  async checkOrganization(jobId: string, token: number): Promise<void> {
    const session = this.core.active;
    const job = session?.data.organizationJobs?.find((item) => item.id === jobId);
    if (!session || session.token !== token || !job)
      throw new Error("整理记录不可用，请重新打开。");
    this.core.assertWorkspaceWritable(session);
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
    const session = this.core.active;
    const job = session?.data.organizationJobs?.find((item) => item.id === jobId);
    if (!session || session.token !== token || !job)
      throw new Error("整理记录不可用，请重新打开。");
    this.core.assertWorkspaceWritable(session);
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
    const session = this.core.active;
    if (!session || session.token !== token) return;
    return this.trackCloudOperation(session, () => this.runStopOrganization(jobId, token));
  }

  private async runStopOrganization(jobId: string, token: number): Promise<void> {
    const session = this.core.active;
    if (!session || session.token !== token) return;
    this.core.assertWorkspaceWritable(session);
    const job = session.data.organizationJobs?.find((item) => item.id === jobId);
    if (job && keepsRunningAfterBrowserExit(job)) {
      if (!session.ready || !session.user)
        throw new Error("请先登录并载入云端资料，再停止后台整理任务。");
      if (!this.core.io.cancelOrganizationJob)
        throw new Error("当前云端尚未支持后台整理，请完成数据库迁移后重试。");
      const snapshot = session.data;
      const revision = session.revision;
      const result = await this.core.io.cancelOrganizationJob(job.id, revision, session.user.id);
      if (!this.core.isActive(session) || session.token !== token)
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
    const session = this.core.active;
    if (!session?.ready || session.token !== token || !session.user)
      throw new Error("请先登录云端账号，再整理资料。");
    this.core.assertWorkspaceWritable(session);
    if (signal?.aborted) throw new DOMException("整理已停止", "AbortError");
    const localDevelopmentPageRun =
      isDurableOrganizationRequest(request) &&
      this.core.capabilities.durableOrganizationProcessorEnabled === false &&
      this.core.capabilities.localDevelopmentOrganizationRunnerEnabled === true &&
      isLocalDevelopmentOrganizationRunnerEnabled(
        localDevelopmentOrganizationRunnerStateFromEnvironment(),
      );
    if (
      isDurableOrganizationRequest(request) &&
      this.core.capabilities.durableOrganizationProcessorEnabled === false &&
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
    if (this.core.aiBusy(token))
      throw new Error("已有 AI 问答或整理正在执行，请等待完成或先停止。");
    if (!existing && (session.data.organizationJobs?.length ?? 0) >= 1000)
      throw new Error("整理记录已达当前上限，暂不能新增任务。已保存建议仍可查看和导出。");
    if (
      isDurableOrganizationRequest(request) &&
      !localDevelopmentPageRun &&
      this.core.io.enqueueOrganizationJob
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
        await this.core.persist(session);
      } catch (cause) {
        if (this.core.isActive(session)) {
          session.status = "error";
          session.error =
            "整理记录尚未保存到此浏览器：" + errorText(cause) + "。请重试保存或导出后再离开。";
          this.core.publish(session);
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
        this.core.update(
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
      const model = await this.core.io.getModelStatus(session.user!.id, pending.controller.signal);
      current();
      if (model.mode !== "model")
        throw new Error(model.message || "尚未配置生成模型，无法整理资料。");
      this.changeOrganizationJob(session, request.requestId, { status: "running" });
      await persistJob();
      current();
      const result = organizationResultSchema.parse(
        await this.core.io.organizeCloud(
          pending.request,
          pending.controller.signal,
          session.user!.id,
        ),
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
      if (this.core.isActive(session)) {
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
      this.core.publish(session);
    }
  }
}
