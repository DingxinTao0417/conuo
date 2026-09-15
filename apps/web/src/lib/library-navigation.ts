import type { Source } from "./types";

function timestamp(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The navigation only surfaces documents the user explicitly starred. Reading
 * activity is used solely as a stable ordering signal; importing or indexing
 * a document never makes it appear as a pinned item.
 */
export function pinnedLibrarySources(sources: readonly Source[], limit = 3): Source[] {
  return sources
    .filter((source) => !source.deletedAt && source.starred)
    .sort((left, right) => {
      const recentlyRead = timestamp(right.lastReadAt) - timestamp(left.lastReadAt);
      if (recentlyRead) return recentlyRead;
      const recentlyChanged = timestamp(right.updatedAt) - timestamp(left.updatedAt);
      return recentlyChanged || left.id.localeCompare(right.id);
    })
    .slice(0, Math.max(0, limit));
}
