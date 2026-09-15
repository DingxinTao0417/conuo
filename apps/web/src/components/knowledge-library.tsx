"use client";

import { BookOpen, Search, X } from "lucide-react";
import type { WorkspaceData } from "@/lib/types";
import { selectKnowledgeLibrary, type KnowledgeLibraryItem } from "@/lib/knowledge-library";
import {
  knowledgeLibraryFilters,
  type KnowledgeLibraryFilter,
} from "@/lib/workspace-section-route";
import "./knowledge-library.css";

const filterLabels: Record<KnowledgeLibraryFilter, string> = {
  all: "全部",
  pending: "待审核",
  saved: "已保存",
};

export interface KnowledgeLibraryProps {
  data: WorkspaceData;
  /** `all` renders one section per knowledge library. */
  spaceId?: string;
  query: string;
  filter: KnowledgeLibraryFilter;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: KnowledgeLibraryFilter) => void;
  onOpen: (noteId: string) => void;
}

function updatedLabel(value: string): string {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return "更新时间未知";
  return `${new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(instant)} 更新`;
}

function sourceCountLabel(count: number): string {
  return count ? `${count} 份关联资料` : "尚未关联资料";
}

function KnowledgeCard({ item, onOpen }: { item: KnowledgeLibraryItem; onOpen: () => void }) {
  const { note } = item;
  return (
    <button
      type="button"
      className="knowledge-library-card"
      aria-label={`打开知识页 ${note.title}，${item.statusLabel}，${sourceCountLabel(item.associatedSourceCount)}`}
      onClick={onOpen}
    >
      <span className="knowledge-library-card-heading">
        <span className="knowledge-library-card-icon" aria-hidden="true">
          <BookOpen size={18} />
        </span>
        <span className={`knowledge-library-status is-${item.status}`}>{item.statusLabel}</span>
      </span>
      <strong className="knowledge-library-card-title">{note.title}</strong>
      <span className="knowledge-library-card-summary">{item.summary}</span>
      <span className="knowledge-library-card-meta">
        <span>{sourceCountLabel(item.associatedSourceCount)}</span>
        <time dateTime={note.updatedAt}>{updatedLabel(note.updatedAt)}</time>
      </span>
    </button>
  );
}

export default function KnowledgeLibrary({
  data,
  spaceId = "all",
  query,
  filter,
  onQueryChange,
  onFilterChange,
  onOpen,
}: KnowledgeLibraryProps) {
  const view = selectKnowledgeLibrary(data, { spaceId, query, filter });
  const hasQuery = Boolean(query.trim());

  return (
    <section className="knowledge-library" aria-label="知识页资料库">
      <div className="knowledge-library-toolbar">
        <div className="knowledge-library-filters" role="group" aria-label="按审核状态筛选知识页">
          {knowledgeLibraryFilters.map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={filter === value}
              onClick={() => onFilterChange(value)}
            >
              <span>{filterLabels[value]}</span>
              <small>{view.counts[value]}</small>
            </button>
          ))}
        </div>
        <div className="knowledge-library-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            aria-label="搜索知识页"
            placeholder="搜索标题、正文或来源…"
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
          />
          {query && (
            <button type="button" aria-label="清除知识页搜索" onClick={() => onQueryChange("")}>
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {view.groups.length ? (
        <div className="knowledge-library-groups">
          {view.groups.map((group, groupIndex) => {
            const headingId = `knowledge-library-group-${groupIndex}`;
            return (
              <section
                className="knowledge-library-group"
                aria-labelledby={headingId}
                key={group.id}
              >
                <header className="knowledge-library-group-heading">
                  <span className="knowledge-library-space-mark" aria-hidden="true" />
                  <h3 id={headingId}>{group.name}</h3>
                  {group.space?.archived && (
                    <span className="knowledge-library-archived">已归档</span>
                  )}
                  <small>{group.items.length} 个知识页</small>
                </header>
                <div className="knowledge-library-grid">
                  {group.items.map((item) => (
                    <KnowledgeCard
                      item={item}
                      key={item.note.id}
                      onOpen={() => onOpen(item.note.id)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="knowledge-library-empty" role="status">
          <BookOpen size={30} aria-hidden="true" />
          <h3>
            {hasQuery
              ? "没有找到匹配的知识页"
              : filter === "pending"
                ? "没有待审核知识页"
                : filter === "saved"
                  ? "还没有已保存知识页"
                  : "让知识逐渐连起来"}
          </h3>
          <p>
            {hasQuery
              ? "试试其他主题、正文或来源关键词。"
              : filter === "all"
                ? "阅读时将有用的内容保存为知识页草稿，再补充和审核。"
                : "切换状态查看其他知识页。"}
          </p>
          {hasQuery ? (
            <button type="button" className="btn" onClick={() => onQueryChange("")}>
              清除搜索
            </button>
          ) : filter !== "all" ? (
            <button type="button" className="btn" onClick={() => onFilterChange("all")}>
              查看全部知识页
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
