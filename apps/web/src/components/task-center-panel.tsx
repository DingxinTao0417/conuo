"use client";

import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Cloud,
  FileText,
  History,
  Loader2,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import type { ImportJob } from "@/lib/import-queue";
import type { OrganizationJob } from "@/lib/organization-types";
import type { OrganizationStatus } from "@/lib/organization-runner";
import {
  isLocalDevelopmentOrganizationRunnerEnabled,
  isOrganizationProcessorEnabled,
  localDevelopmentOrganizationRunnerAvailabilityMessage,
  localDevelopmentOrganizationRunnerStateFromEnvironment,
  organizationProcessorAvailabilityMessage,
  type OrganizationProcessorState,
} from "@/lib/organization-processor-capability";
import type { Source, WorkspaceData } from "@/lib/types";
import {
  workspaceSyncPresentation,
  type WorkspaceSyncPresentationInput,
} from "@/lib/workspace-sync-presentation";
import "./task-center-panel.css";

export type DurableProcessorState = OrganizationProcessorState;

export interface TaskCenterSyncState extends WorkspaceSyncPresentationInput {
  hasRecovery?: boolean;
}

export interface TaskCenterPanelProps {
  data: WorkspaceData;
  sync: TaskCenterSyncState;
  organizationStatus: OrganizationStatus;
  /**
   * This is a declaration from the current web build, not a health check. A
   * queued durable record proves the request was accepted, never that a cloud
   * processor is deployed or currently executing it.
   */
  durableProcessorState?: DurableProcessorState;
  onRetrySync?: () => void | Promise<void>;
  onResolveSync?: () => void;
  onUseRecovery?: () => void | Promise<void>;
  onRefreshOrganizationStatus?: () => void | Promise<void>;
  onRetryImport: (jobId: string) => void | Promise<void>;
  onCancelImport: (jobId: string) => void | Promise<void>;
  onRetryOrganization: (jobId: string) => void | Promise<void>;
  onCheckOrganization: (jobId: string) => void | Promise<void>;
  onStopOrganization: (jobId: string) => void | Promise<void>;
  onOpenSource: (sourceId: string) => void;
  onOpenOrganization: (spaceId: string) => void;
}

type Action = () => void | Promise<void>;

const importStatusLabels: Record<ImportJob["status"], string> = {
  queued: "等待处理",
  running: "正在处理",
  failed: "需要重试",
  cancelled: "已停止",
  completed: "已完成",
};

const importStageLabels: Record<ImportJob["stage"], string> = {
  saving: "保存原件",
  parsing: "提取正文",
  indexing: "准备检索",
};

const organizationStatusLabels: Record<OrganizationJob["status"], string> = {
  queued: "等待处理",
  running: "正在整理",
  ready: "待查看",
  failed: "需要重试",
  cancelled: "已停止",
  dismissed: "已收起",
};

const organizationKindLabels: Record<OrganizationJob["request"]["kind"], string> = {
  source: "资料分析",
  knowledge: "主题草稿",
  update: "知识页更新",
  relations: "关系建议",
};

function isActive(status: ImportJob["status"] | OrganizationJob["status"]): boolean {
  return status === "queued" || status === "running";
}

function sourceFor(data: WorkspaceData, sourceId: string): Source | undefined {
  return data.sources.find((source) => source.id === sourceId && !source.deletedAt);
}

function formatTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function organizationTitle(job: OrganizationJob, data: WorkspaceData): string {
  if (job.request.kind === "source")
    return sourceFor(data, job.request.sourceIds[0] || "")?.title || "资料分析";
  if (job.request.kind === "knowledge") return job.request.topic || "知识主题草稿";
  if (job.request.kind === "update") return job.request.targetNote?.id || "知识页更新";
  return job.request.compareNote?.id || "知识关系建议";
}

function organizationOrigin(
  job: OrganizationJob,
  durableProcessorState: DurableProcessorState,
): { label: string; description: string; pendingCloudProcessor: boolean } {
  if (!job.durable)
    return {
      label: "页面内任务",
      description:
        "这类整理只在当前页面执行。关闭页面会停止当前请求；任务记录和资料版本仍有效时，可继续原请求。",
      pendingCloudProcessor: false,
    };
  if (!isActive(job.status))
    return {
      label: "云端任务记录",
      description:
        job.status === "ready"
          ? "任务结果已写回工作区；可打开 AI 整理页查看或重新生成。"
          : "任务记录已保留；可打开 AI 整理页查看详情，并在后台处理器启用后重新生成。",
      pendingCloudProcessor: false,
    };
  if (durableProcessorState === "not-deployed")
    return {
      label: "等待后台部署",
      description:
        "这是一条已存在的云端任务记录。当前构建未声明生产处理器已启用，不能承诺关闭页面后继续；可刷新状态核对已发布结果，或停止任务。",
      pendingCloudProcessor: true,
    };
  return {
    label: "云端后台任务",
    description: "任务已提交云端队列；处理器是否已领取或完成，请刷新状态核对已发布结果。",
    pendingCloudProcessor: false,
  };
}

function EmptyTaskList({ children }: { children: string }) {
  return (
    <div className="task-center-empty">
      <Check size={18} aria-hidden="true" />
      <p>{children}</p>
    </div>
  );
}

export default function TaskCenterPanel({
  data,
  sync,
  organizationStatus,
  durableProcessorState = "not-deployed",
  onRetrySync,
  onResolveSync,
  onUseRecovery,
  onRefreshOrganizationStatus,
  onRetryImport,
  onCancelImport,
  onRetryOrganization,
  onCheckOrganization,
  onStopOrganization,
  onOpenSource,
  onOpenOrganization,
}: TaskCenterPanelProps) {
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const durableProcessorEnabled = isOrganizationProcessorEnabled(durableProcessorState);
  const localDevelopmentRunnerEnabled =
    !durableProcessorEnabled &&
    isLocalDevelopmentOrganizationRunnerEnabled(
      localDevelopmentOrganizationRunnerStateFromEnvironment(),
    );
  const importJobs = useMemo(
    () =>
      [...(data.importJobs ?? [])].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      ),
    [data.importJobs],
  );
  const organizationJobs = useMemo(
    () =>
      [...(data.organizationJobs ?? [])].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      ),
    [data.organizationJobs],
  );
  const activeImportCount = importJobs.filter((job) => isActive(job.status)).length;
  const activeOrganizationCount = organizationJobs.filter(
    (job) => isActive(job.status) && (!job.durable || durableProcessorEnabled),
  ).length;
  const localPageOrganizationRunning =
    localDevelopmentRunnerEnabled &&
    organizationJobs.some(
      (job) =>
        !job.durable &&
        isActive(job.status) &&
        (job.request.kind === "source" || job.request.kind === "knowledge"),
    );
  const organizationStatusRunning =
    (durableProcessorEnabled && organizationStatus.running) || localPageOrganizationRunning;
  const attentionCount =
    importJobs.filter((job) => job.status === "failed").length +
    organizationJobs.filter((job) => job.status === "failed").length +
    (sync.status === "error" || sync.status === "conflict" || sync.cloudReadOnly ? 1 : 0);
  const presentation = workspaceSyncPresentation(sync);

  async function run(key: string, action: Action) {
    if (pendingAction) return;
    setPendingAction(key);
    setActionError("");
    try {
      await action();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "操作未完成，请稍后重试。");
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <section className="task-center-panel" aria-labelledby="task-center-title">
      <header className="task-center-heading">
        <div>
          <span className="task-center-eyebrow">
            <History size={14} aria-hidden="true" />
            工作区任务
          </span>
          <h2 id="task-center-title">任务中心</h2>
          <p>查看资料导入、解析和 AI 整理的进度；每项都保留它实际运行的位置和可恢复操作。</p>
        </div>
        <div className="task-center-counts" aria-label="任务统计">
          <span>
            <strong>{activeImportCount + activeOrganizationCount}</strong>
            进行中
          </span>
          <span>
            <strong>{attentionCount}</strong>
            需处理
          </span>
        </div>
      </header>

      <section
        className={`task-center-sync task-center-sync-${presentation.tone}`}
        aria-label="工作区同步状态"
      >
        <span className="task-center-sync-icon" aria-hidden="true">
          {presentation.tone === "success" ? (
            <Cloud size={18} />
          ) : presentation.tone === "progress" ? (
            <Loader2 size={18} className="spin" />
          ) : presentation.tone === "neutral" ? (
            <ShieldCheck size={18} />
          ) : (
            <History size={18} />
          )}
        </span>
        <div>
          <h3>{presentation.label}</h3>
          <p>{presentation.description}</p>
        </div>
        <div className="task-center-sync-actions">
          {(sync.status === "error" || sync.cloudReadOnly) && onRetrySync && (
            <button
              className="btn"
              type="button"
              disabled={Boolean(pendingAction)}
              onClick={() => void run("sync-retry", onRetrySync)}
            >
              <RotateCcw size={14} />
              重新连接
            </button>
          )}
          {sync.status === "conflict" && onResolveSync && (
            <button
              className="btn"
              type="button"
              onClick={() => onResolveSync()}
              disabled={Boolean(pendingAction)}
            >
              处理同步问题
              <ChevronRight size={14} />
            </button>
          )}
          {sync.hasRecovery && onUseRecovery && (
            <button
              className="text-button"
              type="button"
              disabled={Boolean(pendingAction)}
              onClick={() => void run("sync-recovery", onUseRecovery)}
            >
              备份当前副本并加载云端
            </button>
          )}
        </div>
      </section>

      {actionError && (
        <div className="task-center-error" role="alert">
          <span>{actionError}</span>
          <button
            className="icon-btn"
            type="button"
            aria-label="关闭任务操作错误"
            onClick={() => setActionError("")}
          >
            <X size={15} />
          </button>
        </div>
      )}

      <div className="task-center-columns">
        <section className="task-center-group" aria-labelledby="import-tasks-title">
          <header className="task-center-group-heading">
            <div>
              <span className="task-center-group-icon task-center-group-icon-import">
                <FileText size={16} aria-hidden="true" />
              </span>
              <div>
                <h3 id="import-tasks-title">资料导入与解析</h3>
                <p>
                  {sync.storageMode === "cloud"
                    ? "原件与任务保存到云端，当前页面负责提取正文；云端确认前请保持页面打开。"
                    : "原件保存、正文提取和检索准备在此浏览器中执行，可在下次打开时恢复。"}
                </p>
              </div>
            </div>
            <span className="task-center-group-count">{importJobs.length}</span>
          </header>
          <div className="task-center-list">
            {importJobs.length ? (
              importJobs.map((job) => {
                const source = sourceFor(data, job.sourceId);
                const active = isActive(job.status);
                const retryable = job.status === "failed" || job.status === "cancelled";
                const taskKey = `import:${job.id}`;
                return (
                  <article className="task-center-card" key={job.id} data-task-kind="import">
                    <div className="task-center-card-heading">
                      <span className="task-center-card-icon task-center-card-icon-import">
                        {active ? <Loader2 size={16} className="spin" /> : <FileText size={16} />}
                      </span>
                      <div>
                        <h4>{job.filename}</h4>
                        <p>
                          此浏览器处理 · {importStageLabels[job.stage]} ·{" "}
                          {formatTime(job.updatedAt)}
                        </p>
                      </div>
                      <span className={`task-center-status task-center-status-${job.status}`}>
                        {importStatusLabels[job.status]}
                      </span>
                    </div>
                    <p className="task-center-card-copy">
                      {job.originalSaved
                        ? "原件已保留；关闭页面后可从同一资料版本继续处理。"
                        : "正在建立原件副本；完成前不会把资料显示为可检索。"}
                    </p>
                    {job.error && <p className="task-center-card-error">{job.error}</p>}
                    <div className="task-center-card-actions">
                      {active && (
                        <button
                          className="btn"
                          type="button"
                          disabled={Boolean(pendingAction)}
                          onClick={() =>
                            void run(`${taskKey}:cancel`, () => onCancelImport(job.id))
                          }
                        >
                          <Square size={12} />
                          停止
                        </button>
                      )}
                      {retryable && (
                        <button
                          className="btn"
                          type="button"
                          disabled={Boolean(pendingAction)}
                          onClick={() => void run(`${taskKey}:retry`, () => onRetryImport(job.id))}
                        >
                          <RotateCcw size={13} />
                          重新处理
                        </button>
                      )}
                      {source && (
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => onOpenSource(source.id)}
                        >
                          定位资料
                          <ArrowUpRight size={13} />
                        </button>
                      )}
                    </div>
                  </article>
                );
              })
            ) : (
              <EmptyTaskList>还没有导入或解析任务。</EmptyTaskList>
            )}
          </div>
        </section>

        <section className="task-center-group" aria-labelledby="organization-tasks-title">
          <header className="task-center-group-heading">
            <div>
              <span className="task-center-group-icon task-center-group-icon-organization">
                <Sparkles size={16} aria-hidden="true" />
              </span>
              <div>
                <h3 id="organization-tasks-title">AI 整理</h3>
                <p>
                  {durableProcessorEnabled
                    ? "资料分析和主题草稿可提交云端；知识页更新与关系建议仍跟随当前页面。"
                    : localDevelopmentRunnerEnabled
                      ? "本地开发中手动页面内整理可用；自动分析不会入队，离开页面会中止请求。"
                      : "后台整理等待部署；当前不会创建新的资料分析、主题草稿或自动任务，已有记录仍可查看和操作。"}
                </p>
              </div>
            </div>
            <span className="task-center-group-count">{organizationJobs.length}</span>
          </header>
          <div className="task-center-organization-status" role="status">
            <span className={organizationStatusRunning ? "task-center-status-spin" : ""}>
              {organizationStatusRunning ? <Loader2 size={13} /> : <Sparkles size={13} />}
            </span>
            <span>
              {durableProcessorEnabled
                ? organizationStatus.message
                : localDevelopmentRunnerEnabled
                  ? localDevelopmentOrganizationRunnerAvailabilityMessage()
                  : organizationProcessorAvailabilityMessage(durableProcessorState)}
            </span>
            {onRefreshOrganizationStatus && (
              <button
                className="text-button"
                type="button"
                disabled={Boolean(pendingAction) || organizationStatusRunning}
                onClick={() => void run("organization-status", onRefreshOrganizationStatus)}
              >
                刷新
              </button>
            )}
          </div>
          <div className="task-center-list">
            {organizationJobs.length ? (
              organizationJobs.map((job) => {
                const active = isActive(job.status);
                const retryable = job.status === "failed" || job.status === "cancelled";
                const origin = organizationOrigin(job, durableProcessorState);
                const waitingForProcessor = active && job.durable && !durableProcessorEnabled;
                const statusLabel = waitingForProcessor
                  ? "等待部署"
                  : organizationStatusLabels[job.status];
                const source =
                  job.request.kind === "source"
                    ? sourceFor(data, job.request.sourceIds[0] || "")
                    : undefined;
                const taskKey = `organization:${job.id}`;
                return (
                  <article className="task-center-card" key={job.id} data-task-kind="organization">
                    <div className="task-center-card-heading">
                      <span className="task-center-card-icon task-center-card-icon-organization">
                        {active && !waitingForProcessor ? (
                          <Loader2 size={16} className="spin" />
                        ) : (
                          <Sparkles size={16} />
                        )}
                      </span>
                      <div>
                        <h4>{organizationTitle(job, data)}</h4>
                        <p>
                          {organizationKindLabels[job.request.kind]} · {formatTime(job.updatedAt)}
                        </p>
                      </div>
                      <span
                        className={`task-center-status task-center-status-${
                          waitingForProcessor ? "waiting" : job.status
                        }`}
                      >
                        {statusLabel}
                      </span>
                    </div>
                    <div
                      className={`task-center-origin${origin.pendingCloudProcessor ? " task-center-origin-pending" : ""}`}
                    >
                      <Cloud size={13} aria-hidden="true" />
                      <span>
                        <strong>{origin.label}</strong>
                        {origin.description}
                      </span>
                    </div>
                    {job.error && <p className="task-center-card-error">{job.error}</p>}
                    <div className="task-center-card-actions">
                      {active && job.durable && (
                        <button
                          className="btn"
                          type="button"
                          disabled={Boolean(pendingAction)}
                          onClick={() =>
                            void run(`${taskKey}:check`, () => onCheckOrganization(job.id))
                          }
                        >
                          <RotateCcw size={13} />
                          刷新状态
                        </button>
                      )}
                      {active && !job.durable && (
                        <button
                          className="btn"
                          type="button"
                          disabled={Boolean(pendingAction)}
                          onClick={() =>
                            void run(`${taskKey}:check`, () => onCheckOrganization(job.id))
                          }
                        >
                          继续原请求
                        </button>
                      )}
                      {active && (
                        <button
                          className="btn"
                          type="button"
                          disabled={Boolean(pendingAction)}
                          onClick={() =>
                            void run(`${taskKey}:stop`, () => onStopOrganization(job.id))
                          }
                        >
                          <Square size={12} />
                          停止
                        </button>
                      )}
                      {retryable && (!job.durable || durableProcessorEnabled) && (
                        <button
                          className="btn"
                          type="button"
                          disabled={Boolean(pendingAction)}
                          onClick={() =>
                            void run(`${taskKey}:retry`, () => onRetryOrganization(job.id))
                          }
                        >
                          <RotateCcw size={13} />
                          重新生成
                        </button>
                      )}
                      {source ? (
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => onOpenSource(source.id)}
                        >
                          定位资料
                          <ArrowUpRight size={13} />
                        </button>
                      ) : null}
                      {(!source || !active) && (
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => onOpenOrganization(job.request.spaceId)}
                        >
                          {job.status === "ready" ? "查看整理结果" : "前往 AI 整理"}
                          <ArrowUpRight size={13} />
                        </button>
                      )}
                    </div>
                  </article>
                );
              })
            ) : (
              <EmptyTaskList>还没有 AI 整理任务。</EmptyTaskList>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
