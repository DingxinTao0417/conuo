// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Reader, { type ReaderProps } from "./reader";
import { createDemoWorkspace } from "@/lib/seed";
import type { Conversation, Source } from "@/lib/types";

vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./pdf-reader", () => ({ default: () => null }));
vi.mock("./web-version-panel", () => ({ default: () => null }));

describe("reader reading activity", () => {
  let host: HTMLDivElement;
  let root: Root;
  let source: Source;
  let props: ReaderProps;
  let scrollDescriptor: PropertyDescriptor | undefined;
  let showModalDescriptor: PropertyDescriptor | undefined;
  let closeDialogDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00.000Z"));
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
    showModalDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
    closeDialogDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
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
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const data = createDemoWorkspace();
    source = { ...data.sources[0], kind: "markdown", aiAllowed: true };
    props = {
      source,
      sources: [source],
      space: data.spaces[0],
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
    if (showModalDescriptor)
      Object.defineProperty(HTMLDialogElement.prototype, "showModal", showModalDescriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    if (closeDialogDescriptor)
      Object.defineProperty(HTMLDialogElement.prototype, "close", closeDialogDescriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function render(overrides: Partial<ReaderProps> = {}) {
    props = { ...props, ...overrides };
    await act(async () => root.render(createElement(Reader, props)));
  }

  async function scrollTo(offset: number) {
    const container = host.querySelector<HTMLElement>(".reader-document-scroll")!;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      writable: true,
      value: offset,
    });
    await act(async () => {
      container.dispatchEvent(new Event("scroll", { bubbles: true }));
      vi.advanceTimersByTime(400);
    });
  }

  it("records actual text reading separately from metadata and rate-limits workspace writes", async () => {
    await scrollTo(120);
    expect(props.onSourceChange).toHaveBeenLastCalledWith({
      readOffset: 120,
      // The reader records after its 400 ms scroll settle window, rather than
      // treating the DOM event itself as a completed reading action.
      lastReadAt: "2026-09-12T12:00:00.400Z",
    });

    vi.setSystemTime(new Date("2026-09-12T12:00:05.000Z"));
    await scrollTo(260);
    expect(props.onSourceChange).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(props.onSourceChange).toHaveBeenLastCalledWith({
      readOffset: 260,
      lastReadAt: "2026-09-12T12:00:15.400Z",
    });
  });

  it("drops pending text progress and restores the resolved offset when its revision advances", async () => {
    await render({ readingPositionRevision: 0 });
    await scrollTo(120);
    expect(props.onSourceChange).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-09-12T12:00:05.000Z"));
    await scrollTo(260);
    expect(props.onSourceChange).toHaveBeenCalledTimes(1);

    const resolved = { ...source, readOffset: 40 };
    await render({
      source: resolved,
      sources: [resolved],
      readingPositionRevision: 1,
    });

    expect(host.querySelector<HTMLElement>(".reader-document-scroll")!.scrollTop).toBe(40);
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(props.onSourceChange).toHaveBeenCalledTimes(1);
  });

  it("reports unsettled scroll intent before the debounce without increasing workspace writes", async () => {
    const pending = vi.fn();
    await render({ onPendingReadingChange: pending });
    const container = host.querySelector<HTMLElement>(".reader-document-scroll")!;
    container.scrollTop = 120;
    await act(async () => container.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(pending).toHaveBeenLastCalledWith(true);
    expect(props.onSourceChange).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(400));
    expect(props.onSourceChange).toHaveBeenCalledOnce();
    expect(pending).toHaveBeenLastCalledWith(false);
  });

  it("keeps throttled reading intent until saved and releases it when returning to the saved position", async () => {
    const pending = vi.fn();
    await render({ onPendingReadingChange: pending });
    await scrollTo(120);
    const saved = { ...source, readOffset: 120, lastReadAt: "2026-09-12T12:00:00.400Z" };
    await render({ source: saved, sources: [saved] });
    vi.setSystemTime(new Date("2026-09-12T12:00:05.000Z"));
    await scrollTo(260);
    expect(pending).toHaveBeenLastCalledWith(true);
    expect(props.onSourceChange).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(pending).toHaveBeenLastCalledWith(false);
    expect(props.onSourceChange).toHaveBeenCalledTimes(2);
    await render({
      source: { ...saved, readOffset: 260 },
      sources: [{ ...saved, readOffset: 260 }],
    });
    const container = host.querySelector<HTMLElement>(".reader-document-scroll")!;
    container.scrollTop = 400;
    await act(async () => container.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(pending).toHaveBeenLastCalledWith(true);
    container.scrollTop = 260;
    await act(async () => container.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(pending).toHaveBeenLastCalledWith(false);
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(props.onSourceChange).toHaveBeenCalledTimes(2);
  });

  it("preserves pending offsets across timestamp-only updates and respects the updated throttle", async () => {
    const pending = vi.fn();
    await render({ onPendingReadingChange: pending });
    await scrollTo(120);
    const saved = { ...source, readOffset: 120, lastReadAt: "2026-09-12T12:00:00.400Z" };
    await render({ source: saved, sources: [saved] });
    vi.setSystemTime(new Date("2026-09-12T12:00:05.000Z"));
    await scrollTo(260);
    await act(async () => vi.advanceTimersByTime(2_600));
    const activity = { ...saved, lastReadAt: "2026-09-12T12:00:08.000Z" };
    await render({ source: activity, sources: [activity] });
    expect(pending).toHaveBeenLastCalledWith(true);
    await act(async () => vi.advanceTimersByTime(7_400));
    expect(props.onSourceChange).toHaveBeenCalledOnce();
    expect(pending).toHaveBeenLastCalledWith(true);
    await act(async () => vi.advanceTimersByTime(7_600));
    expect(props.onSourceChange).toHaveBeenLastCalledWith({
      readOffset: 260,
      lastReadAt: "2026-09-12T12:00:23.000Z",
    });
    expect(pending).toHaveBeenLastCalledWith(false);
  });

  it("recognizes the last reported offset even before parent props catch up", async () => {
    const pending = vi.fn();
    await render({ onPendingReadingChange: pending });
    await scrollTo(120);
    vi.setSystemTime(new Date("2026-09-12T12:00:05.000Z"));
    await scrollTo(260);
    expect(pending).toHaveBeenLastCalledWith(true);
    const container = host.querySelector<HTMLElement>(".reader-document-scroll")!;
    container.scrollTop = 120;
    await act(async () => container.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(pending).toHaveBeenLastCalledWith(false);
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(props.onSourceChange).toHaveBeenCalledOnce();
  });

  it("releases pending progress when the currently viewed version becomes historical", async () => {
    const pending = vi.fn();
    await render({ onPendingReadingChange: pending });
    const container = host.querySelector<HTMLElement>(".reader-document-scroll")!;
    container.scrollTop = 120;
    await act(async () => container.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(pending).toHaveBeenLastCalledWith(true);
    await render({ currentSource: { ...source, versionId: "next-version" } });
    expect(pending).toHaveBeenLastCalledWith(false);
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(props.onSourceChange).not.toHaveBeenCalled();
  });

  it("shows the resolved PDF page when its revision advances", async () => {
    const pdf = {
      ...source,
      kind: "pdf" as const,
      mime: "application/pdf",
      pageCount: 6,
      readPage: 1,
    };
    await render({ source: pdf, sources: [pdf], readingPositionRevision: 0 });
    expect(host.querySelector<HTMLInputElement>('[aria-label="跳转页码"]')?.value).toBe("1");

    const resolved = { ...pdf, readPage: 4 };
    await render({
      source: resolved,
      sources: [resolved],
      readingPositionRevision: 1,
    });
    expect(host.querySelector<HTMLInputElement>('[aria-label="跳转页码"]')?.value).toBe("4");
  });

  it("shows retained positions and switches text progress without flushing an old pending scroll", async () => {
    await act(async () => vi.advanceTimersByTime(1_500));
    vi.mocked(props.onSourceChange).mockClear();
    const retained: Source = {
      ...source,
      readPage: undefined,
      readOffset: 120,
      lastReadAt: "2026-09-12T11:00:00.000Z",
      readingPositionAlternatives: [
        {
          origin: "remote",
          readOffset: 640,
          lastReadAt: "2026-09-12T10:00:00.000Z",
        },
        {
          origin: "local",
          readOffset: 900,
          lastReadAt: "2026-09-12T09:00:00.000Z",
        },
      ],
    };
    await render({ source: retained, sources: [retained] });

    const container = host.querySelector<HTMLElement>(".reader-document-scroll")!;
    container.scrollTop = 280;
    await act(async () => container.dispatchEvent(new Event("scroll", { bubbles: true })));

    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="更多资料操作"]')!.click(),
    );
    const entry = host.querySelector<HTMLButtonElement>('[aria-label="已保留阅读位置"]');
    expect(entry?.textContent).toContain("2");
    await act(async () => entry!.click());

    const dialog = host.querySelector<HTMLDialogElement>("dialog");
    expect(dialog?.open).toBe(true);
    expect(dialog?.textContent).toContain("当前使用");
    expect(dialog?.textContent).toContain("云端位置");
    expect(dialog?.textContent).toContain("本机位置");
    expect(dialog?.textContent).toContain("页码：未记录 · 正文偏移：120 像素");

    await act(async () =>
      dialog
        ?.querySelector<HTMLButtonElement>('[aria-label="切换到云端位置：正文偏移 640 像素"]')
        ?.click(),
    );

    expect(props.onSourceChange).toHaveBeenCalledTimes(1);
    expect(props.onSourceChange).toHaveBeenCalledWith({
      readPage: undefined,
      readOffset: 640,
      lastReadAt: "2026-09-12T10:00:00.000Z",
      readingPositionAlternatives: [
        {
          origin: "previous",
          readOffset: 120,
          lastReadAt: "2026-09-12T11:00:00.000Z",
        },
        {
          origin: "local",
          readOffset: 900,
          lastReadAt: "2026-09-12T09:00:00.000Z",
        },
      ],
    });
    expect(container.scrollTop).toBe(640);
    expect(host.querySelector("dialog")).toBeNull();

    await act(async () => vi.advanceTimersByTime(20_000));
    expect(props.onSourceChange).toHaveBeenCalledTimes(1);
  });

  it("applies a retained PDF page immediately", async () => {
    const retained: Source = {
      ...source,
      kind: "pdf",
      mime: "application/pdf",
      pageCount: 6,
      readPage: 1,
      readOffset: undefined,
      lastReadAt: "2026-09-12T11:00:00.000Z",
      readingPositionAlternatives: [
        { origin: "previous", readPage: 4, lastReadAt: "2026-09-12T10:00:00.000Z" },
      ],
    };
    await render({ source: retained, sources: [retained] });
    vi.mocked(props.onSourceChange).mockClear();

    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="更多资料操作"]')!.click(),
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="已保留阅读位置"]')!.click(),
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="切换到先前选择：第 4 页"]')!.click(),
    );

    expect(host.querySelector<HTMLInputElement>('[aria-label="跳转页码"]')?.value).toBe("4");
    expect(props.onSourceChange).toHaveBeenCalledOnce();
    expect(props.onSourceChange).toHaveBeenCalledWith({
      readPage: 4,
      readOffset: undefined,
      lastReadAt: "2026-09-12T10:00:00.000Z",
      readingPositionAlternatives: [
        {
          origin: "previous",
          readPage: 1,
          lastReadAt: "2026-09-12T11:00:00.000Z",
        },
      ],
    });
  });

  it("records a short document after it remains visibly open", async () => {
    await act(async () => {
      vi.advanceTimersByTime(1_500);
    });
    expect(props.onSourceChange).toHaveBeenLastCalledWith({
      lastReadAt: "2026-09-12T12:00:01.500Z",
    });
  });

  it("does not let a future device clock suppress local reading activity", async () => {
    const future = { ...source, lastReadAt: "2026-09-12T13:00:00.000Z" };
    await render({ source: future, sources: [future] });
    await scrollTo(120);
    expect(props.onSourceChange).toHaveBeenLastCalledWith({
      readOffset: 120,
      // Preserve the already-saved future timestamp rather than writing it
      // backward, while still persisting the local offset immediately.
      lastReadAt: "2026-09-12T13:00:00.000Z",
    });
  });

  it("does not turn an old retained version into a new reading activity", async () => {
    const historical = { ...source, versionId: "old-version" };
    await render({ source: historical, currentSource: source });
    await scrollTo(120);
    expect(props.onSourceChange).not.toHaveBeenCalled();
  });

  it("opens the exact queued question instead of substituting the newest thread", async () => {
    const newest: Conversation = {
      id: "newest-thread",
      spaceId: props.space.id,
      sourceId: source.id,
      title: "较新的问题",
      scope: "document",
      sourceIds: [source.id],
      messages: [
        {
          id: "newest-answer",
          role: "assistant",
          content: "这是默认会显示的较新回答。",
          citations: [],
          createdAt: "2026-09-12T11:00:00.000Z",
        },
      ],
      resolved: false,
      updatedAt: "2026-09-12T11:00:00.000Z",
    };
    const target: Conversation = {
      ...newest,
      id: "target-thread",
      // A deleted learning space rehomes its historical thread to Inbox while
      // a shared source can still belong to the current space.
      spaceId: "inbox",
      title: "队列中点开的问题",
      messages: [
        {
          id: "target-answer",
          role: "assistant",
          content: "这是用户点开的准确问答记录。",
          citations: [],
          createdAt: "2026-09-12T10:00:00.000Z",
        },
      ],
      updatedAt: "2026-09-12T10:00:00.000Z",
    };

    await render({ conversations: [newest, target], initialConversationId: target.id });

    expect(host.textContent).toContain("这是用户点开的准确问答记录。");
    expect(host.textContent).not.toContain("这是默认会显示的较新回答。");
  });

  it("restores the queued thread's saved scope and selected sources before a follow-up", async () => {
    const peer: Source = {
      ...source,
      id: "peer-source",
      versionId: "peer-version",
      title: "另一份已选资料",
    };
    const target: Conversation = {
      id: "two-source-thread",
      spaceId: props.space.id,
      sourceId: source.id,
      title: "需要保留资料范围的问题",
      scope: "sources",
      sourceIds: [source.id, peer.id],
      messages: [
        {
          id: "saved-question",
          role: "user",
          content: "先前的双资料问题",
          citations: [],
          createdAt: "2026-09-12T10:00:00.000Z",
        },
      ],
      resolved: false,
      updatedAt: "2026-09-12T10:00:00.000Z",
    };
    await render({
      sources: [source, peer],
      conversations: [target],
      initialConversationId: target.id,
    });

    expect(host.querySelector<HTMLSelectElement>(".reader-scope select")?.value).toBe("sources");
    expect(
      [...host.querySelectorAll<HTMLInputElement>(".reader-source-picker input")]
        .filter((input) => input.checked)
        .map((input) => input.nextElementSibling?.textContent),
    ).toHaveLength(2);

    const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="向资料提问"]')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      "继续比较两份资料",
    );
    await act(async () => input.dispatchEvent(new Event("input", { bubbles: true })));
    await act(async () =>
      host
        .querySelector(".reader-composer")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );

    expect(props.onAsk).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "sources",
        sourceIds: [source.id, peer.id],
      }),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(props.onConversationChange).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "sources", sourceIds: [source.id, peer.id] }),
    );
  });
});
