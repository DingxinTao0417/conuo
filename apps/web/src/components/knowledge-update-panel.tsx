"use client";

import { useMemo, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  Check,
  FileText,
  Info,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Citation, Source, WorkspaceData } from "@/lib/types";
import type { OrganizationJob, OrganizationRequest } from "@/lib/organization-types";
import { organizationUnavailableReason } from "@/lib/organization";
import {
  knowledgeBlocks,
  knowledgeUpdateReviewReason,
  snapshotKnowledgeNote,
} from "@/lib/knowledge-update";
import { renderNoteForExport } from "@/lib/note-markdown";
import { sourceCoverageLabel } from "@/lib/source-coverage";
import type { KnowledgeUpdateReviewDraft } from "@/lib/knowledge-update-review-drafts";
import type { KnowledgeUpdateDraftSaveStatus } from "@/lib/use-knowledge-update-review-drafts";
import "./organization.css";
import "./knowledge-update.css";
import KnowledgeUpdateWithdrawal from "./knowledge-update-withdrawal";
import type { KnowledgeUpdateWithdrawalSelection } from "@/lib/knowledge-update-withdrawal";

export type { KnowledgeUpdateReviewDraft } from "@/lib/knowledge-update-review-drafts";

export interface KnowledgeUpdatePanelProps {
  data: WorkspaceData;
  noteId: string;
  status: { ready: boolean; running: boolean; message: string };
  onGenerate: (input: {
    kind: "update";
    spaceId: string;
    sourceIds: string[];
    topic?: string;
    targetNoteId: string;
  }) => Promise<void>;
  onApply: (jobId: string, changes: { changeId: string; text: string }[]) => void | Promise<void>;
  onIgnore: (jobId: string, changeId: string) => void | Promise<void>;
  onRetry: (jobId: string) => Promise<void>;
  onCheck: (jobId: string) => Promise<void>;
  onStop: (jobId: string) => void;
  onDismiss: (jobId: string) => void | Promise<void>;
  onOpenCitation: (citation: Citation) => void;
  onBack: () => void;
  onRefreshStatus?: () => void | Promise<void>;
  reviewDrafts?: Readonly<Record<string, KnowledgeUpdateReviewDraft>>;
  onReviewDraftChange?: (jobId: string, draft: KnowledgeUpdateReviewDraft | null) => void;
  reviewDraftSaveStatus?: KnowledgeUpdateDraftSaveStatus;
  onRetryReviewDraftSave?: () => void;
  withdrawalContextKey?: string;
  onWithdraw?: (
    jobId: string,
    fingerprint: string,
    selections: KnowledgeUpdateWithdrawalSelection[],
  ) => Promise<void>;
}

const jobLabels: Record<OrganizationJob["status"], string> = {
  queued: "等待生成",
  running: "正在生成",
  ready: "可审核",
  failed: "未完成",
  cancelled: "已停止",
  dismissed: "已收起",
};

function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sourceReason(source: Source | undefined, spaceId: string) {
  if (!source || source.deletedAt) return "资料已删除或无法访问";
  if (spaceId === "inbox" ? source.spaceIds.length !== 0 : !source.spaceIds.includes(spaceId))
    return "资料已移出当前知识库";
  if (!source.aiAllowed) return "未允许 AI 使用";
  if (source.status === "saved" || source.status === "parsing") return "等待解析完成";
  if (source.status === "failed") return "解析未完成";
  if (source.status === "link-only") return "仅保存链接，没有可分析正文";
  if (!source.text.trim() || !source.chunks.length) return "没有可分析正文";
  return "";
}

function BeforePreview({ html }: { html: string }) {
  // The export converter sanitizes HTML and inserts one generated title; remove only that title.
  const markdown = useMemo(
    () => renderNoteForExport("原段落", html).markdown.replace(/^#[^\n]*\n+/, ""),
    [html],
  );
  return (
    <div className="organization-markdown knowledge-update-before">
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
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

function UpdateResult({
  data,
  job,
  pending,
  run,
  onApply,
  onIgnore,
  onOpenCitation,
  draft,
  onDraftChange,
}: Pick<KnowledgeUpdatePanelProps, "data" | "onApply" | "onIgnore" | "onOpenCitation"> & {
  job: OrganizationJob;
  pending: boolean;
  run: (action: () => void | Promise<void>) => void;
  draft?: KnowledgeUpdateReviewDraft;
  onDraftChange?: (draft: KnowledgeUpdateReviewDraft | null) => void;
}) {
  const [localSelected, setLocalSelected] = useState<string[]>([]);
  const [localEdits, setLocalEdits] = useState<Record<string, string>>({});
  const selected = onDraftChange ? (draft?.selectedChangeIds ?? []) : localSelected;
  const edits = onDraftChange ? (draft?.editedTexts ?? {}) : localEdits;
  const publishDraft = (selectedChangeIds: string[], editedTexts: Record<string, string>) => {
    setLocalSelected(selectedChangeIds);
    setLocalEdits(editedTexts);
    onDraftChange?.(
      selectedChangeIds.length || Object.keys(editedTexts).length
        ? { selectedChangeIds, editedTexts }
        : null,
    );
  };
  const result = job.result;
  if (!result || result.kind !== "update") return null;
  const reason = knowledgeUpdateReviewReason(data, job);
  const applied = job.updateReview?.applied || [];
  const ignored = job.updateReview?.ignored || [];
  const unresolved = result.changes.filter(
    (change) =>
      !applied.some((item) => item.changeId === change.id) && !ignored.includes(change.id),
  );
  const chosen = unresolved.filter((change) => selected.includes(change.id));
  const invalidText = chosen.some(
    (change) => change.type !== "remove" && !(edits[change.id] ?? change.after).trim(),
  );
  let blocks: ReturnType<typeof knowledgeBlocks> = [];
  try {
    blocks = knowledgeBlocks(result.target.content);
  } catch {
    // The review guard explains invalid positioning; history must remain readable.
  }
  return (
    <>
      {reason && (
        <div className="organization-warning" role="status">
          <ShieldCheck size={15} />
          <span>{reason} 请重新生成，或返回知识页核对正文。</span>
        </div>
      )}
      <div className="knowledge-update-baseline">
        <span>生成基于 {formatDate(result.target.updatedAt)} 的页面</span>
        <span>
          {applied.length} 项已应用 · {ignored.length} 项已忽略 · {unresolved.length} 项待审核
        </span>
      </div>
      {result.changes.length === 0 ? (
        <div className="organization-small-empty">
          <Check size={24} />
          <p>本次未发现需要更新的建议</p>
          <span>知识页保持原样。你可以补充资料后再次生成。</span>
        </div>
      ) : (
        <>
          <div className="knowledge-update-changes">
            {result.changes.map((change, index) => {
              const accepted = applied.find((item) => item.changeId === change.id);
              const isIgnored = ignored.includes(change.id);
              const reviewed = Boolean(accepted) || isIgnored;
              const blockIndex = blocks.findIndex((block) => block.id === change.blockId);
              const position =
                change.blockId === "start"
                  ? "页面开头"
                  : blockIndex >= 0
                    ? `第 ${blockIndex + 1} 个内容块${change.type === "insert_after" ? "之后" : ""}`
                    : "原页面指定位置";
              const typeLabel =
                change.type === "insert_after"
                  ? "补充"
                  : change.type === "replace"
                    ? "修改"
                    : "移除";
              const text = accepted?.text ?? edits[change.id] ?? change.after;
              const inputId = `knowledge-update-${job.id}-${change.id}`;
              return (
                <section
                  className={`knowledge-update-change${reviewed ? " knowledge-update-reviewed" : ""}`}
                  key={change.id}
                >
                  <div className="knowledge-update-change-heading">
                    <label htmlFor={`${inputId}-select`}>
                      <input
                        id={`${inputId}-select`}
                        type="checkbox"
                        checked={!reviewed && selected.includes(change.id)}
                        disabled={pending || Boolean(reason) || reviewed}
                        onChange={(event) =>
                          publishDraft(
                            event.target.checked
                              ? [...new Set([...selected, change.id])]
                              : selected.filter((id) => id !== change.id),
                            edits,
                          )
                        }
                      />
                      <strong>建议 {index + 1}</strong>
                    </label>
                    <span className={`knowledge-update-type knowledge-update-type-${change.type}`}>
                      {typeLabel}
                    </span>
                    <span className="knowledge-update-position">{position}</span>
                    {accepted ? (
                      <span className="organization-badge organization-badge-success">
                        <Check size={11} />
                        已应用
                      </span>
                    ) : isIgnored ? (
                      <span className="organization-badge">已忽略</span>
                    ) : (
                      <button
                        type="button"
                        className="organization-text-button"
                        disabled={pending || Boolean(reason)}
                        onClick={() =>
                          run(async () => {
                            await onIgnore(job.id, change.id);
                            const nextEdits = { ...edits };
                            delete nextEdits[change.id];
                            publishDraft(
                              selected.filter((id) => id !== change.id),
                              nextEdits,
                            );
                          })
                        }
                      >
                        忽略此项
                      </button>
                    )}
                  </div>
                  <p className="knowledge-update-reason">{change.reason}</p>
                  <div className="knowledge-update-comparison">
                    <div className="knowledge-update-column">
                      <h4>{change.type === "insert_after" ? "插入位置的原段落" : "修改前"}</h4>
                      {change.before ? (
                        <BeforePreview html={change.before} />
                      ) : (
                        <p className="knowledge-update-placeholder">在页面开头插入新段落</p>
                      )}
                    </div>
                    <div className="knowledge-update-column knowledge-update-after">
                      <label htmlFor={inputId}>
                        {accepted
                          ? "已应用的内容"
                          : change.type === "remove"
                            ? "修改后"
                            : "建议内容"}
                        {!reviewed && change.type !== "remove" && <small>可编辑纯文本</small>}
                      </label>
                      {change.type === "remove" ? (
                        <p className="knowledge-update-placeholder">
                          {accepted ? "此段落已移除" : "移除此段落"}
                        </p>
                      ) : (
                        <textarea
                          id={inputId}
                          aria-label={`建议 ${index + 1} 的修改内容`}
                          value={text}
                          readOnly={reviewed || Boolean(reason)}
                          disabled={pending}
                          maxLength={6000}
                          rows={5}
                          onChange={(event) =>
                            publishDraft(selected, { ...edits, [change.id]: event.target.value })
                          }
                        />
                      )}
                    </div>
                  </div>
                  <details className="knowledge-update-evidence">
                    <summary>查看依据 · {change.citations.length} 处原文</summary>
                    {change.citations.map((citation, citationIndex) => (
                      <div
                        className="knowledge-update-quote"
                        key={`${citation.chunkId}-${citationIndex}`}
                      >
                        <blockquote>{citation.quote}</blockquote>
                        <button
                          type="button"
                          className="organization-citation"
                          onClick={() => onOpenCitation(citation)}
                          title={`${citation.title} · ${citation.section}`}
                        >
                          <span>{citationIndex + 1}</span>
                          <span>{citation.title}</span>
                          {citation.page && <small>p.{citation.page}</small>}
                        </button>
                      </div>
                    ))}
                  </details>
                </section>
              );
            })}
          </div>
          <div className="knowledge-update-apply">
            <div>
              <strong>已选择 {chosen.length} 项修改</strong>
              <p>
                {invalidText
                  ? "请补全所选修改的内容，或取消选择空白建议。"
                  : "只修改勾选的内容块，未选中的正文原样保留。"}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending || Boolean(reason) || !chosen.length || invalidText}
              onClick={() =>
                run(async () => {
                  await onApply(
                    job.id,
                    chosen.map((change) => ({
                      changeId: change.id,
                      text: change.type === "remove" ? "" : (edits[change.id] ?? change.after),
                    })),
                  );
                  const nextEdits = { ...edits };
                  for (const change of chosen) delete nextEdits[change.id];
                  publishDraft([], nextEdits);
                })
              }
            >
              <Check size={14} />
              应用所选修改
            </button>
          </div>
        </>
      )}
      <div className="organization-result-footer">
        <Info size={14} />
        <span>{result.coverage}</span>
      </div>
    </>
  );
}

export function KnowledgeUpdatePanel({
  data,
  noteId,
  status,
  onGenerate,
  onApply,
  onIgnore,
  onRetry,
  onCheck,
  onStop,
  onDismiss,
  onOpenCitation,
  onBack,
  onRefreshStatus,
  reviewDrafts,
  onReviewDraftChange,
  reviewDraftSaveStatus,
  onRetryReviewDraftSave,
  withdrawalContextKey = "current-workspace",
  onWithdraw,
}: KnowledgeUpdatePanelProps) {
  const note = data.notes.find(
    (item) => item.id === noteId && item.kind === "knowledge" && !item.deletedAt,
  );
  const [selected, setSelected] = useState<string[]>(() => [
    ...new Set(note?.citations.map((citation) => citation.sourceId) || []),
  ]);
  const [search, setSearch] = useState("");
  const [topic, setTopic] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [showDismissed, setShowDismissed] = useState(false);
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
  if (!note)
    return (
      <div className="organization-panel knowledge-update-panel">
        <button type="button" className="organization-text-button" onClick={onBack}>
          <ArrowLeft size={14} />
          返回知识页
        </button>
        <div className="organization-empty">
          <span>
            <BookOpen size={22} />
          </span>
          <h3>这份知识页已不可用</h3>
          <p>页面可能已删除，或不再属于当前工作区。</p>
        </div>
      </div>
    );
  const spaceId = note.spaceId;
  const citedIds = [...new Set(note.citations.map((citation) => citation.sourceId))];
  const rows = [
    ...data.sources
      .filter(
        (source) =>
          !source.deletedAt &&
          (spaceId === "inbox" ? source.spaceIds.length === 0 : source.spaceIds.includes(spaceId)),
      )
      .map((source) => source.id),
    ...selected,
    ...citedIds,
  ];
  const ids = [...new Set(rows)];
  const sourceTitle = (id: string) =>
    data.sources.find((source) => source.id === id)?.title ||
    note.citations.find((citation) => citation.sourceId === id)?.title ||
    "原引用资料（已不可用）";
  const selectedProblems = selected.filter((id) =>
    sourceReason(
      data.sources.find((source) => source.id === id),
      spaceId,
    ),
  );
  const missingCited = citedIds.filter((id) => !selected.includes(id));
  const request: OrganizationRequest = {
    requestId: "knowledge-update-preview",
    kind: "update",
    trigger: "manual",
    spaceId,
    sourceIds: selected,
    sourceVersions: selected.map((sourceId) => ({
      sourceId,
      versionId: data.sources.find((source) => source.id === sourceId)?.versionId || "unavailable",
    })),
    ...(topic.trim() ? { topic: topic.trim() } : {}),
    targetNote: {
      id: note.id,
      revision: snapshotKnowledgeNote(note).revision,
      updatedAt: note.updatedAt,
    },
  };
  const generationReason = !data.aiEnabled
    ? "AI 使用已关闭，请先在设置中开启。"
    : !status.ready
      ? status.message || "云端模型服务尚未就绪。"
      : status.running
        ? "已有模型任务正在执行，请等待完成或停止后再生成。"
        : selected.length === 0
          ? "请选择 1–10 份同库资料。"
          : selected.length > 10
            ? "最多选择 10 份资料，请手动调整选集。"
            : selectedProblems.length
              ? "所选资料包含不可用项，请核对下方资料状态。"
              : missingCited.length
                ? "请保留知识页现有引用涉及的全部资料。"
                : organizationUnavailableReason(data, request);
  const dismissedCount = (data.organizationJobs || []).filter(
    (job) =>
      job.request.kind === "update" &&
      job.request.targetNote?.id === noteId &&
      job.status === "dismissed" &&
      Boolean(job.updateReview?.applied.length),
  ).length;
  const jobs = (data.organizationJobs || [])
    .filter(
      (job) =>
        job.request.kind === "update" &&
        job.request.targetNote?.id === noteId &&
        (job.status !== "dismissed" ||
          (showDismissed && Boolean(job.updateReview?.applied.length))),
    )
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const filteredIds = ids.filter(
    (id) =>
      selected.includes(id) ||
      sourceTitle(id).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <div className="organization-panel knowledge-update-panel">
      <button
        type="button"
        className="organization-text-button knowledge-update-back"
        onClick={onBack}
      >
        <ArrowLeft size={14} />
        返回知识页
      </button>
      <header className="organization-heading">
        <div>
          <span className="organization-eyebrow">
            <Sparkles size={13} />
            AI 更新建议
          </span>
          <h2>{note.title || "未命名知识页"}</h2>
          <p>
            {spaceId === "inbox"
              ? "收件箱"
              : data.spaces.find((space) => space.id === spaceId)?.name || "原知识库"}{" "}
            · 最近更新于 {formatDate(note.updatedAt)}
          </p>
        </div>
      </header>
      <div className="knowledge-update-protection">
        <ShieldCheck size={17} />
        <div>
          <strong>逐项审核，再更新知识页</strong>
          <p>
            AI
            会对照当前正文提出有原文依据的补充、修改或移除建议。段落、标题、列表和表格按完整内容块审核；建议内容支持纯文本和换行。页面或资料变化后，旧建议将停止应用。
          </p>
        </div>
      </div>
      <div
        className={`organization-status${status.ready ? "" : " organization-status-muted"}`}
        role="status"
      >
        <Info size={14} />
        <span>
          {status.message ||
            (status.ready ? "模型服务已就绪，由你主动发起生成。" : "正在读取模型服务状态。")}
        </span>
        {onRefreshStatus && (
          <button
            type="button"
            className="organization-text-button"
            disabled={pending}
            onClick={() => void run(onRefreshStatus)}
          >
            <RotateCcw size={12} />
            刷新状态
          </button>
        )}
      </div>
      {error && (
        <div className="organization-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭操作提示"
            onClick={() => setError("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <section className="organization-compose" aria-label="选择更新依据">
        <div className="organization-compose-heading">
          <h3>选择更新依据</h3>
          <span>已选 {selected.length} / 10 份</span>
        </div>
        <p className="organization-subtle knowledge-update-compose-hint">
          已默认勾选这份知识页的原引用资料，可添加同库的新资料一起对照。
        </p>
        {(selectedProblems.length > 0 || missingCited.length > 0) && (
          <div className="organization-selection-warning">
            <Info size={15} />
            <div>
              {selectedProblems.length > 0 && (
                <>
                  <p>以下选中资料暂不可用，仍保留在选集中：</p>
                  <ul>
                    {selectedProblems.map((id) => (
                      <li key={id}>
                        <strong>{sourceTitle(id)}</strong>：
                        {sourceReason(
                          data.sources.find((source) => source.id === id),
                          spaceId,
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {missingCited.length > 0 && (
                <>
                  <p>现有引用涉及的 {missingCited.length} 份资料尚未选中；生成时需要一并核对。</p>
                  <button
                    type="button"
                    className="organization-text-button"
                    disabled={pending}
                    onClick={() => setSelected((values) => [...new Set([...values, ...citedIds])])}
                  >
                    加入全部原引用资料
                  </button>
                </>
              )}
            </div>
          </div>
        )}
        <div className="organization-source-tools">
          <input
            type="search"
            aria-label="搜索同库资料"
            placeholder="搜索同库资料"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <span className="organization-subtle">已选资料始终显示</span>
        </div>
        {filteredIds.length ? (
          <div className="organization-source-list">
            {filteredIds.map((id) => {
              const source = data.sources.find((item) => item.id === id);
              const reason = sourceReason(source, spaceId);
              const checked = selected.includes(id);
              return (
                <label
                  className={`organization-source-row${checked ? " organization-source-selected" : ""}`}
                  key={id}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={pending || (!checked && (Boolean(reason) || selected.length >= 10))}
                    onChange={(event) =>
                      setSelected((values) =>
                        event.target.checked
                          ? [...values, id]
                          : values.filter((value) => value !== id),
                      )
                    }
                  />
                  <FileText size={18} />
                  <span className="organization-source-copy">
                    <strong>{sourceTitle(id)}</strong>
                    <small>
                      {reason ||
                        (source ? sourceCoverageLabel(source) || "可用于更新" : "可用于更新")}
                      {citedIds.includes(id) ? " · 原引用资料" : ""}
                    </small>
                  </span>
                </label>
              );
            })}
          </div>
        ) : (
          <div className="organization-small-empty">
            <FileText size={22} />
            <p>{search ? "没有匹配的资料" : "当前知识库还没有资料"}</p>
            <span>导入并完成文字解析后，就可以选择更新依据。</span>
          </div>
        )}
        <label className="organization-topic-input">
          <span>
            本次关注<small>选填</small>
          </span>
          <input
            value={topic}
            maxLength={200}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="例如：补充新定义，核对结论是否有变化"
          />
        </label>
        <div className="organization-generate-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending || Boolean(generationReason)}
            onClick={() =>
              void run(() =>
                onGenerate({
                  kind: "update",
                  spaceId,
                  sourceIds: [...selected],
                  ...(topic.trim() ? { topic: topic.trim() } : {}),
                  targetNoteId: noteId,
                }),
              )
            }
          >
            <Sparkles size={14} />
            生成更新建议
          </button>
          <span>
            {generationReason || "生成会使用所选资料与当前知识页；结果需要你审核后才会写入正文。"}
          </span>
        </div>
      </section>
      <div className="organization-review-heading">
        <div>
          <h3>
            更新记录 <span className="knowledge-update-count">{jobs.length}</span>
          </h3>
          <p>每次建议都绑定生成时的页面与资料版本。应用后的修改保留 AI 标记和原文依据。</p>
        </div>
        {dismissedCount > 0 && (
          <button
            type="button"
            className="btn"
            onClick={() => setShowDismissed((current) => !current)}
          >
            <RotateCcw size={13} />
            {showDismissed ? "隐藏已收起记录" : `已收起的更新（${dismissedCount}）`}
          </button>
        )}
      </div>
      {reviewDraftSaveStatus && (
        <div
          className={`knowledge-update-draft-status${reviewDraftSaveStatus.kind === "error" ? " knowledge-update-draft-error" : ""}`}
          role="status"
        >
          <Info size={14} />
          <span>{reviewDraftSaveStatus.message}</span>
          {reviewDraftSaveStatus.kind === "error" && onRetryReviewDraftSave && (
            <button
              type="button"
              className="organization-text-button"
              onClick={onRetryReviewDraftSave}
            >
              重试本机操作
            </button>
          )}
        </div>
      )}
      {jobs.length ? (
        <div className="organization-results">
          {jobs.map((job) => {
            const active = job.status === "queued" || job.status === "running";
            const result = job.result?.kind === "update" ? job.result : undefined;
            const reviewReason =
              job.status === "ready" ? knowledgeUpdateReviewReason(data, job) : "";
            const retryRequest: OrganizationRequest = {
              ...job.request,
              targetNote: request.targetNote,
              sourceVersions: job.request.sourceIds.map((sourceId) => ({
                sourceId,
                versionId:
                  data.sources.find((source) => source.id === sourceId)?.versionId || "unavailable",
              })),
            };
            const retryReason = organizationUnavailableReason(data, retryRequest);
            const modelDisabled = pending || status.running || !status.ready || !data.aiEnabled;
            return (
              <article className="organization-result-card" key={job.id}>
                <div className="organization-result-heading">
                  <span className="organization-result-icon">
                    {active ? (
                      <LoaderCircle size={18} className="organization-spinner" />
                    ) : (
                      <Sparkles size={18} />
                    )}
                  </span>
                  <div>
                    <h3>
                      {jobLabels[job.status]}
                      {result ? ` · ${result.changes.length} 项更新建议` : ""}
                    </h3>
                    <p>
                      {formatDate(job.createdAt)} · {job.request.sourceIds.length} 份资料
                      {job.request.topic ? ` · ${job.request.topic}` : ""}
                    </p>
                  </div>
                  {!active && job.status !== "dismissed" && (
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="收起这次更新记录"
                      title="收起记录，已应用的内容会保留"
                      disabled={pending}
                      onClick={() =>
                        void run(async () => {
                          await onDismiss(job.id);
                          onReviewDraftChange?.(job.id, null);
                        })
                      }
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                {(job.status === "ready" || job.status === "dismissed") && result ? (
                  <UpdateResult
                    data={data}
                    job={job}
                    pending={pending}
                    run={(action) => void run(action)}
                    onApply={onApply}
                    onIgnore={onIgnore}
                    onOpenCitation={onOpenCitation}
                    draft={reviewDrafts?.[job.id]}
                    onDraftChange={
                      onReviewDraftChange
                        ? (draft) => onReviewDraftChange(job.id, draft)
                        : undefined
                    }
                  />
                ) : (
                  <div className="knowledge-update-job-body">
                    <p>
                      {active
                        ? "生成完成后可逐项审核。停止后可检查原请求状态，或重新生成。"
                        : job.error || "这次生成尚未得到可审核结果。"}
                    </p>
                  </div>
                )}
                {onWithdraw && job.updateReview?.applied.length ? (
                  <KnowledgeUpdateWithdrawal
                    data={data}
                    job={job}
                    contextKey={withdrawalContextKey}
                    onWithdraw={onWithdraw}
                    onEditCurrent={onBack}
                  />
                ) : null}
                {(active || job.status !== "ready" || reviewReason) && (
                  <div className="knowledge-update-job-actions">
                    {active ? (
                      <button type="button" className="btn" onClick={() => onStop(job.id)}>
                        <Square size={12} />
                        停止生成
                      </button>
                    ) : null}
                    {!job.restoredFromBackup &&
                      job.status !== "queued" &&
                      job.status !== "ready" && (
                        <button
                          type="button"
                          className="btn"
                          disabled={
                            modelDisabled ||
                            Boolean(organizationUnavailableReason(data, job.request))
                          }
                          onClick={() => void run(() => onCheck(job.id))}
                        >
                          <RotateCcw size={13} />
                          检查原请求
                        </button>
                      )}
                    {!active && (
                      <button
                        type="button"
                        className="btn"
                        disabled={modelDisabled || Boolean(retryReason)}
                        onClick={() => void run(() => onRetry(job.id))}
                      >
                        <Sparkles size={13} />
                        按当前页面重新生成
                      </button>
                    )}
                    {!active && (
                      <p>
                        {job.restoredFromBackup && "这是备份中的任务记录，无法检查原工作区请求。"}
                        {retryReason ||
                          "重新生成会沿用这次的资料选集，绑定当前版本并创建新任务。也可在上方调整选集。"}
                      </p>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="organization-empty">
          <span>
            <BookOpen size={23} />
          </span>
          <h3>为这份知识页补充新的理解</h3>
          <p>
            选择资料并生成更新建议，逐项对照修改前后的内容。
            <br />
            正文会一直保留，直到你主动应用修改。
          </p>
        </div>
      )}
    </div>
  );
}

export default KnowledgeUpdatePanel;
