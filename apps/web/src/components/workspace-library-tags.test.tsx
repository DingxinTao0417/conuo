// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace, createEmptyWorkspace } from "@/lib/seed";

let workspaceStore: Record<string, unknown>;

vi.mock("next/dynamic", () => ({ default: () => () => null }));
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
vi.mock("./collection-library", () => ({
  default: () => null,
  CollectionActions: () => null,
}));
vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./workspace-search", () => ({ default: () => null }));
vi.mock("./indexing-panel", () => ({ default: () => null }));
vi.mock("./web-import-form", () => ({ default: () => null }));

import Workspace from "./workspace";

describe("Workspace library tag filters", () => {
  let host: HTMLDivElement;
  let root: Root;
  let spaceId: string;
  let data: ReturnType<typeof createDemoWorkspace>;

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

    data = createDemoWorkspace();
    spaceId = data.spaces[0]!.id;
    data.sources[0]!.tags = ["机器学习"];
    data.sources[1]!.tags = ["课程资料"];
    data.sources[0]!.createdAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    data.sources[1]!.createdAt = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    data.sources[0]!.updatedAt = "2026-01-02T00:00:00.000Z";
    data.sources[1]!.updatedAt = "2026-01-01T00:00:00.000Z";
    workspaceStore = {
      token: 1,
      data,
      update: vi.fn(),
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
    window.history.replaceState(null, "", `#library/${spaceId}`);
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

  function tagControl(tag: string) {
    const control = host.querySelector<HTMLInputElement>(`input[aria-label="标签 ${tag}"]`);
    expect(control, `tag ${tag}`).toBeInstanceOf(HTMLInputElement);
    return control as HTMLInputElement;
  }

  /** Type, time and tags now share one filter popover in the toolbar. */
  function filterTrigger(activeCount = 0) {
    const label = activeCount ? `筛选资料，已应用 ${activeCount} 项` : "筛选资料";
    return host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  }

  async function openFilterMenu() {
    const trigger = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.getAttribute("aria-label")?.startsWith("筛选资料"),
    );
    expect(trigger, "filter trigger").toBeInstanceOf(HTMLButtonElement);
    if (trigger!.getAttribute("aria-expanded") !== "true") await act(async () => trigger!.click());
  }

  function visibleTitles() {
    return [...host.querySelectorAll(".source-row .source-open b")].map((item) => item.textContent);
  }

  it("combines selected tags with AND semantics and offers a clear path for an empty result", async () => {
    const first = data.sources[0]!;
    const second = data.sources[1]!;
    expect(visibleTitles()).toEqual([first.title, second.title]);

    expect(filterTrigger()).toBeInstanceOf(HTMLButtonElement);
    await openFilterMenu();
    expect(host.querySelector('[role="dialog"][aria-label="筛选资料"]')).toBeTruthy();
    expect(host.textContent).toContain("仅显示同时具有所选标签的资料");

    await act(async () => tagControl("机器学习").click());
    expect(visibleTitles()).toEqual([first.title]);
    expect(window.location.hash).toContain("tag=%E6%9C%BA%E5%99%A8%E5%AD%A6%E4%B9%A0");

    await act(async () => tagControl("课程资料").click());
    expect(visibleTitles()).toEqual([]);
    expect(host.textContent).toContain("没有找到匹配的资料");
    const clear = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "清除筛选",
    );
    expect(clear).toBeInstanceOf(HTMLButtonElement);
    await act(async () => clear!.click());
    expect(visibleTitles()).toEqual([first.title, second.title]);
    expect(window.location.hash).not.toContain("tag=");
  });

  it("drops tags that do not exist after the library scope changes", async () => {
    await openFilterMenu();
    await act(async () => tagControl("机器学习").click());
    expect(window.location.hash).toContain("tag=");

    await act(async () => {
      window.history.replaceState(
        null,
        "",
        "#library/inbox?tag=%E6%9C%BA%E5%99%A8%E5%AD%A6%E4%B9%A0",
      );
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    expect(filterTrigger()).toBeTruthy();
    expect(window.location.hash).toBe("#library/inbox");
  });

  it("filters by a rolling creation window and restores it from browser history", async () => {
    const first = data.sources[0]!;
    const second = data.sources[1]!;
    await openFilterMenu();
    const control = host.querySelector<HTMLSelectElement>(
      'select[aria-label="按添加时间筛选资料"]',
    );
    expect(control).toBeInstanceOf(HTMLSelectElement);

    await act(async () => {
      control!.value = "7d";
      control!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(visibleTitles()).toEqual([first.title]);
    expect(window.location.hash).toBe(`#library/${spaceId}?time=7d`);
    expect(filterTrigger(1)).toBeTruthy();

    await act(async () => {
      window.history.replaceState(null, "", `#library/${spaceId}?time=365d`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(control!.value).toBe("365d");
    expect(visibleTitles()).toEqual([first.title, second.title]);
  });

  it("keeps a deep-linked tag through the initial workspace hydration", async () => {
    const hydrated = createDemoWorkspace();
    const hydratedSpaceId = hydrated.spaces[0]!.id;
    hydrated.sources[0]!.tags = ["机器学习"];
    hydrated.sources[1]!.tags = ["课程资料"];

    // Model the coordinator's actual first snapshot: its data is empty until
    // local or cloud state finishes loading, while the browser already has a
    // shareable library URL.
    await act(async () => root.unmount());
    root = createRoot(host);
    workspaceStore = {
      ...workspaceStore,
      data: createEmptyWorkspace(),
      ready: false,
    };
    window.history.replaceState(
      null,
      "",
      `#library/${hydratedSpaceId}?tag=%E6%9C%BA%E5%99%A8%E5%AD%A6%E4%B9%A0`,
    );
    await act(async () => root.render(createElement(Workspace)));
    expect(host.textContent).toContain("正在打开学习空间");

    workspaceStore = { ...workspaceStore, data: hydrated, ready: true };
    await act(async () => root.render(createElement(Workspace)));

    expect(window.location.hash).toBe(
      `#library/${hydratedSpaceId}?tag=%E6%9C%BA%E5%99%A8%E5%AD%A6%E4%B9%A0`,
    );
    expect(filterTrigger(1)).toBeTruthy();
    expect(visibleTitles()).toEqual([hydrated.sources[0]!.title]);
  });

  it("closes the filter dialog with Escape while keeping its selected state", async () => {
    await openFilterMenu();
    await act(async () => tagControl("机器学习").click());
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));

    expect(host.querySelector('[role="dialog"][aria-label="筛选资料"]')).toBeNull();
    expect(filterTrigger(1)).toBeTruthy();
  });
});
