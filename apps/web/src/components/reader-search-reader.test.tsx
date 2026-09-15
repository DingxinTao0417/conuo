// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Reader, { type ReaderProps } from "./reader";
import { createDemoWorkspace } from "@/lib/seed";
import type { Source } from "@/lib/types";

vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./pdf-reader", () => ({ default: () => null }));
vi.mock("./web-version-panel", () => ({ default: () => null }));

describe("reader in-document search", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: ReaderProps;
  let source: Source;
  let scrollDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const workspace = createDemoWorkspace();
    source = {
      ...workspace.sources[0],
      id: "search-source",
      versionId: "search-version",
      kind: "markdown",
      title: "学习率资料标题不应计入查找",
      text: `# 原文概览

第一处学习率在正文中。

第二处 **学习**率跨越行内格式。

第三处学习率在正文中。`,
      chunks: [],
      aiAllowed: true,
    };
    props = {
      source,
      sources: [source],
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

  async function click(button: HTMLButtonElement) {
    await act(async () => button.click());
  }

  async function setInput(value: string) {
    const input = host.querySelector<HTMLInputElement>('input[aria-label="查找文字"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    await act(async () => input.dispatchEvent(new Event("input", { bubbles: true })));
  }

  function button(label: string) {
    const result = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(result, label).toBeTruthy();
    return result!;
  }

  function count() {
    return host.querySelector<HTMLElement>("[data-reader-search-count]")?.textContent?.trim();
  }

  it("counts and cycles only source prose, including inline Markdown text", async () => {
    const toggle = button("查找原文");
    await click(toggle);
    expect(toggle.getAttribute("aria-controls")).toBe("reader-find-panel");
    expect(document.activeElement).toBe(host.querySelector('input[aria-label="查找文字"]'));
    await setInput("学习率");

    await click(button("下一处匹配"));
    expect(count()).toBe("1 / 3");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });

    await click(button("下一处匹配"));
    expect(count()).toBe("2 / 3");
    await click(button("上一处匹配"));
    expect(count()).toBe("1 / 3");

    await act(async () => {
      host
        .querySelector<HTMLInputElement>('input[aria-label="查找文字"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Enter", shiftKey: true }),
        );
    });
    expect(count()).toBe("3 / 3");
  });

  it("reports no result clearly and clears the current result when the panel closes", async () => {
    await click(button("查找原文"));
    await setInput("不存在的正文");
    await click(button("下一处匹配"));
    expect(count()).toBe("0 / 0");
    expect(host.textContent).toContain("原文中没有找到该文字。");

    await click(button("关闭查找"));
    expect(host.querySelector('input[aria-label="查找文字"]')).toBeNull();
    expect(document.activeElement).toBe(button("查找原文"));

    await click(button("查找原文"));
    expect(host.querySelector<HTMLInputElement>('input[aria-label="查找文字"]')?.value).toBe(
      "不存在的正文",
    );
    expect(count()).toBe("按 Enter 查找");
  });
});
