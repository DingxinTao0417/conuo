// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import type { Annotation, Source } from "@/lib/types";
import Reader, { type ReaderProps } from "./reader";

vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./web-version-panel", () => ({ default: () => null }));
vi.mock("./pdf-reader", () => ({
  default: ({
    source,
    page,
    onRendered,
  }: {
    source: Source;
    page: number;
    onRendered: () => void;
  }) => (
    <div data-reader-page={page}>
      <div
        className="reader-pdf-text textLayer"
        data-reader-text="true"
        data-reader-source-id={source.id}
        data-reader-source-version={source.versionId}
        data-reader-page={page}
      >
        <span>
          {source.chunks
            .filter((chunk) => chunk.page === page)
            .map((chunk) => chunk.text)
            .join("")}
        </span>
      </div>
      <button onClick={onRendered}>模拟 PDF 渲染完成</button>
    </div>
  ),
}));

type PositionedAnnotation = Annotation & { textAnchor: { start: number; end: number } };

class NativeHighlight extends Set<Range> {
  constructor(...ranges: Range[]) {
    super(ranges);
  }
}

const raw = "学习 **梯度下降** 的步骤。";
const visible = "学习 梯度下降 的步骤。";

describe("Reader version-bound positions for repeated annotations", () => {
  let host: HTMLDivElement;
  let root: Root;
  let source: Source;
  let props: ReaderProps;
  let highlights: Map<string, NativeHighlight>;
  let scrollDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(0), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: false,
      media,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    highlights = new Map();
    vi.stubGlobal("CSS", { highlights });
    vi.stubGlobal("Highlight", NativeHighlight);
    scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });

    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const workspace = createDemoWorkspace();
    source = {
      ...workspace.sources[0]!,
      id: "position-source",
      versionId: "position-version",
      title: "重复原文资料",
      kind: "markdown",
      text: raw,
      chunks: [],
      aiAllowed: true,
    };
    setParagraphs([raw, raw]);
    props = {
      source,
      sources: [source],
      space: workspace.spaces[0]!,
      conversations: [],
      annotations: [],
      notes: [],
      aiEnabled: true,
      onSourceChange: vi.fn(),
      onConversationChange: vi.fn(),
      onAnnotationAdd: vi.fn((annotation: Annotation) => {
        props = { ...props, annotations: [...props.annotations, annotation] };
        root.render(createElement(Reader, props));
      }),
      onSaveNote: vi.fn(),
      onAsk: vi.fn(async () => ({ content: "", citations: [], mode: "extractive" as const })),
      onOpenSource: vi.fn(),
      onBack: vi.fn(),
      getSourceBlob: vi.fn(async () => undefined),
    };
    await render();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    window.getSelection()?.removeAllRanges();
    host.remove();
    if (scrollDescriptor)
      Object.defineProperty(Element.prototype, "scrollIntoView", scrollDescriptor);
    else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function setParagraphs(paragraphs: string[], kind: Source["kind"] = "markdown") {
    source = {
      ...source,
      kind,
      text: paragraphs.join("\n\n"),
      chunks: paragraphs.map((text, order) => ({
        id: `position-chunk-${order}`,
        sourceId: source.id,
        versionId: source.versionId,
        text,
        section: `段落 ${order + 1}`,
        order,
      })),
    };
  }

  async function render(overrides: Partial<ReaderProps> = {}) {
    props = { ...props, source, sources: [source], ...overrides };
    await act(async () => root.render(createElement(Reader, props)));
  }

  async function select(range: Range) {
    await act(async () => {
      Object.defineProperty(range, "getClientRects", {
        value: () => [{ left: 120, top: 220, width: 180, bottom: 244 }],
      });
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
  }

  async function selectNode(node: Node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    await select(range);
  }

  async function click(text: string) {
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.replace(/\s/gu, "") === text.replace(/\s/gu, ""),
    );
    expect(button, `button ${text}`).toBeTruthy();
    await act(async () => button!.click());
  }

  async function saveSelection() {
    await click("高亮");
    const form = host.querySelector('form[aria-label="新增批注"]');
    expect(form).toBeTruthy();
    await act(async () =>
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(props.onAnnotationAdd).toHaveBeenCalledTimes(1);
    return vi.mocked(props.onAnnotationAdd).mock.calls[0]![0] as PositionedAnnotation;
  }

  function ranges(key = "reader-annotation") {
    return [...(highlights.get(key) ?? [])];
  }

  function expectRangeIn(node: Element, quote: string, key = "reader-annotation") {
    const actual = ranges(key);
    expect(actual).toHaveLength(1);
    expect(actual[0]!.toString()).toBe(quote);
    expect(node.contains(actual[0]!.startContainer)).toBe(true);
    expect(node.contains(actual[0]!.endContainer)).toBe(true);
  }

  async function openAnnotations() {
    if (!host.querySelector(".reader-annotations"))
      await act(async () =>
        host.querySelector<HTMLButtonElement>("[data-reader-annotation-trigger]")!.click(),
      );
  }

  async function locate(index = 0) {
    await openAnnotations();
    const button = host.querySelectorAll<HTMLButtonElement>(".reader-annotation-locate")[index];
    expect(button).toBeTruthy();
    await act(async () => button!.click());
  }

  function legacy(quote: string): Annotation {
    return {
      id: "legacy-annotation",
      sourceId: source.id,
      versionId: source.versionId,
      quote,
      note: "保留旧笔记",
      createdAt: "2026-09-12T00:00:00.000Z",
    };
  }

  function expectInsufficientLocation() {
    expect(ranges("reader-citation")).toHaveLength(0);
    const message = [...host.querySelectorAll('[role="status"], [role="alert"]')]
      .map((element) => element.textContent)
      .join(" ");
    expect(message).toMatch(/定位|位置/);
    expect(message).toMatch(/不足|无法|不完整|重复|暂未|不能|不唯一|没有|未.*准确/);
  }

  it("persists the second identical Markdown paragraph and locates that same range after remount", async () => {
    const second = host.querySelectorAll("[data-reader-text] p")[1]!;
    await selectNode(second);
    const saved = await saveSelection();
    const start = source.text.lastIndexOf(raw);
    expect(saved).toMatchObject({ quote: raw, textAnchor: { start, end: start + raw.length } });
    expectRangeIn(second, visible);
    await act(async () => root.unmount());
    root = createRoot(host);
    await render({ annotations: [JSON.parse(JSON.stringify(saved)) as Annotation] });
    const restoredSecond = host.querySelectorAll("[data-reader-text] p")[1]!;
    expectRangeIn(restoredSecond, visible);
    await locate();
    expectRangeIn(restoredSecond, visible, "reader-citation");
    vi.mocked(Element.prototype.scrollIntoView).mockClear();
    await locate();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expectRangeIn(restoredSecond, visible, "reader-citation");
    expect(props.onOpenSource).not.toHaveBeenCalled();
    expect(props.onSaveNote).not.toHaveBeenCalled();
  });

  it("retains UTF16 offsets for a partial strong selection following an emoji", async () => {
    const sentence = "😀 学习 **梯度下降** 的步骤。";
    setParagraphs([sentence, sentence]);
    await render();
    const second = host.querySelectorAll("[data-reader-text] p")[1]!;
    const text = second.querySelector("strong")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 1);
    range.setEnd(text, 3);
    await select(range);
    expect(window.getSelection()!.toString()).toBe("度下");
    const saved = await saveSelection();
    const start = source.text.lastIndexOf("度下");
    expect(saved).toMatchObject({ quote: "度下", textAnchor: { start, end: start + 2 } });
    expect(start).toBeGreaterThan([...source.text.slice(0, start)].length);
    expectRangeIn(second, "度下");
    await locate();
    expectRangeIn(second, "度下", "reader-citation");
  });

  it("does not guess a repeated legacy quote but still locates an unambiguous old annotation", async () => {
    await render({ annotations: [legacy(raw)] });
    expect(ranges()).toHaveLength(0);
    await locate();
    expectInsufficientLocation();
    setParagraphs(["仅此一次 **学习率**。", raw, raw]);
    await render({ annotations: [legacy("仅此一次 **学习率**。")] });
    const first = host.querySelector("[data-reader-text] p")!;
    expectRangeIn(first, "仅此一次 学习率。");
    await locate();
    expectRangeIn(first, "仅此一次 学习率。", "reader-citation");
  });

  it("maps the second repeated TXT paragraph from a native range to exact source positions", async () => {
    const sentence = "学习 梯度下降 的步骤。";
    setParagraphs([sentence, sentence], "text");
    await render();
    const second = host.querySelectorAll("[data-reader-text] p")[1]!;
    await selectNode(second);
    const saved = await saveSelection();
    const start = source.text.lastIndexOf(sentence);
    expect(saved).toMatchObject({
      quote: sentence,
      textAnchor: { start, end: source.text.length },
    });
    expectRangeIn(second, sentence);
    await locate();
    expectRangeIn(second, sentence, "reader-citation");
  });

  it("uses the retained webpage Markdown body to anchor its second identical paragraph", async () => {
    setParagraphs([raw, raw], "web");
    source = { ...source, url: "https://example.com/article" };
    await render();
    const second = host.querySelectorAll("[data-reader-text] p")[1]!;
    expect(second.querySelector("strong")?.textContent).toBe("梯度下降");
    await selectNode(second);
    const saved = await saveSelection();
    expect(saved).toMatchObject({
      quote: raw,
      textAnchor: { start: source.text.lastIndexOf(raw), end: source.text.length },
    });
    expectRangeIn(second, visible);
    await locate();
    expectRangeIn(second, visible, "reader-citation");
  });

  it("rejects stale version, changed raw text, and modified DOM rather than choosing another similar quote", async () => {
    const start = source.text.lastIndexOf(raw);
    const saved: PositionedAnnotation = {
      ...legacy(raw),
      textAnchor: { start, end: source.text.length },
    };
    await render({ annotations: [saved] });
    const second = host.querySelectorAll("[data-reader-text] p")[1]!;
    expectRangeIn(second, visible);
    source = {
      ...source,
      versionId: "another-version",
      chunks: source.chunks.map((chunk) => ({ ...chunk, versionId: "another-version" })),
    };
    await render({ annotations: [saved] });
    expect(ranges()).toHaveLength(0);
    source = {
      ...source,
      versionId: saved.versionId,
      text: `变更前缀。\n\n${source.text}`,
      chunks: source.chunks.map((chunk) => ({ ...chunk, versionId: saved.versionId })),
    };
    await render({ annotations: [saved] });
    expect(ranges()).toHaveLength(0);
    await locate();
    expectInsufficientLocation();
    setParagraphs([raw, raw]);
    await render({ annotations: [saved] });
    const prose = host.querySelector<HTMLElement>("[data-reader-text]")!;
    prose.querySelectorAll("p")[1]!.textContent = "改变 DOM 内容。";
    await render({ annotations: [{ ...saved }] });
    expect(ranges()).toHaveLength(0);
    await locate();
    expectInsufficientLocation();
    setParagraphs([raw]);
    // Corrupt stored or in-memory anchors must never masquerade as legacy records,
    // even when the source quote is unique and a loose text fallback would succeed.
    for (const textAnchor of [null, { start: Number.NaN, end: raw.length }, { end: raw.length }]) {
      const corrupt = { ...legacy(raw), textAnchor } as unknown as Annotation;
      await render({ annotations: [corrupt] });
      expect(ranges()).toHaveLength(0);
      await locate();
      expectInsufficientLocation();
    }
  });

  it("anchors a repeated PDF quote to page two and rejects an exact quote anchor that belongs to page one", async () => {
    const sentence = "学习 梯度下降 的步骤。";
    setParagraphs([sentence, sentence], "pdf");
    source = {
      ...source,
      pageCount: 2,
      readPage: 2,
      chunks: source.chunks.map((chunk, order) => ({ ...chunk, page: order + 1 })),
    };
    // Open this external renderer as a fresh Reader so its current page is initialized from the source.
    await act(async () => root.unmount());
    root = createRoot(host);
    await render();
    await click("模拟 PDF 渲染完成");
    const layer = host.querySelector('[data-reader-page="2"] [data-reader-text]')!;
    await selectNode(layer.querySelector("span")!);
    const saved = await saveSelection();
    expect(saved).toMatchObject({
      quote: sentence,
      page: 2,
      textAnchor: { start: source.text.lastIndexOf(sentence), end: source.text.length },
    });
    expectRangeIn(layer, sentence);
    await locate();
    expectRangeIn(layer, sentence, "reader-citation");
    const forged = { ...saved, textAnchor: { start: 0, end: sentence.length } };
    await render({ annotations: [forged] });
    expect(ranges()).toHaveLength(0);
    await locate();
    expectInsufficientLocation();
  });
});
