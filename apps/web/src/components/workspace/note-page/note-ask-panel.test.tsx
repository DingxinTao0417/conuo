// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import { serverScopeFor } from "@/lib/ask-scopes";
import type { Citation, Note, Source, WorkspaceData } from "@/lib/types";
import NoteAskPanel, { type NoteAskPanelProps } from "./note-ask-panel";

function citation(source: Source): Citation {
  const chunk = source.chunks[0]!;
  return {
    sourceId: source.id,
    versionId: source.versionId,
    chunkId: chunk.id,
    title: source.title,
    quote: chunk.text,
    page: chunk.page,
    section: chunk.section,
  };
}

function acceptedKnowledgePage(data: WorkspaceData): Note {
  const now = "2026-09-13T12:00:00.000Z";
  return {
    id: "knowledge-page",
    spaceId: data.spaces[0]!.id,
    title: "学习率知识页",
    content: "<p>绝不能进入 AI 请求的知识页正文。</p>",
    kind: "knowledge",
    aiGenerated: true,
    status: "accepted",
    citations: [citation(data.sources[0]!)],
    versions: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function setText(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("NoteAskPanel", () => {
  let host: HTMLDivElement;
  let root: Root;
  let data: WorkspaceData;
  let note: Note;
  let onAsk: ReturnType<typeof vi.fn<NoteAskPanelProps["onAsk"]>>;
  let onConversationChange: ReturnType<typeof vi.fn<NoteAskPanelProps["onConversationChange"]>>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    data = createDemoWorkspace();
    note = acceptedKnowledgePage(data);
    onAsk = vi.fn<NoteAskPanelProps["onAsk"]>(async () => ({
      content: "原文检索结果。",
      citations: [citation(data.sources[0]!)],
      mode: "extractive",
    }));
    onConversationChange = vi.fn<NoteAskPanelProps["onConversationChange"]>();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render() {
    await act(async () => {
      root.render(
        createElement(NoteAskPanel, {
          data,
          note,
          onAsk,
          onConversationChange,
          onOpenSource: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
  }

  const composer = () =>
    host.querySelector<HTMLTextAreaElement>('textarea[aria-label="基于原始依据提问"]')!;

  it("sends only the accepted page's fixed original source range, never its body", async () => {
    await render();
    await act(async () => setText(composer(), "学习率为什么会让损失振荡？"));

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="发送问题"]')!.click();
      await Promise.resolve();
    });

    const source = data.sources[0]!;
    expect(onAsk).toHaveBeenCalledOnce();
    expect(onAsk.mock.calls[0]?.[0]).toMatchObject({
      scope: "sources",
      sourceIds: [source.id],
      sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
      spaceId: note.spaceId,
    });
    expect(JSON.stringify(onAsk.mock.calls[0]?.[0])).not.toContain("知识页正文");
    const saved = onConversationChange.mock.calls.at(-1)?.[0];
    expect(saved?.sourceId).toBeUndefined();
    expect(saved?.messages.at(-1)?.attempt?.scopeSnapshot).toMatchObject({
      scope: "sources",
      sourceIds: [source.id],
      sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
      spaceId: note.spaceId,
    });
  });

  it("explains and disables asking when no current original source remains", async () => {
    data.sources[0] = { ...data.sources[0]!, aiAllowed: false };
    await render();

    expect(host.textContent).toContain("没有可用于问答的原始资料");
    expect(composer().disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="发送问题"]')?.disabled).toBe(true);
  });

  it("offers the page's own range as the only option and never a wider one", async () => {
    await render();

    // A single allowed range is stated, not offered in a picker that could be widened.
    expect(host.querySelector(".reader-scope select")).toBeNull();
    expect(host.querySelector(".reader-scope-fixed")?.textContent).toContain("本页引用的资料");
    expect(serverScopeFor("note-evidence")).toBe("sources");
  });
});
