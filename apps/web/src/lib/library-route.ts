import { isLibraryTimeFilter, type LibraryTimeFilter } from "./library-time-filter";
import { defaultLibrarySort, isLibrarySort, type LibrarySort } from "./library-sort";

export const libraryFilters = [
  "all",
  "starred",
  "pdf",
  "docx",
  "markdown",
  "text",
  "web",
  "note",
  "knowledge",
] as const;

export type LibraryFilter = (typeof libraryFilters)[number];
export type LibraryLayout = "list" | "grid";

/** The URL cannot select more tags than a source can carry. */
const MAX_LIBRARY_ROUTE_TAGS = 100;
const MAX_LIBRARY_ROUTE_TAG_LENGTH = 100;
const controlCharacter = /[\u0000-\u001F\u007F]/u;

export interface LibraryRoute {
  spaceId: string;
  files: boolean;
  filter: LibraryFilter;
  time: LibraryTimeFilter;
  sort: LibrarySort;
  layout: LibraryLayout;
  /** The visible view's search text: knowledge-library search or source search. */
  query: string;
  /**
   * Source tags selected in a files view. Omitted when no tag filter is active
   * so existing library links remain compact and backwards-compatible.
   */
  tags?: string[];
  /** Explicit all-library question panel; omitted everywhere else. */
  crossLibraryAsk?: { conversationId?: string };
}

const defaultRoute: LibraryRoute = {
  spaceId: "all",
  files: false,
  filter: "all",
  time: "all",
  sort: defaultLibrarySort,
  layout: "list",
  query: "",
};

function routeId(value: string | null): string | undefined {
  return value && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : undefined;
}

export function isLibraryFilter(value: string): value is LibraryFilter {
  return (libraryFilters as readonly string[]).includes(value);
}

function decodePathSegment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/**
 * Produces the tag-filter representation shared by URL parsing and formatting.
 * Values use the same NFKC, whitespace, and case-insensitive comparison as
 * source search, while retaining the first readable label for the UI.
 */
export function normalizeLibraryTags(values: readonly string[] | undefined): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();

  for (const value of values || []) {
    const tag = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (!tag || tag.length > MAX_LIBRARY_ROUTE_TAG_LENGTH || controlCharacter.test(tag)) continue;

    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length === MAX_LIBRARY_ROUTE_TAGS) break;
  }

  return tags;
}

/**
 * Reads the client-side library route from the URL fragment. Keeping this
 * state in the fragment lets a reload or a reader back-navigation restore the
 * same knowledge library, filters, sort order, view mode, query, and source tags
 * without server state.
 */
export function parseLibraryRoute(hash: string): LibraryRoute | undefined {
  const fragment = hash.replace(/^#/, "");
  const queryStart = fragment.indexOf("?");
  const path = (queryStart === -1 ? fragment : fragment.slice(0, queryStart)).split("/");
  if (path[0] !== "library") return undefined;

  const params = new URLSearchParams(queryStart === -1 ? "" : fragment.slice(queryStart + 1));
  const spaceId = decodePathSegment(path[1]);
  const files = Boolean(spaceId);
  const filterValue = params.get("filter");
  const timeValue = params.get("time");
  const sortValue = params.get("sort");
  const layoutValue = params.get("layout");
  const tags = files ? normalizeLibraryTags(params.getAll("tag")) : [];
  const conversationId = routeId(params.get("conversation"));
  const crossLibraryAsk =
    files && spaceId === "all" && params.get("ask") === "1"
      ? { ...(conversationId ? { conversationId } : {}) }
      : undefined;

  return {
    spaceId: spaceId || defaultRoute.spaceId,
    files,
    filter:
      files && filterValue && isLibraryFilter(filterValue) ? filterValue : defaultRoute.filter,
    time: files && timeValue && isLibraryTimeFilter(timeValue) ? timeValue : defaultRoute.time,
    sort: files && sortValue && isLibrarySort(sortValue) ? sortValue : defaultRoute.sort,
    layout: files && layoutValue === "grid" ? "grid" : defaultRoute.layout,
    query: params.get("q") || "",
    ...(tags.length ? { tags } : {}),
    ...(crossLibraryAsk ? { crossLibraryAsk } : {}),
  };
}

/** Returns the canonical fragment for a library screen. */
export function formatLibraryRoute(route: LibraryRoute): string {
  const files = route.files || route.spaceId !== "all";
  const params = new URLSearchParams();
  if (route.query) params.set("q", route.query);
  if (files && route.filter !== defaultRoute.filter) params.set("filter", route.filter);
  if (files && route.time !== defaultRoute.time) params.set("time", route.time);
  if (files && route.sort !== defaultRoute.sort) params.set("sort", route.sort);
  if (files && route.layout !== defaultRoute.layout) params.set("layout", route.layout);
  if (files) for (const tag of normalizeLibraryTags(route.tags)) params.append("tag", tag);
  if (files && route.spaceId === "all" && route.crossLibraryAsk) {
    params.set("ask", "1");
    if (route.crossLibraryAsk.conversationId)
      params.set("conversation", route.crossLibraryAsk.conversationId);
  }

  const path = files ? `/${encodeURIComponent(route.spaceId)}` : "";
  const query = params.toString();
  return `#library${path}${query ? `?${query}` : ""}`;
}
