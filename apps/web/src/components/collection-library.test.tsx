// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CollectionLibrary from "./collection-library";

describe("CollectionLibrary", () => {
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

  it("keeps each library's quantity inside its visual cover", async () => {
    const onOpenSpace = vi.fn();
    await act(async () => {
      root.render(
        createElement(CollectionLibrary, {
          spaces: [
            {
              id: "machine-learning",
              name: "机器学习",
              goal: "整理课程资料与阅读笔记",
              color: "#6844d9",
              archived: false,
              createdAt: "2026-09-13T00:00:00.000Z",
            },
          ],
          sources: [
            {
              id: "source-one",
              versionId: "version-one",
              title: "学习率",
              filename: "learning-rate.md",
              kind: "markdown",
              mime: "text/markdown",
              size: 10,
              hash: "hash-one",
              spaceIds: ["machine-learning"],
              tags: [],
              status: "ready",
              text: "正文",
              chunks: [],
              createdAt: "2026-09-13T00:00:00.000Z",
              updatedAt: "2026-09-13T00:00:00.000Z",
              deletedAt: null,
              aiAllowed: true,
              starred: false,
            },
          ],
          notes: [
            {
              id: "draft-page",
              spaceId: "machine-learning",
              title: "学习率草稿",
              content: "<p>待审核</p>",
              kind: "knowledge",
              status: "draft",
              citations: [],
              versions: [],
              createdAt: "2026-09-13T00:00:00.000Z",
              updatedAt: "2026-09-14T00:00:00.000Z",
              deletedAt: null,
            },
          ],
          onOpenSpace,
          onNewSpace: vi.fn(),
          onImport: vi.fn(),
          onNewNote: vi.fn(),
          onOpenAll: vi.fn(),
          query: "",
          onQueryChange: vi.fn(),
        }),
      );
    });

    const cover = host.querySelector<HTMLElement>(".collection-cover");
    const meta = host.querySelector<HTMLElement>(".collection-cover-meta");
    expect(cover?.contains(meta ?? null)).toBe(true);
    expect(meta?.textContent).toContain("1 份资料");
    expect(meta?.textContent).toContain("更新");
    expect(host.querySelector(".collection-cover-index")?.textContent).toBe("机");
    expect(host.querySelector(".collection-cover-review")?.textContent).toBe("待审核 1");
    expect(host.querySelector(".collection-book-meta")).toBeNull();

    await act(async () => {
      host.querySelector<HTMLButtonElement>(".collection-book")!.click();
    });
    expect(onOpenSpace).toHaveBeenCalledWith("machine-learning");
  });

  it("reveals archived libraries through the shelf filter", async () => {
    const onOpenSpace = vi.fn();
    await act(async () => {
      root.render(
        createElement(CollectionLibrary, {
          spaces: [
            {
              id: "active-space",
              name: "正在学习",
              goal: "当前主题",
              color: "#6844d9",
              archived: false,
              createdAt: "2026-09-13T00:00:00.000Z",
            },
            {
              id: "archived-space",
              name: "旧课程",
              goal: "已结束的主题",
              color: "#5f6c7b",
              archived: true,
              createdAt: "2026-09-12T00:00:00.000Z",
            },
          ],
          sources: [],
          onOpenSpace,
          onNewSpace: vi.fn(),
          onImport: vi.fn(),
          onNewNote: vi.fn(),
          onOpenAll: vi.fn(),
          query: "",
          onQueryChange: vi.fn(),
        }),
      );
    });

    expect(host.textContent).toContain("正在学习");
    expect(host.textContent).not.toContain("旧课程");
    const filter = host.querySelector<HTMLButtonElement>(".collection-space-filter")!;
    expect(filter.getAttribute("aria-pressed")).toBe("false");
    expect(filter.getAttribute("aria-label")).toBe("显示 1 个已归档知识库");

    await act(async () => filter.click());

    expect(filter.getAttribute("aria-pressed")).toBe("true");
    expect(filter.getAttribute("aria-label")).toBe("隐藏 1 个已归档知识库");
    expect(host.textContent).toContain("旧课程");
    expect(host.querySelector(".collection-cover-state")?.textContent).toBe("已归档");
    const archivedBook = host.querySelector<HTMLButtonElement>(
      '[aria-label="打开知识库旧课程，0 份资料，已归档"]',
    );
    expect(archivedBook).not.toBeNull();

    await act(async () => archivedBook!.click());
    expect(onOpenSpace).toHaveBeenCalledWith("archived-space");
  });
});
