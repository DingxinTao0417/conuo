"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  FileText,
  History,
  MessageSquare,
  Plus,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import type {
  AnswerRequest,
  AnswerResult,
  Citation,
  Conversation,
  Message,
  WorkspaceData,
} from "@/lib/types";
import { sourceCoverageLabel } from "@/lib/source-coverage";
import { priorUserQuestions } from "@/lib/answer-context";
import {
  CROSS_LIBRARY_SCOPE,
  CROSS_LIBRARY_MAX_SOURCES,
  createCrossLibraryAnswerRequest,
  crossLibrarySourceEligibility,
  crossLibrarySourceReasonLabel,
  isCrossLibraryConversation,
  resolveCrossLibraryConversation,
} from "@/lib/cross-library-ask";
import "./cross-library-ask-panel.css";

const statusLabel: Record<WorkspaceData["sources"][number]["status"], string> = {
  saved: "待解析",
  parsing: "解析中",
  ready: "可检索",
  partial: "部分可检索",
  failed: "解析失败",
  "link-only": "仅保存链接",
};
const sourceStatusLabel = (source: WorkspaceData["sources"][number]) =>
  sourceCoverageLabel(source) || statusLabel[source.status];

function currentTime() {
  return new Date().toISOString();
}

function messageTitle(question: string) {
  const normalized = question.replace(/\s+/gu, " ").trim();
  return normalized.length > 40 ? `${normalized.slice(0, 40)}…` : normalized || "跨库问题";
}

function sourceSpaces(data: WorkspaceData, sourceId: string) {
  const source = data.sources.find((item) => item.id === sourceId);
  if (!source) return "资料已不可用";
  const names = source.spaceIds.map((spaceId) => {
    const space = data.spaces.find((item) => item.id === spaceId);
    return space ? `${space.name}${space.archived ? "（已归档）" : ""}` : "已移除知识库";
  });
  return names.length ? names.join(" · ") : "未归属知识库";
}

function lockedCitation(
  citation: Citation,
  sourceVersions: readonly { sourceId: string; versionId: string }[],
) {
  return sourceVersions.some(
    (source) => source.sourceId === citation.sourceId && source.versionId === citation.versionId,
  );
}

function initialSelection(data: WorkspaceData, sourceIds: readonly string[] | undefined) {
  const selected: string[] = [];
  for (const sourceId of sourceIds ?? []) {
    if (selected.includes(sourceId)) continue;
    const source = data.sources.find((item) => item.id === sourceId);
    if (!source || !crossLibrarySourceEligibility(data, source).available) continue;
    selected.push(sourceId);
    if (selected.length === CROSS_LIBRARY_MAX_SOURCES) break;
  }
  return selected;
}

export interface CrossLibraryAskPanelProps {
  data: WorkspaceData;
  initialConversationId?: string;
  /** One-time draft copied into a newly opened cross-library question surface. */
  initialQuestion?: string;
  /** One-time candidate range; unavailable, duplicate and excess sources are ignored. */
  initialSourceIds?: readonly string[];
  /** Clears a forged or no-longer-cross-library route before it can become a new draft. */
  onInvalidInitialConversation?: () => void;
  onAsk: (request: AnswerRequest, signal: AbortSignal) => Promise<AnswerResult>;
  onConversationChange: (conversation: Conversation) => void;
  /** Keeps the browser route aligned with the active fixed-range thread. */
  onActiveConversationChange: (conversationId?: string) => void;
  /** Lets containing entry points stay inert while this panel has an in-flight answer. */
  onBusyChange?: (busy: boolean) => void;
  onOpenSource: (sourceId: string, versionId?: string, citation?: Citation) => void;
  /**
   * Switches the library list into question mode so the learner can locate the
   * sources for this range by asking, instead of scanning the list by title.
   * The results hand back into this same panel; they never send a question.
   */
  onFindSourcesByQuestion?: () => void;
  onClose: () => void;
}

/**
 * A dedicated all-library question surface. It never borrows the reader's
 * mutable scope picker: a new question must select a bounded set first, and a
 * saved thread keeps exactly the same source/version snapshots for follow-ups.
 */
export default function CrossLibraryAskPanel({
  data,
  initialConversationId,
  initialQuestion,
  initialSourceIds,
  onInvalidInitialConversation,
  onAsk,
  onConversationChange,
  onActiveConversationChange,
  onBusyChange,
  onOpenSource,
  onFindSourcesByQuestion,
  onClose,
}: CrossLibraryAskPanelProps) {
  const initialConversation = initialConversationId
    ? (data.conversations.find(
        (item) => item.id === initialConversationId && isCrossLibraryConversation(item),
      ) ?? null)
    : null;
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    initialConversation
      ? [...initialConversation.sourceIds]
      : initialConversationId
        ? []
        : initialSelection(data, initialSourceIds),
  );
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(
    () => initialConversation?.id ?? null,
  );
  const [newConversation, setNewConversation] = useState(() => !initialConversation);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [input, setInput] = useState(() =>
    initialConversation || initialConversationId ? "" : (initialQuestion ?? "").slice(0, 4000),
  );
  const [tutorMode, setTutorMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const onBusyChangeRef = useRef(onBusyChange);
  const rejectedInitialConversationId = useRef<string | null>(null);
  const appliedInitialConversationId = useRef<string | undefined>(initialConversationId);

  const history = useMemo(
    () => data.conversations.filter(isCrossLibraryConversation),
    [data.conversations],
  );
  const conversation = !newConversation
    ? (history.find((item) => item.id === selectedConversationId) ?? null)
    : null;
  const restored = conversation ? resolveCrossLibraryConversation(data, conversation) : null;
  const fixedVersions = restored?.ok ? (restored.request.sourceVersions ?? []) : [];
  const messages = conversation?.messages ?? [];
  const candidates = useMemo(
    () =>
      data.sources
        .map((source) => crossLibrarySourceEligibility(data, source))
        .sort(
          (left, right) =>
            Number(right.available) - Number(left.available) ||
            left.source.title.localeCompare(right.source.title, "zh-CN"),
        ),
    [data],
  );

  useEffect(() => {
    onBusyChangeRef.current = onBusyChange;
  }, [onBusyChange]);

  useEffect(() => {
    if (!initialConversationId || initialConversation) {
      rejectedInitialConversationId.current = null;
      return;
    }
    if (rejectedInitialConversationId.current !== initialConversationId) {
      rejectedInitialConversationId.current = initialConversationId;
      onInvalidInitialConversation?.();
    }
  }, [initialConversation, initialConversationId, onInvalidInitialConversation]);

  // Hash navigation is an external boundary: replace the local draft when the
  // requested conversation changes, without remounting an in-flight first answer.
  /* eslint-disable react-hooks/set-state-in-effect -- URL navigation deliberately resets panel state. */
  useEffect(() => {
    if (appliedInitialConversationId.current === initialConversationId) return;
    appliedInitialConversationId.current = initialConversationId;
    setHistoryOpen(false);
    setInput("");
    setTutorMode(false);
    setError("");
    if (initialConversation) {
      setSelectedConversationId(initialConversation.id);
      setSelectedIds([...initialConversation.sourceIds]);
      setNewConversation(false);
      return;
    }
    setSelectedConversationId(null);
    setSelectedIds([]);
    setNewConversation(true);
  }, [initialConversation, initialConversationId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(
    () => () => {
      controller.current?.abort(new DOMException("已离开跨库问答。", "AbortError"));
      if (busyRef.current) {
        busyRef.current = false;
        onBusyChangeRef.current?.(false);
      }
    },
    [],
  );

  function updateBusy(next: boolean) {
    busyRef.current = next;
    setBusy(next);
    onBusyChangeRef.current?.(next);
  }

  function startNewConversation() {
    if (busy) return;
    const hadActiveConversation = Boolean(conversation);
    setNewConversation(true);
    setSelectedConversationId(null);
    setSelectedIds([]);
    setHistoryOpen(false);
    setInput("");
    setTutorMode(false);
    setError("");
    if (hadActiveConversation) onActiveConversationChange();
  }

  function chooseSource(sourceId: string, available: boolean) {
    if (busy || !available || conversation) return;
    setError("");
    setSelectedIds((current) => {
      if (current.includes(sourceId)) return current.filter((item) => item !== sourceId);
      if (current.length >= CROSS_LIBRARY_MAX_SOURCES) {
        setError(`一次最多选择 ${CROSS_LIBRARY_MAX_SOURCES} 份资料，请先取消其中一份。`);
        return current;
      }
      return [...current, sourceId];
    });
  }

  async function ask() {
    const question = input.trim();
    if (!question || busy) return;
    let request: AnswerRequest;
    try {
      if (conversation) {
        if (!restored?.ok) throw restored?.error ?? new Error("这条跨库会话不可继续提问。");
        request = {
          ...restored.request,
          question,
          requestId: crypto.randomUUID(),
          userContext: priorUserQuestions(conversation.messages),
        };
      } else {
        request = createCrossLibraryAnswerRequest(data, {
          question,
          requestId: crypto.randomUUID(),
          sourceIds: selectedIds,
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "请重新确认跨库资料范围。");
      return;
    }

    const now = currentTime();
    const thread: Conversation = conversation ?? {
      id: crypto.randomUUID(),
      spaceId: "all",
      title: messageTitle(question),
      scope: CROSS_LIBRARY_SCOPE,
      sourceIds: [...request.sourceIds],
      messages: [],
      resolved: false,
      updatedAt: now,
    };
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: question,
      citations: [],
      createdAt: now,
    };
    const next = {
      ...thread,
      sourceIds: [...request.sourceIds],
      messages: [...thread.messages, userMessage],
      updatedAt: now,
    };
    const scopeSnapshot = {
      scope: request.scope,
      sourceIds: [...request.sourceIds],
      sourceVersions: request.sourceVersions?.map((item) => ({ ...item })),
      spaceId: request.spaceId,
      ...(request.userContext?.length ? { userContext: [...request.userContext] } : {}),
    };
    const attempt = {
      id: request.requestId!,
      questionMessageId: userMessage.id,
      scopeSnapshot,
      status: "completed" as const,
    };
    onConversationChange(next);
    if (!conversation) onActiveConversationChange(thread.id);
    setSelectedConversationId(thread.id);
    setSelectedIds([...request.sourceIds]);
    setNewConversation(false);
    setInput("");
    setError("");
    updateBusy(true);
    const signal = new AbortController();
    controller.current = signal;
    try {
      const answer = await onAsk(
        {
          ...request,
          conversationId: thread.id,
          ...(tutorMode ? { mode: "tutor" as const } : {}),
        },
        signal.signal,
      );
      if (controller.current !== signal) return;
      if (signal.signal.aborted) {
        throw signal.signal.reason instanceof Error
          ? signal.signal.reason
          : new DOMException("回答已停止。", "AbortError");
      }
      const completed: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: answer.content,
        citations: answer.citations,
        ...(answer.noteEvidence?.length ? { noteEvidence: answer.noteEvidence } : {}),
        mode: answer.mode,
        attempt,
        createdAt: currentTime(),
      };
      onConversationChange({
        ...next,
        messages: [...next.messages, completed],
        updatedAt: completed.createdAt,
      });
    } catch (cause) {
      if (controller.current !== signal) return;
      const message = cause instanceof Error ? cause.message : "暂时无法回答，请稍后重试。";
      const failed: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        citations: [],
        error: message,
        attempt: { ...attempt, status: signal.signal.aborted ? "stopped" : "failed" },
        createdAt: currentTime(),
      };
      onConversationChange({
        ...next,
        messages: [...next.messages, failed],
        updatedAt: failed.createdAt,
      });
      setError(message);
    } finally {
      if (controller.current === signal) {
        controller.current = null;
        if (busyRef.current) updateBusy(false);
      }
    }
  }

  const editable = !conversation;
  const unavailable = restored && !restored.ok ? restored.error.message : "";
  const canAsk = Boolean(
    data.aiEnabled &&
    !busy &&
    input.trim() &&
    (conversation ? restored?.ok : selectedIds.length > 0),
  );

  return (
    <section className="cross-library-ask" aria-label="问 AI · 全部资料库">
      <header className="cross-library-ask-header">
        <div>
          <span className="cross-library-ask-kicker">
            <Sparkles size={15} aria-hidden="true" />
            全部资料库
          </span>
          <h2>问 AI</h2>
          <p>
            明确选择 1 至 5 份资料后提问。回答只使用下方锁定的资料与版本，不会扩大到其他知识库。
          </p>
        </div>
        <div className="cross-library-ask-header-actions">
          <button
            type="button"
            className="btn"
            aria-label="跨库问答历史"
            aria-expanded={historyOpen}
            disabled={busy}
            onClick={() => setHistoryOpen((value) => !value)}
          >
            <History size={15} aria-hidden="true" />
            历史
          </button>
          <button type="button" className="btn" disabled={busy} onClick={startNewConversation}>
            <Plus size={15} aria-hidden="true" />
            新建
          </button>
          <button type="button" className="icon-btn" aria-label="关闭跨库问答" onClick={onClose}>
            <X size={17} aria-hidden="true" />
          </button>
        </div>
      </header>

      {historyOpen && (
        <div className="cross-library-ask-history">
          <h3>跨库问答历史</h3>
          {history.length ? (
            history.map((item) => (
              <button
                type="button"
                className={item.id === conversation?.id ? "active" : ""}
                key={item.id}
                disabled={busy}
                onClick={() => {
                  setSelectedConversationId(item.id);
                  setSelectedIds([...item.sourceIds]);
                  setNewConversation(false);
                  setHistoryOpen(false);
                  setError("");
                  if (item.id !== conversation?.id) onActiveConversationChange(item.id);
                }}
              >
                <MessageSquare size={15} aria-hidden="true" />
                <span>{item.title}</span>
                <small>{item.sourceIds.length} 份资料</small>
              </button>
            ))
          ) : (
            <p>发送第一个跨库问题后，会在这里保留固定资料范围与问答记录。</p>
          )}
        </div>
      )}

      <div className="cross-library-ask-body">
        <section
          className="cross-library-source-picker"
          aria-labelledby="cross-library-source-title"
        >
          <div className="cross-library-source-heading">
            <div>
              <h3 id="cross-library-source-title">选择资料</h3>
              <p>
                {conversation
                  ? `此会话固定使用 ${conversation.sourceIds.length} 份资料的保存版本。`
                  : `已选择 ${selectedIds.length} / ${CROSS_LIBRARY_MAX_SOURCES} 份资料。`}
              </p>
            </div>
            {conversation
              ? restored?.ok && <span className="badge">范围已锁定</span>
              : // Only a new question still has a range to fill; a saved thread
                // keeps the exact source versions its first answer used.
                onFindSourcesByQuestion && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={onFindSourcesByQuestion}
                  >
                    用问题找资料
                  </button>
                )}
          </div>
          {unavailable && (
            <p className="cross-library-ask-warning" role="status">
              {unavailable}
            </p>
          )}
          <div className="cross-library-source-list">
            {candidates.length ? (
              candidates.map(({ source, activeSpaces, available, reason }) => {
                const checked = selectedIds.includes(source.id);
                const disabled = !editable || !available || busy;
                return (
                  <label
                    className={`cross-library-source${checked ? " selected" : ""}${disabled ? " disabled" : ""}`}
                    key={source.id}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      aria-label={`选择跨库资料 ${source.title}`}
                      onChange={() => chooseSource(source.id, available)}
                    />
                    <span className="cross-library-source-check" aria-hidden="true">
                      {checked ? <Check size={14} /> : <Square size={14} />}
                    </span>
                    <FileText size={18} aria-hidden="true" />
                    <span className="cross-library-source-copy">
                      <strong>{source.title}</strong>
                      <span>{sourceSpaces(data, source.id)}</span>
                      <small>
                        版本 {source.versionId} · {sourceStatusLabel(source)}
                        {activeSpaces.length ? ` · ${activeSpaces.length} 个可用知识库` : ""}
                      </small>
                    </span>
                    <span
                      className={
                        available
                          ? "cross-library-source-state ready"
                          : "cross-library-source-state"
                      }
                    >
                      {crossLibrarySourceReasonLabel(reason)}
                    </span>
                  </label>
                );
              })
            ) : (
              <p className="empty-small">
                还没有可选择的资料。先导入并完成解析，再回到全部资料库发起跨库问答。
              </p>
            )}
          </div>
        </section>

        <section className="cross-library-conversation" aria-label="跨库问答内容">
          {messages.length ? (
            <div className="cross-library-message-list" aria-live="polite">
              {messages.map((message) => {
                const citations = message.citations.filter((citation) =>
                  lockedCitation(citation, fixedVersions),
                );
                return (
                  <article
                    className={`cross-library-message cross-library-message-${message.role}`}
                    key={message.id}
                  >
                    <strong>{message.role === "user" ? "你" : "Conuo"}</strong>
                    {message.content && <div>{message.content}</div>}
                    {message.error && (
                      <p className="cross-library-message-error">本次未完成：{message.error}</p>
                    )}
                    {message.role === "assistant" &&
                      message.citations.length > citations.length && (
                        <p className="cross-library-message-error">
                          部分历史引用不属于此会话的固定资料版本，不能打开。
                        </p>
                      )}
                    {citations.length > 0 && (
                      <div className="cross-library-citations">
                        {citations.map((citation) => (
                          <button
                            type="button"
                            key={`${citation.sourceId}:${citation.versionId}:${citation.chunkId}`}
                            onClick={() =>
                              onOpenSource(citation.sourceId, citation.versionId, citation)
                            }
                          >
                            打开原文 · {citation.title}
                          </button>
                        ))}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="cross-library-ask-empty">
              <Sparkles size={25} aria-hidden="true" />
              <h3>{conversation ? "这条会话还没有可展示的回答" : "从多份资料的联系开始"}</h3>
              <p>例如：这些资料对同一概念有哪些不同解释？</p>
            </div>
          )}
          {!data.aiEnabled && (
            <p className="cross-library-ask-warning" role="status">
              资料问答已关闭，请先在设置中开启。
            </p>
          )}
          <form
            className="cross-library-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void ask();
            }}
          >
            {error && <p className="cross-library-form-error">{error}</p>}
            <textarea
              aria-label="输入跨库问题"
              value={input}
              maxLength={4000}
              disabled={busy || !data.aiEnabled || Boolean(unavailable)}
              placeholder={
                conversation ? "在同一组固定资料中继续追问…" : "选择资料后，输入想比较或梳理的问题…"
              }
              onChange={(event) => setInput(event.target.value)}
            />
            <div>
              <span>
                {conversation ? "会沿用保存的资料与版本" : "首次发送后将锁定当前资料版本"}
              </span>
              {process.env.NEXT_PUBLIC_CONUO_FEATURE_TUTOR_MODE === "on" && (
                <label className="cross-library-tutor-toggle">
                  <input
                    type="checkbox"
                    checked={tutorMode}
                    disabled={busy || !data.aiEnabled || Boolean(unavailable)}
                    onChange={(event) => setTutorMode(event.target.checked)}
                  />
                  <span>回答方式：{tutorMode ? "引导我思考" : "直接解答"}</span>
                </label>
              )}
              {busy ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    controller.current?.abort(new DOMException("回答已停止。", "AbortError"))
                  }
                >
                  停止
                </button>
              ) : (
                <button className="btn btn-primary" disabled={!canAsk}>
                  <ArrowUp size={15} aria-hidden="true" />
                  发送
                </button>
              )}
            </div>
          </form>
        </section>
      </div>
    </section>
  );
}
