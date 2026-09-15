// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import KnowledgeEvidenceAskPanel, {
  type KnowledgeEvidenceAskPanelProps,
} from "./knowledge-evidence-ask-panel";
import { createDemoWorkspace } from "@/lib/seed";
import type { Citation, Note, Source, WorkspaceData } from "@/lib/types";

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

describe("KnowledgeEvidenceAskPanel", () => {
  let host: HTMLDivElement;
  let root: Root;
  let data: WorkspaceData;
  let note: Note;
  let onAsk: ReturnType<typeof vi.fn<KnowledgeEvidenceAskPanelProps["onAsk"]>>;
  let onConversationChange: ReturnType<
    typeof vi.fn<KnowledgeEvidenceAskPanelProps["onConversationChange"]>
  >;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    data = createDemoWorkspace();
    note = acceptedKnowledgePage(data);
    onAsk = vi.fn<KnowledgeEvidenceAskPanelProps["onAsk"]>(async () => ({
      content: "原文检索结果。",
      citations: [citation(data.sources[0]!)],
      mode: "extractive",
    }));
    onConversationChange = vi.fn<KnowledgeEvidenceAskPanelProps["onConversationChange"]>();
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
        createElement(KnowledgeEvidenceAskPanel, {
          data,
          note,
          onAsk,
          onConversationChange,
          onOpenSource: vi.fn(),
          onBack: vi.fn(),
        }),
      );
    });
  }

  it("sends only the accepted page's fixed original source range, never its body", async () => {
    await render();
    const field = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="基于原始依据提问"]',
    )!;
    await act(async () => setText(field, "学习率为什么会让损失振荡？"));

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
    expect(
      host.querySelector<HTMLTextAreaElement>('textarea[aria-label="基于原始依据提问"]')?.disabled,
    ).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="发送问题"]')?.disabled).toBe(true);
  });
});
