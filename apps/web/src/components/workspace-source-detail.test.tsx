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
vi.mock("./collection-library", () => ({
  default: () => null,
  CollectionActions: () => null,
}));
vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./workspace-search", () => ({ default: () => null }));
vi.mock("./indexing-panel", () => ({ default: () => null }));
vi.mock("./web-import-form", () => ({ default: () => null }));

import Workspace from "./workspace";

const currentTitle = "梯度下降讲义";
const otherTitle = "反向传播笔记";

describe("Workspace source detail panel", () => {
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
    const first = data.sources[0]!;
    const second = data.sources[1]!;
    first.title = currentTitle;
    first.kind = "pdf";
    first.pageCount = 12;
    first.parsedPages = 12;
    first.versionCreatedAt = "2026-09-10T08:00:00.000Z";
    first.versions = [
      {
        versionId: "earlier-version",
        title: currentTitle,
        filename: "gradient-v1.pdf",
        kind: "pdf",
        mime: "application/pdf",
        size: 2048,
        hash: "a".repeat(64),
        status: "ready",
        text: "第一版正文",
        chunks: [],
        createdAt: "2026-09-01T08:00:00.000Z",
        archivedAt: "2026-09-10T08:00:00.000Z",
      },
    ];
    second.title = otherTitle;
    // The default sort is by update time; pin it so row order is readable here.
    first.updatedAt = "2026-09-14T08:00:00.000Z";
    second.updatedAt = "2026-09-13T08:00:00.000Z";
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
      updateDurably: vi.fn(async () => true),
      getCurrentWorkspaceData: () => data,
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

  function panel() {
    return host.querySelector<HTMLElement>('[aria-label="资料详情"]');
  }

  function rows() {
    return [...host.querySelectorAll(".source-row .source-open b")].map((item) => item.textContent);
  }

  async function openDetail(title: string) {
    const manage = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === `管理 ${title}`,
    );
    expect(manage, `manage ${title}`).toBeInstanceOf(HTMLButtonElement);
    await act(async () => manage!.click());
    expect(panel()).toBeInstanceOf(HTMLElement);
  }

  function tab(label: string) {
    const control = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (item) => item.textContent?.trim() === label,
    );
    expect(control, `detail tab ${label}`).toBeInstanceOf(HTMLButtonElement);
    return control!;
  }

  async function openTab(label: string) {
    await act(async () => tab(label).click());
  }

  function button(text: string, scope: ParentNode = host) {
    const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.replace(/\s+/gu, "") === text.replace(/\s+/gu, ""),
    );
    expect(match, `button ${text}`).toBeInstanceOf(HTMLButtonElement);
    return match!;
  }

  it("docks beside the library list instead of covering it with a dialog", async () => {
    expect(rows()).toEqual([currentTitle, otherTitle]);
    await openDetail(currentTitle);

    // The list keeps every row, so the next source is one click away.
    expect(rows()).toEqual([currentTitle, otherTitle]);
    expect(host.querySelector("dialog")).toBeNull();
    expect(panel()!.closest("main")).toBeNull();
    expect(panel()!.textContent).toContain(currentTitle);

    await openDetail(otherTitle);
    expect(panel()!.querySelector("header")?.textContent).toContain(otherTitle);
    expect(tab("基本").getAttribute("aria-selected")).toBe("true");
    expect(rows()).toEqual([currentTitle, otherTitle]);

    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="关闭资料详情"]')!.click(),
    );
    expect(panel()).toBeNull();
    expect(rows()).toEqual([currentTitle, otherTitle]);
  });

  it("splits details into a basic, a recognized-content and a version tab", async () => {
    await openDetail(currentTitle);

    expect(
      [...host.querySelectorAll('[role="tab"]')].map((item) => item.textContent?.trim()),
    ).toEqual(["基本", "已识别内容", "版本"]);
    expect(host.querySelector<HTMLInputElement>(".source-detail-body .field")?.value).toBe(
      currentTitle,
    );
    expect(panel()!.textContent).toContain("允许 AI 使用这份资料");
    expect(panel()!.querySelector("fieldset legend")?.textContent).toBe("所属学习空间");
    expect(host.querySelector('[aria-label="资料元数据"]')).toBeTruthy();
    expect(host.querySelector('[aria-label="资料版本记录"]')).toBeNull();

    await openTab("已识别内容");
    expect(tab("已识别内容").getAttribute("aria-selected")).toBe("true");
    expect(panel()!.textContent).toContain("资料可用范围");
    expect(panel()!.querySelectorAll(".recognized-content-chunk").length).toBeGreaterThan(0);
    expect(host.querySelector('[aria-label="资料元数据"]')).toBeNull();

    await openTab("版本");
    const versions = host.querySelector<HTMLElement>('[aria-label="资料版本记录"]');
    expect(versions).toBeInstanceOf(HTMLElement);
    expect(versions!.querySelectorAll("li")).toHaveLength(2);
    expect(versions!.textContent).toContain("当前版本");
    expect(versions!.textContent).toContain("历史版本");
    expect(versions!.textContent).toContain("gradient-v1.pdf");
    // Replacing or restoring retained content still belongs to the reader.
    expect(versions!.textContent).toContain("资料版本记录");

    await openTab("基本");
    expect(host.querySelector('[aria-label="资料元数据"]')).toBeTruthy();
  });

  it("keeps secondary metadata one disclosure away on the basic tab", async () => {
    await openDetail(currentTitle);
    const moreInfo = host.querySelector<HTMLElement>("#source-detail-more-info");
    expect(moreInfo?.hidden).toBe(true);
    expect(button("更多信息").getAttribute("aria-expanded")).toBe("false");

    await act(async () => button("更多信息").click());
    expect(moreInfo?.hidden).toBe(false);
    const extra = host.querySelector<HTMLElement>('[aria-label="更多资料信息"]');
    expect(extra!.textContent).toContain("导入来源");
    expect(extra!.textContent).toContain("原文件");
    expect(extra!.textContent).toContain("识别范围");

    await act(async () => button("收起更多信息").click());
    expect(moreInfo?.hidden).toBe(true);
  });

  it("offers reading plus three secondary actions and edits the name in place", async () => {
    await openDetail(currentTitle);
    const input = host.querySelector<HTMLInputElement>(".source-detail-body .field")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "梯度下降讲义 · 第二版");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(data.sources[0]!.title).toBe("梯度下降讲义 · 第二版");

    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="更多资料操作"]')!.click(),
    );
    const menu = host.querySelector<HTMLElement>('[aria-label="更多资料操作"][role="group"]')!;
    expect([...menu.querySelectorAll("button")].map((item) => item.textContent?.trim())).toEqual([
      "下载原件",
      "AI 建议",
      "移入回收站",
    ]);

    await act(async () => button("移入回收站", menu).click());
    expect(host.querySelector(".bulk-recycle-modal")).not.toBeNull();
    expect(host.querySelector(".bulk-recycle-modal")?.textContent).toContain("1");
  });

  it("opens ordinary reading from the basic tab without a recognized-content return", async () => {
    await openDetail(currentTitle);
    await act(async () => button("打开阅读").click());

    expect(window.location.hash).toBe(`#source/${data.sources[0]!.id}`);
    expect(panel()).toBeNull();
  });
});
