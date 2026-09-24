import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const ALLOWED = new Set([
  "root",
  "paragraph",
  "text",
  "strong",
  "emphasis",
  "delete",
  "inlineCode",
  "code",
  "list",
  "listItem",
  "table",
  "tableRow",
  "tableCell",
  "inlineMath",
  "math",
  "break",
]);
const lenientParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const strictParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath, { singleDollarTextMath: false });

const CITATION_LIKE = /\\?\[(\d+)\\?\]/gu;
const neutralizeCitationLike = (value: string) => value.replace(CITATION_LIKE, "［$1］");

/** Legacy-safe plain text: every Markdown and math delimiter is literal. */
export function escapePlainAnswerText(value: string): string {
  return neutralizeCitationLike(value).replace(/[\\`*_{}\[\]<>#!|$]/g, "\\$&");
}

function walk(node: MdNode, visit: (node: MdNode) => boolean): boolean {
  if (!visit(node)) return false;
  return (node.children ?? []).every((child) => walk(child, visit));
}

function replaceRanges(
  text: string,
  ranges: Array<{ start: number; end: number; value: string }>,
): string {
  let result = "";
  let cursor = 0;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    result += text.slice(cursor, range.start) + range.value;
    cursor = range.end;
  }
  return result + text.slice(cursor);
}

/**
 * Returns a safe Markdown subset for one model paragraph, or the escaped plain
 * text fallback when the paragraph uses anything outside that subset.
 */
export function sanitizeAnswerMarkdown(raw: string): string {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (!text || text.includes("[[conuo-")) return escapePlainAnswerText(text);

  // Find inline math with the lenient grammar and rewrite it to the display
  // form used by the renderer. The second parse below has single-dollar math
  // disabled so legacy plain text remains literal.
  const inlineMath: Array<{ start: number; end: number; value: string }> = [];
  const lenientOk = walk(lenientParser.parse(text) as MdNode, (node) => {
    if (!ALLOWED.has(node.type)) return false;
    if (node.type === "inlineMath") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return false;
      inlineMath.push({ start, end, value: `$$${node.value ?? ""}$$` });
    }
    return true;
  });
  if (!lenientOk) return escapePlainAnswerText(text);
  const rewritten = replaceRanges(text, inlineMath);

  const textRanges: Array<{ start: number; end: number; value: string }> = [];
  const strictOk = walk(strictParser.parse(rewritten) as MdNode, (node) => {
    if (!ALLOWED.has(node.type)) return false;
    if (node.type === "text") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return false;
      const source = rewritten.slice(start, end);
      const neutral = neutralizeCitationLike(source);
      if (neutral !== source) textRanges.push({ start, end, value: neutral });
    }
    return true;
  });
  if (!strictOk) return escapePlainAnswerText(text);
  return replaceRanges(rewritten, textRanges);
}

const BLOCK_LINE = /^\s*(?:```|~~~|\$\$|\||[-*+]\s|\d+[.)]\s)/u;

/** Appends visible reference markers without breaking a trailing block construct. */
export function withReferences(markdown: string, references: string): string {
  if (!references) return markdown;
  const lastLine = markdown.split("\n").at(-1) ?? "";
  return BLOCK_LINE.test(lastLine) ? `${markdown}\n\n${references}` : `${markdown} ${references}`;
}

/** Places a bold label before a paragraph, or on its own line before a block. */
export function withLabel(markdown: string, label: string): string {
  if (!label) return markdown;
  const firstLine = markdown.split("\n")[0] ?? "";
  return BLOCK_LINE.test(firstLine) ? `${label.trim()}\n\n${markdown}` : `${label}${markdown}`;
}
