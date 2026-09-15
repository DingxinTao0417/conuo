"use client";
import { useCallback, useRef, useState, type RefObject } from "react";
import {
  ArrowDownToLine,
  FilePlus2,
  LayoutGrid,
  Library,
  ListFilter,
  MoreHorizontal,
  Search,
  SlidersHorizontal,
  Upload,
  X,
} from "lucide-react";
import { isLibraryFilter, type LibraryRoute } from "@/lib/library-route";
import { isLibrarySort } from "@/lib/library-sort";
import { isLibraryTimeFilter } from "@/lib/library-time-filter";
import type { LibraryViewPatch } from "../hooks/use-library-route";
import { useMenuDismissal } from "../hooks/use-menu-dismissal";
import { normalizedTag } from "../shared";
import type { WorkspaceSearchIntent } from "../../workspace-search";

/** The three popovers the toolbar can open; only one is open at a time. */
type LibraryMenu = "filter" | "view" | "more";

export type LibraryToolbarProps = {
  /** The whole library view, so the toolbar never owns filter state itself. */
  route: LibraryRoute;
  onChange: (patch: LibraryViewPatch) => void;
  searchIntent: WorkspaceSearchIntent;
  onSearchIntentChange: (intent: WorkspaceSearchIntent) => void;
  availableTags: string[];
  searchRef: RefObject<HTMLInputElement | null>;
  busy: boolean;
  canExportLibrary: boolean;
  onExportLibrary: () => void;
  onImport: () => void;
  onNewNote: () => void;
};

/**
 * The library's five fixed controls: search, filter, view, import and more.
 *
 * Type, time and tag filters share one popover so the toolbar width no longer
 * depends on how many filters exist, and sort plus layout share another. The
 * view popover is disabled rather than removed when the current results are not
 * source rows the learner can reorder, so the control does not move around.
 */
export default function LibraryToolbar({
  route,
  onChange,
  searchIntent,
  onSearchIntentChange,
  availableTags,
  searchRef,
  busy,
  canExportLibrary,
  onExportLibrary,
  onImport,
  onNewNote,
}: LibraryToolbarProps) {
  const [requestedMenu, setRequestedMenu] = useState<LibraryMenu | null>(null);
  const filterMenu = useRef<HTMLDivElement>(null);
  const viewMenu = useRef<HTMLDivElement>(null);
  const moreMenu = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setRequestedMenu(null), []);

  const selectedTags = route.tags ?? [];
  const derivedFilter = route.filter === "note" || route.filter === "knowledge";
  // Question results are ranked by relevance and derived types use the content
  // search layout, so neither honours a source sort order or a card grid.
  const viewAvailable = searchIntent === "keyword" && !derivedFilter;
  const activeFilterCount =
    (route.filter === "all" ? 0 : 1) + (route.time === "all" ? 0 : 1) + selectedTags.length;
  // Switching to question mode while the view popover is open must not leave
  // controls on screen that no longer apply to the visible results.
  const openMenu = requestedMenu === "view" && !viewAvailable ? null : requestedMenu;

  useMenuDismissal(openMenu === "filter", filterMenu, closeMenu);
  useMenuDismissal(openMenu === "view", viewMenu, closeMenu);
  useMenuDismissal(openMenu === "more", moreMenu, closeMenu);

  const toggle = (menu: LibraryMenu) =>
    setRequestedMenu((current) => (current === menu ? null : menu));

  return (
    <div className="library-tools">
      <div className="search-field library-search-field">
        <div className="library-search-mode" role="group" aria-label="资料搜索方式">
          <button
            type="button"
            aria-pressed={searchIntent === "keyword"}
            onClick={() => onSearchIntentChange("keyword")}
          >
            关键词
          </button>
          <button
            type="button"
            aria-pressed={searchIntent === "question"}
            onClick={() => onSearchIntentChange("question")}
          >
            用问题找资料
          </button>
        </div>
        <Search size={16} aria-hidden="true" />
        <input
          ref={searchRef}
          placeholder={
            searchIntent === "question"
              ? "例如：哪份资料讲过学习率过高？"
              : "搜索资料、笔记与知识页…"
          }
          aria-label={searchIntent === "question" ? "输入问题找资料" : "搜索资料"}
          value={route.query}
          onChange={(event) => onChange({ query: event.target.value })}
        />
        {route.query && (
          <button
            type="button"
            className="icon-btn"
            onClick={() => onChange({ query: "" })}
            aria-label="清空搜索"
          >
            <X size={14} />
          </button>
        )}
      </div>
      <span className="library-tools-spacer" aria-hidden="true" />
      <div className="library-menu" ref={filterMenu}>
        <button
          type="button"
          className={`btn library-menu-trigger${activeFilterCount ? " is-active" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={openMenu === "filter"}
          aria-label={activeFilterCount ? `筛选资料，已应用 ${activeFilterCount} 项` : "筛选资料"}
          onClick={() => toggle("filter")}
        >
          <ListFilter size={14} aria-hidden="true" />
          筛选
          {activeFilterCount > 0 && (
            <span className="library-menu-badge" aria-hidden="true">
              {activeFilterCount}
            </span>
          )}
        </button>
        {openMenu === "filter" && (
          <section className="library-menu-popover" role="dialog" aria-label="筛选资料">
            <label className="library-menu-field">
              资料类型
              <select
                className="field"
                aria-label="筛选资料类型"
                value={route.filter}
                onChange={(event) => {
                  if (isLibraryFilter(event.target.value)) onChange({ filter: event.target.value });
                }}
              >
                <option value="all">全部类型</option>
                <option value="starred">已收藏</option>
                <option value="pdf">PDF</option>
                <option value="docx">DOCX</option>
                <option value="markdown">Markdown</option>
                <option value="text">TXT</option>
                <option value="web">网页</option>
                {searchIntent === "keyword" && <option value="note">笔记</option>}
                {searchIntent === "keyword" && <option value="knowledge">知识页</option>}
              </select>
            </label>
            <label className="library-menu-field">
              添加时间
              <select
                className="field"
                aria-label="按添加时间筛选资料"
                value={route.time}
                onChange={(event) => {
                  if (isLibraryTimeFilter(event.target.value))
                    onChange({ time: event.target.value });
                }}
              >
                <option value="all">全部时间</option>
                <option value="7d">最近 7 天</option>
                <option value="30d">最近 30 天</option>
                <option value="365d">最近一年</option>
              </select>
            </label>
            <div className="library-menu-section">
              <strong>标签</strong>
              <p>仅显示同时具有所选标签的资料。</p>
              {availableTags.length ? (
                <div className="tag-filter-options" role="group" aria-label="当前范围可用标签">
                  {availableTags.map((tag) => {
                    const checked = selectedTags.some(
                      (selectedTag) => normalizedTag(selectedTag) === normalizedTag(tag),
                    );
                    return (
                      <label className="tag-filter-option" key={normalizedTag(tag)}>
                        <input
                          type="checkbox"
                          aria-label={`标签 ${tag}`}
                          checked={checked}
                          onChange={(event) =>
                            onChange({
                              tags: event.currentTarget.checked
                                ? [...selectedTags, tag]
                                : selectedTags.filter(
                                    (selectedTag) =>
                                      normalizedTag(selectedTag) !== normalizedTag(tag),
                                  ),
                            })
                          }
                        />
                        <span>{tag}</span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p className="tag-filter-empty">当前范围还没有可用标签。</p>
              )}
            </div>
            <div className="library-menu-footer">
              <button
                type="button"
                className="text-button"
                aria-label="清除全部筛选"
                disabled={activeFilterCount === 0}
                onClick={() => onChange({ filter: "all", time: "all", tags: [] })}
              >
                清除
              </button>
            </div>
          </section>
        )}
      </div>
      <div className="library-menu" ref={viewMenu}>
        <button
          type="button"
          className="btn library-menu-trigger"
          aria-haspopup="dialog"
          aria-expanded={openMenu === "view"}
          aria-label="资料视图设置"
          disabled={!viewAvailable}
          title={
            viewAvailable
              ? undefined
              : searchIntent === "question"
                ? "用问题找资料按相关度排序，不能另选排序或卡片视图。"
                : "笔记与知识页使用内容搜索布局，不能另选排序或卡片视图。"
          }
          onClick={() => toggle("view")}
        >
          <SlidersHorizontal size={14} aria-hidden="true" />
          视图
        </button>
        {openMenu === "view" && (
          <section className="library-menu-popover" role="dialog" aria-label="资料视图设置">
            <label className="library-menu-field">
              排序
              <select
                className="field"
                aria-label="资料排序方式"
                value={route.sort}
                onChange={(event) => {
                  if (isLibrarySort(event.target.value)) onChange({ sort: event.target.value });
                }}
              >
                <option value="updated">最近更新</option>
                <option value="created">最近添加</option>
                <option value="name">名称</option>
              </select>
            </label>
            <div className="library-menu-section">
              <strong>布局</strong>
              <div className="view-switch">
                <button
                  type="button"
                  aria-label="列表视图"
                  aria-pressed={route.layout === "list"}
                  className="icon-btn"
                  onClick={() => onChange({ layout: "list" })}
                >
                  <Library size={16} />
                </button>
                <button
                  type="button"
                  aria-label="卡片视图"
                  aria-pressed={route.layout === "grid"}
                  className="icon-btn"
                  onClick={() => onChange({ layout: "grid" })}
                >
                  <LayoutGrid size={16} />
                </button>
              </div>
            </div>
          </section>
        )}
      </div>
      <button type="button" className="btn library-import-action" onClick={onImport}>
        <Upload size={14} aria-hidden="true" />
        导入
      </button>
      <div className="library-menu" ref={moreMenu}>
        <button
          type="button"
          className="icon-btn library-menu-trigger"
          aria-haspopup="menu"
          aria-expanded={openMenu === "more"}
          aria-label="更多资料库操作"
          onClick={() => toggle("more")}
        >
          <MoreHorizontal size={18} />
        </button>
        {openMenu === "more" && (
          <div
            className="library-menu-popover library-menu-list"
            role="group"
            aria-label="更多资料库操作"
          >
            {canExportLibrary && (
              <button
                type="button"
                className="library-menu-item export-library-action"
                disabled={busy}
                onClick={() => {
                  closeMenu();
                  onExportLibrary();
                }}
              >
                <ArrowDownToLine size={15} aria-hidden="true" />
                导出此知识库
              </button>
            )}
            <button
              type="button"
              className="library-menu-item"
              onClick={() => {
                closeMenu();
                onNewNote();
              }}
            >
              <FilePlus2 size={15} aria-hidden="true" />
              新建笔记
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
