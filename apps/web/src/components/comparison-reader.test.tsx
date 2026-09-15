// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createComparisonConversationMetadata } from "@/lib/comparison-conversation";
import type { Conversation, Source, Space } from "@/lib/types";

vi.mock("./pdf-reader", async () => {
  const { createElement: renderElement } = await import("react");
  return {
    default: ({
      source,
      page,
      zoom,
    }: {
      source: { id: string; title: string };
      page: number;
      zoom: number;
    }) =>
      renderElement(
        "output",
        { "data-pdf-preview": source.id },
        `${source.title} · ${page} · ${zoom}%`,
      ),
  };
});

import ComparisonReader, { type ComparisonReaderProps } from "./comparison-reader";

const space: Space = {
  id: "machine-learning",
  name: "机器学习",
  goal: "整理课程资料与阅读笔记",
  color: "#6844d9",
  archived: false,
  createdAt: "2026-09-13T00:00:00.000Z",
};

function source(id: string, overrides: Partial<Source> = {}): Source {
  return {
    id,
    versionId: `${id}-version-2`,
    versionCreatedAt: "2026-09-13T00:00:00.000Z",
    title: `${id} 学习资料`,
    filename: `${id}.md`,
    kind: "markdown",
    mime: "text/markdown",
    size: 128,
    hash: `${id}-hash`,
    spaceIds: [space.id],
    tags: [],
    status: "ready",
    text: "第一段正文。\n\n第二段正文。",
    chunks: [],
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    deletedAt: null,
    aiAllowed: true,
    starred: false,
    ...overrides,
  };
}

function installMatchMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    get matches() {
      return matches;
    },
    media: "(max-width: 1024px)",
    onchange: null,
    addEventListener: (_type: string, callback: EventListenerOrEventListenerObject) => {
      if (typeof callback === "function") listeners.add(callback as () => void);
    },
    removeEventListener: (_type: string, callback: EventListenerOrEventListenerObject) => {
      if (typeof callback === "function") listeners.delete(callback as () => void);
    },
    addListener: (callback: () => void) => listeners.add(callback),
    removeListener: (callback: () => void) => listeners.delete(callback),
    dispatchEvent: () => true,
  } as MediaQueryList;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => query),
  );
}

function progress(enabled = true) {
  return {
    isCurrentVersion: vi.fn(() => enabled),
    onChange: vi.fn(),
    onPendingChange: vi.fn(),
  };
}

describe("ComparisonReader", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: ComparisonReaderProps;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T12:00:00.000Z"));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    installMatchMedia(false);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    props = {
      leftSource: source("left", {
        title: "神经网络基础",
        text: "# 神经网络\n\n[安全链接](https://example.com)\n\n[危险链接](javascript:alert(1))\n\n![结构图](https://example.com/image.png)\n\n<script>window.untrusted = true</script>",
      }),
      rightSource: source("right", {
        title: "线性回归入门",
        kind: "text",
        mime: "text/plain",
        text: "第一段原始文本。\n\n第二段原始文本。",
      }),
      space,
      getSourceBlob: vi.fn(async () => undefined),
      onBack: vi.fn(),
      onOpenSource: vi.fn(),
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function render(overrides: Partial<ComparisonReaderProps> = {}) {
    props = { ...props, ...overrides };
    await act(async () => root.render(createElement(ComparisonReader, props)));
  }

  async function scrollPane(side: "left" | "right", offset: number, settleMs = 400) {
    const container = host.querySelector<HTMLElement>(
      `[data-comparison-side="${side}"] .comparison-document-scroll`,
    )!;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      writable: true,
      value: offset,
    });
    await act(async () => {
      container.dispatchEvent(new Event("scroll", { bubbles: true }));
      vi.advanceTimersByTime(settleMs);
    });
  }

  it("renders two independent read-only source panes with exact-version open actions", async () => {
    await render();

    expect(host.querySelector("h1")?.textContent).toBe("对照阅读");
    expect(host.textContent).toContain("同一知识库 · 机器学习");
    expect(host.textContent).toContain("固定版本 · 只读");
    expect(host.querySelectorAll(".comparison-document-pane")).toHaveLength(2);
    expect(host.querySelectorAll(".comparison-document-scroll")).toHaveLength(2);
    expect(host.querySelector('[data-comparison-side="left"]')?.textContent).toContain(
      "神经网络基础",
    );
    expect(host.querySelector('[data-comparison-side="right"]')?.textContent).toContain(
      "线性回归入门",
    );
    expect(host.querySelector('[data-comparison-side="left"]')?.textContent).toContain("Markdown");
    expect(host.querySelector('[data-comparison-side="right"]')?.textContent).toContain("TXT");
    expect(host.querySelectorAll(".comparison-plain-paragraph")).toHaveLength(2);
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector(".comparison-reader-image-placeholder")?.textContent).toContain(
      "结构图",
    );

    const sourceButtons = [...host.querySelectorAll<HTMLButtonElement>(".comparison-open-source")];
    expect(sourceButtons).toHaveLength(2);
    await act(async () => sourceButtons[1].click());
    expect(props.onOpenSource).toHaveBeenCalledWith(
      props.rightSource.id,
      props.rightSource.versionId,
    );

    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="返回资料库"]')!.click(),
    );
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it("keeps PDF page and zoom controls isolated to their own pane", async () => {
    const leftPdf = source("left-pdf", {
      title: "左侧 PDF",
      kind: "pdf",
      mime: "application/pdf",
      filename: "left.pdf",
      text: "",
      pageCount: 3,
      readPage: 1,
    });
    const rightPdf = source("right-pdf", {
      title: "右侧 PDF",
      kind: "pdf",
      mime: "application/pdf",
      filename: "right.pdf",
      text: "",
      pageCount: 4,
      readPage: 1,
    });
    await render({
      leftSource: leftPdf,
      rightSource: rightPdf,
      readingPositionRevision: 0,
    });

    expect(host.querySelector('[data-pdf-preview="left-pdf"]')?.textContent).toBe(
      "左侧 PDF · 1 · 100%",
    );
    expect(host.querySelector('[data-pdf-preview="right-pdf"]')?.textContent).toBe(
      "右侧 PDF · 1 · 100%",
    );

    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="左侧 PDF 下一页"]')!.click(),
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="右侧 PDF 放大"]')!.click(),
    );

    expect(host.querySelector('[data-pdf-preview="left-pdf"]')?.textContent).toBe(
      "左侧 PDF · 2 · 100%",
    );
    expect(host.querySelector('[data-pdf-preview="right-pdf"]')?.textContent).toBe(
      "右侧 PDF · 1 · 110%",
    );

    await render({
      leftSource: { ...leftPdf, readPage: 3 },
      rightSource: { ...rightPdf, readPage: 4 },
      readingPositionRevision: 1,
    });
    expect(host.querySelector('[data-pdf-preview="left-pdf"]')?.textContent).toBe(
      "左侧 PDF · 3 · 100%",
    );
    expect(host.querySelector('[data-pdf-preview="right-pdf"]')?.textContent).toBe(
      "右侧 PDF · 4 · 110%",
    );
  });

  it("restores and saves each current text pane independently after a scroll settle", async () => {
    const readingProgress = progress();
    const left = source("left", { readOffset: 90 });
    const right = source("right", { readOffset: 180 });
    await render({ leftSource: left, rightSource: right, readingProgress });

    const panes = [...host.querySelectorAll<HTMLElement>(".comparison-document-scroll")];
    expect(panes.map((pane) => pane.scrollTop)).toEqual([90, 180]);

    await scrollPane("left", 120);
    expect(readingProgress.onChange).toHaveBeenLastCalledWith(
      left,
      expect.objectContaining({
        readOffset: 120,
        lastReadAt: "2026-09-13T12:00:00.400Z",
      }),
    );

    await scrollPane("right", 260);
    expect(readingProgress.onChange).toHaveBeenLastCalledWith(
      right,
      expect.objectContaining({
        readOffset: 260,
        lastReadAt: "2026-09-13T12:00:00.800Z",
      }),
    );
  });

  it("rate-limits one pane's text writes without delaying the other pane", async () => {
    const readingProgress = progress();
    await render({ readingProgress });

    await scrollPane("left", 120);
    expect(readingProgress.onChange).toHaveBeenCalledTimes(1);

    await scrollPane("left", 260);
    expect(readingProgress.onChange).toHaveBeenCalledTimes(1);

    await scrollPane("right", 180);
    expect(readingProgress.onChange).toHaveBeenCalledTimes(2);
    expect(readingProgress.onChange).toHaveBeenLastCalledWith(
      props.rightSource,
      expect.objectContaining({ readOffset: 180 }),
    );

    await act(async () => {
      vi.advanceTimersByTime(14_200);
    });
    expect(readingProgress.onChange).toHaveBeenLastCalledWith(
      props.leftSource,
      expect.objectContaining({
        readOffset: 260,
        lastReadAt: "2026-09-13T12:00:15.400Z",
      }),
    );
  });

  it("holds pending scroll intent during both the settle and activity throttle", async () => {
    const readingProgress = progress();
    const left = source("left", { readOffset: 90, lastReadAt: new Date().toISOString() });
    await render({
      leftSource: left,
      rightSource: { ...props.rightSource, lastReadAt: new Date().toISOString() },
      readingProgress,
    });

    await scrollPane("left", 120, 0);
    expect(readingProgress.onPendingChange.mock.calls).toEqual([[left, true]]);
    expect(readingProgress.onChange).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTime(399));
    expect(readingProgress.onPendingChange.mock.calls).toEqual([[left, true]]);
    await act(async () => vi.advanceTimersByTime(14_600));
    expect(readingProgress.onPendingChange.mock.calls).toEqual([[left, true]]);
    expect(readingProgress.onChange).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTime(1));
    expect(readingProgress.onChange).toHaveBeenCalledWith(
      left,
      expect.objectContaining({ readOffset: 120 }),
    );
    expect(readingProgress.onPendingChange.mock.calls).toEqual([
      [left, true],
      [left, false],
    ]);
    expect(readingProgress.onChange.mock.invocationCallOrder[0]).toBeLessThan(
      readingProgress.onPendingChange.mock.invocationCallOrder[1],
    );
  });

  it("keeps the two pane notices independent when one returns to its saved offset", async () => {
    const readingProgress = progress();
    await render({ readingProgress });
    await scrollPane("left", 120, 0);
    await scrollPane("right", 180, 0);
    await scrollPane("left", 0, 0);
    expect(readingProgress.onPendingChange.mock.calls).toEqual([
      [props.leftSource, true],
      [props.rightSource, true],
      [props.leftSource, false],
    ]);

    await act(async () => vi.advanceTimersByTime(400));
    expect(readingProgress.onChange).toHaveBeenCalledTimes(1);
    expect(readingProgress.onChange).toHaveBeenCalledWith(
      props.rightSource,
      expect.objectContaining({ readOffset: 180 }),
    );
    expect(readingProgress.onPendingChange).toHaveBeenLastCalledWith(props.rightSource, false);
  });

  it("retains intent and its throttle when a timestamp-only save changes the activity baseline", async () => {
    const readingProgress = progress();
    await render({
      leftSource: { ...props.leftSource, lastReadAt: new Date().toISOString() },
      rightSource: { ...props.rightSource, lastReadAt: new Date().toISOString() },
      readingProgress,
    });
    const owner = props.leftSource;
    await scrollPane("left", 160);
    await act(async () => vi.advanceTimersByTime(4_600));
    await render({ leftSource: { ...props.leftSource, lastReadAt: new Date().toISOString() } });
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(readingProgress.onChange).not.toHaveBeenCalled();
    expect(readingProgress.onPendingChange.mock.calls).toEqual([[owner, true]]);
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(readingProgress.onChange).toHaveBeenCalledWith(
      props.leftSource,
      expect.objectContaining({ readOffset: 160 }),
    );
    expect(readingProgress.onPendingChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "left" }),
      false,
    );
  });

  it("releases each original notice on cleanup without leaving delayed writes", async () => {
    const readingProgress = progress();
    await render({ readingProgress });
    const left = props.leftSource;
    await scrollPane("left", 120, 0);
    await scrollPane("right", 180, 0);

    await render({ leftSource: source("replacement"), readingProgress: progress(false) });
    expect(readingProgress.onPendingChange).toHaveBeenCalledWith(left, false);
    expect(
      readingProgress.onPendingChange.mock.calls.filter(([, pending]) => !pending),
    ).toHaveLength(2);
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(props.readingProgress?.onChange).not.toHaveBeenCalled();
    expect(props.readingProgress?.onPendingChange).not.toHaveBeenCalledWith(
      expect.anything(),
      true,
    );
  });

  it("clears settled intent after the version becomes historical", async () => {
    let current = true;
    const readingProgress = { ...progress(), isCurrentVersion: vi.fn(() => current) };
    await render({ readingProgress });
    await scrollPane("left", 160, 0);
    current = false;
    await act(async () => vi.advanceTimersByTime(400));
    expect(readingProgress.onChange).not.toHaveBeenCalled();
    expect(readingProgress.onPendingChange.mock.calls).toEqual([
      [props.leftSource, true],
      [props.leftSource, false],
    ]);
    await scrollPane("right", 180);
    expect(readingProgress.onPendingChange.mock.calls).toHaveLength(2);
  });

  it("uses the original notice callback when a newer callback replaces it", async () => {
    const first = progress();
    const next = progress();
    await render({ readingProgress: first });
    await scrollPane("left", 120, 0);
    await render({ readingProgress: next });
    await scrollPane("left", 0, 0);
    expect(first.onPendingChange.mock.calls).toEqual([
      [props.leftSource, true],
      [props.leftSource, false],
    ]);
    expect(next.onPendingChange).not.toHaveBeenCalled();

    await scrollPane("right", 180, 0);
    expect(next.onPendingChange).toHaveBeenCalledWith(props.rightSource, true);
    await act(async () => vi.advanceTimersByTime(400));
    expect(next.onPendingChange).toHaveBeenLastCalledWith(props.rightSource, false);
    expect(first.onPendingChange.mock.calls).toHaveLength(2);
  });

  it("returns to the latest reported offset without requiring a source rerender", async () => {
    const readingProgress = progress();
    await render({ readingProgress });
    await scrollPane("left", 120);
    await scrollPane("left", 240, 0);
    await scrollPane("left", 120, 0);
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(
      readingProgress.onChange.mock.calls.filter(([, patch]) => patch.readOffset !== undefined),
    ).toHaveLength(1);
    expect(readingProgress.onPendingChange.mock.calls).toEqual([
      [props.leftSource, true],
      [props.leftSource, false],
      [props.leftSource, true],
      [props.leftSource, false],
    ]);
  });

  it("drops pending pane progress and restores both resolved text offsets", async () => {
    const readingProgress = progress();
    await render({ readingProgress, readingPositionRevision: 0 });
    await act(async () => vi.advanceTimersByTime(1_500));
    readingProgress.onChange.mockClear();

    vi.setSystemTime(new Date("2026-09-13T12:01:00.000Z"));
    await scrollPane("left", 120);
    expect(readingProgress.onChange).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-09-13T12:01:05.000Z"));
    await scrollPane("left", 260);
    expect(readingProgress.onChange).toHaveBeenCalledTimes(1);

    await render({
      leftSource: { ...props.leftSource, readOffset: 30 },
      rightSource: { ...props.rightSource, readOffset: 70 },
      readingPositionRevision: 1,
    });
    const panes = [...host.querySelectorAll<HTMLElement>(".comparison-document-scroll")];
    expect(panes.map((pane) => pane.scrollTop)).toEqual([30, 70]);
    expect(readingProgress.onPendingChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "left" }),
      false,
    );

    await act(async () => vi.advanceTimersByTime(20_000));
    expect(readingProgress.onChange).toHaveBeenCalledTimes(1);
  });

  it("saves only the PDF pane whose page changed", async () => {
    const readingProgress = progress();
    const leftPdf = source("left-pdf", {
      title: "左侧 PDF",
      kind: "pdf",
      mime: "application/pdf",
      filename: "left.pdf",
      text: "",
      pageCount: 3,
      readPage: 1,
    });
    const rightPdf = source("right-pdf", {
      title: "右侧 PDF",
      kind: "pdf",
      mime: "application/pdf",
      filename: "right.pdf",
      text: "",
      pageCount: 3,
      readPage: 1,
    });
    await render({ leftSource: leftPdf, rightSource: rightPdf, readingProgress });

    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="左侧 PDF 下一页"]')!.click(),
    );

    expect(readingProgress.onChange).toHaveBeenCalledTimes(1);
    expect(readingProgress.onChange).toHaveBeenCalledWith(
      leftPdf,
      expect.objectContaining({
        readPage: 2,
        lastReadAt: "2026-09-13T12:00:00.000Z",
      }),
    );
  });

  it("does not write position or activity after a comparison version becomes historical", async () => {
    const readingProgress = progress(false);
    const leftPdf = source("left-pdf", {
      title: "左侧 PDF",
      kind: "pdf",
      mime: "application/pdf",
      filename: "left.pdf",
      text: "",
      pageCount: 3,
      readPage: 1,
    });
    await render({ leftSource: leftPdf, readingProgress });

    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="左侧 PDF 下一页"]')!.click(),
    );
    await scrollPane("right", 140);
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });

    expect(readingProgress.onChange).not.toHaveBeenCalled();
  });

  it("rechecks current-version status before a delayed scroll write", async () => {
    let current = true;
    const readingProgress = {
      isCurrentVersion: vi.fn(() => current),
      onChange: vi.fn(),
    };
    await render({ readingProgress });

    const container = host.querySelector<HTMLElement>(
      '[data-comparison-side="left"] .comparison-document-scroll',
    )!;
    Object.defineProperty(container, "scrollTop", { configurable: true, value: 160 });
    await act(async () => {
      container.dispatchEvent(new Event("scroll", { bubbles: true }));
      current = false;
      vi.advanceTimersByTime(400);
    });

    expect(readingProgress.onChange).not.toHaveBeenCalled();
  });

  it("shows a clear fallback for a retained PDF without original bytes", async () => {
    const unavailablePdf = source("missing-pdf", {
      title: "缺失原件的 PDF",
      kind: "pdf",
      mime: "application/pdf",
      text: "",
      originalMissing: true,
    });
    await render({ leftSource: unavailablePdf });

    expect(host.textContent).toContain("原始 PDF 不可用");
    expect(host.textContent).toContain("缺少原始文件");
    expect(host.querySelector('[data-pdf-preview="missing-pdf"]')).toBeNull();
  });

  it("renders the compact fallback instead of a double-column reader at 1024px and below", async () => {
    installMatchMedia(true);
    await render();

    expect(host.querySelector(".comparison-reader-body")).toBeNull();
    expect(host.querySelectorAll(".comparison-document-pane")).toHaveLength(0);
    expect(host.textContent).toContain("当前屏幕不支持并排对照");
    expect(host.querySelectorAll(".comparison-open-source")).toHaveLength(2);

    const sourceButtons = [...host.querySelectorAll<HTMLButtonElement>(".comparison-open-source")];
    await act(async () => sourceButtons[0].click());
    expect(props.onOpenSource).toHaveBeenCalledWith(
      props.leftSource.id,
      props.leftSource.versionId,
    );
  });

  it("offers the locked comparison question entry only in the wide reader", async () => {
    props = {
      ...props,
      ask: {
        conversations: [],
        onConversationChange: vi.fn(),
        onAsk: vi.fn(async () => ({
          content: "原文摘录",
          citations: [],
          mode: "extractive" as const,
        })),
      },
    };
    await render();

    expect(
      [...host.querySelectorAll<HTMLButtonElement>("button")].some((button) =>
        button.textContent?.includes("比较问 AI"),
      ),
    ).toBe(true);

    installMatchMedia(true);
    await render();
    expect(
      [...host.querySelectorAll<HTMLButtonElement>("button")].some((button) =>
        button.textContent?.includes("比较问 AI"),
      ),
    ).toBe(false);
  });

  it("opens the exact route-selected comparison thread in the ask panel", async () => {
    const saved: Conversation = {
      id: "route-selected-thread",
      spaceId: props.space.id,
      title: "URL 指向的对照记录",
      scope: "sources",
      sourceIds: [props.leftSource.id, props.rightSource.id],
      comparison: createComparisonConversationMetadata({
        leftSourceId: props.leftSource.id,
        leftVersionId: props.leftSource.versionId,
        rightSourceId: props.rightSource.id,
        rightVersionId: props.rightSource.versionId,
        spaceId: props.space.id,
      }),
      messages: [
        {
          id: "route-selected-answer",
          role: "assistant",
          content: "这里是 URL 指向的固定版本会话。",
          citations: [],
          createdAt: "2026-09-13T12:00:00.000Z",
        },
      ],
      resolved: false,
      updatedAt: "2026-09-13T12:00:00.000Z",
    };
    const ask = {
      conversations: [saved],
      onConversationChange: vi.fn(),
      onAsk: vi.fn(async () => ({
        content: "原文摘录",
        citations: [],
        mode: "extractive" as const,
      })),
    };
    await render({ ask });
    expect(host.querySelector(".comparison-ai-panel")).toBeNull();

    await render({ ask: { ...ask, initialConversationId: saved.id } });

    expect(host.querySelector(".comparison-ai-panel")).not.toBeNull();
    expect(host.textContent).toContain("这里是 URL 指向的固定版本会话。");
  });
});
