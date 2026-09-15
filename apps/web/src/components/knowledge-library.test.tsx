// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Note, Space, WorkspaceData } from "@/lib/types";
import KnowledgeLibrary from "./knowledge-library";

const earlier = "2026-09-12T08:00:00.000Z";
const later = "2026-09-14T09:00:00.000Z";

function space(id: string, name: string): Space {
  return { id, name, goal: "", color: "#4B3FE3", archived: false, createdAt: earlier };
}

function note(id: string, spaceId: string, options: Partial<Note> = {}): Note {
  return {
    id,
    spaceId,
    title: `知识页 ${id}`,
    content: `<p>${id} 的正文</p>`,
    kind: "knowledge",
    aiGenerated: false,
    status: "accepted",
    citations: [],
    versions: [],
    createdAt: earlier,
    updatedAt: earlier,
    deletedAt: null,
    ...options,
  };
}

function workspace(): WorkspaceData {
  return {
    schemaVersion: 1,
    spaces: [space("space-a", "机器学习"), space("space-b", "设计")],
    sources: [],
    notes: [
      note("ai-draft", "space-a", {
        title: "理解学习率",
        content: "<p>学习率决定更新步长。</p>",
        aiGenerated: true,
        status: "draft",
        updatedAt: later,
        citations: [
          {
            sourceId: "source-a",
            versionId: "version-a",
            chunkId: "chunk-a",
            title: "机器学习入门",
            quote: "学习率决定步长",
            section: "正文",
          },
          {
            sourceId: "source-a",
            versionId: "version-a",
            chunkId: "chunk-b",
            title: "机器学习入门",
            quote: "过大时损失震荡",
            section: "正文",
          },
        ],
      }),
      note("manual-draft", "space-a", { status: "draft", content: "" }),
      note("saved", "space-b", { title: "排版基础" }),
    ],
    annotations: [],
    conversations: [],
    aiEnabled: true,
  };
}

describe("KnowledgeLibrary", () => {
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

  it("renders grouped knowledge semantics and opens the selected page", async () => {
    const onOpen = vi.fn();
    await act(async () => {
      root.render(
        createElement(KnowledgeLibrary, {
          data: workspace(),
          query: "",
          filter: "all",
          onQueryChange: vi.fn(),
          onFilterChange: vi.fn(),
          onOpen,
        }),
      );
    });

    expect(
      [...host.querySelectorAll(".knowledge-library-group-heading h3")].map(
        (item) => item.textContent,
      ),
    ).toEqual(["机器学习", "设计"]);
    expect(host.textContent).toContain("AI 草稿");
    expect(host.textContent).toContain("人工草稿");
    expect(host.textContent).toContain("已保存");
    expect(host.textContent).toContain("1 份关联资料");
    expect(host.textContent).toContain("尚未关联资料");
    expect(host.textContent).toContain("学习率决定更新步长。");
    expect(host.textContent).not.toContain("自由笔记");

    const card = host.querySelector<HTMLButtonElement>('[aria-label^="打开知识页 理解学习率"]');
    await act(async () => card!.click());
    expect(onOpen).toHaveBeenCalledWith("ai-draft");
  });

  it("exposes controlled status and search interactions with query-aware counts", async () => {
    const onFilterChange = vi.fn();
    const onQueryChange = vi.fn();
    await act(async () => {
      root.render(
        createElement(KnowledgeLibrary, {
          data: workspace(),
          spaceId: "space-a",
          query: "学习率",
          filter: "pending",
          onQueryChange,
          onFilterChange,
          onOpen: vi.fn(),
        }),
      );
    });

    const filters = host.querySelector('[role="group"][aria-label="按审核状态筛选知识页"]');
    expect(filters?.textContent).toContain("全部1");
    expect(filters?.textContent).toContain("待审核1");
    expect(filters?.textContent).toContain("已保存0");
    const saved = [...filters!.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("已保存"),
    );
    await act(async () => saved!.click());
    expect(onFilterChange).toHaveBeenCalledWith("saved");

    const search = host.querySelector<HTMLInputElement>('[aria-label="搜索知识页"]')!;
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      valueSetter.call(search, "梯度下降");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onQueryChange).toHaveBeenCalledWith("梯度下降");

    const clear = host.querySelector<HTMLButtonElement>('[aria-label="清除知识页搜索"]')!;
    await act(async () => clear.click());
    expect(onQueryChange).toHaveBeenCalledWith("");
  });

  it("uses knowledge-specific empty states and recovery actions", async () => {
    const onQueryChange = vi.fn();
    const onFilterChange = vi.fn();
    const data = workspace();

    await act(async () => {
      root.render(
        createElement(KnowledgeLibrary, {
          data,
          query: "不存在",
          filter: "all",
          onQueryChange,
          onFilterChange,
          onOpen: vi.fn(),
        }),
      );
    });
    expect(host.textContent).toContain("没有找到匹配的知识页");
    expect(host.textContent).not.toContain("没有找到匹配的笔记");
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "清除搜索")!
        .click();
    });
    expect(onQueryChange).toHaveBeenCalledWith("");

    await act(async () => {
      root.render(
        createElement(KnowledgeLibrary, {
          data: { ...data, notes: data.notes.filter((item) => item.status === "draft") },
          query: "",
          filter: "saved",
          onQueryChange,
          onFilterChange,
          onOpen: vi.fn(),
        }),
      );
    });
    expect(host.textContent).toContain("还没有已保存知识页");
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "查看全部知识页")!
        .click();
    });
    expect(onFilterChange).toHaveBeenCalledWith("all");
  });
});
