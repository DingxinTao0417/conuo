// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import type { Conversation } from "@/lib/types";

let workspaceStore: Record<string, unknown>;

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/use-workspace", () => ({ useWorkspace: () => workspaceStore }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signOut: vi.fn() } }),
}));
vi.mock("./collection-library", () => ({
  default: () => null,
  CollectionActions: () => null,
}));
vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./workspace-search", () => ({ default: () => null }));
vi.mock("./indexing-panel", () => ({ default: () => null }));
vi.mock("./web-import-form", () => ({ default: () => null }));

import Workspace from "./workspace";

describe("Workspace question history", () => {
  let host: HTMLDivElement;
  let root: Root;
  let spaceId: string;
  let activeSourceId: string;

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

    const data = createDemoWorkspace();
    spaceId = data.spaces[0]!.id;
    activeSourceId = data.sources[0]!.id;
    const deletedSource = data.sources[1]!;
    deletedSource.deletedAt = "2026-09-12T08:30:00.000Z";
    const conversations: Conversation[] = [
      {
        id: "pending-old",
        spaceId,
        sourceId: deletedSource.id,
        title: "较早的待解决问题",
        scope: "document",
        sourceIds: [deletedSource.id],
        messages: [],
        resolved: false,
        updatedAt: "2026-09-12T08:00:00.000Z",
      },
      {
        id: "resolved-middle",
        spaceId,
        sourceId: activeSourceId,
        title: "已经解决的问题",
        scope: "document",
        sourceIds: [activeSourceId],
        messages: [],
        resolved: true,
        updatedAt: "2026-09-12T09:00:00.000Z",
      },
      {
        id: "pending-new",
        spaceId,
        sourceId: activeSourceId,
        title: "最近的待解决问题",
        scope: "document",
        sourceIds: [activeSourceId],
        messages: [
          {
            id: "latest-answer",
            role: "assistant",
            content: "这是最近一次讨论的回答。",
            citations: [],
            createdAt: "2026-09-12T10:00:00.000Z",
          },
        ],
        resolved: false,
        updatedAt: "2026-09-12T10:00:00.000Z",
      },
    ];
    data.conversations = conversations;
    workspaceStore = {
      token: 1,
      data,
      update: vi.fn(),
      updateDurably: vi.fn(),
      ready: true,
      status: "local",
      localCacheMode: "normal",
      user: undefined,
      anonymousMigration: { kind: "none", canMigrate: false },
      signOut: vi.fn(),
      signOutState: { kind: "ready", canSync: false, canKeepLocalDraft: false },
      ask: vi.fn(),
      cancelImport: vi.fn(),
      checkOrganization: vi.fn(),
      discardAccount: vi.fn(),
      error: "",
      importFile: vi.fn(),
      noteSyncPlan: undefined,
      organizationStatus: undefined,
      organize: vi.fn(),
      previewSourcePurge: vi.fn(),
      purgeSource: vi.fn(),
      purging: false,
      recovery: undefined,
      recoveryRevision: undefined,
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
    window.history.replaceState(null, "", `#questions?space=${spaceId}&status=all`);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(Workspace)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
  });

  function titles() {
    return [...host.querySelectorAll(".question-history-item h3")].map(
      (heading) => heading.textContent,
    );
  }

  function filterButton(label: string) {
    const button = [
      ...host.querySelectorAll<HTMLButtonElement>(".question-history-filters button"),
    ].find((candidate) => candidate.querySelector("span")?.textContent === label);
    expect(button, label).toBeInstanceOf(HTMLButtonElement);
    return button as HTMLButtonElement;
  }

  it("pushes filter state and restores it from browser navigation", async () => {
    expect(titles()).toEqual(["最近的待解决问题", "已经解决的问题", "较早的待解决问题"]);
    expect(host.textContent).toContain("关联资料");
    expect(host.textContent).toContain("最近回答：这是最近一次讨论的回答。");

    const deletedRow = [...host.querySelectorAll<HTMLElement>(".question-history-item")].find(
      (row) => row.textContent?.includes("较早的待解决问题"),
    );
    expect(deletedRow?.textContent).toContain("原资料已删除，可查看记录");
    expect(deletedRow?.querySelector('[aria-label^="打开《"]')).toBeNull();

    const pushState = vi.spyOn(window.history, "pushState");
    await act(async () => filterButton("已解决").click());
    expect(pushState).toHaveBeenLastCalledWith(
      null,
      "",
      `#questions?space=${spaceId}&status=resolved`,
    );
    expect(window.location.hash).toBe(`#questions?space=${spaceId}&status=resolved`);
    expect(filterButton("已解决").getAttribute("aria-pressed")).toBe("true");
    expect(titles()).toEqual(["已经解决的问题"]);

    await act(async () => {
      window.history.replaceState(null, "", `#questions?space=${spaceId}&status=pending`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(filterButton("待解决").getAttribute("aria-pressed")).toBe("true");
    expect(titles()).toEqual(["最近的待解决问题", "较早的待解决问题"]);

    await act(async () => {
      window.history.replaceState(null, "", `#questions?space=${spaceId}&status=resolved`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(filterButton("已解决").getAttribute("aria-pressed")).toBe("true");
    expect(titles()).toEqual(["已经解决的问题"]);
  });

  it("opens only route-confirmed originals and continues a valid discussion", async () => {
    const newestRow = [...host.querySelectorAll<HTMLElement>(".question-history-item")].find(
      (row) => row.textContent?.includes("最近的待解决问题"),
    );
    const original = newestRow?.querySelector<HTMLButtonElement>('[aria-label^="打开《"]');
    expect(original).toBeInstanceOf(HTMLButtonElement);
    await act(async () => original!.click());
    expect(window.location.hash).toBe(`#source/${activeSourceId}`);

    await act(async () => {
      window.history.replaceState(null, "", `#questions?space=${spaceId}&status=all`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const restoredNewestRow = [
      ...host.querySelectorAll<HTMLElement>(".question-history-item"),
    ].find((row) => row.textContent?.includes("最近的待解决问题"));
    const continueButton = [
      ...(restoredNewestRow?.querySelectorAll<HTMLButtonElement>("button") ?? []),
    ].find((button) => button.textContent?.trim() === "继续讨论");
    expect(continueButton).toBeInstanceOf(HTMLButtonElement);
    await act(async () => continueButton!.click());
    expect(window.location.hash).toBe("#conversation/pending-new");
  });

  it("restores a deep-linked filter after remount and defaults a bare route to all", async () => {
    await act(async () => root.unmount());
    root = createRoot(host);
    window.history.replaceState(null, "", `#questions?space=${spaceId}&status=pending`);
    await act(async () => root.render(createElement(Workspace)));

    expect(filterButton("待解决").getAttribute("aria-pressed")).toBe("true");
    expect(titles()).toEqual(["最近的待解决问题", "较早的待解决问题"]);

    await act(async () => root.unmount());
    root = createRoot(host);
    window.history.replaceState(null, "", `#questions?space=${spaceId}`);
    await act(async () => root.render(createElement(Workspace)));

    expect(filterButton("全部").getAttribute("aria-pressed")).toBe("true");
    expect(titles()).toEqual(["最近的待解决问题", "已经解决的问题", "较早的待解决问题"]);
  });

  it("keeps a useful first-question action when the scoped history is empty", async () => {
    const data = structuredClone(workspaceStore.data as ReturnType<typeof createDemoWorkspace>);
    data.conversations = [];
    workspaceStore = { ...workspaceStore, data };
    await act(async () => root.render(createElement(Workspace)));

    expect(host.textContent).toContain("第一个问题，从阅读开始");
    expect(host.textContent).toContain("打开一份资料，在右侧输入问题");
    const openLibrary = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "打开资料库",
    );
    expect(openLibrary).toBeInstanceOf(HTMLButtonElement);
  });
});
