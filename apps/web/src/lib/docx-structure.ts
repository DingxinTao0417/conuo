import type { Element, Nodes, RootContent } from "hast";
import rehypeParse from "rehype-parse";
import { unified } from "unified";
import type { Chunk } from "./types";

export type DocxBlock =
  | { type: "heading"; id: string; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | {
      type: "table";
      rows: Array<Array<{ text: string; header: boolean }>>;
      unreliableLayout?: true;
    };

export interface DocxStructureResult {
  blocks: DocxBlock[];
  messages: string[];
}

const htmlParser = unified().use(rehypeParse, { fragment: true });
const blockedElements = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "svg",
  "math",
]);

function isElement(node: Nodes): node is Element {
  return node.type === "element";
}

function plainText(node: Nodes): string {
  if (node.type === "text") return node.value;
  if (!isElement(node) || blockedElements.has(node.tagName)) return "";
  if (node.tagName === "br") return "\n";
  const text = node.children.map((child) => plainText(child)).join("");
  // Paragraph boundaries inside a cell/list item separate words too.
  return node.tagName === "p" ? `${text}\n` : text;
}

function normalizeInlineText(value: string): string {
  return value
    .replace(/\u00a0/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function descendants(
  root: Element,
  tagName: string,
  stopAt: ReadonlySet<string> = new Set(),
): Element[] {
  const matches: Element[] = [];
  const visit = (node: RootContent) => {
    if (!isElement(node)) return;
    if (node.tagName === tagName) {
      matches.push(node);
      return;
    }
    if (stopAt.has(node.tagName)) return;
    node.children.forEach(visit);
  };
  root.children.forEach(visit);
  return matches;
}

function parseTable(table: Element): Extract<DocxBlock, { type: "table" }> | null {
  let unreliableLayout = descendants(table, "table").length > 0;
  const rows = descendants(table, "tr", new Set(["table"])).flatMap((row) => {
    const cells = row.children.flatMap((node) => {
      if (!isElement(node) || (node.tagName !== "td" && node.tagName !== "th")) return [];
      if (Number(node.properties.colSpan ?? 1) !== 1 || Number(node.properties.rowSpan ?? 1) !== 1)
        unreliableLayout = true;
      return [
        {
          text: normalizeInlineText(plainText(node)),
          header: node.tagName === "th",
        },
      ];
    });
    return cells.length ? [cells] : [];
  });
  return rows.length
    ? { type: "table", rows, ...(unreliableLayout ? { unreliableLayout: true as const } : {}) }
    : null;
}

function parseList(list: Element): Extract<DocxBlock, { type: "list" }> | null {
  const items = list.children.flatMap((node) => {
    if (!isElement(node) || node.tagName !== "li") return [];
    const text = normalizeInlineText(plainText(node));
    return text ? [text] : [];
  });
  return items.length ? { type: "list", ordered: list.tagName === "ol", items } : null;
}

/**
 * Mammoth explicitly does not sanitize its HTML. Parse it as data and retain
 * only the document structures that this reader owns; no HTML or attributes
 * from the file cross the boundary into React.
 */
export function parseDocxHtml(html: string): DocxBlock[] {
  const root = htmlParser.parse(html);
  const blocks: DocxBlock[] = [];
  let headingIndex = 0;

  const visit = (node: RootContent) => {
    if (node.type === "text") {
      const text = normalizeInlineText(node.value);
      if (text) blocks.push({ type: "paragraph", text });
      return;
    }
    if (!isElement(node) || blockedElements.has(node.tagName)) return;
    const heading = node.tagName.match(/^h([1-6])$/u);
    if (heading) {
      const text = normalizeInlineText(plainText(node));
      if (text) {
        blocks.push({
          type: "heading",
          id: `docx-heading-${headingIndex++}`,
          level: Number(heading[1]),
          text,
        });
      }
      return;
    }
    if (node.tagName === "p" || node.tagName === "blockquote") {
      const text = normalizeInlineText(plainText(node));
      if (text) blocks.push({ type: "paragraph", text });
      return;
    }
    if (node.tagName === "table") {
      const table = parseTable(node);
      if (table) blocks.push(table);
      return;
    }
    if (node.tagName === "ul" || node.tagName === "ol") {
      const list = parseList(node);
      if (list) blocks.push(list);
      return;
    }
    node.children.forEach(visit);
  };

  root.children.forEach(visit);
  return blocks;
}

/** Convert an original DOCX to the reader's restricted, text-only structure. */
export async function convertDocxToStructure(
  arrayBuffer: ArrayBuffer,
): Promise<DocxStructureResult> {
  const mammoth = await import("mammoth");
  const result = await mammoth.convertToHtml(
    { arrayBuffer },
    {
      externalFileAccess: false,
      includeEmbeddedStyleMap: false,
      convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
    },
  );
  return {
    blocks: parseDocxHtml(result.value),
    messages: result.messages.map((message) => message.message),
  };
}

function blockTextSegments(block: DocxBlock): string[] {
  if (block.type === "table") return block.rows.flatMap((row) => row.map((cell) => cell.text));
  if (block.type === "list") return block.items;
  return [block.text];
}

function normalizedTextWithOffsets(value: string) {
  let text = "";
  const offsets: number[] = [];
  for (let index = 0; index < value.length; index++) {
    if (/\s/u.test(value[index])) continue;
    text += value[index];
    offsets.push(index);
  }
  return { text, offsets };
}

export interface DocxTableEvidenceRange {
  start: number;
  end: number;
  sectionSuffix: string;
}

/**
 * Map only confirmed, rectangular tables to contiguous retained raw spans.
 * A group always contains complete rows and never exceeds the ordinary chunk
 * limit. Column context is bounded metadata, never text stitched into a quote.
 */
export function docxTableEvidenceRanges(
  sourceText: string,
  blocks: DocxBlock[],
  maxChunkSize: number,
): { ranges: DocxTableEvidenceRange[]; messages: string[] } {
  const normalized = normalizedTextWithOffsets(sourceText);
  const ranges: DocxTableEvidenceRange[] = [];
  const messages: string[] = [];
  let cursor = 0;
  let aligned = true;
  let tableNumber = 0;
  let failedTables = 0;

  for (const block of blocks) {
    const compact = blockTextSegments(block).join("").replace(/\s/gu, "");
    const matches = aligned && normalized.text.startsWith(compact, cursor);
    const at = cursor;
    if (matches) cursor += compact.length;
    else aligned = false;
    if (block.type !== "table") continue;
    tableNumber += 1;
    const columns = block.rows[0]?.length ?? 0;
    let failure = "";
    if (!matches) failure = "结构与原文位置无法可靠对应";
    else if (
      block.unreliableLayout ||
      !columns ||
      block.rows.some((row) => row.length !== columns || row.some((cell) => !cell.text.trim()))
    )
      failure = "含合并、嵌套、不规则或空单元格";

    const rows: Array<{ start: number; end: number }> = [];
    let rowCursor = at;
    if (!failure) {
      for (const row of block.rows) {
        const length = row
          .map((cell) => cell.text)
          .join("")
          .replace(/\s/gu, "").length;
        const start = normalized.offsets[rowCursor];
        const end = normalized.offsets[rowCursor + length - 1] + 1;
        if (end - start > maxChunkSize) {
          failure = "单行超过证据块容量";
          break;
        }
        rows.push({ start, end });
        rowCursor += length;
      }
    }
    if (failure) {
      failedTables += 1;
      if (messages.length < 30)
        messages.push(
          `第 ${tableNumber} 个表格${failure}；已保留可检索文字，问答暂不保证该表格的行列关系。`,
        );
      continue;
    }

    // Do not infer that the first row is a header. Preserve its actual ordered
    // column texts, with an explicit truncation marker for long cell content.
    const perColumnLimit = Math.max(1, Math.floor(280 / columns) - 8);
    const firstRow = block.rows[0]
      .slice(0, 16)
      .map((cell, index) => {
        const text = cell.text.slice(0, perColumnLimit);
        return `${index + 1}:“${text}${text.length < cell.text.length ? "…" : ""}”`;
      })
      .join("；");
    const columnContext = `首行各列${columns > 16 ? "（前 16 列）" : ""}：${firstRow}`;
    let first = 0;
    while (first < rows.length) {
      let last = first;
      while (last + 1 < rows.length && rows[last + 1].end - rows[first].start <= maxChunkSize)
        last += 1;
      ranges.push({
        start: rows[first].start,
        end: rows[last].end,
        sectionSuffix: `表格 ${tableNumber} · 第 ${first + 1}–${last + 1} 行 · ${columns} 列；${columnContext}`,
      });
      first = last + 1;
    }
  }
  if (failedTables > 30)
    messages.push(`另有 ${failedTables - 30} 个表格无法可靠保留行列关系；已保留其可检索文字。`);
  return { ranges, messages };
}

/**
 * Match converted headings back to the retained raw text in document order.
 * Only existing chunk metadata changes; chunk text and IDs stay byte-for-byte
 * compatible with retrieval, citations, backup and current schema validation.
 */
export function applyDocxSections(
  chunks: Chunk[],
  sourceText: string,
  blocks: DocxBlock[],
): Chunk[] {
  const normalizedSource = normalizedTextWithOffsets(sourceText);
  const anchors: Array<{ offset: number; title: string }> = [];
  let normalizedCursor = 0;

  for (const block of blocks) {
    for (const segment of blockTextSegments(block)) {
      const needle = segment.replace(/\s/gu, "");
      if (!needle) continue;
      const at = normalizedSource.text.indexOf(needle, normalizedCursor);
      if (at === -1) continue;
      if (block.type === "heading") {
        anchors.push({ offset: normalizedSource.offsets[at], title: block.text });
      }
      normalizedCursor = at + needle.length;
    }
  }
  if (!anchors.length) return chunks;

  let sourceCursor = 0;
  let anchorIndex = 0;
  let section = "正文";
  return chunks.map((chunk) => {
    const start = sourceText.indexOf(chunk.text, sourceCursor);
    if (start === -1) return { ...chunk, section };
    const end = start + chunk.text.length;
    sourceCursor = end;
    while (anchorIndex < anchors.length && anchors[anchorIndex].offset < end) {
      section = anchors[anchorIndex].title;
      anchorIndex += 1;
    }
    return { ...chunk, section };
  });
}
