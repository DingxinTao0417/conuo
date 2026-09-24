"use client";

import { useCallback, useRef, useState } from "react";
import type { AnswerProgress, OnAnswerProgress } from "@/lib/answer-stream-types";
import type { AnswerResult } from "@/lib/types";

export type AskAnswerPhase = Extract<AnswerProgress, { type: "progress" }>["phase"];

export interface AskRunHandlers {
  /** Sends the request the host has already bounded and validated. */
  dispatch: (
    signal: AbortSignal,
    onProgress: OnAnswerProgress,
    depth: "standard" | "deep",
    mode: "answer" | "tutor",
  ) => Promise<AnswerResult>;
  /**
   * Whether the host still owns this request. A reader that has navigated to
   * another source, or a page whose evidence range has changed, answers false
   * so a late stream event or error never lands in the new context.
   */
  accepts?: () => boolean;
  onAnswer: (answer: AnswerResult) => void;
  onFailure: (failure: {
    message: string;
    stoppedByUser: boolean;
    /** Content produced before the learner pressed stop; never treated as verified. */
    partial: AnswerResult | null;
  }) => void;
}

/**
 * The conversation half of a question surface: composer text, in-flight state,
 * the streamed draft, which saved thread is open, and which citation card is
 * expanded.
 *
 * Every surface that talks to `/api/v1/ask` needs exactly this state machine,
 * and each one used to re-implement the abort/stop/late-event handling. Keeping
 * it here means a new entry point cannot accidentally ship a variant that
 * publishes a stopped answer or leaks a previous context's result.
 */
export function useAskConversation() {
  const [input, setInput] = useState("");
  const [deepThinking, setDeepThinking] = useState(false);
  const [tutorMode, setTutorMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [answerDraft, setAnswerDraft] = useState<AnswerResult | null>(null);
  const [answerPhase, setAnswerPhase] = useState<AskAnswerPhase>("retrieving");
  const [error, setError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [newConversation, setNewConversation] = useState(false);
  const [expandedCitationKey, setExpandedCitationKey] = useState<string | null>(null);
  const [saveTargetMessageId, setSaveTargetMessageId] = useState<string | null>(null);
  const [knowledgePageTargetId, setKnowledgePageTargetId] = useState("");

  const controller = useRef<AbortController | null>(null);
  const manuallyStopped = useRef<AbortController | null>(null);
  const answerDraftRef = useRef<AnswerResult | null>(null);
  const questionInput = useRef<HTMLTextAreaElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);

  const replaceAnswerDraft = useCallback((next: AnswerResult | null) => {
    answerDraftRef.current = next;
    setAnswerDraft(next);
  }, []);

  const focusInput = useCallback(() => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => questionInput.current?.focus());
      return;
    }
    questionInput.current?.focus();
  }, []);

  /** True while a request is registered, including the window before `busy` paints. */
  const running = useCallback(() => controller.current !== null, []);

  const abort = useCallback((reason?: unknown) => {
    controller.current?.abort(reason);
  }, []);

  /** Learner-initiated stop: the partial content is kept, marked unverified. */
  const stop = useCallback(() => {
    const active = controller.current;
    if (!active) return;
    manuallyStopped.current = active;
    setStopping(true);
    active.abort();
  }, []);

  /** Clears the composer and thread selection without touching an in-flight request. */
  const beginNewConversation = useCallback(() => {
    setNewConversation(true);
    setSelectedConversationId(null);
    setHistoryOpen(false);
    setInput("");
    setDeepThinking(false);
    setTutorMode(false);
    setError("");
    setSaveTargetMessageId(null);
    setKnowledgePageTargetId("");
  }, []);

  /** Drops everything, including the in-flight request, for a new host identity. */
  const reset = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    manuallyStopped.current = null;
    replaceAnswerDraft(null);
    setInput("");
    setDeepThinking(false);
    setTutorMode(false);
    setBusy(false);
    setStopping(false);
    setAnswerPhase("retrieving");
    setError("");
    setHistoryOpen(false);
    setSelectedConversationId(null);
    setNewConversation(false);
    setExpandedCitationKey(null);
    setSaveTargetMessageId(null);
    setKnowledgePageTargetId("");
  }, [replaceAnswerDraft]);

  const toggleCitationKey = useCallback((key: string) => {
    setExpandedCitationKey((current) => (current === key ? null : key));
  }, []);

  const openKnowledgeSaveTarget = useCallback((messageId: string) => {
    setSaveTargetMessageId((current) => {
      const next = current === messageId ? null : messageId;
      if (next) setKnowledgePageTargetId("");
      return next;
    });
  }, []);

  const run = useCallback(
    async ({ dispatch, accepts, onAnswer, onFailure }: AskRunHandlers) => {
      const requestController = new AbortController();
      controller.current = requestController;
      setError("");
      replaceAnswerDraft(null);
      setAnswerPhase("retrieving");
      setBusy(true);
      setStopping(false);
      manuallyStopped.current = null;
      try {
        const answer = await dispatch(
          requestController.signal,
          (event) => {
            if (
              requestController.signal.aborted ||
              controller.current !== requestController ||
              accepts?.() === false
            )
              return;
            if (event.type === "draft") replaceAnswerDraft(event.answer);
            else setAnswerPhase(event.phase);
          },
          deepThinking ? "deep" : "standard",
          tutorMode ? "tutor" : "answer",
        );
        if (requestController.signal.aborted) throw new DOMException("已停止", "AbortError");
        onAnswer(answer);
      } catch (cause) {
        const stoppedByUser = manuallyStopped.current === requestController;
        const partial =
          stoppedByUser && answerDraftRef.current?.content.trim() ? answerDraftRef.current : null;
        const message = stoppedByUser
          ? partial
            ? "已停止生成，以上内容尚未完成或核验。"
            : "回答已停止，问题已保留。"
          : cause instanceof Error
            ? cause.message
            : "暂时无法回答，请稍后重试。";
        onFailure({ message, stoppedByUser, partial });
        if (accepts?.() !== false) setError(message);
      } finally {
        if (controller.current === requestController) {
          controller.current = null;
          setBusy(false);
          replaceAnswerDraft(null);
          setStopping(false);
          if (manuallyStopped.current === requestController) manuallyStopped.current = null;
        }
      }
    },
    [deepThinking, replaceAnswerDraft, tutorMode],
  );

  return {
    input,
    setInput,
    deepThinking,
    setDeepThinking,
    tutorMode,
    setTutorMode,
    busy,
    stopping,
    answerDraft,
    answerPhase,
    error,
    setError,
    historyOpen,
    setHistoryOpen,
    selectedConversationId,
    setSelectedConversationId,
    newConversation,
    setNewConversation,
    expandedCitationKey,
    setExpandedCitationKey,
    toggleCitationKey,
    saveTargetMessageId,
    setSaveTargetMessageId,
    knowledgePageTargetId,
    setKnowledgePageTargetId,
    openKnowledgeSaveTarget,
    questionInput,
    chatEnd,
    focusInput,
    running,
    abort,
    stop,
    beginNewConversation,
    reset,
    run,
  };
}

export type AskConversation = ReturnType<typeof useAskConversation>;
