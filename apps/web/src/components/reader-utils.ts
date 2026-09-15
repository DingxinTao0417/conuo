import type { Citation, Source } from "@/lib/types";
import { getSourceVersion } from "@/lib/source-versions";
import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";

const markdownQuoteParser = unified().use(remarkParse).use(remarkGfm);

type MarkdownQuoteNode = {
  type?: unknown;
  value?: unknown;
  alt?: unknown;
  children?: unknown;
};

function isMarkdownQuoteNode(value: unknown): value is MarkdownQuoteNode {
  return !!value && typeof value === "object";
}

/**
 * A citation keeps its byte-for-byte source excerpt, including Markdown
 * syntax. ReactMarkdown does not render that syntax, so derive a second,
 * display-only candidate when locating the same immutable excerpt in the DOM.
 */
function renderedMarkdownText(markdown: string): string {
  try {
    const parts: string[] = [];
    const visit = (node: unknown) => {
      if (!isMarkdownQuoteNode(node)) return;
      if (node.type === "image" && typeof node.alt === "string") {
        parts.push(node.alt);
        return;
      }
      if (
        typeof node.value === "string" &&
        ["text", "inlineCode", "code"].includes(String(node.type))
      )
        parts.push(node.value);
      if (Array.isArray(node.children)) node.children.forEach(visit);
    };
    visit(markdownQuoteParser.parse(markdown));
    return parts.join("\n");
  } catch {
    return "";
  }
}

/** Citation identity is immutable: never silently move a quote to a newer version. */
export function citationProblem(citation: Citation, sources: Source[]): string | null {
  const current = sources.find((item) => item.id === citation.sourceId);
  if (!current || current.deletedAt) return "这份资料已删除或当前不可访问，无法打开原文。";
  const source = getSourceVersion(current, citation.versionId);
  if (!source) return "这条引用的旧版本未保留，当前版本不能替代原始依据。";
  const chunk = source.chunks.find(
    (item) =>
      item.id === citation.chunkId &&
      item.sourceId === citation.sourceId &&
      item.versionId === citation.versionId,
  );
  if (!chunk) return "引用的原文片段当前不可用，请保留引用并重新检查资料状态。";
  if (!quoteOffsets(chunk.text, citation.quote) && !quoteOffsets(source.text, citation.quote))
    return "引用摘录未在保存的这个版本中找到，不能将当前文字视为原始依据。";
  return null;
}

/** Ignore whitespace differences introduced by PDF line layout, retaining DOM offsets. */
export function quoteOffsets(text: string, quote: string): [number, number] | null {
  const offsets: number[] = [];
  let normalized = "";
  for (let i = 0; i < text.length; i++) {
    if (!/\s/u.test(text[i])) {
      normalized += text[i];
      offsets.push(i);
    }
  }
  const target = quote.replace(/\s/gu, "");
  if (!target) return null;
  const at = normalized.indexOf(target);
  return at === -1 ? null : [offsets[at], offsets[at + target.length - 1] + 1];
}

export function findQuoteRange(container: HTMLElement, quote: string): Range | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let text = "";
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest("button, [aria-hidden='true']")) continue;
    nodes.push(node);
    text += node.textContent || "";
  }
  const candidates = [...new Set([quote, renderedMarkdownText(quote)])].filter(Boolean);
  const match = candidates.map((candidate) => quoteOffsets(text, candidate)).find(Boolean);
  if (!match) return null;
  const range = document.createRange();
  let offset = 0,
    started = false;
  for (const node of nodes) {
    const end = offset + node.length;
    if (!started && match[0] < end) {
      range.setStart(node, match[0] - offset);
      started = true;
    }
    if (started && match[1] <= end) {
      range.setEnd(node, match[1] - offset);
      return range;
    }
    offset = end;
  }
  return null;
}
