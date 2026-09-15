"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  Check,
  FileText,
  History,
  MessageSquare,
  PanelRightClose,
  Plus,
  Sparkles,
  Square,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { priorUserQuestions } from "@/lib/answer-context";
import type { OnAnswerProgress, AnswerProgress } from "@/lib/answer-stream-types";
import {
  createComparisonConversationMetadata,
  isConversationForComparisonRoute,
} from "@/lib/comparison-conversation";
import type { ComparisonRoute } from "@/lib/comparison-route";
import type {
  AnswerAttempt,
  AnswerResult,
  Citation,
  Conversation,
  Message,
  Source,
  Space,
} from "@/lib/types";
import { citationProblem } from "./reader-utils";
import "./comparison-ai-panel.css";

export interface ComparisonAskInput {
  requestId: string;
  question: string;
  /** Prior learner questions only; model responses never become question context. */
  userContext?: string[];
}

export interface ComparisonAskPanelProps {
  leftSource: Source;
  rightSource: Source;
  space: Space;
  conversations: Conversation[];
  /** Opens this exact fixed-pair thread instead of defaulting to the newest one. */
  initialConversationId?: string;
  /** A current scope check from the parent; the dispatch callback rechecks it too. */
  unavailableReason?: string;
  onAsk: (
    input: ComparisonAskInput,
    signal: AbortSignal,
    onProgress?: OnAnswerProgress,
  ) => Promise<AnswerResult>;
  onConversationChange: (conversation: Conversation) => void;
  onOpenSource: (sourceId: string, versionId?: string, citation?: Citation) => void;
  onClose: () => void;
}

const phaseLabels: Record<Extract<AnswerProgress, { type: "progress" }>["phase"], string> = {
  retrieving: "正在检索两份资料…",
  generating: "正在生成比较…",
  validating: "正在核对引用…",
};

function comparisonRoute(leftSource: Source, rightSource: Source, space: Space): ComparisonRoute {
  return {
    leftSourceId: leftSource.id,
    leftVersionId: leftSource.versionId,
    rightSourceId: rightSource.id,
    rightVersionId: rightSource.versionId,
    spaceId: space.id,
  };
}

function safeMarkdownHref(href?: string) {
  if (!href) return undefined;
  const value = href.trim();
  return /^(?:https?:|mailto:|\/|#)/iu.test(value) ? value : undefined;
}

function AnswerMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => {
          const safeHref = safeMarkdownHref(href);
          return safeHref ? (
            <a href={safeHref} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ) : (
            <span className="comparison-ai-unsafe-link">{children}</span>
          );
        },
        img: ({ alt }) => (
          <span className="comparison-ai-image-placeholder">[图片{alt ? `：${alt}` : ""}]</span>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function CitationCard({
  citation,
  sources,
  onOpenSource,
}: {
  citation: Citation;
  sources: Source[];
  onOpenSource: ComparisonAskPanelProps["onOpenSource"];
}) {
  const issue = !sources.some(
    (source) => source.id === citation.sourceId && source.versionId === citation.versionId,
  )
    ? "这条引用不属于当前对照的固定资料版本，不能打开。"
    : citationProblem(citation, sources);
  const location = citation.page ? `第 ${citation.page} 页` : citation.section;
  return (
    <section className={`comparison-ai-citation ${issue ? "invalid" : ""}`}>
      <header>
        <FileText size={14} aria-hidden="true" />
        <div>
          <strong title={citation.title}>{citation.title}</strong>
          <span>{location || "原文片段"}</span>
        </div>
      </header>
      <blockquote>{citation.quote}</blockquote>
      {issue ? (
        <p>{issue}</p>
      ) : (
        <button
          type="button"
          onClick={() => onOpenSource(citation.sourceId, citation.versionId, citation)}
        >
          打开对应原文
          <ArrowUpRight size={12} aria-hidden="true" />
        </button>
      )}
    </section>
  );
}

function AssistantMessage({
  message,
  sources,
  onOpenSource,
}: {
  message: Message;
  sources: Source[];
  onOpenSource: ComparisonAskPanelProps["onOpenSource"];
}) {
  return (
    <article className="comparison-ai-message comparison-ai-message-assistant">
      <div className="comparison-ai-message-label">
        <Sparkles size={14} aria-hidden="true" />
        Conuo
        <span>
          {message.error
            ? message.content
              ? "已停止 · 未完成、未核验"
              : "本次未完成"
            : message.mode === "extractive"
              ? "原文检索 · 未调用生成模型"
              : "AI 回答"}
        </span>
      </div>
      {message.content && (
        <div className="comparison-ai-message-content">
          <AnswerMarkdown content={message.content} />
        </div>
      )}
      {message.error && <p className="comparison-ai-message-error">{message.error}</p>}
      {message.citations.length > 0 && (
        <div className="comparison-ai-citations" aria-label="回答引用">
          {message.citations.map((citation, index) => (
            <CitationCard
              citation={citation}
              sources={sources}
              onOpenSource={onOpenSource}
              key={`${citation.sourceId}:${citation.versionId}:${citation.chunkId}:${index}`}
            />
          ))}
        </div>
      )}
    </article>
  );
}

function comparisonConversationTitle(leftSource: Source, rightSource: Source) {
  return `对照：${leftSource.title} / ${rightSource.title}`.slice(0, 512);
}

/**
 * A small, intentionally scope-free question panel. Its parent owns every
 * request boundary, so this component never receives fields that could expand
 * the answer beyond the two fixed source versions on screen.
 */
export default function ComparisonAskPanel({
  leftSource,
  rightSource,
  space,
  conversations,
  initialConversationId,
  unavailableReason,
  onAsk,
  onConversationChange,
  onOpenSource,
  onClose,
}: ComparisonAskPanelProps) {
  const route = useMemo(
    () => comparisonRoute(leftSource, rightSource, space),
    [leftSource, rightSource, space],
  );
  const identity = `${route.spaceId}:${route.leftSourceId}:${route.leftVersionId}:${route.rightSourceId}:${route.rightVersionId}`;
  const history = useMemo(
    () =>
      conversations
        .filter((conversation) => isConversationForComparisonRoute(conversation, route))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [conversations, route],
  );
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(
    () => initialConversationId ?? null,
  );
  const [newConversation, setNewConversation] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [answerDraft, setAnswerDraft] = useState<AnswerResult | null>(null);
  const [answerPhase, setAnswerPhase] = useState<keyof typeof phaseLabels>("retrieving");
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const manuallyStoppedController = useRef<AbortController | null>(null);
  const answerDraftRef = useRef<AnswerResult | null>(null);
  const activeIdentity = useRef(identity);
  const consumedInitialConversationId = useRef<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const activeConversationId =
    selectedConversationId && history.some((item) => item.id === selectedConversationId)
      ? selectedConversationId
      : null;
  const conversation = newConversation
    ? undefined
    : history.find((item) => item.id === activeConversationId) || history[0];
  const messages = conversation?.messages || [];
  const sources = [leftSource, rightSource];

  function replaceAnswerDraft(value: AnswerResult | null) {
    answerDraftRef.current = value;
    setAnswerDraft(value);
  }

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (activeIdentity.current === identity) return;
    controller.current?.abort();
    activeIdentity.current = identity;
    consumedInitialConversationId.current = null;
    setSelectedConversationId(null);
    setNewConversation(false);
    setHistoryOpen(false);
    setInput("");
    setBusy(false);
    setStopping(false);
    setError("");
    replaceAnswerDraft(null);
    manuallyStoppedController.current = null;
  }, [identity]);
  useEffect(() => {
    if (!initialConversationId) {
      consumedInitialConversationId.current = null;
      return;
    }
    if (
      initialConversationId === consumedInitialConversationId.current ||
      !history.some((item) => item.id === initialConversationId)
    )
      return;

    consumedInitialConversationId.current = initialConversationId;
    setSelectedConversationId(initialConversationId);
    setNewConversation(false);
  }, [history, initialConversationId]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  function beginNewConversation() {
    setNewConversation(true);
    setSelectedConversationId(null);
    setHistoryOpen(false);
    setInput("");
    setError("");
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function stop() {
    if (!controller.current) return;
    manuallyStoppedController.current = controller.current;
    setStopping(true);
    controller.current.abort(new DOMException("已停止", "AbortError"));
  }

  async function ask() {
    const question = input.trim();
    if (!question || busy || controller.current) return;
    if (unavailableReason) {
      setError(unavailableReason);
      return;
    }

    const now = new Date().toISOString();
    const userContext = priorUserQuestions(messages);
    const questionMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: question,
      citations: [],
      createdAt: now,
    };
    const next: Conversation = {
      ...(conversation || {
        id: crypto.randomUUID(),
        spaceId: space.id,
        title: comparisonConversationTitle(leftSource, rightSource),
        scope: "sources" as const,
        sourceIds: [leftSource.id, rightSource.id],
        comparison: createComparisonConversationMetadata(route),
        messages: [],
        resolved: false,
      }),
      scope: "sources",
      sourceIds: [leftSource.id, rightSource.id],
      comparison: createComparisonConversationMetadata(route),
      messages: [...(conversation?.messages || []), questionMessage],
      updatedAt: now,
    };
    onConversationChange(next);
    setSelectedConversationId(next.id);
    setNewConversation(false);
    setInput("");
    setError("");
    replaceAnswerDraft(null);
    setAnswerPhase("retrieving");
    setBusy(true);
    setStopping(false);
    manuallyStoppedController.current = null;
    const requestController = new AbortController();
    controller.current = requestController;
    const attempt: AnswerAttempt = {
      id: crypto.randomUUID(),
      questionMessageId: questionMessage.id,
      scopeSnapshot: {
        scope: "sources",
        sourceIds: [leftSource.id, rightSource.id],
        sourceVersions: [
          { sourceId: leftSource.id, versionId: leftSource.versionId },
          { sourceId: rightSource.id, versionId: rightSource.versionId },
        ],
        comparison: createComparisonConversationMetadata(route),
        spaceId: space.id,
        ...(userContext.length ? { userContext } : {}),
      },
      status: "completed",
    };

    try {
      const answer = await onAsk(
        {
          requestId: attempt.id,
          question,
          ...(userContext.length ? { userContext } : {}),
        },
        requestController.signal,
        (event) => {
          if (
            requestController.signal.aborted ||
            controller.current !== requestController ||
            activeIdentity.current !== identity
          )
            return;
          if (event.type === "draft") replaceAnswerDraft(event.answer);
          else setAnswerPhase(event.phase);
        },
      );
      if (requestController.signal.aborted) throw new DOMException("已停止", "AbortError");
      if (activeIdentity.current !== identity)
        throw new Error("对照资料已变化，本次回答未保存。请重新确认两份资料后再提问。");
      const response: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: answer.content,
        citations: answer.citations,
        mode: answer.mode,
        attempt,
        createdAt: new Date().toISOString(),
      };
      onConversationChange({
        ...next,
        messages: [...next.messages, response],
        updatedAt: response.createdAt,
      });
    } catch (cause) {
      const stoppedByUser = manuallyStoppedController.current === requestController;
      const partial =
        stoppedByUser && answerDraftRef.current?.content.trim() ? answerDraftRef.current : null;
      const message = stoppedByUser
        ? partial
          ? "已停止生成，以上内容尚未完成或核验。"
          : "回答已停止，问题已保留。"
        : cause instanceof Error
          ? cause.message
          : "暂时无法回答，请稍后重试。";
      const response: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: partial?.content ?? "",
        citations: partial?.citations ?? [],
        ...(partial ? { mode: partial.mode } : {}),
        attempt: { ...attempt, status: stoppedByUser ? "stopped" : "failed" },
        error: message,
        createdAt: new Date().toISOString(),
      };
      if (activeIdentity.current === identity) {
        onConversationChange({
          ...next,
          messages: [...next.messages, response],
          updatedAt: response.createdAt,
        });
        setError(message);
      }
    } finally {
      if (controller.current === requestController) {
        controller.current = null;
        setBusy(false);
        setStopping(false);
        replaceAnswerDraft(null);
        if (manuallyStoppedController.current === requestController)
          manuallyStoppedController.current = null;
      }
    }
  }

  return (
    <aside className="comparison-ai-panel" aria-label="比较问 AI">
      <header className="comparison-ai-header">
        <div className="comparison-ai-heading">
          <span className="comparison-ai-icon">
            <Sparkles size={17} aria-hidden="true" />
          </span>
          <strong>比较问 AI</strong>
          <span className="comparison-ai-heading-spacer" />
          <button
            type="button"
            className="icon-btn"
            aria-label="对话历史"
            aria-expanded={historyOpen}
            disabled={busy}
            onClick={() => setHistoryOpen((value) => !value)}
          >
            <History size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="新建对话"
            disabled={busy || !!unavailableReason}
            onClick={beginNewConversation}
          >
            <Plus size={18} aria-hidden="true" />
          </button>
          <button type="button" className="icon-btn" aria-label="收起比较问答" onClick={onClose}>
            <PanelRightClose size={17} aria-hidden="true" />
          </button>
        </div>
        <p>只使用当前屏幕上的两份固定版本资料回答；不会扩展到笔记或其他资料。</p>
        <div className="comparison-ai-scope" aria-label="固定问答范围">
          <span>已锁定 2 份资料</span>
          <div>
            <b title={leftSource.title}>{leftSource.title}</b>
            <b title={rightSource.title}>{rightSource.title}</b>
          </div>
        </div>
        {unavailableReason && (
          <p className="comparison-ai-unavailable" role="status">
            {unavailableReason}
          </p>
        )}
      </header>
      {historyOpen && (
        <div className="comparison-ai-history">
          <h2>这两份资料的对话</h2>
          {history.length ? (
            history.map((item) => (
              <button
                className={conversation?.id === item.id ? "active" : ""}
                type="button"
                key={item.id}
                onClick={() => {
                  setSelectedConversationId(item.id);
                  setNewConversation(false);
                  setHistoryOpen(false);
                  setError("");
                }}
              >
                <MessageSquare size={15} aria-hidden="true" />
                <span>{item.title}</span>
                {item.resolved && <Check size={14} aria-label="已解决" />}
              </button>
            ))
          ) : (
            <p>发送第一个比较问题后，对话会保存在这里。</p>
          )}
        </div>
      )}
      {conversation && (
        <div className="comparison-ai-conversation-state">
          <span>{conversation.resolved ? "这个问题已解决" : "正在比较这两份资料"}</span>
          <button
            type="button"
            disabled={busy || !!unavailableReason}
            onClick={() =>
              onConversationChange({
                ...conversation,
                resolved: !conversation.resolved,
                updatedAt: new Date().toISOString(),
              })
            }
          >
            {conversation.resolved ? "重新打开" : "标记已解决"}
          </button>
        </div>
      )}
      <div className="comparison-ai-messages" aria-live="polite" aria-relevant="additions text">
        {!messages.length && (
          <div className="comparison-ai-empty">
            <span>
              <Sparkles size={23} aria-hidden="true" />
            </span>
            <h2>从两份资料的分歧开始</h2>
            <p>提问时，回答会附上两份资料中可回到原文核对的引用。</p>
            <div>
              {[
                "两份资料的核心观点有哪些一致和不同？",
                "它们分别采用了什么方法或证据？",
                "哪些结论需要结合两份资料谨慎理解？",
              ].map((question) => (
                <button
                  type="button"
                  key={question}
                  disabled={!!unavailableReason}
                  onClick={() => {
                    setInput(question);
                    inputRef.current?.focus();
                  }}
                >
                  {question}
                  <ArrowUp size={14} aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message) =>
          message.role === "assistant" ? (
            <AssistantMessage
              message={message}
              sources={sources}
              onOpenSource={onOpenSource}
              key={message.id}
            />
          ) : (
            <article className="comparison-ai-message comparison-ai-message-user" key={message.id}>
              <div className="comparison-ai-message-label">你</div>
              <div className="comparison-ai-message-content">{message.content}</div>
            </article>
          ),
        )}
        {busy && answerDraft && (
          <article className="comparison-ai-message comparison-ai-message-assistant comparison-ai-draft">
            <div className="comparison-ai-message-label">
              <Sparkles size={14} aria-hidden="true" />
              Conuo <span>正在生成，尚未完成或核验</span>
            </div>
            <div className="comparison-ai-message-content">
              <AnswerMarkdown content={answerDraft.content} />
            </div>
          </article>
        )}
        {busy && !answerDraft && (
          <p className="comparison-ai-progress" role="status">
            <Sparkles size={14} aria-hidden="true" />
            {phaseLabels[answerPhase]}
          </p>
        )}
      </div>
      <form
        className="comparison-ai-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
      >
        {error && <p className="comparison-ai-form-error">{error}</p>}
        <div className="comparison-ai-input-box">
          <textarea
            ref={inputRef}
            value={input}
            disabled={busy || !!unavailableReason}
            maxLength={4000}
            placeholder="例如：两份资料的结论为什么不同？"
            aria-label="输入比较问题"
            onChange={(event) => setInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void ask();
              }
            }}
          />
          <div>
            <span>{busy ? "范围已锁定为两份资料" : "⌘ / Ctrl + Enter 发送"}</span>
            {busy ? (
              <button
                type="button"
                className="comparison-ai-stop"
                disabled={stopping}
                onClick={stop}
              >
                <Square size={12} fill="currentColor" aria-hidden="true" />
                {stopping ? "正在停止" : "停止"}
              </button>
            ) : (
              <button
                type="submit"
                className="comparison-ai-send"
                aria-label="发送比较问题"
                disabled={!input.trim() || !!unavailableReason}
              >
                <ArrowUp size={16} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
        <p className="comparison-ai-footnote">回答会保留原文引用；请回到对应版本核对结论。</p>
      </form>
    </aside>
  );
}
