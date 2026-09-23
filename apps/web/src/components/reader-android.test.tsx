// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Reader, { type ReaderProps } from "./reader";
import { createDemoWorkspace } from "@/lib/seed";
import type { Citation, Source } from "@/lib/types";

vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./pdf-reader", () => ({ default: () => null }));
vi.mock("./web-version-panel", () => ({ default: () => null }));

describe("Android phone reader variant", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: ReaderProps;
  let source: Source;
  let citation: Citation;
  let scrollDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(max-width: 620px)" || query === "(max-width: 1024px)",
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
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
    const quote = "学习率过大时，参数会在低点附近反复跨越。";
    source = {
      ...workspace.sources[0],
      id: "android-source",
      versionId: "android-version",
      kind: "markdown",
      aiAllowed: true,
      text: `${quote}\n\n这是一份用于验证 Android 阅读器的资料。`,
      spaceIds: [workspace.spaces[0].id],
      chunks: [
        {
          id: "android-chunk",
          sourceId: "android-source",
          versionId: "android-version",
          text: quote,
          section: "学习率",
          order: 0,
        },
      ],
    };
    citation = {
      sourceId: source.id,
      versionId: source.versionId,
      chunkId: "android-chunk",
      title: source.title,
      quote,
      section: "学习率",
    };
    props = {
      source,
      sources: [source],
      notes: [],
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

  function workspace() {
    const element = host.querySelector<HTMLElement>(".reader-workspace");
    expect(element).toBeTruthy();
    return element!;
  }

  async function click(element: HTMLElement) {
    await act(async () => {
      element.click();
    });
  }

  it("keeps the default phone flow unless Android is explicitly selected", () => {
    expect(workspace().dataset.mobileVariant).toBe("default");
    expect(host.querySelector('[aria-label="Android 阅读模式切换"]')).toBeNull();
    expect(host.querySelector(".reader-android-ask-fab")).toBeNull();
  });

  it("uses text tabs, a three-dot menu, a FAB, and an expandable AI sheet in Android mode", async () => {
    await render({ mobilePlatform: "android" });

    expect(workspace().dataset.mobileVariant).toBe("android");
    expect(workspace().className).toContain("reader-mobile-android");
    const tabs = host.querySelector<HTMLElement>('[aria-label="Android 阅读模式切换"]');
    expect(tabs).toBeTruthy();
    expect(tabs?.getAttribute("role")).toBe("group");
    const original = tabs!.querySelector<HTMLButtonElement>("button:first-child");
    const ai = tabs!.querySelector<HTMLButtonElement>("button:last-child");
    expect(original?.textContent).toBe("原文");
    expect(original?.getAttribute("aria-pressed")).toBe("true");
    expect(ai?.textContent).toBe("AI");

    const menuToggle = host.querySelector<HTMLButtonElement>('[aria-label="更多资料操作"]');
    expect(menuToggle).toBeTruthy();
    await click(menuToggle!);
    expect(host.querySelector('[aria-label="资料操作"]')?.textContent).toContain("资料版本记录");

    await click(ai!);
    expect(workspace().className).toContain("reader-mobile-ai");
    expect(ai?.getAttribute("aria-pressed")).toBe("true");

    await click(original!);
    expect(workspace().className).toContain("reader-mobile-reading");
    const peek = host.querySelector<HTMLButtonElement>('[aria-label="展开问 AI 工作表"]');
    expect(peek?.textContent).toContain("问 AI");
    await click(peek!);
    expect(workspace().className).toContain("reader-mobile-ai");

    const close = host.querySelector<HTMLButtonElement>('[aria-label="收起问答面板"]');
    expect(close).toBeTruthy();
    await click(close!);
    const fab = host.querySelector<HTMLButtonElement>(".reader-android-ask-fab");
    expect(fab?.getAttribute("aria-label")).toBe("问 AI");
    await click(fab!);
    expect(workspace().className).toContain("reader-mobile-ai");
  });

  it("returns from an Android citation page to the open AI sheet", async () => {
    await render({ mobilePlatform: "android", initialCitation: citation });

    expect(workspace().className).toContain("reader-mobile-citation");
    expect(host.querySelector('[aria-label="Android 阅读模式切换"]')).toBeNull();
    const returnToAnswer = host.querySelector<HTMLButtonElement>('[aria-label="返回回答"]');
    expect(returnToAnswer).toBeTruthy();
    await click(returnToAnswer!);
    expect(workspace().className).toContain("reader-mobile-ai");
    expect(workspace().className).toContain("reader-mobile-android");
  });
});
