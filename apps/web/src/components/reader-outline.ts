import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { DocxBlock } from "@/lib/docx-structure";
import type { Source } from "@/lib/types";

const markdownOutlineParser = unified().use(remarkParse).use(remarkGfm);
const GENERIC_CHUNK_SECTIONS = new Set(["正文"]);

type MarkdownNode = {
  type?: unknown;
  value?: unknown;
  alt?: unknown;
  depth?: unknown;
  children?: unknown;
  position?: {
    start?: { offset?: unknown };
    end?: { offset?: unknown };
  };
};

export interface ReaderOutlineItem {
  /** Stable for the immutable source text currently displayed in the reader. */
  id: string;
  title: string;
  /** Heading nesting when it comes from Markdown; chunk sections are top-level. */
  level: number;
  /** Exact saved text used to locate the item in the normalized reader DOM. */
  locator: string;
  kind: "markdown-heading" | "docx-heading" | "chunk-section";
  /** Exact source-text offset for Markdown headings, never inferred from prose. */
  sourceOffset?: number;
  /** Lets the reader distinguish repeated visible Markdown headings. */
  headingOccurrence?: number;
}

function isMarkdownNode(value: unknown): value is MarkdownNode {
  return !!value && typeof value === "object";
}

function markdownNodeText(node: unknown): string {
  if (!isMarkdownNode(node)) return "";
  if (node.type === "image" && typeof node.alt === "string") return node.alt;
  const value = typeof node.value === "string" ? node.value : "";
  const children = Array.isArray(node.children) ? node.children.map(markdownNodeText).join("") : "";
  return value || children;
}

/** Match browser heading text without inventing a second interpretation of a title. */
export function normalizeReaderOutlineTitle(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeLocatorText(value: string): string {
  return value.replace(/\s/gu, "");
}

/**
 * Chunk metadata has no source offset. Do not expose it as a jump target when
 * the retained chunk text occurs more than once in this exact saved document.
 */
function hasUniqueSourceLocator(sourceText: string, locator: string): boolean {
  const needle = normalizeLocatorText(locator);
  if (!needle) return false;
  const haystack = normalizeLocatorText(sourceText);
  const first = haystack.indexOf(needle);
  return first !== -1 && haystack.indexOf(needle, first + 1) === -1;
}

function markdownHeadings(source: Source): ReaderOutlineItem[] {
  if (source.kind !== "markdown" && source.kind !== "web") return [];
  const items: ReaderOutlineItem[] = [];
  const occurrences = new Map<string, number>();

  const visit = (value: unknown) => {
    if (!isMarkdownNode(value)) return;
    if (value.type === "heading" && typeof value.depth === "number") {
      const title = normalizeReaderOutlineTitle(markdownNodeText(value));
      const start = value.position?.start?.offset;
      const end = value.position?.end?.offset;
      // Positions come from the saved Markdown AST. Skip an incomplete node
      // instead of manufacturing a locator from arbitrary rendered prose.
      if (
        title &&
        typeof start === "number" &&
        typeof end === "number" &&
        start >= 0 &&
        end > start
      ) {
        const occurrence = occurrences.get(title) || 0;
        occurrences.set(title, occurrence + 1);
        items.push({
          id: `markdown:${start}`,
          title,
          level: Math.max(1, Math.min(6, value.depth)),
          locator: source.text.slice(start, end),
          kind: "markdown-heading",
          sourceOffset: start,
          headingOccurrence: occurrence,
        });
      }
    }
    if (Array.isArray(value.children)) value.children.forEach(visit);
  };

  try {
    visit(markdownOutlineParser.parse(source.text));
  } catch {
    // A malformed Markdown document remains readable. It simply does not get
    // a directory unless retained chunk metadata provides one below.
  }
  return items;
}

function chunkSections(source: Source): ReaderOutlineItem[] {
  const seen = new Set<string>();
  return [...source.chunks]
    .sort((left, right) => left.order - right.order)
    .flatMap((chunk) => {
      const title = normalizeReaderOutlineTitle(chunk.section);
      const key = title.toLocaleLowerCase();
      if (
        !title ||
        GENERIC_CHUNK_SECTIONS.has(title) ||
        seen.has(key) ||
        !hasUniqueSourceLocator(source.text, chunk.text)
      )
        return [];
      seen.add(key);
      return [
        {
          id: `chunk:${chunk.id}`,
          title,
          level: 1,
          locator: chunk.text,
          kind: "chunk-section" as const,
        },
      ];
    });
}

function docxHeadings(blocks: DocxBlock[]): ReaderOutlineItem[] {
  return blocks.flatMap((block) => {
    if (block.type !== "heading") return [];
    return [
      {
        id: `docx:${block.id}`,
        title: block.text,
        level: block.level,
        locator: block.text,
        kind: "docx-heading" as const,
      },
    ];
  });
}

/**
 * Derive a read-only reader directory from saved document structure only.
 * Markdown headings take precedence because their source offsets are exact;
 * otherwise retained chunk.section metadata provides the available sections.
 */
export function deriveReaderOutline(
  source: Source,
  docxBlocks?: DocxBlock[] | null,
): ReaderOutlineItem[] {
  if (source.kind === "pdf") return [];
  if (source.kind === "docx" && docxBlocks) {
    const headings = docxHeadings(docxBlocks);
    if (headings.length) return headings;
  }
  const headings = markdownHeadings(source);
  return headings.length ? headings : chunkSections(source);
}
