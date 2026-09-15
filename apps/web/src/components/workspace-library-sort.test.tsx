// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";

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

describe("Workspace library sorting", () => {
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
    const first = data.sources[0]!;
    const second = data.sources[1]!;
    first.title = "第 10 课";
    first.createdAt = "2026-09-12T00:00:00.000Z";
    first.updatedAt = "2026-09-10T00:00:00.000Z";
    second.title = "第 2 课";
    second.createdAt = "2026-09-09T00:00:00.000Z";
    second.updatedAt = "2026-09-13T00:00:00.000Z";
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

  function visibleTitles() {
    return [...host.querySelectorAll(".source-row .source-open b")].map((item) => item.textContent);
  }

  function sortControl() {
    const control = host.querySelector<HTMLSelectElement>('select[aria-label="资料排序方式"]');
    expect(control).toBeInstanceOf(HTMLSelectElement);
    return control as HTMLSelectElement;
  }

  async function chooseSort(value: "updated" | "created" | "name") {
    const control = sortControl();
    await act(async () => {
      control.value = value;
      control.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("sorts immediately, preserves selection, and restores the route state", async () => {
    const first = data.sources[0]!;
    const second = data.sources[1]!;
    expect(sortControl().value).toBe("updated");
    expect(visibleTitles()).toEqual([second.title, first.title]);
    expect(host.querySelector(".source-list-heading")?.textContent).toContain("更新时间");
    expect(host.querySelector(".source-list-heading")?.textContent).not.toContain("添加时间");
    expect(host.querySelector(".source-date")?.textContent).toBe(
      new Date(second.updatedAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric" }),
    );

    const selected = host.querySelector<HTMLInputElement>(
      `input[aria-label="选择 ${first.title}"]`,
    )!;
    await act(async () => selected.click());
    expect(selected.checked).toBe(true);

    await chooseSort("created");
    expect(visibleTitles()).toEqual([first.title, second.title]);
    expect(window.location.hash).toBe(`#library/${spaceId}?sort=created`);
    expect(selected.checked).toBe(true);

    await chooseSort("name");
    expect(visibleTitles()).toEqual([second.title, first.title]);
    expect(window.location.hash).toBe(`#library/${spaceId}?sort=name`);

    await act(async () => {
      window.history.replaceState(null, "", `#library/${spaceId}?sort=created`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(sortControl().value).toBe("created");
    expect(visibleTitles()).toEqual([first.title, second.title]);
  });

  it("does not present a library sort control for relevance-ordered question search", async () => {
    const questionMode = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "用问题找资料",
    );
    expect(questionMode).toBeInstanceOf(HTMLButtonElement);
    await act(async () => questionMode!.click());
    expect(host.querySelector('select[aria-label="资料排序方式"]')).toBeNull();

    const keywordMode = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "关键词",
    );
    await act(async () => keywordMode!.click());
    expect(sortControl().value).toBe("updated");
  });
});
