"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUp, FileText, Loader2, Sparkles, X } from "lucide-react";
import { priorUserQuestions } from "@/lib/answer-context";
import {
  createKnowledgePageEvidenceAnswerRequest,
  resolveKnowledgePageOriginalEvidence,
} from "@/lib/knowledge-page-evidence";
import type {
  AnswerAttempt,
  AnswerRequest,
  AnswerResult,
  Citation,
  Conversation,
  Message,
  Note,
  WorkspaceData,
} from "@/lib/types";
import { citationProblem } from "./reader-utils";
import "./knowledge-evidence-ask-panel.css";

export interface KnowledgeEvidenceAskPanelProps {
  data: WorkspaceData;
  note: Note;
  onAsk: (request: AnswerRequest, signal: AbortSignal) => Promise<AnswerResult>;
  onConversationChange: (conversation: Conversation) => void;
  onOpenSource: (sourceId: string, versionId?: string, citation?: Citation) => void;
  onBack: () => void;
}

function conversationTitle(note: Note) {
  const title = note.title.trim() || "未命名知识页";
  return `原始依据：${title}`.slice(0, 512);
}

/**
 * A fixed-range question surface for an accepted knowledge page. Its only
 * evidence boundary is derived from the page's current original citations;
 * the page body is never copied into a request or a conversation snapshot.
 */
export default function KnowledgeEvidenceAskPanel({
  data,
  note,
  onAsk,
  onConversationChange,
  onOpenSource,
  onBack,
}: KnowledgeEvidenceAskPanelProps) {
  const evidence = useMemo(() => resolveKnowledgePageOriginalEvidence(data, note), [data, note]);
  const identity = evidence.ok
    ? `${note.id}:${note.spaceId}:${evidence.sourceVersions
        .map((reference) => `${reference.sourceId}:${reference.versionId}`)
        .join("|")}`
    : `${note.id}:unavailable`;
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const activeIdentity = useRef(identity);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (activeIdentity.current === identity) return;
    controller.current?.abort(new DOMException("原始资料范围已变化。", "AbortError"));
    activeIdentity.current = identity;
    setConversation(null);
    setInput("");
    setBusy(false);
    setError("");
  }, [identity]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const messages = conversation?.messages ?? [];
  const sources = evidence.ok ? evidence.sources : [];
  const unavailable = !evidence.ok ? evidence.message : "";
  const canAsk = Boolean(data.aiEnabled && evidence.ok && input.trim() && !busy);

  async function ask() {
    const question = input.trim();
    if (!question || busy || !evidence.ok) return;
    if (!data.aiEnabled) {
      setError("资料问答已关闭，请先在设置中开启。");
      return;
    }

    const userContext = priorUserQuestions(messages);
    let request: AnswerRequest;
    try {
      request = createKnowledgePageEvidenceAnswerRequest(data, note, {
        question,
        requestId: crypto.randomUUID(),
        ...(userContext.length ? { userContext } : {}),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "请重新确认原始资料范围。");
      return;
    }

    const now = new Date().toISOString();
    const questionMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: question,
      citations: [],
      createdAt: now,
    };
    const next: Conversation = {
      ...(conversation ?? {
        id: crypto.randomUUID(),
        spaceId: note.spaceId,
        title: conversationTitle(note),
        scope: "sources" as const,
        sourceIds: [...request.sourceIds],
        messages: [],
        resolved: false,
      }),
      scope: "sources",
      sourceIds: [...request.sourceIds],
      messages: [...messages, questionMessage],
      updatedAt: now,
    };
    const attempt: AnswerAttempt = {
      id: request.requestId!,
      questionMessageId: questionMessage.id,
      scopeSnapshot: {
        scope: "sources",
        sourceIds: [...request.sourceIds],
        sourceVersions: request.sourceVersions?.map((reference) => ({ ...reference })),
        spaceId: request.spaceId,
        ...(userContext.length ? { userContext: [...userContext] } : {}),
      },
      status: "completed",
    };
    setConversation(next);
    onConversationChange(next);
    setInput("");
    setError("");
    setBusy(true);
    const requestController = new AbortController();
    controller.current = requestController;
    const requestIdentity = activeIdentity.current;

    try {
      const answer = await onAsk(request, requestController.signal);
      if (requestController.signal.aborted) throw new DOMException("已停止", "AbortError");
      if (activeIdentity.current !== requestIdentity)
        throw new Error("原始资料范围已变化，本次回答未保存。请重新确认资料后再提问。");
      const response: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: answer.content,
        citations: answer.citations,
        mode: answer.mode,
        attempt,
        createdAt: new Date().toISOString(),
      };
      const completed = {
        ...next,
        messages: [...next.messages, response],
        updatedAt: response.createdAt,
      };
      setConversation(completed);
      onConversationChange(completed);
    } catch (cause) {
      if (activeIdentity.current !== requestIdentity) return;
      const message = requestController.signal.aborted
        ? "回答已停止，问题已保留。"
        : cause instanceof Error
          ? cause.message
          : "暂时无法回答，请稍后重试。";
      const response: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        citations: [],
        error: message,
        attempt: { ...attempt, status: requestController.signal.aborted ? "stopped" : "failed" },
        createdAt: new Date().toISOString(),
      };
      const failed = {
        ...next,
        messages: [...next.messages, response],
        updatedAt: response.createdAt,
      };
      setConversation(failed);
      onConversationChange(failed);
      setError(message);
    } finally {
      if (controller.current === requestController) {
        controller.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <section className="knowledge-evidence-ask" aria-label="基于原始依据提问">
      <header className="knowledge-evidence-ask-header">
        <button type="button" className="btn" onClick={onBack} disabled={busy}>
          <ArrowLeft size={15} aria-hidden="true" />
          返回知识页
        </button>
        <button type="button" className="icon-btn" aria-label="关闭原始依据问答" onClick={onBack}>
          <X size={17} aria-hidden="true" />
        </button>
      </header>

      <div className="knowledge-evidence-ask-intro">
        <span className="knowledge-evidence-ask-icon">
          <Sparkles size={19} aria-hidden="true" />
        </span>
        <div>
          <span>知识页问答</span>
          <h1>基于本页原始依据提问</h1>
          <p>回答只检索本页引用且仍有效的原始资料。知识页正文不会发送给 AI，也不会作为回答证据。</p>
        </div>
      </div>

      {unavailable ? (
        <p className="knowledge-evidence-ask-notice" role="status">
          {unavailable}
        </p>
      ) : (
        <div className="knowledge-evidence-ask-range" aria-label="固定原始资料范围">
          <div>
            <strong>已锁定 {sources.length} 份原始资料</strong>
            <span>只会引用以下资料的当前版本</span>
          </div>
          <ul>
            {sources.map((source) => (
              <li key={source.id}>
                <FileText size={15} aria-hidden="true" />
                <span title={source.title}>{source.title}</span>
                <small>版本 {source.versionId.slice(0, 8)}</small>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!data.aiEnabled && (
        <p className="knowledge-evidence-ask-notice" role="status">
          资料问答已关闭，请先在设置中开启。
        </p>
      )}

      <div
        className="knowledge-evidence-ask-messages"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {!messages.length && !unavailable && (
          <div className="knowledge-evidence-ask-empty">
            <Sparkles size={24} aria-hidden="true" />
            <h2>从原始资料开始核对</h2>
            <p>例如：这些资料分别如何解释同一个概念？</p>
          </div>
        )}
        {messages.map((message) => (
          <article
            className={`knowledge-evidence-ask-message knowledge-evidence-ask-message-${message.role}`}
            key={message.id}
          >
            <strong>{message.role === "user" ? "你" : "Conuo"}</strong>
            {message.content && (
              <div className="knowledge-evidence-ask-content">{message.content}</div>
            )}
            {message.error && <p className="knowledge-evidence-ask-error">{message.error}</p>}
            {message.citations.length > 0 && (
              <div className="knowledge-evidence-ask-citations" aria-label="回答引用">
                {message.citations.map((citation, index) => {
                  const issue =
                    !evidence.ok ||
                    !sources.some(
                      (source) =>
                        source.id === citation.sourceId && source.versionId === citation.versionId,
                    )
                      ? "这条引用不属于本页锁定的原始资料范围，不能打开。"
                      : citationProblem(citation, data.sources);
                  return (
                    <button
                      type="button"
                      className={issue ? "invalid" : ""}
                      disabled={Boolean(issue)}
                      key={`${citation.sourceId}:${citation.versionId}:${citation.chunkId}:${index}`}
                      onClick={() => onOpenSource(citation.sourceId, citation.versionId, citation)}
                    >
                      <FileText size={14} aria-hidden="true" />
                      <span>{issue || `打开原文 · ${citation.title}`}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </article>
        ))}
      </div>

      <form
        className="knowledge-evidence-ask-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
      >
        <textarea
          ref={inputRef}
          aria-label="基于原始依据提问"
          placeholder="提出一个需要回到原始资料核对的问题…"
          value={input}
          disabled={!evidence.ok || busy}
          onChange={(event) => setInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void ask();
            }
          }}
        />
        <button type="submit" className="btn btn-primary" disabled={!canAsk} aria-label="发送问题">
          {busy ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <ArrowUp size={16} />}
          {busy ? "检索中" : "发送"}
        </button>
      </form>
      {error && (
        <p className="knowledge-evidence-ask-error" role="status">
          {error}
        </p>
      )}
    </section>
  );
}
