// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import ReaderToolstrip, { type ReaderToolstripProps } from "./reader/reader-toolstrip";

describe("reader tool strip interactions", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: ReaderToolstripProps;
  let changeReadingMode: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    changeReadingMode = vi.fn();
    const workspace = createDemoWorkspace();
    props = {
      source: {
        ...workspace.sources[0],
        kind: "pdf",
        pageCount: 12,
      },
      showText: false,
      page: 3,
      pages: 12,
      zoom: 100,
      outlineItems: [
        {
          id: "learning-rate",
          title: "学习率",
          level: 1,
          locator: "学习率决定每一步走多远。",
          kind: "chunk-section",
        },
      ],
      annotationCount: 3,
      activePanel: null,
      regionCaptureActive: false,
      regionStudyBlockedMessage: "",
      pdfReadingModeControls: () =>
        createElement("button", { onClick: changeReadingMode }, "连续滚动"),
      changePage: vi.fn(),
      setZoom: vi.fn(),
      togglePdfText: vi.fn(),
      toggleRegionCapture: vi.fn(),
      toggleOutline: vi.fn(),
      toggleAnnotations: vi.fn(),
    };
    await render();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(overrides: Partial<ReaderToolstripProps> = {}) {
    props = { ...props, ...overrides };
    await act(async () => root.render(createElement(ReaderToolstrip, props)));
  }

  function button(selector: string) {
    const result = host.querySelector<HTMLButtonElement>(selector);
    expect(result, selector).toBeTruthy();
    return result!;
  }

  function textButton(text: string) {
    const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === text,
    );
    expect(result, text).toBeTruthy();
    return result!;
  }

  function toggle() {
    return button("[data-reader-toolstrip-toggle]");
  }

  async function click(target: HTMLButtonElement) {
    await act(async () => target.click());
  }

  function expectExpanded(expanded: boolean) {
    expect(toggle().getAttribute("aria-expanded")).toBe(String(expanded));
    expect(
      host.querySelector("[data-reader-document-tools]")?.getAttribute("data-tools-expanded"),
    ).toBe(String(expanded));
  }

  it("closes expanded tools with Escape and restores focus to their visible toggle", async () => {
    expect(toggle().getAttribute("aria-label")).toBe("PDF阅读工具");
    expectExpanded(false);
    await click(toggle());
    expectExpanded(true);

    const action = textButton("解析文本");
    action.focus();
    await act(async () => {
      action.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    });

    expectExpanded(false);
    expect(document.activeElement).toBe(toggle());
    expect(props.togglePdfText).not.toHaveBeenCalled();
  });

  it("hands directory and annotation actions to their panels and collapses the tools", async () => {
    await click(toggle());
    const outline = button("[data-reader-outline-trigger]");
    await click(outline);

    expect(props.toggleOutline).toHaveBeenCalledExactlyOnceWith(outline);
    expect(props.toggleAnnotations).not.toHaveBeenCalled();
    expectExpanded(false);
    expect(document.activeElement).toBe(toggle());

    await click(toggle());
    await click(button("[data-reader-annotation-trigger]"));

    expect(props.toggleAnnotations).toHaveBeenCalledExactlyOnceWith();
    expect(props.toggleOutline).toHaveBeenCalledTimes(1);
    expectExpanded(false);
    expect(document.activeElement).toBe(toggle());
  });

  it("keeps the tools open while changing reading mode or switching PDF text views", async () => {
    await click(toggle());
    await click(textButton("连续滚动"));
    expect(changeReadingMode).toHaveBeenCalledTimes(1);
    expectExpanded(true);

    await click(textButton("解析文本"));
    expect(props.togglePdfText).toHaveBeenCalledTimes(1);
    await render({ showText: true });
    expectExpanded(true);
    expect(host.querySelector("[data-reader-region-trigger]")).toBeNull();

    await click(textButton("原始 PDF"));
    expect(props.togglePdfText).toHaveBeenCalledTimes(2);
    await render({ showText: false });
    expectExpanded(true);
    expect(textButton("连续滚动")).toBeTruthy();
  });

  it("labels annotations visibly, omits the empty badge, and follows the active panel", async () => {
    const annotations = button("[data-reader-annotation-trigger]");
    const outline = button("[data-reader-outline-trigger]");
    expect(annotations.textContent).toContain("标注");
    expect(annotations.textContent).toContain("3");
    expect(annotations.getAttribute("aria-label")).toBe("我的标注（3）");
    expect(annotations.getAttribute("aria-expanded")).toBe("false");
    expect(outline.getAttribute("aria-expanded")).toBe("false");

    await render({ activePanel: "annotations" });
    expect(annotations.getAttribute("aria-expanded")).toBe("true");
    expect(outline.getAttribute("aria-expanded")).toBe("false");

    await render({
      source: { ...props.source, kind: "markdown" },
      activePanel: "outline",
      annotationCount: 0,
    });
    expect(toggle().getAttribute("aria-label")).toBe("资料阅读工具");
    expect(annotations.textContent?.replace(/\s+/gu, "")).toBe("标注");
    expect(annotations.getAttribute("aria-label")).toBe("我的标注（0）");
    expect(annotations.getAttribute("aria-expanded")).toBe("false");
    expect(outline.getAttribute("aria-expanded")).toBe("true");
  });

  it("explains unavailable region study beside the disabled action and clears the reason when ready", async () => {
    const reason = "当前资料未开启 AI 访问。";
    await render({ regionStudyBlockedMessage: reason });
    await click(toggle());
    const region = button("[data-reader-region-trigger]");
    const descriptionId = region.getAttribute("aria-describedby");
    expect(region.disabled).toBe(true);
    expect(descriptionId).toBeTruthy();
    const description = document.getElementById(descriptionId!);
    expect(host.querySelector("[data-reader-toolstrip-tools]")?.contains(description)).toBe(true);
    expect(description?.textContent).toContain(reason);
    await click(region);
    expect(props.toggleRegionCapture).not.toHaveBeenCalled();

    await render({ regionStudyBlockedMessage: "" });
    expect(region.disabled).toBe(false);
    expect(region.hasAttribute("aria-describedby")).toBe(false);
    expect(document.getElementById(descriptionId!)).toBeNull();
    await click(region);
    expect(props.toggleRegionCapture).toHaveBeenCalledTimes(1);
  });
});
