// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchCandidate } from "@/lib/search-types";
import type { Note, Source, SourceKind, WorkspaceData } from "@/lib/types";

const cloud = vi.hoisted(() => ({ searchCloud: vi.fn() }));
vi.mock("@/lib/cloud", () => ({ searchCloud: cloud.searchCloud }));

import WorkspaceSearch, { type WorkspaceSearchProps } from "./workspace-search";

const now = "2026-09-13T12:00:00.000Z";
const space = {
  id: "calculus",
  name: "微积分",
  goal: "",
  color: "#6544d9",
  archived: false,
  createdAt: now,
};

function source(id: string, kind: SourceKind, tags: string[], starred: boolean): Source {
  const versionId = `${id}-version`;
  return {
    id,
    versionId,
    title: `微积分资料 ${id}`,
    filename: `${id}.${kind === "markdown" ? "md" : kind}`,
    kind,
    mime: "text/plain",
    size: 20,
    hash: `${id}-hash`,
    spaceIds: [space.id],
    tags,
    status: "ready",
    text: `微积分资料 ${id} 正文`,
    chunks: [
      {
        id: `${id}-chunk`,
        sourceId: id,
        versionId,
        text: `微积分资料 ${id} 正文`,
        section: "正文",
        order: 0,
      },
    ],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    aiAllowed: true,
    starred,
  };
}

function note(id: string, kind: Note["kind"]): Note {
  return {
    id,
    spaceId: space.id,
    title: `微积分${kind === "knowledge" ? "知识页" : "笔记"}`,
    content: `<p>微积分 ${id} 正文</p>`,
    kind,
    status: "accepted",
    citations: [],
    versions: [],
    contentRevision: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function fixture(): WorkspaceData {
  return {
    schemaVersion: 1,
    spaces: [space],
    sources: [
      source("starred-pdf", "pdf", ["考试", "重点", "微积分"], true),
      source("unstarred-pdf", "pdf", ["考试", "重点", "微积分"], false),
      source("starred-web", "web", ["考试", "重点", "微积分"], true),
      source("missing-tag-pdf", "pdf", ["考试", "微积分"], true),
    ],
    notes: [note("personal-note", "note"), note("knowledge-page", "knowledge")],
    annotations: [],
    conversations: [],
    aiEnabled: true,
    importJobs: [],
  };
}

describe("WorkspaceSearch external library filters", () => {
  let host: HTMLDivElement;
  let root: Root;
  let data: WorkspaceData;
  let props: WorkspaceSearchProps;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    cloud.searchCloud.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    data = fixture();
    props = {
      data,
      query: "微积分",
      scope: { kind: "space", spaceId: space.id },
      cloudSaved: false,
      intent: "keyword",
      onOpen: vi.fn(),
      onAskSources: vi.fn(),
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(next: Partial<WorkspaceSearchProps> = {}) {
    props = { ...props, ...next };
    await act(async () => root.render(createElement(WorkspaceSearch, props)));
  }

  function titles() {
    return [...host.querySelectorAll(".workspace-search-hit-heading strong")].map(
      (item) => item.textContent,
    );
  }

  it("presents Markdown excerpts without changing original search locators or plain text", async () => {
    const markdown = source("markdown", "markdown", [], false);
    markdown.text = "## 微积分 **C#** 与 #学习标签";
    markdown.chunks[0]!.text = markdown.text;
    const plain = source("plain", "text", [], false);
    plain.text = "## 微积分 C# 与 #学习标签";
    plain.chunks[0]!.text = plain.text;
    data = { ...data, sources: [markdown, plain], notes: [] };
    await render({ data });

    const hits = [...host.querySelectorAll<HTMLButtonElement>(".workspace-search-hit")];
    const rendered = hits.find((hit) => hit.textContent?.includes("微积分资料 markdown"))!;
    expect(rendered.querySelector(".workspace-search-snippet")?.textContent).toBe(
      "微积分 C# 与 #学习标签",
    );
    const literal = hits.find((hit) => hit.textContent?.includes("微积分资料 plain"))!;
    expect(literal.querySelector(".workspace-search-snippet")?.textContent).toBe(plain.text);
    await act(async () => rendered.click());
    expect(props.onOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        snippet: markdown.text,
        objectId: markdown.id,
        versionId: markdown.versionId,
        blockId: markdown.chunks[0]!.id,
        locator: expect.objectContaining({ kind: "chunk", order: 0, section: "正文" }),
      }),
    );
    expect(markdown.chunks[0]!.text).toBe("## 微积分 **C#** 与 #学习标签");
  });

  it("uses source kind, every library tag, and favorite state for local results", async () => {
    await render({
      externalFilters: {
        sourceKinds: ["pdf"],
        tags: ["考试", "重点"],
        starred: true,
      },
    });

    expect(titles()).toEqual(["微积分资料 starred-pdf"]);
    expect(host.textContent).not.toContain("微积分笔记");
    expect(host.textContent).not.toContain("微积分知识页");
  });

  it("filters each object's own creation time without excluding readable notes", async () => {
    data.sources[0]!.createdAt = "2026-09-12T12:00:00.000Z";
    for (const source of data.sources.slice(1)) source.createdAt = "2026-08-01T12:00:00.000Z";

    await render({
      externalFilters: { created: { from: "2026-09-06T12:00:00.000Z" } },
    });

    expect(titles()).toEqual(
      expect.arrayContaining(["微积分资料 starred-pdf", "微积分笔记", "微积分知识页"]),
    );
    expect(titles()).toHaveLength(3);
  });

  it("allows filtering notes before entering a keyword, without sending an empty cloud query", async () => {
    await render({
      query: "",
      userId: "owner-a",
      cloudSaved: true,
      externalFilters: { types: ["note"] },
    });
    expect(titles()).toEqual(["微积分笔记"]);
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes("搜索云端"),
    );
    expect(button?.disabled).toBe(true);
    await act(async () => button!.click());
    expect(cloud.searchCloud).not.toHaveBeenCalled();
  });

  it("filters accepted knowledge pages by their own date even when AI is off", async () => {
    data.aiEnabled = false;
    data.sources.forEach((source) => {
      source.createdAt = "2026-08-01T00:00:00.000Z";
      source.aiAllowed = false;
    });
    data.notes.push({ ...note("draft-page", "knowledge"), status: "draft", title: "微积分待审核" });
    await render({
      externalFilters: {
        types: ["knowledge"],
        created: { from: "2026-09-13T12:00:00.000Z", to: "2026-09-14T00:00:00.000Z" },
      },
    });
    expect(titles()).toEqual(["微积分知识页"]);
    data = {
      ...data,
      notes: data.notes.map((item) => ({ ...item, createdAt: "2026-09-14T00:00:00.000Z" })),
    };
    await render({ data });
    expect(titles()).toEqual([]);
  });

  it("keeps tags, favorites and legacy source types source-specific", async () => {
    for (const constraint of [
      { tags: ["微积分"] },
      { starred: true },
      { starred: false },
      { sourceKinds: ["pdf" as const] },
    ]) {
      await render({ externalFilters: { types: ["note", "knowledge"], ...constraint } });
      expect(titles()).toEqual([]);
    }
  });

  it("supports mixed content types without treating derived content as AI evidence", async () => {
    await render({ externalFilters: { types: ["pdf", "note"] } });
    expect(titles()).toHaveLength(4);
    expect(titles()).toContain("微积分笔记");
    expect(titles()).not.toContain("微积分知识页");
    await render({
      intent: "question",
      userId: "owner-a",
      cloudSaved: true,
      data: { ...data, semanticSearch: true },
      externalFilters: { types: ["knowledge"] },
    });
    expect(titles()).toEqual([]);
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes("语义找资料"),
    );
    expect(!button || button.disabled).toBe(true);
    expect(cloud.searchCloud).not.toHaveBeenCalled();
  });

  it("sends derived type and date constraints to the cloud and materializes only that type", async () => {
    const page = data.notes[1]!;
    cloud.searchCloud.mockResolvedValue({
      candidates: [
        {
          kind: "knowledge",
          objectId: page.id,
          revision: 1,
          updatedAt: page.updatedAt,
          blockId: null,
          score: 100,
        },
      ],
      mode: "keyword",
      revision: 1,
    });
    await render({
      userId: "owner-a",
      cloudSaved: true,
      externalFilters: { types: ["knowledge"], created: { from: "2026-09-06T12:00:00.000Z" } },
    });
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes("搜索云端"),
    );
    await act(async () => button!.click());
    expect(cloud.searchCloud).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({
          types: ["knowledge"],
          created: { from: "2026-09-06T12:00:00.000Z" },
        }),
      }),
      "keyword",
      "owner-a",
      expect.any(AbortSignal),
    );
    expect(titles()).toEqual(["微积分知识页"]);
    expect(host.textContent).toContain("云端关键词检索");
  });

  it("sends kind and AND tag constraints to cloud search, then removes unstarred candidates", async () => {
    const starred = data.sources[0]!;
    const unstarred = data.sources[1]!;
    const candidates: SearchCandidate[] = [starred, unstarred].map((item) => ({
      kind: "source",
      objectId: item.id,
      versionId: item.versionId,
      blockId: item.chunks[0]!.id,
      score: 100,
    }));
    cloud.searchCloud.mockResolvedValue({
      candidates,
      mode: "keyword",
      revision: 1,
    });
    await render({
      userId: "learner",
      cloudSaved: true,
      externalFilters: {
        sourceKinds: ["pdf"],
        tags: ["重点", "考试"],
        starred: true,
        created: { from: "2026-09-06T12:00:00.000Z" },
      },
    });

    const cloudButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("搜索云端"),
    );
    expect(cloudButton).toBeTruthy();
    await act(async () => {
      cloudButton!.click();
      await Promise.resolve();
    });

    expect(cloud.searchCloud).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "微积分",
        scope: { kind: "space", spaceId: space.id },
        filters: expect.objectContaining({
          types: ["pdf"],
          tags: ["重点", "考试"],
          created: { from: "2026-09-06T12:00:00.000Z" },
        }),
      }),
      "keyword",
      "learner",
      expect.any(AbortSignal),
    );
    expect(titles()).toEqual(["微积分资料 starred-pdf"]);
  });

  it("finds source excerpts from a natural-language question and hands off only the exact selection", async () => {
    const onAskSources = vi.fn();
    await render({
      intent: "question",
      query: "哪份微积分资料讲过正文？",
      onAskSources,
    });

    expect(titles()).toEqual([
      "微积分资料 missing-tag-pdf",
      "微积分资料 starred-pdf",
      "微积分资料 starred-web",
      "微积分资料 unstarred-pdf",
    ]);
    expect(host.textContent).not.toContain("微积分笔记");
    expect(host.textContent).not.toContain("微积分知识页");
    expect(host.textContent).toContain("不是 AI 回答");
    expect(cloud.searchCloud).not.toHaveBeenCalled();

    const first = host.querySelector<HTMLInputElement>(
      '[aria-label="将 微积分资料 starred-pdf 加入提问"]',
    );
    const second = host.querySelector<HTMLInputElement>(
      '[aria-label="将 微积分资料 starred-web 加入提问"]',
    );
    expect(first?.disabled).toBe(false);
    await act(async () => {
      first!.click();
      second!.click();
    });

    const askButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("基于这些资料提问"),
    );
    await act(async () => askButton!.click());
    expect(onAskSources).toHaveBeenCalledWith({
      question: "哪份微积分资料讲过正文？",
      sourceIds: ["starred-pdf", "starred-web"],
    });
  });

  it("keeps locally readable matches visible while blocking sources that are not eligible for AI", async () => {
    data.sources[0]!.aiAllowed = false;
    data.sources[1]!.status = "parsing";
    await render({ intent: "question" });

    expect(titles()).toContain("微积分资料 starred-pdf");
    expect(titles()).toContain("微积分资料 unstarred-pdf");
    expect(
      host.querySelector<HTMLInputElement>('[aria-label="将 微积分资料 starred-pdf 加入提问"]')
        ?.disabled,
    ).toBe(true);
    expect(
      host.querySelector<HTMLInputElement>('[aria-label="将 微积分资料 unstarred-pdf 加入提问"]')
        ?.disabled,
    ).toBe(true);
    expect(host.textContent).toContain("此资料已禁止 AI 使用");
    expect(host.textContent).toContain("正文或索引尚未可用");
  });

  it("retains the local fallback and labels it after semantic search fails", async () => {
    data.semanticSearch = true;
    cloud.searchCloud.mockRejectedValue(new Error("语义索引暂不可用"));
    await render({
      intent: "question",
      userId: "learner",
      cloudSaved: true,
    });

    const semanticButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("语义找资料"),
    );
    await act(async () => {
      semanticButton!.click();
      await Promise.resolve();
    });

    expect(cloud.searchCloud).toHaveBeenCalledWith(
      expect.objectContaining({ query: "微积分" }),
      "semantic",
      "learner",
      expect.any(AbortSignal),
    );
    expect(titles()).toHaveLength(4);
    expect(host.textContent).toContain("当前浏览器关键词匹配");
    expect(host.textContent).toContain("未生成回答");
    expect(host.textContent).toContain("语义索引暂不可用");
  });
});
