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

describe("Workspace settings sync status", () => {
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

    workspaceStore = {
      token: 1,
      data: createEmptyWorkspace(),
      update: vi.fn(),
      updateDurably: vi.fn(),
      ready: true,
      status: "error",
      error: "网络中断，云端保存尚未确认。",
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
    window.history.replaceState(null, "", "#settings/reading");
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

  it("shows the confirmed workspace state instead of inferring it from the connected account", async () => {
    const currentStatus = () =>
      host.querySelector<HTMLElement>('[aria-label="当前工作区保存状态"]');
    expect(currentStatus()?.textContent).toContain("当前工作区保存状态：保存需要处理");
    expect(currentStatus()?.textContent).toContain("网络中断，云端保存尚未确认。");

    workspaceStore = { ...workspaceStore, status: "cloud", error: "" };
    await act(async () => root.render(createElement(Workspace)));

    expect(currentStatus()?.textContent).toContain("当前工作区保存状态：工作区已保存到云端");
    expect(currentStatus()?.textContent).toContain("当前任务记录与资料库状态已确认保存。");
  });

  it("describes the connected account without implying a confirmed save", async () => {
    await act(async () => {
      window.history.replaceState(null, "", "#settings/account");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    expect(host.textContent).toContain("已连接账号");
    expect(host.textContent).toContain("以服务确认状态为准");
    expect(host.textContent).not.toContain("资料保存到你的私有云端空间");
    // The save state stays in its own settings group, so the account group
    // cannot be mistaken for a save confirmation.
    expect(host.querySelector('[aria-label="当前工作区保存状态"]')).toBeNull();
  });

  it("opens the global task center from the settings status", async () => {
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "查看同步与任务",
    );
    expect(button).toBeInstanceOf(HTMLButtonElement);

    await act(async () => button!.click());

    expect(window.location.hash).toBe("#tasks");
  });

  it("keeps only the automatic-organization switch in the AI group", async () => {
    await act(async () => {
      window.history.replaceState(null, "", "#settings/ai");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    expect(host.querySelector('[aria-label="自动整理资料"]')).toBeInstanceOf(HTMLInputElement);
    // Reviewing organization work belongs to the task center and the knowledge
    // tab's "从资料生成"; settings only decides whether it runs.
    expect(
      [...host.querySelectorAll<HTMLButtonElement>("button")].some(
        (item) => item.textContent?.trim() === "查看整理任务与建议",
      ),
    ).toBe(false);
  });
});
