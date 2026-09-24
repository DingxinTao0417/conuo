import { chunkText } from "./import";
import type { Source, SourcePageRange } from "./types";

function pageRanges(pages: number[]): SourcePageRange[] {
  const ranges: SourcePageRange[] = [];
  for (const page of [...new Set(pages)].sort((left, right) => left - right)) {
    const previous = ranges.at(-1);
    if (previous && page === previous.end + 1) previous.end = page;
    else ranges.push({ start: page, end: page });
  }
  return ranges;
}

export function ocrTargetPages(source: Source): number[] {
  return (source.coverage?.unavailablePageRanges ?? []).flatMap((range) => {
    const pages: number[] = [];
    for (let page = range.start; page <= range.end; page++) pages.push(page);
    return pages;
  });
}

/** Assemble an in-memory OCR preview into a new immutable PDF version candidate. */
export function assembleDerivedPdfSource(source: Source, ocrPages: Record<number, string>): Source {
  if (source.kind !== "pdf" || !source.pageCount)
    throw new Error("OCR 派生版本需要当前 PDF 的页数信息。");
  const versionId = crypto.randomUUID();
  const existing = new Map<number, string>();
  for (const chunk of source.chunks) {
    if (chunk.page === undefined) continue;
    existing.set(
      chunk.page,
      `${existing.get(chunk.page) ?? ""}${existing.has(chunk.page) ? "\n\n" : ""}${chunk.text}`,
    );
  }
  const pageTexts: Array<{ page: number; text: string }> = [];
  const missing: number[] = [];
  for (let page = 1; page <= source.pageCount; page++) {
    const text = (ocrPages[page] ?? existing.get(page) ?? "").trim();
    if (!text) missing.push(page);
    else pageTexts.push({ page, text });
  }
  const chunks = pageTexts.flatMap(({ page, text }) =>
    chunkText(text, source.id, versionId).map((chunk) => ({
      ...chunk,
      page,
      section: `第 ${page} 页`,
      order: 0,
    })),
  );
  chunks.forEach((chunk, index) => {
    chunk.order = index;
  });
  const parsedPages = pageTexts.length;
  const parseState = missing.length ? (parsedPages ? "partial" : "failed") : "complete";
  const now = new Date().toISOString();
  const base = structuredClone(source);
  delete base.versions;
  delete base.readPage;
  delete base.readOffset;
  return {
    ...base,
    versionId,
    versionCreatedAt: now,
    createdAt: now,
    updatedAt: now,
    text: pageTexts.map((item) => item.text).join("\n\n"),
    chunks,
    status: parseState === "complete" ? "ready" : parseState,
    parsedPages,
    coverage: {
      captureScope: "full",
      parseState,
      ...(missing.length ? { unavailablePageRanges: pageRanges(missing) } : {}),
    },
    ...(missing.length
      ? { error: `仍有 ${missing.length} 页没有可检索文字；问答仅使用已解析页面。` }
      : { error: undefined }),
    blobKey: `original:${source.id}:${versionId}`,
    storagePath: undefined,
    originalMissing: undefined,
    derivation: { method: "ocr-vlm-v1", fromVersionId: source.versionId },
  };
}
