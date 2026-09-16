// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Reader, {
  defaultAiPanelWidthForViewport,
  maxAiPanelWidthForWorkspace,
  type ReaderProps,
} from "./reader";
import { createDemoWorkspace } from "@/lib/seed";

vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./pdf-reader", () => ({ default: () => null }));

describe("reader document controls and source actions", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: ReaderProps;
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
    const source = {
      ...workspace.sources[0],
      id: "topbar-source",
      versionId: "topbar-version",
      kind: "markdown" as const,
      title: "一份名称很长、需要在手机端紧凑显示的学习资料",
      aiAllowed: true,
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
      onReplaceFile: vi.fn(async () => undefined),
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

  function moreToggle() {
    const toggle = host.querySelector<HTMLButtonElement>('[aria-label="更多资料操作"]');
    expect(toggle).toBeTruthy();
    return toggle!;
  }

  function actionMenu() {
    const menu = host.querySelector<HTMLElement>("#reader-source-actions-menu");
    expect(menu).toBeTruthy();
    return menu!;
  }

  function actionButton(label: string) {
    const button = [...actionMenu().querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === label,
    );
    expect(button, `${label} action`).toBeTruthy();
    return button!;
  }

  async function click(button: HTMLButtonElement) {
    await act(async () => {
      button.click();
    });
  }

  it("places the document toolbar in the reading scroll region before the paper", () => {
    const scroll = host.querySelector<HTMLElement>(".reader-document-scroll");
    const toolbar = host.querySelector<HTMLElement>("[data-reader-document-tools]");
    const paper = host.querySelector<HTMLElement>(".reader-paper");

    expect(scroll).toBeTruthy();
    expect(toolbar).toBeTruthy();
    expect(paper).toBeTruthy();
    expect(scroll?.contains(toolbar!)).toBe(true);
    expect(host.querySelector(".reader-document > [data-reader-document-tools]")).toBeNull();
    expect([...scroll!.children].indexOf(toolbar!)).toBeLessThan(
      [...scroll!.children].indexOf(paper!),
    );
    expect(toolbar?.querySelector('[aria-label="查找原文"]')).toBeTruthy();
    expect(toolbar?.querySelector('[aria-label^="我的标注"]')).toBeTruthy();
  });

  it("keeps the top bar and AI panel in separate desktop layout regions", async () => {
    const workspace = host.querySelector<HTMLElement>(".reader-workspace");
    const documentPane = host.querySelector<HTMLElement>("#reader-document-pane");
    const topbar = host.querySelector<HTMLElement>(".reader-topbar");

    expect(workspace).toBeTruthy();
    expect(documentPane).toBeTruthy();
    expect(topbar).toBeTruthy();
    expect(documentPane?.contains(topbar!)).toBe(false);
    expect(topbar?.parentElement).toBe(workspace);

    const readerBody = host.querySelector<HTMLElement>(".reader-body");
    const aiPanel = host.querySelector<HTMLElement>("#reader-ai-panel");
    expect(workspace?.classList.contains("reader-with-ai")).toBe(true);
    expect(readerBody?.contains(topbar!)).toBe(false);
    expect(aiPanel).toBeTruthy();
    expect(readerBody?.contains(aiPanel!)).toBe(true);
    expect(topbar?.parentElement).toBe(workspace);
    const desktopTools = topbar?.querySelector<HTMLElement>('[aria-label="阅读工具"]');
    expect(desktopTools).toBeTruthy();
    expect(desktopTools?.querySelector('[aria-label="查找原文"]')).toBeTruthy();
    expect(desktopTools?.querySelector('[aria-label^="我的标注"]')).toBeTruthy();
  });

  it("keeps enough room for the reader when a narrow desktop resizes the AI panel", () => {
    expect(maxAiPanelWidthForWorkspace(825)).toBe(320);
    expect(maxAiPanelWidthForWorkspace(1_056)).toBe(484);
    expect(maxAiPanelWidthForWorkspace(1_216)).toBe(520);
    expect(maxAiPanelWidthForWorkspace(null)).toBe(520);
  });

  it("uses the landscape tablet panel width only for the 1025–1199px web range", () => {
    expect(defaultAiPanelWidthForViewport(1024)).toBe(380);
    expect(defaultAiPanelWidthForViewport(1025)).toBe(360);
    expect(defaultAiPanelWidthForViewport(1194)).toBe(360);
    expect(defaultAiPanelWidthForViewport(1199)).toBe(360);
    expect(defaultAiPanelWidthForViewport(1200)).toBe(380);
    expect(defaultAiPanelWidthForViewport(null)).toBe(380);
  });

  it("keeps desktop and compact reader tool state synchronized", async () => {
    const source = {
      ...props.source,
      text: "# 优化器基础\n\n## 学习率\n\n学习率决定每一步走多远。",
    };
    await render({ source, sources: [source] });

    const desktopTools = host.querySelector<HTMLElement>(".reader-desktop-topbar-tools")!;
    const compactTools = host.querySelector<HTMLElement>("[data-reader-document-tools]")!;
    const toolPair = (selector: string) => {
      const desktop = desktopTools.querySelector<HTMLButtonElement>(selector);
      const compact = compactTools.querySelector<HTMLButtonElement>(selector);
      expect(desktop, `desktop ${selector}`).toBeTruthy();
      expect(compact, `compact ${selector}`).toBeTruthy();
      return [desktop!, compact!] as const;
    };

    const [desktopSearch, compactSearch] = toolPair("[data-reader-search-trigger]");
    await click(desktopSearch);
    expect(desktopSearch.getAttribute("aria-expanded")).toBe("true");
    expect(compactSearch.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector("#reader-find-panel")).toBeTruthy();
    await click(compactSearch);
    expect(desktopSearch.getAttribute("aria-expanded")).toBe("false");
    expect(compactSearch.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector("#reader-find-panel")).toBeNull();

    const [desktopOutline, compactOutline] = toolPair("[data-reader-outline-trigger]");
    await click(compactOutline);
    expect(desktopOutline.getAttribute("aria-expanded")).toBe("true");
    expect(compactOutline.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector("#reader-outline-panel")).toBeTruthy();
    await click(desktopOutline);
    expect(desktopOutline.getAttribute("aria-expanded")).toBe("false");
    expect(compactOutline.getAttribute("aria-expanded")).toBe("false");

    const [desktopAnnotations, compactAnnotations] = toolPair("[data-reader-annotation-trigger]");
    expect(desktopAnnotations.getAttribute("aria-controls")).toBe("reader-annotations-panel");
    expect(compactAnnotations.getAttribute("aria-controls")).toBe("reader-annotations-panel");
    await click(desktopAnnotations);
    expect(desktopAnnotations.getAttribute("aria-expanded")).toBe("true");
    expect(compactAnnotations.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector("#reader-annotations-panel")).toBeTruthy();
    await click(compactAnnotations);
    expect(desktopAnnotations.getAttribute("aria-expanded")).toBe("false");
    expect(compactAnnotations.getAttribute("aria-expanded")).toBe("false");
  });

  it("returns find focus to the reader tool that is visible after a breakpoint change", async () => {
    const desktopSearch = host.querySelector<HTMLButtonElement>(
      ".reader-desktop-topbar-tools [data-reader-search-trigger]",
    )!;
    const compactSearch = host.querySelector<HTMLButtonElement>(
      "[data-reader-document-tools] [data-reader-search-trigger]",
    )!;
    Object.defineProperty(desktopSearch, "getClientRects", {
      configurable: true,
      value: () => [],
    });
    Object.defineProperty(compactSearch, "getClientRects", {
      configurable: true,
      value: () => [{}],
    });

    await click(desktopSearch);
    await click(host.querySelector<HTMLButtonElement>('[aria-label="关闭查找"]')!);
    expect(document.activeElement).toBe(compactSearch);
  });

  it("keeps desktop page and zoom controls in the bottom reader bar while preserving compact controls", async () => {
    const source = {
      ...props.source,
      id: "desktop-pdf-source",
      versionId: "desktop-pdf-version",
      kind: "pdf" as const,
      mime: "application/pdf",
      pageCount: 48,
      readPage: 12,
    };
    await render({ source, sources: [source] });

    const compactToolbar = host.querySelector<HTMLElement>("[data-reader-document-tools]");
    const bottomBar = host.querySelector<HTMLElement>("[data-reader-desktop-bottom-controls]");

    expect(compactToolbar?.querySelector(".reader-document-page-controls")).toBeTruthy();
    expect(compactToolbar?.querySelector(".reader-document-zoom-controls")).toBeTruthy();
    // The reading tool strip owns the name "阅读工具条"; the desktop bottom bar
    // carries only reading position and zoom, so it says what it holds.
    expect(compactToolbar?.getAttribute("aria-label")).toBe("阅读工具条");
    expect(bottomBar).toBeTruthy();
    expect(bottomBar?.getAttribute("role")).toBe("group");
    expect(bottomBar?.getAttribute("aria-label")).toBe("页码与缩放");
    expect(bottomBar?.querySelector('[aria-label="上一页"]')).toBeTruthy();
    expect(bottomBar?.querySelector('[aria-label="下一页"]')).toBeTruthy();
    expect(bottomBar?.querySelector('[aria-label="跳转页码"]')).toBeTruthy();
    expect(bottomBar?.querySelector('[aria-label="缩小"]')).toBeTruthy();
    expect(bottomBar?.querySelector('[aria-label="放大"]')).toBeTruthy();
    expect(bottomBar?.querySelector('[aria-label="查找原文"]')).toBeNull();
    expect(bottomBar?.querySelector('[aria-label^="我的标注"]')).toBeNull();

    await click(bottomBar!.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!);
    expect(bottomBar?.querySelector<HTMLInputElement>('[aria-label="跳转页码"]')?.value).toBe("13");

    await click(bottomBar!.querySelector<HTMLButtonElement>('[aria-label="放大"]')!);
    expect(bottomBar?.querySelector(".reader-zoom")?.textContent).toBe("110%");
  });

  it("keeps return, compact source identity, and Ask AI while exposing source controls in an accessible more menu", async () => {
    const topbar = host.querySelector<HTMLElement>(".reader-topbar");
    expect(topbar?.querySelector('[aria-label="返回资料库"]')).toBeTruthy();
    expect(topbar?.querySelector(".reader-breadcrumb strong")?.textContent).toBe(
      props.source.title,
    );
    expect(
      [...(topbar?.querySelectorAll<HTMLButtonElement>("button") || [])].some(
        (button) => button.textContent?.replace(/\s+/gu, "") === "问AI",
      ),
    ).toBe(true);
    expect(topbar?.querySelector('[aria-label="资料版本记录"]')).toBeNull();
    expect(topbar?.querySelector('[aria-label="替换文件"]')).toBeNull();
    expect(topbar?.querySelector('[aria-label="下载原文件"]')).toBeNull();

    const toggle = moreToggle();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("reader-source-actions-menu");

    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const menu = actionMenu();
    expect(menu.getAttribute("role")).toBe("group");
    expect(menu.getAttribute("aria-label")).toBe("资料操作");
    expect(
      [...menu.querySelectorAll("button")].map((button) => button.textContent?.trim()),
    ).toEqual(["资料版本记录", "替换文件", "下载原文件"]);

    toggle.focus();
    await act(async () => {
      toggle.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    });
    expect(host.querySelector("#reader-source-actions-menu")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await click(toggle);
    actionButton("替换文件").focus();
    await act(async () => {
      actionMenu().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    });
    expect(host.querySelector("#reader-source-actions-menu")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);

    await click(toggle);
    await act(async () => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(host.querySelector("#reader-source-actions-menu")).toBeNull();
  });

  it("uses a contextual return destination in the desktop header and phone navigation", async () => {
    await render({ backLabel: "返回更新审核" });

    const desktopBack = host.querySelector<HTMLButtonElement>(
      '.reader-topbar [aria-label="返回更新审核"]',
    );
    expect(desktopBack).toBeTruthy();
    expect(desktopBack?.classList.contains("reader-back-button-context")).toBe(true);
    expect(desktopBack?.textContent).toBe("返回更新审核");
    expect(desktopBack?.getAttribute("title")).toBe("返回更新审核");

    const mobileBack = host.querySelector<HTMLButtonElement>(
      '.reader-mobile-primary-nav [aria-label="返回更新审核"]',
    );
    expect(mobileBack).toBeTruthy();
    expect(mobileBack?.textContent).toBe("更新审核");
    expect(mobileBack?.querySelector(".lucide-arrow-left")).toBeTruthy();
    expect(mobileBack?.querySelector(".lucide-folder-open")).toBeNull();

    await click(desktopBack!);
    await click(mobileBack!);
    expect(props.onBack).toHaveBeenCalledTimes(2);
  });

  it("labels a legacy saved webpage selection by its retained scope instead of a parser warning", async () => {
    const source = {
      ...props.source,
      kind: "web" as const,
      status: "partial" as const,
      url: "https://example.com/selection",
      webSnapshot: {
        originalUrl: "https://example.com/selection",
        finalUrl: "https://example.com/selection",
        capturedAt: "2026-09-13T00:00:00.000Z",
        method: "server" as const,
        scope: "selection" as const,
        warnings: [],
      },
    };
    await render({ source, sources: [source] });

    const status = host.querySelector<HTMLElement>(".reader-status");
    expect(status?.textContent).toBe("仅保存选段");
    expect(status?.classList.contains("reader-status-ready")).toBe(true);
  });

  it("keeps a concise phone reading and sync state beside a two-part Ask AI entry", async () => {
    const source = {
      ...props.source,
      id: "phone-pdf-source",
      versionId: "phone-pdf-version",
      kind: "pdf" as const,
      mime: "application/pdf",
      pageCount: 48,
      readPage: 12,
    };
    await render({
      source,
      sources: [source],
      saveState: "cloud",
      saveLabel: "已同步",
    });

    const topbar = host.querySelector<HTMLElement>(".reader-topbar");
    const readingMeta = topbar?.querySelector<HTMLElement>(".reader-mobile-reading-meta");
    expect(readingMeta?.textContent).toBe("第 12 页 · 共 48 页");
    expect(readingMeta?.getAttribute("aria-label")).toBe("阅读状态：第 12 页 · 共 48 页");
    expect(topbar?.querySelector(".reader-save-status > span")?.textContent).toBe("已同步");

    const askbar = host.querySelector<HTMLElement>(".reader-mobile-askbar");
    expect(askbar?.getAttribute("role")).toBeNull();
    expect(askbar?.querySelector('[aria-label="从底部打开问 AI"]')?.textContent).toContain(
      "问 AI：基于这篇资料提问",
    );
    expect(askbar?.querySelector('[aria-label="打开问 AI 输入"]')).toBeTruthy();
  });

  it("opens replacement from the more menu and closes the menu first", async () => {
    await click(moreToggle());
    await click(actionButton("替换文件"));

    expect(host.querySelector("#reader-source-actions-menu")).toBeNull();
    const panel = host.querySelector<HTMLElement>('[aria-label="资料版本管理"]');
    expect(panel).toBeTruthy();
    expect(panel?.querySelector('[aria-pressed="true"]')?.textContent?.trim()).toBe("替换文件");
  });

  it("offers refresh instead of replacement for a web source", async () => {
    const source = {
      ...props.source,
      kind: "web" as const,
      url: "https://example.com/learning",
    };
    await render({
      source,
      sources: [source],
      onRefreshWeb: vi.fn(),
      onReplaceFile: undefined,
    });

    await click(moreToggle());
    expect(
      [...actionMenu().querySelectorAll("button")].map((button) => button.textContent?.trim()),
    ).toEqual(["网页版本记录", "刷新网页", "下载原文件"]);
  });
});
