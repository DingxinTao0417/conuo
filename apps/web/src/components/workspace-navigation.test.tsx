// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyWorkspace } from "@/lib/seed";

let workspaceStore: Record<string, unknown>;

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/use-workspace", () => ({ useWorkspace: () => workspaceStore }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signOut: vi.fn() } }),
}));
vi.mock("@/lib/cloud", () => ({
  isCloudConfigured: () => true,
  previewAccountDeletion: vi.fn(),
  requestAccountDeletion: vi.fn(),
}));
vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./workspace-search", () => ({ default: () => null }));
vi.mock("./indexing-panel", () => ({ default: () => null }));
vi.mock("./membership-panel", () => ({ default: () => null }));
vi.mock("./web-import-form", () => ({ default: () => null }));

import Workspace from "./workspace";

describe("Workspace primary navigation", () => {
  let host: HTMLDivElement;
  let root: Root;

  function sidebarLabels() {
    const nav = host.querySelector<HTMLElement>('[aria-label="主导航"]');
    expect(nav).toBeInstanceOf(HTMLElement);
    return [...nav!.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
  }

  async function openHash(hash: string) {
    await act(async () => {
      window.history.replaceState(null, "", hash);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  }

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

    const data = createEmptyWorkspace();
    data.notes.push({
      id: "note-a",
      spaceId: data.spaces[0]?.id ?? "",
      title: "梯度下降笔记",
      content: "<p>步长与损失变化</p>",
      kind: "note",
      status: "accepted",
      citations: [],
      versions: [],
      createdAt: "2026-09-15T09:00:00.000Z",
      updatedAt: "2026-09-15T09:00:00.000Z",
      deletedAt: null,
    });
    data.importJobs = [
      {
        id: "job-running",
        sourceId: "source-a",
        versionId: "version-a",
        filename: "机器学习入门.pdf",
        spaceId: "",
        stage: "parsing",
        status: "running",
        originalSaved: true,
        attempt: 1,
        createdAt: "2026-09-15T10:00:00.000Z",
        updatedAt: "2026-09-15T10:00:00.000Z",
      },
      {
        id: "job-queued",
        sourceId: "source-b",
        versionId: "version-b",
        filename: "梯度下降笔记.md",
        spaceId: "",
        stage: "saving",
        status: "queued",
        originalSaved: true,
        attempt: 0,
        createdAt: "2026-09-15T10:01:00.000Z",
        updatedAt: "2026-09-15T10:01:00.000Z",
      },
    ];
    workspaceStore = {
      token: 1,
      data,
      update: vi.fn(),
      updateDurably: vi.fn(),
      ready: true,
      status: "cloud",
      error: "",
      localCacheMode: "normal",
      user: { id: "account-a", email: "learner@example.test" },
      anonymousMigration: { kind: "none", canMigrate: false },
      signOut: vi.fn(),
      signOutState: { kind: "ready", canSync: false, canKeepLocalDraft: false },
      ask: vi.fn(),
      cancelImport: vi.fn(),
      checkOrganization: vi.fn(),
      discardAccount: vi.fn(),
      importFile: vi.fn(),
      loadLatestLocal: vi.fn(),
      localUpdateRevision: null,
      loadingLocalUpdate: false,
      noteSyncPlan: undefined,
      organizationStatus: { ready: true, running: false, message: "" },
      organize: vi.fn(),
      previewSourcePurge: vi.fn(),
      purgeSource: vi.fn(),
      purging: false,
      readingProgressSyncPlan: undefined,
      recovery: undefined,
      recoveryRevision: undefined,
      refreshOrganizationStatus: vi.fn(),
      replaceFile: vi.fn(),
      resolveNoteConflicts: vi.fn(),
      resolveReadingProgressConflicts: vi.fn(),
      restoreBackup: vi.fn(),
      retry: vi.fn(),
      retryImport: vi.fn(),
      retryOrganization: vi.fn(),
      sourceBlob: vi.fn(async () => undefined),
      stopOrganization: vi.fn(),
      useRemote: vi.fn(),
    };
    window.history.replaceState(null, "", "#home");
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

  it("keeps the task center and AI organization out of the primary sidebar", () => {
    const labels = sidebarLabels();
    expect(labels).toEqual(["学习概览", "资料库", "我的问答", "我的笔记", "知识页"]);
    expect(labels).not.toContain("任务中心");
    expect(labels).not.toContain("AI 整理");
  });

  it("opens the task center from a topbar action that counts unfinished work", async () => {
    const tasks = host.querySelector<HTMLButtonElement>(".topbar-tasks");
    expect(tasks).toBeInstanceOf(HTMLButtonElement);
    expect(tasks!.getAttribute("aria-label")).toBe("任务中心，2 项正在进行");
    expect(tasks!.querySelector(".topbar-task-count")?.textContent).toBe("2");

    await act(async () => tasks!.click());
    expect(window.location.hash).toBe("#tasks");
  });

  it("drops the task badge when no import or organization work is running", async () => {
    workspaceStore = {
      ...workspaceStore,
      data: { ...createEmptyWorkspace(), importJobs: [] },
    };
    await act(async () => root.render(createElement(Workspace)));

    const tasks = host.querySelector<HTMLButtonElement>(".topbar-tasks");
    expect(tasks!.getAttribute("aria-label")).toBe("任务中心");
    expect(tasks!.querySelector(".topbar-task-count")).toBeNull();
  });

  it("opens settings as grouped panes and keeps the group in the URL", async () => {
    await openHash("#settings");

    const panes = host.querySelector<HTMLElement>('[aria-label="设置分组"]');
    expect(panes).toBeInstanceOf(HTMLElement);
    expect([...panes!.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "账号与设备",
      "AI 与资料处理",
      "云端资料与存储",
      "阅读与同步",
      "学习空间",
    ]);
    // A bare #settings opens the first group; AI and storage controls are not
    // stacked onto the same screen any more.
    expect(host.textContent).toContain("安装与设备");
    expect(host.textContent).not.toContain("允许 AI 使用我的资料");
    expect(host.textContent).not.toContain("导出学习资料");

    const ai = [...panes!.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "AI 与资料处理",
    );
    await act(async () => ai!.click());
    expect(window.location.hash).toBe("#settings/ai");
    expect(host.textContent).toContain("允许 AI 使用我的资料");
    expect(host.textContent).not.toContain("安装与设备");
  });

  it("restores a settings group from its own link and falls back for an unknown group", async () => {
    await openHash("#settings/storage");
    expect(host.textContent).toContain("导出学习资料");
    expect(host.querySelector<HTMLElement>('[aria-label="设置分组"]')).toBeInstanceOf(HTMLElement);

    await openHash("#settings/not-a-group");
    expect(host.textContent).toContain("安装与设备");
    expect(host.textContent).not.toContain("导出学习资料");
  });

  it("offers the four phone destinations and hides them while reading", async () => {
    const nav = () => host.querySelector<HTMLElement>('[aria-label="主要内容导航"]');
    expect(nav()).toBeInstanceOf(HTMLElement);
    expect([...nav()!.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "首页",
      "资料",
      "知识",
      "问答",
    ]);

    const knowledge = [...nav()!.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "知识",
    )!;
    await act(async () => knowledge.click());
    expect(window.location.hash).toBe("#knowledge");
    expect(
      [...nav()!.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "知识")!
        .getAttribute("aria-current"),
    ).toBe("page");

    // Saved writing shares the knowledge destination on phones.
    await openHash("#notes");
    expect(
      [...nav()!.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "知识")!
        .getAttribute("aria-current"),
    ).toBe("page");

    // The note editor and the reader own the bottom of the screen themselves.
    await openHash("#note/note-a");
    expect(nav()).toBeNull();
  });

  it("still resolves the task center and AI organization deep links", async () => {
    await openHash("#tasks");
    expect(window.location.hash).toBe("#tasks");
    expect(host.querySelector(".content-scroll")).toBeInstanceOf(HTMLElement);
    expect(host.textContent).toContain("任务中心");

    await openHash("#organize");
    expect(window.location.hash).toBe("#organize");
    expect(host.querySelector(".content-scroll")).toBeInstanceOf(HTMLElement);
    expect(host.textContent).toContain("AI 整理");
  });
});
