import { readingBlocks, type Source } from "./contracts.ts";

export const READER_FONT_MIN = 15;
export const READER_FONT_MAX = 25;
export const READER_FONT_DEFAULT = 17;

export type ReaderBookmark = {
  block: number;
  fraction: number;
  offset: number;
};
export type ReaderBlockLayout = { index: number; y: number; height: number };
export type ReaderSession = {
  positions: Map<string, ReaderBookmark>;
  fontSize: number;
};

/** Owned by a mounted account workspace; never persisted or shared between accounts. */
export function createReaderSession(): ReaderSession {
  return { positions: new Map(), fontSize: READER_FONT_DEFAULT };
}

export function readerKey(source: Pick<Source, "id" | "versionId">) {
  return JSON.stringify([source.id, source.versionId]);
}

export function readerModel(source: Source) {
  const occurrences = new Map<string, number>();
  for (const chunk of source.chunks)
    occurrences.set(chunk.id, (occurrences.get(chunk.id) ?? 0) + 1);
  const blocks = readingBlocks({
    ...source,
    chunks: source.chunks.filter(
      (chunk) =>
        chunk.sourceId === source.id &&
        chunk.versionId === source.versionId &&
        occurrences.get(chunk.id) === 1,
    ),
  });
  const contents = blocks.flatMap((block, index) =>
    block.chunkId
      ? [
          {
            block: index,
            chunkId: block.chunkId,
            title: block.section?.trim() || "正文段落",
            page: block.page,
            preview: block.text.trim().replace(/\s+/g, " ").slice(0, 84),
          },
        ]
      : [],
  );
  return { blocks, contents };
}

export function readingBookmark(
  layouts: ReaderBlockLayout[],
  offset: number,
): ReaderBookmark {
  const y = Number.isFinite(offset) ? Math.max(0, offset) : 0;
  const ordered = layouts
    .filter((block) => Number.isFinite(block.y) && block.height > 0)
    .sort((a, b) => a.y - b.y);
  // Keep the title/header visible when the reader is still above the first paragraph.
  if (!ordered.length || y < ordered[0].y)
    return { block: -1, fraction: 0, offset: y };
  const block = ordered.findLast((item) => item.y <= y)!;
  return {
    block: block.index,
    fraction: Math.min(1, Math.max(0, (y - block.y) / block.height)),
    offset: y,
  };
}

/** A paragraph-relative anchor survives font size and split-view width changes. */
export function readingOffset(
  bookmark: ReaderBookmark,
  layouts: ReaderBlockLayout[],
  maximum: number,
) {
  const block = layouts.find((item) => item.index === bookmark.block);
  const y = block
    ? block.y + block.height * Math.min(1, Math.max(0, bookmark.fraction))
    : bookmark.offset;
  return Math.min(Math.max(0, maximum), Math.max(0, y));
}
