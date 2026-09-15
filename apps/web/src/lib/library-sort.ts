import type { Source } from "./types";

export const librarySorts = ["updated", "created", "name"] as const;

export type LibrarySort = (typeof librarySorts)[number];
export type LibrarySortableSource = Pick<Source, "title" | "createdAt" | "updatedAt">;

export const defaultLibrarySort: LibrarySort = "updated";

const titleCollator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});

export function isLibrarySort(value: string): value is LibrarySort {
  return (librarySorts as readonly string[]).includes(value);
}

function timestamp(value: string): number | undefined {
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : undefined;
}

function compareNewestFirst(left: string, right: string): number {
  const leftTime = timestamp(left);
  const rightTime = timestamp(right);

  if (leftTime === undefined) return rightTime === undefined ? 0 : 1;
  if (rightTime === undefined) return -1;
  if (leftTime === rightTime) return 0;
  return leftTime > rightTime ? -1 : 1;
}

function compareSources(
  left: LibrarySortableSource,
  right: LibrarySortableSource,
  sort: LibrarySort,
): number {
  if (sort === "updated") return compareNewestFirst(left.updatedAt, right.updatedAt);
  if (sort === "created") return compareNewestFirst(left.createdAt, right.createdAt);

  return titleCollator.compare(left.title.normalize("NFKC"), right.title.normalize("NFKC"));
}

/** Returns a stably sorted copy and leaves the caller's source order untouched. */
export function sortLibrarySources<T extends LibrarySortableSource>(
  sources: readonly T[],
  sort: LibrarySort = defaultLibrarySort,
): T[] {
  return sources
    .map((source, index) => ({ source, index }))
    .sort(
      (left, right) => compareSources(left.source, right.source, sort) || left.index - right.index,
    )
    .map(({ source }) => source);
}
