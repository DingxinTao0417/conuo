"use client";

import { useMemo, useState } from "react";
import {
  BookOpen,
  Check,
  ChevronDown,
  FileText,
  FolderOpen,
  Info,
  LoaderCircle,
  LockKeyhole,
  RotateCcw,
  Sparkles,
  Square,
  Tag,
  UnlockKeyhole,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Citation, Source, WorkspaceData } from "@/lib/types";
import type { OrganizationJob, OrganizationPage } from "@/lib/organization-types";
import { organizationReviewReason } from "@/lib/organization";
import {
  isLocalDevelopmentOrganizationRunnerEnabled,
  isOrganizationProcessorEnabled,
  localDevelopmentOrganizationRunnerAvailabilityMessage,
  localDevelopmentOrganizationRunnerStateFromEnvironment,
  organizationProcessorAvailabilityMessage,
  type OrganizationProcessorState,
} from "@/lib/organization-processor-capability";
import { sourceCoverageLabel } from "@/lib/source-coverage";
import "./organization.css";

export interface OrganizationPanelProps {
  data: WorkspaceData;
  spaceId: string;
  initialSourceIds?: string[];
  status: { ready: boolean; message: string; running: boolean };
  /** A build declaration, never a confirmation that a worker is currently healthy. */
  durableProcessorState?: OrganizationProcessorState;
  onRefreshStatus?: () => void;
  onSpaceChange: (id: string) => void;
  onGenerate: (input: {
    kind: "source" | "knowledge";
    spaceId: string;
    sourceIds: string[];
    topic?: string;
  }) => Promise<void>;
  onStop: (jobId: string) => Promise<void>;
  onRetry: (jobId: string) => Promise<void>;
  onCheck: (jobId: string) => Promise<void>;
  onApplyTags: (jobId: string, labels: string[]) => void;
  onUndoTags: (jobId: string) => void;
  onSavePage: (jobId: string, index: number, status: "draft" | "accepted") => void;
  onIgnorePage: (jobId: string, index: number) => void;
  onDismiss: (jobId: string) => void;
  onOpenNote: (noteId: string) => void;
  onOpenCitation: (citation: Citation) => void;
  onLockTags: (sourceId: string, locked: boolean) => void;
}

interface SourceBatchResult {
  attempted: number;
  succeeded: Array<{ sourceId: string; title: string }>;
  failed: Array<{ sourceId: string; title: string; message: string }>;
}

const jobLabels: Record<OrganizationJob["status"], string> = {
  queued: "等待整理",
  running: "正在生成",
  ready: "待查看",
  failed: "未完成",
  cancelled: "已停止",
  dismissed: "已收起",
};

function unavailableReason(source: Source): string {
  if (!source.aiAllowed) return "未允许 AI 使用";
  if (source.status === "saved" || source.status === "parsing") return "等待解析完成";
  if (source.status === "failed") return "解析未完成";
  if (source.status === "link-only") return "仅保存链接，没有可分析正文";
  if (!source.text.trim() || !source.chunks.length) return "没有可分析正文";
  return "";
}

function Markdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
        img: ({ alt }) => <span>[图片{alt ? `：${alt}` : ""}]</span>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function Citations({
  citations,
  onOpen,
}: {
  citations: Citation[];
  onOpen: (citation: Citation) => void;
}) {
  if (!citations.length) return null;
  return (
    <div className="organization-citations" aria-label="原文依据">
      {citations.map((citation, index) => (
        <button
          className="organization-citation"
          key={`${citation.sourceId}-${citation.chunkId}-${index}`}
          type="button"
          onClick={() => onOpen(citation)}
          title={`${citation.title}${citation.page ? ` · 第 ${citation.page} 页` : ""} · ${citation.section}`}
        >
          <span>{index + 1}</span>
          <span>{citation.title}</span>
          {citation.page && <small>p.{citation.page}</small>}
        </button>
      ))}
    </div>
  );
}

function PageCard({
  page,
  index,
  job,
  blocked,
  pending,
  onSave,
  onIgnore,
  onOpenNote,
  onOpenCitation,
}: {
  page: OrganizationPage;
  index: number;
  job: OrganizationJob;
  blocked: boolean;
  pending: boolean;
  onSave: (status: "draft" | "accepted") => void;
  onIgnore: () => void;
  onOpenNote: (id: string) => void;
  onOpenCitation: (citation: Citation) => void;
}) {
  const saved = job.savedPages?.find((item) => item.index === index);
  const ignored = job.ignoredPages?.includes(index);
  return (
    <article className={`organization-page${ignored ? " organization-page-ignored" : ""}`}>
      <div className="organization-page-heading">
        <span className="organization-page-icon">
          <BookOpen size={17} />
        </span>
        <h4>{page.title}</h4>
        {saved && (
          <span className="organization-badge organization-badge-success">
            <Check size={12} />
            已保存
          </span>
        )}
        {ignored && <span className="organization-badge">已忽略</span>}
      </div>
      <div className="organization-markdown">
        <Markdown content={page.content} />
      </div>
      <Citations citations={page.citations} onOpen={onOpenCitation} />
      <div className="organization-page-actions">
        {saved ? (
          <button className="btn" type="button" onClick={() => onOpenNote(saved.noteId)}>
            打开知识页
          </button>
        ) : ignored ? (
          <span className="organization-subtle">此主题未加入知识页。</span>
        ) : (
          <>
            <button
              className="btn btn-primary"
              type="button"
              disabled={blocked || pending}
              onClick={() => onSave("accepted")}
            >
              <Check size={14} />
              接受主题
            </button>
            <button
              className="btn"
              type="button"
              disabled={blocked || pending}
              onClick={() => onSave("draft")}
            >
              编辑为草稿
            </button>
            <button
              className="organization-text-button"
              type="button"
              disabled={blocked || pending}
              onClick={onIgnore}
            >
              忽略主题
            </button>
          </>
        )}
      </div>
    </article>
  );
}

function SuggestionCard({
  job,
  data,
  pending,
  run,
  onApplyTags,
  onUndoTags,
  onSavePage,
  onIgnorePage,
  onDismiss,
  onOpenNote,
  onOpenCitation,
  onLockTags,
}: Pick<
  OrganizationPanelProps,
  | "data"
  | "onApplyTags"
  | "onUndoTags"
  | "onSavePage"
  | "onIgnorePage"
  | "onDismiss"
  | "onOpenNote"
  | "onOpenCitation"
  | "onLockTags"
> & { job: OrganizationJob; pending: boolean; run: (action: () => void | Promise<void>) => void }) {
  const [chosenLabels, setChosenLabels] = useState<string[]>([]);
  const result = job.result;
  if (!result || (result.kind !== "source" && result.kind !== "knowledge")) return null;
  const reason = organizationReviewReason(data, job);
  const source = data.sources.find(
    (item) => item.id === job.request.sourceIds[0] && !item.deletedAt,
  );
  const locked = Boolean(source?.tagsLocked);
  const blocked = Boolean(reason);
  const isSource = result.kind === "source";
  const liveLabels = isSource
    ? result.tags.filter((item) => !source?.tags.includes(item.label))
    : [];
  const chosen = chosenLabels.filter((label) => liveLabels.some((item) => item.label === label));
  const tagsChanged = Boolean(
    job.appliedTags &&
    (job.appliedTags.revision === undefined ||
      (source?.tagsRevision ?? 0) !== job.appliedTags.revision ||
      JSON.stringify(source?.tags) !== JSON.stringify(job.appliedTags.after)),
  );
  const pages = isSource ? [result.summary] : result.pages;
  return (
    <section
      className="organization-result-card"
      aria-label={isSource ? `资料建议：${source?.title || result.summary.title}` : "知识主题草稿"}
    >
      <header className="organization-result-heading">
        <span className="organization-result-icon">
          {isSource ? <FileText size={18} /> : <Sparkles size={18} />}
        </span>
        <div>
          <h3>
            {isSource ? source?.title || result.summary.title : job.request.topic || "知识主题草稿"}
          </h3>
          <p>
            {isSource
              ? "摘要与归类建议"
              : `${job.request.sourceIds.length} 份资料 · ${pages.length} 个主题`}
            <span> · AI 生成，待你核对</span>
          </p>
        </div>
        <button
          className="icon-btn"
          type="button"
          disabled={pending}
          aria-label="收起这次整理结果"
          title="保留已应用标签和已保存知识页，收起这次整理结果"
          onClick={() => run(() => onDismiss(job.id))}
        >
          <X size={16} />
        </button>
      </header>
      {reason && (
        <p className="organization-warning" role="status">
          <Info size={15} />
          {reason}
        </p>
      )}
      {isSource && (
        <div className="organization-source-suggestions">
          <div className="organization-summary">
            <h4>内容摘要</h4>
            <div className="organization-markdown">
              <Markdown content={result.summary.content} />
            </div>
            <Citations citations={result.summary.citations} onOpen={onOpenCitation} />
          </div>
          <div className="organization-label-heading">
            <h4>
              <Tag size={14} />
              标签建议
            </h4>
            {source && (
              <button
                className="organization-text-button"
                type="button"
                disabled={pending}
                onClick={() => run(() => onLockTags(source.id, !locked))}
              >
                {locked ? <LockKeyhole size={13} /> : <UnlockKeyhole size={13} />}
                {locked ? "取消固定标签" : "固定现有标签"}
              </button>
            )}
          </div>
          {source?.tags.length ? (
            <p className="organization-subtle">现有标签：{source.tags.join(" · ")}</p>
          ) : (
            <p className="organization-subtle">当前资料还没有标签。</p>
          )}
          {result.tags.length ? (
            <div className="organization-tag-options">
              {result.tags.map((item, index) => {
                const existing = Boolean(source?.tags.includes(item.label));
                return (
                  <div className="organization-tag-option" key={`${item.label}-${index}`}>
                    <label>
                      <input
                        type="checkbox"
                        checked={existing || chosen.includes(item.label)}
                        disabled={
                          existing || locked || blocked || pending || Boolean(job.appliedTags)
                        }
                        onChange={(event) =>
                          setChosenLabels((labels) =>
                            event.target.checked
                              ? [...labels, item.label]
                              : labels.filter((label) => label !== item.label),
                          )
                        }
                      />
                      <span>{item.label}</span>
                      {existing && <small>已有</small>}
                    </label>
                    <details>
                      <summary>
                        依据
                        <ChevronDown size={12} />
                      </summary>
                      <Citations citations={item.citations} onOpen={onOpenCitation} />
                    </details>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="organization-subtle">本次没有建议新增标签。</p>
          )}
          {locked && (
            <p className="organization-inline-note">
              <LockKeyhole size={13} />
              标签已固定，当前不能追加或撤回建议标签。
            </p>
          )}
          <div className="organization-tag-actions">
            {job.appliedTags ? (
              <>
                <span className="organization-applied">
                  <Check size={14} />
                  已追加 {job.appliedTags.added.length} 个标签
                </span>
                <button
                  className="btn"
                  type="button"
                  disabled={pending || blocked || locked || tagsChanged}
                  onClick={() => run(() => onUndoTags(job.id))}
                >
                  <RotateCcw size={13} />
                  撤回本次追加
                </button>
                {tagsChanged && (
                  <span className="organization-subtle">
                    {job.appliedTags.revision === undefined
                      ? "无法核对这次标签变更，请手动管理标签。"
                      : "标签后来有修改，保留当前内容。"}
                  </span>
                )}
              </>
            ) : (
              <button
                className="btn"
                type="button"
                disabled={pending || blocked || locked || !chosen.length}
                onClick={() => run(() => onApplyTags(job.id, chosen))}
              >
                追加所选标签{chosen.length ? `（${chosen.length}）` : ""}
              </button>
            )}
          </div>
          <div className="organization-topics">
            <h4>主题建议</h4>
            {result.topics.length ? (
              result.topics.map((item, index) => (
                <details key={`${item.label}-${index}`}>
                  <summary>
                    {item.label}
                    <ChevronDown size={12} />
                  </summary>
                  <Citations citations={item.citations} onOpen={onOpenCitation} />
                </details>
              ))
            ) : (
              <span className="organization-subtle">本次没有主题建议。</span>
            )}
            <p className="organization-subtle">主题供你归类参考，不会移动资料。</p>
          </div>
        </div>
      )}
      {!isSource && (
        <div className="organization-pages">
          {pages.map((page, index) => (
            <PageCard
              key={index}
              page={page}
              index={index}
              job={job}
              pending={pending}
              blocked={blocked}
              onSave={(next) => run(() => onSavePage(job.id, index, next))}
              onIgnore={() => run(() => onIgnorePage(job.id, index))}
              onOpenNote={onOpenNote}
              onOpenCitation={onOpenCitation}
            />
          ))}
        </div>
      )}
      <footer className="organization-result-footer">
        <Info size={13} />
        <p>{result.coverage}</p>
      </footer>
    </section>
  );
}

export default function OrganizationPanel(props: OrganizationPanelProps) {
  const {
    data,
    spaceId,
    initialSourceIds = [],
    status,
    durableProcessorState = "not-deployed",
    onSpaceChange,
    onGenerate,
    onStop,
    onRetry,
    onCheck,
  } = props;
  const durableProcessorEnabled = isOrganizationProcessorEnabled(durableProcessorState);
  const localDevelopmentRunnerEnabled =
    !durableProcessorEnabled &&
    isLocalDevelopmentOrganizationRunnerEnabled(
      localDevelopmentOrganizationRunnerStateFromEnvironment(),
    );
  const sourceKnowledgeExecutionEnabled = durableProcessorEnabled || localDevelopmentRunnerEnabled;
  const [selectedIds, setSelectedIds] = useState<string[]>([...initialSourceIds]);
  const [topic, setTopic] = useState("");
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [sourceBatchResult, setSourceBatchResult] = useState<SourceBatchResult | null>(null);
  const [tab, setTab] = useState<"all" | "source" | "knowledge">("all");
  const sources = useMemo(
    () =>
      data.sources.filter(
        (source) =>
          !source.deletedAt &&
          (spaceId === "inbox" ? !source.spaceIds.length : source.spaceIds.includes(spaceId)),
      ),
    [data.sources, spaceId],
  );
  const eligible = sources.filter((source) => !unavailableReason(source));
  const unavailableSelected = selectedIds.flatMap((id) => {
    const source = data.sources.find((item) => item.id === id);
    const reason =
      !source || source.deletedAt
        ? "资料已删除或无法访问"
        : spaceId !== "all" && !sources.some((item) => item.id === id)
          ? "资料已移出当前知识库"
          : unavailableReason(source);
    return reason
      ? [
          {
            id,
            title: source?.title || "已不可用资料",
            reason,
            visible: sources.some((item) => item.id === id),
          },
        ]
      : [];
  });
  const invisibleSelectedCount = unavailableSelected.filter((item) => !item.visible).length;
  const duplicateSelectedCount = selectedIds.length - new Set(selectedIds).size;
  const selectionBlocked =
    selectedIds.length > 10 || unavailableSelected.length > 0 || duplicateSelectedCount > 0;
  const visibleSources = sources.filter((source) =>
    `${source.title} ${source.tags.join(" ")}`
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );
  const jobs = (data.organizationJobs || [])
    .filter(
      (job) =>
        (job.request.kind === "source" || job.request.kind === "knowledge") &&
        job.status !== "dismissed" &&
        (spaceId === "all" || job.request.spaceId === spaceId),
    )
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const filteredJobs = jobs.filter((job) => tab === "all" || job.request.kind === tab);
  const isAvailableSpace =
    spaceId === "inbox" || data.spaces.some((space) => space.id === spaceId && !space.archived);
  const canGenerate =
    isAvailableSpace &&
    sourceKnowledgeExecutionEnabled &&
    status.ready &&
    data.aiEnabled &&
    !status.running &&
    !pending &&
    !selectionBlocked;
  const activeJobs = jobs.filter((job) => job.status === "running" || job.status === "queued");
  const disabledReason = !sourceKnowledgeExecutionEnabled
    ? organizationProcessorAvailabilityMessage(durableProcessorState)
    : !data.aiEnabled
      ? "请先在设置中开启 AI。"
      : !status.ready
        ? status.message
        : !isAvailableSpace
          ? "先选择要整理的知识库。"
          : "";
  const displayedStatusMessage =
    localDevelopmentRunnerEnabled && status.ready
      ? localDevelopmentOrganizationRunnerAvailabilityMessage()
      : status.message;

  async function run(action: () => void | Promise<void>) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作未完成，请稍后重试。");
    } finally {
      setPending(false);
    }
  }
  function generateKnowledge() {
    if (!canGenerate || !selectedIds.length) return;
    void run(() =>
      onGenerate({
        kind: "knowledge",
        spaceId,
        sourceIds: [...selectedIds],
        ...(topic.trim() ? { topic: topic.trim() } : {}),
      }),
    );
  }

  function generateSources() {
    if (!canGenerate || !selectedIds.length) return;
    const targets = selectedIds.map((sourceId) => ({
      sourceId,
      title: data.sources.find((source) => source.id === sourceId)?.title || "已不可用资料",
    }));
    setSourceBatchResult(null);
    void run(async () => {
      const succeeded: SourceBatchResult["succeeded"] = [];
      const failed: SourceBatchResult["failed"] = [];
      for (const target of targets) {
        try {
          // The server contract intentionally keeps each source analysis isolated.
          // A batch is coordinated here so one failure does not hide later outcomes.
          await onGenerate({ kind: "source", spaceId, sourceIds: [target.sourceId] });
          succeeded.push(target);
        } catch (cause) {
          failed.push({
            ...target,
            message: cause instanceof Error ? cause.message : "整理请求未完成。",
          });
        }
      }
      setSourceBatchResult({ attempted: targets.length, succeeded, failed });
    });
  }
  function stop(jobId: string) {
    void run(() => onStop(jobId));
  }

  return (
    <section className="organization-panel" aria-labelledby="organization-title">
      <header className="organization-heading">
        <div>
          <div className="organization-eyebrow">
            <Sparkles size={15} />
            AI 学习助手
          </div>
          <h2 id="organization-title">从资料生成</h2>
          <p>从资料中提炼线索，由你决定哪些成为知识。</p>
        </div>
        <label className="organization-space-picker">
          <FolderOpen size={15} />
          <select
            aria-label="选择要整理的知识库"
            value={spaceId}
            disabled={pending}
            onChange={(event) => onSpaceChange(event.target.value)}
          >
            <option value="all">选择知识库</option>
            {data.spaces
              .filter((space) => !space.archived)
              .map((space) => (
                <option key={space.id} value={space.id}>
                  {space.name}
                </option>
              ))}
            <option value="inbox">收件箱</option>
          </select>
          <ChevronDown size={13} />
        </label>
      </header>
      {/* Automatic organization is a workspace setting, not part of this flow;
          it lives in 设置 · AI 与资料处理 so there is one place to turn it on. */}
      <p
        className={`organization-auto-setting${
          durableProcessorEnabled ? "" : " organization-auto-setting--waiting"
        }`}
      >
        {durableProcessorEnabled
          ? "与问答共用每日模型次数。任务是否在关闭页面后继续，取决于已部署的后台处理器；可刷新状态核对。"
          : localDevelopmentRunnerEnabled
            ? localDevelopmentOrganizationRunnerAvailabilityMessage()
            : "已有任务记录仍可刷新、查看或停止；当前不能承诺 source／knowledge 任务在关闭页面后继续。"}
      </p>
      {(disabledReason || displayedStatusMessage) && (
        <p
          className={`organization-status${disabledReason ? " organization-status-muted" : ""}`}
          role="status"
        >
          <Info size={15} />
          <span>{disabledReason || displayedStatusMessage}</span>
          {props.onRefreshStatus && (
            <button
              type="button"
              className="organization-text-button"
              disabled={pending || status.running}
              onClick={props.onRefreshStatus}
            >
              <RotateCcw size={12} />
              重新检查
            </button>
          )}
        </p>
      )}
      {error && (
        <div className="organization-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭操作错误提示"
            onClick={() => setError("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      <div className="organization-compose">
        <div className="organization-compose-heading">
          <h3>选择资料</h3>
          <span>已选 {selectedIds.length} / 10 份</span>
        </div>
        {selectionBlocked && (
          <div className="organization-selection-warning" role="alert">
            <Info size={15} />
            <div>
              {selectedIds.length > 10 && (
                <p>已选 {selectedIds.length} 份资料，超过单次 10 份上限。</p>
              )}
              {duplicateSelectedCount > 0 && (
                <p>当前选择有 {duplicateSelectedCount} 个重复项，请重新选择。</p>
              )}
              {unavailableSelected.length > 0 && (
                <>
                  <p>已选资料中有 {unavailableSelected.length} 份不可用。</p>
                  {invisibleSelectedCount > 0 && (
                    <p>
                      {invisibleSelectedCount}{" "}
                      份已删除、无法访问或移出当前知识库，不能显示在下方资料列表中。
                    </p>
                  )}
                  <ul>
                    {unavailableSelected.map((item, index) => (
                      <li key={`${item.id}-${index}`}>
                        <strong>{item.title}</strong>：{item.reason}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <p>请取消不需要的勾选、清空或明确重新选择后生成。本次不会自动缩小资料范围。</p>
            </div>
          </div>
        )}
        {isAvailableSpace ? (
          <>
            <div className="organization-source-tools">
              <input
                aria-label="搜索待整理资料"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索资料名称或标签"
              />
              <button
                className="organization-text-button"
                type="button"
                disabled={pending || !eligible.length}
                onClick={() => {
                  setSelectedIds(eligible.slice(0, 10).map((source) => source.id));
                  setSourceBatchResult(null);
                }}
              >
                选择前 {Math.min(eligible.length, 10)} 份
              </button>
              <button
                className="organization-text-button"
                type="button"
                disabled={pending || !selectedIds.length}
                onClick={() => {
                  setSelectedIds([]);
                  setSourceBatchResult(null);
                }}
              >
                清空
              </button>
            </div>
            {visibleSources.length ? (
              <div
                className={`organization-source-list${
                  visibleSources.length === 1 ? " organization-source-list--single" : ""
                }`}
              >
                {visibleSources.map((source) => {
                  const reason = unavailableReason(source);
                  const checked = selectedIds.includes(source.id);
                  return (
                    <label
                      className={`organization-source-row${checked ? " organization-source-selected" : ""}`}
                      key={source.id}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={
                          pending || (!checked && (Boolean(reason) || selectedIds.length >= 10))
                        }
                        onChange={(event) => {
                          setSelectedIds((ids) =>
                            event.target.checked
                              ? [...ids, source.id]
                              : ids.filter((id) => id !== source.id),
                          );
                          setSourceBatchResult(null);
                        }}
                      />
                      <FileText size={17} />
                      <span className="organization-source-copy">
                        <strong>{source.title}</strong>
                        <small>
                          {reason ||
                            `${source.kind.toUpperCase()}${sourceCoverageLabel(source) ? ` · ${sourceCoverageLabel(source)}` : " · 可分析"}`}
                        </small>
                      </span>
                      {source.tagsLocked && <LockKeyhole size={13} aria-label="标签已固定" />}
                    </label>
                  );
                })}
              </div>
            ) : (
              <div className="organization-small-empty">
                <FileText size={24} />
                <p>{search.trim() ? "没有找到匹配资料" : "这个知识库还没有资料"}</p>
                <span>
                  {search.trim() ? "换个关键词试试。" : "先导入文件或网页正文，再回来整理。"}
                </span>
              </div>
            )}
            {selectedIds.length === 10 && !selectionBlocked && (
              <p className="organization-subtle">每次最多选择 10 份；可分批生成主题草稿。</p>
            )}
            <label className="organization-topic-input">
              <span>
                想围绕什么主题整理？<small>选填</small>
              </span>
              <input
                value={topic}
                maxLength={200}
                disabled={pending}
                placeholder="例如：梯度下降的核心概念与常见误区"
                onChange={(event) => setTopic(event.target.value)}
              />
            </label>
            <div className="organization-generate-actions">
              <button
                className="btn btn-primary"
                type="button"
                disabled={!canGenerate || !selectedIds.length}
                onClick={generateKnowledge}
              >
                <Sparkles size={15} />
                生成主题草稿
              </button>
              <button
                className="btn"
                type="button"
                disabled={!canGenerate || !selectedIds.length}
                onClick={generateSources}
              >
                {selectedIds.length > 1 ? `分析所选资料（${selectedIds.length}）` : "分析这份资料"}
              </button>
            </div>
            <p className="organization-generate-help">
              {durableProcessorEnabled
                ? "单份分析生成摘要和归类建议；主题草稿可综合多份资料。"
                : localDevelopmentRunnerEnabled
                  ? "本地开发页面运行：仅在当前页面内手动执行，离开页面会停止；不会自动排队。"
                  : "后台整理等待部署后启用；当前不会创建新的资料分析或主题草稿任务。"}
            </p>
            {sourceBatchResult && (
              <section
                className={`organization-batch-result${sourceBatchResult.failed.length ? " organization-batch-result-partial" : ""}`}
                role="status"
                aria-label="批量资料分析结果"
              >
                <div className="organization-batch-summary">
                  {sourceBatchResult.failed.length ? <Info size={15} /> : <Check size={15} />}
                  <div>
                    <strong>
                      已提交 {sourceBatchResult.succeeded.length} / {sourceBatchResult.attempted}{" "}
                      份资料
                    </strong>
                    <p>每份资料保持独立请求；可在下方逐项查看摘要、标签和原文依据。</p>
                  </div>
                </div>
                <ul>
                  {sourceBatchResult.succeeded.map((item) => (
                    <li key={item.sourceId}>
                      <span className="organization-batch-mark organization-batch-mark-success">
                        <Check size={12} />
                        已提交
                      </span>
                      <span>{item.title}</span>
                    </li>
                  ))}
                  {sourceBatchResult.failed.map((item) => (
                    <li key={item.sourceId}>
                      <span className="organization-batch-mark organization-batch-mark-error">
                        <X size={12} />
                        未提交
                      </span>
                      <span>
                        {item.title}
                        <small>{item.message}</small>
                      </span>
                    </li>
                  ))}
                </ul>
                {sourceBatchResult.failed.length > 0 && (
                  <button
                    className="organization-text-button"
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setSelectedIds(sourceBatchResult.failed.map((item) => item.sourceId));
                      setSourceBatchResult(null);
                    }}
                  >
                    仅保留未提交项
                  </button>
                )}
              </section>
            )}
          </>
        ) : (
          <div className="organization-small-empty">
            <FolderOpen size={24} />
            <p>先选择一个知识库或收件箱</p>
            <span>每次整理只使用你选定范围内的资料。</span>
          </div>
        )}
      </div>
      {activeJobs.length > 0 && (
        <div className="organization-queue" aria-label="整理任务">
          <div>
            <LoaderCircle
              size={16}
              className={
                (status.running && durableProcessorEnabled) ||
                (localDevelopmentRunnerEnabled && activeJobs.some((job) => !job.durable))
                  ? "organization-spinner"
                  : ""
              }
            />
            <strong>
              {!durableProcessorEnabled && activeJobs.some((job) => job.durable)
                ? "有等待后台部署的整理任务"
                : status.running
                  ? "正在处理整理任务"
                  : "有未完成的整理任务"}
            </strong>
            <span>{activeJobs.length} 项</span>
          </div>
          <p>
            {activeJobs.some((job) => job.durable)
              ? durableProcessorEnabled
                ? "任务已提交云端队列；是否已被处理器领取或在关闭页面后继续，请刷新状态核对。停止会保留任务记录，已发生的模型调用可能仍计次。"
                : "当前构建未声明后台处理器已启用，不能承诺这些任务会在关闭页面后继续。可刷新状态核对结果，或停止仍处于等待状态的任务。"
              : localDevelopmentRunnerEnabled
                ? "本地开发页面任务只在当前页面存活时执行；刷新、关闭或离开页面会停止请求。已发生的模型调用可能仍计次。"
                : "完成后会出现在下方。停止会保留任务记录，已发生的模型调用可能仍计次。"}
          </p>
          {activeJobs.map((job) => (
            <div className="organization-queue-item" key={job.id}>
              <span>
                {job.request.kind === "source"
                  ? data.sources.find((source) => source.id === job.request.sourceIds[0])?.title ||
                    "资料分析"
                  : job.request.topic || "主题草稿"}
              </span>
              <small>{jobLabels[job.status]}</small>
              <button className="btn" type="button" disabled={pending} onClick={() => stop(job.id)}>
                <Square size={12} />
                停止
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="organization-review-heading">
        <div>
          <h3>整理结果</h3>
          <p>逐项核对后保存。草稿不会用于回答，目前问答只参考你导入的原始资料。</p>
        </div>
        <div className="organization-filters" role="group" aria-label="筛选整理结果">
          {(
            [
              ["all", "全部"],
              ["source", "资料建议"],
              ["knowledge", "主题草稿"],
            ] as const
          ).map(([value, label]) => (
            <button
              type="button"
              key={value}
              aria-pressed={tab === value}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="organization-results">
        {filteredJobs.length ? (
          filteredJobs.map((job) =>
            job.status === "ready" && job.result ? (
              <SuggestionCard
                key={job.id}
                {...props}
                job={job}
                pending={pending}
                run={(action) => void run(action)}
              />
            ) : (
              <article className="organization-job-card" key={job.id}>
                <div className="organization-job-heading">
                  <span className="organization-result-icon">
                    {job.request.kind === "source" ? (
                      <FileText size={17} />
                    ) : (
                      <Sparkles size={17} />
                    )}
                  </span>
                  <div>
                    <h3>
                      {job.request.kind === "source"
                        ? data.sources.find((source) => source.id === job.request.sourceIds[0])
                            ?.title || "资料分析"
                        : job.request.topic || "知识主题草稿"}
                    </h3>
                    <p>
                      {job.request.sourceIds.length} 份资料 ·{" "}
                      {job.request.trigger === "automatic" ? "自动分析" : "手动生成"}
                    </p>
                  </div>
                  <span className="organization-badge">{jobLabels[job.status]}</span>
                </div>
                {job.error && <p className="organization-job-error">{job.error}</p>}
                <div className="organization-job-actions">
                  <button
                    className="btn"
                    type="button"
                    disabled={
                      pending ||
                      status.running ||
                      !status.ready ||
                      !data.aiEnabled ||
                      job.restoredFromBackup ||
                      (job.durable && !["queued", "running"].includes(job.status))
                    }
                    onClick={() => void run(() => onCheck(job.id))}
                  >
                    {job.durable ? "刷新任务状态" : "继续原请求"}
                  </button>
                  <button
                    className="btn"
                    type="button"
                    disabled={
                      pending ||
                      !durableProcessorEnabled ||
                      status.running ||
                      !status.ready ||
                      !data.aiEnabled
                    }
                    onClick={() => void run(() => onRetry(job.id))}
                  >
                    <RotateCcw size={13} />
                    重新生成
                  </button>
                  <button
                    className="organization-text-button"
                    type="button"
                    disabled={pending || job.status === "running"}
                    onClick={() => void run(() => props.onDismiss(job.id))}
                  >
                    收起记录
                  </button>
                </div>
                <p className="organization-subtle">
                  {job.restoredFromBackup
                    ? "这是备份中的任务记录，无法继续原工作区请求。重新生成会按当前资料创建新任务并使用模型次数。"
                    : job.durable
                      ? durableProcessorEnabled
                        ? "这项任务已提交云端队列。后台处理器是否已领取、或关闭页面后是否继续，请刷新状态核对；重新生成会创建新任务并再次使用模型次数。"
                        : "这是一项已存在的云端任务记录。当前构建未声明后台处理器已启用，不能承诺关闭页面后继续；可刷新状态查看已发布结果，或在后台部署后重新生成。"
                      : "继续原请求会检查执行状态，可能调用模型或恢复已有结果；重新生成会再次使用模型次数。"}
                </p>
              </article>
            ),
          )
        ) : (
          <div className="organization-empty">
            <span>
              <Sparkles size={25} />
            </span>
            <h3>从一个想学懂的主题开始</h3>
            <p>
              选择资料生成草稿，或开启自动分析。
              <br />
              你确认的标签和知识页会保留下来。
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
