import { useCallback, useMemo, useState } from "react";
import {
  formatLibraryRoute,
  normalizeLibraryTags,
  type LibraryFilter,
  type LibraryRoute,
} from "@/lib/library-route";
import { defaultLibrarySort, type LibrarySort } from "@/lib/library-sort";
import type { LibraryTimeFilter } from "@/lib/library-time-filter";
import type { WorkspaceSearchIntent } from "../../workspace-search";

/** Fields of a library route that the in-page toolbar may change without navigating. */
export type LibraryViewPatch = Partial<
  Pick<LibraryRoute, "filter" | "time" | "sort" | "layout" | "query" | "tags" | "crossLibraryAsk">
>;

/**
 * State behind the library view (space, filters, sort, layout, search) and its
 * two-way binding with the `#library` URL route.
 *
 * This first cut keeps one `useState` per field and exposes the same setters the
 * shell used before, so existing call sites are untouched; turning the internals
 * into a single reducer is a later step that can happen behind this interface.
 */
export function useLibraryRoute() {
  const [spaceId, setSpaceId] = useState("all");
  const [libraryFiles, setLibraryFiles] = useState(false);
  const [crossLibraryAsk, setCrossLibraryAsk] = useState<{ conversationId?: string } | null>(null);
  const [search, setSearch] = useState("");
  const [searchIntent, setSearchIntent] = useState<WorkspaceSearchIntent>("keyword");
  const [collectionSearch, setCollectionSearch] = useState("");
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [timeFilter, setTimeFilter] = useState<LibraryTimeFilter>("all");
  const [sort, setSort] = useState<LibrarySort>(defaultLibrarySort);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [layout, setLayout] = useState<"grid" | "list">("list");

  const currentLibraryViewRoute = useMemo<LibraryRoute>(
    () => ({
      spaceId,
      files: libraryFiles,
      filter,
      time: timeFilter,
      sort,
      layout,
      query: libraryFiles ? search : collectionSearch,
      ...(selectedTags.length ? { tags: selectedTags } : {}),
      ...(crossLibraryAsk ? { crossLibraryAsk } : {}),
    }),
    [
      collectionSearch,
      crossLibraryAsk,
      filter,
      layout,
      libraryFiles,
      search,
      selectedTags,
      sort,
      spaceId,
      timeFilter,
    ],
  );

  /** URL → state: adopt every field of a parsed library route. */
  const applyRoute = useCallback((route: LibraryRoute) => {
    setSpaceId(route.spaceId);
    setLibraryFiles(route.files);
    setFilter(route.filter);
    if (route.filter === "note" || route.filter === "knowledge") setSearchIntent("keyword");
    setTimeFilter(route.time);
    setSort(route.sort);
    setLayout(route.layout);
    setSelectedTags(normalizeLibraryTags(route.tags));
    setSearch(route.files ? route.query : "");
    setCollectionSearch(route.files ? "" : route.query);
    setCrossLibraryAsk(route.crossLibraryAsk ?? null);
  }, []);

  /** State → URL: patch the current view and mirror it into the hash without a history entry. */
  function replaceLibraryView(patch: LibraryViewPatch) {
    const next: LibraryRoute = {
      spaceId,
      files: libraryFiles,
      filter,
      time: timeFilter,
      sort,
      layout,
      query: libraryFiles ? search : collectionSearch,
      ...(selectedTags.length ? { tags: selectedTags } : {}),
      ...(crossLibraryAsk ? { crossLibraryAsk } : {}),
      ...patch,
    };
    setFilter(next.filter);
    if (next.filter === "note" || next.filter === "knowledge") setSearchIntent("keyword");
    setTimeFilter(next.time);
    setSort(next.sort);
    setLayout(next.layout);
    setSelectedTags(normalizeLibraryTags(next.tags));
    if (next.files) {
      setSearch(next.query);
      setCollectionSearch("");
    } else {
      setCollectionSearch(next.query);
      setSearch("");
    }
    setCrossLibraryAsk(next.crossLibraryAsk ?? null);
    window.history.replaceState(null, "", formatLibraryRoute(next));
  }

  return {
    spaceId,
    setSpaceId,
    libraryFiles,
    setLibraryFiles,
    crossLibraryAsk,
    setCrossLibraryAsk,
    search,
    setSearch,
    searchIntent,
    setSearchIntent,
    collectionSearch,
    setCollectionSearch,
    filter,
    setFilter,
    timeFilter,
    setTimeFilter,
    sort,
    setSort,
    selectedTags,
    setSelectedTags,
    layout,
    setLayout,
    currentLibraryViewRoute,
    applyRoute,
    replaceLibraryView,
  };
}
