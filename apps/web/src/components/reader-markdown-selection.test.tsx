// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import { resolveSavedCitation } from "@/lib/retrieval";
import type { Annotation, Source } from "@/lib/types";
import Reader, { type ReaderProps } from "./reader";

vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./pdf-reader", () => ({ default: () => null }));
vi.mock("./web-version-panel", () => ({ default: () => null }));

const raw = "学习 **梯度下降** 的步骤。";
const visible = "学习 梯度下降 的步骤。";

describe("Reader native selections across Markdown inline formatting", () => {
  let host: HTMLDivElement;
  let root: Root;
  let source: Source;
  let props: ReaderProps;
  let writeClipboard: ReturnType<typeof vi.fn>;
  let clipboardDescriptor: PropertyDescriptor | undefined;
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
    scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    writeClipboard = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: writeClipboard },
    });

    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const workspace = createDemoWorkspace();
    source = {
      ...workspace.sources[0]!,
      id: "markdown-source",
      versionId: "markdown-version",
      title: "固定版本 Markdown 资料",
      kind: "markdown",
      text: `# 训练笔记\n\n${raw}`,
      aiAllowed: true,
      chunks: [
        {
          id: "formatted-chunk",
          sourceId: "markdown-source",
          versionId: "markdown-version",
          text: raw,
          section: "训练笔记",
          order: 0,
        },
      ],
    };
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
      onSaveExcerptToKnowledgePage: vi.fn(() => "梯度下降摘录"),
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
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
    if (scrollDescriptor)
      Object.defineProperty(Element.prototype, "scrollIntoView", scrollDescriptor);
    else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function render(overrides: Partial<ReaderProps> = {}) {
    props = { ...props, ...overrides };
    await act(async () => root.render(createElement(Reader, props)));
  }

  async function selectNode(node: Node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    await selectRange(range);
  }

  async function selectRange(range: Range) {
    await act(async () => {
      Object.defineProperty(range, "getClientRects", {
        configurable: true,
        value: () => [{ left: 120, top: 220, width: 180, bottom: 244 }],
      });
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
  }

  async function selectParagraph(index = 0) {
    const paragraphs = host.querySelectorAll("[data-reader-text] p");
    expect(paragraphs[index]?.textContent).toBe(visible);
    expect(paragraphs[index]?.querySelector("strong")?.textContent).toBe("梯度下降");
    await selectNode(paragraphs[index]!);
    expect(window.getSelection()?.toString()).toBe(visible);
  }

  function button(text: string) {
    const candidate = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.replace(/\s/gu, "") === text.replace(/\s/gu, ""),
    );
    expect(candidate, `button ${text}`).toBeTruthy();
    return candidate!;
  }

  async function click(text: string) {
    await act(async () => button(text).click());
  }

  async function type(textarea: HTMLTextAreaElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        value,
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("saves an exact raw annotation while its compose and saved previews show visible text", async () => {
    await selectParagraph();
    await click("高亮");
    const compose = host.querySelector<HTMLFormElement>('form[aria-label="新增批注"]')!;
    expect(compose.querySelector("blockquote")?.textContent).toBe(visible);
    await type(compose.querySelector<HTMLTextAreaElement>("textarea")!, "自己推导一次。");
    await act(async () =>
      compose.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(props.onAnnotationAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: source.id,
        versionId: source.versionId,
        quote: raw,
        note: "自己推导一次。",
      }),
    );
    expect(host.querySelector(".reader-annotation-card blockquote")?.textContent).toBe(visible);
  });

  it("copies visible text but sends the exact raw selected excerpt and version to question answering", async () => {
    await selectParagraph();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="复制选段"]')!.click(),
    );
    expect(writeClipboard).toHaveBeenCalledWith(visible);
    await act(async () => host.querySelector<HTMLButtonElement>(".reader-selection-ask")!.click());
    expect(host.querySelector(".reader-selected-quote blockquote")?.textContent).toBe(visible);
    await type(
      host.querySelector<HTMLTextAreaElement>('[aria-label="向资料提问"]')!,
      "解释这一步。",
    );
    await act(async () =>
      host
        .querySelector("form.reader-composer")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(props.onAsk).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "selection",
        sourceId: source.id,
        selection: raw,
        sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
      }),
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });

  it("saves a new note with an exact raw source citation from the formatted selection", async () => {
    await selectParagraph();
    await click("存笔记");
    expect(props.onSaveNote).toHaveBeenCalledWith(
      `> ${raw}\n\n`,
      [
        expect.objectContaining({
          sourceId: source.id,
          versionId: source.versionId,
          chunkId: "formatted-chunk",
          quote: raw,
        }),
      ],
      "note",
    );
    const citation = vi.mocked(props.onSaveNote).mock.calls[0]![1][0]!;
    expect(
      resolveSavedCitation({ ...createDemoWorkspace(), sources: [source] }, citation)?.chunk.id,
    ).toBe("formatted-chunk");
  });

  it("saves a knowledge-page excerpt with the raw quote and exact version anchor", async () => {
    await selectParagraph();
    await click("存知识页");
    expect(host.querySelector('[role="dialog"] blockquote')?.textContent).toBe(visible);
    await click("新建知识页草稿");
    expect(props.onSaveExcerptToKnowledgePage).toHaveBeenCalledWith({
      spaceId: props.space.id,
      sourceId: source.id,
      versionId: source.versionId,
      quote: raw,
      anchorChunkId: "formatted-chunk",
    });
  });

  it("anchors the second identical formatted paragraph to its second source chunk", async () => {
    const first = `# 第一节\n\n${raw}`;
    const second = `# 第二节\n\n${raw}`;
    source = {
      ...source,
      text: `${first}\n\n${second}`,
      chunks: [first, second].map((text, order) => ({
        id: `repeated-chunk-${order}`,
        sourceId: source.id,
        versionId: source.versionId,
        text,
        section: order ? "第二节" : "第一节",
        order,
      })),
    };
    await render({ source, sources: [source] });
    await selectParagraph(1);
    await click("存笔记");
    expect(props.onSaveNote).toHaveBeenCalledWith(
      `> ${raw}\n\n`,
      [
        expect.objectContaining({
          chunkId: "repeated-chunk-1",
          quote: second,
        }),
      ],
      "note",
    );
    const citation = vi.mocked(props.onSaveNote).mock.calls[0]![1][0]!;
    expect(
      resolveSavedCitation({ ...createDemoWorkspace(), sources: [source] }, citation)?.chunk.id,
    ).toBe("repeated-chunk-1");
    await click("存知识页");
    await click("新建知识页草稿");
    expect(props.onSaveExcerptToKnowledgePage).toHaveBeenCalledWith(
      expect.objectContaining({
        quote: raw,
        anchorChunkId: "repeated-chunk-1",
      }),
    );
  });

  it("rejects document header and unmapped raw HTML selections as source excerpts", async () => {
    const header = host.querySelector(".reader-document-scroll header h1");
    expect(header).toBeTruthy();
    await selectNode(header!);
    const headerToolbar = host.querySelector('[role="toolbar"][aria-label^="已选中"]') !== null;
    source = {
      ...source,
      text: "<div>非 Markdown HTML 片段。</div>",
      chunks: [{ ...source.chunks[0]!, text: "<div>非 Markdown HTML 片段。</div>" }],
    };
    await render({ source, sources: [source] });
    await selectNode(host.querySelector("[data-reader-text]")!);
    expect({
      headerToolbar,
      htmlToolbar: host.querySelector('[role="toolbar"][aria-label^="已选中"]') !== null,
    }).toEqual({ headerToolbar: false, htmlToolbar: false });
    expect(props.onAnnotationAdd).not.toHaveBeenCalled();
    expect(props.onSaveNote).not.toHaveBeenCalled();
    expect(props.onSaveExcerptToKnowledgePage).not.toHaveBeenCalled();
    expect(props.onAsk).not.toHaveBeenCalled();
  });

  it("locates a saved partial-format raw annotation at its exact visible native range", async () => {
    class NativeRangeHighlight extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    }
    const highlights = new Map<string, NativeRangeHighlight>();
    vi.stubGlobal("CSS", { highlights });
    vi.stubGlobal("Highlight", NativeRangeHighlight);
    const paragraph = host.querySelector("[data-reader-text] p")!;
    const range = document.createRange();
    range.setStart(paragraph.querySelector("strong")!.firstChild!, 1);
    range.setEnd(paragraph.lastChild!, paragraph.lastChild!.textContent!.length);
    await selectRange(range);
    const partialRaw = "度下降** 的步骤。";
    const partialVisible = "度下降 的步骤。";
    expect(window.getSelection()?.toString()).toBe(partialVisible);
    await click("高亮");
    expect(host.querySelector(".reader-annotation-compose blockquote")?.textContent).toBe(
      partialVisible,
    );
    await act(async () =>
      host
        .querySelector('form[aria-label="新增批注"]')!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(props.onAnnotationAdd).toHaveBeenCalledWith(
      expect.objectContaining({ quote: partialRaw }),
    );
    const annotationRanges = [...highlights.get("reader-annotation")!];
    expect(annotationRanges).toHaveLength(1);
    expect(annotationRanges[0]!.toString()).toBe(partialVisible);
    expect(annotationRanges[0]!.startContainer.parentElement?.closest("p")).toBe(paragraph);
    await act(async () =>
      host.querySelector<HTMLButtonElement>(".reader-annotation-locate")!.click(),
    );
    expect([...highlights.get("reader-citation")!][0]?.toString()).toBe(partialVisible);
  });

  it("preserves a native selection across paragraphs and chunks for annotations and questions", async () => {
    const paragraphsRaw = ["先学习 **梯度下降**。", "再记录 *学习率*。"];
    source = {
      ...source,
      text: paragraphsRaw.join("\n\n"),
      chunks: paragraphsRaw.map((text, order) => ({
        id: `cross-paragraph-chunk-${order}`,
        sourceId: source.id,
        versionId: source.versionId,
        text,
        section: "跨段笔记",
        order,
      })),
    };
    await render({ source, sources: [source] });
    const paragraphs = host.querySelectorAll("[data-reader-text] p");
    const range = document.createRange();
    range.setStart(paragraphs[0]!.firstChild!, 0);
    range.setEnd(paragraphs[1]!.lastChild!, paragraphs[1]!.lastChild!.textContent!.length);
    await selectRange(range);
    await click("高亮");
    await act(async () =>
      host
        .querySelector('form[aria-label="新增批注"]')!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(props.onAnnotationAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: source.id,
        versionId: source.versionId,
        quote: source.text,
      }),
    );
    await act(async () => host.querySelector<HTMLButtonElement>(".reader-selection-ask")!.click());
    const originalFormat = host.querySelector<HTMLDetailsElement>(
      ".reader-selection-source-format",
    );
    expect(originalFormat?.querySelector("summary")?.textContent).toBe("查看原文格式");
    expect(originalFormat?.querySelector("blockquote")?.textContent).toBe(source.text);
    await type(
      host.querySelector<HTMLTextAreaElement>('[aria-label="向资料提问"]')!,
      "这两段如何关联？",
    );
    await act(async () =>
      host
        .querySelector("form.reader-composer")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(props.onAsk).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "selection",
        selection: source.text,
        sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
      }),
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });
});
