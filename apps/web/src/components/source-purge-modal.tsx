"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { SourcePurgePreview } from "@/lib/cloud";
import type { PermanentSourceDeletionSelection } from "@/lib/permanent-deletion";
import type { Source } from "@/lib/types";
import Modal from "./modal";
import "./source-purge-modal.css";

export interface SourcePurgeModalProps {
  source: Source;
  onClose: () => void;
  onPreview: (
    selection?: PermanentSourceDeletionSelection,
    signal?: AbortSignal,
  ) => Promise<SourcePurgePreview>;
  onPurge: (preview: SourcePurgePreview) => Promise<void>;
  reviewKey: string;
  contextKey: string;
}

interface ReviewIdentity {
  sourceId: string;
  versionId: string;
  reviewKey: string;
  contextKey: string;
}

interface ReviewState {
  identity: ReviewIdentity;
  observedIdentity: ReviewIdentity;
  invalidated: boolean;
  preview: SourcePurgePreview | null;
  selection: PermanentSourceDeletionSelection;
  checking: boolean;
  error: string;
  confirmation: string;
  resetNotice: boolean;
}

function identity(props: SourcePurgeModalProps): ReviewIdentity {
  return {
    sourceId: props.source.id,
    versionId: props.source.versionId,
    reviewKey: props.reviewKey,
    contextKey: props.contextKey,
  };
}

function sameContext(left: ReviewIdentity, right: ReviewIdentity): boolean {
  return (
    left.sourceId === right.sourceId &&
    left.versionId === right.versionId &&
    left.contextKey === right.contextKey
  );
}

function sameReview(left: ReviewIdentity, right: ReviewIdentity): boolean {
  return sameContext(left, right) && left.reviewKey === right.reviewKey;
}

function emptySelection(): PermanentSourceDeletionSelection {
  return { noteIds: [], conversationIds: [] };
}

function sameSelection(
  left: PermanentSourceDeletionSelection,
  right: PermanentSourceDeletionSelection,
): boolean {
  return (["noteIds", "conversationIds"] as const).every(
    (key) => JSON.stringify([...left[key]].sort()) === JSON.stringify([...right[key]].sort()),
  );
}

export default function SourcePurgeModal(props: SourcePurgeModalProps) {
  const { source, reviewKey, contextKey } = props;
  const latest = useRef(props);
  const mounted = useRef(false);
  const request = useRef<{
    sequence: number;
    controller: AbortController;
    identity: ReviewIdentity;
  } | null>(null);
  const sequence = useRef(0);
  const reviewed = useRef<{ preview: SourcePurgePreview; identity: ReviewIdentity } | null>(null);
  const selected = useRef(emptySelection());
  const typedName = useRef("");
  const deleting = useRef<{ identity: ReviewIdentity; invalidated: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<ReviewState>(() => ({
    identity: identity(props),
    observedIdentity: identity(props),
    invalidated: false,
    preview: null,
    selection: emptySelection(),
    checking: true,
    error: "",
    confirmation: "",
    resetNotice: false,
  }));

  useLayoutEffect(() => {
    latest.current = props;
    const current = identity(props);
    if (request.current && !sameReview(request.current.identity, current)) {
      request.current.controller.abort();
      request.current = null;
      sequence.current += 1;
    }
    if (reviewed.current && !sameReview(reviewed.current.identity, current)) {
      reviewed.current = null;
      typedName.current = "";
    }
    if (deleting.current && !sameReview(deleting.current.identity, current)) {
      deleting.current.invalidated = true;
    }
  });

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.controller.abort();
      request.current = null;
      reviewed.current = null;
      sequence.current += 1;
    };
  }, []);

  const loadPreview = useCallback(
    async (selection?: PermanentSourceDeletionSelection, resetNotice = false) => {
      if (!mounted.current || deleting.current) return;
      const current = latest.current;
      const captured = identity(current);
      const desired = selection
        ? { noteIds: [...selection.noteIds], conversationIds: [...selection.conversationIds] }
        : emptySelection();
      request.current?.controller.abort();
      const pending = {
        sequence: ++sequence.current,
        controller: new AbortController(),
        identity: captured,
      };
      request.current = pending;
      reviewed.current = null;
      selected.current = desired;
      typedName.current = "";
      setState((previous) => ({
        identity: captured,
        observedIdentity: captured,
        invalidated: false,
        preview: sameContext(previous.identity, captured) ? previous.preview : null,
        selection: desired,
        checking: true,
        error: "",
        confirmation: "",
        resetNotice,
      }));
      const isCurrent = () =>
        mounted.current &&
        request.current === pending &&
        sequence.current === pending.sequence &&
        !pending.controller.signal.aborted &&
        sameReview(captured, identity(latest.current));
      try {
        const preview = await current.onPreview(
          selection === undefined ? undefined : desired,
          pending.controller.signal,
        );
        if (!isCurrent()) return;
        if (
          preview.impact.source.id !== captured.sourceId ||
          (preview.contentSelection
            ? !sameSelection(preview.contentSelection.selection, desired)
            : desired.noteIds.length > 0 || desired.conversationIds.length > 0)
        ) {
          throw new Error("云端返回的选择与本次核对不一致，请重新核对后再确认。");
        }
        reviewed.current = { preview, identity: captured };
        request.current = null;
        setState({
          identity: captured,
          observedIdentity: captured,
          invalidated: false,
          preview,
          selection: desired,
          checking: false,
          error: "",
          confirmation: "",
          resetNotice,
        });
      } catch (cause) {
        if (!isCurrent()) return;
        request.current = null;
        setState((previous) => ({
          ...previous,
          checking: false,
          error:
            cause instanceof Error ? cause.message : "无法读取彻底删除的影响范围，请稍后重试。",
          confirmation: "",
        }));
      }
    },
    [],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void loadPreview(), 0);
    return () => window.clearTimeout(timer);
  }, [loadPreview]);

  const currentIdentity = {
    sourceId: source.id,
    versionId: source.versionId,
    reviewKey,
    contextKey,
  };
  if (!sameReview(state.observedIdentity, currentIdentity)) {
    // A changed identity remains unreviewed even if the user changes it back.
    // This guarded state adjustment prevents the old confirmation from painting.
    setState({ ...state, observedIdentity: currentIdentity, invalidated: true, confirmation: "" });
  }
  const ownContext = sameContext(state.identity, currentIdentity);
  const stale = state.invalidated || !sameReview(state.identity, currentIdentity);
  const checking = ownContext && !stale && state.checking;
  const preview = ownContext ? state.preview : null;
  const impact = !stale && !checking && !state.error ? preview?.impact : undefined;
  const content = preview?.contentSelection;
  const blocked =
    !!preview &&
    (preview.blockers.annotations.length > 0 || preview.blockers.conceptRelations.length > 0);
  const valid = !!preview && !stale && !checking && !state.error && !blocked;
  const confirmation = stale ? "" : state.confirmation;

  function close() {
    if (!deleting.current) latest.current.onClose();
  }

  function changeSelection(
    key: keyof PermanentSourceDeletionSelection,
    id: string,
    checked: boolean,
  ) {
    if (busy || stale || !content || deleting.current) return;
    const previous = selected.current;
    const next = {
      ...previous,
      [key]: checked
        ? [...new Set([...previous[key], id])]
        : previous[key].filter((value) => value !== id),
    };
    void loadPreview(next);
  }

  async function submit() {
    const accepted = reviewed.current;
    const current = latest.current;
    if (
      deleting.current ||
      request.current ||
      !accepted ||
      !sameReview(accepted.identity, identity(current)) ||
      typedName.current.trim() !== current.source.title ||
      accepted.preview.blockers.annotations.length ||
      accepted.preview.blockers.conceptRelations.length
    )
      return;
    const operation = { identity: accepted.identity, invalidated: false };
    deleting.current = operation;
    setBusy(true);
    setState((previous) => ({ ...previous, error: "" }));
    try {
      await current.onPurge(accepted.preview);
    } catch (cause) {
      if (
        mounted.current &&
        !operation.invalidated &&
        sameReview(accepted.identity, identity(latest.current))
      ) {
        reviewed.current = null;
        typedName.current = "";
        setState((previous) => ({
          ...previous,
          error: cause instanceof Error ? cause.message : "彻底删除未完成，请重新核对后重试。",
          confirmation: "",
        }));
      }
    } finally {
      if (deleting.current === operation) {
        deleting.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  }

  return (
    <Modal
      title={`彻底删除「${source.title}」？`}
      onClose={close}
      wide
      dismissible={!busy}
      className="source-purge-dialog"
    >
      <div className="modal-body source-purge-modal">
        <p className="source-purge-intro">
          此操作不可撤销。系统会删除此资料的原文件、全部历史版本、解析内容和检索索引。独立笔记、知识页与对话默认保留，只有明确勾选的整篇内容才会一并删除。
        </p>
        {stale && (
          <div className="notice notice-warning source-purge-error" role="alert">
            <span>
              相关资料或账号上下文已变化，原预览失效，请重新核对。重新核对会清空勾选，默认保留全部笔记与对话。
            </span>
          </div>
        )}
        {ownContext && state.error && (
          <div className="notice notice-warning source-purge-error" role="alert">
            <span>{state.error} 重新核对会清空勾选，默认保留全部笔记与对话。</span>
          </div>
        )}
        {(stale || (ownContext && state.error)) && (
          <button
            className="btn source-purge-refresh"
            disabled={busy}
            onClick={() => void loadPreview(undefined, true)}
          >
            重新核对
          </button>
        )}
        {checking && (
          <div className="source-purge-loading" role="status">
            <Loader2 size={17} className="spin" /> 正在从云端核对删除范围…
          </div>
        )}
        {!stale && state.resetNotice && (
          <p className="source-purge-reset" role="status">
            已重置为全部保留，请重新勾选需要删除的内容并确认资料名称。
          </p>
        )}
        {preview && (
          <>
            {content ? (
              <section className="source-purge-content" aria-label="选择一并删除的独立内容">
                <h3>选择要一并删除的内容</h3>
                <p>
                  勾选会删除整篇笔记或知识页及其全部历史，或删除整个对话及全部消息；正文可能同时包含其他资料。未勾选内容会保留，历史回答中的引用摘录文字仍可能存在，不表示已查找或抹除所有副本。
                </p>
                <fieldset disabled={busy || stale}>
                  <legend>笔记与知识页</legend>
                  {content.notes.length ? (
                    content.notes.map((note) => (
                      <label className="source-purge-candidate" key={note.id}>
                        <input
                          type="checkbox"
                          aria-label={`一并删除${note.kind === "knowledge" ? "知识页" : "笔记"}「${note.title}」`}
                          checked={state.selection.noteIds.includes(note.id)}
                          onChange={(event) =>
                            changeSelection("noteIds", note.id, event.target.checked)
                          }
                        />
                        <span>
                          <b>{note.title}</b>
                          <small>
                            {note.kind === "knowledge" ? "知识页" : "笔记"} · 当前及历史共{" "}
                            {note.versions} 个版本
                          </small>
                        </span>
                      </label>
                    ))
                  ) : (
                    <p className="muted">没有可选的关联笔记或知识页。</p>
                  )}
                </fieldset>
                <fieldset disabled={busy || stale}>
                  <legend>对话</legend>
                  {content.conversations.length ? (
                    content.conversations.map((conversation) => (
                      <label className="source-purge-candidate" key={conversation.id}>
                        <input
                          type="checkbox"
                          aria-label={`一并删除对话「${conversation.title}」`}
                          checked={state.selection.conversationIds.includes(conversation.id)}
                          onChange={(event) =>
                            changeSelection(
                              "conversationIds",
                              conversation.id,
                              event.target.checked,
                            )
                          }
                        />
                        <span>
                          <b>{conversation.title}</b>
                          <small>整段对话 · {conversation.messages} 条消息</small>
                        </span>
                      </label>
                    ))
                  ) : (
                    <p className="muted">没有可选的关联对话。</p>
                  )}
                </fieldset>
              </section>
            ) : (
              <p className="notice source-purge-legacy">
                当前云端尚未提供独立内容选择清理。此处只能默认保留全部笔记、知识页和对话，再删除资料；不会代替你选择删除正文。
              </p>
            )}
            {impact && (
              <section className="source-purge-impact" aria-label="彻底删除影响预览">
                <h3>将立即移除</h3>
                <ul>
                  <li>
                    {impact.versions} 个资料版本记录；{impact.cloudOriginals} 个云端原件进入清理队列
                  </li>
                  {(impact.removedNotes ?? 0) > 0 && (
                    <li>
                      {impact.removedNotes} 篇已选笔记或知识页，含当前与历史共{" "}
                      {impact.removedNoteVersions ?? 0} 个版本
                    </li>
                  )}
                  {(impact.removedConversations ?? 0) > 0 && (
                    <li>
                      {impact.removedConversations} 个已选完整对话，含 {impact.removedMessages ?? 0}{" "}
                      条消息
                    </li>
                  )}
                  {impact.annotations > 0 && <li>{impact.annotations} 条无正文批注</li>}
                  {impact.importJobs > 0 && <li>{impact.importJobs} 条导入或索引记录</li>}
                  {impact.organizationJobs > 0 && (
                    <li>
                      {impact.organizationJobs} 条 AI 整理记录
                      {impact.pendingOrganizationJobs > 0
                        ? `（其中 ${impact.pendingOrganizationJobs} 条尚未完成）`
                        : ""}
                    </li>
                  )}
                  {impact.conceptRelations > 0 && <li>{impact.conceptRelations} 条 AI 生成关系</li>}
                </ul>
                <h3>将保留你的正文</h3>
                <ul>
                  {impact.retainedNotes > 0 && (
                    <li>
                      {impact.retainedNotes} 篇未选笔记或知识页会保留，移除{" "}
                      {impact.retainedNoteCitations} 个来源引用
                    </li>
                  )}
                  {impact.retainedConversations > 0 && (
                    <li>
                      {impact.retainedConversations} 个未选对话会保留，移除{" "}
                      {impact.retainedConversationCitations} 个来源引用；回答与冻结摘录文字仍保留
                    </li>
                  )}
                  {!impact.retainedNotes && !impact.retainedConversations && (
                    <li>没有需要保留的关联正文</li>
                  )}
                </ul>
              </section>
            )}
            {!stale && blocked && (
              <div className="notice notice-warning source-purge-blockers" role="alert">
                <span>
                  还有 {preview.blockers.annotations.length} 条带正文的批注和{" "}
                  {preview.blockers.conceptRelations.length}{" "}
                  条手工关系。请先将批注另存为独立笔记，或明确删除这些手工内容；系统不会静默丢弃它们。
                </span>
              </div>
            )}
            <p className="muted source-purge-cleanup">
              删除确认后，云端原件会进入后台清理队列，提交成功不表示原件已经清理完毕。本机原件只会在确认没有任何工作区仍引用时清理。
            </p>
            {!blocked && (
              <label className="source-purge-confirmation">
                输入资料名称 <b>{source.title}</b> 以确认
                <input
                  className="field"
                  aria-label="输入资料名称以确认彻底删除"
                  value={confirmation}
                  onChange={(event) => {
                    typedName.current = event.target.value;
                    setState((previous) => ({ ...previous, confirmation: event.target.value }));
                  }}
                  autoComplete="off"
                  disabled={busy || !valid}
                />
              </label>
            )}
          </>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={close} disabled={busy}>
            取消
          </button>
          <button
            className="btn btn-danger"
            disabled={busy || !valid || confirmation.trim() !== source.title}
            onClick={() => void submit()}
          >
            {busy ? "正在彻底删除…" : "彻底删除资料"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
