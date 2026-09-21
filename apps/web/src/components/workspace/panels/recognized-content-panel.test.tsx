// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Source } from "@/lib/types";
import RecognizedContentPanel from "./recognized-content-panel";

function sourceWithChunks(count: number): Source {
  const sourceId = "source-long";
  const versionId = "version-long";
  return {
    id: sourceId,
    versionId,
    title: "长文档",
    filename: "long.pdf",
    kind: "pdf",
    mime: "application/pdf",
    size: 1024,
    hash: "hash",
    spaceIds: [],
    tags: [],
    status: "ready",
    coverage: { captureScope: "full", parseState: "complete" },
    text: "长文档正文",
    chunks: Array.from({ length: count }, (_, index) => ({
      id: `chunk-${index + 1}`,
      sourceId,
      versionId,
      text: index === count - 1 ? "唯一的量子纠缠内容" : `普通正文 ${index + 1}`,
      section: `第 ${index + 1} 节`,
      page: index + 1,
      order: index,
    })),
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    deletedAt: null,
    aiAllowed: true,
    starred: false,
    pageCount: count,
    parsedPages: count,
  };
}

describe("RecognizedContentPanel long documents", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(count = 65) {
    await act(async () => {
      root.render(
        createElement(RecognizedContentPanel, {
          source: sourceWithChunks(count),
          onOpenSource: vi.fn(),
        }),
      );
    });
  }

  it("renders long content in bounded batches", async () => {
    await render();

    expect(host.querySelectorAll(".recognized-content-chunk")).toHaveLength(30);
    expect(host.textContent).toContain("共 65 段，当前显示 30 段");

    const more = host.querySelector<HTMLButtonElement>(".recognized-content-more")!;
    expect(more.textContent).toContain("继续显示 30 段");
    await act(async () => more.click());

    expect(host.querySelectorAll(".recognized-content-chunk")).toHaveLength(60);
    expect(host.textContent).toContain("共 65 段，当前显示 60 段");
  });

  it("searches all chunks instead of only the rendered batch", async () => {
    await render();
    const input = host.querySelector<HTMLInputElement>('[aria-label="搜索已识别内容"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

    await act(async () => {
      setValue.call(input, "量子纠缠");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(host.querySelectorAll(".recognized-content-chunk")).toHaveLength(1);
    expect(host.textContent).toContain("找到 1 段，当前显示 1 段");
    expect(host.textContent).toContain("唯一的量子纠缠内容");
  });
});
