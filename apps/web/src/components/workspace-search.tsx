"use client";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { FileText, Loader2, Search, Sparkles } from "lucide-react";
import { searchCloud } from "@/lib/cloud";
import {
  CROSS_LIBRARY_MAX_SOURCES,
  crossLibrarySourceEligibility,
  crossLibrarySourceReasonLabel,
} from "@/lib/cross-library-ask";
import { materializeSearchCandidates, searchWorkspace } from "@/lib/search";
import type { SearchCandidate, SearchHit, SearchRequest, SearchScope } from "@/lib/search-types";
import type { Source, SourceKind, WorkspaceData } from "@/lib/types";
import "./workspace-search.css";

const sourceKinds = [
  "pdf",
  "docx",
  "markdown",
  "text",
  "web",
] as const satisfies readonly SourceKind[];
type SearchContentType = NonNullable<NonNullable<SearchRequest["filters"]>["types"]>[number];
type SearchDateRange = NonNullable<NonNullable<SearchRequest["filters"]>["created"]>;
type SourceSearchHit = Extract<SearchHit, { kind: "source" }>;
type QuestionSearchHit = SourceSearchHit & {
  locator: Extract<SourceSearchHit["locator"], { kind: "chunk" }>;
};
export type WorkspaceSearchIntent = "keyword" | "question";

export interface WorkspaceSearchAskDraft {
  question: string;
  sourceIds: string[];
}

/**
 * Applies the containing source-library view to search without coupling this
 * component to routing or library controls. Every supplied tag must match the
 * source, and a supplied `starred` value is an exact boolean match.
 */
export interface WorkspaceSearchExternalFilters {
  /** Ordinary-search types include sources, notes and accepted knowledge pages. */
  types?: readonly SearchContentType[];
  /** Legacy source-only constraint, intersected with `types` when both exist. */
  sourceKinds?: readonly SourceKind[];
  tags?: readonly string[];
  starred?: boolean;
  created?: SearchDateRange;
}

export interface WorkspaceSearchProps {
  data: WorkspaceData;
  query: string;
  scope: SearchScope;
  userId?: string;
  cloudSaved: boolean;
  intent: WorkspaceSearchIntent;
  /** Optional source-library constraints from the parent view. */
  externalFilters?: WorkspaceSearchExternalFilters;
  onOpen: (hit: SearchHit) => void;
  /** Prevents a new handoff while the existing question panel is generating. */
  askDisabled?: boolean;
  /** Opens the existing bounded-source question flow. This never sends the question itself. */
  onAskSources: (draft: WorkspaceSearchAskDraft) => void;
}

interface NormalizedExternalFilters {
  types: SearchContentType[];
  sourceKinds: SourceKind[];
  tags: string[];
  starred?: boolean;
  created?: SearchDateRange;
}

function normalizedTag(value: string) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function normalizeDateRange(range: SearchDateRange | undefined): SearchDateRange | undefined {
  if (!range) return undefined;
  const instant = (value: string | undefined) => {
    if (!value) return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  };
  const from = instant(range.from);
  const to = instant(range.to);
  const normalized = {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
  return normalized.from || normalized.to ? normalized : undefined;
}

function normalizeExternalFilters(
  filters: WorkspaceSearchExternalFilters | undefined,
): NormalizedExternalFilters {
  const kinds = new Set<SourceKind>();
  for (const kind of filters?.sourceKinds || [])
    if ((sourceKinds as readonly string[]).includes(kind)) kinds.add(kind);

  const tags: string[] = [];
  const seenTags = new Set<string>();
  for (const value of filters?.tags || []) {
    const tag = normalizedTag(value);
    const key = tag.toLocaleLowerCase();
    if (!tag || tag.length > 100 || seenTags.has(key)) continue;
    seenTags.add(key);
    tags.push(tag);
    if (tags.length === 100) break;
  }
  const created = normalizeDateRange(filters?.created);
  const types = [...new Set(filters?.types || [])].filter((type) =>
    [...sourceKinds, "note", "knowledge"].includes(type),
  );

  return {
    types,
    sourceKinds: [...kinds],
    tags,
    ...(typeof filters?.starred === "boolean" ? { starred: filters.starred } : {}),
    ...(created ? { created } : {}),
  };
}

function sourceMatchesExternalFilters(source: Source, filters: NormalizedExternalFilters) {
  if (filters.types.length && !filters.types.includes(source.kind)) return false;
  if (filters.sourceKinds.length && !filters.sourceKinds.includes(source.kind)) return false;
  if (filters.starred !== undefined && source.starred !== filters.starred) return false;
  if (filters.created) {
    const createdAt = Date.parse(source.createdAt);
    if (!Number.isFinite(createdAt)) return false;
    if (filters.created.from && createdAt < Date.parse(filters.created.from)) return false;
    if (filters.created.to && createdAt >= Date.parse(filters.created.to)) return false;
  }
  return filters.tags.every((tag) =>
    source.tags.some(
      (sourceTag) => normalizedTag(sourceTag).toLocaleLowerCase() === tag.toLocaleLowerCase(),
    ),
  );
}

function hasExternalSourceFilter(filters: NormalizedExternalFilters) {
  return Boolean(
    filters.sourceKinds.length || filters.tags.length || filters.starred !== undefined,
  );
}

/**
 * Search candidates from a cloud response only carry IDs. Apply the same
 * library constraints before materializing them so stale or broad remote
 * candidate windows never leak an out-of-view source into the result list.
 */
function externalSearchData(
  data: WorkspaceData,
  filters: NormalizedExternalFilters,
): WorkspaceData {
  if (!hasExternalSourceFilter(filters)) return data;
  return {
    ...data,
    sources: data.sources.filter((source) => sourceMatchesExternalFilters(source, filters)),
    // Tags, favorites and the legacy source-type filter describe sources only.
    // Generic type/date constraints are evaluated on each object's own fields.
    notes: [],
  };
}

function externalCandidates(
  data: WorkspaceData,
  candidates: SearchCandidate[],
  filters: NormalizedExternalFilters,
): SearchCandidate[] {
  if (!hasExternalSourceFilter(filters)) return candidates;
  return candidates.filter((candidate) => {
    if (candidate.kind !== "source") return false;
    const source = data.sources.find((item) => item.id === candidate.objectId);
    return Boolean(source && sourceMatchesExternalFilters(source, filters));
  });
}

export default function WorkspaceSearch({
  data,
  query,
  scope,
  userId,
  cloudSaved,
  intent,
  externalFilters,
  onOpen,
  askDisabled = false,
  onAskSources,
}: WorkspaceSearchProps) {
  const [selection, setSelection] = useState<{ key: string; ids: string[] }>({
    key: "",
    ids: [],
  });
  const [remote, setRemote] = useState<{
    key: string;
    data: WorkspaceData;
    candidates?: SearchCandidate[];
    error?: string;
    pending?: boolean;
  }>();
  const controller = useRef<AbortController | null>(null);
  const libraryFilters = normalizeExternalFilters(externalFilters);
  const requestTypes: SearchContentType[] | undefined =
    intent === "question"
      ? sourceKinds.filter(
          (kind) =>
            (!libraryFilters.types.length || libraryFilters.types.includes(kind)) &&
            (!libraryFilters.sourceKinds.length || libraryFilters.sourceKinds.includes(kind)),
        )
      : libraryFilters.types.length
        ? [...libraryFilters.types]
        : libraryFilters.sourceKinds.length
          ? [...libraryFilters.sourceKinds]
          : undefined;
  const request: SearchRequest = {
    query,
    scope,
    filters: {
      types: requestTypes,
      // The containing library controls are the single source of filter truth.
      tags: libraryFilters.tags.length ? [...libraryFilters.tags] : undefined,
      ...(libraryFilters.starred !== undefined ? { starred: libraryFilters.starred } : {}),
      created: libraryFilters.created,
    },
    limit: 50,
  };
  const cloudMode = intent === "question" ? "semantic" : "keyword";
  // Keep every containing-view constraint in the identity, including legacy filters.
  const key = JSON.stringify([userId, request, cloudMode, cloudSaved, libraryFilters]);
  const current = useRef({ key, data });
  useLayoutEffect(() => {
    current.current = { key, data };
    return () => {
      controller.current?.abort();
    };
  }, [key, data]);
  const result = useMemo(() => {
    try {
      const [, input, mode, , filters] = JSON.parse(key) as [
        string | undefined,
        SearchRequest,
        "semantic" | "keyword",
        boolean,
        NormalizedExternalFilters,
      ];
      const filteredData = externalSearchData(data, filters);
      // An empty API type array means no restriction. A question with only
      // derived types must have no source candidates and cannot go remote.
      const searchData =
        mode === "semantic" && !input.filters?.types?.length
          ? { ...filteredData, sources: [], notes: [] }
          : filteredData;
      if (remote?.key === key && remote.data === data && remote.candidates)
        return {
          value: materializeSearchCandidates(searchData, input, remote.candidates),
          cloud: true,
        };
      return { value: searchWorkspace(searchData, input), cloud: false };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "无法读取搜索结果。" };
    }
  }, [data, key, remote]);
  const activeRemote = remote?.key === key && remote.data === data ? remote : undefined;
  const canSemantic = Boolean(
    userId &&
    cloudSaved &&
    data.aiEnabled &&
    data.semanticSearch &&
    scope.kind !== "all" &&
    requestTypes?.length,
  );
  const canSearchCloud = Boolean(
    query.trim() && userId && cloudSaved && (cloudMode === "keyword" || canSemantic),
  );
  async function search() {
    if (!userId || !canSearchCloud) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setRemote({ key, data, pending: true });
    try {
      const response = await searchCloud(request, cloudMode, userId, abort.signal);
      if (abort.signal.aborted || current.current.key !== key || current.current.data !== data)
        return;
      materializeSearchCandidates(data, request, response.candidates);
      setRemote({
        key,
        data,
        candidates: externalCandidates(data, response.candidates, libraryFilters),
      });
    } catch (error) {
      if (!abort.signal.aborted && current.current.key === key && current.current.data === data)
        setRemote({
          key,
          data,
          error: error instanceof Error ? error.message : "搜索失败，请重试。",
        });
    }
  }

  const questionHits =
    intent === "question"
      ? (result.value?.hits.filter(
          (hit): hit is QuestionSearchHit => hit.kind === "source" && hit.locator.kind === "chunk",
        ) ?? [])
      : [];
  const questionItems = questionHits.map((hit) => {
    const source = data.sources.find(
      (item) => item.id === hit.objectId && item.versionId === hit.versionId,
    );
    const eligibility = source ? crossLibrarySourceEligibility(data, source) : undefined;
    return {
      hit,
      available: Boolean(source && eligibility?.available),
      reason: source
        ? crossLibrarySourceReasonLabel(eligibility?.reason)
        : "资料版本已变化，请重新搜索",
    };
  });
  const selectionKey = JSON.stringify([
    key,
    Boolean(result.cloud),
    questionItems.map(({ hit, available }) => [hit.objectId, hit.versionId, available]),
  ]);
  const availableIds = new Set(
    questionItems.filter((item) => item.available).map((item) => item.hit.objectId),
  );
  const selectedIds =
    selection.key === selectionKey
      ? selection.ids.filter((sourceId) => availableIds.has(sourceId))
      : [];

  function toggleQuestionSource(sourceId: string) {
    setSelection((current) => {
      const ids =
        current.key === selectionKey ? current.ids.filter((id) => availableIds.has(id)) : [];
      if (ids.includes(sourceId))
        return { key: selectionKey, ids: ids.filter((id) => id !== sourceId) };
      if (!availableIds.has(sourceId) || ids.length >= CROSS_LIBRARY_MAX_SOURCES)
        return { key: selectionKey, ids };
      return { key: selectionKey, ids: [...ids, sourceId] };
    });
  }

  const scopeLabel =
    scope.kind === "all"
      ? "全部知识库与收件箱"
      : scope.kind === "inbox"
        ? "收件箱"
        : (data.spaces.find((item) => item.id === scope.spaceId)?.name ?? "当前知识库");

  return (
    <section className="workspace-search" aria-label="内容搜索结果">
      <div className="workspace-search-controls">
        <p>
          {intent === "question"
            ? `在「${scopeLabel}」中找资料 · ${result.cloud ? "云端关键词与语义检索" : "当前浏览器关键词匹配"} · 未生成回答`
            : `范围：${scopeLabel} · ${result.cloud ? "云端关键词检索" : "当前浏览器关键词检索"}`}
        </p>
        {userId && (intent === "keyword" || canSemantic) && (
          <button
            type="button"
            className="btn"
            disabled={!canSearchCloud || activeRemote?.pending}
            onClick={() => void search()}
          >
            {activeRemote?.pending ? <Loader2 size={15} className="spin" /> : <Search size={15} />}
            {intent === "question" ? "语义找资料" : "搜索云端"}
          </button>
        )}
      </div>
      <p className="workspace-search-summary">
        {intent === "question"
          ? "先核对原文片段并选择资料，再进入问答。这里显示的是检索结果，不是 AI 回答。"
          : "待审核草稿不参与普通搜索。"}
        {!query.trim() ? " 当前按类型浏览；输入关键词后可搜索云端。" : ""}
        {libraryFilters.types.some((type) => type === "note" || type === "knowledge") &&
        hasExternalSourceFilter(libraryFilters)
          ? " 标签和收藏仅适用于资料；浏览笔记或知识页时请清除这些条件。"
          : ""}
        {userId && !cloudSaved ? " 云端保存完成后可搜索云端。" : ""}
        {intent === "question" && userId && cloudSaved && !canSemantic
          ? " 选择具体知识库并开启语义检索后，可补充云端语义匹配。"
          : ""}
      </p>
      {(activeRemote?.error || result.error) && (
        <p className="form-error" role="alert">
          {activeRemote?.error || result.error}
        </p>
      )}
      {result.value && intent === "question" && (
        <div className="workspace-question-results" aria-live="polite">
          <div className="workspace-question-heading">
            <div>
              <strong>匹配资料与原文片段</strong>
              <span>
                {questionItems.length
                  ? `找到 ${questionItems.length} 份相关资料 · 已选择 ${selectedIds.length} / ${CROSS_LIBRARY_MAX_SOURCES}`
                  : "没有找到相关资料"}
              </span>
            </div>
            <button
              type="button"
              className="btn"
              disabled={askDisabled || !data.aiEnabled || !selectedIds.length}
              onClick={() => onAskSources({ question: query.trim(), sourceIds: [...selectedIds] })}
            >
              <Sparkles size={15} aria-hidden="true" />
              {askDisabled ? "当前回答生成中" : "用所选资料继续提问"}
            </button>
          </div>
          {!questionItems.length && (
            <p className="empty-small">试试缩短为主题关键词，或调整类型、时间和标签。</p>
          )}
          <div className="workspace-search-hits">
            {questionItems.map(({ hit, available, reason }) => {
              const checked = selectedIds.includes(hit.objectId);
              const selectionFull = selectedIds.length >= CROSS_LIBRARY_MAX_SOURCES && !checked;
              return (
                <article
                  className={`workspace-question-hit${checked ? " selected" : ""}`}
                  key={hit.id}
                >
                  <label className="workspace-question-select">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!available || selectionFull}
                      aria-label={`将 ${hit.title} 加入提问`}
                      onChange={() => toggleQuestionSource(hit.objectId)}
                    />
                    <FileText size={17} aria-hidden="true" />
                  </label>
                  <div className="workspace-question-copy">
                    <span className="workspace-search-hit-heading">
                      <strong>{hit.title}</strong>
                      <span>{available ? "可用于资料问答" : reason}</span>
                    </span>
                    <span className="workspace-search-snippet">{hit.snippet}</span>
                    <span className="workspace-search-location">
                      {`${hit.sourceKind === "text" ? "TXT" : hit.sourceKind === "markdown" ? "Markdown" : hit.sourceKind === "web" ? "网页" : hit.sourceKind.toUpperCase()} · ${hit.locator.page ? `第 ${hit.locator.page} 页` : hit.locator.section}`}
                      {hit.warnings.length ? ` · ${hit.warnings.join("；")}` : ""}
                    </span>
                  </div>
                  <button type="button" className="text-button" onClick={() => onOpen(hit)}>
                    打开原文
                  </button>
                </article>
              );
            })}
          </div>
          {!data.aiEnabled && questionItems.length > 0 && (
            <p className="workspace-search-summary">资料问答已关闭；仍可打开并阅读这些原文。</p>
          )}
          {result.value.hasMore && (
            <p className="workspace-search-summary">还有更多结果，请缩小范围或增加筛选条件。</p>
          )}
        </div>
      )}
      {result.value && intent === "keyword" && (
        <div className="workspace-search-hits" aria-live="polite">
          {!result.value.hits.length && (
            <p className="empty-small">未找到匹配内容。试试更具体的关键词或调整筛选条件。</p>
          )}
          {result.value.hits.map((hit) => (
            <button className="workspace-search-hit" key={hit.id} onClick={() => onOpen(hit)}>
              <span className="workspace-search-hit-heading">
                <strong>{hit.title}</strong>
                <span>{hit.provenance.label}</span>
              </span>
              <span className="workspace-search-snippet">{hit.snippet || "匹配标题或标签"}</span>
              <span className="workspace-search-location">
                {hit.kind === "source"
                  ? `${hit.sourceKind === "text" ? "TXT" : hit.sourceKind === "markdown" ? "Markdown" : hit.sourceKind === "web" ? "网页" : hit.sourceKind.toUpperCase()} · ${hit.locator.kind === "chunk" ? (hit.locator.page ? `第 ${hit.locator.page} 页` : hit.locator.section) : "标题 / 标签"}`
                  : hit.kind === "knowledge"
                    ? "知识页"
                    : "笔记"}
                {hit.warnings.length ? ` · ${hit.warnings.join("；")}` : ""}
              </span>
            </button>
          ))}
          {result.value.hasMore && (
            <p className="workspace-search-summary">还有更多结果，请缩小范围或增加筛选条件。</p>
          )}
        </div>
      )}
    </section>
  );
}
