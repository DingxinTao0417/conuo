/** Pure text helpers for the homepage: answer streaming and headline splitting. */
import type { AnswerBlock, Lang } from "./copy";

/** Splits inline answer text into plain, bold and citation tokens. */
export type InlineToken =
  { kind: "text"; value: string; bold: boolean } | { kind: "cite"; ref: number };

export function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const pattern = /\*\*(.+?)\*\*|\{(\d+)\}/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ kind: "text", value: text.slice(last, index), bold: false });
    if (match[1] !== undefined) tokens.push({ kind: "text", value: match[1], bold: true });
    else tokens.push({ kind: "cite", ref: Number(match[2]) });
    last = index + match[0].length;
  }
  if (last < text.length) tokens.push({ kind: "text", value: text.slice(last), bold: false });
  return tokens;
}

/** Unique paragraph references cited by an answer, in order of first appearance. */
export function answerCitations(blocks: AnswerBlock[]): number[] {
  const refs: number[] = [];
  for (const block of blocks) {
    const texts = block.kind === "list" ? block.items : block.kind === "math" ? [] : [block.text];
    for (const text of texts)
      for (const token of tokenizeInline(text))
        if (token.kind === "cite" && !refs.includes(token.ref)) refs.push(token.ref);
  }
  return refs;
}

export type HeadlineUnit = { text: string; highlight: boolean; space: boolean };

/** Splits a headline into animatable units: characters for Chinese, words for English. */
export function splitHeadline(line: string, highlight: string, lang: Lang): HeadlineUnit[] {
  const at = highlight ? line.indexOf(highlight) : -1;
  const segments =
    at < 0
      ? [{ text: line, highlight: false }]
      : [
          { text: line.slice(0, at), highlight: false },
          { text: highlight, highlight: true },
          { text: line.slice(at + highlight.length), highlight: false },
        ].filter((segment) => segment.text);
  return segments.flatMap(({ text, highlight: hl }) =>
    lang === "zh"
      ? Array.from(text).map((char) => ({ text: char, highlight: hl, space: false }))
      : text
          .split(/(\s+)/)
          .filter(Boolean)
          .map((word) => ({ text: word, highlight: hl, space: /^\s+$/.test(word) })),
  );
}

const inlineLength = (text: string) =>
  tokenizeInline(text).reduce(
    (total, token) => total + (token.kind === "cite" ? 1 : Array.from(token.value).length),
    0,
  );

export function blockLength(block: AnswerBlock) {
  if (block.kind === "math") return 1;
  const texts = block.kind === "list" ? block.items : [block.text];
  return texts.reduce((total, text) => total + inlineLength(text), 0);
}

/** Citation refs already streamed onto the screen for a given character budget. */
export function revealedRefs(blocks: AnswerBlock[], budget: number) {
  const refs = new Set<number>();
  let used = 0;
  for (const block of blocks) {
    if (block.kind === "math") {
      used += 1;
      continue;
    }
    for (const text of block.kind === "list" ? block.items : [block.text])
      for (const token of tokenizeInline(text)) {
        if (used >= budget) return refs;
        if (token.kind === "cite") {
          refs.add(token.ref);
          used += 1;
        } else used += Array.from(token.value).length;
      }
  }
  return refs;
}

export function plainAnswer(blocks: AnswerBlock[], paragraphLabel: string) {
  const inline = (text: string) =>
    tokenizeInline(text)
      .map((token) => (token.kind === "cite" ? ` [${paragraphLabel}${token.ref}]` : token.value))
      .join("");
  return blocks
    .map((block) =>
      block.kind === "math"
        ? ""
        : block.kind === "list"
          ? block.items.map(inline).join(" ")
          : inline(block.text),
    )
    .filter(Boolean)
    .join(" ");
}
