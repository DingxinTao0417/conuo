export type InkPreviewEntry = {
  revisionId: string;
  url: string;
};

export function parseInkPreviewPages(payload: unknown): Record<number, InkPreviewEntry> {
  if (!payload || typeof payload !== "object") return {};
  const pages = (payload as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) return {};
  const next: Record<number, InkPreviewEntry> = {};
  for (const page of pages) {
    if (!page || typeof page !== "object") continue;
    const item = page as {
      pageIndex?: unknown;
      headRevisionId?: unknown;
      previewDownloadUrl?: unknown;
      deleted?: unknown;
    };
    if (
      typeof item.pageIndex !== "number" ||
      !Number.isInteger(item.pageIndex) ||
      typeof item.previewDownloadUrl !== "string" ||
      typeof item.headRevisionId !== "string" ||
      item.deleted === true
    )
      continue;
    next[item.pageIndex + 1] = {
      revisionId: item.headRevisionId,
      url: item.previewDownloadUrl,
    };
  }
  return next;
}

/** Keep existing img URLs while the page head is unchanged so polls do not remount previews. */
export function mergeInkPreviewPages(
  previous: Record<number, InkPreviewEntry>,
  incoming: Record<number, InkPreviewEntry>,
  options: { refreshUrls?: boolean } = {},
): Record<number, InkPreviewEntry> {
  let changed = Object.keys(previous).length !== Object.keys(incoming).length;
  const merged: Record<number, InkPreviewEntry> = {};
  for (const [key, entry] of Object.entries(incoming)) {
    const page = Number(key);
    const prior = previous[page];
    if (prior && prior.revisionId === entry.revisionId && !options.refreshUrls) {
      merged[page] = prior;
      continue;
    }
    if (!prior || prior.revisionId !== entry.revisionId || prior.url !== entry.url) changed = true;
    merged[page] = entry;
  }
  return changed ? merged : previous;
}
