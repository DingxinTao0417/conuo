// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Annotation, Source } from "@/lib/types";
import {
  annotationRangeResolver,
  locateUniqueTextAnchor,
  readNativePdfSelectionPage,
  readPlainAnnotationSelection,
} from "./annotation-selection";

describe("locateUniqueTextAnchor", () => {
  it("anchors an exact unique quote and refuses duplicates", () => {
    const text = "前言。目标句在此。后记。";
    expect(locateUniqueTextAnchor({ text }, "目标句在此。")).toEqual({
      quote: "目标句在此。",
      textAnchor: { start: 3, end: 9 },
    });
    expect(locateUniqueTextAnchor({ text: "重复段。重复段。" }, "重复段。")).toBeNull();
  });

  it("maps whitespace-insensitive unique matches back to raw source text", () => {
    const text = "定义。  两个向量  正交。";
    expect(locateUniqueTextAnchor({ text }, "定义。两个向量正交。")).toEqual({
      quote: "定义。  两个向量  正交。",
      textAnchor: { start: 0, end: text.length },
    });
  });
});

describe("owned PDF selections and annotations across mounted pages", () => {
  let host: HTMLDivElement;
  let source: Source;
  const sentence = "学习 梯度下降 的步骤。";
  const pages = [sentence, sentence, "仅第三页有这段文字。"];

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    source = {
      id: "pdf-source",
      versionId: "pdf-version",
      title: "连续 PDF",
      filename: "continuous.pdf",
      kind: "pdf",
      mime: "application/pdf",
      size: 1,
      hash: "pdf-hash",
      spaceIds: [],
      tags: [],
      status: "ready",
      text: pages.join("\n\n"),
      chunks: pages.map((text, order) => ({
        id: `chunk-${order + 1}`,
        sourceId: "pdf-source",
        versionId: "pdf-version",
        order,
        text,
        page: order + 1,
        section: `第 ${order + 1} 页`,
      })),
      pageCount: 3,
      createdAt: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-09-15T00:00:00.000Z",
      deletedAt: null,
      aiAllowed: true,
      starred: false,
    };
  });

  afterEach(() => host.remove());

  function layer(page: number, text = pages[page - 1]) {
    const body = document.createElement("div");
    body.className = "reader-pdf-text textLayer";
    body.dataset.readerText = "true";
    body.dataset.readerSourceId = source.id;
    body.dataset.readerSourceVersion = source.versionId;
    body.dataset.readerPage = String(page);
    const span = document.createElement("span");
    span.textContent = text;
    body.append(span);
    host.append(body);
    return body;
  }

  function selection(body: HTMLElement) {
    const range = document.createRange();
    range.selectNodeContents(body.querySelector("span")!);
    return range;
  }

  function annotation(page?: number, anchored = false): Annotation {
    const quote = pages[(page ?? 1) - 1];
    const start = pages.slice(0, (page ?? 1) - 1).reduce((sum, text) => sum + text.length + 2, 0);
    return {
      id: "annotation",
      sourceId: source.id,
      versionId: source.versionId,
      quote,
      note: "保存批注",
      createdAt: source.createdAt,
      ...(page === undefined ? {} : { page }),
      ...(anchored ? { textAnchor: { start, end: start + quote.length } } : {}),
    };
  }

  function expectIn(range: Range | null, body: HTMLElement, quote = sentence) {
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe(quote);
    expect(body.contains(range!.startContainer)).toBe(true);
    expect(body.contains(range!.endContainer)).toBe(true);
  }

  it("locates a legacy annotation in a non-first mounted page without matching the identical first page", () => {
    layer(1);
    const second = layer(2);
    expectIn(annotationRangeResolver(host, source)(annotation(2)), second);
  });

  it("uses an exact retained anchor to choose its physical page even without annotation.page", () => {
    layer(1);
    const second = layer(2);
    const saved = annotation(2, true);
    delete saved.page;
    expectIn(annotationRangeResolver(host, source)(saved), second);
  });

  it("rejects a page-two annotation whose exact text anchor actually belongs to page one", () => {
    layer(1);
    layer(2);
    const forged = { ...annotation(2, true), textAnchor: { start: 0, end: sentence.length } };
    expect(annotationRangeResolver(host, source)(forged)).toBeNull();
  });

  it("does not invent uniqueness for a repeated unpaged legacy quote when only one page is mounted", () => {
    layer(2);
    expect(annotationRangeResolver(host, source)(annotation())).toBeNull();
    layer(1);
    expect(annotationRangeResolver(host, source)(annotation())).toBeNull();
  });

  it("allows a globally unique unpaged legacy quote in its actual mounted page", () => {
    layer(1);
    const third = layer(3);
    const saved = annotation(3);
    delete saved.page;
    expectIn(annotationRangeResolver(host, source)(saved), third, pages[2]);
  });

  it("does not locate a missing page in another page containing the same quote", () => {
    layer(1);
    expect(annotationRangeResolver(host, source)(annotation(2))).toBeNull();
    expect(annotationRangeResolver(host, source)(annotation(2, true))).toBeNull();
  });

  it("requires the ready flag and retained DOM proof, then allows a newly prepared resolver after lazy rendering", () => {
    layer(1);
    const second = layer(2, "");
    second.dataset.readerText = "false";
    const beforeRendering = annotationRangeResolver(host, source);
    expect(beforeRendering(annotation(2))).toBeNull();
    second.dataset.readerText = "true";
    second.querySelector("span")!.textContent = sentence;
    expect(beforeRendering(annotation(2))).toBeNull();
    expectIn(annotationRangeResolver(host, source)(annotation(2)), second);
  });

  it("ignores other sources and versions before a valid later owned layer", () => {
    layer(2).dataset.readerSourceId = "another-source";
    layer(2).dataset.readerSourceVersion = "another-version";
    const owned = layer(2);
    expectIn(annotationRangeResolver(host, source)(annotation(2)), owned);
    expect(
      annotationRangeResolver(host, source)({ ...annotation(2), sourceId: "another-source" }),
    ).toBeNull();
    expect(
      annotationRangeResolver(host, source)({ ...annotation(2), versionId: "another-version" }),
    ).toBeNull();
  });

  it("rejects ambiguous duplicate mounted layers claiming the same retained physical page", () => {
    layer(2);
    layer(2);
    expect(annotationRangeResolver(host, source)(annotation(2, true))).toBeNull();
  });

  it("rejects a modified ready layer rather than retaining a cached annotation proof", () => {
    const second = layer(2);
    const resolve = annotationRangeResolver(host, source);
    expectIn(resolve(annotation(2)), second);
    second.querySelector("span")!.textContent = "被替换的文字。";
    expect(resolve(annotation(2))).toBeNull();
    expect(readNativePdfSelectionPage(source, selection(second))).toBe(2);
    expect(readPlainAnnotationSelection(source, selection(second))).toBeNull();
  });

  it("reads the actual selected page and UTF16 source offsets despite identical text in another visible page", () => {
    layer(1);
    const second = layer(2, "学 习\n梯度下降 的步骤。");
    const range = selection(second);
    expect(readNativePdfSelectionPage(source, range)).toBe(2);
    expect(readPlainAnnotationSelection(source, range)).toEqual({
      quote: sentence,
      textAnchor: { start: sentence.length + 2, end: sentence.length * 2 + 2 },
    });
  });

  it("rejects a native selection spanning two physical text layers", () => {
    const first = layer(1);
    const second = layer(2);
    const range = document.createRange();
    range.setStart(first.querySelector("span")!.firstChild!, 0);
    range.setEnd(second.querySelector("span")!.firstChild!, sentence.length);
    expect(readNativePdfSelectionPage(source, range)).toBeUndefined();
    expect(readPlainAnnotationSelection(source, range)).toBeNull();
  });

  it("rejects native selection through nested foreign reader content even within the outer body", () => {
    const second = layer(2);
    const foreign = document.createElement("div");
    foreign.dataset.readerText = "true";
    foreign.dataset.readerSourceId = "another-source";
    foreign.dataset.readerSourceVersion = source.versionId;
    foreign.textContent = sentence;
    second.append(foreign);
    const range = document.createRange();
    range.setStart(second.querySelector("span")!.firstChild!, 0);
    range.setEnd(foreign.firstChild!, sentence.length);
    expect(readNativePdfSelectionPage(source, range)).toBeUndefined();
    expect(readPlainAnnotationSelection(source, range)).toBeNull();
  });

  it("requires physical page identity, source and version ownership, and the true readiness flag", () => {
    const second = layer(2);
    const range = selection(second);
    for (const [key, value] of [
      ["readerText", "false"],
      ["readerText", ""],
      ["readerSourceId", "another-source"],
      ["readerSourceVersion", "another-version"],
      ["readerPage", "0"],
      ["readerPage", "4"],
      ["readerPage", "1.5"],
    ]) {
      const before = second.dataset[key];
      second.dataset[key] = value;
      expect(readNativePdfSelectionPage(source, range)).toBeUndefined();
      expect(readPlainAnnotationSelection(source, range)).toBeNull();
      second.dataset[key] = before;
    }
    expect(readNativePdfSelectionPage({ ...source, chunks: [] }, range)).toBe(2);
    expect(readPlainAnnotationSelection({ ...source, chunks: [] }, range)).toBeNull();
    expect(annotationRangeResolver(host, { ...source, chunks: [] })(annotation(2))).toBeNull();
  });

  it("retains physical selection identity when canonical page text is absent or differs from renderer layout", () => {
    const second = layer(2, "PDF 渲染器当前可选文字");
    const range = selection(second);
    for (const unparsed of [
      { ...source, text: "", chunks: [] },
      { ...source, text: "解析结果存在排版差异。", chunks: [] },
    ]) {
      expect(readNativePdfSelectionPage(unparsed, range)).toBe(2);
      expect(readPlainAnnotationSelection(unparsed, range)).toBeNull();
    }
  });

  it("does not call a non-physical PDF text fallback or non-PDF body a native physical page", () => {
    const second = layer(2, source.text);
    second.classList.remove("textLayer");
    expect(readNativePdfSelectionPage(source, selection(second))).toBeUndefined();
    expect(
      readNativePdfSelectionPage({ ...source, kind: "text" }, selection(second)),
    ).toBeUndefined();
  });
});
