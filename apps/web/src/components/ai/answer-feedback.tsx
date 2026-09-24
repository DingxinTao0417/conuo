"use client";

import { useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import {
  submitAnswerFeedback,
  withdrawAnswerFeedback,
  type AnswerFeedbackInput,
  CloudError,
} from "@/lib/cloud";
import type { Message } from "@/lib/types";

const reasons = [
  ["wrong_citation", "引用不支持"],
  ["not_answered", "答非所问"],
  ["incorrect", "内容有误"],
  ["incomplete", "不完整"],
  ["format", "格式有问题"],
  ["too_long", "太长"],
  ["other", "其他"],
] as const satisfies ReadonlyArray<readonly [AnswerFeedbackInput["reasons"][number], string]>;

export interface AnswerFeedbackProps {
  message: Message;
  question?: string;
  expectedUserId?: string;
}

export default function AnswerFeedback({ message, question, expectedUserId }: AnswerFeedbackProps) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<AnswerFeedbackInput["reasons"]>([]);
  const [comment, setComment] = useState("");
  const [includeContent, setIncludeContent] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");

  if (
    process.env.NEXT_PUBLIC_CONUO_FEATURE_ANSWER_FEEDBACK !== "on" ||
    !expectedUserId ||
    message.role !== "assistant" ||
    !message.content ||
    !message.attempt?.id ||
    message.attempt.status !== "completed"
  )
    return null;

  async function save(rating: AnswerFeedbackInput["rating"]) {
    if (state === "saving") return;
    setState("saving");
    setError("");
    const input: AnswerFeedbackInput = {
      requestId: message.attempt!.id,
      messageId: message.id,
      rating,
      reasons: rating === "down" ? selected : [],
      ...(rating === "down" && comment.trim() ? { comment: comment.trim() } : {}),
      includeContent: rating === "down" && includeContent,
      ...(rating === "down" && includeContent && question && message.content
        ? { question, answer: message.content }
        : {}),
    };
    try {
      await submitAnswerFeedback(input, expectedUserId!);
      setState("saved");
      setOpen(false);
    } catch (cause) {
      setState("error");
      setError(cause instanceof CloudError ? cause.message : "反馈暂时无法保存，请稍后重试。");
    }
  }

  async function withdraw() {
    if (state === "saving") return;
    setState("saving");
    setError("");
    try {
      await withdrawAnswerFeedback(message.attempt!.id, expectedUserId!);
      setState("idle");
    } catch (cause) {
      setState("error");
      setError(cause instanceof CloudError ? cause.message : "反馈暂时无法撤回，请稍后重试。");
    }
  }

  function toggleReason(reason: AnswerFeedbackInput["reasons"][number]) {
    setSelected((current) =>
      current.includes(reason) ? current.filter((item) => item !== reason) : [...current, reason],
    );
  }

  if (state === "saved")
    return (
      <div className="answer-feedback answer-feedback-saved" role="status">
        <span>已收到反馈</span>
        <button type="button" onClick={() => void withdraw()}>
          撤回
        </button>
      </div>
    );

  return (
    <div className="answer-feedback" aria-label="回答反馈">
      {!open && (
        <div className="answer-feedback-buttons">
          <button type="button" aria-label="这条回答有帮助" onClick={() => void save("up")}>
            <ThumbsUp size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="这条回答没帮助"
            onClick={() => {
              setOpen(true);
              setState("idle");
            }}
          >
            <ThumbsDown size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      {open && (
        <form
          className="answer-feedback-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save("down");
          }}
        >
          <fieldset>
            <legend>可以告诉我们原因吗？</legend>
            {reasons.map(([value, label]) => (
              <label key={value}>
                <input
                  type="checkbox"
                  checked={selected.includes(value)}
                  onChange={() => toggleReason(value)}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <textarea
            maxLength={500}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="补充说明（可选）"
            aria-label="反馈补充说明"
          />
          <label>
            <input
              type="checkbox"
              checked={includeContent}
              disabled={!question || !message.content}
              onChange={(event) => setIncludeContent(event.target.checked)}
            />
            附上本次问题和回答，帮助改进（不会附上资料原文）
          </label>
          {error && <p role="alert">{error}</p>}
          <div>
            <button type="submit" disabled={state === "saving"}>
              提交反馈
            </button>
            <button type="button" onClick={() => setOpen(false)} disabled={state === "saving"}>
              取消
            </button>
          </div>
        </form>
      )}
      {state === "error" && !open && <p role="alert">{error}</p>}
    </div>
  );
}
