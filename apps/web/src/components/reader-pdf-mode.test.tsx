// @vitest-environment jsdom

import { act, createElement, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import type { Annotation, Source } from "@/lib/types";
import Reader, { type ReaderProps } from "./reader";

interface PdfModeProps {
  source: Source;
  page: number;
  readingMode: "single" | "continuous";
  navigationRequest: number;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onVisiblePageChange: (page: number) => void;
  onRendered: () => void;
  capture: { active: boolean };
}

const bridge = vi.hoisted(() => ({ pdfProps: null as PdfModeProps | null }));

vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./web-version-panel", () => ({ default: () => null }));
vi.mock("./pdf-reader", () => ({
  default: (props: PdfModeProps) => {
    bridge.pdfProps = props;
    const pages = props.readingMode === "continuous" ? [1, 2, 3, 4, 5, 6] : [props.page];
    return createElement(
      "div",
      { "data-pdf-mode-mock": true },
      ...pages.map((page) =>
        createElement(
          "section",
          { key: page, "data-pdf-mock-page": page },
          createElement(
            "div",
            {
              className: "reader-pdf-text textLayer",
              "data-reader-text": true,
              "data-reader-page": page,
              "data-reader-source-id": props.source.id,
              "data-reader-source-version": props.source.versionId,
            },
            createElement(
              "span",
              null,
              props.source.chunks
                .filter((chunk) => chunk.page === page)
                .map((chunk) => chunk.text)
                .join(""),
            ),
          ),
          createElement(
            "button",
            { onClick: () => props.onVisiblePageChange(page) },
            `模拟第 ${page} 页可见`,
          ),
        ),
      ),
    );
  },
}));

describe("Reader PDF reading mode integration", () => {
  let host: HTMLDivElement;
  let root: Root;
  let source: Source;
  let props: ReaderProps;
  let scrollDescriptor: PropertyDescriptor | undefined;
  let showModalDescriptor: PropertyDescriptor | undefined;
  let closeDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));
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
    showModalDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
    closeDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
      }),
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute("open");
      }),
    });
    bridge.pdfProps = null;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const workspace = createDemoWorkspace();
    const pageText = [
      "重复摘录。",
      "第二页正文。",
      "第三页正文。",
      "第四页正文。",
      "重复摘录。",
      "最后一页正文。",
    ];
    source = {
      ...workspace.sources[0]!,
      id: "mode-pdf-source",
      versionId: "mode-pdf-version",
      kind: "pdf",
      mime: "application/pdf",
      title: "六页学习资料",
      text: pageText.join("\n\n"),
      chunks: pageText.map((text, index) => ({
        id: `chunk-${index + 1}`,
        sourceId: "mode-pdf-source",
        versionId: "mode-pdf-version",
        text,
        section: `第 ${index + 1} 页`,
        order: index,
        page: index + 1,
      })),
      pageCount: 6,
      readPage: 3,
      aiAllowed: true,
      originalMissing: false,
      lastReadAt: undefined,
    };
    props = {
      source,
      sources: [source],
      notes: [],
      space: workspace.spaces[0]!,
      conversations: [],
      annotations: [],
      aiEnabled: true,
      cloudUserId: "reader-account",
      saveState: "cloud",
      readingPositionRevision: 0,
      onSourceChange: vi.fn(),
      onPendingReadingChange: vi.fn(),
      onConversationChange: vi.fn(),
      onAnnotationAdd: vi.fn(),
      onSaveNote: vi.fn(),
      onSaveExcerptToKnowledgePage: vi.fn(() => "第 5 页摘录"),
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
    if (showModalDescriptor)
      Object.defineProperty(HTMLDialogElement.prototype, "showModal", showModalDescriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    if (closeDescriptor)
      Object.defineProperty(HTMLDialogElement.prototype, "close", closeDescriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function render(overrides: Partial<ReaderProps> = {}) {
    props = { ...props, ...overrides };
    await act(async () => root.render(createElement(Reader, props)));
  }

  function button(text: string) {
    const candidate = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.replace(/\s/gu, "") === text.replace(/\s/gu, ""),
    );
    expect(candidate, `button ${text}`).toBeTruthy();
    return candidate!;
  }

  function modeButton(mode: "single" | "continuous") {
    const group = host.querySelector('[role="group"][aria-label="PDF 阅读模式"]');
    expect(group).toBeTruthy();
    const result = [...group!.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes(mode === "single" ? "单页" : "连续"),
    );
    expect(result).toBeTruthy();
    return result!;
  }

  async function click(target: HTMLButtonElement) {
    await act(async () => target.click());
  }

  async function visible(page: number) {
    await act(async () => bridge.pdfProps!.onVisiblePageChange(page));
  }

  async function advance(milliseconds: number) {
    await act(async () => vi.advanceTimersByTime(milliseconds));
  }

  async function jump(page: number) {
    const input = host.querySelector<HTMLInputElement>('[aria-label="跳转页码"]')!;
    expect(input).toBeTruthy();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        String(page),
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });
  }

  function scrolledPhysicalPages() {
    return (vi.mocked(Element.prototype.scrollIntoView).mock.contexts as Element[])
      .map((element) => element.closest("[data-pdf-mock-page]")?.getAttribute("data-pdf-mock-page"))
      .filter((page): page is string => !!page)
      .map(Number);
  }

  async function pdfRendered() {
    await act(async () => bridge.pdfProps!.onRendered());
  }

  async function focusPdfTarget(kind: "citation" | "annotation") {
    if (kind === "citation") {
      await render({
        initialCitation: {
          sourceId: source.id,
          versionId: source.versionId,
          chunkId: "chunk-4",
          title: source.title,
          quote: "第四页正文。",
          section: "第 4 页",
          page: 4,
        },
      });
      // The real workspace consumes a navigation citation after opening it;
      // retain the reader's focus without replaying that route request.
      await render({ initialCitation: undefined });
      expect(host.querySelector(".reader-citation-target")).toBeTruthy();
    } else {
      const start = source.text.indexOf("第四页正文。");
      const annotation: Annotation = {
        id: "focused-page-4-annotation",
        sourceId: source.id,
        versionId: source.versionId,
        quote: "第四页正文。",
        note: "检查定位不会覆盖新的阅读位置。",
        page: 4,
        textAnchor: { start, end: start + "第四页正文。".length },
        createdAt: "2026-09-15T11:00:00.000Z",
      };
      await render({ annotations: [annotation] });
      await click(host.querySelector<HTMLButtonElement>("[data-reader-annotation-trigger]")!);
      await click(host.querySelector<HTMLButtonElement>(".reader-annotation-locate")!);
    }
    await pdfRendered();
    expect(bridge.pdfProps!.page).toBe(4);
    expect(scrolledPhysicalPages()).toContain(4);
    vi.mocked(Element.prototype.scrollIntoView).mockClear();
  }

  it("starts in single-page mode and keeps the current page while toggling without recording activity", async () => {
    expect(modeButton("single").getAttribute("aria-pressed")).toBe("true");
    expect(modeButton("continuous").getAttribute("aria-pressed")).toBe("false");
    expect(bridge.pdfProps!.readingMode).toBe("single");
    expect(bridge.pdfProps!.page).toBe(3);
    expect(bridge.pdfProps!.scrollContainerRef.current).toBe(
      host.querySelector(".reader-document-scroll"),
    );
    await click(modeButton("continuous"));
    expect(bridge.pdfProps!.readingMode).toBe("continuous");
    expect(bridge.pdfProps!.page).toBe(3);
    expect(modeButton("continuous").getAttribute("aria-pressed")).toBe("true");
    await click(modeButton("single"));
    expect(bridge.pdfProps!.page).toBe(3);
    expect(props.onSourceChange).not.toHaveBeenCalled();
  });

  it("keeps continuous mode through cloud acknowledgements and source metadata changes", async () => {
    await click(modeButton("continuous"));
    const updated = { ...source, title: "更新标题", updatedAt: "2026-09-15T12:00:01.000Z" };
    await render({
      source: updated,
      sources: [updated],
      saveState: "saving",
      saveLabel: "正在保存到云端",
    });
    await render({ saveState: "cloud", saveLabel: "已保存到云端" });
    expect(bridge.pdfProps!.readingMode).toBe("continuous");
    expect(bridge.pdfProps!.page).toBe(3);
    expect(props.onSourceChange).not.toHaveBeenCalled();
  });

  it("debounces visible pages and publishes only the settled latest page without navigation loops", async () => {
    await click(modeButton("continuous"));
    const request = bridge.pdfProps!.navigationRequest;
    await visible(4);
    expect(bridge.pdfProps!.page).toBe(4);
    expect(props.onPendingReadingChange).toHaveBeenLastCalledWith(true);
    expect(props.onSourceChange).not.toHaveBeenCalled();
    await advance(250);
    await visible(5);
    await advance(399);
    expect(props.onSourceChange).not.toHaveBeenCalled();
    await advance(1);
    expect(props.onSourceChange).toHaveBeenCalledExactlyOnceWith({
      readPage: 5,
      lastReadAt: "2026-09-15T12:00:00.650Z",
    });
    expect(bridge.pdfProps!.navigationRequest).toBe(request);
    expect(props.onPendingReadingChange).toHaveBeenLastCalledWith(false);
  });

  it("rate-limits settled continuous reading while preserving pending intent until its flush", async () => {
    await click(modeButton("continuous"));
    await visible(4);
    await advance(400);
    const saved = { ...source, readPage: 4, lastReadAt: "2026-09-15T12:00:00.400Z" };
    await render({ source: saved, sources: [saved] });
    await advance(4_600);
    await visible(5);
    await advance(400);
    expect(props.onSourceChange).toHaveBeenCalledOnce();
    expect(props.onPendingReadingChange).toHaveBeenLastCalledWith(true);
    await advance(9_999);
    expect(props.onSourceChange).toHaveBeenCalledOnce();
    await advance(1);
    expect(props.onSourceChange).toHaveBeenLastCalledWith({
      readPage: 5,
      lastReadAt: "2026-09-15T12:00:15.400Z",
    });
    expect(props.onPendingReadingChange).toHaveBeenLastCalledWith(false);
  });

  it("clears unsettled page intent when returning to the already saved page", async () => {
    await click(modeButton("continuous"));
    await visible(4);
    expect(props.onPendingReadingChange).toHaveBeenLastCalledWith(true);
    await visible(3);
    expect(props.onPendingReadingChange).toHaveBeenLastCalledWith(false);
    await advance(20_000);
    // The existing visible-document timer may report lastReadAt, but the
    // canceled page must never become a workspace reading-position patch.
    expect(
      vi.mocked(props.onSourceChange).mock.calls.every(([patch]) => patch.readPage === undefined),
    ).toBe(true);
  });

  it("flushes the final unsettled PDF page when leaving the reader", async () => {
    await click(modeButton("continuous"));
    await visible(5);
    expect(props.onSourceChange).not.toHaveBeenCalled();
    await advance(100);
    await act(async () => root.render(null));
    expect(props.onSourceChange).toHaveBeenCalledExactlyOnceWith({
      readPage: 5,
      lastReadAt: "2026-09-15T12:00:00.100Z",
    });
    expect(props.onPendingReadingChange).toHaveBeenLastCalledWith(false);
    await advance(20_000);
    expect(props.onSourceChange).toHaveBeenCalledOnce();
  });

  it("ignores visible-page notifications in single-page mode", async () => {
    await visible(5);
    await advance(400);
    expect(bridge.pdfProps!.page).toBe(3);
    expect(props.onSourceChange).not.toHaveBeenCalled();
    expect(props.onPendingReadingChange).not.toHaveBeenCalledWith(true);
  });

  it("does not persist PDF mode in browser business storage", async () => {
    const writeStorage = vi.spyOn(Storage.prototype, "setItem");
    const readStorage = vi.spyOn(Storage.prototype, "getItem");
    const openDatabase = vi.fn(() => {
      throw new Error("unexpected business storage access");
    });
    vi.stubGlobal("indexedDB", { open: openDatabase });
    try {
      await click(modeButton("continuous"));
      await click(modeButton("single"));
      expect(writeStorage).not.toHaveBeenCalled();
      expect(readStorage).not.toHaveBeenCalled();
      expect(openDatabase).not.toHaveBeenCalled();
    } finally {
      writeStorage.mockRestore();
      readStorage.mockRestore();
    }
  });

  it("explicit page navigation triggers a new request even when jumping to the same visible page", async () => {
    await click(modeButton("continuous"));
    const initial = bridge.pdfProps!.navigationRequest;
    await jump(4);
    expect(bridge.pdfProps!.page).toBe(4);
    expect(bridge.pdfProps!.navigationRequest).toBeGreaterThan(initial);
    const jumped = bridge.pdfProps!.navigationRequest;
    // A citation may ask to re-center the page already considered visible.
    await render({
      initialCitation: {
        sourceId: source.id,
        versionId: source.versionId,
        chunkId: "chunk-4",
        title: source.title,
        quote: "第四页正文。",
        section: "第 4 页",
        page: 4,
      },
    });
    expect(bridge.pdfProps!.page).toBe(4);
    expect(bridge.pdfProps!.navigationRequest).toBeGreaterThan(jumped);
    expect(bridge.pdfProps!.readingMode).toBe("continuous");
  });

  it("applies resolved reading position revisions without resetting the selected mode", async () => {
    await click(modeButton("continuous"));
    await visible(4);
    const initial = bridge.pdfProps!.navigationRequest;
    const resolved = { ...source, readPage: 6 };
    await render({ source: resolved, sources: [resolved], readingPositionRevision: 1 });
    await advance(0);
    expect(bridge.pdfProps!.page).toBe(6);
    expect(bridge.pdfProps!.readingMode).toBe("continuous");
    expect(bridge.pdfProps!.navigationRequest).toBeGreaterThan(initial);
    expect(props.onPendingReadingChange).toHaveBeenLastCalledWith(false);
    await advance(20_000);
    expect(
      vi.mocked(props.onSourceChange).mock.calls.every(([patch]) => patch.readPage === undefined),
    ).toBe(true);
  });

  it("allows viewing historical PDFs without changing the current version reading activity", async () => {
    await render({ currentSource: { ...source, versionId: "current-version" } });
    await click(modeButton("continuous"));
    await visible(5);
    await advance(400);
    await jump(6);
    expect(bridge.pdfProps!.page).toBe(6);
    expect(props.onSourceChange).not.toHaveBeenCalled();
    expect(props.onPendingReadingChange).not.toHaveBeenCalledWith(true);
  });

  it("releases pending continuous progress if the viewed version becomes historical", async () => {
    await click(modeButton("continuous"));
    await visible(4);
    expect(props.onPendingReadingChange).toHaveBeenLastCalledWith(true);
    await render({ currentSource: { ...source, versionId: "new-version" } });
    expect(props.onPendingReadingChange).toHaveBeenLastCalledWith(false);
    await advance(20_000);
    expect(props.onSourceChange).not.toHaveBeenCalled();
  });

  it("does not show PDF mode controls for text documents", async () => {
    const markdown = { ...source, kind: "markdown" as const, mime: "text/markdown" };
    await render({ source: markdown, sources: [markdown] });
    expect(host.querySelector('[role="group"][aria-label="PDF 阅读模式"]')).toBeNull();
  });

  it("cancels an unconfirmed screenshot selection when the display mode changes", async () => {
    const trigger = host.querySelector<HTMLButtonElement>("[data-reader-region-trigger]")!;
    await click(trigger);
    expect(bridge.pdfProps!.capture.active).toBe(true);
    await click(modeButton("continuous"));
    expect(bridge.pdfProps!.capture.active).toBe(false);
    expect(props.onSourceChange).not.toHaveBeenCalled();
  });

  it("binds excerpts to their physical PDF page when another page is currently visible", async () => {
    await click(modeButton("continuous"));
    expect(bridge.pdfProps!.page).toBe(3);
    const node = host.querySelector('[data-pdf-mock-page="5"] .textLayer span')!;
    await act(async () => {
      const range = document.createRange();
      range.selectNodeContents(node);
      Object.defineProperty(range, "getClientRects", {
        configurable: true,
        value: () => [{ left: 120, top: 200, width: 180, bottom: 224 }],
      });
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await click(button("存知识页"));
    await click(button("新建知识页草稿"));
    expect(props.onSaveExcerptToKnowledgePage).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: source.id,
        versionId: source.versionId,
        quote: "重复摘录。",
        anchorPage: 5,
        anchorChunkId: "chunk-5",
      }),
    );
    expect(bridge.pdfProps!.page).toBe(3);
  });

  it.each(["next", "jump"] as const)(
    "does not re-center an old citation after manual %s navigation",
    async (navigation) => {
      await click(modeButton("continuous"));
      await focusPdfTarget("citation");
      if (navigation === "next")
        await click(host.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!);
      else await jump(6);
      expect(bridge.pdfProps!.page).toBe(navigation === "next" ? 5 : 6);
      await pdfRendered();
      await pdfRendered();
      expect(scrolledPhysicalPages()).not.toContain(4);
      expect(host.querySelector(".reader-citation-target")).toBeNull();
    },
  );

  it.each([
    ["citation", "revision"],
    ["annotation", "revision"],
    ["citation", "retained"],
    ["annotation", "retained"],
  ] as const)("clears %s focus when applying a %s reading position", async (kind, position) => {
    const retained = {
      ...source,
      readingPositionAlternatives: [
        { origin: "previous" as const, readPage: 6, lastReadAt: "2026-09-15T10:00:00.000Z" },
      ],
    };
    await render({ source: retained, sources: [retained] });
    await click(modeButton("continuous"));
    await focusPdfTarget(kind);
    if (position === "revision") {
      const resolved = { ...retained, readPage: 6 };
      await render({ source: resolved, sources: [resolved], readingPositionRevision: 1 });
      await advance(0);
    } else {
      await click(host.querySelector<HTMLButtonElement>('[aria-label="更多资料操作"]')!);
      await click(host.querySelector<HTMLButtonElement>('[aria-label="已保留阅读位置"]')!);
      await click(host.querySelector<HTMLButtonElement>('[aria-label="切换到先前选择：第 6 页"]')!);
      await advance(0);
    }
    expect(bridge.pdfProps!.page).toBe(6);
    await pdfRendered();
    await pdfRendered();
    expect(scrolledPhysicalPages()).not.toContain(4);
    expect(bridge.pdfProps!.page).toBe(6);
  });

  it("refuses to create a note citation from a different page when the selected physical page has no matching parser chunk", async () => {
    await click(modeButton("continuous"));
    const node = host.querySelector('[data-pdf-mock-page="5"] .textLayer span')!;
    // External PDF text can differ from retained parser output. The same
    // words exist on page 3, but must not become a fabricated page 5 anchor.
    node.textContent = "第三页正文。";
    await act(async () => {
      const range = document.createRange();
      range.selectNodeContents(node);
      Object.defineProperty(range, "getClientRects", {
        configurable: true,
        value: () => [{ left: 120, top: 200, width: 180, bottom: 224 }],
      });
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await click(button("存笔记"));
    expect(props.onSaveNote).not.toHaveBeenCalled();
    expect(host.textContent).toContain("请先从已解析的原文中选择一段文字。");
  });
});
