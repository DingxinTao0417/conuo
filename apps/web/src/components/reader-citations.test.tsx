// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Reader, { type ReaderProps } from "./reader";
import { answerNoteMarker, extractiveCitationMarker } from "@/lib/citation-markers";
import { createDemoWorkspace } from "@/lib/seed";
import type {
  AnswerNoteEvidence,
  Citation,
  Conversation,
  Message,
  Note,
  Source,
} from "@/lib/types";

vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./pdf-reader", () => ({ default: () => null }));
vi.mock("./web-version-panel", () => ({ default: () => null }));

const now = "2026-09-13T00:00:00.000Z";
const firstQuote = "学习率过大时，参数可能反复越过较好的位置，损失出现振荡。";
const secondQuote = "学习率太小会让损失下降缓慢，需要更多次更新。";

describe("reader answer citations", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: ReaderProps;
  let source: Source;
  let citations: Citation[];
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

    const workspace = createDemoWorkspace();
    source = {
      ...workspace.sources[0],
      id: "source-a",
      versionId: "version-a",
      kind: "markdown",
      aiAllowed: true,
      text: `${firstQuote}\n\n${secondQuote}`,
      spaceIds: [workspace.spaces[0].id],
      chunks: [
        {
          id: "chunk-a",
          sourceId: "source-a",
          versionId: "version-a",
          text: firstQuote,
          section: "学习率过高",
          order: 0,
        },
        {
          id: "chunk-b",
          sourceId: "source-a",
          versionId: "version-a",
          text: secondQuote,
          section: "学习率过小",
          order: 1,
        },
      ],
    };
    citations = source.chunks.map((chunk) => ({
      sourceId: source.id,
      versionId: source.versionId,
      chunkId: chunk.id,
      title: "机器学习入门.pdf",
      quote: chunk.text,
      section: chunk.section,
    }));
    props = {
      source,
      sources: [source],
      space: workspace.spaces[0],
      conversations: [conversation("资料中的两处结论。 [1]\n\n另一处结论。 [2]", citations)],
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
    if (scrollDescriptor)
      Object.defineProperty(Element.prototype, "scrollIntoView", scrollDescriptor);
    else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    vi.unstubAllGlobals();
  });

  async function render(overrides: Partial<ReaderProps> = {}) {
    props = { ...props, ...overrides };
    await act(async () => {
      root.render(createElement(Reader, props));
    });
  }

  function conversation(
    content: string,
    messageCitations: Citation[],
    mode: Message["mode"] = "model",
    noteEvidence: AnswerNoteEvidence[] = [],
  ): Conversation {
    return {
      id: "conversation-a",
      spaceId: source.spaceIds[0] || "space-a",
      sourceId: "source-a",
      title: "学习率问题",
      scope: "document",
      sourceIds: ["source-a"],
      resolved: false,
      updatedAt: now,
      messages: [
        {
          id: "assistant-message",
          role: "assistant",
          content,
          citations: messageCitations,
          ...(noteEvidence.length ? { noteEvidence } : {}),
          createdAt: now,
          mode,
        },
      ],
    };
  }

  function chip(index: number) {
    const result = host.querySelector<HTMLButtonElement>(`[aria-label^="查看引用 ${index + 1}："]`);
    expect(result, `citation chip ${index + 1}`).toBeTruthy();
    return result!;
  }

  async function click(button: HTMLButtonElement) {
    await act(async () => {
      button.click();
    });
  }

  it("turns answer markers into ordered, accessible citation chips and keeps one source card open", async () => {
    const first = chip(0);
    expect(first.textContent).toContain("机器学习入门.pdf");
    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('[role="region"]')).toBeNull();

    await click(first);
    expect(chip(0).getAttribute("aria-expanded")).toBe("true");
    expect(chip(1).getAttribute("aria-expanded")).toBe("false");
    const firstCard = host.querySelector<HTMLElement>('[aria-label="引用 1 原文"]');
    expect(firstCard?.textContent).toContain(firstQuote);
    expect(firstCard?.textContent).toContain("学习率过高");

    await click(chip(1));
    expect(host.querySelector('[aria-label="引用 1 原文"]')).toBeNull();
    expect(host.querySelector('[aria-label="引用 2 原文"]')?.textContent).toContain(secondQuote);
  });

  it("uses the existing same-source locator only after the reader chooses open original position", async () => {
    await click(chip(0));
    expect(props.onOpenSource).not.toHaveBeenCalled();

    const open = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.replace(/\s+/gu, "") === "打开原文位置",
    );
    expect(open).toBeTruthy();
    await click(open!);

    expect(props.onOpenSource).not.toHaveBeenCalled();
    expect(host.textContent).toContain("引用原文 · 机器学习入门.pdf");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("locates a Markdown heading citation after its syntax is omitted from rendered prose", async () => {
    const rawHeading = `## ${firstQuote}`;
    const markdownSource = {
      ...source,
      text: `${rawHeading}\n\n${secondQuote}`,
      chunks: [{ ...source.chunks[0], text: rawHeading }, source.chunks[1]],
    };
    const markdownCitation = { ...citations[0], quote: rawHeading };
    await render({
      source: markdownSource,
      sources: [markdownSource],
      conversations: [conversation("标题依据 [1]", [markdownCitation])],
    });

    await click(chip(0));
    const open = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.replace(/\s+/gu, "") === "打开原文位置",
    );
    await click(open!);

    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(host.textContent).not.toContain("暂未精确定位");
  });

  it("keeps the compact AI panel mounted and returns to the reader after opening a citation", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query === "(max-width: 1024px)" })),
    );
    const workspace = host.querySelector<HTMLElement>(".reader-workspace")!;
    const ask = host.querySelector<HTMLButtonElement>(".reader-ai-toggle")!;

    await click(ask);
    expect(workspace.className).toContain("reader-mobile-ai");
    expect(host.querySelector(".reader-ai")).toBeTruthy();

    await click(host.querySelector<HTMLButtonElement>('[aria-label="收起问答面板"]')!);
    expect(workspace.className).toContain("reader-mobile-reading");
    expect(host.querySelector(".reader-ai")).toBeTruthy();

    await click(ask);
    await click(chip(0));
    const open = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.replace(/\s+/gu, "") === "打开原文位置",
    );
    await click(open!);

    expect(workspace.className).toContain("reader-mobile-reading");
    expect(host.querySelector(".reader-ai")).toBeTruthy();
    expect(host.textContent).toContain("引用原文 · 机器学习入门.pdf");
  });

  it("uses a phone citation page and keeps a direct route back to the same AI answer", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(max-width: 1024px)" || query === "(max-width: 620px)",
      })),
    );
    const workspace = host.querySelector<HTMLElement>(".reader-workspace")!;
    const ask = host.querySelector<HTMLButtonElement>('[aria-label="从底部打开问 AI"]');
    expect(ask).toBeTruthy();

    await click(ask!);
    expect(workspace.className).toContain("reader-mobile-ai");
    await click(chip(0));
    const open = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.replace(/\s+/gu, "") === "打开原文位置",
    );
    await click(open!);

    expect(workspace.className).toContain("reader-mobile-citation");
    const citationPage = host.querySelector<HTMLElement>('[aria-label="引用原文"]');
    expect(citationPage?.textContent).toContain(firstQuote);
    expect(citationPage?.textContent).toContain("学习率过高");

    const backToAnswer = host.querySelector<HTMLButtonElement>('[aria-label="返回回答"]');
    expect(backToAnswer).toBeTruthy();
    await click(backToAnswer!);
    expect(workspace.className).toContain("reader-mobile-ai");
    expect(host.querySelector(".reader-ai")).toBeTruthy();
  });

  it("gives phone readers a working primary navigation after the Ask AI entry", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(max-width: 1024px)" || query === "(max-width: 620px)",
      })),
    );
    const onBack = vi.fn();
    const onOpenSettings = vi.fn();
    await render({ onBack, onOpenSettings });

    const nav = host.querySelector<HTMLElement>(".reader-mobile-primary-nav");
    expect(nav?.previousElementSibling?.classList.contains("reader-mobile-askbar")).toBe(true);
    expect(
      [...(nav?.querySelectorAll<HTMLButtonElement>("button") || [])].map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["资料", "阅读", "问答", "我的"]);
    expect(nav?.querySelector('[aria-current="page"]')?.textContent).toContain("阅读");

    await click(nav!.querySelector<HTMLButtonElement>('[aria-label="打开问答"]')!);
    expect(host.querySelector(".reader-workspace")?.className).toContain("reader-mobile-ai");

    await click(nav!.querySelector<HTMLButtonElement>('[aria-label="返回阅读"]')!);
    expect(host.querySelector(".reader-workspace")?.className).toContain("reader-mobile-reading");

    await click(nav!.querySelector<HTMLButtonElement>('[aria-label="返回资料库"]')!);
    expect(onBack).toHaveBeenCalledTimes(1);

    await click(nav!.querySelector<HTMLButtonElement>('[aria-label="打开我的"]')!);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps a cross-source phone citation inside the originating answer until the learner opens its source", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(max-width: 1024px)" || query === "(max-width: 620px)",
      })),
    );
    const citedSource: Source = {
      ...source,
      id: "source-b",
      versionId: "version-b",
      title: "资料 B.pdf",
      text: "另一份资料中的原文。",
      chunks: [
        {
          ...source.chunks[0],
          id: "chunk-b-source",
          sourceId: "source-b",
          versionId: "version-b",
          text: "另一份资料中的原文。",
        },
      ],
    };
    const crossSourceCitation: Citation = {
      sourceId: citedSource.id,
      versionId: citedSource.versionId,
      chunkId: citedSource.chunks[0]!.id,
      title: citedSource.title,
      quote: citedSource.chunks[0]!.text,
      section: "关键段落",
    };
    await render({
      sources: [source, citedSource],
      conversations: [conversation("跨资料回答 [1]", [crossSourceCitation])],
    });

    await click(host.querySelector<HTMLButtonElement>('[aria-label="从底部打开问 AI"]')!);
    await click(chip(0));
    const openPosition = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.replace(/\s+/gu, "") === "打开原文位置",
    );
    await click(openPosition!);

    const citationPage = host.querySelector<HTMLElement>('[aria-label="引用原文"]');
    expect(citationPage?.textContent).toContain("另一份资料中的原文。");
    expect(props.onOpenSource).not.toHaveBeenCalled();
    const backToAnswer = host.querySelector<HTMLButtonElement>('[aria-label="返回回答"]')!;
    expect(document.activeElement).toBe(backToAnswer);

    await click(backToAnswer);
    expect(host.querySelector(".reader-workspace")?.className).toContain("reader-mobile-ai");
    expect(host.textContent).toContain("跨资料回答");

    await click(
      [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.replace(/\s+/gu, "") === "打开原文位置",
      )!,
    );
    await click(host.querySelector<HTMLButtonElement>('[aria-label="打开完整原文"]')!);
    expect(props.onOpenSource).toHaveBeenCalledWith(
      citedSource.id,
      citedSource.versionId,
      crossSourceCitation,
    );
  });

  it("shows the workspace save state in the reader header", async () => {
    await render({ saveState: "cloud", saveLabel: "已保存到云端" });

    const sync = host.querySelector<HTMLElement>(".reader-save-status[role=status]");
    expect(sync?.textContent).toContain("已保存到云端");
    expect(sync?.className).toContain("reader-save-cloud");
  });

  it("keeps a fallback chip when an answer has citations but no numbered marker", async () => {
    await render({ conversations: [conversation("这个回答没有写编号。", [citations[0]])] });
    expect(host.querySelector('[aria-label="回答引用"]')?.textContent).toContain("引用");
    expect(chip(0)).toBeTruthy();
  });

  it("replaces an extractive citation heading as one chip instead of repeating its source title", async () => {
    await render({
      conversations: [
        conversation(
          `**[1] ${citations[0].title} · ${citations[0].section}**\n\n> ${citations[0].quote}`,
          [citations[0]],
          "extractive",
        ),
      ],
    });
    expect(host.querySelectorAll('[aria-label^="查看引用"]').length).toBe(1);
    expect(host.textContent?.split(citations[0].title)).toHaveLength(2);
  });

  it("uses only controlled extractive metadata as a chip and preserves source footnotes", async () => {
    const quote = "原文保留自己的脚注编号 [1]，它不是回答引用。";
    const sourceWithFootnote = {
      ...source,
      text: quote,
      chunks: [{ ...source.chunks[0], text: quote }],
    };
    const citationWithFootnote = { ...citations[0], quote };
    await render({
      source: sourceWithFootnote,
      sources: [sourceWithFootnote],
      conversations: [
        conversation(
          `**${extractiveCitationMarker(0)}**\n\n> ${quote}`,
          [citationWithFootnote],
          "extractive",
        ),
      ],
    });
    expect(host.querySelectorAll('[aria-label^="查看引用"]').length).toBe(1);
    expect(host.querySelector(".reader-message-content blockquote")?.textContent).toContain("[1]");
  });

  it("compacts legacy extractive headings even when a source title contains Markdown", async () => {
    const markdownTitleCitation = { ...citations[0], title: "资料 *草稿* [v2]" };
    await render({
      conversations: [
        conversation(
          `**[1] ${markdownTitleCitation.title} · ${markdownTitleCitation.section}**\n\n> ${markdownTitleCitation.quote}`,
          [markdownTitleCitation],
          "extractive",
        ),
      ],
    });
    expect(host.querySelectorAll('[aria-label^="查看引用"]').length).toBe(1);
    expect(host.textContent?.split(markdownTitleCitation.title)).toHaveLength(2);
  });

  it("does not turn marker-like text in inline code into a second interactive citation", async () => {
    await render({
      conversations: [conversation("正文依据 [1]，代码是 `示例 [1]`。", [citations[0]])],
    });
    expect(host.querySelectorAll('[aria-label^="查看引用"]').length).toBe(1);
    expect(host.querySelector("code")?.textContent).toBe("示例 [1]");
  });

  it("keeps a fallback chip when a citation marker appears only in code", async () => {
    await render({ conversations: [conversation("`示例 [1]`", [citations[0]])] });
    expect(host.querySelector("code")?.textContent).toBe("示例 [1]");
    expect(host.querySelectorAll('[aria-label^="查看引用"]').length).toBe(1);
    expect(host.querySelector('[aria-label="回答引用"]')?.textContent).toContain("引用");
  });

  it("keeps a fallback chip when a citation marker appears only inside an external link", async () => {
    await render({
      conversations: [conversation("[[1]](https://example.com/reference)", [citations[0]])],
    });
    expect(host.querySelector('a[href="https://example.com/reference"]')?.textContent).toBe("[1]");
    expect(host.querySelectorAll('[aria-label^="查看引用"]').length).toBe(1);
    expect(host.querySelector('[aria-label="回答引用"]')?.textContent).toContain("引用");
  });

  it("does not hijack a regular fragment whose text happens to start with the citation prefix", async () => {
    await render({
      conversations: [conversation("[个人笔记](#conuo-citation-1-notes)", [citations[0]])],
    });
    expect(host.querySelector('a[href="#conuo-citation-1-notes"]')?.textContent).toBe("个人笔记");
    expect(host.querySelectorAll('[aria-label^="查看引用"]').length).toBe(1);
  });

  it("shows an unavailable citation transparently and does not offer an invalid jump", async () => {
    const broken = { ...citations[0], quote: "这段文字不在保存版本中。" };
    await render({ conversations: [conversation("无效引用 [1]", [broken])] });
    await click(chip(0));

    const card = host.querySelector('[aria-label="引用 1 原文"]');
    expect(card?.textContent).toContain("引用摘录未在保存的这个版本中找到");
    expect([...card!.querySelectorAll("button")]).toHaveLength(0);
    expect(props.onOpenSource).not.toHaveBeenCalled();
  });

  it("renders personal-note evidence separately from source citations and keeps its snapshot readable", async () => {
    const noteEvidence: AnswerNoteEvidence[] = [
      {
        noteId: "note-a",
        spaceId: source.spaceIds[0],
        sourceId: source.id,
        sourceVersionId: source.versionId,
        revision: 1,
        updatedAt: now,
        blockId: "b1",
        title: "我的学习率复盘",
        quote: "我记下：损失反复上下波动时，应该先降低学习率。",
      },
    ];
    await render({
      notes: [
        {
          id: "note-a",
          spaceId: source.spaceIds[0],
          title: "我的学习率复盘",
          content: `<p>${noteEvidence[0].quote}</p>`,
          kind: "note",
          aiGenerated: false,
          status: "accepted",
          citations: [citations[0]],
          versions: [],
          contentRevision: 1,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        } satisfies Note,
      ],
      conversations: [
        conversation(`这是我当时的理解。 **${answerNoteMarker(0)}**`, [], "model", noteEvidence),
      ],
    });
    const chip = host.querySelector<HTMLButtonElement>('[aria-label^="查看我的笔记依据 1："]');
    expect(chip?.textContent).toContain("我的笔记");
    expect(host.querySelector('[aria-label="回答引用"]')).toBeNull();
    expect(host.querySelector('[aria-label="回答依据"]')).toBeTruthy();

    await click(chip!);
    const card = host.querySelector('[aria-label="我的笔记依据 1"]');
    expect(card?.textContent).toContain(noteEvidence[0].quote);
    expect(card?.textContent).toContain("不是原始资料");
    expect(card?.textContent).not.toContain("打开原文位置");
  });

  it("lets a completed source-only answer append to an existing knowledge page", async () => {
    const page: Note = {
      id: "knowledge-page",
      spaceId: source.spaceIds[0],
      title: "学习率复盘",
      content: "<p>已有内容</p>",
      kind: "knowledge",
      aiGenerated: false,
      status: "accepted",
      citations: [citations[0]],
      versions: [],
      contentRevision: 2,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const onAppendToKnowledgePage = vi.fn(() => page.title);
    await render({ notes: [page], onAppendToKnowledgePage });

    const save = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.replace(/\s+/gu, "") === "保存到知识页",
    );
    expect(save).toBeTruthy();
    await click(save!);

    const target = host.querySelector<HTMLSelectElement>("select[aria-label='选择要追加的知识页']");
    expect(target).toBeTruthy();
    await act(async () => {
      target!.value = page.id;
      target!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const append = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.replace(/\s+/gu, "") === "追加到知识页",
    );
    expect(append).toBeTruthy();
    await click(append!);

    expect(onAppendToKnowledgePage).toHaveBeenCalledWith({
      noteId: page.id,
      content: "资料中的两处结论。 [1]\n\n另一处结论。 [2]",
      citations,
      mode: "model",
    });
    expect(host.textContent).toContain("已追加到“学习率复盘”");
    expect(props.onSaveNote).not.toHaveBeenCalled();
  });
});
