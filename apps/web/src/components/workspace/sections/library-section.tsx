"use client";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  ArrowDownToLine,
  FolderPlus,
  LayoutGrid,
  Library,
  MoreHorizontal,
  Search,
  Sparkles,
  Star,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { persistConversation } from "@/lib/conversations";
import type { WorkspaceExportScope } from "@/lib/export-scope";
import { isLibraryFilter, type LibraryFilter, type LibraryRoute } from "@/lib/library-route";
import { isLibrarySort, type LibrarySort } from "@/lib/library-sort";
import { isLibraryTimeFilter, type LibraryTimeFilter } from "@/lib/library-time-filter";
import type { SearchHit } from "@/lib/search-types";
import { sourcePresentationStatus } from "@/lib/source-coverage";
import type { Citation, Source, Space, WorkspaceData } from "@/lib/types";
import { CollectionActions } from "../../collection-library";
import WorkspaceSearch, {
  type WorkspaceSearchAskDraft,
  type WorkspaceSearchExternalFilters,
  type WorkspaceSearchIntent,
} from "../../workspace-search";
import { CrossLibraryAskPanel } from "../lazy-panels";
import { Empty, SourceIcon, date, normalizedTag, sizeLabel, sourceStatusLabel } from "../shared";
import type { CrossLibrarySearchDraft, WorkspaceStore, WorkspaceUser } from "../types";

export type LibraryViewPatch = Partial<
  Pick<LibraryRoute, "filter" | "time" | "sort" | "layout" | "query" | "tags" | "crossLibraryAsk">
>;

export type LibrarySectionProps = {
  data: WorkspaceData;
  store: WorkspaceStore;
  user: WorkspaceUser;
  update: WorkspaceStore["update"];
  status: WorkspaceStore["status"];
  spaceId: string;
  libraryFiles: boolean;
  activeSpace: Space | undefined;
  visibleSources: Source[];
  filteredSources: Source[];
  availableTags: string[];
  derivedLibraryFilter: boolean;
  busy: boolean;
  search: string;
  searchRef: RefObject<HTMLInputElement | null>;
  searchIntent: WorkspaceSearchIntent;
  setSearchIntent: (intent: WorkspaceSearchIntent) => void;
  filter: LibraryFilter;
  timeFilter: LibraryTimeFilter;
  sort: LibrarySort;
  layout: "grid" | "list";
  selectedTags: string[];
  tagFilterRef: RefObject<HTMLDivElement | null>;
  tagFilterOpen: boolean;
  setTagFilterOpen: Dispatch<SetStateAction<boolean>>;
  replaceLibraryView: (patch: LibraryViewPatch) => void;
  searchExternalFilters: WorkspaceSearchExternalFilters | undefined;
  selected: string[];
  setSelected: (ids: string[]) => void;
  crossLibraryAsk: { conversationId?: string } | null;
  crossLibraryAskPanelKey: string;
  setCrossLibraryAskPanelKey: (key: string) => void;
  crossLibraryAskBusy: boolean;
  setCrossLibraryAskBusy: (busy: boolean) => void;
  crossLibrarySearchDraft: CrossLibrarySearchDraft | null;
  setCrossLibrarySearchDraft: (draft: CrossLibrarySearchDraft | null) => void;
  setActiveCrossLibraryConversation: (conversationId?: string) => void;
  clearConversationRouteState: () => void;
  setModal: (modal: "bulk-tags" | "details") => void;
  setDetailId: (id: string) => void;
  setToast: (message: string) => void;
  openImport: () => void;
  newNote: (kind: "note") => void;
  openSpaceCreation: () => void;
  openExport: (scope: WorkspaceExportScope) => void;
  openSource: (sourceId: string, versionId?: string, citation?: Citation) => void;
  openSearchHit: (hit: SearchHit) => void;
  openQuestionSearchDraft: (draft: WorkspaceSearchAskDraft) => void;
  openBulkSpaceAssociation: () => void;
  openBulkRecycle: () => void;
  openOrganization: (ids: string[]) => void;
  patchSource: (source: Source, patch: Partial<Source>) => void;
};

export default function LibrarySection({
  data,
  store,
  user,
  update,
  status,
  spaceId,
  libraryFiles,
  activeSpace,
  visibleSources,
  filteredSources,
  availableTags,
  derivedLibraryFilter,
  busy,
  search,
  searchRef,
  searchIntent,
  setSearchIntent,
  filter,
  timeFilter,
  sort,
  layout,
  selectedTags,
  tagFilterRef,
  tagFilterOpen,
  setTagFilterOpen,
  replaceLibraryView,
  searchExternalFilters,
  selected,
  setSelected,
  crossLibraryAsk,
  crossLibraryAskPanelKey,
  setCrossLibraryAskPanelKey,
  crossLibraryAskBusy,
  setCrossLibraryAskBusy,
  crossLibrarySearchDraft,
  setCrossLibrarySearchDraft,
  setActiveCrossLibraryConversation,
  clearConversationRouteState,
  setModal,
  setDetailId,
  setToast,
  openImport,
  newNote,
  openSpaceCreation,
  openExport,
  openSource,
  openSearchHit,
  openQuestionSearchDraft,
  openBulkSpaceAssociation,
  openBulkRecycle,
  openOrganization,
  patchSource,
}: LibrarySectionProps) {
  return (
    <>
      <CollectionActions
        onNewNote={() => newNote("note")}
        onImport={openImport}
        onNewSpace={() => openSpaceCreation()}
      />
      <div className="library-directory-heading">
        <div>
          <h2>
            {spaceId === "all" ? "全部资料" : "库内资料"}
            <span className="count-badge">{visibleSources.length}</span>
          </h2>
          {activeSpace?.goal && <p>{activeSpace.goal}</p>}
        </div>
        {activeSpace && (
          <button
            className="btn export-library-action"
            disabled={busy}
            onClick={() => openExport({ kind: "space", spaceId: activeSpace.id })}
          >
            <ArrowDownToLine size={15} aria-hidden="true" />
            导出此知识库
          </button>
        )}
        {spaceId === "all" && libraryFiles && (
          <button
            className="btn"
            disabled={crossLibraryAskBusy}
            onClick={() => {
              setCrossLibraryAskPanelKey(crypto.randomUUID());
              setCrossLibrarySearchDraft(null);
              replaceLibraryView({ crossLibraryAsk: {} });
            }}
          >
            <Sparkles size={15} />
            跨库问 AI
          </button>
        )}
      </div>
      {spaceId === "all" && libraryFiles && crossLibraryAsk && (
        <CrossLibraryAskPanel
          key={crossLibraryAskPanelKey}
          data={data}
          initialConversationId={crossLibraryAsk.conversationId}
          initialQuestion={crossLibrarySearchDraft?.question}
          initialSourceIds={crossLibrarySearchDraft?.sourceIds}
          onAsk={(request, signal) => store.ask(request, signal)}
          onConversationChange={(conversation) =>
            update((workspace) => persistConversation(workspace, conversation))
          }
          onActiveConversationChange={setActiveCrossLibraryConversation}
          onBusyChange={setCrossLibraryAskBusy}
          onOpenSource={openSource}
          onInvalidInitialConversation={() => {
            setToast("这条跨库问答记录不可用，已切换为新问题。");
            replaceLibraryView({ crossLibraryAsk: {} });
          }}
          onClose={() => {
            clearConversationRouteState();
            setCrossLibrarySearchDraft(null);
            replaceLibraryView({ crossLibraryAsk: undefined });
          }}
        />
      )}
      <div className="library-tools">
        <div className="library-search-mode" role="group" aria-label="资料搜索方式">
          <button
            type="button"
            aria-pressed={searchIntent === "keyword"}
            onClick={() => {
              setSearchIntent("keyword");
              setSelected([]);
            }}
          >
            关键词
          </button>
          <button
            type="button"
            aria-pressed={searchIntent === "question"}
            onClick={() => {
              if (derivedLibraryFilter) replaceLibraryView({ filter: "all" });
              setSearchIntent("question");
              setSelected([]);
            }}
          >
            用问题找资料
          </button>
        </div>
        <div className="search-field">
          <Search size={16} />
          <input
            ref={searchRef}
            placeholder={
              searchIntent === "question"
                ? "例如：哪份资料讲过学习率过高？"
                : "搜索资料、笔记与知识页…"
            }
            aria-label={searchIntent === "question" ? "输入问题找资料" : "搜索资料"}
            value={search}
            onChange={(e) => {
              replaceLibraryView({ query: e.target.value });
              setSelected([]);
            }}
          />
          {search && (
            <button
              className="icon-btn"
              onClick={() => replaceLibraryView({ query: "" })}
              aria-label="清空搜索"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <span className="library-search-break" aria-hidden="true" />
        <select
          className="field filter-select"
          aria-label="筛选资料类型"
          value={filter}
          onChange={(e) => {
            if (isLibraryFilter(e.target.value)) {
              replaceLibraryView({ filter: e.target.value });
              setSelected([]);
            }
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
        <select
          className="field filter-select time-filter-select"
          aria-label="按添加时间筛选资料"
          value={timeFilter}
          onChange={(e) => {
            if (isLibraryTimeFilter(e.target.value)) {
              replaceLibraryView({ time: e.target.value });
              setSelected([]);
            }
          }}
        >
          <option value="all">全部时间</option>
          <option value="7d">最近 7 天</option>
          <option value="30d">最近 30 天</option>
          <option value="365d">最近一年</option>
        </select>
        {searchIntent === "keyword" && !derivedLibraryFilter && (
          <select
            className="field filter-select sort-filter-select"
            aria-label="资料排序方式"
            value={sort}
            onChange={(event) => {
              if (isLibrarySort(event.target.value))
                replaceLibraryView({ sort: event.target.value });
            }}
          >
            <option value="updated">最近更新</option>
            <option value="created">最近添加</option>
            <option value="name">名称</option>
          </select>
        )}
        <div className="tag-filter" ref={tagFilterRef}>
          <button
            type="button"
            className={`btn tag-filter-trigger${selectedTags.length ? " is-active" : ""}`}
            aria-haspopup="dialog"
            aria-expanded={tagFilterOpen}
            aria-label={
              selectedTags.length ? `筛选资料标签，已选 ${selectedTags.length} 项` : "筛选资料标签"
            }
            onClick={() => setTagFilterOpen((open) => !open)}
          >
            <Tag size={14} aria-hidden="true" />
            标签{selectedTags.length ? ` ${selectedTags.length}` : ""}
          </button>
          {tagFilterOpen && (
            <section className="tag-filter-popover" role="dialog" aria-label="按标签筛选资料">
              <div className="tag-filter-popover-heading">
                <div>
                  <strong>筛选标签</strong>
                  <p>仅显示同时具有所选标签的资料。</p>
                </div>
                {selectedTags.length > 0 && (
                  <button
                    type="button"
                    className="text-button"
                    aria-label="清除已选标签"
                    onClick={() => {
                      replaceLibraryView({ tags: [] });
                      setSelected([]);
                    }}
                  >
                    清除
                  </button>
                )}
              </div>
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
                          onChange={(event) => {
                            const nextTags = event.currentTarget.checked
                              ? [...selectedTags, tag]
                              : selectedTags.filter(
                                  (selectedTag) =>
                                    normalizedTag(selectedTag) !== normalizedTag(tag),
                                );
                            replaceLibraryView({ tags: nextTags });
                            setSelected([]);
                          }}
                        />
                        <span>{tag}</span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p className="tag-filter-empty">当前范围还没有可用标签。</p>
              )}
            </section>
          )}
        </div>
        {searchIntent === "keyword" && !derivedLibraryFilter && (
          <div className="view-switch">
            <button
              aria-label="列表视图"
              aria-pressed={layout === "list"}
              className="icon-btn"
              onClick={() => replaceLibraryView({ layout: "list" })}
            >
              <Library size={16} />
            </button>
            <button
              aria-label="卡片视图"
              aria-pressed={layout === "grid"}
              className="icon-btn"
              onClick={() => replaceLibraryView({ layout: "grid" })}
            >
              <LayoutGrid size={16} />
            </button>
          </div>
        )}
      </div>
      {(search.trim() || derivedLibraryFilter) && (
        <WorkspaceSearch
          key={`${store.token}:${spaceId}`}
          data={data}
          query={search}
          scope={
            spaceId === "all"
              ? { kind: "all" }
              : spaceId === "inbox"
                ? { kind: "inbox" }
                : { kind: "space", spaceId }
          }
          userId={user?.id}
          cloudSaved={status === "cloud"}
          intent={searchIntent}
          externalFilters={searchExternalFilters}
          onOpen={openSearchHit}
          askDisabled={crossLibraryAskBusy}
          onAskSources={openQuestionSearchDraft}
        />
      )}
      {!derivedLibraryFilter && selected.length > 0 && (
        <div className="bulk-bar">
          <span>已选 {selected.length} 份</span>
          <button className="btn" onClick={() => setModal("bulk-tags")}>
            <Tag size={14} />
            添加标签
          </button>
          <button className="btn" onClick={openBulkSpaceAssociation}>
            <FolderPlus size={14} />
            关联空间
          </button>
          <button className="btn" onClick={() => openOrganization(selected)}>
            <Sparkles size={14} />
            整理为知识页
          </button>
          <button className="btn" onClick={() => openBulkRecycle()}>
            <Trash2 size={14} />
            移入回收站
          </button>
          <button className="text-button" onClick={() => setSelected([])}>
            取消选择
          </button>
        </div>
      )}
      {!search.trim() &&
        !derivedLibraryFilter &&
        (filteredSources.length ? (
          <div className={`source-list ${layout === "grid" ? "source-grid" : ""}`}>
            {layout === "list" && (
              <div className="source-list-heading">
                <span>资料名称</span>
                <span>状态</span>
                <span>更新时间</span>
                <span />
              </div>
            )}
            {filteredSources.map((s) => (
              <div className="source-row" key={s.id}>
                <input
                  className="source-check"
                  type="checkbox"
                  aria-label={`选择 ${s.title}`}
                  checked={selected.includes(s.id)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? [...selected, s.id] : selected.filter((id) => id !== s.id),
                    )
                  }
                />
                <button className="source-open" onClick={() => openSource(s.id)}>
                  <SourceIcon source={s} />
                  <div>
                    <b>{s.title}</b>
                    <p>
                      {sizeLabel(s.size)}
                      {s.tags.map((tag) => (
                        <span className="tag" key={tag}>
                          {tag}
                        </span>
                      ))}
                    </p>
                  </div>
                </button>
                <span className={`badge badge-${sourcePresentationStatus(s)}`}>
                  {sourceStatusLabel(s)}
                </span>
                <span className="source-date">{date(s.updatedAt)}</span>
                <button
                  className={`icon-btn star-btn ${s.starred ? "is-starred" : ""}`}
                  aria-label={s.starred ? `取消收藏 ${s.title}` : `收藏 ${s.title}`}
                  onClick={() => patchSource(s, { starred: !s.starred })}
                >
                  <Star size={16} fill={s.starred ? "currentColor" : "none"} />
                </button>
                <button
                  className="icon-btn"
                  aria-label={`管理 ${s.title}`}
                  onClick={() => {
                    setDetailId(s.id);
                    setModal("details");
                  }}
                >
                  <MoreHorizontal size={18} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <Empty
            icon={<Library size={32} />}
            title={
              search || filter !== "all" || timeFilter !== "all" || selectedTags.length
                ? "没有找到匹配的资料"
                : "这里等待着你的第一份资料"
            }
            text={
              search
                ? "换一个关键词，或在其他学习空间中查找。"
                : filter !== "all" || timeFilter !== "all" || selectedTags.length
                  ? "调整资料类型、添加时间或标签筛选，看看其他资料。"
                  : "把文件和网页收集在一起，再慢慢读懂。"
            }
            action={
              filter !== "all" || timeFilter !== "all" || selectedTags.length ? (
                <button
                  className="btn"
                  onClick={() => {
                    replaceLibraryView({ filter: "all", time: "all", tags: [] });
                    setSelected([]);
                  }}
                >
                  清除筛选
                </button>
              ) : !search ? (
                <button className="btn" onClick={openImport}>
                  导入资料
                </button>
              ) : undefined
            }
          />
        ))}
    </>
  );
}
