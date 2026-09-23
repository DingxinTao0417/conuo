// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Reader, { type ReaderProps } from "./reader";
import { createDemoWorkspace } from "@/lib/seed";
import type { Annotation, Citation, Conversation, Source } from "@/lib/types";

vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./pdf-reader", () => ({ default: () => null }));
vi.mock("./web-version-panel", () => ({ default: () => null }));

const quote = "学习率过大时，参数可能反复越过较好的位置，损失出现振荡。";

/**
 * The reader owns one panel slot beside the document and a separate AI panel.
 * These cover the rules that used to depend on every opener remembering to
 * close the others.
 */
describe("reader panel slot", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: ReaderProps;
  let source: Source;
  let citation: Citation;
  let scrollDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(0), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
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
      ...workspace.sources[0],
      id: "panel-source",
      versionId: "panel-version",
      kind: "markdown",
      aiAllowed: true,
      text: `# 优化器基础\n\n## 学习率\n\n${quote}`,
      spaceIds: [workspace.spaces[0].id],
      chunks: [
        {
          id: "panel-chunk",
          sourceId: "panel-source",
          versionId: "panel-version",
          text: quote,
          section: "学习率",
          order: 0,
        },
      ],
    };
    citation = {
      sourceId: source.id,
      versionId: source.versionId,
      chunkId: "panel-chunk",
      title: "机器学习入门.md",
      quote,
      section: "学习率",
    };
    props = {
      source,
      sources: [source],
      space: workspace.spaces[0],
      conversations: [],
      annotations: [],
      aiEnabled: true,
      onSourceChange: vi.fn(),
      onConversationChange: vi.fn(),
      onAnnotationAdd: vi.fn(),
      onSaveNote: vi.fn(),
      onAsk: vi.fn(async () => ({ content: "", citations: [], mode: "extractive" as const })),
      onOpenSource: vi.fn(),
      onBack: vi.fn(),
      getSourceBlob: vi.fn(async () => undefined),
    };
    await render();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    if (scrollDescriptor)
      Object.defineProperty(Element.prototype, "scrollIntoView", scrollDescriptor);
    else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    vi.unstubAllGlobals();
  });

  async function render(overrides: Partial<ReaderProps> = {}) {
    props = { ...props, ...overrides };
    await act(async () => {
      root.render(createElement(Reader, props));
    });
  }

  async function click(button: HTMLButtonElement) {
    await act(async () => {
      button.click();
    });
  }

  function trigger(selector: string) {
    const result = host.querySelector<HTMLButtonElement>(selector);
    expect(result, selector).toBeTruthy();
    return result!;
  }

  function annotation(): Annotation {
    return {
      id: "panel-annotation",
      sourceId: source.id,
      versionId: source.versionId,
      quote,
      note: "这里需要复习。",
      textAnchor: { start: source.text.indexOf(quote), end: source.text.indexOf(quote) + 12 },
      createdAt: "2026-09-13T00:00:00.000Z",
    };
  }

  function answerConversation(): Conversation {
    return {
      id: "panel-conversation",
      spaceId: props.space.id,
      sourceId: source.id,
      title: "学习率问题",
      scope: "document",
      sourceIds: [source.id],
      resolved: false,
      updatedAt: "2026-09-13T00:00:00.000Z",
      messages: [
        {
          id: "panel-answer",
          role: "assistant",
          content: "回答引用了原文。 [1]",
          citations: [citation],
          createdAt: "2026-09-13T00:00:00.000Z",
          mode: "model",
        },
      ],
    };
  }

  /** Opens the located excerpt card the way an answer citation does. */
  async function openCitationFromAnswer(overrides: Partial<ReaderProps> = {}) {
    await render({ conversations: [answerConversation()], ...overrides });
    await click(trigger('[aria-label^="查看引用 1："]'));
    const open = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.replace(/\s+/gu, "") === "打开原文位置",
    );
    expect(open).toBeTruthy();
    await click(open!);
    expect(host.querySelector(".reader-citation-target")).toBeTruthy();
  }

  function toolstrip() {
    const strip = host.querySelector<HTMLElement>("[data-reader-desktop-bottom-controls]");
    expect(strip).toBeTruthy();
    return strip!;
  }

  /** What the bottom controls offer, in the order a learner reads it. */
  function toolstripControls() {
    return [...toolstrip().querySelectorAll<HTMLElement>("button, input")].map(
      (control) =>
        control.getAttribute("aria-label") ||
        control.textContent?.replace(/\s+/gu, "") ||
        control.tagName,
    );
  }

  it("renders reading tools for the format that is open", async () => {
    const pdf: Source = {
      ...source,
      id: "pdf-source",
      versionId: "pdf-version",
      kind: "pdf",
      mime: "application/pdf",
      filename: "机器学习入门.pdf",
      pageCount: 12,
      text: "",
      chunks: [],
    };
    await render({ source: pdf, sources: [pdf] });
    expect(toolstripControls()).toEqual([
      "上一页",
      "下一页",
      "跳转页码",
      "解析文本",
      "框选区域交给 AI",
      "我的标注（0）",
      "缩小",
      "100%",
      "放大",
    ]);
    expect(host.querySelectorAll('[aria-label="PDF 阅读模式"]')).toHaveLength(0);
    expect(host.querySelector("[data-reader-document-tools]")).toBeNull();

    // Text formats have neither pages nor a physical page to frame.
    for (const kind of ["docx", "markdown", "web"] as const) {
      const text: Source = {
        ...source,
        id: `${kind}-source`,
        versionId: `${kind}-version`,
        kind,
        text: "只有连续正文。",
        chunks: [],
        ...(kind === "web" ? { url: "https://example.com/a" } : {}),
      };
      await render({ source: text, sources: [text] });
      expect(toolstripControls(), kind).toEqual(["我的标注（0）", "缩小", "100%", "放大"]);
      expect(toolstrip().querySelector("[data-reader-region-trigger]"), kind).toBeNull();
    }

    // Structure is a property of the document, not of its format.
    await render({ source, sources: [source] });
    expect(toolstrip().querySelector("[data-reader-outline-trigger]")).toBeTruthy();
  });

  it("keeps format tools in the shared bottom controls without a phone expand toggle", async () => {
    const pdf: Source = {
      ...source,
      id: "pdf-tools-source",
      versionId: "pdf-tools-version",
      kind: "pdf",
      mime: "application/pdf",
      filename: "机器学习入门.pdf",
      pageCount: 12,
      text: "",
      chunks: [],
    };
    await render({ source: pdf, sources: [pdf] });
    expect(host.querySelector("[data-reader-toolstrip-toggle]")).toBeNull();
    expect(toolstrip().querySelector("[data-reader-annotation-trigger]")).toBeTruthy();
    expect(toolstrip().querySelector("[data-reader-region-trigger]")).toBeTruthy();
    expect(toolstrip().querySelector('[aria-label="缩小"]')).toBeTruthy();
    expect(toolstrip().querySelector('[aria-label="放大"]')).toBeTruthy();
  });

  it("gives the document one panel at a time", async () => {
    await render({ annotations: [annotation()] });
    const outline = trigger("[data-reader-outline-trigger]");
    const find = trigger("[data-reader-search-trigger]");
    const annotations = trigger("[data-reader-annotation-trigger]");

    await click(outline);
    expect(host.querySelector("#reader-outline-panel")).toBeTruthy();

    await click(find);
    expect(host.querySelector("#reader-find-panel")).toBeTruthy();
    expect(host.querySelector("#reader-outline-panel")).toBeNull();
    expect(outline.getAttribute("aria-expanded")).toBe("false");

    await click(annotations);
    expect(host.querySelector("#reader-annotations-panel")).toBeTruthy();
    expect(host.querySelector("#reader-find-panel")).toBeNull();
    expect(find.getAttribute("aria-expanded")).toBe("false");

    await click(trigger('[aria-label="更多资料操作"]'));
    expect(host.querySelector("#reader-source-actions-menu")).toBeTruthy();
    expect(host.querySelector("#reader-annotations-panel")).toBeNull();

    await click(annotations);
    expect(host.querySelector("#reader-annotations-panel")).toBeTruthy();
    expect(host.querySelector("#reader-source-actions-menu")).toBeNull();
  });

  it("keeps the Ask AI panel next to whichever document panel is open", async () => {
    await click(trigger("[data-reader-outline-trigger]"));

    expect(host.querySelector("#reader-ai-panel")).toBeTruthy();
    expect(host.querySelector("#reader-outline-panel")).toBeTruthy();
    expect(host.querySelector(".reader-workspace")?.className).toContain("reader-with-ai");

    // Closing the conversation must not disturb the document panel, and the
    // document panel must not close the conversation.
    await click(trigger('[aria-label="收起问答面板"]'));
    expect(host.querySelector("#reader-ai-panel")).toBeNull();
    expect(host.querySelector("#reader-outline-panel")).toBeTruthy();

    await click(trigger(".reader-ai-toggle"));
    expect(host.querySelector("#reader-ai-panel")).toBeTruthy();
    expect(host.querySelector("#reader-outline-panel")).toBeTruthy();
  });

  it("separates the located citation from the panel showing it", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(max-width: 1024px)" || query === "(max-width: 620px)",
      })),
    );
    await openCitationFromAnswer();
    expect(host.querySelector<HTMLElement>('[aria-label="引用原文"]')?.textContent).toContain(
      quote,
    );

    // Find takes the panel slot, so the excerpt card closes. The citation
    // itself is still the reader's located target: the phone citation page
    // reads the evidence, not the panel state.
    await click(trigger("[data-reader-search-trigger]"));
    expect(host.querySelector("#reader-find-panel")).toBeTruthy();
    expect(host.querySelector(".reader-citation-target")).toBeNull();
    expect(host.querySelector<HTMLElement>('[aria-label="引用原文"]')?.textContent).toContain(
      quote,
    );
  });

  it("does not close an open panel when the reader drops its located citation", async () => {
    await openCitationFromAnswer({ annotations: [annotation()] });

    await click(trigger("[data-reader-annotation-trigger]"));
    expect(host.querySelector("#reader-annotations-panel")).toBeTruthy();
    expect(host.querySelector(".reader-citation-target")).toBeNull();

    // Locating an annotation drops the citation highlight. Only the citation
    // card answers to that, so the list the learner is working in stays open.
    await click(trigger('[aria-label^="定位批注："]'));
    expect(host.querySelector("#reader-annotations-panel")).toBeTruthy();
  });
});
