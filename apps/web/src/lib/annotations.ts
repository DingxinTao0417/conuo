import type { Annotation, Source } from "./types";

export const ANNOTATION_LIMITS = {
  quoteCharacters: 6_000,
  noteCharacters: 4_000,
} as const;

type AnnotationIdentity = Pick<
  Annotation,
  "id" | "sourceId" | "versionId" | "quote" | "page" | "textAnchor" | "createdAt"
>;

export function sameAnnotationTextAnchor(
  left: Annotation["textAnchor"],
  right: Annotation["textAnchor"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.start === right.start && left.end === right.end;
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** Unanchored legacy annotations stay compatible; new anchors never guess a position. */
export function annotationTextAnchorMatches(
  text: string,
  annotation: Pick<Annotation, "quote" | "textAnchor">,
): boolean {
  const anchor = annotation.textAnchor;
  if (anchor === undefined) return true;
  return Boolean(
    anchor &&
    typeof anchor === "object" &&
    Object.keys(anchor).every((key) => key === "start" || key === "end") &&
    Number.isSafeInteger(anchor.start) &&
    Number.isSafeInteger(anchor.end) &&
    anchor.start >= 0 &&
    anchor.start < anchor.end &&
    anchor.end <= text.length &&
    !splitsSurrogatePair(text, anchor.start) &&
    !splitsSurrogatePair(text, anchor.end) &&
    text.slice(anchor.start, anchor.end) === annotation.quote,
  );
}

function characterCount(value: string) {
  return Array.from(value).length;
}

function compact(value: string) {
  return value.replace(/\s/gu, "");
}

function normalizedText(value: string, field: "原文选段" | "批注内容", limit: number) {
  const text = value.replace(/\r\n?/gu, "\n").trim();
  if (characterCount(text) > limit)
    throw new Error(`${field}最多 ${limit.toLocaleString("zh-CN")} 个字符。`);
  return text;
}

/** An annotation always points to one exact retained source version. */
export function assertAnnotationSource(
  annotation: Pick<Annotation, "sourceId" | "versionId" | "quote" | "page" | "textAnchor">,
  source: Pick<Source, "id" | "versionId" | "deletedAt" | "text" | "pageCount">,
) {
  if (source.deletedAt) throw new Error("资料已删除，不能修改其中的批注。");
  if (annotation.sourceId !== source.id || annotation.versionId !== source.versionId)
    throw new Error("批注不属于当前资料版本，不能修改。");
  const quote =
    annotation.textAnchor === undefined
      ? normalizedText(annotation.quote, "原文选段", ANNOTATION_LIMITS.quoteCharacters)
      : annotation.quote;
  if (characterCount(quote) > ANNOTATION_LIMITS.quoteCharacters)
    throw new Error("原文选段最多 6,000 个字符。");
  if (!quote.trim()) throw new Error("请先选择一段原文。");
  if (!annotationTextAnchorMatches(source.text, annotation))
    throw new Error("批注原文位置与当前资料不一致，未修改批注。");
  if (!compact(source.text).includes(compact(quote)))
    throw new Error("选段不属于当前资料版本，未保存批注。");
  if (
    annotation.page !== undefined &&
    (!Number.isInteger(annotation.page) ||
      annotation.page < 1 ||
      (source.pageCount !== undefined && annotation.page > source.pageCount))
  )
    throw new Error("批注页码无效，未保存批注。");
  return quote;
}

/** Create a bounded, version-bound annotation from a user-selected passage. */
export function createAnnotation(
  input: AnnotationIdentity & Pick<Annotation, "note">,
  source: Pick<Source, "id" | "versionId" | "deletedAt" | "text" | "pageCount">,
): Annotation {
  if (!input.id.trim() || input.id.length > 200) throw new Error("批注标识无效，未保存批注。");
  if (!Number.isFinite(Date.parse(input.createdAt))) throw new Error("批注时间无效，未保存批注。");
  const quote = assertAnnotationSource(input, source);
  return {
    ...input,
    quote,
    ...(input.textAnchor !== undefined ? { textAnchor: { ...input.textAnchor } } : {}),
    note: normalizedText(input.note, "批注内容", ANNOTATION_LIMITS.noteCharacters),
  };
}

/** Update only the user's note while keeping the original selection identity immutable. */
export function updateAnnotation(
  annotation: Annotation,
  note: string,
  source: Pick<Source, "id" | "versionId" | "deletedAt" | "text" | "pageCount">,
): Annotation {
  assertAnnotationSource(annotation, source);
  return {
    ...annotation,
    note: normalizedText(note, "批注内容", ANNOTATION_LIMITS.noteCharacters),
  };
}

/** Validate a removal request before its owner mutates persisted workspace state. */
export function removeAnnotation(
  annotations: readonly Annotation[],
  annotation: Annotation,
  source: Pick<Source, "id" | "versionId" | "deletedAt" | "text" | "pageCount">,
): Annotation[] {
  assertAnnotationSource(annotation, source);
  const found = annotations.find((item) => item.id === annotation.id);
  if (
    !found ||
    found.sourceId !== annotation.sourceId ||
    found.versionId !== annotation.versionId ||
    found.quote !== annotation.quote ||
    !sameAnnotationTextAnchor(found.textAnchor, annotation.textAnchor)
  )
    throw new Error("批注已变化或不可用，请刷新后重试。");
  return annotations.filter((item) => item.id !== annotation.id);
}
