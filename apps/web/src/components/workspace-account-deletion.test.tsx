// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import type { AccountSignOutControl } from "./account-panel";

type AccountProps = {
  onAccountDeletion: (accountId: string) => Promise<void>;
  signOutControl?: AccountSignOutControl;
};

let workspaceStore: Record<string, unknown>;
let accountProps: AccountProps | undefined;
const auth = vi.hoisted(() => ({ signOut: vi.fn() }));

vi.mock("next/dynamic", () => ({
  default: (loader: () => unknown) =>
    String(loader).includes("account-panel")
      ? (props: AccountProps) => {
          accountProps = props;
          return createElement("div", { "data-testid": "account-panel" });
        }
      : String(loader).includes("backup-restore-panel")
        ? () => createElement("div", { "data-testid": "backup-review" }, "当前备份预览")
        : () => null,
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/use-workspace", () => ({ useWorkspace: () => workspaceStore }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth }) }));
vi.mock("@/lib/cloud", () => ({
  isCloudConfigured: () => true,
  previewAccountDeletion: vi.fn(),
  requestAccountDeletion: vi.fn(),
}));
vi.mock("@/lib/knowledge-update-review-drafts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/knowledge-update-review-drafts")>()),
  loadKnowledgeUpdateReviewDrafts: vi.fn(async (accountId: string) => ({
    accountId,
    epoch: 0,
    generation: "isolated-draft-session",
    drafts: [],
  })),
  clearAccountKnowledgeUpdateReviewDrafts: vi.fn(async () => {}),
}));
vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./workspace-search", () => ({ default: () => null }));
vi.mock("./indexing-panel", () => ({ default: () => null }));
vi.mock("./web-import-form", () => ({ default: () => null }));

import Workspace from "./workspace";

function deferred() {
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((_resolve, no) => {
    reject = no;
  });
  return { promise, reject };
}

describe("Workspace account deletion access barrier", () => {
  let host: HTMLDivElement;
  let root: Root;
  let dialogDescriptors: { show?: PropertyDescriptor; close?: PropertyDescriptor };
  const privateTitle = "仅属于已注销账号的资料";
  const privateText = "PRIVATE_DELETED_ACCOUNT_SOURCE_TEXT";
  const privateNote = "PRIVATE_DELETED_ACCOUNT_NOTE_TEXT";

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    dialogDescriptors = {
      show: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal"),
      close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close"),
    };
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.removeAttribute("open");
      },
    });
    const data = createDemoWorkspace();
    data.sources = [
      { ...data.sources[0]!, title: privateTitle, text: privateText, spaceIds: [], starred: false },
    ];
    data.notes = [
      {
        id: "private-note",
        title: "旧账号的私人笔记",
        kind: "note",
        status: "accepted",
        spaceId: "inbox",
        content: `<p>${privateNote}</p>`,
        citations: [],
        versions: [],
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z",
        deletedAt: null,
      },
    ];
    data.conversations = [];
    data.organizationJobs = [];
    data.importJobs = [];
    workspaceStore = {
      token: 11,
      data,
      ready: true,
      status: "cloud",
      error: "",
      localCacheMode: "normal",
      accountDeletionState: undefined,
      user: { id: "account-a", email: "learner@example.test" },
      anonymousMigration: { kind: "none", canMigrate: false },
      signOutState: { kind: "unsynced", canSync: true, canKeepLocalDraft: true },
      safeSignOut: vi.fn(),
      organizationStatus: { ready: true, running: false, message: "" },
      update: vi.fn(),
      updateDurably: vi.fn(),
      signOut: vi.fn(),
      ask: vi.fn(),
      cancelImport: vi.fn(),
      checkOrganization: vi.fn(),
      discardAccount: vi.fn(async () => {}),
      retryAccountLocalDeletion: vi.fn(async () => {}),
      importFile: vi.fn(),
      loadLatestLocal: vi.fn(),
      localUpdateRevision: null,
      loadingLocalUpdate: false,
      cloudUpdateRevision: null,
      checkingCloudUpdate: false,
      loadingCloudUpdate: false,
      cloudUpdateError: "",
      cloudAdoptionSequence: 0,
      loadCloudUpdate: vi.fn(),
      checkCloudUpdates: vi.fn(),
      setPendingReadingPosition: vi.fn(),
      noteSyncPlan: undefined,
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
    accountProps = undefined;
    auth.signOut.mockReset();
    window.history.replaceState(null, "", "#library/inbox");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
    for (const [name, descriptor] of [
      ["showModal", dialogDescriptors.show],
      ["close", dialogDescriptors.close],
    ] as const) {
      if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
      else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    }
    vi.unstubAllGlobals();
  });

  async function render(overrides: Record<string, unknown> = {}) {
    workspaceStore = { ...workspaceStore, ...overrides };
    await act(async () => root.render(createElement(Workspace)));
  }

  function button(label: string) {
    const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    expect(result, label).toBeInstanceOf(HTMLButtonElement);
    return result!;
  }

  it("replaces both ready content and ordinary loading/error UI in every deletion state", async () => {
    await render();
    expect(host.textContent).toContain(privateTitle);
    for (const state of ["clearing", "blocked", "cleanup-failed"] as const) {
      for (const ready of [false, true]) {
        await render({
          ready,
          accountDeletionState: state,
          status: "error",
          error: "注销账号不能重新连接",
        });
        expect(host.querySelector(".account-access-stopped")).not.toBeNull();
        expect(host.querySelector(".page-loading")).toBeNull();
        expect(host.querySelector(".notice.notice-warning")).toBeNull();
        expect(host.textContent).not.toContain("正在打开学习空间");
        expect(host.textContent).not.toContain("正在安全删除资料");
        expect(host.textContent).not.toContain(privateTitle);
        expect(host.textContent).not.toContain(privateText);
        expect(host.textContent).not.toContain(privateNote);
        expect(
          [...host.querySelectorAll("button")].some((item) => item.textContent === "重新连接"),
        ).toBe(false);
      }
    }
    expect(workspaceStore.retry).not.toHaveBeenCalled();
    expect(workspaceStore.sourceBlob).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("retries only local deletion once for simultaneous clicks and stays stopped on failure", async () => {
    const pending = deferred();
    const retry = vi.fn(() => pending.promise);
    await render({
      ready: false,
      status: "error",
      accountDeletionState: "cleanup-failed",
      retryAccountLocalDeletion: retry,
    });
    await act(async () => {
      const trigger = button("重试清理本机资料");
      trigger.click();
      trigger.click();
    });
    expect(retry).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledWith();
    expect(workspaceStore.retry).not.toHaveBeenCalled();
    expect(workspaceStore.loadCloudUpdate).not.toHaveBeenCalled();
    expect(workspaceStore.useRemote).not.toHaveBeenCalled();
    expect(workspaceStore.safeSignOut).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
    await act(async () => pending.reject(new Error("still blocked by local disk")));
    expect(host.querySelector(".account-access-stopped-warning")?.textContent).toContain(
      "本机缓存未能完全清理",
    );
    expect(host.querySelector(".page-loading")).toBeNull();
    expect(host.textContent).not.toContain(privateTitle);
    retry.mockResolvedValueOnce(undefined);
    await act(async () => button("重试清理本机资料").click());
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("opens account state with the exact cache cleanup callback and no ordinary exit controls", async () => {
    await render({ ready: false, accountDeletionState: "blocked" });
    await act(async () => button("查看账号状态").click());
    expect(host.querySelector("dialog[open] [data-testid='account-panel']")).not.toBeNull();
    expect(accountProps?.onAccountDeletion).toBe(workspaceStore.discardAccount);
    expect(accountProps?.signOutControl).toBeUndefined();
    await act(async () => accountProps!.onAccountDeletion("account-a"));
    expect(workspaceStore.discardAccount).toHaveBeenCalledExactlyOnceWith("account-a");
    expect(workspaceStore.safeSignOut).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it.each([".sidebar-bottom .user-button", ".topbar-account"])(
    "keeps recovery available through %s when account access is blocked",
    async (selector) => {
      await render({ ready: false, accountDeletionState: "blocked" });
      const previousHash = window.location.hash;
      const trigger = host.querySelector<HTMLButtonElement>(selector);
      expect(trigger).toBeInstanceOf(HTMLButtonElement);
      await act(async () => trigger!.click());
      expect(window.location.hash).toBe(previousHash);
      expect(host.querySelector(".account-access-stopped")).not.toBeNull();
      expect(host.querySelector("dialog[open] [data-testid='account-panel']")).not.toBeNull();
      expect(accountProps?.onAccountDeletion).toBe(workspaceStore.discardAccount);
      expect(accountProps?.signOutControl).toBeUndefined();
    },
  );

  it("closes an ongoing backup review when account access stops and does not revive it afterward", async () => {
    window.history.replaceState(null, "", "#settings/storage");
    await render();
    await act(async () => button("恢复备份").click());
    expect(host.querySelector("[data-testid='backup-review']")).not.toBeNull();
    await render({ ready: false, token: 12, accountDeletionState: "clearing" });
    expect(host.querySelector("[data-testid='backup-review']")).toBeNull();
    expect(host.querySelector(".account-access-stopped")).not.toBeNull();
    await render({ ready: true, token: 13, accountDeletionState: null });
    expect(host.querySelector("[data-testid='backup-review']")).toBeNull();
  });

  it("offers verification without implying deletion or calling cache cleanup for an unreadable account marker", async () => {
    const retry = vi.fn(async () => {});
    await render({
      ready: false,
      accountAccessVerificationFailed: true,
      localCacheMode: "cloud-readonly",
      error: "无法核验本机账号注销状态",
      retry,
    });
    expect(host.textContent).toContain("暂时无法核验账号状态");
    expect(host.textContent).not.toContain("账号注销已开始");
    expect(host.textContent).not.toContain("清理完成后将移除账号");
    expect(host.querySelector(".page-loading")).toBeNull();
    expect(host.textContent).not.toContain(privateTitle);
    await act(async () => button("重新核验账号状态").click());
    expect(retry).toHaveBeenCalledExactlyOnceWith();
    expect(workspaceStore.retryAccountLocalDeletion).not.toHaveBeenCalled();
    expect(workspaceStore.discardAccount).not.toHaveBeenCalled();
    await act(async () => button("查看账号状态").click());
    expect(accountProps?.signOutControl).toBeDefined();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("preserves the ordinary loading and reconnect flow for an account without a deletion marker", async () => {
    await render({ ready: false, status: "error", error: "网络暂时断开" });
    expect(host.querySelector(".account-access-stopped")).toBeNull();
    expect(host.querySelector(".page-loading")?.textContent).toContain("正在打开学习空间");
    expect(host.querySelector(".notice.notice-warning")?.textContent).toContain("网络暂时断开");
    expect(button("重新连接")).not.toBeNull();
    expect(workspaceStore.retryAccountLocalDeletion).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });
});
