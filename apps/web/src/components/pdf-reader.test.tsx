// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import PdfReader from "./pdf-reader";

const engine = vi.hoisted(() => ({
  documents: [] as unknown[],
  layers: [] as { container: HTMLElement; content: unknown; cancel: ReturnType<typeof vi.fn> }[],
  getDocument: vi.fn(),
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: engine.getDocument,
  TextLayer: class {
    private entry;
    constructor(options: { container: HTMLElement; textContentSource: unknown }) {
      this.entry = {
        container: options.container,
        content: options.textContentSource,
        cancel: vi.fn(),
      };
      engine.layers.push(this.entry);
    }
    render() {
      const content = this.entry.content as { text: string; rendering?: Promise<void> };
      const span = document.createElement("span");
      span.textContent = content.text;
      this.entry.container.append(span);
      return content.rendering ?? Promise.resolve();
    }
    cancel() {
      this.entry.cancel();
    }
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function pdfPage(text = "native page text") {
  return {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 900 * scale,
      scale,
      userUnit: 1,
    })),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    getTextContent: vi.fn(async () => ({ text })),
  };
}

function pdfDocument(pages = [pdfPage(), pdfPage("second native page")]) {
  return {
    numPages: pages.length,
    getPage: vi.fn(async (number: number) => pages[number - 1]),
  };
}

describe("PDF Reader canvas and native text lifecycle", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: ComponentProps<typeof PdfReader>;
  let first: ReturnType<typeof pdfPage>;
  let second: ReturnType<typeof pdfPage>;
  let documentTask: { promise: Promise<unknown>; destroy: ReturnType<typeof vi.fn> };
  let drawImage: ReturnType<typeof vi.fn>;
  const pointerDescriptors = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("devicePixelRatio", 1);
    for (const name of ["setPointerCapture", "hasPointerCapture", "releasePointerCapture"]) {
      pointerDescriptors.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        value: vi.fn(() => true),
      });
    }
    drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      fillRect: vi.fn(),
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, mime) => {
      callback(new Blob(["encoded region pixels"], { type: mime }));
    });
    first = pdfPage();
    second = pdfPage("second native page");
    engine.documents = [pdfDocument([first, second])];
    engine.layers = [];
    engine.getDocument.mockReset().mockImplementation(() => {
      documentTask = { promise: Promise.resolve(engine.documents.shift()), destroy: vi.fn() };
      return documentTask;
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    props = {
      source: {
        ...createDemoWorkspace().sources[0],
        id: "pdf-source",
        versionId: "pdf-v1",
        kind: "pdf",
      },
      page: 1,
      zoom: 100,
      getSourceBlob: vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(4) }) as Blob),
      onPages: vi.fn(),
      onRendered: vi.fn(),
      capture: { active: true, onCapture: vi.fn(), onCancel: vi.fn() },
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    for (const [name, descriptor] of pointerDescriptors) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, name);
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(overrides: Partial<typeof props> = {}, key = "account-a") {
    props = { ...props, ...overrides };
    await act(async () => root.render(createElement(PdfReader, { ...props, key })));
  }

  function overlay() {
    return host.querySelector<HTMLElement>("[data-pdf-region-selector]")!;
  }

  function textLayer() {
    return host.querySelector<HTMLElement>(".reader-pdf-text")!;
  }

  function confirmButton() {
    return [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "使用这一区域",
    )!;
  }

  async function select() {
    Object.defineProperty(overlay(), "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600 }),
    });
    for (const [type, x, y] of [
      ["pointerdown", 40, 60],
      ["pointermove", 200, 300],
      ["pointerup", 200, 300],
    ] as const) {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
      });
      Object.defineProperties(event, { pointerId: { value: 8 }, pointerType: { value: "mouse" } });
      await act(async () => overlay().dispatchEvent(event));
    }
  }

  async function expectCapture(page = 1) {
    await select();
    expect(confirmButton().disabled).toBe(false);
    const sourceCanvas = host.querySelector(`.reader-pdf-page[data-reader-page="${page}"] canvas`);
    await act(async () => confirmButton().click());
    expect(props.capture!.onCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: { sourceId: props.source.id, versionId: props.source.versionId, page },
        region: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
        pixelRegion: { x: 60, y: 90, width: 240, height: 360 },
        width: 240,
        height: 360,
      }),
    );
    expect(drawImage).toHaveBeenCalledWith(sourceCanvas, 60, 90, 240, 360, 0, 0, 240, 360);
  }

  function expectNoNativeProof() {
    expect(textLayer().hasAttribute("data-reader-source-id")).toBe(false);
    expect(textLayer().hasAttribute("data-reader-source-version")).toBe(false);
    expect(textLayer().hasAttribute("data-reader-page")).toBe(false);
    expect(textLayer().hasAttribute("data-reader-text")).toBe(false);
  }

  it("captures rendered pixels even when native text extraction fails", async () => {
    first.getTextContent.mockRejectedValue(new Error("text extraction failed"));
    await render();
    await expectCapture();
    expectNoNativeProof();
    expect(host.textContent).toContain("文字选取暂不可用");
    expect(host.textContent).not.toContain("PDF 预览暂不可用");
  });

  it("captures while getTextContent remains pending without granting native selection proof", async () => {
    const text = deferred<{ text: string }>();
    first.getTextContent.mockReturnValue(text.promise);
    await render();
    expect(host.querySelector(".reader-pdf-overflow")?.getAttribute("aria-busy")).toBe("false");
    expectNoNativeProof();
    await expectCapture();
    expect(engine.layers).toHaveLength(0);
  });

  it("clears a failed partial TextLayer but retains pixel capture", async () => {
    const textRender = deferred<void>();
    first.getTextContent.mockResolvedValue({
      text: "partial native text",
      rendering: textRender.promise,
    } as { text: string });
    await render();
    expectNoNativeProof();
    await act(async () => textRender.reject(new Error("TextLayer failed")));
    expect(textLayer().textContent).toBe("");
    expectNoNativeProof();
    expect(engine.layers[0].cancel).toHaveBeenCalled();
    await expectCapture();
  });

  it("grants native selection proof only after this page's TextLayer completes", async () => {
    const textRender = deferred<void>();
    first.getTextContent.mockResolvedValue({
      text: "native text",
      rendering: textRender.promise,
    } as { text: string });
    await render();
    expectNoNativeProof();
    await act(async () => textRender.resolve());
    expect(textLayer().dataset.readerSourceId).toBe("pdf-source");
    expect(textLayer().dataset.readerSourceVersion).toBe("pdf-v1");
    expect(textLayer().dataset.readerPage).toBe("1");
    expect(textLayer().dataset.readerText).toBe("true");
    await expectCapture();
  });

  it("does not construct an old pending TextLayer after changing page", async () => {
    const oldText = deferred<{ text: string }>();
    first.getTextContent.mockReturnValue(oldText.promise);
    await render();
    await render({ page: 2 });
    expect(textLayer().textContent).toBe("second native page");
    const renderedCalls = vi.mocked(props.onRendered).mock.calls.length;
    await act(async () => oldText.resolve({ text: "stale page text" }));
    expect(engine.layers).toHaveLength(1);
    expect(textLayer().textContent).toBe("second native page");
    expect(textLayer().dataset.readerPage).toBe("2");
    expect(props.onRendered).toHaveBeenCalledTimes(renderedCalls);
    await expectCapture(2);
  });

  it("cancels old partial text and ignores its late failure without clearing the next page", async () => {
    const oldRender = deferred<void>();
    first.getTextContent.mockResolvedValue({
      text: "old partial",
      rendering: oldRender.promise,
    } as { text: string });
    await render();
    const oldLayer = engine.layers[0];
    await render({ page: 2 });
    await act(async () => oldRender.reject(new Error("late old text failure")));
    expect(oldLayer.cancel).toHaveBeenCalled();
    expect(textLayer().textContent).toBe("second native page");
    expect(textLayer().dataset.readerPage).toBe("2");
    expect(host.textContent).not.toContain("文字选取暂不可用");
    await expectCapture(2);
  });

  it("keeps capture disabled until the current Canvas finishes and after a Canvas failure", async () => {
    const pixels = deferred<void>();
    const cancel = vi.fn();
    first.render.mockReturnValue({ promise: pixels.promise, cancel });
    await render();
    await select();
    expect(confirmButton().disabled).toBe(true);
    expect(first.getTextContent).not.toHaveBeenCalled();
    await act(async () => pixels.reject(new Error("pixel rendering failed")));
    await select();
    expect(confirmButton().disabled).toBe(true);
    expectNoNativeProof();
    expect(host.textContent).toContain("PDF 预览暂不可用");
    expect(props.capture!.onCapture).not.toHaveBeenCalled();
  });

  it("cannot revive the old same-page frame after a failed open retry", async () => {
    await render();
    await expectCapture();
    const broken = pdfPage();
    broken.render.mockImplementation(() => {
      throw new Error("new Canvas failed");
    });
    engine.documents.push(pdfDocument([broken, second]));
    // Returning to the old zoom must not restore its frame after another render fails.
    first.render.mockImplementation(() => {
      throw new Error("same page failed");
    });
    await render({ zoom: 110 });
    await render({ zoom: 100 });
    await select();
    expect(confirmButton().disabled).toBe(true);
    expectNoNativeProof();
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "重试打开",
    )!;
    await act(async () => retry.click());
    await select();
    expect(confirmButton().disabled).toBe(true);
    expectNoNativeProof();
    expect(host.textContent).toContain("new Canvas failed");
  });

  it("opens a new source version without exposing the old version's pending native text or pixels", async () => {
    const oldText = deferred<{ text: string }>();
    first.getTextContent.mockReturnValue(oldText.promise);
    await render();
    const versionPage = pdfPage("version 2 native text");
    const versionPixels = deferred<void>();
    versionPage.render.mockReturnValue({ promise: versionPixels.promise, cancel: vi.fn() });
    engine.documents.push(pdfDocument([versionPage]));
    await render({ source: { ...props.source, versionId: "pdf-v2" } }, "account-a:pdf-v2");
    await act(async () => oldText.resolve({ text: "version 1 stale text" }));
    expect(host.textContent).not.toContain("PDF 预览暂不可用");
    expect(engine.getDocument).toHaveBeenCalledTimes(2);
    await select();
    expect(confirmButton().disabled).toBe(true);
    expectNoNativeProof();
    expect(engine.layers).toHaveLength(0);
    await act(async () => versionPixels.resolve());
    expect(textLayer().textContent).toBe("version 2 native text");
    expect(textLayer().dataset.readerSourceVersion).toBe("pdf-v2");
    await expectCapture();
  });

  it("invalidates current-page pixels while a new page renders and ignores old completion", async () => {
    const oldPixels = deferred<void>();
    first.render.mockReturnValue({ promise: oldPixels.promise, cancel: vi.fn() });
    const newPixels = deferred<void>();
    second.render.mockReturnValue({ promise: newPixels.promise, cancel: vi.fn() });
    await render();
    await render({ page: 2 });
    await act(async () => oldPixels.resolve());
    await select();
    expect(confirmButton().disabled).toBe(true);
    expect(first.getTextContent).not.toHaveBeenCalled();
    await act(async () => newPixels.resolve());
    await expectCapture(2);
  });

  it("disposes account A's pending text before the same source opens for account B", async () => {
    const oldText = deferred<{ text: string }>();
    first.getTextContent.mockReturnValue(oldText.promise);
    await render();
    const oldTask = documentTask;
    const accountBPage = pdfPage("account B native text");
    const accountBPixels = deferred<void>();
    accountBPage.render.mockReturnValue({ promise: accountBPixels.promise, cancel: vi.fn() });
    engine.documents.push(pdfDocument([accountBPage]));
    await render({}, "account-b");
    expect(oldTask.destroy).toHaveBeenCalled();
    await act(async () => oldText.resolve({ text: "account A private text" }));
    await select();
    expect(confirmButton().disabled).toBe(true);
    expect(engine.layers).toHaveLength(0);
    await act(async () => accountBPixels.resolve());
    expect(textLayer().textContent).toBe("account B native text");
    await expectCapture();
  });

  function enableScrollGeometry(documentInset = 0) {
    host.className = "reader-document-scroll";
    Object.defineProperty(host, "clientHeight", { configurable: true, value: 650 });
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      host.scrollTop = options.top ?? 0;
    });
    Object.defineProperty(host, "scrollTo", { configurable: true, value: scrollTo });
    const originalBounds = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === host)
        return { top: 0, left: 0, bottom: 650, right: 800, width: 800, height: 650 } as DOMRect;
      if (this.classList.contains("reader-pdf-page")) {
        const pages = [...host.querySelectorAll<HTMLElement>(".reader-pdf-page")];
        const index = pages.indexOf(this);
        const offset = pages
          .slice(0, index)
          .reduce((sum, page) => sum + parseFloat(page.style.height) + 24, 0);
        const height = parseFloat(this.style.height);
        const width = parseFloat(this.style.width);
        const top = documentInset + offset - host.scrollTop;
        return { top, left: 0, bottom: top + height, right: width, width, height } as DOMRect;
      }
      return originalBounds.call(this);
    });
    let sequence = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++sequence;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    props.scrollContainerRef = { current: host };
    return {
      scrollTo,
      async scroll(top: number) {
        await act(async () => {
          host.scrollTop = top;
          host.dispatchEvent(new Event("scroll"));
          const pending = [...frames.values()];
          frames.clear();
          pending.forEach((callback) => callback(0));
        });
      },
    };
  }

  function manyPages(number = 20) {
    const pages = Array.from({ length: number }, (_, index) =>
      pdfPage(`physical page ${index + 1}`),
    );
    const pdf = pdfDocument(pages);
    engine.documents = [pdf];
    return { pages, pdf };
  }

  function addToolbar(position = "sticky", display = "flex") {
    const toolbar = document.createElement("div");
    toolbar.className = "reader-document-tools";
    toolbar.style.position = position;
    toolbar.style.display = display;
    toolbar.style.top = "0px";
    Object.defineProperty(toolbar, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 0, left: 0, bottom: 70, right: 800, width: 800, height: 70 }),
    });
    host.prepend(toolbar);
    return toolbar;
  }

  it("keeps every physical page in continuous layout while only nearby pages allocate pixels", async () => {
    enableScrollGeometry();
    const { pages, pdf } = manyPages();
    await render({ readingMode: "continuous", capture: undefined });
    expect(host.querySelectorAll(".reader-pdf-page")).toHaveLength(20);
    expect(host.querySelectorAll("canvas").length).toBeLessThanOrEqual(5);
    expect(host.querySelectorAll(".reader-pdf-placeholder").length).toBeGreaterThanOrEqual(15);
    expect(pages[0].render).toHaveBeenCalledTimes(1);
    expect(pages[1].render).toHaveBeenCalledTimes(1);
    expect(pdf.getPage).not.toHaveBeenCalledWith(10);
    expect(pages[19].render).not.toHaveBeenCalled();
  });

  it("reports the visible physical page and accepts feedback without resetting the scroll position", async () => {
    const geometry = enableScrollGeometry();
    const { pdf } = manyPages();
    const onVisiblePageChange = vi.fn();
    await render({ readingMode: "continuous", onVisiblePageChange, capture: undefined });
    await geometry.scroll(9 * 924 + 150);
    expect(onVisiblePageChange).toHaveBeenLastCalledWith(10);
    expect(pdf.getPage).toHaveBeenCalledWith(10);
    expect(host.querySelectorAll("canvas").length).toBeLessThanOrEqual(5);
    expect(host.querySelector('.reader-pdf-page[data-reader-page="1"] canvas')).toBeNull();
    const navigations = geometry.scrollTo.mock.calls.length;
    await render({ page: 10 });
    await geometry.scroll(9 * 924 + 160);
    expect(host.scrollTop).toBe(9 * 924 + 160);
    expect(geometry.scrollTo).toHaveBeenCalledTimes(navigations);
    expect(onVisiblePageChange).toHaveBeenCalledTimes(1);
    expect(engine.getDocument).toHaveBeenCalledTimes(1);
    expect(props.getSourceBlob).toHaveBeenCalledTimes(1);
  });

  it("jumps to a requested page and can explicitly return to the start of that same page", async () => {
    const geometry = enableScrollGeometry();
    manyPages();
    const onVisiblePageChange = vi.fn();
    await render({ readingMode: "continuous", onVisiblePageChange, capture: undefined });
    await render({ page: 7, navigationRequest: 1 });
    expect(host.scrollTop).toBe(6 * 924);
    expect(onVisiblePageChange).not.toHaveBeenCalled();
    await geometry.scroll(6 * 924 + 250);
    await render({ navigationRequest: 2 });
    expect(host.scrollTop).toBe(6 * 924);
    expect(onVisiblePageChange).not.toHaveBeenCalled();
    expect(engine.getDocument).toHaveBeenCalledTimes(1);
  });

  it("switches modes on the current page while keeping its within-page position and loaded document", async () => {
    const geometry = enableScrollGeometry();
    manyPages();
    await render({ readingMode: "continuous", capture: undefined });
    await geometry.scroll(9 * 924 + 180);
    await render({ page: 10 });
    await render({ readingMode: "single" });
    expect(host.querySelectorAll(".reader-pdf-page")).toHaveLength(1);
    expect(host.querySelector(".reader-pdf-page")?.getAttribute("data-reader-page")).toBe("10");
    expect(host.scrollTop).toBe(180);
    await render({ readingMode: "continuous" });
    expect(host.querySelectorAll(".reader-pdf-page")).toHaveLength(20);
    expect(host.scrollTop).toBe(9 * 924 + 180);
    expect(engine.getDocument).toHaveBeenCalledTimes(1);
    expect(props.getSourceBlob).toHaveBeenCalledTimes(1);
    expect(documentTask.destroy).not.toHaveBeenCalled();
  });

  it("binds continuous screenshots and native text proof to the visible physical page", async () => {
    const geometry = enableScrollGeometry();
    manyPages();
    await render({ readingMode: "continuous" });
    await select();
    expect(host.querySelector("[data-pdf-capture-selection]")).not.toBeNull();
    await geometry.scroll(9 * 924 + 150);
    expect(host.querySelectorAll("[data-pdf-region-selector]")).toHaveLength(1);
    expect(overlay().dataset.page).toBe("10");
    expect(host.querySelector("[data-pdf-capture-selection]")).toBeNull();
    const native = host.querySelector<HTMLElement>(
      '.reader-pdf-page[data-reader-page="10"] .reader-pdf-text',
    )!;
    expect(native.textContent).toBe("physical page 10");
    expect(native.dataset.readerPage).toBe("10");
    expect(native.dataset.readerSourceId).toBe("pdf-source");
    expect(native.dataset.readerSourceVersion).toBe("pdf-v1");
    await expectCapture(10);
  });

  it("clears unconfirmed selections on mode switches and explicit same-page navigation", async () => {
    enableScrollGeometry();
    await render();
    await select();
    expect(host.querySelector("[data-pdf-capture-selection]")).not.toBeNull();
    await render({ readingMode: "continuous" });
    expect(host.querySelector("[data-pdf-capture-selection]")).toBeNull();
    await select();
    await render({ navigationRequest: 1 });
    expect(host.querySelector("[data-pdf-capture-selection]")).toBeNull();
    expect(props.capture!.onCapture).not.toHaveBeenCalled();
  });

  it("cancels offscreen render tasks, releases their canvases, and ignores their late completion", async () => {
    const geometry = enableScrollGeometry();
    const { pages } = manyPages();
    const pendingPixels = deferred<void>();
    const cancel = vi.fn();
    pages[0].render.mockReturnValue({ promise: pendingPixels.promise, cancel });
    await render({ readingMode: "continuous", capture: undefined });
    const oldCanvas = host.querySelector<HTMLCanvasElement>(
      '.reader-pdf-page[data-reader-page="1"] canvas',
    )!;
    await geometry.scroll(9 * 924);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(oldCanvas.width).toBe(0);
    expect(oldCanvas.height).toBe(0);
    const notifications = vi.mocked(props.onRendered).mock.calls.length;
    await act(async () => pendingPixels.resolve());
    expect(pages[0].getTextContent).not.toHaveBeenCalled();
    expect(props.onRendered).toHaveBeenCalledTimes(notifications);
    expect(host.querySelector('.reader-pdf-page[data-reader-page="1"] canvas')).toBeNull();
    expect(host.querySelector('.reader-pdf-page[data-reader-page="10"] canvas')).not.toBeNull();
  });

  it("prevents a delayed capture from an old mode from reaching the AI callback", async () => {
    enableScrollGeometry();
    const encoding = deferred<Blob>();
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      void encoding.promise.then(callback);
    });
    await render();
    await select();
    await act(async () => confirmButton().click());
    await render({ readingMode: "continuous" });
    await act(async () => encoding.resolve(new Blob(["encoded pixels"], { type: "image/png" })));
    expect(props.capture!.onCapture).not.toHaveBeenCalled();
  });

  it("releases navigation at a page's end so a mode switch never traps later scrolling", async () => {
    const geometry = enableScrollGeometry();
    const onVisiblePageChange = vi.fn();
    await render({ capture: undefined, onVisiblePageChange });
    await geometry.scroll(810);
    await render({ readingMode: "continuous" });
    expect(host.scrollTop).toBe(810);
    expect(onVisiblePageChange).toHaveBeenLastCalledWith(2);
    const jumps = geometry.scrollTo.mock.calls.length;
    await geometry.scroll(1000);
    await geometry.scroll(1200);
    expect(host.scrollTop).toBe(1200);
    expect(geometry.scrollTo).toHaveBeenCalledTimes(jumps);
  });

  it("uses an explicit same-page request to return a single-page viewport to its start", async () => {
    const geometry = enableScrollGeometry();
    await render({ capture: undefined });
    await geometry.scroll(300);
    await render({ navigationRequest: 1 });
    expect(host.scrollTop).toBe(0);
    expect(engine.getDocument).toHaveBeenCalledTimes(1);
  });

  it("ignores text extraction arriving after its continuous page becomes an offscreen placeholder", async () => {
    const geometry = enableScrollGeometry();
    const { pages } = manyPages();
    const oldText = deferred<{ text: string }>();
    pages[0].getTextContent.mockReturnValue(oldText.promise);
    await render({ readingMode: "continuous", capture: undefined });
    await geometry.scroll(9 * 924);
    const layers = engine.layers.length;
    const notifications = vi.mocked(props.onRendered).mock.calls.length;
    await act(async () => oldText.resolve({ text: "late first-page text" }));
    expect(engine.layers).toHaveLength(layers);
    expect(props.onRendered).toHaveBeenCalledTimes(notifications);
    expect(host.textContent).not.toContain("late first-page text");
    expect(
      host.querySelector('.reader-pdf-page[data-reader-page="1"] .reader-pdf-text'),
    ).toBeNull();
  });

  it("positions an explicitly requested PDF page below the visible sticky document toolbar", async () => {
    enableScrollGeometry(70);
    manyPages();
    await render({ readingMode: "continuous", capture: undefined });
    addToolbar();
    await render({ page: 3, navigationRequest: 1 });
    const page = host.querySelector<HTMLElement>('.reader-pdf-page[data-reader-page="3"]')!;
    expect(page.getBoundingClientRect().top).toBe(70);
    expect(host.scrollTop).toBe(2 * 924);
    await render({ navigationRequest: 2 });
    expect(page.getBoundingClientRect().top).toBe(70);
  });

  it("keeps the within-page reading position beneath a sticky toolbar across both mode switches", async () => {
    const geometry = enableScrollGeometry(70);
    manyPages();
    await render({ readingMode: "continuous", capture: undefined });
    addToolbar();
    await render({ page: 3, navigationRequest: 1 });
    await geometry.scroll(2 * 924 + 180);
    const continuousTop = host
      .querySelector<HTMLElement>('.reader-pdf-page[data-reader-page="3"]')!
      .getBoundingClientRect().top;
    expect(continuousTop).toBe(-110);
    await render({ readingMode: "single" });
    expect(host.querySelector<HTMLElement>(".reader-pdf-page")!.getBoundingClientRect().top).toBe(
      continuousTop,
    );
    expect(host.scrollTop).toBe(180);
    await render({ readingMode: "continuous" });
    expect(
      host
        .querySelector<HTMLElement>('.reader-pdf-page[data-reader-page="3"]')!
        .getBoundingClientRect().top,
    ).toBe(continuousTop);
    expect(host.scrollTop).toBe(2 * 924 + 180);
    expect(engine.getDocument).toHaveBeenCalledTimes(1);
  });

  it("detects the visible page using the space below the sticky toolbar", async () => {
    const geometry = enableScrollGeometry(70);
    const onVisiblePageChange = vi.fn();
    manyPages();
    await render({ readingMode: "continuous", capture: undefined, onVisiblePageChange });
    addToolbar();
    await render({ navigationRequest: 1 });
    await geometry.scroll(800);
    expect(onVisiblePageChange).toHaveBeenLastCalledWith(2);
  });

  it.each([
    ["static", "flex"],
    ["sticky", "none"],
    ["fixed", "flex"],
  ])("does not reserve occlusion for a %s toolbar with display %s", async (position, display) => {
    enableScrollGeometry();
    manyPages();
    await render({ readingMode: "continuous", capture: undefined });
    addToolbar(position, display);
    await render({ page: 3, navigationRequest: 1 });
    expect(
      host
        .querySelector<HTMLElement>('.reader-pdf-page[data-reader-page="3"]')!
        .getBoundingClientRect().top,
    ).toBe(0);
    expect(host.scrollTop).toBe(2 * 924);
  });
});
