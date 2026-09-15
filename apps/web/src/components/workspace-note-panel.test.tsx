// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import type { Citation, Note } from "@/lib/types";

const noteId = "knowledge-panel-note";
let workspaceStore: Record<string, unknown>;

/**
 * lazy-panels declares ConceptRelations (1), KnowledgeUpdate (2) and
 * KnowledgeEvidenceAsk (13) in that order; the probes stand in for all three so
 * the test can assert which one the page has open.
 */
vi.mock("next/dynamic", () => ({
  default: (() => {
    let index = 0;
    const probe = (label: string) =>
      function PanelProbe() {
        return createElement("section", { "aria-label": label });
      };
    return () => {
      index += 1;
      if (index === 1) return probe("关系面板探针");
      if (index === 2) return probe("更新面板探针");
      if (index === 13) return probe("依据问答探针");
      return () => null;
    };
  })(),
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/use-workspace", () => ({ useWorkspace: () => workspaceStore }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signOut: vi.fn() } }),
}));
vi.mock("@/lib/cloud", () => ({
  isCloudConfigured: () => false,
  subscribeSession: (listener: (user: null) => void) => {
    listener(null);
    return () => {};
  },
  previewAccountDeletion: vi.fn(),
  requestAccountDeletion: vi.fn(),
}));
vi.mock("./collection-library", () => ({ default: () => null, CollectionActions: () => null }));
vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./workspace-search", () => ({ default: () => null }));
vi.mock("./indexing-panel", () => ({ default: () => null }));
vi.mock("./web-import-form", () => ({ default: () => null }));

import Workspace from "./workspace";

describe("knowledge page AI panels", () => {
  let host: HTMLDivElement;
  let root: Root;

  function toolbar() {
    return host.querySelector<HTMLElement>(".note-page > .content-toolbar")!;
  }

  function control(label: string) {
    return [...toolbar().querySelectorAll<HTMLButtonElement>("button")].find(
      (button) =>
        button.getAttribute("aria-label") === label ||
        button.textContent?.replace(/\s+/gu, "") === label,
    );
  }

  function menuItem(label: string) {
    return [...host.querySelectorAll<HTMLButtonElement>(".library-menu-item")].find(
      (button) => button.textContent?.replace(/\s+/gu, "") === label,
    );
  }

  async function render(route: string) {
    window.history.replaceState(null, "", route);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(Workspace)));
  }

  beforeEach(() => {
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

    const data = createDemoWorkspace();
    const source = data.sources[0]!;
    const chunk = source.chunks[0]!;
    const citation: Citation = {
      sourceId: source.id,
      versionId: source.versionId,
      chunkId: chunk.id,
      title: source.title,
      quote: chunk.text,
      section: chunk.section,
      page: chunk.page,
    };
    const note: Note = {
      id: noteId,
      spaceId: source.spaceIds[0]!,
      title: "学习率复习",
      content: "<p>学习率决定参数更新步长。</p>",
      kind: "knowledge",
      status: "accepted",
      citations: [citation],
      versions: [],
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      deletedAt: null,
    };
    data.notes = [note];
    workspaceStore = {
      token: 1,
      data,
      update: vi.fn(),
      updateDurably: vi.fn(),
      ready: true,
      status: "local",
      localCacheMode: "normal",
      user: undefined,
      signOut: vi.fn(),
      signOutState: { kind: "ready", canSync: false, canKeepLocalDraft: false },
      ask: vi.fn(),
      cancelImport: vi.fn(),
      checkOrganization: vi.fn(),
      discardAccount: vi.fn(),
      error: "",
      importFile: vi.fn(),
      noteSyncPlan: undefined,
      organizationStatus: { ready: true, running: false, message: "模型服务已就绪" },
      organize: vi.fn(),
      previewSourcePurge: vi.fn(),
      purgeSource: vi.fn(),
      purging: false,
      refreshOrganizationStatus: vi.fn(),
      replaceFile: vi.fn(),
      resolveNoteConflicts: vi.fn(),
      restoreBackup: vi.fn(),
      retry: vi.fn(),
      retryImport: vi.fn(),
      retryOrganization: vi.fn(),
      sourceBlob: vi.fn(async () => undefined),
      stopOrganization: vi.fn(),
      useRemote: vi.fn(),
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
  });

  it("collapses the accepted page toolbar to four controls", async () => {
    await render(`#note/${noteId}`);
    const buttons = [...toolbar().querySelectorAll("button")];
    // 返回 · AI · ⋯ for an accepted page; 接受知识页 only appears on a draft.
    expect(
      buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim()),
    ).toEqual(["返回", "知识页 AI", "更多笔记操作"]);
    expect(control("历史版本")).toBeUndefined();
    expect(control("知识关系")).toBeUndefined();
  });

  it("keeps the page body on screen when an AI review opens beside it", async () => {
    await render(`#note/${noteId}`);
    expect(host.querySelector('[aria-label="关系面板探针"]')).toBeNull();

    await act(async () => control("知识页 AI")!.click());
    await act(async () => menuItem("知识关系")!.click());

    expect(host.querySelector('[aria-label="关系面板探针"]')).toBeInstanceOf(HTMLElement);
    // The article is no longer replaced by the review.
    expect(host.querySelector('[aria-label="笔记标题"]')).toBeInstanceOf(HTMLInputElement);
    expect(host.querySelector(".note-side-panel")?.getAttribute("data-note-panel")).toBe(
      "relations",
    );
    expect(window.location.hash).toBe(`#note/${noteId}/relations`);
  });

  it("shows only one review at a time", async () => {
    await render(`#note/${noteId}/relations`);
    expect(host.querySelector('[aria-label="关系面板探针"]')).toBeInstanceOf(HTMLElement);

    await act(async () => control("知识页 AI")!.click());
    await act(async () => menuItem("更新建议")!.click());

    expect(host.querySelector('[aria-label="关系面板探针"]')).toBeNull();
    expect(host.querySelector('[aria-label="更新面板探针"]')).toBeInstanceOf(HTMLElement);
    expect(host.querySelectorAll(".note-side-panel")).toHaveLength(1);
  });

  it("restores the evidence question panel from its own route and closes back to the page", async () => {
    await render(`#note/${noteId}/ask`);
    expect(host.querySelector('[aria-label="依据问答探针"]')).toBeInstanceOf(HTMLElement);

    await act(async () => control("知识页 AI")!.click());
    await act(async () => menuItem("基于原始依据提问")!.click());
    expect(window.location.hash).toBe(`#note/${noteId}/ask`);

    await act(async () => control("知识页 AI")!.click());
    await act(async () => menuItem("知识关系")!.click());
    expect(host.querySelector('[aria-label="依据问答探针"]')).toBeNull();
  });

  it("refuses the evidence range while the page is still a draft", async () => {
    const data = workspaceStore.data as ReturnType<typeof createDemoWorkspace>;
    data.notes[0]!.status = "draft";
    await render(`#note/${noteId}`);

    await act(async () => control("知识页 AI")!.click());
    const evidence = menuItem("基于原始依据提问")!;
    expect(evidence.disabled).toBe(true);
    expect(evidence.title).toContain("请先接受知识页");
  });
});
