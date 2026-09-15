"use client";

import { useMemo, useState, type CSSProperties } from "react";
import {
  ArrowRight,
  FilePlus2,
  LibraryBig,
  Search,
  SlidersHorizontal,
  Upload,
  X,
} from "lucide-react";
import type { Note, Source, Space } from "@/lib/types";
import { collectionCoverStyle, inboxCoverStyle } from "@/lib/collection-cover";
import "./collection-library.css";

export interface CollectionLibraryProps {
  spaces: Space[];
  sources: Source[];
  /** Knowledge-page drafts make pending review visible from the shelf. */
  notes?: Note[];
  title?: string;
  onOpenSpace: (id: string) => void;
  onNewSpace: () => void;
  onImport: () => void;
  onNewNote: () => void;
  onOpenAll: () => void;
  query: string;
  onQueryChange: (query: string) => void;
}

export function CollectionActions({
  onNewNote,
  onImport,
  onNewSpace,
}: Pick<CollectionLibraryProps, "onNewNote" | "onImport" | "onNewSpace">) {
  return (
    <div className="collection-actions" aria-label="快捷操作">
      <button className="collection-action" onClick={onNewNote}>
        <span className="collection-action-icon collection-action-document">
          <FilePlus2 size={23} strokeWidth={1.6} />
        </span>
        <span className="collection-action-copy">
          <strong>新建文档</strong>
          <span>记录想法与学习笔记</span>
        </span>
      </button>
      <button className="collection-action" onClick={onImport}>
        <span className="collection-action-icon collection-action-import">
          <Upload size={23} strokeWidth={1.6} />
        </span>
        <span className="collection-action-copy">
          <strong>导入资料</strong>
          <span>上传文件或收藏网页</span>
        </span>
      </button>
      <button className="collection-action" onClick={onNewSpace}>
        <span className="collection-action-icon collection-action-create">
          <LibraryBig size={23} strokeWidth={1.6} />
        </span>
        <span className="collection-action-copy">
          <strong>新建知识库</strong>
          <span>按主题整理学习资料</span>
        </span>
      </button>
    </div>
  );
}

export default function CollectionLibrary({
  spaces,
  sources,
  notes = [],
  title = "知识库",
  onOpenSpace,
  onNewSpace,
  onImport,
  onNewNote,
  onOpenAll,
  query,
  onQueryChange,
}: CollectionLibraryProps) {
  const [includeArchived, setIncludeArchived] = useState(false);
  const archivedCount = spaces.filter((space) => space.archived).length;
  const books = useMemo(() => {
    const liveSources = sources.filter((source) => !source.deletedAt);
    const collections = spaces
      .filter((space) => includeArchived || !space.archived)
      .map((space) => {
        const spaceSources = liveSources.filter((source) => source.spaceIds.includes(space.id));
        const spaceNotes = notes.filter((note) => !note.deletedAt && note.spaceId === space.id);
        const activity = [
          space.createdAt,
          ...spaceSources.map((source) => source.updatedAt),
          ...spaceNotes.map((note) => note.updatedAt),
        ].filter(Boolean);
        const updatedAt = activity.sort((left, right) => Date.parse(right) - Date.parse(left))[0];
        return {
          id: space.id,
          name: space.name,
          goal: space.goal,
          count: spaceSources.length,
          updatedAt,
          hasLearningActivity: spaceSources.length > 0 || spaceNotes.length > 0,
          pendingReviewCount: spaceNotes.filter(
            (note) => note.kind === "knowledge" && note.status === "draft",
          ).length,
          style: collectionCoverStyle(space.id, space.color) as CSSProperties,
          inbox: false,
          archived: space.archived,
        };
      });
    const inboxSources = liveSources.filter((source) => source.spaceIds.length === 0);
    if (inboxSources.length)
      collections.push({
        id: "inbox",
        name: "收件箱",
        goal: "尚未归入知识库的资料",
        count: inboxSources.length,
        updatedAt: inboxSources
          .map((source) => source.updatedAt)
          .sort((left, right) => Date.parse(right) - Date.parse(left))[0],
        hasLearningActivity: true,
        pendingReviewCount: 0,
        style: inboxCoverStyle as CSSProperties,
        inbox: true,
        archived: false,
      });
    return collections;
  }, [includeArchived, notes, spaces, sources]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = books.filter((book) =>
    `${book.name}\n${book.goal}`.toLocaleLowerCase().includes(normalizedQuery),
  );

  return (
    <section className="collection-library" aria-label={title}>
      <CollectionActions onNewNote={onNewNote} onImport={onImport} onNewSpace={onNewSpace} />

      <section className="collection-shelf" aria-labelledby="collection-shelf-title">
        <div className="collection-shelf-header">
          <div className="collection-shelf-heading">
            <h2 id="collection-shelf-title">全部知识库</h2>
            <button
              type="button"
              className="collection-space-filter"
              aria-label={
                archivedCount === 0
                  ? "没有已归档知识库"
                  : includeArchived
                    ? `隐藏 ${archivedCount} 个已归档知识库`
                    : `显示 ${archivedCount} 个已归档知识库`
              }
              aria-pressed={includeArchived}
              disabled={archivedCount === 0}
              title={
                archivedCount === 0
                  ? "没有已归档知识库"
                  : includeArchived
                    ? "隐藏已归档知识库"
                    : "显示已归档知识库"
              }
              onClick={() => setIncludeArchived((current) => !current)}
            >
              <SlidersHorizontal size={14} aria-hidden="true" />
              {archivedCount > 0 && <span>{archivedCount}</span>}
            </button>
            <button className="collection-all-sources" onClick={onOpenAll}>
              全部资料
              <ArrowRight size={13} />
            </button>
          </div>
          <div className="collection-shelf-tools">
            <label className="collection-search">
              <Search size={15} aria-hidden="true" />
              <input
                aria-label="搜索知识库"
                placeholder="搜索知识库"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
              />
              {query && (
                <button type="button" aria-label="清除知识库搜索" onClick={() => onQueryChange("")}>
                  <X size={13} />
                </button>
              )}
            </label>
          </div>
        </div>

        {filtered.length > 0 ? (
          <div className="collection-books">
            {filtered.map((book) => (
              <button
                className="collection-book"
                key={book.id}
                onClick={() => onOpenSpace(book.id)}
                aria-label={`打开${book.inbox ? "" : "知识库"}${book.name}，${book.count} 份资料${book.archived ? "，已归档" : ""}${book.pendingReviewCount ? `，${book.pendingReviewCount} 个待审核知识页` : ""}`}
              >
                <span
                  className={`collection-cover${book.archived ? " collection-cover-archived" : ""}`}
                  style={book.style}
                >
                  <span className="collection-cover-index" aria-hidden="true">
                    {book.inbox ? "收" : book.name.trim().slice(0, 1)}
                  </span>
                  <span className="collection-cover-copy">
                    <strong className="collection-cover-title" title={book.name}>
                      {book.name}
                    </strong>
                    {book.goal && (
                      <span className="collection-cover-description" title={book.goal}>
                        {book.goal}
                      </span>
                    )}
                  </span>
                  {(book.archived || book.pendingReviewCount > 0) && (
                    <span className="collection-cover-statuses">
                      {book.archived && <span className="collection-cover-state">已归档</span>}
                      {book.pendingReviewCount > 0 && (
                        <span className="collection-cover-review">
                          待审核 {book.pendingReviewCount}
                        </span>
                      )}
                    </span>
                  )}
                  <span className="collection-cover-meta">
                    <span>{book.count} 份资料</span>
                    {book.updatedAt && (
                      <span className="collection-cover-date">
                        {book.hasLearningActivity ? "更新" : "创建"}{" "}
                        {new Date(book.updatedAt).toLocaleDateString("zh-CN", {
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="collection-empty" role="status">
            <h3>{normalizedQuery ? "没有找到相关知识库" : "还没有知识库"}</h3>
            <p>
              {normalizedQuery
                ? "试试其他名称或主题关键词。"
                : "新建一个知识库，将同一主题的资料放在一起。"}
            </p>
            {normalizedQuery ? (
              <button className="btn" onClick={() => onQueryChange("")}>
                清除搜索
              </button>
            ) : (
              <button className="btn" onClick={onNewSpace}>
                新建知识库
              </button>
            )}
          </div>
        )}
      </section>
    </section>
  );
}
