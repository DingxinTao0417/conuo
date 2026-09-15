// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import type { WorkspaceData } from "@/lib/types";

let workspaceStore: Record<string, unknown>;

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/use-workspace", () => ({ useWorkspace: () => workspaceStore }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signOut: vi.fn() } }),
}));
vi.mock("@/lib/cloud", () => ({
  isCloudConfigured: () => false,
  previewAccountDeletion: vi.fn(),
  requestAccountDeletion: vi.fn(),
}));
vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./workspace-search", () => ({ default: () => null }));
vi.mock("./indexing-panel", () => ({ default: () => null }));
vi.mock("./web-import-form", () => ({ default: () => null }));

import Workspace from "./workspace";

describe("Workspace library toolbar", () => {
  let host: HTMLDivElement;
  let root: Root;
  let data: WorkspaceData;
  let spaceId: string;

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
    data.sources[0]!.kind = "pdf";
    data.sources[0]!.tags = ["机器学习"];
    data.sources[1]!.tags = ["课程资料"];
    workspaceStore = {
      token: 1,
      data,
      ready: true,
      status: "local",
      localCacheMode: "normal",
      user: undefined,
      update: vi.fn((updater: (current: WorkspaceData) => WorkspaceData) => {
        data = updater(data);
        workspaceStore = { ...workspaceStore, data };
        return true;
      }),
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
      organizationStatus: undefined,
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
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await open(`#library/${spaceId}`);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
  });

  async function open(hash: string) {
    window.history.replaceState(null, "", hash);
    await act(async () => root.render(createElement(Workspace)));
    await act(async () => window.dispatchEvent(new HashChangeEvent("hashchange")));
  }

  function toolbar() {
    const tools = host.querySelector<HTMLElement>(".library-tools");
    expect(tools).toBeInstanceOf(HTMLElement);
    return tools!;
  }

  function trigger(label: string) {
    const control = [...toolbar().querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.getAttribute("aria-label")?.startsWith(label),
    );
    expect(control, label).toBeInstanceOf(HTMLButtonElement);
    return control!;
  }

  async function openMenu(label: string) {
    const control = trigger(label);
    if (control.getAttribute("aria-expanded") !== "true") await act(async () => control.click());
    return control;
  }

  function select(label: string) {
    const control = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
    expect(control, label).toBeInstanceOf(HTMLSelectElement);
    return control!;
  }

  async function choose(label: string, value: string) {
    const control = select(label);
    await act(async () => {
      control.value = value;
      control.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  function button(text: string, scope: ParentNode = host) {
    const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.replace(/\s+/gu, "") === text.replace(/\s+/gu, ""),
    );
    expect(match, `button ${text}`).toBeInstanceOf(HTMLButtonElement);
    return match!;
  }

  it("keeps five controls in the toolbar and moves library-wide actions into ⋯", async () => {
    const slots = [...toolbar().children].filter((child) => !child.hasAttribute("aria-hidden"));
    expect(slots).toHaveLength(5);
    expect(toolbar().querySelector('.search-field [aria-label="资料搜索方式"]')).toBeTruthy();
    expect(toolbar().querySelector('input[aria-label="搜索资料"]')).toBeTruthy();
    expect(trigger("筛选资料").textContent).toContain("筛选");
    expect(trigger("资料视图设置").textContent).toContain("视图");
    expect(toolbar().querySelector(".library-import-action")?.textContent?.trim()).toBe("导入");

    // The quick-action cards belong to the all-libraries home, not to a library.
    expect(host.querySelector(".collection-actions")).toBeNull();

    await openMenu("更多资料库操作");
    const menu = host.querySelector<HTMLElement>('[aria-label="更多资料库操作"][role="group"]');
    expect(menu).toBeInstanceOf(HTMLElement);
    expect([...menu!.querySelectorAll("button")].map((item) => item.textContent?.trim())).toEqual([
      "导出此知识库",
      "新建笔记",
    ]);
  });

  it("restores every filter, sort and layout choice from one library link", async () => {
    await open(
      `#library/${spaceId}?filter=pdf&time=365d&sort=name&layout=grid&tag=%E6%9C%BA%E5%99%A8%E5%AD%A6%E4%B9%A0`,
    );

    expect(host.querySelector(".source-list.source-grid")).toBeTruthy();
    expect(trigger("筛选资料").getAttribute("aria-label")).toBe("筛选资料，已应用 3 项");

    await openMenu("筛选资料");
    expect(select("筛选资料类型").value).toBe("pdf");
    expect(select("按添加时间筛选资料").value).toBe("365d");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="标签 机器学习"]')?.checked).toBe(
      true,
    );

    await openMenu("资料视图设置");
    expect(select("资料排序方式").value).toBe("name");
    expect(
      host
        .querySelector<HTMLButtonElement>('[aria-label="卡片视图"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("writes sort and layout back to the library link from the view menu", async () => {
    await openMenu("资料视图设置");
    await choose("资料排序方式", "created");
    expect(window.location.hash).toBe(`#library/${spaceId}?sort=created`);

    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="卡片视图"]')!.click(),
    );
    expect(window.location.hash).toBe(`#library/${spaceId}?sort=created&layout=grid`);
    expect(host.querySelector(".source-list.source-grid")).toBeTruthy();

    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="列表视图"]')!.click(),
    );
    expect(window.location.hash).toBe(`#library/${spaceId}?sort=created`);
  });

  it("counts active filters on the trigger and clears all of them at once", async () => {
    await openMenu("筛选资料");
    await choose("筛选资料类型", "pdf");
    await choose("按添加时间筛选资料", "365d");
    await act(async () =>
      host.querySelector<HTMLInputElement>('input[aria-label="标签 机器学习"]')!.click(),
    );

    expect(trigger("筛选资料").getAttribute("aria-label")).toBe("筛选资料，已应用 3 项");
    expect(trigger("筛选资料").textContent).toContain("3");
    expect(window.location.hash).toContain("filter=pdf");
    expect(window.location.hash).toContain("time=365d");
    expect(window.location.hash).toContain("tag=");

    const clear = host.querySelector<HTMLButtonElement>('[aria-label="清除全部筛选"]')!;
    expect(clear.disabled).toBe(false);
    await act(async () => clear.click());

    expect(window.location.hash).toBe(`#library/${spaceId}`);
    expect(trigger("筛选资料").getAttribute("aria-label")).toBe("筛选资料");
    expect(host.querySelector<HTMLButtonElement>('[aria-label="清除全部筛选"]')?.disabled).toBe(
      true,
    );
  });

  it("closes an open popover on a press outside it without losing the choice", async () => {
    await openMenu("筛选资料");
    await choose("筛选资料类型", "pdf");
    await act(async () =>
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
    );

    expect(host.querySelector('[role="dialog"][aria-label="筛选资料"]')).toBeNull();
    expect(trigger("筛选资料").getAttribute("aria-expanded")).toBe("false");
    expect(trigger("筛选资料").getAttribute("aria-label")).toBe("筛选资料，已应用 1 项");
  });

  it("imports from the toolbar and creates a note from ⋯", async () => {
    await act(async () => button("导入").click());
    expect(host.textContent).toContain("导入学习资料");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());

    await openMenu("更多资料库操作");
    await act(async () => button("新建笔记").click());
    expect(window.location.hash).toMatch(/^#note\//u);
    expect(data.notes[0]).toMatchObject({ kind: "note", title: "未命名笔记" });
  });
});
