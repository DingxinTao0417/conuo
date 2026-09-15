"use client";

import { ArrowUpRight, BookOpen, Check, FileText, MessageCircle, Sparkles } from "lucide-react";
import {
  questionHistoryCounts,
  questionHistoryFilters,
  questionHistoryItems,
  type QuestionHistoryFilter,
} from "@/lib/question-history";
import type { Conversation, Source, WorkspaceData } from "@/lib/types";
import "./question-history-list.css";

const filterLabels: Record<QuestionHistoryFilter, string> = {
  all: "全部",
  pending: "待解决",
  resolved: "已解决",
};

function updatedLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "更新时间未知";
  return `${date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" })} 更新`;
}

export default function QuestionHistoryList({
  data,
  spaceId,
  filter,
  onFilterChange,
  onContinue,
  onOpenOriginal,
  onToggleResolved,
  onOpenLibrary,
}: {
  data: WorkspaceData;
  spaceId: string;
  filter: QuestionHistoryFilter;
  onFilterChange: (filter: QuestionHistoryFilter) => void;
  onContinue: (conversation: Conversation) => void;
  onOpenOriginal: (source: Source) => void;
  onToggleResolved: (conversation: Conversation) => void;
  onOpenLibrary: () => void;
}) {
  const counts = questionHistoryCounts(data, spaceId);
  const items = questionHistoryItems(data, spaceId, filter);

  return (
    <section className="question-history" aria-label="问答记录">
      <div className="question-history-toolbar">
        <div className="question-history-filters" role="group" aria-label="按解决状态筛选">
          {questionHistoryFilters.map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={filter === value}
              onClick={() => onFilterChange(value)}
            >
              <span>{filterLabels[value]}</span>
              <small>{counts[value]}</small>
            </button>
          ))}
        </div>
        <span className="question-history-order">按最近更新排序</span>
      </div>

      {items.length ? (
        <div className="question-history-list">
          {items.map(
            ({ conversation, sourceSummary, recentDiscussionSummary, originalSource, action }) => (
              <article
                className={`question-history-item${conversation.resolved ? " is-resolved" : ""}`}
                key={conversation.id}
              >
                <header className="question-history-item-heading">
                  <span className="question-history-icon" aria-hidden="true">
                    <Sparkles size={17} />
                  </span>
                  <div>
                    <div className="question-history-title-line">
                      <h3>{conversation.title}</h3>
                      <span
                        className={`question-history-status ${conversation.resolved ? "resolved" : "pending"}`}
                      >
                        {conversation.resolved ? "已解决" : "待解决"}
                      </span>
                    </div>
                    <p>
                      {conversation.messages.length} 条消息 · {updatedLabel(conversation.updatedAt)}
                    </p>
                  </div>
                </header>

                <div className="question-history-context">
                  <p>
                    <FileText size={15} aria-hidden="true" />
                    <span>
                      <strong>关联资料</strong>
                      {sourceSummary}
                    </span>
                  </p>
                  <p>
                    <MessageCircle size={15} aria-hidden="true" />
                    <span>
                      <strong>最近讨论</strong>
                      {recentDiscussionSummary}
                    </span>
                  </p>
                </div>

                <footer className="question-history-actions">
                  {originalSource && (
                    <button
                      type="button"
                      className="btn question-history-original"
                      aria-label={`打开《${originalSource.title}》原文`}
                      onClick={() => onOpenOriginal(originalSource)}
                    >
                      打开原文
                      <ArrowUpRight size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-primary question-history-continue"
                    onClick={() => onContinue(conversation)}
                  >
                    {action === "continue" ? "继续讨论" : "查看记录"}
                  </button>
                  <button
                    type="button"
                    className={`btn question-history-resolve${conversation.resolved ? " resolved" : ""}`}
                    onClick={() => onToggleResolved(conversation)}
                  >
                    {conversation.resolved && <Check size={14} />}
                    {conversation.resolved ? "改为待解决" : "标记已解决"}
                  </button>
                </footer>
              </article>
            ),
          )}
        </div>
      ) : (
        <div className="question-history-empty">
          <BookOpen size={30} aria-hidden="true" />
          <h3>{counts.all ? `${filterLabels[filter]}问答为空` : "第一个问题，从阅读开始"}</h3>
          <p>
            {counts.all
              ? "切换状态查看其他记录，或回到资料继续提问。"
              : "打开一份资料，在右侧输入问题或选中一段文字查找依据。"}
          </p>
          {counts.all ? (
            <button type="button" className="btn" onClick={() => onFilterChange("all")}>
              查看全部问答
            </button>
          ) : (
            <button type="button" className="btn" onClick={onOpenLibrary}>
              打开资料库
            </button>
          )}
        </div>
      )}
    </section>
  );
}
