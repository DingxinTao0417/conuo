// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Reader, { type ReaderProps } from "./reader";
import { createDemoWorkspace } from "@/lib/seed";

vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./pdf-reader", () => ({ default: () => null }));
vi.mock("./web-version-panel", () => ({ default: () => null }));

describe("reader AI panel resize", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: ReaderProps;
  let wideLayout: boolean;
  let scrollDescriptor: PropertyDescriptor | undefined;
  let setPointerCaptureDescriptor: PropertyDescriptor | undefined;
  let hasPointerCaptureDescriptor: PropertyDescriptor | undefined;
  let releasePointerCaptureDescriptor: PropertyDescriptor | undefined;
  let innerWidthDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    wideLayout = true;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(min-width: 1025px)" ? wideLayout : false,
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
    setPointerCaptureDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "setPointerCapture",
    );
    hasPointerCaptureDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "hasPointerCapture",
    );
    releasePointerCaptureDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "releasePointerCapture",
    );
    innerWidthDescriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
      configurable: true,
      value: vi.fn(() => true),
    });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      value: vi.fn(),
    });

    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const workspace = createDemoWorkspace();
    const source = {
      ...workspace.sources[0],
      id: "resize-source",
      versionId: "resize-version",
      kind: "markdown" as const,
      aiAllowed: true,
      text: "# 学习资料\n\n可以在这里阅读并向 AI 提问。",
      spaceIds: [workspace.spaces[0].id],
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
    restoreDescriptor(Element.prototype, "scrollIntoView", scrollDescriptor);
    restoreDescriptor(HTMLElement.prototype, "setPointerCapture", setPointerCaptureDescriptor);
    restoreDescriptor(HTMLElement.prototype, "hasPointerCapture", hasPointerCaptureDescriptor);
    restoreDescriptor(
      HTMLElement.prototype,
      "releasePointerCapture",
      releasePointerCaptureDescriptor,
    );
    restoreDescriptor(window, "innerWidth", innerWidthDescriptor);
    vi.unstubAllGlobals();
  });

  function restoreDescriptor(
    target: object,
    key: string,
    descriptor: PropertyDescriptor | undefined,
  ) {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  }

  async function render(overrides: Partial<ReaderProps> = {}) {
    props = { ...props, ...overrides };
    await act(async () => {
      root.render(createElement(Reader, props));
    });
  }

  function resizer() {
    const separator = host.querySelector<HTMLDivElement>('[role="separator"]');
    expect(separator).toBeTruthy();
    return separator!;
  }

  function workspace() {
    const element = host.querySelector<HTMLElement>(".reader-workspace");
    expect(element).toBeTruthy();
    return element!;
  }

  async function press(key: string, options: KeyboardEventInit = {}) {
    await act(async () => {
      resizer().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key, ...options }));
    });
  }

  async function pointer(type: string, clientX: number, pointerType = "mouse") {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 });
    Object.defineProperties(event, {
      pointerId: { value: 3 },
      pointerType: { value: pointerType },
    });
    await act(async () => {
      resizer().dispatchEvent(event);
    });
  }

  async function resizeViewport(width: number) {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
  }

  it("exposes an accessible desktop separator and keeps its chosen width while reopening the panel", async () => {
    expect(resizer().getAttribute("aria-label")).toBe("调整问 AI 面板宽度");
    expect(resizer().getAttribute("aria-orientation")).toBe("vertical");
    expect(resizer().getAttribute("aria-valuemin")).toBe("320");
    expect(resizer().getAttribute("aria-valuemax")).toBe("520");
    expect(resizer().getAttribute("aria-valuenow")).toBe("380");

    await press("ArrowLeft");
    expect(resizer().getAttribute("aria-valuenow")).toBe("396");
    expect(workspace().style.getPropertyValue("--reader-ai-width")).toBe("396px");

    await press("ArrowRight", { shiftKey: true });
    expect(resizer().getAttribute("aria-valuenow")).toBe("364");
    await press("Home");
    expect(resizer().getAttribute("aria-valuenow")).toBe("320");
    await press("End");
    expect(resizer().getAttribute("aria-valuenow")).toBe("520");

    const close = host.querySelector<HTMLButtonElement>('[aria-label="收起问答面板"]');
    expect(close).toBeTruthy();
    await act(async () => {
      close!.click();
    });
    expect(host.querySelector('[role="separator"]')).toBeNull();

    const open = host.querySelector<HTMLButtonElement>(".reader-ai-toggle");
    expect(open).toBeTruthy();
    await act(async () => {
      open!.click();
    });
    expect(resizer().getAttribute("aria-valuenow")).toBe("520");
  });

  it("resizes with a pointer drag and ignores pointer input in compact layouts", async () => {
    await pointer("pointerdown", 600);
    expect(workspace().className).toContain("reader-ai-resizing");
    await pointer("pointermove", 540);
    expect(resizer().getAttribute("aria-valuenow")).toBe("440");
    await pointer("pointerup", 540);
    expect(workspace().className).not.toContain("reader-ai-resizing");

    wideLayout = false;
    await pointer("pointerdown", 540, "touch");
    await pointer("pointermove", 400, "touch");
    expect(resizer().getAttribute("aria-valuenow")).toBe("440");
    expect(workspace().className).not.toContain("reader-ai-resizing");
  });

  it("uses the landscape tablet default without overwriting a customized width", async () => {
    await resizeViewport(1194);
    expect(resizer().getAttribute("aria-valuenow")).toBe("360");
    expect(workspace().style.getPropertyValue("--reader-ai-width")).toBe("360px");

    await press("ArrowLeft");
    expect(resizer().getAttribute("aria-valuenow")).toBe("376");

    Object.defineProperty(workspace(), "clientWidth", { configurable: true, value: 892 });
    await resizeViewport(1194);
    expect(resizer().getAttribute("aria-valuenow")).toBe("320");

    Object.defineProperty(workspace(), "clientWidth", { configurable: true, value: 1_194 });
    await resizeViewport(1200);
    expect(resizer().getAttribute("aria-valuenow")).toBe("376");
    await resizeViewport(1194);
    expect(resizer().getAttribute("aria-valuenow")).toBe("376");
    expect(workspace().style.getPropertyValue("--reader-ai-width")).toBe("376px");

    await act(async () => {
      resizer().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(resizer().getAttribute("aria-valuenow")).toBe("360");
    expect(workspace().style.getPropertyValue("--reader-ai-width")).toBe("360px");

    await resizeViewport(1200);
    expect(resizer().getAttribute("aria-valuenow")).toBe("380");
    await act(async () => {
      resizer().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(resizer().getAttribute("aria-valuenow")).toBe("380");
  });
});
