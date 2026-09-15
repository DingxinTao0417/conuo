// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Reader, { type ReaderProps } from "./reader";
import { createDemoWorkspace } from "@/lib/seed";
import type { Annotation, Source } from "@/lib/types";

vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./pdf-reader", () => ({ default: () => null }));
vi.mock("./web-version-panel", () => ({ default: () => null }));

describe("reader annotations", () => {
  let host: HTMLDivElement;
  let root: Root;
  let source: Source;
  let props: ReaderProps;
  let scrollDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(0), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
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
      onAnnotationAdd: vi.fn((annotation: Annotation) => {
        props = { ...props, annotations: [...props.annotations, annotation] };
        root.render(createElement(Reader, props));
      }),
      onAnnotationUpdate: vi.fn((annotation: Annotation) => {
        props = {
          ...props,
          annotations: props.annotations.map((item) =>
            item.id === annotation.id ? annotation : item,
          ),
        };
        root.render(createElement(Reader, props));
      }),
      onAnnotationDelete: vi.fn((annotation: Annotation) => {
        props = {
          ...props,
          annotations: props.annotations.filter((item) => item.id !== annotation.id),
        };
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
    await act(async () => {
      root.unmount();
    });
    window.getSelection()?.removeAllRanges();
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

  async function selectParagraphContaining(
    text: string,
    position?: { left: number; top: number; width: number; bottom: number },
  ) {
    const paragraph = [...host.querySelectorAll("[data-reader-text] p")].find((item) =>
      item.textContent?.includes(text),
    );
    expect(paragraph, `paragraph containing ${text}`).toBeTruthy();
    await act(async () => {
      const range = document.createRange();
      range.selectNodeContents(paragraph!);
      if (position) {
        Object.defineProperty(range, "getClientRects", {
          configurable: true,
          value: () => ({ 0: position, length: 1 }),
        });
      }
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    return paragraph!.textContent!.trim();
  }

  it("anchors the selection toolbar near the chosen text and clears the floating control on scroll", async () => {
    await selectParagraphContaining("学习率是更新参数时的步长系数", {
      left: 120,
      top: 220,
      width: 180,
      bottom: 244,
    });
    const toolbar = host.querySelector<HTMLElement>('[role="toolbar"][aria-label^="已选中"]');
    expect(toolbar).toBeTruthy();
    expect(toolbar?.className).toContain("reader-selection-actions-above");
    expect(toolbar?.style.left).toBe("210px");
    expect(toolbar?.style.top).toBe("212px");
    expect(toolbar?.textContent).toContain("问 AI");
    expect(toolbar?.textContent).toContain("存笔记");
    expect(toolbar?.querySelector('button[aria-label="复制选段"]')).toBeTruthy();
    expect(toolbar?.textContent).not.toContain("已选中");

    await act(async () => {
      host
        .querySelector<HTMLElement>(".reader-document-scroll")!
        .dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(host.querySelector('[role="toolbar"][aria-label^="已选中"]')).toBeNull();
  });

  function buttonByText(text: string) {
    const button = [...host.querySelectorAll("button")].find(
      (item) => item.textContent?.replace(/\s+/g, "") === text.replace(/\s+/g, ""),
    );
    expect(button, `button ${text}`).toBeTruthy();
    return button!;
  }

  async function click(button: HTMLButtonElement) {
    await act(async () => {
      button.click();
    });
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

  it("creates a version-bound annotation with a note, then edits and deletes it through owner callbacks", async () => {
    const quote = await selectParagraphContaining("学习率是更新参数时的步长系数");
    await click(buttonByText("高亮"));
    const createForm = host.querySelector<HTMLFormElement>('form[aria-label="新增批注"]')!;
    expect(createForm.textContent).toContain(quote);
    await type(
      host.querySelector<HTMLTextAreaElement>('textarea[aria-label="批注内容"]')!,
      "先理解更新规则。",
    );
    await act(async () => {
      createForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(props.onAnnotationAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: source.id,
        versionId: source.versionId,
        quote,
        note: "先理解更新规则。",
      }),
    );
    expect(host.textContent).toContain("先理解更新规则。");

    await click(host.querySelector<HTMLButtonElement>('button[aria-label="编辑批注"]')!);
    await type(
      host.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑批注内容"]')!,
      "补充：需要自己推导一次。",
    );
    await act(async () => {
      host
        .querySelector<HTMLFormElement>('form[aria-label="编辑批注"]')!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(props.onAnnotationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: source.id,
        versionId: source.versionId,
        quote,
        note: "补充：需要自己推导一次。",
      }),
    );

    await click(host.querySelector<HTMLButtonElement>('button[aria-label="删除批注"]')!);
    expect(props.onAnnotationDelete).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: source.id, versionId: source.versionId, quote }),
    );
    expect(host.textContent).not.toContain("补充：需要自己推导一次。");
  });

  it("keeps every annotation action read-only when the displayed version is historical", async () => {
    const historical = { ...source, versionId: "historical-version" };
    const annotation: Annotation = {
      id: "annotation-historical",
      sourceId: historical.id,
      versionId: historical.versionId,
      quote: "学习率是更新参数时的步长系数。参数更新可以写为：新参数 = 旧参数 − 学习率 × 梯度。",
      note: "历史说明",
      createdAt: "2026-09-12T00:00:00.000Z",
    };
    await render({
      source: historical,
      currentSource: source,
      sources: [source],
      annotations: [annotation],
    });
    await click(
      [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
        item.getAttribute("aria-label")?.startsWith("我的标注"),
      )!,
    );
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="编辑批注"]')!.disabled).toBe(
      true,
    );
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="删除批注"]')!.disabled).toBe(
      true,
    );
    await selectParagraphContaining("学习率是更新参数时的步长系数");
    expect(buttonByText("高亮").disabled).toBe(true);
    expect(props.onAnnotationAdd).not.toHaveBeenCalled();
    expect(props.onAnnotationUpdate).not.toHaveBeenCalled();
    expect(props.onAnnotationDelete).not.toHaveBeenCalled();
  });
});
