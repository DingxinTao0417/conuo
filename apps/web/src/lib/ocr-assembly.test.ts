import { describe, expect, it } from "vitest";
import type { Source } from "./types";
import { assembleDerivedPdfSource, ocrTargetPages } from "./ocr-assembly";

function source(): Source {
  return {
    id: "pdf-source",
    versionId: "pdf-v1",
    title: "扫描件",
    filename: "scan.pdf",
    kind: "pdf",
    mime: "application/pdf",
    size: 10,
    hash: "a".repeat(64),
    spaceIds: [],
    tags: [],
    status: "partial",
    coverage: {
      captureScope: "full",
      parseState: "partial",
      unavailablePageRanges: [{ start: 2, end: 3 }],
    },
    text: "第 1 页正文",
    chunks: [
      {
        id: "chunk-1",
        sourceId: "pdf-source",
        versionId: "pdf-v1",
        text: "第 1 页正文",
        section: "第 1 页",
        page: 1,
        order: 0,
      },
    ],
    createdAt: "2026-09-25T12:00:00.000Z",
    updatedAt: "2026-09-25T12:00:00.000Z",
    deletedAt: null,
    aiAllowed: true,
    starred: false,
    pageCount: 3,
    parsedPages: 1,
  };
}

describe("browser OCR page assembly", () => {
  it("expands unavailable ranges into page targets", () => {
    expect(ocrTargetPages(source())).toEqual([2, 3]);
  });

  it("keeps old page text, adds OCR pages, and reports remaining gaps", () => {
    const candidate = assembleDerivedPdfSource(source(), { 2: "## 识别页\n\nOCR 正文" });
    expect(candidate.derivation).toEqual({ method: "ocr-vlm-v1", fromVersionId: "pdf-v1" });
    expect(candidate.text).toContain("第 1 页正文");
    expect(candidate.text).toContain("OCR 正文");
    expect(candidate.chunks.every((chunk) => chunk.versionId === candidate.versionId)).toBe(true);
    expect(candidate.coverage).toEqual({
      captureScope: "full",
      parseState: "partial",
      unavailablePageRanges: [{ start: 3, end: 3 }],
    });
    expect(candidate.parsedPages).toBe(2);
  });
});
