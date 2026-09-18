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
  isCloudConfigured: () => false,
  subscribeSession: (listener: (user: null) => void) => {
    listener(null);
    return () => {};
  },
  previewAccountDeletion: vi.fn(),
  requestAccountDeletion: vi.fn(),
}));
vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./workspace-search", () => ({ default: () => null }));
vi.mock("./indexing-panel", () => ({ default: () => null }));
vi.mock("./web-import-form", () => ({ default: () => null }));
vi.mock("@/lib/export", () => ({
  exportWorkspace: vi.fn(async () => ({ issues: [] })),
}));

import Workspace from "./workspace";
import { exportWorkspace } from "@/lib/export";

describe("Workspace first material path", () => {
  let host: HTMLDivElement;
  let root: Root;
  let data: ReturnType<typeof createEmptyWorkspace>;

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

    data = createEmptyWorkspace();
    const update = vi.fn((updater: (current: typeof data) => typeof data) => {
      data = updater(data);
      workspaceStore = { ...workspaceStore, data };
    });
    workspaceStore = {
      token: 1,
      data,
      update,
      ready: true,
      status: "local",
      user: undefined,
      signOut: vi.fn(),
      signOutState: { kind: "ready", canSync: false, canKeepLocalDraft: false },
      ask: vi.fn(),
      cancelImport: vi.fn(),
      checkOrganization: vi.fn(),
      discardAccount: vi.fn(),
      error: "",
      localUpdateRevision: null,
      loadingLocalUpdate: false,
      loadLatestLocal: vi.fn(),
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

  function button(label: string) {
    const match = [...host.querySelectorAll("button")].find(
      (item) => item.textContent?.replace(/\s+/g, "").trim() === label.replace(/\s+/g, ""),
    );
    expect(match, `button ${label}`).toBeInstanceOf(HTMLButtonElement);
    return match as HTMLButtonElement;
  }

  async function navigateTo(hash: string) {
    await act(async () => {
      window.history.pushState(null, "", hash);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
  }

  function expectFirstImportNaming() {
    expect(host.textContent).toContain("创建知识库并导入资料");
    expect(host.textContent).not.toContain("导入学习资料");
  }

  it("names and preselects the first library before importing, without retaining a blank starter", async () => {
    await act(async () => button("添加第一份资料").click());
    expect(host.textContent).toContain("创建知识库并导入资料");

    const name = host.querySelector<HTMLInputElement>('input[name="name"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      name,
      "机器学习入门",
    );
    await act(async () => name.dispatchEvent(new Event("input", { bubbles: true })));
    await act(async () => button("创建并导入").click());

    expect(data.spaces).toHaveLength(1);
    expect(data.spaces[0]).toMatchObject({ name: "机器学习入门" });
    expect(host.textContent).toContain("导入学习资料");
    const importTarget = [...host.querySelectorAll("label")].find((label) =>
      label.textContent?.startsWith("保存到"),
    );
    expect(importTarget?.querySelector("select")?.value).toBe(data.spaces[0]!.id);
    const consent = host.querySelector<HTMLInputElement>(
      'input[aria-label="允许 AI 使用本次导入的资料"]',
    );
    expect(consent?.checked).toBe(false);
  });

  it("routes the home heading import action through first-library naming", async () => {
    await act(async () => button("导入资料").click());

    expectFirstImportNaming();
  });

  it("routes the knowledge-library quick import action through first-library naming", async () => {
    await navigateTo("#library");
    const importLabel = [...host.querySelectorAll(".collection-action strong")].find(
      (item) => item.textContent === "导入资料",
    );
    expect(importLabel?.closest("button")).toBeInstanceOf(HTMLButtonElement);

    await act(async () => (importLabel!.closest("button") as HTMLButtonElement).click());

    expectFirstImportNaming();
  });

  it("routes an empty library's import action through first-library naming", async () => {
    await navigateTo(`#library/${data.spaces[0]!.id}`);
    await act(async () => button("导入资料").click());

    expectFirstImportNaming();
  });

  it("keeps browser-only status visible through account settings when cloud sync is unavailable", async () => {
    const entry = host.querySelector<HTMLButtonElement>(
      '.sidebar-bottom [aria-label="账号与设置"]',
    );
    expect(entry).toBeInstanceOf(HTMLButtonElement);
    expect(entry?.textContent).toContain("本机工作区");
    expect(entry?.textContent).toContain("账号与设置");
    expect(host.textContent).toContain("云端同步暂不可用");
    expect(host.textContent).not.toContain("登录以连接云端");

    await act(async () => entry!.click());
    expect(window.location.hash).toBe("#settings/account");
    expect(host.querySelector(".settings-card")?.textContent).toContain(
      "云端同步暂不可用。资料仅保存在此浏览器",
    );
    expect(host.textContent).not.toContain("Supabase");
    expect(host.querySelector('input[type="email"]')).toBeNull();
  });

  it("offers an explicit latest-data action and exports pending memory before replacement", async () => {
    const loadLatestLocal = vi.fn(async (preserve: (snapshot: typeof data) => Promise<boolean>) =>
      preserve(data),
    );
    workspaceStore = {
      ...workspaceStore,
      localUpdateRevision: 2,
      loadingLocalUpdate: false,
      loadLatestLocal,
      status: "error",
      error: "另一个标签页已更新本机工作区。",
    };
    await act(async () => root.render(createElement(Workspace)));

    expect(host.textContent).toContain("其他标签页保存了更新");
    expect(host.textContent).toContain("先下载一份可恢复备份");
    expect(
      [...host.querySelectorAll("button")].some((item) => item.textContent === "重新连接"),
    ).toBe(false);
    await act(async () => button("载入最新数据").click());
    await vi.waitFor(() => expect(loadLatestLocal).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(exportWorkspace).toHaveBeenCalledOnce());
    expect(vi.mocked(exportWorkspace).mock.calls[0]?.[0]).toBe(data);
    expect(host.textContent).toContain("本页修改已下载为可恢复备份");
  });
});
