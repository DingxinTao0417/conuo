// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Reader, { type ReaderProps } from "./reader";
import { createDemoWorkspace } from "@/lib/seed";
import type { Source } from "@/lib/types";

const docxMocks = vi.hoisted(() => ({ convert: vi.fn() }));

vi.mock("@/lib/docx-structure", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docx-structure")>()),
  convertDocxToStructure: docxMocks.convert,
}));
vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./pdf-reader", () => ({ default: () => null }));
vi.mock("./web-version-panel", () => ({ default: () => null }));

describe("reader outline navigation", () => {
  let host: HTMLDivElement;
  let root: Root;
  let source: Source;
  let props: ReaderProps;
  let scrollDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    docxMocks.convert.mockReset();
    docxMocks.convert.mockResolvedValue({ blocks: [], messages: [] });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const workspace = createDemoWorkspace();
    source = { ...workspace.sources[0], kind: "markdown", aiAllowed: true };
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
    await act(async () => root.unmount());
    host.remove();
    if (scrollDescriptor)
      Object.defineProperty(Element.prototype, "scrollIntoView", scrollDescriptor);
    else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    vi.unstubAllGlobals();
  });

  async function render(overrides: Partial<ReaderProps> = {}) {
    props = { ...props, ...overrides };
    await act(async () => root.render(createElement(Reader, props)));
  }

  async function click(button: HTMLButtonElement) {
    await act(async () => button.click());
  }

  function outlineTrigger() {
    const result = host.querySelector<HTMLButtonElement>('[aria-label^="打开资料目录"]');
    expect(result).toBeTruthy();
    return result!;
  }

  function outlineItem(title: string) {
    const result = [...host.querySelectorAll<HTMLButtonElement>("[data-reader-outline-item]")].find(
      (item) => item.textContent === title,
    );
    expect(result, `outline item ${title}`).toBeTruthy();
    return result!;
  }

  it("opens a Markdown directory and jumps to the exact rendered heading", async () => {
    const trigger = outlineTrigger();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await click(trigger);
    expect(host.querySelector('[aria-label="资料目录"]')).toBeTruthy();
    const target = [...host.querySelectorAll<HTMLElement>(".reader-prose h2")].find(
      (heading) => heading.textContent === "学习率决定每一步走多远",
    );
    expect(target).toBeTruthy();
    const targetScroll = vi.fn();
    Object.defineProperty(target!, "scrollIntoView", {
      configurable: true,
      value: targetScroll,
    });

    await click(outlineItem("学习率决定每一步走多远"));

    expect(targetScroll).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(host.querySelector('[aria-label="资料目录"]')).toBeNull();
  });

  it("uses the saved chunk text to locate a named DOCX section", async () => {
    const docx: Source = {
      ...source,
      id: "docx-source",
      versionId: "docx-version",
      kind: "docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: "练习.docx",
      // The metadata title deliberately repeats a source paragraph. Outline
      // navigation must still restrict its lookup to reader prose.
      title: "练习段落。",
      text: "概念段落。\n\n练习段落。",
      chunks: [
        {
          id: "concept",
          sourceId: "docx-source",
          versionId: "docx-version",
          text: "概念段落。",
          section: "概念",
          order: 0,
        },
        {
          id: "practice",
          sourceId: "docx-source",
          versionId: "docx-version",
          text: "练习段落。",
          section: "练习",
          order: 1,
        },
      ],
    };
    await render({ source: docx, sources: [docx] });
    await click(outlineTrigger());
    const target = [...host.querySelectorAll<HTMLElement>(".reader-plain-paragraph")].find(
      (paragraph) => paragraph.textContent === "练习段落。",
    );
    expect(target).toBeTruthy();
    const targetScroll = vi.fn();
    Object.defineProperty(target!, "scrollIntoView", {
      configurable: true,
      value: targetScroll,
    });

    await click(outlineItem("练习"));

    expect(targetScroll).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
  });

  it("renders a DOCX heading and table safely and uses the heading as a directory anchor", async () => {
    const docx: Source = {
      ...source,
      id: "structured-docx",
      versionId: "structured-version",
      kind: "docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: "结构化资料.docx",
      text: "第一章\n\n说明正文。\n\n名称\n\n值\n\n速度\n\n42",
      chunks: [
        {
          id: "plain-import",
          sourceId: "structured-docx",
          versionId: "structured-version",
          text: "第一章",
          section: "正文",
          order: 0,
        },
      ],
    };
    docxMocks.convert.mockResolvedValueOnce({
      messages: [],
      blocks: [
        { type: "heading", id: "docx-heading-0", level: 1, text: "第一章" },
        { type: "paragraph", text: "说明正文。" },
        {
          type: "table",
          rows: [
            [
              { text: "名称", header: true },
              { text: "值", header: true },
            ],
            [
              { text: "速度", header: false },
              { text: "42", header: false },
            ],
          ],
        },
      ],
    });
    const original = {
      arrayBuffer: vi.fn(async () => new ArrayBuffer(8)),
    } as unknown as Blob;

    await render({
      source: docx,
      sources: [docx],
      getSourceBlob: vi.fn(async () => original),
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const heading = host.querySelector<HTMLElement>('[data-docx-heading-id="docx-heading-0"]');
    expect(heading?.tagName).toBe("H1");
    expect(heading?.textContent).toBe("第一章");
    expect([...host.querySelectorAll("th, td")].map((cell) => cell.textContent)).toEqual([
      "名称",
      "值",
      "速度",
      "42",
    ]);

    await click(outlineTrigger());
    const targetScroll = vi.fn();
    Object.defineProperty(heading!, "scrollIntoView", {
      configurable: true,
      value: targetScroll,
    });
    await click(outlineItem("第一章"));

    expect(targetScroll).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(host.querySelector('[aria-label="资料目录"]')).toBeNull();
  });

  it("keeps PDF page controls and hides directories without real document structure", async () => {
    const pdf: Source = {
      ...source,
      id: "pdf-source",
      versionId: "pdf-version",
      kind: "pdf",
      mime: "application/pdf",
      filename: "资料.pdf",
      pageCount: 3,
      chunks: [
        {
          id: "page-one",
          sourceId: "pdf-source",
          versionId: "pdf-version",
          text: "第一页文字。",
          section: "第 1 页",
          page: 1,
          order: 0,
        },
      ],
    };
    await render({ source: pdf, sources: [pdf] });

    expect(host.querySelector('input[aria-label="跳转页码"]')).toBeTruthy();
    expect(host.querySelector('[aria-label^="打开资料目录"]')).toBeNull();

    const plainDocx: Source = {
      ...pdf,
      id: "plain-source",
      versionId: "plain-version",
      kind: "docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: "连续正文.docx",
      text: "只有连续正文。",
      chunks: [
        {
          id: "body",
          sourceId: "plain-source",
          versionId: "plain-version",
          text: "只有连续正文。",
          section: "正文",
          order: 0,
        },
      ],
    };
    await render({ source: plainDocx, sources: [plainDocx] });
    expect(host.querySelector('[aria-label^="打开资料目录"]')).toBeNull();

    const ambiguousDocx: Source = {
      ...plainDocx,
      id: "ambiguous-source",
      versionId: "ambiguous-version",
      filename: "重复段落.docx",
      text: "重复段落。\n\n中间内容。\n\n重复段落。",
      chunks: [
        {
          id: "ambiguous",
          sourceId: "ambiguous-source",
          versionId: "ambiguous-version",
          text: "重复段落。",
          section: "重复章节",
          order: 0,
        },
      ],
    };
    await render({ source: ambiguousDocx, sources: [ambiguousDocx] });
    expect(host.querySelector('[aria-label^="打开资料目录"]')).toBeNull();
  });
});
