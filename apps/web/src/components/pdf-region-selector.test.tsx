// @vitest-environment jsdom

import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PdfRegionSelector, { type PdfRegionSelectorProps } from "./pdf-region-selector";

const firstIdentity = { sourceId: "source-a", versionId: "version-1", page: 2 };

describe("PDF region selector", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: PdfRegionSelectorProps;
  let pointerCaptureDescriptor: PropertyDescriptor | undefined;
  let hasPointerCaptureDescriptor: PropertyDescriptor | undefined;
  let releasePointerCaptureDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    pointerCaptureDescriptor = Object.getOwnPropertyDescriptor(
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
    props = {
      canvasRef: createRef<HTMLCanvasElement>(),
      identity: firstIdentity,
      onCapture: vi.fn(),
      onCancel: vi.fn(),
      onSelectionChange: vi.fn(),
    };
    props.canvasRef.current = { width: 800, height: 1_200 } as HTMLCanvasElement;
    await render();
    setBounds({ left: 100, top: 50, width: 400, height: 200 });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    restoreDescriptor(HTMLElement.prototype, "setPointerCapture", pointerCaptureDescriptor);
    restoreDescriptor(HTMLElement.prototype, "hasPointerCapture", hasPointerCaptureDescriptor);
    restoreDescriptor(
      HTMLElement.prototype,
      "releasePointerCapture",
      releasePointerCaptureDescriptor,
    );
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

  async function render(overrides: Partial<PdfRegionSelectorProps> = {}) {
    props = { ...props, ...overrides };
    await act(async () => root.render(createElement(PdfRegionSelector, props)));
  }

  function overlay() {
    const element = host.querySelector<HTMLDivElement>("[data-pdf-region-selector]");
    expect(element).toBeTruthy();
    return element!;
  }

  function setBounds(bounds: { left: number; top: number; width: number; height: number }) {
    Object.defineProperty(overlay(), "getBoundingClientRect", {
      configurable: true,
      value: vi.fn(() => ({
        ...bounds,
        right: bounds.left + bounds.width,
        bottom: bounds.top + bounds.height,
        x: bounds.left,
        y: bounds.top,
        toJSON: () => ({}),
      })),
    });
  }

  async function pointer(type: string, clientX: number, clientY: number, pointerId = 8) {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button: 0,
    });
    Object.defineProperties(event, {
      pointerId: { value: pointerId },
      pointerType: { value: "mouse" },
    });
    await act(async () => overlay().dispatchEvent(event));
  }

  it("supports reverse dragging and clamps the chosen region to page boundaries", async () => {
    await pointer("pointerdown", 150, 100);
    await pointer("pointermove", 600, 10);
    await pointer("pointerup", 600, 10);

    const lastSelection = vi.mocked(props.onSelectionChange!).mock.calls.at(-1)?.[0];
    expect(lastSelection).toEqual({
      identity: firstIdentity,
      region: { x: 0.125, y: 0, width: 0.875, height: 0.25 },
    });
    const selection = host.querySelector<HTMLElement>("[data-pdf-capture-selection]");
    expect(selection?.style.left).toBe("12.5%");
    expect(selection?.style.top).toBe("0%");
    expect(selection?.style.width).toBe("87.5%");
    expect(selection?.style.height).toBe("25%");
  });

  it("keeps normalized coordinates after layout zoom and clears them on page/version change", async () => {
    await pointer("pointerdown", 140, 90);
    await pointer("pointerup", 300, 170);
    const before = vi.mocked(props.onSelectionChange!).mock.calls.at(-1)?.[0];

    await render();
    setBounds({ left: 50, top: 20, width: 800, height: 400 });
    const retained = host.querySelector<HTMLElement>("[data-pdf-capture-selection]");
    expect(retained?.style.left).toBe(`${before!.region.x * 100}%`);
    expect(retained?.style.width).toBe(`${before!.region.width * 100}%`);

    await render({ identity: { ...firstIdentity, page: 3 } });
    expect(host.querySelector("[data-pdf-capture-selection]")).toBeNull();
    expect(vi.mocked(props.onSelectionChange!).mock.calls.at(-1)?.[0]).toBeNull();
    expect(overlay().dataset.page).toBe("3");
  });

  it("cancels with Escape and ignores too-small or not-ready drags", async () => {
    await pointer("pointerdown", 160, 90);
    await pointer("pointerup", 260, 150);
    expect(host.querySelector("[data-pdf-capture-selection]")).toBeTruthy();

    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-pdf-capture-selection]")).toBeNull();

    await pointer("pointerdown", 150, 100);
    await pointer("pointerup", 154, 104);
    expect(host.querySelector("[data-pdf-capture-selection]")).toBeNull();

    await render({ ready: false });
    setBounds({ left: 100, top: 50, width: 400, height: 200 });
    await pointer("pointerdown", 150, 100);
    await pointer("pointerup", 300, 180);
    expect(host.querySelector("[data-pdf-capture-selection]")).toBeNull();
    const confirm = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("使用这一区域"),
    );
    expect(confirm?.disabled).toBe(true);
  });
});
