import type { Element, ElementContent, Root as HtmlRoot, RootContent } from "hast";
import type { Root as MarkdownRoot, RootContent as MarkdownContent } from "mdast";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

const ELEMENTS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "b",
  "em",
  "i",
  "s",
  "del",
  "u",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "br",
  "hr",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "a",
  "sup",
  "sub",
]);
const DROP_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "template",
  "noscript",
]);

function safeHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const href = value.trim();
  let decoded = href;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    // Invalid percent escapes do not make an otherwise safe URL executable.
  }
  if (
    [href, decoded].some((text) =>
      Array.from(text).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
    )
  )
    return null;
  try {
    const base = "https://conuo.invalid/";
    return [href, decoded].every((text) =>
      ["http:", "https:", "mailto:"].includes(new URL(text, base).protocol),
    )
      ? href
      : null;
  } catch {
    return null;
  }
}

function safeChildren(nodes: readonly RootContent[]): ElementContent[] {
  return nodes.flatMap((node): ElementContent[] => {
    if (node.type === "text") return [{ type: "text", value: node.value }];
    if (node.type !== "element" || DROP_CONTENT.has(node.tagName)) return [];
    if (node.tagName === "img") {
      const alt = typeof node.properties.alt === "string" ? node.properties.alt : "";
      return [{ type: "text", value: alt || "[图片]" }];
    }
    const children = safeChildren(node.children);
    if (!ELEMENTS.has(node.tagName)) return children;
    const properties: Element["properties"] = {};
    if (node.tagName === "a") {
      const href = safeHref(node.properties.href);
      if (href === null) return children;
      properties.href = href;
      if (typeof node.properties.title === "string") properties.title = node.properties.title;
      properties.rel = ["noreferrer", "noopener"];
    }
    if (node.tagName === "ol" && Number.isSafeInteger(node.properties.start))
      properties.start = node.properties.start;
    if (["td", "th"].includes(node.tagName)) {
      if (["left", "center", "right"].includes(String(node.properties.align)))
        properties.align = node.properties.align;
      for (const key of ["colSpan", "rowSpan"] as const) {
        const span = Number(node.properties[key]);
        // Bound expansion before hast-util-to-mdast builds a rectangular table.
        if (Number.isSafeInteger(span) && span > 1) properties[key] = Math.min(span, 100);
      }
    }
    if (node.tagName === "code" && Array.isArray(node.properties.className)) {
      properties.className = node.properties.className.filter(
        (value) => typeof value === "string" && /^language-[a-zA-Z0-9_-]+$/.test(value),
      );
    }
    return [{ type: "element", tagName: node.tagName, properties, children }];
  });
}

function sanitizeHtml() {
  return (tree: HtmlRoot) => {
    tree.children = safeChildren(tree.children);
  };
}

const htmlParser = unified().use(rehypeParse, { fragment: true });
const legacyMarkdown = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: false });
const htmlConverter = unified().use(rehypeRemark);
const htmlWriter = unified().use(rehypeStringify, { allowDangerousHtml: false });
const markdownWriter = unified()
  .use(remarkGfm)
  .use(remarkStringify, { bullet: "-", emphasis: "*", fences: true, incrementListMarker: true });

function isEditorHtml(tree: HtmlRoot): boolean {
  // Legacy notes may contain Markdown autolinks (<https://...>), which the HTML
  // parser treats as unknown tags. Only known HTML elements identify rich text.
  for (const node of tree.children) {
    if (node.type === "text" && node.value.trim()) return false;
    if (node.type === "element")
      return (
        ELEMENTS.has(node.tagName) ||
        DROP_CONTENT.has(node.tagName) ||
        ["div", "span", "img"].includes(node.tagName)
      );
  }
  return false;
}

function preserveTableBreaks(tree: MarkdownRoot): void {
  function walk(node: { type: string; children?: unknown[] }, inCell = false): void {
    if (!node.children) return;
    const inside = inCell || node.type === "tableCell";
    node.children = node.children.map((child) => {
      const item = child as { type: string; children?: unknown[] };
      // GFM rows cannot contain literal line endings. This fixed, inert element
      // preserves cell breaks without allowing source-supplied raw HTML through.
      if (inside && item.type === "break") return { type: "html", value: "<br>" };
      walk(item, inside);
      return item;
    });
  }
  walk(tree);
}

export interface ExportCitation {
  title: string;
  quote: string;
  sourceId: string;
  versionId: string;
  chunkId: string;
  page?: number;
  section: string;
  metadataPath: string | null;
}

function citationBlocks(citations: readonly ExportCitation[]): MarkdownContent[] {
  if (!citations.length) return [];
  return [
    { type: "heading", depth: 2, children: [{ type: "text", value: "引用来源" }] },
    {
      type: "list",
      ordered: true,
      start: 1,
      spread: true,
      children: citations.map((citation) => ({
        type: "listItem",
        spread: true,
        children: [
          {
            type: "paragraph",
            children: citation.metadataPath
              ? [
                  {
                    type: "link",
                    url: citation.metadataPath,
                    children: [{ type: "text", value: citation.title }],
                  },
                ]
              : [
                  {
                    type: "text",
                    value: `${citation.title}（所引用的资料版本未包含在本次备份中）`,
                  },
                ],
          },
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                value: `${citation.page ? `第 ${citation.page} 页；` : ""}${citation.section ? `${citation.section}；` : ""}sourceId: `,
              },
              { type: "inlineCode", value: citation.sourceId },
              { type: "text", value: "；versionId: " },
              { type: "inlineCode", value: citation.versionId },
              { type: "text", value: "；chunkId: " },
              { type: "inlineCode", value: citation.chunkId },
            ],
          },
          {
            type: "blockquote",
            children: [{ type: "paragraph", children: [{ type: "text", value: citation.quote }] }],
          },
        ],
      })),
    },
  ];
}

/** Portable GFM plus an inert readable HTML copy; exact editor bytes are backed up separately. */
export function renderNoteForExport(
  title: string,
  content: string,
  citations: readonly ExportCitation[] = [],
) {
  const parsed = htmlParser.parse(content);
  const originalFormat = isEditorHtml(parsed) ? ("html" as const) : ("markdown" as const);
  const htmlTree =
    originalFormat === "html" ? parsed : legacyMarkdown.runSync(legacyMarkdown.parse(content));
  sanitizeHtml()(htmlTree);
  const markdownTree = htmlConverter.runSync(structuredClone(htmlTree));
  preserveTableBreaks(markdownTree);
  markdownTree.children.unshift({
    type: "heading",
    depth: 1,
    children: [{ type: "text", value: title.replace(/[\r\n]+/g, " ") }],
  });
  markdownTree.children.push(...citationBlocks(citations));
  const htmlBody = String(htmlWriter.stringify(htmlTree));
  return {
    markdown: String(markdownWriter.stringify(markdownTree)),
    htmlBody,
    originalFormat,
  };
}
