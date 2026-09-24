/**
 * URL helpers for regular, space-scoped workspace screens.
 *
 * Source and library screens have richer routes of their own. These routes
 * keep the current learning space stable when a learner opens Overview,
 * Knowledge, Questions, or AI organization in a new tab or reloads.
 */
export const scopedWorkspaceSections = [
  "home",
  "notes",
  "knowledge",
  "organize",
  "questions",
  "practice",
  "review",
] as const;

export type ScopedWorkspaceSection = (typeof scopedWorkspaceSections)[number];

/**
 * Screens that do not belong to one learning space still use this small route
 * contract. A task center must not inherit whichever space happened to be
 * open when it was bookmarked, because it summarizes work across the whole
 * workspace.
 */
export const globalWorkspaceSections = ["tasks"] as const;

export type GlobalWorkspaceSection = (typeof globalWorkspaceSections)[number];
export type WorkspaceSection = ScopedWorkspaceSection | GlobalWorkspaceSection;

export const knowledgeLibraryFilters = ["all", "pending", "saved"] as const;
export type KnowledgeLibraryFilter = (typeof knowledgeLibraryFilters)[number];

export interface WorkspaceSectionRoute {
  section: WorkspaceSection;
  spaceId: string;
  query?: string;
  knowledgeFilter?: KnowledgeLibraryFilter;
}

export interface WorkspaceSectionRouteOptions {
  query?: string;
  knowledgeFilter?: KnowledgeLibraryFilter;
}

const spaceIdPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const knowledgeQueryMaxLength = 500;

export function isScopedWorkspaceSection(value: string): value is ScopedWorkspaceSection {
  return (scopedWorkspaceSections as readonly string[]).includes(value);
}

export function isWorkspaceSection(value: string): value is WorkspaceSection {
  return (
    isScopedWorkspaceSection(value) ||
    (globalWorkspaceSections as readonly string[]).includes(value)
  );
}

function validSpaceId(value: string | null): string | undefined {
  return value && spaceIdPattern.test(value) ? value : undefined;
}

export function isKnowledgeLibraryFilter(value: string): value is KnowledgeLibraryFilter {
  return (knowledgeLibraryFilters as readonly string[]).includes(value);
}

/** Parses only normal workspace section routes, leaving reader routes untouched. */
export function parseWorkspaceSectionRoute(hash: string): WorkspaceSectionRoute | undefined {
  const fragment = hash.replace(/^#/, "");
  const queryStart = fragment.indexOf("?");
  const section = queryStart === -1 ? fragment : fragment.slice(0, queryStart);
  if (!isWorkspaceSection(section)) return undefined;

  if (!isScopedWorkspaceSection(section)) return { section, spaceId: "all" };

  const params = new URLSearchParams(queryStart === -1 ? "" : fragment.slice(queryStart + 1));
  const route: WorkspaceSectionRoute = {
    section,
    spaceId: validSpaceId(params.get("space")) || "all",
  };
  if (section !== "knowledge") return route;

  const query = params.get("q")?.slice(0, knowledgeQueryMaxLength) ?? "";
  const filter = params.get("status") ?? "";
  return {
    ...route,
    ...(query.trim() ? { query } : {}),
    ...(isKnowledgeLibraryFilter(filter) && filter !== "all" ? { knowledgeFilter: filter } : {}),
  };
}

/** Serializes a section route without leaking a stale space through browser history. */
export function formatWorkspaceSectionRoute(
  section: WorkspaceSection,
  spaceId: string,
  options: WorkspaceSectionRouteOptions = {},
): string {
  if (!isScopedWorkspaceSection(section)) return `#${section}`;
  const params = new URLSearchParams();
  if (spaceId !== "all" && validSpaceId(spaceId)) params.set("space", spaceId);
  if (section === "knowledge") {
    const query = options.query?.slice(0, knowledgeQueryMaxLength) ?? "";
    if (query.trim()) params.set("q", query);
    if (
      options.knowledgeFilter &&
      options.knowledgeFilter !== "all" &&
      isKnowledgeLibraryFilter(options.knowledgeFilter)
    )
      params.set("status", options.knowledgeFilter);
  }
  const query = params.toString();
  return `#${section}${query ? `?${query}` : ""}`;
}
