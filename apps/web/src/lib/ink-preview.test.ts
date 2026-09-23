import { describe, expect, it } from "vitest";
import { mergeInkPreviewPages, parseInkPreviewPages } from "./ink-preview";

describe("ink preview merge", () => {
  it("parses committed page heads into 1-based preview entries", () => {
    const pages = parseInkPreviewPages({
      pages: [
        { pageIndex: 0, headRevisionId: "rev-a", previewDownloadUrl: "https://cdn/a.png" },
        { pageIndex: 1, headRevisionId: "rev-b", deleted: true, previewDownloadUrl: "https://cdn/b.png" },
        { pageIndex: 2, headRevisionId: null },
      ],
    });
    expect(pages).toEqual({
      1: { revisionId: "rev-a", url: "https://cdn/a.png" },
    });
  });

  it("keeps the previous URL when the head revision is unchanged", () => {
    const previous = { 1: { revisionId: "rev-a", url: "https://cdn/old.png" } };
    const merged = mergeInkPreviewPages(previous, {
      1: { revisionId: "rev-a", url: "https://cdn/new.png" },
    });
    expect(merged).toBe(previous);
  });

  it("adopts a new preview when the head revision advances", () => {
    const previous = { 1: { revisionId: "rev-a", url: "https://cdn/old.png" } };
    const incoming = { 1: { revisionId: "rev-b", url: "https://cdn/new.png" } };
    expect(mergeInkPreviewPages(previous, incoming)).toEqual(incoming);
  });
});
