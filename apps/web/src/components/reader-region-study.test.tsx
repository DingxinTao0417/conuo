// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Reader, { type ReaderProps } from "./reader";
import { createDemoWorkspace } from "@/lib/seed";
import type { PdfCaptureResult } from "./pdf-capture";

const bridge = vi.hoisted(() => ({ pdfProps: null as Record<string, unknown> | null }));

vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./web-version-panel", () => ({ default: () => null }));
vi.mock("./pdf-reader", () => ({
  default: (props: Record<string, unknown>) => {
    bridge.pdfProps = props;
    return null;
  },
}));
vi.mock("./region-study-panel", async () => {
  const React = await import("react");
  return {
    default: (props: { capture: PdfCaptureResult; onRecapture: () => void; onClose: () => void }) =>
      React.createElement(
        "div",
        { "data-region-study-panel": true },
        `panel:${props.capture.identity.page}`,
        React.createElement("button", { onClick: props.onRecapture }, "重新框选"),
        React.createElement("button", { onClick: props.onClose }, "关闭区域学习"),
      ),
  };
});

describe("Reader region study integration", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: ReaderProps;
  let scrollDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    bridge.pdfProps = null;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
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
      id: "pdf-source",
      versionId: "pdf-version",
      kind: "pdf" as const,
      mime: "application/pdf",
      pageCount: 12,
      readPage: 7,
      aiAllowed: true,
      originalMissing: false,
    };
    props = {
      source,
      sources: [source],
      notes: [],
      space: workspace.spaces[0],
      conversations: [],
      annotations: [],
      aiEnabled: true,
      cloudUserId: "account-one",
      saveState: "cloud",
      saveLabel: "已保存到云端",
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

  async function click(target: HTMLButtonElement) {
    await act(async () => target.click());
  }

  function regionTriggers() {
    return [...host.querySelectorAll<HTMLButtonElement>("[data-reader-region-trigger]")];
  }

  function captureControl() {
    return bridge.pdfProps?.capture as {
      active: boolean;
      onCapture: (capture: PdfCaptureResult) => void;
    };
  }

  function captureResult(): PdfCaptureResult {
    return {
      identity: { sourceId: "pdf-source", versionId: "pdf-version", page: 7 },
      region: { x: 0.1, y: 0.2, width: 0.3, height: 0.25 },
      pixelRegion: { x: 10, y: 20, width: 300, height: 250 },
      blob: new Blob(["private-region"], { type: "image/jpeg" }),
      mimeType: "image/jpeg",
      width: 300,
      height: 250,
      bytes: 14,
    };
  }

  it("turns an exact PDF capture into the visual study review panel", async () => {
    // Framing is a PDF tool, so it has exactly one trigger: the strip inside
    // the document. It used to be duplicated in the global top bar.
    expect(regionTriggers()).toHaveLength(1);
    expect(regionTriggers().every((button) => !button.disabled)).toBe(true);

    await click(regionTriggers()[0]!);
    const control = bridge.pdfProps?.capture as {
      active: boolean;
      onCapture: (capture: PdfCaptureResult) => void;
    };
    expect(control.active).toBe(true);

    const capture: PdfCaptureResult = {
      identity: { sourceId: "pdf-source", versionId: "pdf-version", page: 7 },
      region: { x: 0.1, y: 0.2, width: 0.3, height: 0.25 },
      pixelRegion: { x: 10, y: 20, width: 300, height: 250 },
      blob: new Blob(["region"], { type: "image/jpeg" }),
      mimeType: "image/jpeg",
      width: 300,
      height: 250,
      bytes: 6,
    };
    await act(async () => control.onCapture(capture));

    expect(host.querySelector("[data-region-study-panel]")?.textContent).toContain("panel:7");
    expect((bridge.pdfProps?.capture as { active: boolean }).active).toBe(false);

    await click(
      [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "重新框选",
      )!,
    );
    expect(host.querySelector("[data-region-study-panel]")).toBeNull();
    expect((bridge.pdfProps?.capture as { active: boolean }).active).toBe(true);
  });

  it("discards captured pixels when the signed-in account changes", async () => {
    await click(regionTriggers()[0]!);
    const control = bridge.pdfProps?.capture as {
      onCapture: (capture: PdfCaptureResult) => void;
    };
    await act(async () =>
      control.onCapture({
        identity: { sourceId: "pdf-source", versionId: "pdf-version", page: 7 },
        region: { x: 0.1, y: 0.2, width: 0.3, height: 0.25 },
        pixelRegion: { x: 10, y: 20, width: 300, height: 250 },
        blob: new Blob(["private-region"], { type: "image/jpeg" }),
        mimeType: "image/jpeg",
        width: 300,
        height: 250,
        bytes: 14,
      }),
    );
    expect(host.querySelector("[data-region-study-panel]")).toBeTruthy();

    await render({ cloudUserId: "account-two" });
    expect(host.querySelector("[data-region-study-panel]")).toBeNull();

    await render({ cloudUserId: "account-one" });
    expect(host.querySelector("[data-region-study-panel]")).toBeNull();
    expect((bridge.pdfProps?.capture as { active: boolean }).active).toBe(false);
  });

  it("ends selection when the account changes before any screenshot is captured", async () => {
    await click(regionTriggers()[0]!);
    expect(captureControl().active).toBe(true);

    await render({ cloudUserId: "account-two" });
    expect(captureControl().active).toBe(false);
    expect(host.querySelector("[data-region-study-panel]")).toBeNull();

    await render({ cloudUserId: "account-one" });
    expect(captureControl().active).toBe(false);
  });

  it("ignores an old capture callback after another account starts a new selection", async () => {
    await click(regionTriggers()[0]!);
    const oldControl = captureControl();

    await render({ cloudUserId: "account-two" });
    await click(regionTriggers()[0]!);
    const newControl = captureControl();
    expect(newControl.active).toBe(true);

    await act(async () => oldControl.onCapture(captureResult()));
    expect(host.querySelector("[data-region-study-panel]")).toBeNull();
    expect(captureControl().active).toBe(true);

    await act(async () => newControl.onCapture(captureResult()));
    expect(host.querySelector("[data-region-study-panel]")).toBeTruthy();
    expect(captureControl().active).toBe(false);
  });

  it.each(["source", "version", "AI setting", "source permission", "cloud state"])(
    "invalidates a pending selection and its callback when %s changes",
    async (change) => {
      await click(regionTriggers()[0]!);
      const oldControl = captureControl();
      let overrides: Partial<ReaderProps>;
      if (change === "AI setting") overrides = { aiEnabled: false };
      else if (change === "cloud state") overrides = { saveState: "saving" };
      else {
        const changedSource = {
          ...props.source,
          ...(change === "source"
            ? { id: "another-source" }
            : change === "version"
              ? { versionId: "another-version" }
              : { aiAllowed: false }),
        };
        overrides = { source: changedSource, sources: [changedSource] };
      }

      await render(overrides);
      expect(captureControl().active).toBe(false);
      await act(async () => oldControl.onCapture(captureResult()));
      expect(host.querySelector("[data-region-study-panel]")).toBeNull();
      expect(captureControl().active).toBe(false);
    },
  );

  it("blocks selection until account, cloud confirmation and AI permissions are ready", async () => {
    await render({ cloudUserId: undefined });
    expect(regionTriggers().every((button) => button.disabled)).toBe(true);
    expect(regionTriggers()[0]?.title).toContain("登录");

    await render({ cloudUserId: "account-one", saveState: "saving" });
    expect(regionTriggers().every((button) => button.disabled)).toBe(true);
    expect(regionTriggers()[0]?.title).toContain("云端确认");

    await render({ saveState: "cloud", aiEnabled: false });
    expect(regionTriggers().every((button) => button.disabled)).toBe(true);
    expect(regionTriggers()[0]?.title).toContain("资料问答已关闭");

    const denied = { ...props.source, aiAllowed: false };
    await render({ aiEnabled: true, source: denied, sources: [denied] });
    expect(regionTriggers().every((button) => button.disabled)).toBe(true);
    expect(regionTriggers()[0]?.title).toContain("尚未允许用于 AI");
  });

  it("removes the image-region action in parsed-text mode", async () => {
    // The parsed-text switch is a pressed-state control in the tool strip now,
    // so it is addressed by the label the reader actually sees.
    const toggle = [
      ...host.querySelectorAll<HTMLButtonElement>(
        "[data-reader-desktop-bottom-controls] button",
      ),
    ].find((button) => button.textContent?.trim() === "解析文本");
    expect(toggle).toBeTruthy();
    await click(toggle!);
    expect(regionTriggers()).toHaveLength(0);
    expect(bridge.pdfProps).not.toBeNull();
  });
});
