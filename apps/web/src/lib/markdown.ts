import type { Element, ElementContent, Root, RootContent } from "hast";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

const EDITOR_ELEMENTS = new Set([
  "p",
  "strong",
  "em",
  "s",
  "del",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "pre",
  "code",
  "br",
  "hr",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "a",
  "sup",
  "sub",
]);

function safeHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const href = value.trim();
  // HTML entities have already been decoded by remark. Reject literal control
  // characters before URL parsing, including obfuscated java<TAB>script links.
  if (
    Array.from(href).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return null;
  // mdast-to-hast percent-encodes some decoded control characters. Inspect a
  // decoded scheme as well, so entity/percent obfuscation cannot survive a later
  // editor normalization step and become an executable link.
  let decoded = href;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    /* Keep the original for URL validation. */
  }
  const colon = decoded.indexOf(":");
  if (colon >= 0) {
    const scheme = Array.from(decoded.slice(0, colon))
      .filter((character) => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127)
      .join("")
      .toLowerCase();
    if (["javascript", "data", "vbscript"].includes(scheme)) return null;
  }
  try {
    const parsed = new URL(href, "https://conuo.invalid/");
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? href : null;
  } catch {
    return null;
  }
}

function sanitizeChildren(nodes: readonly RootContent[]): ElementContent[] {
  const result: ElementContent[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      result.push(node);
      continue;
    }
    if (node.type !== "element") continue;
    if (node.tagName === "img") {
      // Notes do not issue image requests just because an answer/source contains
      // Markdown images. Preserve descriptive text, including reference images.
      const alt = typeof node.properties.alt === "string" ? node.properties.alt : "";
      result.push({ type: "text", value: alt || "[图片]" });
      continue;
    }
    const children = sanitizeChildren(node.children);
    if (!EDITOR_ELEMENTS.has(node.tagName)) {
      result.push(...children);
      continue;
    }
    const properties: Element["properties"] = {};
    if (node.tagName === "a") {
      const href = safeHref(node.properties.href);
      if (href === null) {
        result.push(...children);
        continue;
      }
      properties.href = href;
      if (typeof node.properties.title === "string") properties.title = node.properties.title;
    }
    if (
      node.tagName === "ol" &&
      typeof node.properties.start === "number" &&
      Number.isSafeInteger(node.properties.start)
    ) {
      properties.start = node.properties.start;
    }
    if (
      (node.tagName === "td" || node.tagName === "th") &&
      ["left", "center", "right"].includes(String(node.properties.align))
    ) {
      properties.align = node.properties.align;
    }
    if (node.tagName === "code" && Array.isArray(node.properties.className)) {
      properties.className = node.properties.className.filter(
        (value) => typeof value === "string" && /^language-[a-zA-Z0-9_-]+$/.test(value),
      );
    }
    result.push({ type: "element", tagName: node.tagName, properties, children });
  }
  return result;
}

function editorSafeHtml() {
  return (tree: Root) => {
    tree.children = sanitizeChildren(tree.children);
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: false })
  .use(editorSafeHtml)
  .use(rehypeStringify, { allowDangerousHtml: false });

/** Convert answer Markdown to inert, structured HTML that Tiptap can import. */
export function markdownToEditorHtml(markdown: string): string {
  return String(processor.processSync(markdown));
}
