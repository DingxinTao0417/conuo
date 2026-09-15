import type { Annotation, Source } from "@/lib/types";
import { projectMarkdownVisibleText, sourceChunkRanges } from "@/lib/markdown-excerpt";
import { annotationTextAnchorMatches } from "@/lib/annotations";

type TextAnchor = { start: number; end: number };
type Unit = { rawStart: number; rawEnd: number };
const compact = (text: string) => text.replace(/\s/gu, "");

/** Page identity needs retained, ordered page text; a first similar chunk proves nothing. */
function pageRange(source: Source, page: number): TextAnchor | null {
  const expected = source.chunks.filter((chunk) => chunk.page === page);
  const all = sourceChunkRanges(source);
  const ranges = all
    .filter((range) => range.chunk.page === page)
    .sort((a, b) => a.rawStart - b.rawStart);
  if (!expected.length || ranges.length !== expected.length) return null;
  const start = ranges[0].rawStart;
  let end = start;
  for (const range of ranges) {
    if (range.rawStart < end || compact(source.text.slice(end, range.rawStart))) return null;
    end = range.rawEnd;
  }
  if (
    all.some((range) => range.chunk.page !== page && range.rawStart < end && range.rawEnd > start)
  )
    return null;
  return { start, end };
}

function projection(source: Source, scope: TextAnchor) {
  if (source.kind === "markdown" || source.kind === "web") {
    const projected = projectMarkdownVisibleText(source.text, {
      rawStart: scope.start,
      rawEnd: scope.end,
    });
    return projected.ok ? projected : null;
  }
  let compactText = "";
  const units: Unit[] = [];
  for (let offset = scope.start; offset < scope.end;) {
    const character = String.fromCodePoint(source.text.codePointAt(offset)!);
    if (!/\s/u.test(character)) {
      compactText += character;
      for (let index = 0; index < character.length; index++)
        units.push({ rawStart: offset, rawEnd: offset + character.length });
    }
    offset += character.length;
  }
  return { compactText, units, blockedRanges: [] as Unit[] };
}

function textNodes(container: Node) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let text = "";
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest(".reader-image-placeholder, button, [aria-hidden='true']"))
      continue;
    nodes.push(node);
    text += node.data;
  }
  return { nodes, text };
}

function ownedTextBody(source: Source, element: Element) {
  const body = element.closest<HTMLElement>("[data-reader-text]");
  if (
    body?.dataset.readerText !== "true" ||
    body.dataset.readerSourceId !== source.id ||
    body.dataset.readerSourceVersion !== source.versionId
  )
    return null;
  return body;
}

function physicalPdfPage(source: Source, body: HTMLElement): number | undefined {
  const page = Number(body.dataset.readerPage);
  return Number.isSafeInteger(page) &&
    page >= 1 &&
    (source.pageCount === undefined || page <= source.pageCount)
    ? page
    : undefined;
}

function ownedBody(source: Source, element: Element) {
  const body = ownedTextBody(source, element);
  if (!body) return null;
  if (source.kind === "pdf" && body.classList.contains("textLayer")) {
    const page = physicalPdfPage(source, body);
    if (page === undefined) return null;
    const scope = pageRange(source, page);
    return scope ? { body, scope, page } : null;
  }
  return { body, scope: { start: 0, end: source.text.length }, page: undefined };
}

function rangeElement(node: Node) {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function readOwnedSelection(source: Source, range: Range) {
  const start = rangeElement(range.startContainer);
  const end = rangeElement(range.endContainer);
  const owned = start && ownedBody(source, start);
  const endOwned = end && ownedBody(source, end);
  if (!owned || !endOwned || owned.body !== endOwned.body) return null;
  const projected = projection(source, owned.scope);
  if (!projected || compact(textNodes(owned.body).text) !== projected.compactText) return null;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(owned.body);
  prefix.setEnd(range.startContainer, range.startOffset);
  const index = compact(textNodes(prefix.cloneContents()).text).length;
  const selected = compact(range.toString());
  if (!selected || projected.compactText.slice(index, index + selected.length) !== selected)
    return null;
  const first = projected.units[index];
  const last = projected.units[index + selected.length - 1];
  const before = projected.units[index - 1];
  const after = projected.units[index + selected.length];
  if (
    !first ||
    !last ||
    (before && before.rawStart === first.rawStart && before.rawEnd === first.rawEnd) ||
    (after && after.rawStart === last.rawStart && after.rawEnd === last.rawEnd)
  )
    return null;
  const textAnchor = { start: first.rawStart, end: last.rawEnd };
  return {
    quote: source.text.slice(textAnchor.start, textAnchor.end),
    textAnchor,
    page: owned.page,
  };
}

/** Canonical raw text and its exact native position, including PDF layout whitespace. */
export function readPlainAnnotationSelection(source: Source, range: Range) {
  const selected = readOwnedSelection(source, range);
  return selected ? { quote: selected.quote, textAnchor: selected.textAnchor } : null;
}

/** A native PDF selection proves its physical page, independently of the visible page. */
export function readNativePdfSelectionPage(source: Source, range: Range): number | undefined {
  if (source.kind !== "pdf") return undefined;
  const start = rangeElement(range.startContainer);
  const end = rangeElement(range.endContainer);
  const startBody = start && ownedTextBody(source, start);
  const endBody = end && ownedTextBody(source, end);
  if (!startBody || startBody !== endBody || !startBody.classList.contains("textLayer"))
    return undefined;
  // Physical renderer identity does not require extraction/retention to have completed.
  // Exact source offsets remain the separate responsibility of readPlainAnnotationSelection.
  return physicalPdfPage(source, startBody);
}

function lowerBound(units: Unit[], offset: number, field: "rawStart" | "rawEnd") {
  let low = 0,
    high = units.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (units[middle][field] < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function bodyRangeResolver(
  candidate: HTMLElement,
  source: Source,
): (annotation: Annotation) => Range | null {
  const owned = ownedBody(source, candidate);
  if (!owned) return () => null;
  const projected = projection(source, owned.scope);
  const retained = textNodes(owned.body);
  if (!projected || compact(retained.text) !== projected.compactText) return () => null;
  const domUnits: { node: Text; offset: number }[] = [];
  for (const node of retained.nodes) {
    for (let offset = 0; offset < node.length; offset++)
      if (!/\s/u.test(node.data[offset])) domUnits.push({ node, offset });
  }
  const legacyScopes = new Map<string, { text: string; units: number[] }>();
  const pages = new Map<number, TextAnchor | null>();
  return (annotation: Annotation): Range | null => {
    if (annotation.sourceId !== source.id || annotation.versionId !== source.versionId) return null;
    const current = ownedBody(source, owned.body);
    if (!current || current.page !== owned.page) return null;
    if (
      annotation.textAnchor !== undefined &&
      !annotationTextAnchorMatches(source.text, annotation)
    )
      return null;
    let anchor = annotation.textAnchor;
    // Without a retained physical page, an old quote must be unique in the whole source.
    // Rendering only one of two identical PDF pages must not manufacture uniqueness.
    let legacyScope =
      owned.page === undefined ? owned.scope : { start: 0, end: source.text.length };
    if (annotation.page !== undefined) {
      if (!pages.has(annotation.page))
        pages.set(annotation.page, pageRange(source, annotation.page));
      const expectedPage = pages.get(annotation.page);
      if (!expectedPage || (owned.page !== undefined && owned.page !== annotation.page))
        return null;
      if (anchor && (anchor.start < expectedPage.start || anchor.end > expectedPage.end))
        return null;
      legacyScope = expectedPage;
    }
    if (anchor !== undefined) {
      if (
        !Number.isSafeInteger(anchor.start) ||
        !Number.isSafeInteger(anchor.end) ||
        anchor.start < owned.scope.start ||
        anchor.end > owned.scope.end ||
        anchor.start >= anchor.end ||
        source.text.slice(anchor.start, anchor.end) !== annotation.quote
      )
        return null;
    } else {
      // Old records can be located only when their original text is unique in the retained scope.
      const scopeKey = `${legacyScope.start}:${legacyScope.end}`;
      if (!legacyScopes.has(scopeKey)) {
        const scopedSource = source.text.slice(legacyScope.start, legacyScope.end);
        const units: number[] = [];
        let text = "";
        for (let index = 0; index < scopedSource.length; index++) {
          if (!/\s/u.test(scopedSource[index])) {
            text += scopedSource[index];
            units.push(legacyScope.start + index);
          }
        }
        legacyScopes.set(scopeKey, { text, units });
      }
      const { text, units } = legacyScopes.get(scopeKey)!;
      const needle = compact(annotation.quote);
      const index = needle ? text.indexOf(needle) : -1;
      if (index < 0 || text.indexOf(needle, index + 1) >= 0) return null;
      anchor = { start: units[index], end: units[index + needle.length - 1] + 1 };
    }
    if (anchor.start < owned.scope.start || anchor.end > owned.scope.end) return null;
    if (
      projected.blockedRanges.some(
        (unit) => unit.rawStart < anchor.end && unit.rawEnd > anchor.start,
      )
    )
      return null;
    const first = lowerBound(projected.units, anchor.start, "rawEnd");
    // rawEnd is exclusive; skip any preceding unit that ends exactly at the anchor.
    let from = first;
    while (from < projected.units.length && projected.units[from].rawEnd <= anchor.start) from++;
    const to = lowerBound(projected.units, anchor.end, "rawStart");
    if (
      from >= to ||
      projected.units[from].rawStart < anchor.start ||
      projected.units[to - 1].rawEnd > anchor.end
    )
      return null;
    const nativeStart = domUnits[from],
      nativeEnd = domUnits[to - 1];
    if (
      !nativeStart ||
      !nativeEnd ||
      !owned.body.contains(nativeStart.node) ||
      !owned.body.contains(nativeEnd.node) ||
      compact(textNodes(owned.body).text) !== projected.compactText
    )
      return null;
    const range = document.createRange();
    range.setStart(nativeStart.node, nativeStart.offset);
    range.setEnd(nativeEnd.node, nativeEnd.offset + 1);
    return range;
  };
}

/** Prove each mounted page once; never fall back from a missing page to similar text. */
export function annotationRangeResolver(
  container: HTMLElement,
  source: Source,
): (annotation: Annotation) => Range | null {
  const candidates = [...container.querySelectorAll<HTMLElement>("[data-reader-text]")];
  if (container.matches("[data-reader-text]")) candidates.unshift(container);
  const resolvers = candidates.map((candidate) => bodyRangeResolver(candidate, source));
  return (annotation) => {
    let resolved: Range | null = null;
    for (const resolve of resolvers) {
      const range = resolve(annotation);
      if (!range) continue;
      // Multiple owned projections claiming the same annotation are insufficient proof.
      if (resolved) return null;
      resolved = range;
    }
    return resolved;
  };
}
