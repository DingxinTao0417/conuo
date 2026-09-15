"use client";
import { useCallback, useRef, useState, type RefObject } from "react";
import { FolderPlus, Library, MoreHorizontal, Sparkles, Star, Tag, Trash2 } from "lucide-react";
import { persistConversation } from "@/lib/conversations";
import type { WorkspaceExportScope } from "@/lib/export-scope";
import type { LibraryRoute } from "@/lib/library-route";
import type { SearchHit } from "@/lib/search-types";
import { sourcePresentationStatus } from "@/lib/source-coverage";
import type { Citation, Source, Space, WorkspaceData } from "@/lib/types";
import WorkspaceSearch, {
  type WorkspaceSearchAskDraft,
  type WorkspaceSearchExternalFilters,
  type WorkspaceSearchIntent,
} from "../../workspace-search";
import type { LibraryViewPatch } from "../hooks/use-library-route";
import { useMenuDismissal } from "../hooks/use-menu-dismissal";
import { CrossLibraryAskPanel } from "../lazy-panels";
import { Empty, SourceIcon, date, sizeLabel, sourceStatusLabel } from "../shared";
import type { CrossLibrarySearchDraft, WorkspaceStore, WorkspaceUser } from "../types";
import LibraryToolbar from "./library-toolbar";

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
  libraryRoute: LibraryRoute;
  searchRef: RefObject<HTMLInputElement | null>;
  searchIntent: WorkspaceSearchIntent;
  setSearchIntent: (intent: WorkspaceSearchIntent) => void;
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
  setModal: (modal: "bulk-tags") => void;
  openSourceDetail: (sourceId: string) => void;
  setToast: (message: string) => void;
  openImport: () => void;
  newNote: (kind: "note") => void;
  openExport: (scope: WorkspaceExportScope) => void;
  openSource: (sourceId: string, versionId?: string, citation?: Citation) => void;
  openSearchHit: (hit: SearchHit) => void;
  openQuestionSearchDraft: (draft: WorkspaceSearchAskDraft) => void;
  openBulkSpaceAssociation: () => void;
  openBulkRecycle: () => void;
  openOrganization: (ids: string[]) => void;
  patchSource: (source: Source, patch: Partial<Source>) => void;
};

/** The selection actions that do not fit the four primary bulk buttons. */
function BulkActionsMenu({ onOrganize }: { onOrganize: () => void }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useMenuDismissal(open, container, close);
  return (
    <div className="library-menu bulk-bar-menu" ref={container}>
      <button
        type="button"
        className="icon-btn library-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="更多批量操作"
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div
          className="library-menu-popover library-menu-list"
          role="group"
          aria-label="更多批量操作"
        >
          <button
            type="button"
            className="library-menu-item"
            onClick={() => {
              close();
              onOrganize();
            }}
          >
            <Sparkles size={15} aria-hidden="true" />
            整理为知识页
          </button>
        </div>
      )}
    </div>
  );
}

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
  libraryRoute,
  searchRef,
  searchIntent,
  setSearchIntent,
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
  openSourceDetail,
  setToast,
  openImport,
  newNote,
  openExport,
  openSource,
  openSearchHit,
  openQuestionSearchDraft,
  openBulkSpaceAssociation,
  openBulkRecycle,
  openOrganization,
  patchSource,
}: LibrarySectionProps) {
  // The shell keeps the visible query in the route it hands down, so the
  // toolbar input and the filtered rows always read the same text.
  const search = libraryRoute.query;
  const { filter, layout, time: timeFilter } = libraryRoute;
  const selectedTags = libraryRoute.tags ?? [];
  const filtersActive = filter !== "all" || timeFilter !== "all" || selectedTags.length > 0;
  return (
    <>
      <div className="library-directory-heading">
        <div>
          <h2>
            {spaceId === "all" ? "全部资料" : "库内资料"}
            <span className="count-badge">{visibleSources.length}</span>
          </h2>
          {activeSpace?.goal && <p>{activeSpace.goal}</p>}
        </div>
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
      <LibraryToolbar
        // An account or cache boundary drops transient review state elsewhere;
        // remounting closes any popover that belonged to the previous session.
        key={`${store.token}:${user?.id ?? "local"}`}
        route={libraryRoute}
        onChange={(patch) => {
          replaceLibraryView(patch);
          // Narrowing the list would silently keep hidden sources selected;
          // reordering or relayouting shows the same set, so it keeps it.
          if ("filter" in patch || "time" in patch || "tags" in patch || "query" in patch)
            setSelected([]);
        }}
        searchIntent={searchIntent}
        onSearchIntentChange={(intent) => {
          // Notes and knowledge pages have no question-mode equivalent.
          if (intent === "question" && derivedLibraryFilter) replaceLibraryView({ filter: "all" });
          setSearchIntent(intent);
          setSelected([]);
        }}
        availableTags={availableTags}
        searchRef={searchRef}
        busy={busy}
        canExportLibrary={Boolean(activeSpace)}
        onExportLibrary={() => {
          if (activeSpace) openExport({ kind: "space", spaceId: activeSpace.id });
        }}
        onImport={openImport}
        onNewNote={() => newNote("note")}
      />
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
          <button className="btn" onClick={() => openBulkRecycle()}>
            <Trash2 size={14} />
            移入回收站
          </button>
          <BulkActionsMenu onOrganize={() => openOrganization(selected)} />
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
                  onClick={() => openSourceDetail(s.id)}
                >
                  <MoreHorizontal size={18} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <Empty
            icon={<Library size={32} />}
            title={search || filtersActive ? "没有找到匹配的资料" : "这里等待着你的第一份资料"}
            text={
              search
                ? "换一个关键词，或在其他学习空间中查找。"
                : filtersActive
                  ? "调整资料类型、添加时间或标签筛选，看看其他资料。"
                  : "把文件和网页收集在一起，再慢慢读懂。"
            }
            action={
              filtersActive ? (
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
