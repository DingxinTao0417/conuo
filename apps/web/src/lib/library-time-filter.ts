import type { SearchRequest } from "./search-types";

export const libraryTimeFilters = ["all", "7d", "30d", "365d"] as const;

export type LibraryTimeFilter = (typeof libraryTimeFilters)[number];
export type LibraryCreatedRange = NonNullable<NonNullable<SearchRequest["filters"]>["created"]>;

const filterDays: Record<Exclude<LibraryTimeFilter, "all">, number> = {
  "7d": 7,
  "30d": 30,
  "365d": 365,
};

export function isLibraryTimeFilter(value: string): value is LibraryTimeFilter {
  return (libraryTimeFilters as readonly string[]).includes(value);
}

/** Returns the inclusive rolling start instant used by library and search filtering. */
export function libraryCreatedRange(
  filter: LibraryTimeFilter,
  now: number | Date = Date.now(),
): LibraryCreatedRange | undefined {
  if (filter === "all") return undefined;
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(nowMs)) return undefined;
  return { from: new Date(nowMs - filterDays[filter] * 24 * 60 * 60 * 1000).toISOString() };
}

export function isCreatedWithinLibraryRange(
  createdAt: string,
  range: LibraryCreatedRange | undefined,
): boolean {
  if (!range) return true;
  const instant = Date.parse(createdAt);
  return (
    Number.isFinite(instant) &&
    (!range.from || instant >= Date.parse(range.from)) &&
    (!range.to || instant < Date.parse(range.to))
  );
}
