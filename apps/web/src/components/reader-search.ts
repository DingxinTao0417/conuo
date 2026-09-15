/**
 * Locate all visible reader-body matches without treating reader chrome,
 * document metadata, or action labels as source text. This deliberately uses
 * ordinary text matching rather than the whitespace-tolerant citation matcher:
 * a reader search should reflect what is visibly written in the document.
 */
export function readerSearchRoot(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>("[data-reader-text]") ?? container;
}

type TextSegment = {
  node: Text;
  start: number;
  end: number;
};

function visibleTextSegments(container: HTMLElement): { text: string; segments: TextSegment[] } {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const segments: TextSegment[] = [];
  let text = "";
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest("button, [aria-hidden='true']")) continue;
    const value = node.textContent || "";
    if (!value) continue;
    segments.push({ node, start: text.length, end: text.length + value.length });
    text += value;
  }
  return { text, segments };
}

function rangeAt(segments: TextSegment[], start: number, end: number): Range | null {
  const first = segments.find((segment) => start >= segment.start && start < segment.end);
  const last = segments.find((segment) => end > segment.start && end <= segment.end);
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, start - first.start);
  range.setEnd(last.node, end - last.start);
  return range;
}

/**
 * Returns non-overlapping ranges in reading order. Matching ignores case for
 * Latin text but preserves the exact source characters in each returned range.
 */
export function findReaderSearchRanges(container: HTMLElement, query: string): Range[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const { text, segments } = visibleTextSegments(container);
  const haystack = text.toLowerCase();
  const ranges: Range[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const start = haystack.indexOf(needle, from);
    if (start < 0) break;
    const range = rangeAt(segments, start, start + needle.length);
    if (range) ranges.push(range);
    from = start + needle.length;
  }
  return ranges;
}
