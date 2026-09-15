// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Reader, { type ReaderProps } from "./reader";
import { createDemoWorkspace } from "@/lib/seed";
import type { AnswerRequest, AnswerResult, Conversation, Message } from "@/lib/types";
import type { OnAnswerProgress } from "@/lib/answer-stream-types";

vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./pdf-reader", () => ({ default: () => null }));
vi.mock("./web-version-panel", () => ({ default: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type AnswerRequestWithUserContext = AnswerRequest & { userContext?: string[] };

function message(id: string, role: Message["role"], content: string): Message {
  return {
    id,
    role,
    content,
    citations: [],
    createdAt: "2026-09-13T00:00:00.000Z",
  };
}

describe("reader answer stream remains a transient preview until completion", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: ReaderProps;
  let result: ReturnType<typeof deferred<AnswerResult>>;
  let progress: OnAnswerProgress;
  let signal: AbortSignal;
  let draft: AnswerResult;
  let lastRequest: AnswerRequestWithUserContext | undefined;
  let scrollDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(0), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const data = createDemoWorkspace();
    const source = { ...data.sources[0], kind: "markdown" as const, aiAllowed: true };
    result = deferred<AnswerResult>();
    lastRequest = undefined;
    draft = {
      mode: "model",
      content: "已核对出处的首段。 [1]",
      citations: [
        {
          sourceId: source.id,
          versionId: source.versionId,
          chunkId: source.chunks[0].id,
          title: source.title,
          quote: source.chunks[0].text,
          section: source.chunks[0].section,
        },
      ],
    };
    props = {
      source,
      sources: [source],
      space: data.spaces[0],
      conversations: [],
      annotations: [],
      aiEnabled: true,
      onSourceChange: vi.fn(),
      onAnnotationAdd: vi.fn(),
      onSaveNote: vi.fn(),
      onOpenSource: vi.fn(),
      onBack: vi.fn(),
      getSourceBlob: vi.fn(async () => undefined),
      onConversationChange: vi.fn((conversation) => {
        props = { ...props, conversations: [conversation] };
        root.render(createElement(Reader, props));
      }),
      onAsk: vi.fn((request, requestSignal, onProgress) => {
        lastRequest = request as AnswerRequestWithUserContext;
        signal = requestSignal;
        progress = onProgress!;
        return result.promise;
      }),
    };
    await act(async () => {
      root.render(createElement(Reader, props));
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    if (scrollDescriptor)
      Object.defineProperty(Element.prototype, "scrollIntoView", scrollDescriptor);
    else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    vi.unstubAllGlobals();
  });

  async function start(question = "请解释学习率") {
    await act(async () => {
      const input = host.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        input,
        question,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(props.onAsk).toHaveBeenCalledTimes(1);
  }
  const preview = () => host.querySelector('[aria-label="正在生成的回答"]');
  const followUpGroups = () => [
    ...host.querySelectorAll<HTMLElement>('[role="group"][aria-label="继续追问建议"]'),
  ];

  function completedAttempt(questionMessageId: string) {
    return {
      id: `completed-${questionMessageId}`,
      questionMessageId,
      scopeSnapshot: {
        scope: "document-notes" as const,
        sourceId: props.source.id,
        sourceIds: [props.source.id],
        spaceId: props.space.id,
      },
      status: "completed" as const,
    };
  }

  it("keeps dedicated comparison and cross-library threads out of the ordinary reader", async () => {
    const comparison: Conversation = {
      id: "purged-comparison-thread",
      spaceId: props.space.id,
      title: "已删除资料的对照记录",
      scope: "sources",
      sourceIds: [props.source.id, "purged-source"],
      comparison: {
        leftSourceId: props.source.id,
        leftVersionId: props.source.versionId,
        rightSourceId: "purged-source",
        rightVersionId: "purged-version",
      },
      messages: [message("comparison-question", "user", "这两份资料有什么不同？")],
      resolved: false,
      updatedAt: "2026-09-13T00:00:00.000Z",
    };
    const crossLibrary: Conversation = {
      id: "cross-library-thread",
      spaceId: props.space.id,
      title: "跨知识库问题",
      scope: "cross-library-sources",
      sourceIds: [props.source.id],
      messages: [message("cross-library-question", "user", "跨库问题")],
      resolved: false,
      updatedAt: "2026-09-13T00:00:01.000Z",
    };
    props = { ...props, conversations: [comparison, crossLibrary] };
    await act(async () => root.render(createElement(Reader, props)));

    expect(
      [...host.querySelectorAll<HTMLSelectElement>(".reader-scope select option")].some(
        (option) => option.value === "cross-library-sources",
      ),
    ).toBe(false);
    const history = host.querySelector<HTMLButtonElement>('[aria-label="对话历史"]')!;
    await act(async () => history.click());
    expect(host.textContent).not.toContain("已删除资料的对照记录");
    expect(host.textContent).not.toContain("跨知识库问题");
    expect(host.textContent).toContain("发送第一个问题后，对话会保存在这里。");
  });

  it("shows early paragraphs and sources, but only persists the complete answer and then offers save actions", async () => {
    await start();
    await act(async () => {
      progress({ type: "progress", phase: "generating" });
      progress({ type: "draft", answer: draft });
    });
    expect(preview()?.textContent).toContain(draft.content.replace(" [1]", ""));
    expect(preview()?.textContent).toContain("尚未保存");
    expect(preview()?.textContent).toContain(draft.citations[0].quote);
    expect(preview()?.querySelectorAll("button")).toHaveLength(0);
    expect(props.onConversationChange).toHaveBeenCalledTimes(1);
    expect(props.conversations[0].messages).toHaveLength(1);
    expect(props.onSaveNote).not.toHaveBeenCalled();
    const complete = { ...draft, content: "完整回答已核验。 [1]" };
    await act(async () => {
      progress({ type: "progress", phase: "validating" });
    });
    expect(host.textContent).toContain("正在核对引用并确认回答");
    await act(async () => {
      result.resolve(complete);
    });
    expect(preview()).toBeNull();
    expect(props.onConversationChange).toHaveBeenCalledTimes(2);
    expect(props.conversations[0].messages[1]).toMatchObject(complete);
    expect(host.querySelector('[aria-label="停止回答"]')).toBeNull();
    await act(async () => {
      progress({ type: "draft", answer: draft });
    });
    expect(preview()).toBeNull();
  });

  it("shows two follow-up chips only for the latest completed answer and prefills without sending", async () => {
    const earlierQuestion = message("earlier-question", "user", "上一轮问题");
    const earlierAnswer: Message = {
      ...message("earlier-answer", "assistant", "上一轮已完成回答。"),
      mode: "model",
      attempt: completedAttempt(earlierQuestion.id),
    };
    const existingConversation: Conversation = {
      id: "existing-conversation",
      spaceId: props.space.id,
      sourceId: props.source.id,
      title: earlierQuestion.content,
      scope: "document-notes",
      sourceIds: [props.source.id],
      messages: [earlierQuestion, earlierAnswer],
      resolved: false,
      updatedAt: "2026-09-13T00:00:00.000Z",
    };
    await act(async () => {
      props = { ...props, conversations: [existingConversation] };
      root.render(createElement(Reader, props));
    });

    await start("请继续解释");
    expect(followUpGroups()).toHaveLength(0);

    await act(async () => {
      result.resolve({ ...draft, content: "这轮回答已完整核验。 [1]" });
    });

    const groups = followUpGroups();
    expect(groups).toHaveLength(1);
    const chips = [...groups[0].querySelectorAll<HTMLButtonElement>("button")];
    expect(chips).toHaveLength(2);
    const suggestion = chips[0].textContent?.trim();
    expect(suggestion).toBeTruthy();

    const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="向资料提问"]')!;
    await act(async () => {
      chips[0].click();
    });

    expect(input.value).toBe(suggestion);
    expect(document.activeElement).toBe(input);
    expect(props.onAsk).toHaveBeenCalledTimes(1);
  });

  it("does not show follow-up chips while an answer is still a transient draft", async () => {
    await start();
    await act(async () => {
      progress({ type: "draft", answer: draft });
    });

    expect(followUpGroups()).toHaveLength(0);
  });

  it("does not show follow-up chips for a historical answer", async () => {
    const question = message("historical-question", "user", "历史版本的问题");
    const answer: Message = {
      ...message("historical-answer", "assistant", "历史版本的完整回答。"),
      mode: "model",
      attempt: completedAttempt(question.id),
    };
    const historicalSource = { ...props.source, versionId: "historical-version" };
    const currentSource = { ...props.source, versionId: "current-version" };
    const conversation: Conversation = {
      id: "historical-conversation",
      spaceId: props.space.id,
      sourceId: historicalSource.id,
      title: question.content,
      scope: "document-notes",
      sourceIds: [historicalSource.id],
      messages: [question, answer],
      resolved: false,
      updatedAt: "2026-09-13T00:00:00.000Z",
    };
    await act(async () => {
      props = {
        ...props,
        source: historicalSource,
        currentSource,
        sources: [currentSource],
        conversations: [conversation],
      };
      root.render(createElement(Reader, props));
    });

    expect(followUpGroups()).toHaveLength(0);
  });

  it("does not show follow-up chips for an errored answer", async () => {
    const question = message("errored-question", "user", "没有完成的问题");
    const answer: Message = {
      ...message("errored-answer", "assistant", "未核验的部分内容。"),
      mode: "model",
      attempt: { ...completedAttempt(question.id), status: "stopped" },
      error: "回答已停止，问题已保留。",
    };
    const conversation: Conversation = {
      id: "errored-conversation",
      spaceId: props.space.id,
      sourceId: props.source.id,
      title: question.content,
      scope: "document-notes",
      sourceIds: [props.source.id],
      messages: [question, answer],
      resolved: false,
      updatedAt: "2026-09-13T00:00:00.000Z",
    };
    await act(async () => {
      props = { ...props, conversations: [conversation] };
      root.render(createElement(Reader, props));
    });

    expect(followUpGroups()).toHaveLength(0);
  });

  it("discards a displayed draft after stream failure while retaining the question and a useful retry path", async () => {
    await start();
    await act(async () => {
      progress({ type: "draft", answer: draft });
    });
    await act(async () => {
      result.reject(new Error("回答连接中断，请重新编辑问题后再试。"));
    });
    expect(preview()).toBeNull();
    expect(host.textContent).not.toContain("已核对出处的首段");
    expect(props.conversations[0].messages[0].content).toBe("请解释学习率");
    expect(props.conversations[0].messages[1]).toMatchObject({
      content: "",
      citations: [],
      error: "回答连接中断，请重新编辑问题后再试。",
    });
    expect(props.conversations[0].messages[1].attempt).toMatchObject({
      id: lastRequest?.requestId,
      questionMessageId: props.conversations[0].messages[0].id,
      scopeSnapshot: {
        scope: "document-notes",
        sourceId: props.source.id,
        sourceIds: [props.source.id],
        sourceVersions: [{ sourceId: props.source.id, versionId: props.source.versionId }],
        spaceId: props.space.id,
      },
      status: "failed",
    });
    const edit = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "重新编辑问题",
    )!;
    await act(async () => {
      edit.click();
    });
    expect(host.querySelector("textarea")?.value).toBe("请解释学习率");
  });

  it("retries a failed answer with a fresh request ID and the frozen question range", async () => {
    const failedAttempt = {
      id: "attempt-first",
      questionMessageId: "question-selection",
      scopeSnapshot: {
        scope: "selection" as const,
        sourceId: props.source.id,
        sourceIds: [props.source.id],
        sourceVersions: [{ sourceId: props.source.id, versionId: props.source.versionId }],
        spaceId: props.space.id,
        selection: "冻结的原始选段",
        userContext: ["上一轮的用户问题"],
      },
      status: "failed" as const,
    };
    const failedConversation: Conversation = {
      id: "failed-conversation",
      spaceId: props.space.id,
      sourceId: props.source.id,
      title: "选段追问",
      scope: "document-notes",
      sourceIds: [props.source.id],
      resolved: false,
      updatedAt: "2026-09-13T00:00:00.000Z",
      messages: [
        message("question-selection", "user", "请解释这一段"),
        {
          id: "answer-failed",
          role: "assistant",
          content: "",
          citations: [],
          error: "回答连接中断。",
          attempt: failedAttempt,
          createdAt: "2026-09-13T00:00:01.000Z",
        },
      ],
    };
    await act(async () => {
      props = { ...props, conversations: [failedConversation] };
      root.render(createElement(Reader, props));
    });

    const retry = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "重试此回答",
    )!;
    await act(async () => {
      retry.click();
    });

    expect(props.onAsk).toHaveBeenCalledTimes(1);
    expect(lastRequest).toMatchObject({
      question: "请解释这一段",
      scope: "selection",
      sourceId: props.source.id,
      sourceIds: [],
      sourceVersions: [{ sourceId: props.source.id, versionId: props.source.versionId }],
      spaceId: props.space.id,
      selection: "冻结的原始选段",
      userContext: ["上一轮的用户问题"],
    });
    expect(lastRequest?.requestId).toEqual(expect.any(String));
    expect(lastRequest?.requestId).not.toBe(failedAttempt.id);
    expect(props.conversations[0].messages).toHaveLength(2);
    expect(props.conversations[0].messages.filter((item) => item.role === "user")).toHaveLength(1);
    expect(props.conversations[0].messages[1].attempt).toEqual(failedAttempt);

    await act(async () => {
      result.resolve({ ...draft, content: "重试后已核对出处。 [1]" });
    });

    const messages = props.conversations[0].messages;
    expect(messages).toHaveLength(3);
    expect(messages.filter((item) => item.role === "user")).toHaveLength(1);
    expect(messages[1].attempt).toEqual(failedAttempt);
    expect(messages[2]).toMatchObject({
      content: "重试后已核对出处。 [1]",
      attempt: {
        questionMessageId: "question-selection",
        scopeSnapshot: failedAttempt.scopeSnapshot,
        status: "completed",
      },
    });
    expect(messages[2].attempt?.id).toEqual(lastRequest?.requestId);
    expect(messages[2].attempt?.id).not.toBe(failedAttempt.id);
    expect(host.textContent).toContain("第 2 次尝试");
  });

  it("keeps a displayed draft after a user stop, marks it incomplete, and ignores late events", async () => {
    await start();
    await act(async () => {
      progress({ type: "draft", answer: draft });
    });
    await act(async () => {
      (host.querySelector('[aria-label="停止回答"]') as HTMLButtonElement).click();
    });
    expect(signal.aborted).toBe(true);
    expect(preview()?.textContent).toContain("已停止");
    expect(preview()?.textContent).toContain("已核对出处的首段");
    await act(async () => {
      progress({ type: "draft", answer: draft });
      result.resolve(draft);
    });
    expect(preview()).toBeNull();
    expect(props.conversations[0].messages[1]).toMatchObject({
      content: draft.content,
      citations: draft.citations,
      mode: "model",
      error: "已停止生成，以上内容尚未完成或核验。",
    });
    expect(host.textContent).toContain("已停止 · 未完成、未核验");
    expect(host.textContent).toContain("不会作为已核验答案保存或另存");
    expect(host.textContent).not.toContain("保存笔记");
    expect(host.textContent).not.toContain("保存到知识页");
  });

  it("aborts and clears a draft when the reader switches source version", async () => {
    await start();
    await act(async () => {
      progress({ type: "draft", answer: draft });
    });
    await act(async () => {
      const source = { ...props.source, versionId: "next-version" };
      props = { ...props, source, sources: [source] };
      root.render(createElement(Reader, props));
    });
    expect(signal.aborted).toBe(true);
    expect(preview()).toBeNull();
    await act(async () => {
      progress({ type: "draft", answer: draft });
      result.resolve(draft);
    });
    expect(preview()).toBeNull();
  });

  it("does not start a second request from duplicate synchronous submit events", async () => {
    await start();
    await act(async () => {
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(props.onAsk).toHaveBeenCalledTimes(1);
    await act(async () => {
      result.resolve(draft);
    });
  });

  it("keeps a draft while parsing and submits it once after the source becomes ready", async () => {
    const parsingSource = {
      ...props.source,
      status: "parsing" as const,
      coverage: { captureScope: "full" as const, parseState: "pending" as const },
    };
    props = { ...props, source: parsingSource, sources: [parsingSource] };
    await act(async () => root.render(createElement(Reader, props)));

    const question = "解析完成后解释这一节";
    const input = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        input,
        question,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const send = host.querySelector<HTMLButtonElement>('[aria-label="发送问题"]')!;
    expect(input.disabled).toBe(false);
    expect(input.value).toBe(question);
    expect(send.disabled).toBe(true);
    expect(input.getAttribute("aria-describedby")).toBe("reader-ask-eligibility");
    expect(host.querySelector("#reader-ask-eligibility")?.textContent).toContain("正在解析");

    await act(async () => {
      send.click();
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(props.onAsk).not.toHaveBeenCalled();
    expect(props.onConversationChange).not.toHaveBeenCalled();
    expect(input.value).toBe(question);

    const readySource = {
      ...parsingSource,
      status: "ready" as const,
      coverage: { captureScope: "full" as const, parseState: "complete" as const },
    };
    props = { ...props, source: readySource, sources: [readySource] };
    await act(async () => root.render(createElement(Reader, props)));

    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(question);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="发送问题"]')?.disabled).toBe(false);
    await act(async () => {
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(props.onAsk).toHaveBeenCalledTimes(1);
    expect(props.onConversationChange).toHaveBeenCalledTimes(1);
    expect(props.conversations[0].messages.filter((item) => item.role === "user")).toHaveLength(1);
    await act(async () => result.resolve(draft));
  });

  it("allows a space question when at least one source is ready and reports exclusions", async () => {
    const parsingSource = {
      ...props.source,
      id: "source-still-parsing",
      versionId: "version-still-parsing",
      title: "仍在解析的资料",
      status: "parsing" as const,
      coverage: { captureScope: "full" as const, parseState: "pending" as const },
      chunks: [],
      text: "",
    };
    props = { ...props, sources: [props.source, parsingSource] };
    await act(async () => root.render(createElement(Reader, props)));

    const scope = host.querySelector<HTMLSelectElement>(".reader-scope select")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
        scope,
        "space",
      );
      scope.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const input = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        input,
        "总结当前空间",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(host.textContent).toContain("范围中有 1 份资料尚未就绪或未允许 AI");
    expect(host.querySelector<HTMLButtonElement>('[aria-label="发送问题"]')?.disabled).toBe(false);
    await act(async () => {
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(props.onAsk).toHaveBeenCalledTimes(1);
    expect(lastRequest).toMatchObject({ scope: "space", sourceIds: [] });
    await act(async () => result.resolve(draft));
  });

  it("sends and persists only answer-ready sources from the explicit selection", async () => {
    const parsingSource = {
      ...props.source,
      id: "selected-parsing-source",
      versionId: "selected-parsing-version",
      title: "选中的解析中资料",
      status: "parsing" as const,
      coverage: { captureScope: "full" as const, parseState: "pending" as const },
      chunks: [],
      text: "",
    };
    props = { ...props, sources: [props.source, parsingSource] };
    await act(async () => root.render(createElement(Reader, props)));

    const scope = host.querySelector<HTMLSelectElement>(".reader-scope select")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
        scope,
        "sources",
      );
      scope.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const choices = [...host.querySelectorAll<HTMLInputElement>(".reader-source-picker input")];
    expect(choices).toHaveLength(2);
    await act(async () => {
      choices[0].click();
      choices[1].click();
    });
    const input = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        input,
        "只问选中的资料",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(host.querySelector("#reader-ask-eligibility")?.textContent).toContain("正在解析");
    expect(host.querySelector<HTMLButtonElement>('[aria-label="发送问题"]')?.disabled).toBe(true);

    await act(async () => choices[0].click());
    expect(host.querySelector("#reader-ask-eligibility")).toBeNull();
    expect(host.textContent).toContain("范围中有 1 份资料尚未就绪或未允许 AI");
    expect(host.querySelector<HTMLButtonElement>('[aria-label="发送问题"]')?.disabled).toBe(false);

    await act(async () => {
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    const expectedSourceVersions = [
      { sourceId: props.source.id, versionId: props.source.versionId },
    ];
    expect(lastRequest).toMatchObject({
      scope: "sources",
      sourceIds: [props.source.id],
      sourceVersions: expectedSourceVersions,
    });
    expect(props.onConversationChange).toHaveBeenCalledTimes(1);
    expect(props.conversations[0]).toMatchObject({
      scope: "sources",
      sourceIds: [props.source.id],
    });

    await act(async () => result.resolve(draft));

    expect(props.conversations[0].messages[1].attempt?.scopeSnapshot).toMatchObject({
      scope: "sources",
      sourceIds: [props.source.id],
      sourceVersions: expectedSourceVersions,
    });
  });

  it("blocks a retry before persistence when its frozen source is no longer answer-ready", async () => {
    const parsingSource = {
      ...props.source,
      id: "frozen-parsing-source",
      versionId: "frozen-parsing-version",
      title: "冻结范围中的解析中资料",
      status: "parsing" as const,
      coverage: { captureScope: "full" as const, parseState: "pending" as const },
      chunks: [],
      text: "",
    };
    const failedConversation: Conversation = {
      id: "retry-while-parsing",
      spaceId: props.space.id,
      sourceId: props.source.id,
      title: "等待解析",
      scope: "sources",
      sourceIds: [parsingSource.id],
      resolved: false,
      updatedAt: "2026-09-13T00:00:02.000Z",
      messages: [
        message("question-before-parsing", "user", "解释原问题"),
        {
          ...message("failed-before-parsing", "assistant", ""),
          error: "上次回答失败。",
          attempt: {
            id: "attempt-before-parsing",
            questionMessageId: "question-before-parsing",
            scopeSnapshot: {
              scope: "sources",
              sourceIds: [parsingSource.id],
              spaceId: props.space.id,
            },
            status: "failed",
          },
        },
      ],
    };
    props = {
      ...props,
      sources: [props.source, parsingSource],
      conversations: [failedConversation],
    };
    await act(async () => root.render(createElement(Reader, props)));

    const messagesBefore = structuredClone(props.conversations[0].messages);
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "重试此回答",
    )!;
    await act(async () => retry.click());

    expect(props.onAsk).not.toHaveBeenCalled();
    expect(props.onConversationChange).not.toHaveBeenCalled();
    expect(props.conversations[0].messages).toEqual(messagesBefore);
    expect(host.textContent).toContain("资料正在解析，完成后即可提问");
  });

  it.each([
    ["selection", "冻结的原始选段"],
    ["document", undefined],
    ["document-notes", undefined],
  ] as const)(
    "blocks a %s retry before persistence when its frozen document version changed",
    async (frozenScope, frozenSelection) => {
      const failedConversation: Conversation = {
        id: `single-source-version-change-${frozenScope}`,
        spaceId: props.space.id,
        sourceId: props.source.id,
        title: "单资料冻结版本已变化",
        scope: frozenScope,
        sourceIds: [props.source.id],
        resolved: false,
        updatedAt: "2026-09-13T00:00:02.000Z",
        messages: [
          message(`single-source-question-${frozenScope}`, "user", "解释原问题"),
          {
            ...message(`single-source-answer-${frozenScope}`, "assistant", ""),
            error: "上次回答失败。",
            attempt: {
              id: `single-source-attempt-${frozenScope}`,
              questionMessageId: `single-source-question-${frozenScope}`,
              scopeSnapshot: {
                scope: frozenScope,
                sourceId: props.source.id,
                sourceIds: [props.source.id],
                sourceVersions: [
                  { sourceId: props.source.id, versionId: "previous-source-version" },
                ],
                spaceId: props.space.id,
                ...(frozenSelection ? { selection: frozenSelection } : {}),
              },
              status: "failed",
            },
          },
        ],
      };
      props = { ...props, conversations: [failedConversation] };
      await act(async () => root.render(createElement(Reader, props)));

      const messagesBefore = structuredClone(props.conversations[0].messages);
      const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "重试此回答",
      )!;
      await act(async () => retry.click());

      expect(props.onAsk).not.toHaveBeenCalled();
      expect(props.onConversationChange).not.toHaveBeenCalled();
      expect(props.conversations[0].messages).toEqual(messagesBefore);
      expect(host.textContent).toContain("原问题的资料版本、归属或 AI 使用状态已经变化");
    },
  );

  it("keeps a legacy single-source attempt readable but blocks its unsafe retry", async () => {
    const failedConversation: Conversation = {
      id: "legacy-single-source-retry",
      spaceId: props.space.id,
      sourceId: props.source.id,
      title: "旧版单资料问题",
      scope: "document-notes",
      sourceIds: [props.source.id],
      resolved: false,
      updatedAt: "2026-09-13T00:00:02.000Z",
      messages: [
        message("legacy-single-source-question", "user", "解释旧问题"),
        {
          ...message("legacy-single-source-answer", "assistant", ""),
          error: "上次回答失败。",
          attempt: {
            id: "legacy-single-source-attempt",
            questionMessageId: "legacy-single-source-question",
            scopeSnapshot: {
              scope: "document-notes",
              sourceId: props.source.id,
              sourceIds: [props.source.id],
              spaceId: props.space.id,
            },
            status: "failed",
          },
        },
      ],
    };
    props = { ...props, conversations: [failedConversation] };
    await act(async () => root.render(createElement(Reader, props)));

    expect(host.textContent).toContain("解释旧问题");
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "重试此回答",
    )!;
    await act(async () => retry.click());

    expect(props.onAsk).not.toHaveBeenCalled();
    expect(props.onConversationChange).not.toHaveBeenCalled();
    expect(host.textContent).toContain("原问题的资料版本、归属或 AI 使用状态已经变化");
  });

  it("blocks a failed-answer retry before persistence when a frozen source version changed", async () => {
    const failedConversation: Conversation = {
      id: "retry-after-version-change",
      spaceId: props.space.id,
      sourceId: props.source.id,
      title: "冻结版本已变化",
      scope: "sources",
      sourceIds: [props.source.id],
      resolved: false,
      updatedAt: "2026-09-13T00:00:02.000Z",
      messages: [
        message("question-before-version-change", "user", "解释原问题"),
        {
          ...message("failed-before-version-change", "assistant", ""),
          error: "上次回答失败。",
          attempt: {
            id: "attempt-before-version-change",
            questionMessageId: "question-before-version-change",
            scopeSnapshot: {
              scope: "sources",
              sourceIds: [props.source.id],
              sourceVersions: [{ sourceId: props.source.id, versionId: "previous-source-version" }],
              spaceId: props.space.id,
            },
            status: "failed",
          },
        },
      ],
    };
    props = { ...props, conversations: [failedConversation] };
    await act(async () => root.render(createElement(Reader, props)));

    const messagesBefore = structuredClone(props.conversations[0].messages);
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "重试此回答",
    )!;
    await act(async () => retry.click());

    expect(props.onAsk).not.toHaveBeenCalled();
    expect(props.onConversationChange).not.toHaveBeenCalled();
    expect(props.conversations[0].messages).toEqual(messagesBefore);
    expect(host.textContent).toContain("原问题的资料版本、归属或 AI 使用状态已经变化");
  });

  it("blocks a legacy sources retry whose frozen snapshot lacks source versions", async () => {
    const failedConversation: Conversation = {
      id: "retry-without-frozen-versions",
      spaceId: props.space.id,
      sourceId: props.source.id,
      title: "旧版冻结范围",
      scope: "sources",
      sourceIds: [props.source.id],
      resolved: false,
      updatedAt: "2026-09-13T00:00:02.000Z",
      messages: [
        message("legacy-sources-question", "user", "解释旧问题"),
        {
          ...message("legacy-sources-answer", "assistant", ""),
          error: "上次回答失败。",
          attempt: {
            id: "legacy-sources-attempt",
            questionMessageId: "legacy-sources-question",
            scopeSnapshot: {
              scope: "sources",
              sourceIds: [props.source.id],
              spaceId: props.space.id,
            },
            status: "failed",
          },
        },
      ],
    };
    props = { ...props, conversations: [failedConversation] };
    await act(async () => root.render(createElement(Reader, props)));

    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "重试此回答",
    )!;
    await act(async () => retry.click());

    expect(props.onAsk).not.toHaveBeenCalled();
    expect(props.onConversationChange).not.toHaveBeenCalled();
    expect(host.textContent).toContain("原问题的资料版本、归属或 AI 使用状态已经变化");
  });

  it("forwards only preceding user questions from the active conversation", async () => {
    const active: Conversation = {
      id: "active-conversation",
      spaceId: props.space.id,
      sourceId: props.source.id,
      title: "连续追问",
      scope: "document-notes",
      sourceIds: [props.source.id],
      resolved: false,
      updatedAt: "2026-09-13T00:01:00.000Z",
      messages: [
        message("active-user-1", "user", "FIRST_USER_QUESTION_orionanchor"),
        message("active-assistant", "assistant", "ASSISTANT_ONLY_KEYWORD_never_retrieve"),
        message("active-user-2", "user", "SECOND_USER_QUESTION_calibration"),
      ],
    };
    await act(async () => {
      props = { ...props, conversations: [active] };
      root.render(createElement(Reader, props));
    });

    await start("CURRENT_QUESTION_KEYWORD_never_context");

    expect(lastRequest?.userContext).toEqual([
      "FIRST_USER_QUESTION_orionanchor",
      "SECOND_USER_QUESTION_calibration",
    ]);
    const serialized = JSON.stringify(lastRequest?.userContext);
    expect(serialized).not.toContain("ASSISTANT_ONLY_KEYWORD");
    expect(serialized).not.toContain("CURRENT_QUESTION_KEYWORD");
    await act(async () => {
      result.resolve(draft);
    });
  });

  it("sends only the six most recent user questions from the active conversation as context", async () => {
    const priorUsers = Array.from(
      { length: 7 },
      (_, index) => `ACTIVE_USER_QUESTION_${index + 1}_orionanchor`,
    );
    const active: Conversation = {
      id: "active-conversation",
      spaceId: props.space.id,
      sourceId: props.source.id,
      title: "连续追问",
      scope: "document-notes",
      sourceIds: [props.source.id],
      resolved: false,
      updatedAt: "2026-09-13T00:01:00.000Z",
      messages: [
        message("active-user-1", "user", priorUsers[0]),
        message("active-assistant", "assistant", "ASSISTANT_ONLY_KEYWORD_never_retrieve"),
        ...priorUsers
          .slice(1)
          .map((content, index) => message(`active-user-${index + 2}`, "user", content)),
      ],
    };
    const otherConversation: Conversation = {
      ...active,
      id: "other-conversation",
      updatedAt: "2026-09-12T00:00:00.000Z",
      messages: [message("other-user", "user", "OTHER_CONVERSATION_KEYWORD_never_retrieve")],
    };
    await act(async () => {
      props = { ...props, conversations: [active, otherConversation] };
      root.render(createElement(Reader, props));
    });

    await start("CURRENT_QUESTION_KEYWORD_never_context");

    expect(lastRequest?.userContext).toEqual(priorUsers.slice(-6));
    expect(lastRequest?.userContext).toHaveLength(6);
    expect(lastRequest?.userContext?.every((item) => item.length <= 800)).toBe(true);
    expect(
      lastRequest?.userContext?.reduce((sum, item) => sum + item.length, 0),
    ).toBeLessThanOrEqual(3600);
    const serialized = JSON.stringify(lastRequest?.userContext);
    expect(serialized).not.toContain("ASSISTANT_ONLY_KEYWORD");
    expect(serialized).not.toContain("OTHER_CONVERSATION_KEYWORD");
    expect(serialized).not.toContain("CURRENT_QUESTION_KEYWORD");
    await act(async () => {
      result.resolve(draft);
    });
  });

  it("uses the document-notes scope by default and preserves note evidence only on completion", async () => {
    await start();
    expect(props.onAsk).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "document-notes",
        sourceId: props.source.id,
        sourceIds: [],
        sourceVersions: [{ sourceId: props.source.id, versionId: props.source.versionId }],
      }),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    const complete: AnswerResult = {
      ...draft,
      content: "这是我的个人复盘。 **[[conuo-note:1]]**",
      citations: [],
      noteEvidence: [
        {
          noteId: "note-a",
          spaceId: props.space.id,
          sourceId: props.source.id,
          sourceVersionId: props.source.versionId,
          revision: 1,
          updatedAt: "2026-09-13T00:00:00.000Z",
          blockId: "b1",
          title: "我的复盘",
          quote: "学习率过大时，损失可能振荡。",
        },
      ],
    };
    await act(async () => {
      result.resolve(complete);
    });
    expect(props.conversations[0].messages[1].noteEvidence).toEqual(complete.noteEvidence);
    expect(host.querySelector('[aria-label^="查看我的笔记依据"]')).toBeTruthy();
    expect(
      [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("保存笔记"),
      )?.disabled,
    ).toBe(true);
  });
});
