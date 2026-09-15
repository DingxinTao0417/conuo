import type { SelectionToolbarPosition } from "./reader-types";

export function subscribeToStaticUserAgent() {
  // The user agent does not change during a page session. useSyncExternalStore
  // still lets a client component hydrate from the deterministic server value
  // before switching to the browser-specific presentation.
  return () => {};
}

export function getAndroidUserAgent() {
  return typeof navigator !== "undefined" && /\bAndroid\b/iu.test(navigator.userAgent);
}

export function getServerAndroidUserAgent() {
  return false;
}

export function clearReaderSearchHighlights() {
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined")
    return;
  CSS.highlights.delete("reader-search");
  CSS.highlights.delete("reader-search-current");
}

export function selectionToolbarPosition(range: Range): SelectionToolbarPosition {
  const horizontalInset = 12;
  const viewportWidth = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0);
  const measurableRange = range as Range & {
    getClientRects?: () => DOMRectList;
    getBoundingClientRect?: () => DOMRect;
  };
  const rects = measurableRange.getClientRects?.();
  const rect =
    rects?.length && rects[rects.length - 1]
      ? rects[rects.length - 1]
      : measurableRange.getBoundingClientRect?.() || {
          left: viewportWidth / 2,
          top: 72,
          width: 0,
          bottom: 72,
        };
  const center = rect.left + rect.width / 2;
  // The compact selection toolbar now has one more useful action. At phone
  // widths keep its center far enough from each edge that the fixed floating
  // bar does not start outside the visual viewport when a learner selects the
  // first or last word on a line.
  const compactToolbarHalfWidth = viewportWidth <= 560 ? 144 : 0;
  const minimumCenter = compactToolbarHalfWidth
    ? Math.min(viewportWidth - horizontalInset, compactToolbarHalfWidth + horizontalInset)
    : horizontalInset;
  const maximumCenter = compactToolbarHalfWidth
    ? Math.max(minimumCenter, viewportWidth - compactToolbarHalfWidth - horizontalInset)
    : Math.max(horizontalInset, viewportWidth - horizontalInset);
  const left = Math.min(Math.max(center, minimumCenter), maximumCenter);
  const showAbove = rect.top >= 64;
  return {
    left,
    top: showAbove ? rect.top - 8 : rect.bottom + 8,
    placement: showAbove ? "above" : "below",
  };
}
