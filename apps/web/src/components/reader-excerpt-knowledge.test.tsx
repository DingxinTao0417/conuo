// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Reader, { type ReaderProps } from "./reader";
import { createDemoWorkspace } from "@/lib/seed";
import type { Note, Source } from "@/lib/types";

vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./pdf-reader", () => ({ default: () => null }));
vi.mock("./web-version-panel", () => ({ default: () => null }));

describe("reader excerpt to knowledge page", () => {
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
      notes: [],
      space: workspace.spaces[0],
      conversations: [],
      annotations: [],
      aiEnabled: false,
      onSourceChange: vi.fn(),
      onConversationChange: vi.fn(),
      onAnnotationAdd: vi.fn(),
      onSaveNote: vi.fn(),
      onSaveExcerptToKnowledgePage: vi.fn(() => "学习率摘录"),
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

  function buttonByText(text: string) {
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.replace(/\s+/g, "") === text.replace(/\s+/g, ""),
    );
    expect(button, `button ${text}`).toBeTruthy();
    return button!;
  }

  function uniqueAnchorChunkId(quote: string) {
    const compact = quote.replace(/\s/gu, "");
    const matches = source.chunks.filter((chunk) =>
      chunk.text.replace(/\s/gu, "").includes(compact),
    );
    expect(matches).toHaveLength(1);
    return matches[0]!.id;
  }

  async function click(button: HTMLButtonElement) {
    await act(async () => {
      button.click();
    });
  }

  it("saves a selected original excerpt as a manual knowledge-page draft even when AI is off", async () => {
    const quote = await selectParagraphContaining("学习率是更新参数时的步长系数");
    const saveButton = buttonByText("存知识页");
    expect(saveButton.disabled).toBe(false);

    await click(saveButton);
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.getAttribute("aria-labelledby")).toBe("reader-excerpt-dialog-title");
    expect(dialog?.textContent).toContain("不会调用 AI");
    expect(dialog?.textContent).toContain(quote);

    await click(buttonByText("新建知识页草稿"));
    expect(props.onSaveExcerptToKnowledgePage).toHaveBeenCalledWith({
      spaceId: props.space.id,
      sourceId: source.id,
      versionId: source.versionId,
      quote,
      anchorChunkId: uniqueAnchorChunkId(quote),
    });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).toContain("已新建“学习率摘录”");
  });

  it("keeps the phone selection toolbar inside the viewport when a selection starts at the edge", async () => {
    const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    try {
      await selectParagraphContaining("学习率是更新参数时的步长系数", {
        left: 0,
        top: 220,
        width: 18,
        bottom: 244,
      });
      const toolbar = host.querySelector<HTMLElement>('[role="toolbar"][aria-label^="已选中"]');
      expect(toolbar?.style.left).toBe("156px");
      expect(toolbar?.textContent).toContain("存知识页");
    } finally {
      if (width) Object.defineProperty(window, "innerWidth", width);
      else Reflect.deleteProperty(window, "innerWidth");
    }
  });

  it("lets the learner append the snapshot to a current-space page and leaves cancel side-effect free", async () => {
    const now = new Date().toISOString();
    const page: Note = {
      id: "knowledge-page",
      spaceId: props.space.id,
      title: "梯度下降要点",
      content: "<p>已有正文。</p>",
      kind: "knowledge",
      status: "accepted",
      citations: [],
      versions: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await render({ notes: [page] });
    const quote = await selectParagraphContaining("学习率太小，损失下降缓慢");
    await click(buttonByText("存知识页"));

    const select = host.querySelector<HTMLSelectElement>(
      'select[aria-label="选择要追加原文摘录的知识页"]',
    );
    expect(select).toBeTruthy();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
        select,
        page.id,
      );
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(buttonByText("追加到知识页"));
    expect(props.onSaveExcerptToKnowledgePage).toHaveBeenLastCalledWith({
      noteId: page.id,
      spaceId: props.space.id,
      sourceId: source.id,
      versionId: source.versionId,
      quote,
      anchorChunkId: uniqueAnchorChunkId(quote),
    });

    await selectParagraphContaining("观察连续多次更新的训练损失");
    await click(buttonByText("存知识页"));
    await click(buttonByText("取消"));
    expect(props.onSaveExcerptToKnowledgePage).toHaveBeenCalledTimes(1);
  });

  it("does not offer page mutation while viewing a historical source version", async () => {
    const historical = { ...source, versionId: "historical-version" };
    await render({ source: historical, currentSource: source, sources: [source] });
    await selectParagraphContaining("学习率是更新参数时的步长系数");
    const saveButton = buttonByText("存知识页");
    expect(saveButton.disabled).toBe(true);
    expect(saveButton.title).toContain("历史版本");
  });
});
