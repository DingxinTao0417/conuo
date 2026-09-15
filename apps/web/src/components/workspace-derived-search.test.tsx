// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import type { Citation, Note, WorkspaceData } from "@/lib/types";

let workspaceStore: Record<string, unknown>;
const cloud = vi.hoisted(() => ({ searchCloud: vi.fn() }));

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/use-workspace", () => ({ useWorkspace: () => workspaceStore }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signOut: vi.fn() } }),
}));
vi.mock("@/lib/cloud", () => ({
  isCloudConfigured: () => false,
  searchCloud: cloud.searchCloud,
  previewAccountDeletion: vi.fn(),
  requestAccountDeletion: vi.fn(),
}));
vi.mock("@/lib/use-knowledge-update-review-drafts", () => ({
  useKnowledgeUpdateReviewDrafts: () => ({
    draftsFor: () => ({}),
    change: vi.fn(),
    removeChanges: vi.fn(),
    retry: vi.fn(),
    status: { kind: "idle", message: "" },
  }),
}));
vi.mock("./collection-library", () => ({
  default: () => null,
  CollectionActions: () => null,
}));
vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./indexing-panel", () => ({ default: () => null }));
vi.mock("./web-import-form", () => ({ default: () => null }));

import Workspace from "./workspace";

const now = Date.parse("2026-09-15T12:00:00.000Z");
const day = 24 * 60 * 60 * 1000;
const recentNoteId = "recent-note";
const recentKnowledgeId = "recent-knowledge";

function makeNote(
  data: WorkspaceData,
  id: string,
  kind: Note["kind"],
  age: number,
  extra: Partial<Note> = {},
): Note {
  return {
    id,
    spaceId: data.spaces[0]!.id,
    title: `微积分${kind === "knowledge" ? "知识页" : "笔记"} ${id}`,
    content: `<p>微积分学习记录 ${id}：用自己的话解释导数。</p>`,
    kind,
    status: "accepted",
    citations: [],
    versions: [],
    contentRevision: 1,
    createdAt: new Date(now - age).toISOString(),
    // Recent editing must not turn an old creation into a new creation.
    updatedAt: new Date(now).toISOString(),
    deletedAt: null,
    ...extra,
  };
}

function citation(data: WorkspaceData, index: number): Citation {
  const source = data.sources[index]!;
  const chunk = source.chunks[0]!;
  return {
    sourceId: source.id,
    versionId: source.versionId,
    chunkId: chunk.id,
    title: source.title,
    quote: chunk.text,
    section: chunk.section,
  };
}

function fixture(): WorkspaceData {
  const data = createDemoWorkspace();
  const [recent, old] = data.sources;
  for (const [index, source] of data.sources.entries()) {
    source.title = `微积分资料 ${index === 0 ? "近期" : "旧资料"}`;
    source.createdAt = new Date(now - (index === 0 ? 2 : 45) * day).toISOString();
    source.updatedAt = new Date(now).toISOString();
    source.tags = [index === 0 ? "考试" : "课程"];
    source.starred = index === 0;
    source.text = `微积分资料 ${index} 原文：导数表示变化率。`;
    source.chunks = [
      {
        id: `source-${index}-chunk`,
        sourceId: source.id,
        versionId: source.versionId,
        text: source.text,
        section: "正文",
        order: 0,
      },
    ];
  }
  expect(recent).toBeTruthy();
  expect(old).toBeTruthy();
  data.spaces.push({ ...data.spaces[0]!, id: "other-space", name: "其他知识库" });
  data.notes = [
    makeNote(data, recentNoteId, "note", 2 * day, { citations: [citation(data, 1)] }),
    makeNote(data, "old-note", "note", 45 * day, { citations: [citation(data, 0)] }),
    makeNote(data, "boundary-note", "note", 7 * day),
    makeNote(data, "outside-window-note", "note", 7 * day + 1),
    makeNote(data, recentKnowledgeId, "knowledge", 3 * day, {
      citations: [citation(data, 1)],
      aiGenerated: true,
    }),
    makeNote(data, "old-knowledge", "knowledge", 45 * day),
    makeNote(data, "draft-knowledge", "knowledge", day, { status: "draft" }),
    makeNote(data, "other-space-note", "note", day, { spaceId: "other-space" }),
  ];
  return data;
}

describe("Workspace ordinary search for notes and knowledge pages", () => {
  let host: HTMLDivElement;
  let root: Root;
  let data: WorkspaceData;
  let spaceId: string;
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: vi.fn(),
    });
    nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    cloud.searchCloud.mockReset();
    data = fixture();
    spaceId = data.spaces[0]!.id;
    workspaceStore = {
      token: 1,
      data,
      ready: true,
      status: "local",
      localCacheMode: "normal",
      user: undefined,
      update: vi.fn(),
      updateDurably: vi.fn(),
      anonymousMigration: { kind: "none", canMigrate: false },
      signOut: vi.fn(),
      signOutState: { kind: "ready", canSync: false, canKeepLocalDraft: false },
      ask: vi.fn(),
      cancelImport: vi.fn(),
      checkOrganization: vi.fn(),
      discardAccount: vi.fn(),
      error: "",
      importFile: vi.fn(),
      organize: vi.fn(),
      previewSourcePurge: vi.fn(),
      purgeSource: vi.fn(),
      purging: false,
      refreshOrganizationStatus: vi.fn(),
      replaceFile: vi.fn(),
      resolveNoteConflicts: vi.fn(),
      restoreBackup: vi.fn(),
      retry: vi.fn(async () => {}),
      retryImport: vi.fn(),
      retryOrganization: vi.fn(),
      sourceBlob: vi.fn(async () => undefined),
      stopOrganization: vi.fn(),
      useRemote: vi.fn(),
    };
    window.history.replaceState(null, "", `#library/${spaceId}`);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await render();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render() {
    await act(async () => root.render(createElement(Workspace)));
  }

  function button(text: string) {
    const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === text,
    );
    expect(found, text).toBeInstanceOf(HTMLButtonElement);
    return found!;
  }

  /** The type and time filters share the toolbar's single filter popover. */
  async function openFilterMenu() {
    const trigger = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.getAttribute("aria-label")?.startsWith("筛选资料"),
    );
    expect(trigger, "filter trigger").toBeInstanceOf(HTMLButtonElement);
    if (trigger!.getAttribute("aria-expanded") !== "true") await act(async () => trigger!.click());
  }

  async function filterSelect(label: string) {
    await openFilterMenu();
    const found = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
    expect(found, label).toBeInstanceOf(HTMLSelectElement);
    return found!;
  }

  async function choose(label: string, value: string) {
    const control = await filterSelect(label);
    expect([...control.options].some((option) => option.value === value)).toBe(true);
    await act(async () => {
      control.value = value;
      control.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  async function query(value: string) {
    const input = host.querySelector<HTMLInputElement>('input[aria-label="搜索资料"]');
    expect(input).toBeInstanceOf(HTMLInputElement);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function titles() {
    return [...host.querySelectorAll(".workspace-search-hit-heading strong")].map(
      (item) => item.textContent,
    );
  }

  function title(id: string) {
    return data.notes.find((note) => note.id === id)!.title;
  }

  function expectDerivedView() {
    expect(host.querySelector('[aria-label="内容搜索结果"]')).toBeTruthy();
    expect(host.querySelector(".source-list")).toBeNull();
    expect(host.querySelector(".source-grid")).toBeNull();
  }

  it("browses notes before typing, retains the type when clearing a query, and stays in scope", async () => {
    await choose("筛选资料类型", "note");
    expectDerivedView();
    expect(titles()).toHaveLength(4);
    expect(titles()).toContain(title(recentNoteId));
    expect(titles()).not.toContain(title("other-space-note"));
    expect(titles()).not.toContain(title(recentKnowledgeId));
    expect(window.location.hash).toBe(`#library/${spaceId}?filter=note`);

    await query(recentNoteId);
    expect(titles()).toEqual([title(recentNoteId)]);
    expect((await filterSelect("筛选资料类型")).value).toBe("note");
    expect(window.location.hash).toContain(`q=${recentNoteId}`);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="清空搜索"]')!.click(),
    );
    expect((await filterSelect("筛选资料类型")).value).toBe("note");
    expect(titles()).toHaveLength(4);
    expectDerivedView();
    expect(window.location.hash).toBe(`#library/${spaceId}?filter=note`);
    expect(cloud.searchCloud).not.toHaveBeenCalled();
  });

  it("shows accepted knowledge with AI disabled while excluding draft knowledge", async () => {
    data = {
      ...data,
      aiEnabled: false,
      sources: data.sources.map((source) => ({ ...source, aiAllowed: false })),
    };
    workspaceStore = { ...workspaceStore, data };
    await render();
    await choose("筛选资料类型", "knowledge");
    expectDerivedView();
    expect(titles()).toEqual(
      expect.arrayContaining([title(recentKnowledgeId), title("old-knowledge")]),
    );
    expect(titles()).toHaveLength(2);
    expect(titles()).not.toContain(title("draft-knowledge"));
    expect(host.textContent).toContain("待审核草稿不参与普通搜索");
    expect(host.querySelector(".workspace-question-results")).toBeNull();
  });

  it("filters each object's own creation time, including the exact rolling boundary", async () => {
    await choose("按添加时间筛选资料", "7d");
    await query("微积分");
    expect(titles()).toEqual(
      expect.arrayContaining([
        data.sources[0]!.title,
        title(recentNoteId),
        title("boundary-note"),
        title(recentKnowledgeId),
      ]),
    );
    expect(titles()).toHaveLength(4);
    expect(titles()).not.toContain(data.sources[1]!.title);
    expect(titles()).not.toContain(title("old-note"));
    expect(titles()).not.toContain(title("outside-window-note"));

    // These recent derived objects cite an old source. Its creation date must
    // not replace the date of the note or knowledge page being searched.
    await choose("筛选资料类型", "knowledge");
    expect(titles()).toEqual([title(recentKnowledgeId)]);
    await choose("筛选资料类型", "note");
    expect(titles()).toEqual(expect.arrayContaining([title(recentNoteId), title("boundary-note")]));
    expect(titles()).toHaveLength(2);
  });

  it("resets derived types on question mode and restores keyword mode from hash and history", async () => {
    await choose("筛选资料类型", "note");
    await choose("按添加时间筛选资料", "7d");
    await query("微积分");
    const noteRoute = window.location.hash;
    await act(async () => button("用问题找资料").click());
    expect((await filterSelect("筛选资料类型")).value).toBe("all");
    expect(button("用问题找资料").getAttribute("aria-pressed")).toBe("true");
    expect((await filterSelect("筛选资料类型")).querySelector('option[value="note"]')).toBeNull();
    expect(host.querySelector(".workspace-question-results")).toBeTruthy();
    expect(window.location.hash).not.toContain("filter=note");

    await act(async () => {
      window.history.replaceState(null, "", noteRoute);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(button("关键词").getAttribute("aria-pressed")).toBe("true");
    expect((await filterSelect("筛选资料类型")).value).toBe("note");
    expect((await filterSelect("按添加时间筛选资料")).value).toBe("7d");
    expect(titles()).toHaveLength(2);
    expectDerivedView();

    await act(async () => button("用问题找资料").click());
    await act(async () => {
      window.history.replaceState(null, "", `#library/${spaceId}?filter=knowledge&time=7d`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(button("关键词").getAttribute("aria-pressed")).toBe("true");
    expect((await filterSelect("筛选资料类型")).value).toBe("knowledge");
    expect(titles()).toEqual([title(recentKnowledgeId)]);
    expectDerivedView();
  });

  it("returns from an opened note to the reviewed library type, date and query", async () => {
    await choose("筛选资料类型", "note");
    await choose("按添加时间筛选资料", "7d");
    await query(recentNoteId);
    const returnRoute = window.location.hash;
    expect(titles()).toEqual([title(recentNoteId)]);
    await act(async () => host.querySelector<HTMLButtonElement>(".workspace-search-hit")!.click());
    expect(window.location.hash).toBe(`#note/${recentNoteId}`);
    expect(host.querySelector<HTMLInputElement>('[aria-label="笔记标题"]')?.value).toBe(
      title(recentNoteId),
    );
    await act(async () => button("返回").click());
    expect(window.location.hash).toBe(returnRoute);
    expect((await filterSelect("筛选资料类型")).value).toBe("note");
    expect((await filterSelect("按添加时间筛选资料")).value).toBe("7d");
    expect(host.querySelector<HTMLInputElement>('[aria-label="搜索资料"]')?.value).toBe(
      recentNoteId,
    );
    expect(titles()).toEqual([title(recentNoteId)]);
    expectDerivedView();
  });

  it("keeps an in-flight cloud search and its creation window across an unrelated toast", async () => {
    let resolveSearch!: (value: unknown) => void;
    cloud.searchCloud.mockReturnValue(
      new Promise((resolve) => {
        resolveSearch = resolve;
      }),
    );
    const retry = vi.fn(async () => {
      throw new Error("连接检查未完成");
    });
    workspaceStore = {
      ...workspaceStore,
      status: "cloud",
      user: { id: "owner-a", email: "owner-a@example.com" },
      error: "原件连接需要重新核对",
      retry,
    };
    await render();
    await choose("筛选资料类型", "note");
    await choose("按添加时间筛选资料", "7d");
    expect(button("搜索云端").disabled).toBe(true);
    await query("微积分");
    await act(async () => button("搜索云端").click());
    expect(cloud.searchCloud).toHaveBeenCalledOnce();
    const [request, mode, userId, signal] = cloud.searchCloud.mock.calls[0]!;
    expect(request.filters).toMatchObject({
      types: ["note"],
      created: { from: new Date(now - 7 * day).toISOString() },
    });
    expect(mode).toBe("keyword");
    expect(userId).toBe("owner-a");
    expect(signal.aborted).toBe(false);

    nowSpy.mockReturnValue(now + 60 * 60 * 1000);
    await act(async () => button("重新连接").click());
    expect(host.querySelector(".toast")?.textContent).toContain("连接检查未完成");
    expect(retry).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(false);
    expect(titles()).toContain(title("boundary-note"));

    const note = data.notes.find((item) => item.id === recentNoteId)!;
    await act(async () =>
      resolveSearch({
        mode: "keyword",
        revision: 1,
        candidates: [
          {
            kind: "note",
            objectId: note.id,
            revision: note.contentRevision,
            updatedAt: note.updatedAt,
            blockId: null,
            score: 100,
          },
        ],
      }),
    );
    expect(titles()).toEqual([title(recentNoteId)]);
    expect(host.querySelector(".workspace-search-controls")?.textContent).toContain(
      "云端关键词检索",
    );
    expect(cloud.searchCloud).toHaveBeenCalledOnce();
  });

  it("preserves ordinary source filtering and restores its source rows after clearing search", async () => {
    expect(
      [...host.querySelectorAll(".source-row .source-open b")].map((item) => item.textContent),
    ).toHaveLength(2);
    await choose("筛选资料类型", "markdown");
    await choose("按添加时间筛选资料", "7d");
    expect(host.querySelector(".workspace-search")).toBeNull();
    expect(host.querySelector(".source-row .source-open b")?.textContent).toBe(
      data.sources[0]!.title,
    );
    await query("微积分");
    expect(titles()).toEqual([data.sources[0]!.title]);
    expect(titles()).not.toContain(title(recentNoteId));
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="清空搜索"]')!.click(),
    );
    expect((await filterSelect("筛选资料类型")).value).toBe("markdown");
    expect((await filterSelect("按添加时间筛选资料")).value).toBe("7d");
    expect(host.querySelector(".workspace-search")).toBeNull();
    expect(host.querySelectorAll(".source-row")).toHaveLength(1);
    expect(window.location.hash).toBe(`#library/${spaceId}?filter=markdown&time=7d`);
  });
});
