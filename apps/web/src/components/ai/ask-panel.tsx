"use client";

import type { ReactNode } from "react";
import {
  ArrowUp,
  BookOpen,
  Check,
  History,
  LoaderCircle,
  MessageSquare,
  PanelRightClose,
  Plus,
  Sparkles,
  Square,
  StickyNote,
} from "lucide-react";
import { askScopeLabels, type AskScope } from "@/lib/ask-scopes";
import type { AnswerNoteEvidence, Citation, Conversation, Message, Note } from "@/lib/types";
import {
  AnswerMarkdown,
  CitationCard,
  CitationChip,
  Markdown,
  NoteEvidenceCard,
  NoteEvidenceChip,
} from "../reader/answer-markdown";
import {
  citationCardId,
  citationKey,
  citationMarkerIndexes,
  noteEvidenceCardId,
  noteEvidenceKey,
} from "../reader/citation-markdown";
import { EMPTY_NOTE_EVIDENCE, answerPhases } from "../reader/reader-constants";
import AnswerFeedback from "./answer-feedback";
import type { AskConversation } from "./use-ask-conversation";
import "../reader.css";

/** Copy and identity of the surface hosting the panel. */
export interface AskPanelSurface {
  /** DOM id, so a host can point `aria-controls` at the panel. */
  id: string;
  /** DOM id of the range warning the composer describes itself with. */
  eligibilityId?: string;
  label: string;
  title: string;
  description: string;
  placeholder: string;
  /** Accessible name of the composer; defaults to the generic reader wording. */
  composerLabel?: string;
  footnote: string;
  historyTitle: string;
  historyEmpty: string;
  empty: { title: string; text: string; prompts: readonly string[] };
  /** Host chrome under the description, such as the model status line. */
  extra?: ReactNode;
  /** Hides the panel from assistive tech while another view covers it. */
  hidden?: boolean;
}

export interface AskPanelScope {
  active: AskScope;
  options: readonly AskScope[];
  onChange: (scope: AskScope) => void;
  /** Locks the range while a request runs or the view is read-only. */
  locked: boolean;
  /** Range-specific chrome: a source picker, the selected quote, an evidence list. */
  detail?: ReactNode;
  /** Prevents sending and is announced next to the composer. */
  blockedMessage?: string;
  /**
   * Also disables the composer. Use it when the range cannot come back on its
   * own; a reader waiting for a source to finish parsing keeps typing instead.
   */
  blocksComposer?: boolean;
  /** A non-blocking note, such as how many sources are excluded. */
  notice?: ReactNode;
  /** Host chrome below the range warning, such as "allow this source for AI". */
  footer?: ReactNode;
}

export interface AskPanelConversation {
  current?: Conversation;
  /** Omitted on surfaces that keep no saved threads; the control disappears. */
  history?: readonly Conversation[];
  onSelect?: (conversation: Conversation) => void;
  onToggleResolved?: (conversation: Conversation) => void;
  onNew?: () => void;
  /** Replaces "正在探索这个问题" for surfaces with a different framing. */
  openLabel?: string;
}

export interface AskPanelEvidence {
  citationIssue: (citation: Citation) => string | null;
  noteEvidenceIssue: (evidence: AnswerNoteEvidence) => string | null;
  onOpenCitation: (citation: Citation) => void;
}

/** What a learner may do with a finished answer. Omitted actions disappear. */
export interface AskPanelAnswerActions {
  onSaveNote?: (message: Message) => void;
  /** Knowledge pages a finished answer can be appended to. */
  knowledgePages?: readonly Note[];
  onAppendToKnowledgePage?: (message: Message) => void;
  onCreateKnowledgeDraft?: (message: Message) => void;
  /** Why saving is unavailable for this answer, e.g. it cites personal notes. */
  blockedReason?: (message: Message) => string | undefined;
}

export interface AskPanelComposer {
  /** The surface can be read but not asked, e.g. a historical version. */
  readOnly: boolean;
  readOnlyMessage?: string;
  /** AI is switched off workspace-wide. */
  disabledMessage?: string;
  followUps?: readonly string[];
  onFollowUp?: (question: string) => void;
  onSubmit: () => void;
  onRetry?: (message: Message) => void;
  /** Copies an earlier question back into the composer for editing. */
  onEditQuestion?: (content: string) => void;
  /** Replaces the range name shown above the send button. */
  scopeSummary?: string;
}

export interface AskPanelProps {
  ask: AskConversation;
  surface: AskPanelSurface;
  scope: AskPanelScope;
  conversation: AskPanelConversation;
  messages: readonly Message[];
  evidence: AskPanelEvidence;
  composer: AskPanelComposer;
  answerActions?: AskPanelAnswerActions;
  /** Verified cloud identity used for answer feedback requests. */
  feedbackUserId?: string;
  onClose: () => void;
}

/**
 * The one question surface used by the reader, the comparison reader, a
 * knowledge page and the all-library workspace.
 *
 * It renders a range the learner can see, the saved threads for that range, the
 * answers with their original-source evidence, and the composer. It never
 * builds a request: a host passes an `AskScope` that already declares which
 * `AnswerRequest.scope` it may produce, and dispatches through `ask.run`. That
 * split is what keeps "which files can this answer read" a property of the
 * entry point rather than of this component.
 */
export default function AskPanel({
  ask,
  surface,
  scope,
  conversation,
  messages,
  evidence,
  composer,
  answerActions,
  feedbackUserId,
  onClose,
}: AskPanelProps) {
  const {
    input,
    setInput,
    deepThinking,
    setDeepThinking,
    busy,
    stopping,
    answerDraft,
    answerPhase,
    error,
    historyOpen,
    setHistoryOpen,
    expandedCitationKey,
    toggleCitationKey,
    saveTargetMessageId,
    setSaveTargetMessageId,
    knowledgePageTargetId,
    setKnowledgePageTargetId,
    openKnowledgeSaveTarget,
    questionInput,
    chatEnd,
    stop,
  } = ask;
  const blocked = scope.blockedMessage;
  const eligibilityId = surface.eligibilityId ?? `${surface.id}-eligibility`;
  const knowledgePages = answerActions?.knowledgePages ?? [];
  const singleScope = scope.options.length <= 1;
  const composerDisabled =
    busy ||
    composer.readOnly ||
    Boolean(composer.disabledMessage) ||
    Boolean(blocked && scope.blocksComposer);

  return (
    <aside
      id={surface.id}
      className="reader-ai"
      aria-label={surface.label}
      aria-hidden={surface.hidden || undefined}
    >
      <div className="reader-ai-sheet-grab" aria-hidden="true" />
      <header className="reader-ai-header">
        <div className="reader-ai-heading">
          <div className="reader-ai-icon">
            <Sparkles size={17} />
          </div>
          <strong>{surface.title}</strong>
          <div className="reader-tool-spacer" />
          {conversation.history && (
            <button
              className="icon-btn"
              aria-label="对话历史"
              aria-expanded={historyOpen}
              disabled={busy}
              onClick={() => setHistoryOpen(!historyOpen)}
            >
              <History size={16} />
            </button>
          )}
          {conversation.onNew && (
            <button
              className="icon-btn"
              aria-label="新建对话"
              disabled={busy || composer.readOnly}
              onClick={conversation.onNew}
            >
              <Plus size={18} />
            </button>
          )}
          <button className="icon-btn reader-close-ai" aria-label="收起问答面板" onClick={onClose}>
            <PanelRightClose size={17} />
          </button>
        </div>
        {surface.description ? <p>{surface.description}</p> : null}
        {surface.extra}
      </header>
      {historyOpen && conversation.history && (
        <div className="reader-history">
          <h3>{surface.historyTitle}</h3>
          {conversation.history.length ? (
            conversation.history.map((item) => (
              <button
                className={conversation.current?.id === item.id ? "reader-active" : ""}
                key={item.id}
                onClick={() => conversation.onSelect?.(item)}
              >
                <MessageSquare size={15} />
                <span>{item.title}</span>
                {item.resolved && <Check size={14} />}
              </button>
            ))
          ) : (
            <p>{surface.historyEmpty}</p>
          )}
        </div>
      )}
      {conversation.current && conversation.onToggleResolved && (
        <div className="reader-conversation-state">
          <span>
            {conversation.current.resolved
              ? "这个问题已解决"
              : (conversation.openLabel ?? "正在探索这个问题")}
          </span>
          <button
            disabled={busy || composer.readOnly}
            onClick={() => conversation.onToggleResolved?.(conversation.current!)}
          >
            {conversation.current.resolved ? "重新打开" : "标记已解决"}
          </button>
        </div>
      )}
      <div className="reader-messages" aria-live="polite" aria-relevant="additions text">
        {!messages.length && (
          <div className="reader-ai-empty">
            {(surface.empty.title || surface.empty.text) && (
              <>
                <div className="reader-ai-empty-icon">
                  <Sparkles size={24} />
                </div>
                {surface.empty.title ? <h2>{surface.empty.title}</h2> : null}
                {surface.empty.text ? <p>{surface.empty.text}</p> : null}
              </>
            )}
            <div>
              {surface.empty.prompts.map((question) => (
                <button
                  key={question}
                  disabled={composer.readOnly}
                  onClick={() => {
                    setInput(question);
                    questionInput.current?.focus();
                  }}
                >
                  {question}
                  <ArrowUp size={14} />
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message, index) => {
          const messageNoteEvidence = message.noteEvidence ?? EMPTY_NOTE_EVIDENCE;
          const citationIssues = message.citations.map(evidence.citationIssue);
          const noteEvidenceIssues = messageNoteEvidence.map(evidence.noteEvidenceIssue);
          const activeCitationIndex = message.citations.findIndex(
            (_, citationIndex) => citationKey(message.id, citationIndex) === expandedCitationKey,
          );
          const expandedCitationIndex = activeCitationIndex === -1 ? null : activeCitationIndex;
          const activeNoteEvidenceIndex = messageNoteEvidence.findIndex(
            (_, noteIndex) => noteEvidenceKey(message.id, noteIndex) === expandedCitationKey,
          );
          const expandedNoteEvidenceIndex =
            activeNoteEvidenceIndex === -1 ? null : activeNoteEvidenceIndex;
          const referencedEvidenceIndexes =
            message.role === "assistant"
              ? citationMarkerIndexes(
                  message.content,
                  message.citations,
                  messageNoteEvidence,
                  message.mode,
                )
              : { citations: new Set<number>(), notes: new Set<number>() };
          const fallbackCitationIndexes =
            message.role === "assistant"
              ? message.citations.flatMap((_, citationIndex) =>
                  referencedEvidenceIndexes.citations.has(citationIndex) ? [] : [citationIndex],
                )
              : [];
          const fallbackNoteEvidenceIndexes =
            message.role === "assistant"
              ? messageNoteEvidence.flatMap((_, noteIndex) =>
                  referencedEvidenceIndexes.notes.has(noteIndex) ? [] : [noteIndex],
                )
              : [];
          const saveBlockedReason = answerActions?.blockedReason?.(message);
          const retryQuestion =
            message.role === "assistant" && message.error && message.attempt
              ? messages.find(
                  (item) => item.id === message.attempt?.questionMessageId && item.role === "user",
                )
              : undefined;
          const feedbackQuestion = message.attempt
            ? messages.find(
                (item) => item.id === message.attempt?.questionMessageId && item.role === "user",
              )?.content
            : undefined;
          const attemptNumber = message.attempt
            ? messages
                .slice(0, index + 1)
                .filter(
                  (item) =>
                    item.role === "assistant" &&
                    item.attempt?.questionMessageId === message.attempt?.questionMessageId,
                ).length
            : 0;
          const showFollowUps =
            message.role === "assistant" &&
            !!message.content &&
            !message.error &&
            !message.attempt?.unavailableReason &&
            !composer.readOnly &&
            !busy &&
            index === messages.length - 1;
          const canSaveAnswer =
            message.role === "assistant" && !!message.content && !message.error && !!answerActions;

          return (
            <div key={message.id} className={`reader-message reader-message-${message.role}`}>
              <div className="reader-message-label">
                {message.role === "user" ? (
                  "你"
                ) : (
                  <>
                    <Sparkles size={14} />
                    Conuo{" "}
                    <span>
                      {attemptNumber > 1 ? `第 ${attemptNumber} 次尝试 · ` : ""}
                      {message.error
                        ? message.content
                          ? "已停止 · 未完成、未核验"
                          : "本次未完成"
                        : message.mode === "extractive"
                          ? "原文检索 · 未调用生成模型"
                          : message.mode === "model"
                            ? "AI 回答"
                            : ""}
                    </span>
                  </>
                )}
              </div>
              {message.content && (
                <div className="reader-message-content">
                  {message.role === "assistant" ? (
                    <AnswerMarkdown
                      content={message.content}
                      citations={message.citations}
                      noteEvidence={messageNoteEvidence}
                      mode={message.mode}
                      messageId={message.id}
                      expandedCitationIndex={expandedCitationIndex}
                      expandedNoteEvidenceIndex={expandedNoteEvidenceIndex}
                      citationIssues={citationIssues}
                      noteEvidenceIssues={noteEvidenceIssues}
                      onCitationToggle={(citationIndex) =>
                        toggleCitationKey(citationKey(message.id, citationIndex))
                      }
                      onNoteEvidenceToggle={(noteIndex) =>
                        toggleCitationKey(noteEvidenceKey(message.id, noteIndex))
                      }
                    />
                  ) : (
                    <Markdown content={message.content} />
                  )}
                </div>
              )}
              {message.error && (
                <div className="reader-message-error">
                  <p>{message.error}</p>
                  {message.content && (
                    <small>这段内容保留供回顾和继续提问，不会作为已核验答案保存或另存。</small>
                  )}
                  {message.attempt?.unavailableReason && (
                    <small>当时使用的资料已彻底删除，不能重试这次回答。</small>
                  )}
                  {retryQuestion &&
                    message.attempt &&
                    !message.attempt.unavailableReason &&
                    composer.onRetry && (
                      <button
                        className="btn"
                        disabled={composerDisabled}
                        onClick={() => composer.onRetry?.(message)}
                      >
                        重试此回答
                      </button>
                    )}
                  {composer.onEditQuestion && (
                    <button
                      className="text-button"
                      disabled={composerDisabled}
                      onClick={() => {
                        const previous = messages
                          .slice(0, index)
                          .reverse()
                          .find((item) => item.role === "user");
                        if (previous) composer.onEditQuestion?.(previous.content);
                      }}
                    >
                      重新编辑问题
                    </button>
                  )}
                </div>
              )}
              {message.role === "assistant" &&
                !message.error &&
                message.attempt?.unavailableReason && (
                  <p className="reader-message-history-notice">
                    当时使用的资料已彻底删除；此回答仅保留为历史记录。
                  </p>
                )}
              {message.role === "assistant" && !message.error && (
                <AnswerFeedback
                  message={message}
                  question={feedbackQuestion}
                  expectedUserId={feedbackUserId}
                />
              )}
              {message.role === "assistant" &&
                (message.citations.length > 0 || messageNoteEvidence.length > 0) && (
                  <div
                    className="reader-citations"
                    aria-label={messageNoteEvidence.length ? "回答依据" : "回答引用"}
                  >
                    {expandedCitationIndex !== null && (
                      <CitationCard
                        citation={message.citations[expandedCitationIndex]}
                        index={expandedCitationIndex}
                        id={citationCardId(message.id, expandedCitationIndex)}
                        issue={citationIssues[expandedCitationIndex] || null}
                        onOpen={() =>
                          evidence.onOpenCitation(message.citations[expandedCitationIndex])
                        }
                      />
                    )}
                    {expandedNoteEvidenceIndex !== null && (
                      <NoteEvidenceCard
                        evidence={messageNoteEvidence[expandedNoteEvidenceIndex]}
                        index={expandedNoteEvidenceIndex}
                        id={noteEvidenceCardId(message.id, expandedNoteEvidenceIndex)}
                        issue={noteEvidenceIssues[expandedNoteEvidenceIndex] || null}
                      />
                    )}
                    {fallbackCitationIndexes.length > 0 && (
                      <div className="reader-citation-fallback">
                        <span>引用</span>
                        {fallbackCitationIndexes.map((citationIndex) => {
                          const citation = message.citations[citationIndex];
                          return (
                            <CitationChip
                              key={`${citation.chunkId}-${citationIndex}`}
                              citation={citation}
                              index={citationIndex}
                              cardId={citationCardId(message.id, citationIndex)}
                              expanded={expandedCitationIndex === citationIndex}
                              issue={citationIssues[citationIndex] || null}
                              onToggle={() =>
                                toggleCitationKey(citationKey(message.id, citationIndex))
                              }
                            />
                          );
                        })}
                      </div>
                    )}
                    {fallbackNoteEvidenceIndexes.length > 0 && (
                      <div className="reader-citation-fallback reader-note-evidence-fallback">
                        <span>我的笔记</span>
                        {fallbackNoteEvidenceIndexes.map((noteIndex) => {
                          const item = messageNoteEvidence[noteIndex];
                          return (
                            <NoteEvidenceChip
                              key={`${item.noteId}-${item.blockId}-${noteIndex}`}
                              evidence={item}
                              index={noteIndex}
                              cardId={noteEvidenceCardId(message.id, noteIndex)}
                              expanded={expandedNoteEvidenceIndex === noteIndex}
                              issue={noteEvidenceIssues[noteIndex] || null}
                              onToggle={() =>
                                toggleCitationKey(noteEvidenceKey(message.id, noteIndex))
                              }
                            />
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              {showFollowUps && !!composer.followUps?.length && (
                <div className="reader-followups" role="group" aria-label="继续追问建议">
                  {composer.followUps.map((question) => (
                    <button
                      key={question}
                      type="button"
                      onClick={() => composer.onFollowUp?.(question)}
                    >
                      {question}
                    </button>
                  ))}
                </div>
              )}
              {canSaveAnswer && (
                <div className="reader-message-actions">
                  {answerActions?.onSaveNote && (
                    <button
                      disabled={Boolean(saveBlockedReason)}
                      title={saveBlockedReason}
                      onClick={() => answerActions.onSaveNote?.(message)}
                    >
                      <StickyNote size={13} />
                      保存笔记
                    </button>
                  )}
                  {answerActions?.onAppendToKnowledgePage && (
                    <button
                      aria-expanded={saveTargetMessageId === message.id}
                      disabled={Boolean(saveBlockedReason)}
                      title={saveBlockedReason}
                      onClick={() => openKnowledgeSaveTarget(message.id)}
                    >
                      <BookOpen size={13} />
                      保存到知识页
                    </button>
                  )}
                </div>
              )}
              {canSaveAnswer &&
                saveTargetMessageId === message.id &&
                !saveBlockedReason &&
                answerActions?.onAppendToKnowledgePage && (
                  <div className="reader-save-target" role="group" aria-label="保存回答到知识页">
                    <p>追加后会保留原文依据并新建一个历史版本，知识页将回到待审核状态。</p>
                    {knowledgePages.length ? (
                      <div className="reader-save-target-select">
                        <select
                          aria-label="选择要追加的知识页"
                          value={knowledgePageTargetId}
                          onChange={(event) => setKnowledgePageTargetId(event.target.value)}
                        >
                          <option value="">选择已有知识页</option>
                          {knowledgePages.map((page) => (
                            <option key={page.id} value={page.id}>
                              {page.title || "未命名知识页"}
                              {page.status === "draft" ? " · 待审核" : ""}
                            </option>
                          ))}
                        </select>
                        <button
                          className="btn btn-primary"
                          disabled={!knowledgePageTargetId}
                          onClick={() => answerActions.onAppendToKnowledgePage?.(message)}
                        >
                          追加到知识页
                        </button>
                      </div>
                    ) : (
                      <p className="reader-save-target-empty">当前知识库还没有可追加的知识页。</p>
                    )}
                    <div className="reader-save-target-actions">
                      {answerActions.onCreateKnowledgeDraft && (
                        <button
                          className="btn"
                          onClick={() => answerActions.onCreateKnowledgeDraft?.(message)}
                        >
                          <Plus size={13} />
                          新建知识页草稿
                        </button>
                      )}
                      <button
                        className="btn"
                        onClick={() => {
                          setSaveTargetMessageId(null);
                          setKnowledgePageTargetId("");
                        }}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
            </div>
          );
        })}
        {busy && answerDraft && (
          <div
            className="reader-message reader-message-assistant reader-message-draft"
            role="group"
            aria-label="正在生成的回答"
            aria-busy="true"
          >
            <div className="reader-message-label">
              <Sparkles size={14} />
              Conuo <span>{stopping ? "已停止 · 正在保留以上内容" : "生成中 · 尚未保存"}</span>
            </div>
            <div className="reader-message-content">
              <Markdown content={answerDraft.content} />
            </div>
            <details className="reader-draft-sources">
              <summary>
                本次段落依据 · {answerDraft.citations.length} 处原文
                {answerDraft.noteEvidence?.length
                  ? ` + ${answerDraft.noteEvidence.length} 段我的笔记`
                  : ""}
              </summary>
              <ol>
                {answerDraft.citations.map((citation, index) => (
                  <li key={`${citation.chunkId}-${index}`}>
                    <strong>
                      {citation.title} ·{" "}
                      {citation.page ? `第 ${citation.page} 页` : citation.section}
                    </strong>
                    <p>{citation.quote}</p>
                  </li>
                ))}
              </ol>
              {!!answerDraft.noteEvidence?.length && (
                <ul className="reader-draft-note-evidence">
                  {answerDraft.noteEvidence.map((item, index) => (
                    <li key={`${item.noteId}-${item.blockId}-${index}`}>
                      <strong>我的笔记 · {item.title}</strong>
                      <p>{item.quote}</p>
                    </li>
                  ))}
                </ul>
              )}
            </details>
            <p className="reader-draft-notice">
              {answerDraft.noteEvidence?.length
                ? "回答尚未完成；若最终引用个人笔记，会保留其快照而暂不支持直接另存。"
                : "回答尚未完成，完成后可保存为笔记或知识页。"}
            </p>
          </div>
        )}
        {busy && (
          <div className="reader-answer-progress" role="status">
            <LoaderCircle size={17} className="reader-spin" />
            {answerPhases[answerPhase]}
          </div>
        )}
        <div ref={chatEnd} />
      </div>
      <form
        className="reader-composer"
        onSubmit={(event) => {
          event.preventDefault();
          composer.onSubmit();
        }}
      >
        {composer.readOnly && composer.readOnlyMessage && (
          <p className="reader-form-error">{composer.readOnlyMessage}</p>
        )}
        {composer.disabledMessage && (
          <p className="reader-form-error">{composer.disabledMessage}</p>
        )}
        {error && (
          <p className="reader-form-error" role="alert">
            {error}
          </p>
        )}
        {scope.detail}
        {blocked ? (
          <p id={eligibilityId} className="reader-scope-warning" role="status">
            {blocked}
          </p>
        ) : (
          scope.notice
        )}
        {scope.footer}
        <div className="reader-input-box">
          <textarea
            ref={questionInput}
            aria-label={surface.composerLabel ?? "向资料提问"}
            aria-describedby={blocked ? eligibilityId : undefined}
            value={input}
            disabled={composerDisabled}
            rows={3}
            maxLength={4000}
            placeholder={surface.placeholder}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!blocked) composer.onSubmit();
              }
            }}
          />
          <div className="reader-input-footer">
            {singleScope ? (
              <p className="reader-scope reader-scope-fixed reader-scope-composer">
                <span>提问范围</span>
                <strong>{askScopeLabels[scope.active]}</strong>
              </p>
            ) : (
              <label className="reader-scope reader-scope-composer">
                <span>提问范围</span>
                <select
                  value={scope.active}
                  disabled={scope.locked || composerDisabled}
                  onChange={(event) => scope.onChange(event.target.value as AskScope)}
                >
                  {scope.options.map((key) => (
                    <option value={key} key={key}>
                      {askScopeLabels[key]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {process.env.NEXT_PUBLIC_CONUO_FEATURE_DEEP_THINKING === "on" && (
              <label className="reader-depth-toggle" title="回答更慢，适合推导和比较类问题">
                <input
                  type="checkbox"
                  checked={deepThinking}
                  disabled={composerDisabled}
                  onChange={(event) => setDeepThinking(event.target.checked)}
                />
                <span>深度思考</span>
              </label>
            )}
            {busy ? (
              <button
                type="button"
                className="reader-send reader-stop"
                aria-label="停止回答"
                onClick={stop}
              >
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button
                type="submit"
                className="reader-send"
                aria-label="发送问题"
                disabled={
                  composer.readOnly ||
                  !input.trim() ||
                  Boolean(composer.disabledMessage) ||
                  Boolean(blocked)
                }
              >
                <ArrowUp size={17} />
              </button>
            )}
          </div>
        </div>
        {surface.footnote ? <p className="reader-ai-footnote">{surface.footnote}</p> : null}
      </form>
    </aside>
  );
}
