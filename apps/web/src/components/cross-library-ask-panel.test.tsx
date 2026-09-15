// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CrossLibraryAskPanel, { type CrossLibraryAskPanelProps } from "./cross-library-ask-panel";
import { createDemoWorkspace } from "@/lib/seed";
import type { Source, WorkspaceData } from "@/lib/types";

function rewriteIdentity(source: Source, id: string, versionId: string, spaceId: string): Source {
  return {
    ...structuredClone(source),
    id,
    versionId,
    spaceIds: [spaceId],
    chunks: source.chunks.map((chunk, index) => ({
      ...chunk,
      id: `${id}-chunk-${index}`,
      sourceId: id,
      versionId,
    })),
  };
}

function fixture(): WorkspaceData {
  const data = createDemoWorkspace();
  const firstSpace = { ...data.spaces[0]!, id: "space-one", name: "机器学习资料" };
  const secondSpace = { ...firstSpace, id: "space-two", name: "学习方法资料" };
  const first = rewriteIdentity(data.sources[0]!, "source-one", "version-one", firstSpace.id);
  const second = rewriteIdentity(data.sources[1]!, "source-two", "version-two", secondSpace.id);
  const disabled = {
    ...rewriteIdentity(data.sources[1]!, "source-disabled", "version-disabled", firstSpace.id),
    title: "禁止 AI 的资料",
    aiAllowed: false,
  };
  return {
    ...data,
    spaces: [firstSpace, secondSpace],
    sources: [first, second, disabled],
  };
}

function setText(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("CrossLibraryAskPanel", () => {
  let host: HTMLDivElement;
  let root: Root;
  let data: WorkspaceData;
  let onAsk: ReturnType<typeof vi.fn<CrossLibraryAskPanelProps["onAsk"]>>;
  let onConversationChange: ReturnType<
    typeof vi.fn<CrossLibraryAskPanelProps["onConversationChange"]>
  >;
  let onActiveConversationChange: ReturnType<
    typeof vi.fn<CrossLibraryAskPanelProps["onActiveConversationChange"]>
  >;
  let onOpenSource: ReturnType<typeof vi.fn<CrossLibraryAskPanelProps["onOpenSource"]>>;
  let onClose: ReturnType<typeof vi.fn<CrossLibraryAskPanelProps["onClose"]>>;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    data = fixture();
    onAsk = vi.fn<CrossLibraryAskPanelProps["onAsk"]>(async () => ({
      content: "已基于固定资料回答。",
      citations: [],
      mode: "extractive",
    }));
    onConversationChange = vi.fn<CrossLibraryAskPanelProps["onConversationChange"]>();
    onActiveConversationChange = vi.fn<CrossLibraryAskPanelProps["onActiveConversationChange"]>();
    onOpenSource = vi.fn<CrossLibraryAskPanelProps["onOpenSource"]>();
    onClose = vi.fn<CrossLibraryAskPanelProps["onClose"]>();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(
    initialConversationId?: string,
    onInvalidInitialConversation?: () => void,
    initialDraft?: Pick<CrossLibraryAskPanelProps, "initialQuestion" | "initialSourceIds">,
    onBusyChange?: CrossLibraryAskPanelProps["onBusyChange"],
    panelKey?: string,
  ) {
    await act(async () => {
      root.render(
        createElement(CrossLibraryAskPanel, {
          ...(panelKey ? { key: panelKey } : {}),
          data,
          ...(initialConversationId ? { initialConversationId } : {}),
          ...(onInvalidInitialConversation ? { onInvalidInitialConversation } : {}),
          ...(onBusyChange ? { onBusyChange } : {}),
          ...initialDraft,
          onAsk,
          onConversationChange,
          onActiveConversationChange,
          onOpenSource,
          onClose,
        }),
      );
    });
  }

  it("shows every source with its space, version, status and an explicit unavailable reason", async () => {
    await render();

    expect(host.textContent).toContain("机器学习资料");
    expect(host.textContent).toContain("学习方法资料");
    expect(host.textContent).toContain("版本 version-one");
    expect(host.textContent).toContain("可检索");
    expect(host.textContent).toContain("此资料已禁止 AI 使用");
    expect(
      host.querySelector<HTMLInputElement>('[aria-label="选择跨库资料 禁止 AI 的资料"]')?.disabled,
    ).toBe(true);
  });

  it("prefills a new question once with only unique eligible sources and never sends automatically", async () => {
    await render(undefined, undefined, {
      initialQuestion: "这些资料如何解释学习率？",
      initialSourceIds: [
        "source-two",
        "source-disabled",
        "missing-source",
        "source-two",
        "source-one",
      ],
    });

    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="输入跨库问题"]')?.value).toBe(
      "这些资料如何解释学习率？",
    );
    expect(
      host.querySelector<HTMLInputElement>(
        '[aria-label="选择跨库资料 梯度下降与学习率 · 示例资料"]',
      )?.checked,
    ).toBe(true);
    expect(
      host.querySelector<HTMLInputElement>(
        '[aria-label="选择跨库资料 用自我解释检查理解 · 示例资料"]',
      )?.checked,
    ).toBe(true);
    expect(
      host.querySelector<HTMLInputElement>('[aria-label="选择跨库资料 禁止 AI 的资料"]')?.checked,
    ).toBe(false);
    expect(host.textContent).toContain("已选择 2 / 5 份资料。");
    expect(onAsk).not.toHaveBeenCalled();
    expect(onConversationChange).not.toHaveBeenCalled();

    await act(async () => {
      setText(
        host.querySelector<HTMLTextAreaElement>('[aria-label="输入跨库问题"]')!,
        "我修改后的问题",
      );
    });
    await render(undefined, undefined, {
      initialQuestion: "不应覆盖本地草稿",
      initialSourceIds: ["source-one"],
    });
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="输入跨库问题"]')?.value).toBe(
      "我修改后的问题",
    );
    expect(host.textContent).toContain("已选择 2 / 5 份资料。");
    expect(onAsk).not.toHaveBeenCalled();
  });

  it("requires an explicit bounded selection and sends the exact selected version range", async () => {
    await render();
    const first = host.querySelector<HTMLInputElement>(
      '[aria-label="选择跨库资料 梯度下降与学习率 · 示例资料"]',
    );
    const second = host.querySelector<HTMLInputElement>(
      '[aria-label="选择跨库资料 用自我解释检查理解 · 示例资料"]',
    );
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();

    await act(async () => {
      first!.click();
      second!.click();
    });
    const send = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("发送"),
    );
    expect(send?.disabled).toBe(true);

    await act(async () => {
      setText(
        host.querySelector<HTMLTextAreaElement>('[aria-label="输入跨库问题"]')!,
        "两份资料有哪些共同点？",
      );
    });
    expect(send?.disabled).toBe(false);
    await act(async () => {
      send!.click();
      await Promise.resolve();
    });

    expect(onAsk).toHaveBeenCalledOnce();
    expect(onAsk.mock.calls[0]?.[0]).toMatchObject({
      scope: "cross-library-sources",
      spaceId: "all",
      sourceIds: ["source-one", "source-two"],
      sourceVersions: [
        { sourceId: "source-one", versionId: "version-one" },
        { sourceId: "source-two", versionId: "version-two" },
      ],
    });
    const saved = onConversationChange.mock.calls.at(-1)?.[0];
    expect(saved).toBeTruthy();
    expect(saved!.messages.at(-1)?.attempt?.scopeSnapshot).toMatchObject({
      scope: "cross-library-sources",
      spaceId: "all",
      sourceIds: ["source-one", "source-two"],
      sourceVersions: [
        { sourceId: "source-one", versionId: "version-one" },
        { sourceId: "source-two", versionId: "version-two" },
      ],
    });
    expect(onActiveConversationChange).toHaveBeenCalledWith(saved!.id);
  });

  it("reports an in-flight answer without aborting its signal before completion", async () => {
    let finish:
      ((answer: { content: string; citations: []; mode: "extractive" }) => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    onAsk = vi.fn<CrossLibraryAskPanelProps["onAsk"]>(
      (_request, signal) =>
        new Promise((resolve) => {
          observedSignal = signal;
          finish = resolve;
        }),
    );
    const onBusyChange = vi.fn<NonNullable<CrossLibraryAskPanelProps["onBusyChange"]>>();
    await render(
      undefined,
      undefined,
      {
        initialQuestion: "学习率为什么需要调整？",
        initialSourceIds: ["source-one"],
      },
      onBusyChange,
    );

    const send = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("发送"),
    );
    expect(send).toBeTruthy();
    await act(async () => {
      send!.click();
      await Promise.resolve();
    });

    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    expect(observedSignal?.aborted).toBe(false);

    await act(async () => {
      finish?.({ content: "回答完成。", citations: [], mode: "extractive" });
      await Promise.resolve();
    });
    expect(observedSignal?.aborted).toBe(false);
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("ignores an old panel result after unmount instead of clearing a newer panel's busy state", async () => {
    type DeferredAnswer = { content: string; citations: []; mode: "extractive" };
    const finishers: Array<(answer: DeferredAnswer) => void> = [];
    const signals: AbortSignal[] = [];
    onAsk = vi.fn<CrossLibraryAskPanelProps["onAsk"]>(
      (_request, signal) =>
        new Promise((resolve) => {
          signals.push(signal);
          finishers.push(resolve);
        }),
    );
    let containingBusy = false;
    const onBusyChange = vi.fn<NonNullable<CrossLibraryAskPanelProps["onBusyChange"]>>((busy) => {
      containingBusy = busy;
    });

    await render(
      undefined,
      undefined,
      { initialQuestion: "面板 A", initialSourceIds: ["source-one"] },
      onBusyChange,
      "panel-a",
    );
    let send = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("发送"),
    );
    await act(async () => {
      send!.click();
      await Promise.resolve();
    });
    expect(containingBusy).toBe(true);

    await render(
      undefined,
      undefined,
      { initialQuestion: "面板 B", initialSourceIds: ["source-two"] },
      onBusyChange,
      "panel-b",
    );
    expect(signals[0]?.aborted).toBe(true);
    expect(containingBusy).toBe(false);

    send = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("发送"),
    );
    await act(async () => {
      send!.click();
      await Promise.resolve();
    });
    expect(containingBusy).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    await act(async () => {
      finishers[0]?.({ content: "迟到的 A 回答", citations: [], mode: "extractive" });
      await Promise.resolve();
    });
    const stoppedAttempt = onConversationChange.mock.calls
      .map(([conversation]) => conversation)
      .flatMap((conversation) => conversation.messages)
      .find((message) => message.attempt?.status === "stopped");
    expect(stoppedAttempt?.attempt?.scopeSnapshot).toMatchObject({
      scope: "cross-library-sources",
      sourceIds: ["source-one"],
      sourceVersions: [{ sourceId: "source-one", versionId: "version-one" }],
    });
    expect(containingBusy).toBe(true);

    await act(async () => {
      finishers[1]?.({ content: "B 回答", citations: [], mode: "extractive" });
      await Promise.resolve();
    });
    expect(containingBusy).toBe(false);
  });

  it("reports active, new and history thread changes so the parent can keep the URL in sync", async () => {
    const saved = {
      id: "cross-history-thread",
      spaceId: "all" as const,
      title: "保存的跨库问题",
      scope: "cross-library-sources" as const,
      sourceIds: ["source-one"],
      messages: [
        {
          id: "saved-answer",
          role: "assistant" as const,
          content: "历史回答。",
          citations: [],
          createdAt: "2026-09-13T12:00:00.000Z",
          attempt: {
            id: "saved-attempt",
            questionMessageId: "saved-question",
            status: "completed" as const,
            scopeSnapshot: {
              scope: "cross-library-sources" as const,
              spaceId: "all" as const,
              sourceIds: ["source-one"],
              sourceVersions: [{ sourceId: "source-one", versionId: "version-one" }],
            },
          },
        },
      ],
      resolved: false,
      updatedAt: "2026-09-13T12:00:00.000Z",
    };
    data = { ...data, conversations: [saved] };
    await render(saved.id, undefined, {
      initialQuestion: "不应覆盖已有会话",
      initialSourceIds: ["source-two"],
    });

    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="输入跨库问题"]')?.value).toBe("");
    expect(
      host.querySelector<HTMLInputElement>(
        '[aria-label="选择跨库资料 梯度下降与学习率 · 示例资料"]',
      )?.checked,
    ).toBe(true);
    expect(
      host.querySelector<HTMLInputElement>(
        '[aria-label="选择跨库资料 用自我解释检查理解 · 示例资料"]',
      )?.checked,
    ).toBe(false);

    const newButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("新建"),
    );
    expect(newButton).toBeTruthy();
    await act(async () => newButton!.click());
    expect(onActiveConversationChange).toHaveBeenLastCalledWith();
    expect(host.textContent).toContain("已选择 0 / 5 份资料。");

    const history = host.querySelector<HTMLButtonElement>('[aria-label="跨库问答历史"]');
    expect(history).toBeTruthy();
    await act(async () => history!.click());
    const historyThread = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes(saved.title),
    );
    expect(historyThread).toBeTruthy();
    await act(async () => historyThread!.click());
    expect(onActiveConversationChange).toHaveBeenLastCalledWith(saved.id);

    // Browser back/forward changes the prop without remounting the panel.
    await render();
    expect(host.textContent).toContain("已选择 0 / 5 份资料。");
  });

  it("reports and clears a forged or non-cross-library initial conversation instead of treating it as a new history thread", async () => {
    const onInvalidInitialConversation = vi.fn();
    await render("forged-thread", onInvalidInitialConversation);
    await act(async () => {
      await Promise.resolve();
    });

    expect(onInvalidInitialConversation).toHaveBeenCalledOnce();
    expect(onAsk).not.toHaveBeenCalled();
  });

  it("offers question search as a way to fill the range, and only while it is still editable", async () => {
    const onFindSourcesByQuestion = vi.fn();
    const renderWithFinder = async (initialConversationId?: string) => {
      await act(async () => {
        root.render(
          createElement(CrossLibraryAskPanel, {
            key: initialConversationId ?? "new",
            data,
            ...(initialConversationId ? { initialConversationId } : {}),
            onAsk,
            onConversationChange,
            onActiveConversationChange,
            onOpenSource,
            onFindSourcesByQuestion,
            onClose,
          }),
        );
      });
    };
    const finder = () =>
      [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "用问题找资料",
      );

    await renderWithFinder();
    expect(finder()).toBeTruthy();
    await act(async () => finder()!.click());
    // It only switches the library list into question mode; it never asks.
    expect(onFindSourcesByQuestion).toHaveBeenCalledOnce();
    expect(onAsk).not.toHaveBeenCalled();

    const saved = {
      id: "locked-thread",
      spaceId: "all" as const,
      title: "已锁定范围的会话",
      scope: "cross-library-sources" as const,
      sourceIds: ["source-one"],
      messages: [],
      resolved: false,
      updatedAt: "2026-09-13T12:00:00.000Z",
    };
    data = { ...data, conversations: [saved] };
    await renderWithFinder(saved.id);
    // A saved thread's range is frozen, so there is nothing left to refill.
    expect(finder()).toBeUndefined();
    expect(
      host.querySelector<HTMLInputElement>(
        '[aria-label="选择跨库资料 梯度下降与学习率 · 示例资料"]',
      )?.disabled,
    ).toBe(true);
  });
});
