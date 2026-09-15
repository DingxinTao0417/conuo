// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import { createComparisonConversationMetadata } from "@/lib/comparison-conversation";
import type { AnswerResult, Conversation, Source, Space } from "@/lib/types";
import ComparisonAskPanel, {
  type ComparisonAskInput,
  type ComparisonAskPanelProps,
} from "./comparison-ai-panel";

function route(leftSource: Source, rightSource: Source, space: Space) {
  return {
    leftSourceId: leftSource.id,
    leftVersionId: leftSource.versionId,
    rightSourceId: rightSource.id,
    rightVersionId: rightSource.versionId,
    spaceId: space.id,
  };
}

function updateConversation(conversations: Conversation[], incoming: Conversation) {
  const index = conversations.findIndex((item) => item.id === incoming.id);
  return index === -1
    ? [incoming, ...conversations]
    : conversations.map((item) => (item.id === incoming.id ? incoming : item));
}

describe("ComparisonAskPanel", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: ComparisonAskPanelProps;
  let lastInput: ComparisonAskInput | undefined;
  let answer: AnswerResult;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(0), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const data = createDemoWorkspace();
    const [leftSource, rightSource] = data.sources;
    const space = data.spaces[0];
    answer = {
      mode: "model",
      content: "两份资料的重点不同，但都要求回到原文检查。 [1]",
      citations: [
        {
          sourceId: leftSource.id,
          versionId: leftSource.versionId,
          chunkId: leftSource.chunks[0].id,
          title: leftSource.title,
          quote: leftSource.chunks[0].text,
          section: leftSource.chunks[0].section,
          ...(leftSource.chunks[0].page ? { page: leftSource.chunks[0].page } : {}),
        },
      ],
    };
    lastInput = undefined;
    props = {
      leftSource,
      rightSource,
      space,
      conversations: [],
      onAsk: vi.fn(async (input: ComparisonAskInput) => {
        lastInput = input;
        return answer;
      }),
      onConversationChange: vi.fn((conversation) => {
        props = {
          ...props,
          conversations: updateConversation(props.conversations, conversation),
        };
        root.render(createElement(ComparisonAskPanel, props));
      }),
      onOpenSource: vi.fn(),
      onClose: vi.fn(),
    };
    await act(async () => root.render(createElement(ComparisonAskPanel, props)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function submit(question: string) {
    const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入比较问题"]')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      question,
    );
    await act(async () => input.dispatchEvent(new Event("input", { bubbles: true })));
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
  }

  it("exposes no mutable scope fields and persists a fixed two-source conversation", async () => {
    expect(host.textContent).toContain("已锁定 2 份资料");
    expect(host.textContent).toContain(props.leftSource.title);
    expect(host.textContent).toContain(props.rightSource.title);
    expect(host.querySelector("select")).toBeNull();
    expect(host.querySelector('input[type="checkbox"]')).toBeNull();

    await submit("两份资料的结论有什么不同？");

    expect(props.onAsk).toHaveBeenCalledOnce();
    expect(lastInput).toMatchObject({ question: "两份资料的结论有什么不同？" });
    expect(lastInput?.requestId).toEqual(expect.any(String));
    expect(lastInput).not.toHaveProperty("scope");
    expect(lastInput).not.toHaveProperty("sourceId");
    expect(lastInput).not.toHaveProperty("sourceIds");
    expect(lastInput).not.toHaveProperty("spaceId");
    expect(lastInput).not.toHaveProperty("selection");

    expect(props.conversations).toHaveLength(1);
    expect(props.conversations[0]).toMatchObject({
      spaceId: props.space.id,
      scope: "sources",
      sourceIds: [props.leftSource.id, props.rightSource.id],
      comparison: createComparisonConversationMetadata(
        route(props.leftSource, props.rightSource, props.space),
      ),
    });
    expect(props.conversations[0].sourceId).toBeUndefined();
    expect(props.conversations[0].messages).toMatchObject([
      { role: "user", content: "两份资料的结论有什么不同？" },
      { role: "assistant", content: answer.content, citations: answer.citations, mode: "model" },
    ]);
    expect(props.conversations[0].messages[1].attempt).toMatchObject({
      id: lastInput?.requestId,
      scopeSnapshot: {
        scope: "sources",
        sourceIds: [props.leftSource.id, props.rightSource.id],
        sourceVersions: [
          { sourceId: props.leftSource.id, versionId: props.leftSource.versionId },
          { sourceId: props.rightSource.id, versionId: props.rightSource.versionId },
        ],
        comparison: createComparisonConversationMetadata(
          route(props.leftSource, props.rightSource, props.space),
        ),
        spaceId: props.space.id,
      },
      status: "completed",
    });
  });

  it("opens citations only at their exact source version", async () => {
    await submit("两份资料有什么不同？");
    const open = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("打开对应原文"),
    );
    expect(open).toBeTruthy();
    await act(async () => open!.click());
    expect(props.onOpenSource).toHaveBeenCalledWith(
      answer.citations[0].sourceId,
      answer.citations[0].versionId,
      answer.citations[0],
    );
  });

  it("does not open a persisted citation outside the two fixed versions", async () => {
    const currentRoute = route(props.leftSource, props.rightSource, props.space);
    props = {
      ...props,
      conversations: [
        {
          id: "stale-citation-thread",
          spaceId: props.space.id,
          title: "旧版本引用",
          scope: "sources",
          sourceIds: [props.leftSource.id, props.rightSource.id],
          comparison: createComparisonConversationMetadata(currentRoute),
          messages: [
            {
              id: "stale-answer",
              role: "assistant",
              content: "这是历史中的错误引用。",
              citations: [{ ...answer.citations[0], versionId: "old-version" }],
              mode: "model",
              createdAt: "2026-09-13T12:00:00.000Z",
            },
          ],
          resolved: false,
          updatedAt: "2026-09-13T12:00:00.000Z",
        },
      ],
    };
    await act(async () => root.render(createElement(ComparisonAskPanel, props)));

    expect(host.textContent).toContain("不属于当前对照的固定资料版本");
    expect(
      [...host.querySelectorAll<HTMLButtonElement>("button")].some((button) =>
        button.textContent?.includes("打开对应原文"),
      ),
    ).toBe(false);
    expect(props.onOpenSource).not.toHaveBeenCalled();
  });

  it("keeps a failed attempt and does not turn it into a trusted answer", async () => {
    props = {
      ...props,
      onAsk: vi.fn(async () => {
        throw new Error("回答连接中断，请重新编辑问题后再试。");
      }),
    };
    await act(async () => root.render(createElement(ComparisonAskPanel, props)));

    await submit("为什么两份资料的建议不同？");

    expect(props.conversations).toHaveLength(1);
    expect(props.conversations[0].messages).toHaveLength(2);
    expect(props.conversations[0].messages[1]).toMatchObject({
      role: "assistant",
      content: "",
      citations: [],
      error: "回答连接中断，请重新编辑问题后再试。",
      attempt: { status: "failed" },
    });
    expect(host.textContent).toContain("本次未完成");
  });

  it("keeps comparison history isolated to the exact fixed pair and disables unavailable scopes", async () => {
    const currentRoute = route(props.leftSource, props.rightSource, props.space);
    const matching: Conversation = {
      id: "matching-thread",
      spaceId: props.space.id,
      title: "匹配的对照记录",
      scope: "sources",
      sourceIds: [props.leftSource.id, props.rightSource.id],
      comparison: createComparisonConversationMetadata(currentRoute),
      messages: [],
      resolved: false,
      updatedAt: "2026-09-13T12:00:00.000Z",
    };
    const unrelated: Conversation = {
      ...matching,
      id: "unrelated-thread",
      title: "不应显示的旧版本记录",
      comparison: createComparisonConversationMetadata({
        ...currentRoute,
        rightVersionId: "older-version",
      }),
    };
    props = {
      ...props,
      conversations: [matching, unrelated],
      unavailableReason: "对照阅读可查看历史版本，但 AI 问答只能使用两份当前版本。",
    };
    await act(async () => root.render(createElement(ComparisonAskPanel, props)));

    const history = host.querySelector<HTMLButtonElement>('[aria-label="对话历史"]')!;
    await act(async () => history.click());
    expect(host.textContent).toContain("匹配的对照记录");
    expect(host.textContent).not.toContain("不应显示的旧版本记录");
    expect(
      host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入比较问题"]')!.disabled,
    ).toBe(true);
    expect(props.onAsk).not.toHaveBeenCalled();
  });

  it("opens the exact route-selected fixed-pair thread instead of the newest history item", async () => {
    const currentRoute = route(props.leftSource, props.rightSource, props.space);
    const newest: Conversation = {
      id: "newest-thread",
      spaceId: props.space.id,
      title: "较新的对照问题",
      scope: "sources",
      sourceIds: [props.leftSource.id, props.rightSource.id],
      comparison: createComparisonConversationMetadata(currentRoute),
      messages: [
        {
          id: "newest-answer",
          role: "assistant",
          content: "不应替代目标会话的较新回答。",
          citations: [],
          createdAt: "2026-09-13T13:00:00.000Z",
        },
      ],
      resolved: false,
      updatedAt: "2026-09-13T13:00:00.000Z",
    };
    const target: Conversation = {
      ...newest,
      id: "target-thread",
      title: "URL 指向的对照问题",
      messages: [
        {
          id: "target-answer",
          role: "assistant",
          content: "这是 URL 指向的准确对照记录。",
          citations: [],
          createdAt: "2026-09-13T12:00:00.000Z",
        },
      ],
      updatedAt: "2026-09-13T12:00:00.000Z",
    };
    props = {
      ...props,
      conversations: [newest, target],
      initialConversationId: target.id,
    };
    await act(async () => root.render(createElement(ComparisonAskPanel, props)));

    expect(host.textContent).toContain("这是 URL 指向的准确对照记录。");
    expect(host.textContent).not.toContain("不应替代目标会话的较新回答。");
  });
});
