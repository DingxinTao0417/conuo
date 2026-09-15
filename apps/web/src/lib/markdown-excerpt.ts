import type { Nodes, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Chunk, Source } from "./types";

export interface MarkdownProjectionOptions {
  /** Trusted containing reader block offsets, obtained from AST node.position. */
  rawStart?: number;
  rawEnd?: number;
}

export interface MarkdownExcerptOptions extends MarkdownProjectionOptions {
  /** UTF16 offset in this block's whitespace-compacted visible projection. */
  visibleStart?: number;
  anchorChunkId?: string;
  /** Knowledge-page excerpts require one chunk; annotations/questions do not. */
  requireSingleChunk?: boolean;
}

export type MarkdownExcerptFailureReason =
  | "invalid-input"
  | "unsupported-markdown"
  | "selection-not-found"
  | "selection-ambiguous"
  | "selection-cross-chunk"
  | "chunk-unavailable";

export interface MarkdownExcerptFailure {
  ok: false;
  reason: MarkdownExcerptFailureReason;
  message: string;
}

export interface MarkdownVisibleUnit {
  rawStart: number;
  rawEnd: number;
}

export interface MarkdownVisibleProjection {
  ok: true;
  visibleText: string;
  compactText: string;
  /** One entry per UTF16 unit of compactText; decoded entities remain atomic. */
  units: MarkdownVisibleUnit[];
  /** These intervals cannot be crossed by an excerpt, even when invisible. */
  blockedRanges: MarkdownVisibleUnit[];
}

export type MarkdownProjectionResult = MarkdownVisibleProjection | MarkdownExcerptFailure;
export type MarkdownExcerptResult =
  | MarkdownExcerptFailure
  | {
      ok: true;
      rawQuote: string;
      visibleQuote: string;
      rawStart: number;
      rawEnd: number;
      chunkId?: string;
      chunkIds: string[];
    };

type Atom = MarkdownVisibleUnit & { value: string };
type Context = { quoteDepth: number; listIndent: number };
const parser = unified().use(remarkParse).use(remarkGfm);
let cachedText: string | undefined;
let cachedTree: Root | undefined;
let cachedAtoms: Atom[] | undefined;
let cachedBlockedRanges: MarkdownVisibleUnit[] | undefined;
function treeFor(text: string): Root {
  if (cachedText !== text || !cachedTree) {
    cachedText = text;
    cachedTree = parser.parse(text);
    cachedAtoms = undefined;
    cachedBlockedRanges = undefined;
  }
  return cachedTree;
}
const compact = (text: string) => text.replace(/\s/gu, "");
const failure = (
  reason: MarkdownExcerptFailureReason,
  message: string,
): MarkdownExcerptFailure => ({ ok: false, reason, message });
const unsupported = () =>
  failure(
    "unsupported-markdown",
    "这段 Markdown 的显示文字暂无法可靠定位原文，请缩小到普通文字后重试。",
  );

function bounds(node: Nodes): MarkdownVisibleUnit | null {
  const rawStart = node.position?.start.offset;
  const rawEnd = node.position?.end.offset;
  return rawStart !== undefined && rawEnd !== undefined ? { rawStart, rawEnd } : null;
}

/** Decode a bounded reference with the exact same Markdown parser, never HTML. */
function entityValue(token: string): string {
  const root = parser.parse(token);
  const paragraph = root.children[0];
  return root.children.length === 1 &&
    paragraph?.type === "paragraph" &&
    paragraph.children.length === 1 &&
    paragraph.children[0]?.type === "text"
    ? paragraph.children[0].value
    : token;
}

function textAtoms(raw: string, start: number, context: Context, literal = false): Atom[] {
  const atoms: Atom[] = [];
  let index = 0;
  while (index < raw.length) {
    const offset = index;
    let value: string;
    if (raw[index] === "\r" || raw[index] === "\n") {
      index += raw[index] === "\r" && raw[index + 1] === "\n" ? 2 : 1;
      value = "\n";
      atoms.push({ value, rawStart: start + offset, rawEnd: start + index });
      if (!literal) {
        const prefixStart = index;
        for (let depth = 0; depth < context.quoteDepth; depth++) {
          const prefix = /^ {0,3}>[ \t]?/.exec(raw.slice(index));
          if (!prefix) break;
          index += prefix[0].length;
        }
        const remainingIndent = Math.max(0, context.listIndent - (index - prefixStart));
        const indentation = /^ */.exec(raw.slice(index))![0].length;
        index += Math.min(remainingIndent, indentation);
      }
      continue;
    }
    if (!literal && raw[index] === "\\" && /[!-/:-@\[-`{-~]/u.test(raw[index + 1] ?? "")) {
      value = raw[index + 1];
      index += 2;
    } else if (!literal && raw[index] === "&") {
      const entity = /^&(?:#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});/iu.exec(raw.slice(index));
      if (entity) {
        value = entityValue(entity[0]);
        index += entity[0].length;
      } else {
        value = raw[index];
        index++;
      }
    } else {
      value = String.fromCodePoint(raw.codePointAt(index)!);
      index += value.length;
    }
    atoms.push({ value, rawStart: start + offset, rawEnd: start + index });
  }
  return atoms;
}

function codeAtoms(
  node: Extract<Nodes, { type: "code" }>,
  text: string,
  range: MarkdownVisibleUnit,
): Atom[] | null {
  const raw = text.slice(range.rawStart, range.rawEnd);
  const lines = [...raw.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/gu)].filter((line) => line[0]);
  const opening = /^( {0,3})(`{3,}|~{3,})[^\r\n]*(?:\r\n|\r|\n|$)/u.exec(raw);
  let bodyLines = lines;
  let indentation = 4;
  if (opening) {
    indentation = opening[1].length;
    bodyLines = lines.slice(1);
    const last = bodyLines.at(-1);
    const closing = last ? /^ {0,3}(`+|~+)[ \t]*(?:\r\n|\r|\n|$)/u.exec(last[0]) : null;
    if (closing && closing[1][0] === opening[2][0] && closing[1].length >= opening[2].length)
      bodyLines = bodyLines.slice(0, -1);
  }
  const atoms = bodyLines.flatMap((line) => {
    const value = line[0];
    const spaces = /^ */u.exec(value)![0].length;
    const indent = !opening && value.startsWith("\t") ? 1 : Math.min(indentation, spaces);
    return textAtoms(
      value.slice(indent),
      range.rawStart + line.index! + indent,
      { quoteDepth: 0, listIndent: 0 },
      true,
    );
  });
  // The renderer adds its own terminal newline; AST code.value excludes it.
  while (atoms.at(-1)?.value === "\n" && atoms.map((atom) => atom.value).join("") !== node.value)
    atoms.pop();
  return atoms.map((atom) => atom.value).join("") === node.value ? atoms : null;
}

/**
 * Project source-owned AST text, preserving a UTF16 map back to exact raw
 * characters. Formatting syntax and link destinations contribute no text;
 * HTML/images/unknown nodes are barriers, never strings to strip and trust.
 */
export function projectMarkdownVisibleText(
  text: string,
  options: MarkdownProjectionOptions = {},
): MarkdownProjectionResult {
  if (typeof text !== "string")
    return failure("invalid-input", "Markdown 原文格式无效，请重新选择。");
  const start = options.rawStart ?? 0;
  const end = options.rawEnd ?? text.length;
  if (
    typeof text !== "string" ||
    (options.rawStart === undefined) !== (options.rawEnd === undefined) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end > text.length ||
    start >= end
  )
    return failure("invalid-input", "Markdown 原文定位范围无效，请重新选择。");
  const tree = treeFor(text);
  const atoms: Atom[] = [];
  const allBlockedRanges: MarkdownVisibleUnit[] = [];
  const emit = (items: Atom[]) => {
    for (const item of items) atoms.push(item);
  };
  const block = (range: MarkdownVisibleUnit) => {
    allBlockedRanges.push(range);
  };
  const visit = (node: Nodes, context: Context) => {
    const range = bounds(node);
    if (node.type === "text") {
      if (!range) return;
      const mapped = textAtoms(text.slice(range.rawStart, range.rawEnd), range.rawStart, context);
      if (mapped.map((atom) => atom.value).join("") !== node.value) block(range);
      else emit(mapped);
      return;
    }
    if (node.type === "inlineCode") {
      if (!range) return;
      const raw = text.slice(range.rawStart, range.rawEnd);
      const fence = /^`+/u.exec(raw)?.[0];
      if (!fence || !raw.endsWith(fence) || raw.length < fence.length * 2) {
        block(range);
        return;
      }
      let bodyStart = range.rawStart + fence.length;
      let body = raw.slice(fence.length, -fence.length);
      if (body.startsWith(" ") && body.endsWith(" ") && /[^ ]/u.test(body)) {
        bodyStart++;
        body = body.slice(1, -1);
      }
      const mapped = textAtoms(body, bodyStart, { quoteDepth: 0, listIndent: 0 }, true);
      if (mapped.map((atom) => atom.value).join("") !== node.value) block(range);
      else emit(mapped.map((atom) => (atom.value === "\n" ? { ...atom, value: " " } : atom)));
      return;
    }
    if (node.type === "code") {
      if (!range) return;
      const mapped = codeAtoms(node, text, range);
      if (mapped) emit(mapped);
      else block(range);
      return;
    }
    if (node.type === "break") {
      if (range) emit([{ ...range, value: "\n" }]);
      return;
    }
    if (node.type === "definition" || node.type === "thematicBreak") {
      if (range) block(range);
      return;
    }
    if (["image", "imageReference", "html"].includes(node.type)) {
      if (range) block(range);
      return;
    }
    if (
      !("children" in node) ||
      ![
        "root",
        "paragraph",
        "heading",
        "strong",
        "emphasis",
        "delete",
        "link",
        "linkReference",
        "blockquote",
        "list",
        "listItem",
        "table",
        "tableRow",
        "tableCell",
      ].includes(node.type)
    ) {
      if (range) block(range);
      return;
    }
    const next = { ...context };
    if (node.type === "blockquote") next.quoteDepth++;
    if (node.type === "listItem")
      next.listIndent = Math.max(
        context.listIndent,
        (node.children[0]?.position?.start.column ?? 1) - 1,
      );
    node.children.forEach((child) => visit(child, next));
    if (
      ["paragraph", "heading", "listItem", "tableCell", "tableRow", "code"].includes(node.type) &&
      range
    )
      emit([{ value: "\n", rawStart: range.rawEnd, rawEnd: range.rawEnd }]);
  };
  if (!cachedAtoms || !cachedBlockedRanges) {
    visit(tree, { quoteDepth: 0, listIndent: 0 });
    cachedAtoms = atoms;
    cachedBlockedRanges = allBlockedRanges;
  }
  const scopedAtoms = cachedAtoms.filter((atom) => atom.rawStart >= start && atom.rawEnd <= end);
  const blockedRanges = cachedBlockedRanges
    .filter((range) => range.rawStart < end && range.rawEnd > start)
    .map((range) => ({ ...range }));
  const units: MarkdownVisibleUnit[] = [];
  let compactText = "";
  for (const atom of scopedAtoms) {
    if (/^\s+$/u.test(atom.value)) continue;
    compactText += atom.value;
    for (let index = 0; index < atom.value.length; index++)
      units.push({ rawStart: atom.rawStart, rawEnd: atom.rawEnd });
  }
  return {
    ok: true,
    visibleText: scopedAtoms.map((atom) => atom.value).join(""),
    compactText,
    units,
    blockedRanges,
  };
}

export function sourceChunkRanges(
  source: Pick<Source, "id" | "versionId" | "text" | "chunks">,
): Array<MarkdownVisibleUnit & { chunk: Chunk }> {
  const chunks = source.chunks.filter(
    (chunk) =>
      chunk.sourceId === source.id &&
      chunk.versionId === source.versionId &&
      chunk.text &&
      Number.isSafeInteger(chunk.order) &&
      chunk.order >= 0,
  );
  const sorted = [...chunks].sort((left, right) => left.order - right.order);
  let cursor = 0;
  const ordered: Array<MarkdownVisibleUnit & { chunk: Chunk }> = [];
  let complete =
    chunks.length === source.chunks.length &&
    new Set(chunks.map((chunk) => chunk.order)).size === chunks.length;
  for (const chunk of sorted) {
    const rawStart = source.text.indexOf(chunk.text, cursor);
    if (rawStart < 0 || compact(source.text.slice(cursor, rawStart))) {
      complete = false;
      break;
    }
    cursor = rawStart + chunk.text.length;
    ordered.push({ rawStart, rawEnd: cursor, chunk });
  }
  if (complete && !compact(source.text.slice(cursor))) return ordered;
  // Partial/legacy caches need no guessed ordering: only globally unique raw
  // chunks can independently prove a position without complete coverage.
  return chunks.flatMap((chunk) => {
    const rawStart = source.text.indexOf(chunk.text);
    if (rawStart < 0 || source.text.indexOf(chunk.text, rawStart + 1) >= 0) return [];
    return [{ rawStart, rawEnd: rawStart + chunk.text.length, chunk }];
  });
}

/** Resolve visible text to verbatim current source; only knowledge excerpts require one chunk. */
export function resolveMarkdownExcerpt(
  source: Pick<Source, "id" | "versionId" | "kind" | "text" | "chunks">,
  visibleSelection: string,
  options: MarkdownExcerptOptions = {},
): MarkdownExcerptResult {
  if (
    source.kind !== "markdown" ||
    typeof visibleSelection !== "string" ||
    !visibleSelection.trim() ||
    Array.from(visibleSelection).length > 6_000 ||
    (options.visibleStart !== undefined &&
      (!Number.isSafeInteger(options.visibleStart) || options.visibleStart < 0))
  )
    return failure("invalid-input", "请从当前 Markdown 原文中选择不超过 6000 字的文字。");
  const projection = projectMarkdownVisibleText(source.text, options);
  if (!projection.ok) return projection;
  const needle = compact(visibleSelection);
  if (!needle) return failure("invalid-input", "请先选择一段原文文字。");
  let index: number;
  if (options.visibleStart !== undefined) {
    index = options.visibleStart;
    if (projection.compactText.slice(index, index + needle.length) !== needle)
      return failure("selection-not-found", "选区与当前 Markdown 原文位置不一致，请重新选择。");
  } else {
    index = projection.compactText.indexOf(needle);
    if (index >= 0 && projection.compactText.indexOf(needle, index + 1) >= 0)
      return failure("selection-ambiguous", "这段文字在原文中重复出现，请缩小选区并重新选择。");
  }
  if (index < 0)
    return projection.blockedRanges.length
      ? unsupported()
      : failure("selection-not-found", "所选文字无法在当前 Markdown 原文中核对，请重新选择。");
  const first = projection.units[index];
  const last = projection.units[index + needle.length - 1];
  if (!first || !last) return failure("selection-not-found", "所选文字无法定位原文，请重新选择。");
  const before = projection.units[index - 1];
  const after = projection.units[index + needle.length];
  if (
    (before && before.rawStart === first.rawStart && before.rawEnd === first.rawEnd) ||
    (after && after.rawStart === last.rawStart && after.rawEnd === last.rawEnd)
  )
    return unsupported();
  const rawStart = first.rawStart;
  const rawEnd = last.rawEnd;
  if (projection.blockedRanges.some((range) => range.rawStart < rawEnd && range.rawEnd > rawStart))
    return unsupported();
  const ranges = sourceChunkRanges(source);
  const matches = ranges.filter((range) => range.rawStart <= rawStart && range.rawEnd >= rawEnd);
  const candidates =
    options.anchorChunkId === undefined
      ? matches
      : matches.filter((range) => range.chunk.id === options.anchorChunkId);
  if (options.requireSingleChunk || options.anchorChunkId !== undefined) {
    if (!candidates.length)
      return failure(
        options.anchorChunkId === undefined ? "selection-cross-chunk" : "chunk-unavailable",
        "选段暂无法定位到一个当前原文片段，请缩小选区后重试。",
      );
    if (candidates.length !== 1)
      return failure("selection-ambiguous", "选段对应多个原文片段，请缩小选区后重试。");
  }
  const covering = ranges
    .filter((range) => range.rawStart < rawEnd && range.rawEnd > rawStart)
    .sort((left, right) => left.rawStart - right.rawStart);
  let coveredThrough = rawStart;
  let fullyCovered = true;
  for (const range of covering) {
    if (
      range.rawStart > coveredThrough &&
      compact(source.text.slice(coveredThrough, range.rawStart))
    ) {
      fullyCovered = false;
      break;
    }
    coveredThrough = Math.max(coveredThrough, Math.min(range.rawEnd, rawEnd));
  }
  if (compact(source.text.slice(coveredThrough, rawEnd))) fullyCovered = false;
  const chunkIds = fullyCovered ? covering.map((range) => range.chunk.id) : [];
  return {
    ok: true,
    rawQuote: source.text.slice(rawStart, rawEnd),
    visibleQuote: visibleSelection.trim(),
    rawStart,
    rawEnd,
    ...(candidates.length === 1 ? { chunkId: candidates[0].chunk.id } : {}),
    chunkIds,
  };
}
