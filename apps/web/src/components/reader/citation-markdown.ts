import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { answerNoteMarkerIndex, extractiveCitationMarkerIndex } from "@/lib/citation-markers";
import type { AnswerNoteEvidence, Citation, Message } from "@/lib/types";

const CITATION_HREF_PREFIX = "#conuo-citation-";
const CITATION_HREF_PATTERN = /^#conuo-citation-([1-9]\d*)$/u;
const NOTE_EVIDENCE_HREF_PREFIX = "#conuo-note-";
const NOTE_EVIDENCE_HREF_PATTERN = /^#conuo-note-([1-9]\d*)$/u;
const citationMarkdownParser = unified().use(remarkParse).use(remarkGfm);
const citationMarkerIndexCache = new WeakMap<
  Citation[],
  WeakMap<AnswerNoteEvidence[], Map<string, EvidenceMarkerIndexes>>
>();

type MarkdownTreeNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownTreeNode[];
};

export function citationLocation(citation: Citation) {
  return citation.page ? `第 ${citation.page} 页` : citation.section || "原文片段";
}

export function citationCardId(messageId: string, index: number) {
  return `reader-citation-${messageId.replace(/[^a-zA-Z0-9_-]/g, "-")}-${index + 1}`;
}

export function citationKey(messageId: string, index: number) {
  return `source:${messageId}:${index}`;
}

export function noteEvidenceCardId(messageId: string, index: number) {
  return `reader-note-evidence-${messageId.replace(/[^a-zA-Z0-9_-]/g, "-")}-${index + 1}`;
}

export function noteEvidenceKey(messageId: string, index: number) {
  return `note:${messageId}:${index}`;
}

export function citationIndexFromHref(href?: string) {
  const match = href ? CITATION_HREF_PATTERN.exec(href) : null;
  if (!match) return null;
  const index = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(index) && index > 0 ? index - 1 : null;
}

export function noteEvidenceIndexFromHref(href?: string) {
  const match = href ? NOTE_EVIDENCE_HREF_PATTERN.exec(href) : null;
  if (!match) return null;
  const index = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(index) && index > 0 ? index - 1 : null;
}

function isMarkdownTreeNode(value: unknown): value is MarkdownTreeNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

interface CitationReferenceOptions {
  allowInlineMarkers: boolean;
  allowExtractiveMetadata: boolean;
}

interface EvidenceMarkerIndexes {
  citations: ReadonlySet<number>;
  notes: ReadonlySet<number>;
}

function citationReferenceOptions(mode: Message["mode"]): CitationReferenceOptions {
  return {
    // Older conversations do not have a mode. Preserve their historical inline marker behavior.
    allowInlineMarkers: mode !== "extractive",
    // The legacy extractive heading remains readable after the formatter migration.
    allowExtractiveMetadata: mode !== "model",
  };
}

/** Turns verified answer markers into safe, local evidence links for ReactMarkdown. */
export function createRemarkCitationReferences(
  citations: Citation[],
  noteEvidence: AnswerNoteEvidence[],
  mode: Message["mode"],
) {
  const options = citationReferenceOptions(mode);
  return function remarkCitationReferences() {
    return (tree: unknown) => {
      if (!isMarkdownTreeNode(tree)) return;
      rewriteCitationReferences(tree, citations, noteEvidence, options);
    };
  };
}

function markdownNodeText(node: MarkdownTreeNode): string {
  if (typeof node.value === "string") return node.value;
  return node.children?.map(markdownNodeText).join("") || "";
}

function citationMetadataIndex(
  node: MarkdownTreeNode,
  citations: Citation[],
  allowExtractiveMetadata: boolean,
) {
  if (node.type !== "strong" || !allowExtractiveMetadata) return -1;
  const text = markdownNodeText(node).trim();
  const controlledIndex = extractiveCitationMarkerIndex(text);
  if (controlledIndex !== null) return citations[controlledIndex] ? controlledIndex : -1;
  return citations.findIndex(
    (citation, index) =>
      text.startsWith(`[${index + 1}] `) && text.endsWith(` · ${citationLocation(citation)}`),
  );
}

function noteEvidenceMetadataIndex(node: MarkdownTreeNode, noteEvidence: AnswerNoteEvidence[]) {
  if (node.type !== "strong") return -1;
  const index = answerNoteMarkerIndex(markdownNodeText(node));
  return index !== null && noteEvidence[index] ? index : -1;
}

function rewriteCitationReferences(
  node: MarkdownTreeNode,
  citations: Citation[],
  noteEvidence: AnswerNoteEvidence[],
  options: CitationReferenceOptions,
  insideLink = false,
  converted: { citations: Set<number>; notes: Set<number> } = {
    citations: new Set<number>(),
    notes: new Set<number>(),
  },
) {
  if (!node.children) return converted;
  const skipChildren =
    insideLink ||
    node.type === "link" ||
    node.type === "linkReference" ||
    node.type === "definition";
  const nextChildren: MarkdownTreeNode[] = [];

  for (const child of node.children) {
    const metadataIndex = skipChildren
      ? -1
      : citationMetadataIndex(child, citations, options.allowExtractiveMetadata);
    if (metadataIndex !== -1) {
      converted.citations.add(metadataIndex);
      nextChildren.push({
        type: "link",
        url: `${CITATION_HREF_PREFIX}${metadataIndex + 1}`,
        children: [{ type: "text", value: `[${metadataIndex + 1}]` }],
      });
      continue;
    }
    const noteIndex = skipChildren ? -1 : noteEvidenceMetadataIndex(child, noteEvidence);
    if (noteIndex !== -1) {
      converted.notes.add(noteIndex);
      nextChildren.push({
        type: "link",
        url: `${NOTE_EVIDENCE_HREF_PREFIX}${noteIndex + 1}`,
        children: [{ type: "text", value: `[我的笔记 ${noteIndex + 1}]` }],
      });
      continue;
    }
    if (
      options.allowInlineMarkers &&
      !skipChildren &&
      child.type === "text" &&
      typeof child.value === "string"
    ) {
      const matches = [...child.value.matchAll(/\[(\d+)\]/gu)];
      if (!matches.length) {
        nextChildren.push(child);
        continue;
      }

      let cursor = 0;
      for (const match of matches) {
        const marker = match[0];
        const start = match.index ?? 0;
        const citationIndex = Number.parseInt(match[1], 10) - 1;
        if (start > cursor)
          nextChildren.push({ type: "text", value: child.value.slice(cursor, start) });
        nextChildren.push({
          type: "link",
          url: `${CITATION_HREF_PREFIX}${match[1]}`,
          children: [{ type: "text", value: marker }],
        });
        if (Number.isSafeInteger(citationIndex) && citations[citationIndex]) {
          converted.citations.add(citationIndex);
        }
        cursor = start + marker.length;
      }
      if (cursor < child.value.length)
        nextChildren.push({ type: "text", value: child.value.slice(cursor) });
      continue;
    }

    rewriteCitationReferences(child, citations, noteEvidence, options, skipChildren, converted);
    nextChildren.push(child);
  }
  node.children = nextChildren;
  return converted;
}

export function citationMarkerIndexes(
  content: string,
  citations: Citation[],
  noteEvidence: AnswerNoteEvidence[],
  mode: Message["mode"],
): EvidenceMarkerIndexes {
  const options = citationReferenceOptions(mode);
  const cacheKey = `${options.allowInlineMarkers ? "i" : "-"}${
    options.allowExtractiveMetadata ? "m" : "-"
  }:${content}`;
  let noteCaches = citationMarkerIndexCache.get(citations);
  if (!noteCaches) {
    noteCaches = new WeakMap();
    citationMarkerIndexCache.set(citations, noteCaches);
  }
  let cache = noteCaches.get(noteEvidence);
  if (!cache) {
    cache = new Map();
    noteCaches.set(noteEvidence, cache);
  }
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const tree = citationMarkdownParser.parse(content);
  const indexes = rewriteCitationReferences(
    tree as unknown as MarkdownTreeNode,
    citations,
    noteEvidence,
    options,
  );
  cache.set(cacheKey, indexes);
  return indexes;
}
