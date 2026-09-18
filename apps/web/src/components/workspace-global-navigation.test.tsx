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
vi.mock("./web-import-form", () => ({ default: () => null }));

import Workspace from "./workspace";

describe("Workspace global and space navigation boundaries", () => {
  let host: HTMLDivElement;
  let root: Root;

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
    const now = "2026-09-17T12:00:00.000Z";
    data.spaces = [
      { ...data.spaces[0]!, id: "space-a", name: "我的学习空间" },
      { ...data.spaces[0]!, id: "space-b", name: "第二知识库" },
    ];
    for (const space of data.spaces) {
      for (const kind of ["note", "knowledge"] as const) {
        data.notes.push({
          id: `${space.id}-${kind}`,
          spaceId: space.id,
          title: `${space.name}${kind === "note" ? "笔记" : "知识页"}`,
          content: "<p>这是一条用于验证所属范围的独立记录。</p>",
          kind,
          status: "accepted",
          citations: [],
          versions: [],
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });
      }
      data.conversations.push({
        id: `${space.id}-question`,
        spaceId: space.id,
        title: `${space.name}的问题`,
        scope: "space",
        sourceIds: [],
        messages: [],
        resolved: false,
        updatedAt: now,
      });
    }
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
    window.history.replaceState(null, "", "#library/space-a");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(Workspace)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function openHash(hash: string) {
    await act(async () => {
      window.history.replaceState(null, "", hash);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  }

  function button(selector: string) {
    const element = host.querySelector<HTMLButtonElement>(selector);
    expect(element, selector).toBeInstanceOf(HTMLButtonElement);
    return element!;
  }

  async function click(selector: string) {
    await act(async () => button(selector).click());
  }

  function expectGlobalScope() {
    expect(host.querySelector('[aria-label$="的空间导航"]')).toBeNull();
    expect(host.querySelector(".space-active")).toBeNull();
    expect(button(".topbar-search-trigger").getAttribute("aria-label")).toBe("搜索资料");
  }

  function expectGlobalHome() {
    expect(window.location.hash).toBe("#home");
    expect(host.querySelector(".page-heading h1")?.textContent).toBe("让知识，慢慢成为你的。");
    expectGlobalScope();
  }

  async function moveHistory(direction: "back" | "forward") {
    const changed = new Promise<void>((resolve) =>
      window.addEventListener("popstate", () => resolve(), { once: true }),
    );
    await act(async () => {
      window.history[direction]();
      await changed;
    });
  }

  it.each([
    ["space-a", "我的学习空间"],
    ["space-b", "第二知识库"],
  ])("opens the global learning overview after selecting %s", async (id, name) => {
    await click(`.space-list [aria-label="${name}"]`);
    expect(window.location.hash).toBe(`#library/${id}`);
    await click('[aria-label="主导航"] [aria-label="学习概览"]');
    expectGlobalHome();
  });

  it("opens the global learning overview from the brand while a space overview is active", async () => {
    await openHash("#home?space=space-a");
    expect(host.querySelector(".page-heading h1")?.textContent).toBe("我的学习空间");
    await click('[aria-label="Conuo 学习概览"]');
    expectGlobalHome();
  });

  it("shows records from every space through the global questions, notes and knowledge links", async () => {
    for (const [label, hash, suffix] of [
      ["我的问答", "#questions?status=all", "的问题"],
      ["我的笔记", "#notes", "笔记"],
      ["知识页", "#knowledge", "知识页"],
    ]) {
      await openHash("#library/space-a");
      await click(`[aria-label="主导航"] [aria-label="${label}"]`);
      expect(window.location.hash).toBe(hash);
      expectGlobalScope();
      expect(host.textContent).toContain(`我的学习空间${suffix}`);
      expect(host.textContent).toContain(`第二知识库${suffix}`);
    }
  });

  it("uses global scope for every phone destination after opening a knowledge library", async () => {
    for (const [label, hash] of [
      ["首页", "#home"],
      ["资料", "#library"],
      ["知识", "#knowledge"],
      ["问答", "#questions?status=all"],
    ]) {
      await openHash("#library/space-b");
      const navigation = host.querySelector('[aria-label="主要内容导航"]')!;
      const target = [...navigation.querySelectorAll("button")].find(
        (element) => element.textContent === label,
      )!;
      await act(async () => target.click());
      expect(window.location.hash).toBe(hash);
      expectGlobalScope();
      expect(target.getAttribute("aria-current")).toBe("page");
      if (label === "首页") expectGlobalHome();
    }
  });

  it("preserves the explicit space for its own overview, materials, knowledge and questions tabs", async () => {
    for (const [label, hash] of [
      ["概览", "#home?space=space-a"],
      ["资料", "#library/space-a"],
      ["知识", "#knowledge?space=space-a"],
      ["问答", "#questions?space=space-a&status=all"],
    ]) {
      const navigation = host.querySelector('[aria-label="我的学习空间 的空间导航"]')!;
      const target = [...navigation.querySelectorAll("button")].find(
        (element) => element.textContent?.trim() === label,
      )!;
      await act(async () => target.click());
      expect(window.location.hash).toBe(hash);
      expect(host.querySelector('[aria-label="我的学习空间 的空间导航"]')).not.toBeNull();
      expect(button(".topbar-search-trigger").getAttribute("aria-label")).toBe(
        "搜索当前空间：我的学习空间",
      );
      if (label === "知识") {
        expect(host.textContent).toContain("我的学习空间知识页");
        expect(host.textContent).not.toContain("第二知识库知识页");
      }
      if (label === "问答") {
        expect(host.textContent).toContain("我的学习空间的问题");
        expect(host.textContent).not.toContain("第二知识库的问题");
      }
    }
  });

  it("clears space context for settings, trash and tasks and starts their search across all sources", async () => {
    for (const [selector, hash] of [
      [".sidebar-bottom .user-button", "#settings/account"],
      ['.sidebar-bottom [aria-label="回收站"]', "#trash"],
      [".topbar-tasks", "#tasks"],
    ]) {
      await openHash("#knowledge?space=space-a&q=旧检索&status=pending");
      await click(selector);
      expect(window.location.hash).toBe(hash);
      expectGlobalScope();
      await click(".topbar-search-trigger");
      expect(window.location.hash).not.toContain("space-a");
      expect(window.location.hash).not.toContain("旧检索");
      expect(host.querySelector<HTMLInputElement>('input[aria-label="搜索资料"]')?.value).toBe("");
    }
  });

  it.each([".sidebar-bottom .user-button", ".topbar-account"])(
    "opens all settings from %s and preserves browser history",
    async (selector) => {
      await click(selector);
      expect(window.location.hash).toBe("#settings/account");
      expectGlobalScope();
      expect(host.querySelector(".page-heading h1")?.textContent).toBe("账号与设置");
      expect(host.querySelector('.sidebar-bottom [aria-label="设置"]')).toBeNull();
      expect(button(selector).getAttribute("aria-current")).toBe("page");
      expect(host.querySelector("dialog")).toBeNull();

      const panes = host.querySelector('[aria-label="设置分组"]')!;
      expect([...panes.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
        "账号与设备",
        "AI 与资料处理",
        "云端资料与存储",
        "阅读与同步",
        "学习空间",
      ]);
      const aiPane = [...panes.querySelectorAll("button")].find(
        (item) => item.textContent === "AI 与资料处理",
      )!;
      await act(async () => aiPane.click());
      expect(window.location.hash).toBe("#settings/ai");
      expect(host.textContent).toContain("允许 AI 使用我的资料");
      expect(button(selector).getAttribute("aria-current")).toBe("page");
      await moveHistory("back");
      expect(window.location.hash).toBe("#settings/account");
      expect(host.textContent).toContain("安装与设备");
      await moveHistory("back");
      expect(window.location.hash).toBe("#library/space-a");
      expect(button(selector).getAttribute("aria-current")).toBeNull();
      await moveHistory("forward");
      expect(window.location.hash).toBe("#settings/account");
      expectGlobalScope();
    },
  );

  it("closes the phone drawer when opening account settings during a cloud save", async () => {
    workspaceStore = { ...workspaceStore, status: "saving" };
    await act(async () => root.render(createElement(Workspace)));
    await click('[aria-label="打开导航"]');
    expect(host.querySelector(".sidebar-open")).not.toBeNull();
    await click(".sidebar-bottom .user-button");
    expect(window.location.hash).toBe("#settings/account");
    expect(host.querySelector(".sidebar-open")).toBeNull();
    expectGlobalScope();
  });

  it("clears the selected space when a bare overview link is opened after scoped knowledge", async () => {
    await openHash("#knowledge?space=space-b&q=旧检索&status=pending");
    await openHash("#home");
    expectGlobalHome();
  });

  it("restores the global overview when browser Back returns from a space library", async () => {
    await openHash("#home");
    await click('.space-list [aria-label="我的学习空间"]');
    expect(window.location.hash).toBe("#library/space-a");
    await moveHistory("back");
    expectGlobalHome();
  });

  it("restores scoped and global knowledge views independently through browser Back and Forward", async () => {
    await openHash("#knowledge?space=space-a");
    await click('[aria-label="主导航"] [aria-label="知识页"]');
    expect(window.location.hash).toBe("#knowledge");
    expectGlobalScope();
    await moveHistory("back");
    expect(window.location.hash).toBe("#knowledge?space=space-a");
    expect(host.querySelector('[aria-label="我的学习空间 的空间导航"]')).not.toBeNull();
    expect(host.textContent).not.toContain("第二知识库知识页");
    await moveHistory("forward");
    expect(window.location.hash).toBe("#knowledge");
    expectGlobalScope();
    expect(host.textContent).toContain("第二知识库知识页");
  });
});
