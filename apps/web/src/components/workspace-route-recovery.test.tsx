// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import type { WorkspaceData } from "@/lib/types";

let workspaceStore: Record<string, unknown>;

vi.mock("next/dynamic", () => ({
  default: (() => {
    let index = 0;
    return () => {
      index += 1;
      if (index !== 3) return () => null;
      return function OrganizationProbe(props: {
        data: WorkspaceData;
        spaceId: string;
        onSpaceChange: (id: string) => void;
      }) {
        return createElement(
          "select",
          {
            "aria-label": "整理范围探针",
            value: props.spaceId,
            onChange: (event: { currentTarget: HTMLSelectElement }) =>
              props.onSpaceChange(event.currentTarget.value),
          },
          createElement("option", { value: "all" }, "全部空间"),
          ...props.data.spaces.map((space) =>
            createElement("option", { key: space.id, value: space.id }, space.name),
          ),
        );
      };
    };
  })(),
}));
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

describe("Workspace route recovery and transient navigation state", () => {
  let host: HTMLDivElement;
  let root: Root;
  let data: WorkspaceData;

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
    const firstSpace = data.spaces[0]!;
    data.spaces = [
      { ...firstSpace, id: "space-a", name: "甲知识库" },
      { ...firstSpace, id: "space-b", name: "乙知识库" },
    ];
    data.sources.forEach((source) => {
      source.spaceIds = ["space-a"];
    });
    data.sources[0]!.title = "路由审查资料";
    const now = "2026-09-17T12:00:00.000Z";
    data.notes = [
      {
        id: "existing-note",
        spaceId: "space-a",
        title: "有效笔记",
        content: "<p>用于区分笔记页面和错误回退。</p>",
        kind: "note",
        status: "accepted",
        citations: [],
        versions: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: "deleted-note",
        spaceId: "space-b",
        title: "已删除笔记",
        content: "<p>不能通过旧链接展示。</p>",
        kind: "note",
        status: "accepted",
        citations: [],
        versions: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: now,
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
      window.history.replaceState(null, "", hash || "/");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  }

  function expectGlobalScope() {
    expect(host.querySelector('[aria-label$="的空间导航"]')).toBeNull();
    expect(host.querySelector(".space-active")).toBeNull();
    expect(host.querySelector(".topbar-search-trigger")?.getAttribute("aria-label")).toBe(
      "搜索资料",
    );
  }

  function expectFeedback() {
    expect(host.querySelector(".toast")?.textContent).toMatch(/无效|不可用|不存在|已删除|返回/);
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

  it.each(["", "#not-a-real-page", "#home/unexpected"])(
    "recovers %s to the global overview instead of retaining a previous page",
    async (hash) => {
      await openHash(hash);
      expect(window.location.hash).toBe("#home");
      expect(host.querySelector(".page-heading h1")?.textContent).toBe("让知识，慢慢成为你的。");
      expectGlobalScope();
    },
  );

  it.each(["#note", "#note/existing-note/ask/extra", "#note/missing-note", "#note/deleted-note"])(
    "recovers invalid note route %s to global notes with an explanation",
    async (hash) => {
      await openHash(hash);
      expect(window.location.hash).toBe("#notes");
      expectGlobalScope();
      expectFeedback();
      expect(host.querySelector(".collection-home-title")?.textContent).toBe("我的笔记");
      expect(host.textContent).toContain("有效笔记");
      expect(host.querySelector(".content-toolbar")).toBeNull();
    },
  );

  it.each(["#library/space-a/extra", "#library/%ZZ", "#library//space-a"])(
    "recovers malformed library route %s to the canonical collection page",
    async (hash) => {
      await openHash(hash);
      expect(window.location.hash).toBe("#library");
      expectGlobalScope();
      expect(host.querySelector(".collection-home-title")?.textContent).toBe("资料库");
      expectFeedback();
    },
  );

  it.each([
    ["#home?space=missing-space", "#home"],
    ["#notes?space=missing-space", "#notes"],
    [
      "#knowledge?space=missing-space&q=review&status=pending",
      "#knowledge?q=review&status=pending",
    ],
    ["#questions?space=missing-space&status=pending", "#questions?status=pending"],
    ["#organize?space=missing-space", "#organize"],
    ["#library/missing-space?filter=markdown", "#library/all?filter=markdown"],
  ])(
    "recovers unavailable space route %s without retaining a hidden scope",
    async (hash, expected) => {
      await openHash(hash);
      expect(window.location.hash).toBe(expected);
      expectGlobalScope();
      expectFeedback();
      if (hash.startsWith("#organize"))
        expect(host.querySelector<HTMLSelectElement>('[aria-label="整理范围探针"]')?.value).toBe(
          "all",
        );
    },
  );

  it("does not discard a valid space deep link before the account data is ready", async () => {
    workspaceStore = {
      ...workspaceStore,
      ready: false,
      data: { ...data, spaces: [], sources: [] },
    };
    await act(async () => root.render(createElement(Workspace)));
    await openHash("#knowledge?space=space-b&q=review&status=pending");
    expect(window.location.hash).toBe("#knowledge?space=space-b&q=review&status=pending");
    workspaceStore = { ...workspaceStore, ready: true, data };
    await act(async () => root.render(createElement(Workspace)));
    expect(window.location.hash).toBe("#knowledge?space=space-b&q=review&status=pending");
    expect(host.querySelector('[aria-label="乙知识库 的空间导航"]')).not.toBeNull();
  });

  it("recovers a missing space only after account hydration confirms it is absent", async () => {
    workspaceStore = {
      ...workspaceStore,
      ready: false,
      data: { ...data, spaces: [], sources: [] },
    };
    await act(async () => root.render(createElement(Workspace)));
    await openHash("#home?space=missing-space");
    expect(window.location.hash).toBe("#home?space=missing-space");
    workspaceStore = { ...workspaceStore, ready: true, data };
    await act(async () => root.render(createElement(Workspace)));
    expect(window.location.hash).toBe("#home");
    expectGlobalScope();
    expectFeedback();
  });

  it.each(["sidebar", "hash"])(
    "closes source details on %s navigation and releases the global search shortcut",
    async (navigation) => {
      const manage = host.querySelector<HTMLButtonElement>('[aria-label="管理 路由审查资料"]');
      expect(manage).toBeInstanceOf(HTMLButtonElement);
      await act(async () => manage!.click());
      expect(host.querySelector('[aria-label="资料详情"]')).not.toBeNull();
      if (navigation === "sidebar") {
        await act(async () =>
          host.querySelector<HTMLButtonElement>(".sidebar-bottom .user-button")!.click(),
        );
      } else {
        await openHash("#settings");
      }
      expect(window.location.hash).toBe(
        navigation === "sidebar" ? "#settings/account" : "#settings",
      );
      expect(host.querySelector('[aria-label="资料详情"]')).toBeNull();
      await act(async () =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "k" }),
        ),
      );
      expect(window.location.hash).toBe("#library/all");
      expectGlobalScope();
    },
  );

  it("routes organization scope changes and restores each scope through Back and Forward", async () => {
    await openHash("#organize?space=space-a");
    const select = host.querySelector<HTMLSelectElement>('[aria-label="整理范围探针"]');
    expect(select?.value).toBe("space-a");
    await act(async () => {
      select!.value = "space-b";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(window.location.hash).toBe("#organize?space=space-b");
    expect(host.querySelector<HTMLSelectElement>('[aria-label="整理范围探针"]')?.value).toBe(
      "space-b",
    );
    await moveHistory("back");
    expect(window.location.hash).toBe("#organize?space=space-a");
    expect(host.querySelector<HTMLSelectElement>('[aria-label="整理范围探针"]')?.value).toBe(
      "space-a",
    );
    await moveHistory("forward");
    expect(window.location.hash).toBe("#organize?space=space-b");
    expect(host.querySelector<HTMLSelectElement>('[aria-label="整理范围探针"]')?.value).toBe(
      "space-b",
    );
  });
});
