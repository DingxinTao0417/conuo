"use client";

import { useMemo, type ReactNode } from "react";
import { ArrowUpRight, FolderOpen, Sparkles } from "lucide-react";
import type { PrimaryLearningContinuation } from "@/lib/learning-continue";
import { projectMarkdownVisibleText } from "@/lib/markdown-excerpt";
import "./learning-continuation-card.css";

function positionLabel(continuation: PrimaryLearningContinuation) {
  const source = continuation.source;
  if (source.pageCount) return `第 ${source.readPage || 1} / ${source.pageCount} 页`;
  if (source.readOffset) return "上次读到正文";
  return "已保存阅读位置";
}

export default function LearningContinuationCard({
  continuation,
  icon,
  onContinue,
}: {
  continuation: PrimaryLearningContinuation;
  icon: ReactNode;
  onContinue: () => void;
}) {
  const { source, conversation } = continuation;
  const summary = useMemo(() => {
    const projection =
      source.kind === "markdown" || source.kind === "web"
        ? projectMarkdownVisibleText(source.text)
        : null;
    const text = projection?.ok ? projection.visibleText : source.text;
    return text.replace(/\s+/gu, " ").trim().slice(0, 150) || "打开资料，继续阅读。";
  }, [source.kind, source.text]);
  return (
    <article className="learning-continuation-card">
      <div className="learning-continuation-icon">{icon}</div>
      <div className="learning-continuation-heading">
        <span>{conversation ? "带着问题继续" : "从上次位置继续"}</span>
        <h3>{source.title}</h3>
        <p>
          <FolderOpen size={14} aria-hidden="true" />
          <span>{continuation.spaceName}</span>
          <span aria-hidden="true">·</span>
          <span>{positionLabel(continuation)}</span>
        </p>
      </div>
      <p className="learning-continuation-summary">{summary}</p>
      {conversation && (
        <div className="learning-continuation-question">
          <Sparkles size={17} aria-hidden="true" />
          <div>
            <span>最近留下的问题</span>
            <b>{conversation.title}</b>
          </div>
        </div>
      )}
      <button
        className="btn btn-primary learning-continuation-action"
        type="button"
        onClick={onContinue}
      >
        {conversation ? "继续讨论" : "继续阅读"}
        <ArrowUpRight size={16} aria-hidden="true" />
      </button>
    </article>
  );
}
