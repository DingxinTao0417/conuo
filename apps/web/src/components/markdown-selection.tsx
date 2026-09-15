import { createElement, type ComponentProps } from "react";
import type { Components, ExtraProps } from "react-markdown";
import type { Source } from "@/lib/types";
import { projectMarkdownVisibleText, resolveMarkdownExcerpt } from "@/lib/markdown-excerpt";

function sourceBlock<
  Tag extends
    "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li" | "pre" | "td" | "th" | "blockquote",
>(tag: Tag) {
  return function MarkdownSourceBlock({ node, ...props }: ComponentProps<Tag> & ExtraProps) {
    const start = node?.position?.start.offset;
    const end = node?.position?.end.offset;
    return createElement(tag, {
      ...props,
      ...(typeof start === "number" && typeof end === "number"
        ? { "data-markdown-start": start, "data-markdown-end": end }
        : {}),
    });
  };
}

/** Parser positions belong to this rendered source, never to model output. */
export const markdownSourceComponents: Components = {
  p: sourceBlock("p"),
  h1: sourceBlock("h1"),
  h2: sourceBlock("h2"),
  h3: sourceBlock("h3"),
  h4: sourceBlock("h4"),
  h5: sourceBlock("h5"),
  h6: sourceBlock("h6"),
  li: sourceBlock("li"),
  pre: sourceBlock("pre"),
  td: sourceBlock("td"),
  th: sourceBlock("th"),
  blockquote: sourceBlock("blockquote"),
};

function retainedDomText(container: Node): string {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  while (walker.nextNode()) {
    const text = walker.currentNode as Text;
    // The renderer's image placeholder is UI, rather than parsed source text.
    if (text.parentElement?.closest(".reader-image-placeholder, button, [aria-hidden='true']"))
      continue;
    parts.push(text.data);
  }
  return parts.join("");
}

export function readMarkdownSelection(source: Source, range: Range) {
  if (source.kind !== "markdown" && source.kind !== "web")
    return { ok: false as const, message: "当前资料不是 Markdown 阅读版。" };
  const common =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement;
  const block = common?.closest<HTMLElement>("[data-markdown-start][data-markdown-end]");
  const body = block?.closest<HTMLElement>("[data-reader-text]");
  if (
    !block ||
    !body ||
    body.dataset.readerSourceId !== source.id ||
    body.dataset.readerSourceVersion !== source.versionId ||
    !block.contains(range.startContainer) ||
    !block.contains(range.endContainer)
  )
    return { ok: false as const, message: "请只选择资料正文中的文字。" };
  const rawStart = Number(block.dataset.markdownStart);
  const rawEnd = Number(block.dataset.markdownEnd);
  const projected = projectMarkdownVisibleText(source.text, { rawStart, rawEnd });
  if (!projected.ok) return projected;
  if (retainedDomText(block).replace(/\s/gu, "") !== projected.compactText)
    return {
      ok: false as const,
      message: "这段排版暂时无法准确对应原文，请缩小选段后重试。",
    };
  const prefix = range.cloneRange();
  prefix.selectNodeContents(block);
  prefix.setEnd(range.startContainer, range.startOffset);
  return resolveMarkdownExcerpt({ ...source, kind: "markdown" }, range.toString().trim(), {
    rawStart,
    rawEnd,
    visibleStart: retainedDomText(prefix.cloneContents()).replace(/\s/gu, "").length,
  });
}

/** Display-only: persistence and evidence checks keep the original raw quote. */
export function markdownQuoteText(source: Source, quote: string): string {
  if (!["markdown", "web"].includes(source.kind) || !quote) return quote;
  const rawStart = source.text.indexOf(quote);
  if (rawStart < 0) return quote;
  const projection = projectMarkdownVisibleText(source.text, {
    rawStart,
    rawEnd: rawStart + quote.length,
  });
  return projection.ok && projection.visibleText.trim() ? projection.visibleText.trim() : quote;
}
