"use client";

import { useId, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Clipboard,
  FileClock,
  FilePlus2,
  Highlighter,
  LoaderCircle,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import "./recoverable-drafts-panel.css";

export type RecoverableDraftKind = "annotation" | "note" | "text";

export interface RecoverableDraftItem {
  id: string;
  sourceId: string;
  title: string;
  content: string;
  sourceTitle: string;
  sourceDeletedAt: string;
  updatedAt: string;
  kind?: RecoverableDraftKind;
  excerpt?: string;
  location?: string;
}

export interface RecoverableDraftsPanelProps {
  drafts: readonly RecoverableDraftItem[];
  onRestoreSource: (draft: RecoverableDraftItem) => void | Promise<void>;
  onSaveAsNote: (draft: RecoverableDraftItem) => void | Promise<void>;
  onDiscard: (draft: RecoverableDraftItem) => void | Promise<void>;
  onCopy?: (text: string, draft: RecoverableDraftItem) => void | Promise<void>;
  disabled?: boolean;
  /** Allows selection and copying while preventing workspace mutations. */
  readOnly?: boolean;
}

type DraftAction = "copy" | "restore" | "save" | "discard";

const kindLabels: Record<RecoverableDraftKind, string> = {
  annotation: "批注草稿",
  note: "笔记草稿",
  text: "文字草稿",
};

function KindIcon({ kind }: { kind: RecoverableDraftKind }) {
  if (kind === "annotation") return <Highlighter size={16} />;
  if (kind === "note") return <StickyNote size={16} />;
  return <FileClock size={16} />;
}

function formatUpdatedAt(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "更新时间待同步";
  return parsed.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function defaultCopyText(text: string) {
  if (!navigator.clipboard?.writeText)
    throw new Error("当前浏览器不支持自动复制，请手动选择文字。");
  return navigator.clipboard.writeText(text);
}

export default function RecoverableDraftsPanel({
  drafts,
  onRestoreSource,
  onSaveAsNote,
  onDiscard,
  onCopy = defaultCopyText,
  disabled = false,
  readOnly = false,
}: RecoverableDraftsPanelProps) {
  const headingId = useId();
  const previewId = useId();
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(drafts[0]?.id ?? null);
  const [confirmDiscardId, setConfirmDiscardId] = useState<string | null>(null);
  const [expandedDraftId, setExpandedDraftId] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; action: DraftAction } | null>(null);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const actionLock = useRef(false);
  const selectedDraft = drafts.find((draft) => draft.id === selectedDraftId) ?? drafts[0] ?? null;
  const selectedKind = selectedDraft?.kind ?? "text";
  const contentIsLong = Boolean(
    selectedDraft &&
    (selectedDraft.content.length > 280 || selectedDraft.content.split(/\r?\n/u).length > 7),
  );
  const contentExpanded = selectedDraft?.id === expandedDraftId;
  const busy = Boolean(pending);

  function selectDraft(id: string) {
    if (busy) return;
    setSelectedDraftId(id);
    setConfirmDiscardId(null);
    setExpandedDraftId(null);
    setFeedback("");
    setError("");
  }

  async function runAction(
    draft: RecoverableDraftItem,
    action: DraftAction,
    work: () => void | Promise<void>,
    success: string,
  ) {
    if (actionLock.current || disabled || (readOnly && action !== "copy")) return;
    actionLock.current = true;
    setPending({ id: draft.id, action });
    setFeedback("");
    setError("");
    try {
      await work();
      setFeedback(success);
      if (action === "discard") setConfirmDiscardId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作未完成，请稍后重试。");
    } finally {
      actionLock.current = false;
      setPending(null);
    }
  }

  return (
    <section className="recoverable-drafts" aria-labelledby={headingId} aria-busy={busy}>
      <header className="recoverable-drafts__heading">
        <div className="recoverable-drafts__heading-icon" aria-hidden="true">
          <FileClock size={19} />
        </div>
        <div>
          <div className="recoverable-drafts__title-row">
            <h2 id={headingId}>可恢复草稿</h2>
            {drafts.length > 0 && (
              <span className="recoverable-drafts__count" aria-label={`${drafts.length} 份草稿`}>
                {drafts.length}
              </span>
            )}
          </div>
          <p>资料在其他设备被删除时，离线新增的文字会留在这里，供你单独取回。</p>
        </div>
      </header>

      {drafts.length === 0 ? (
        <div className="recoverable-drafts__empty" role="status">
          <span aria-hidden="true">
            <Check size={20} />
          </span>
          <div>
            <h3>没有待处理的草稿</h3>
            <p>跨设备冲突中保留下来的文字会显示在这里。</p>
          </div>
        </div>
      ) : (
        <div className="recoverable-drafts__layout">
          <div className="recoverable-drafts__list-pane">
            <div className="recoverable-drafts__list-heading">
              <h3>待处理</h3>
              <span>选择一份查看完整文字</span>
            </div>
            <ul className="recoverable-drafts__list" aria-label="可恢复草稿列表">
              {drafts.map((draft) => {
                const selected = draft.id === selectedDraft.id;
                const kind = draft.kind ?? "text";
                return (
                  <li key={draft.id}>
                    <button
                      type="button"
                      className={`recoverable-drafts__item${selected ? " is-selected" : ""}`}
                      aria-current={selected ? "true" : undefined}
                      aria-controls={previewId}
                      disabled={disabled || busy}
                      onClick={() => selectDraft(draft.id)}
                    >
                      <span className="recoverable-drafts__item-icon" aria-hidden="true">
                        <KindIcon kind={kind} />
                      </span>
                      <span className="recoverable-drafts__item-copy">
                        <strong>{draft.title || "未命名草稿"}</strong>
                        <span>来自《{draft.sourceTitle || "原资料"}》</span>
                        <span className="recoverable-drafts__item-deleted">
                          {formatUpdatedAt(draft.sourceDeletedAt)} 移入回收站
                        </span>
                        <small>
                          {draft.excerpt?.trim()
                            ? `“${draft.excerpt.trim()}”`
                            : draft.content.trim() || "（没有相关原文摘录）"}
                        </small>
                      </span>
                      <ChevronRight className="recoverable-drafts__chevron" size={15} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {selectedDraft && (
            <article
              id={previewId}
              className="recoverable-drafts__preview"
              aria-labelledby={`${previewId}-title`}
            >
              <header className="recoverable-drafts__preview-heading">
                <span className="recoverable-drafts__kind">
                  <KindIcon kind={selectedKind} />
                  {kindLabels[selectedKind]}
                </span>
                <h3 id={`${previewId}-title`}>{selectedDraft.title || "未命名草稿"}</h3>
                <p>
                  《{selectedDraft.sourceTitle || "原资料"}》
                  {selectedDraft.location ? ` · ${selectedDraft.location}` : ""} · 草稿保留于{" "}
                  <time dateTime={selectedDraft.updatedAt}>
                    {formatUpdatedAt(selectedDraft.updatedAt)}
                  </time>
                  {" · "}资料删除于{" "}
                  <time dateTime={selectedDraft.sourceDeletedAt}>
                    {formatUpdatedAt(selectedDraft.sourceDeletedAt)}
                  </time>
                </p>
              </header>

              <div className="recoverable-drafts__protection">
                <AlertTriangle size={16} aria-hidden="true" />
                <p>
                  原资料已在另一处被删除。这份草稿不会让资料自动恢复；你可以将文字保存为独立笔记。
                </p>
              </div>

              {selectedDraft.excerpt && (
                <figure className="recoverable-drafts__excerpt">
                  <figcaption>相关原文</figcaption>
                  <blockquote>{selectedDraft.excerpt}</blockquote>
                </figure>
              )}

              <div className="recoverable-drafts__content">
                <h4>离线新增文字</h4>
                <p
                  id={`${previewId}-content`}
                  className={contentIsLong && !contentExpanded ? "is-collapsed" : undefined}
                >
                  {selectedDraft.content || "（这份草稿没有文字内容）"}
                </p>
                {contentIsLong && (
                  <button
                    type="button"
                    className="text-button recoverable-drafts__expand"
                    aria-controls={`${previewId}-content`}
                    aria-expanded={contentExpanded}
                    onClick={() => setExpandedDraftId(contentExpanded ? null : selectedDraft.id)}
                  >
                    {contentExpanded ? "收起长草稿" : "展开完整草稿"}
                  </button>
                )}
              </div>

              {(feedback || error) && (
                <div
                  className={`recoverable-drafts__message${error ? " is-error" : ""}`}
                  role={error ? "alert" : "status"}
                >
                  <span>{error || feedback}</span>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="关闭操作提示"
                    onClick={() => {
                      setFeedback("");
                      setError("");
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
              )}

              <p className="recoverable-drafts__action-note">
                “恢复整份资料”会带回原资料；另存、复制与丢弃只处理草稿，原资料仍在回收站。
              </p>

              {confirmDiscardId === selectedDraft.id ? (
                <div className="recoverable-drafts__discard-confirmation" aria-live="polite">
                  <div>
                    <strong>确认丢弃这份草稿？</strong>
                    <p>丢弃后无法从回收站恢复这段新增文字。</p>
                  </div>
                  <div className="recoverable-drafts__confirm-actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={disabled || readOnly || busy}
                      onClick={() => setConfirmDiscardId(null)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={disabled || readOnly || busy}
                      onClick={() =>
                        void runAction(
                          selectedDraft,
                          "discard",
                          () => onDiscard(selectedDraft),
                          "草稿已丢弃。",
                        )
                      }
                    >
                      {pending?.id === selectedDraft.id && pending.action === "discard" && (
                        <LoaderCircle className="recoverable-drafts__spinner" size={14} />
                      )}
                      {pending?.id === selectedDraft.id && pending.action === "discard"
                        ? "正在丢弃…"
                        : "确认丢弃"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="recoverable-drafts__actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    title="只将草稿文字另存为新笔记，原资料继续留在回收站"
                    disabled={disabled || readOnly || busy || !selectedDraft.content.trim()}
                    onClick={() =>
                      void runAction(
                        selectedDraft,
                        "save",
                        () => onSaveAsNote(selectedDraft),
                        "已保存为新笔记。",
                      )
                    }
                  >
                    {pending?.id === selectedDraft.id && pending.action === "save" ? (
                      <LoaderCircle className="recoverable-drafts__spinner" size={14} />
                    ) : (
                      <FilePlus2 size={14} />
                    )}
                    {pending?.id === selectedDraft.id && pending.action === "save"
                      ? "正在保存…"
                      : "保存为新笔记"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    title="恢复原资料及其内容，这不是只取回当前草稿"
                    disabled={disabled || readOnly || busy}
                    onClick={() =>
                      void runAction(
                        selectedDraft,
                        "restore",
                        () => onRestoreSource(selectedDraft),
                        "整份资料已恢复。",
                      )
                    }
                  >
                    {pending?.id === selectedDraft.id && pending.action === "restore" ? (
                      <LoaderCircle className="recoverable-drafts__spinner" size={14} />
                    ) : (
                      <FileClock size={14} />
                    )}
                    {pending?.id === selectedDraft.id && pending.action === "restore"
                      ? "正在恢复…"
                      : "恢复整份资料"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    title="只复制草稿文字，原资料继续留在回收站"
                    disabled={disabled || busy || !selectedDraft.content.trim()}
                    onClick={() =>
                      void runAction(
                        selectedDraft,
                        "copy",
                        () => onCopy(selectedDraft.content, selectedDraft),
                        "草稿文字已复制。",
                      )
                    }
                  >
                    {pending?.id === selectedDraft.id && pending.action === "copy" ? (
                      <LoaderCircle className="recoverable-drafts__spinner" size={14} />
                    ) : (
                      <Clipboard size={14} />
                    )}
                    {pending?.id === selectedDraft.id && pending.action === "copy"
                      ? "正在复制…"
                      : "复制文字"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger recoverable-drafts__discard"
                    title="只丢弃这份草稿，原资料继续留在回收站"
                    disabled={disabled || readOnly || busy}
                    onClick={() => {
                      setFeedback("");
                      setError("");
                      setConfirmDiscardId(selectedDraft.id);
                    }}
                  >
                    <Trash2 size={14} />
                    丢弃草稿
                  </button>
                </div>
              )}
            </article>
          )}
        </div>
      )}
    </section>
  );
}
