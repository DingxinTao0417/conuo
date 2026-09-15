import { describe, expect, it } from "vitest";
import { deriveReaderOutline } from "./reader-outline";
import type { Source } from "@/lib/types";

function source(overrides: Partial<Source> = {}): Source {
  return {
    id: "source-a",
    versionId: "version-a",
    title: "资料",
    filename: "资料.md",
    kind: "markdown",
    mime: "text/markdown",
    size: 0,
    hash: "hash",
    spaceIds: ["space-a"],
    tags: [],
    status: "ready",
    text: "",
    chunks: [],
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    deletedAt: null,
    aiAllowed: true,
    starred: false,
    ...overrides,
  };
}

describe("reader outline derivation", () => {
  it("uses only parsed Markdown headings with their exact saved offsets", () => {
    const text = [
      "# 学习计划",
      "",
      "```md",
      "## 这只是代码，不是章节",
      "```",
      "",
      "## **练习** 与回顾",
      "",
      "回顾内容。",
    ].join("\n");
    const items = deriveReaderOutline(
      source({
        text,
        chunks: [
          {
            id: "chunk-a",
            sourceId: "source-a",
            versionId: "version-a",
            text,
            section: "正文",
            order: 0,
          },
        ],
      }),
    );

    expect(items).toEqual([
      expect.objectContaining({
        id: "markdown:0",
        title: "学习计划",
        level: 1,
        locator: "# 学习计划",
        kind: "markdown-heading",
        sourceOffset: 0,
        headingOccurrence: 0,
      }),
      expect.objectContaining({
        title: "练习 与回顾",
        level: 2,
        locator: "## **练习** 与回顾",
        kind: "markdown-heading",
        sourceOffset: text.indexOf("## **练习**"),
        headingOccurrence: 0,
      }),
    ]);
  });

  it("falls back to retained named chunk sections in their saved order without inventing 正文", () => {
    const items = deriveReaderOutline(
      source({
        kind: "docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: "资料.docx",
        text: "第一部分内容。\n\n第二部分内容。",
        chunks: [
          {
            id: "generic",
            sourceId: "source-a",
            versionId: "version-a",
            text: "第一部分内容。",
            section: "正文",
            order: 0,
          },
          {
            id: "chapter-b",
            sourceId: "source-a",
            versionId: "version-a",
            text: "第二部分内容。",
            section: "第二部分",
            order: 2,
          },
          {
            id: "chapter-a",
            sourceId: "source-a",
            versionId: "version-a",
            text: "第一部分内容。",
            section: "第一部分",
            order: 1,
          },
          {
            id: "chapter-a-repeat",
            sourceId: "source-a",
            versionId: "version-a",
            text: "第一部分补充。",
            section: "第一部分",
            order: 3,
          },
        ],
      }),
    );

    expect(items).toEqual([
      expect.objectContaining({
        id: "chunk:chapter-a",
        title: "第一部分",
        locator: "第一部分内容。",
        kind: "chunk-section",
      }),
      expect.objectContaining({
        id: "chunk:chapter-b",
        title: "第二部分",
        locator: "第二部分内容。",
        kind: "chunk-section",
      }),
    ]);
  });

  it("omits a named chunk section when its saved locator appears more than once", () => {
    const items = deriveReaderOutline(
      source({
        kind: "docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: "重复段落.docx",
        text: "重复段落。\n\n中间内容。\n\n重复段落。\n\n安全段落。",
        chunks: [
          {
            id: "ambiguous",
            sourceId: "source-a",
            versionId: "version-a",
            text: "重复段落。",
            section: "重复章节",
            order: 0,
          },
          {
            id: "safe",
            sourceId: "source-a",
            versionId: "version-a",
            text: "安全段落。",
            section: "安全章节",
            order: 1,
          },
        ],
      }),
    );

    expect(items).toEqual([
      expect.objectContaining({ id: "chunk:safe", title: "安全章节", locator: "安全段落。" }),
    ]);
  });

  it("does not turn a PDF page list or an unstructured body into a fabricated directory", () => {
    const pdf = source({
      kind: "pdf",
      mime: "application/pdf",
      filename: "资料.pdf",
      chunks: [
        {
          id: "page-one",
          sourceId: "source-a",
          versionId: "version-a",
          text: "第一页文字。",
          section: "第 1 页",
          page: 1,
          order: 0,
        },
      ],
    });
    const unstructured = source({
      kind: "docx",
      filename: "资料.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      text: "只有连续正文。",
      chunks: [
        {
          id: "body",
          sourceId: "source-a",
          versionId: "version-a",
          text: "只有连续正文。",
          section: "正文",
          order: 0,
        },
      ],
    });

    expect(deriveReaderOutline(pdf)).toEqual([]);
    expect(deriveReaderOutline(unstructured)).toEqual([]);
  });
});
