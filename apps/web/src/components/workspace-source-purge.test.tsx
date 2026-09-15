// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import {
  permanentSourceDeletionBlockers,
  previewPermanentSourceDeletion,
  previewPermanentSourceDeletionContent,
  type PermanentSourceDeletionSelection,
} from "@/lib/permanent-deletion";
import type { WorkspaceData } from "@/lib/types";

let workspaceStore: Record<string, unknown>;
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/use-workspace", () => ({ useWorkspace: () => workspaceStore }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { signOut: vi.fn() } }) }));
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("Workspace source purge completion context", () => {
  let host: HTMLDivElement;
  let root: Root;
  let data: WorkspaceData;
  let purge: ReturnType<typeof vi.fn<(sourceId: string) => Promise<void>>>;
  let dialogDescriptors: { show?: PropertyDescriptor; close?: PropertyDescriptor };
  const successText = "资料元数据已彻底删除。云端原件会由后台任务清理";

  function fixture() {
    const result = createDemoWorkspace();
    const base = result.sources[0]!;
    result.sources = ["a", "b"].map((name) => ({
      ...base,
      id: `source-${name}`,
      versionId: `version-${name}`,
      title: name === "a" ? "待删除的算法资料" : "另一份回收站资料",
      chunks: base.chunks.map((chunk, index) => ({
        ...chunk,
        id: `${name}-chunk-${index}`,
        sourceId: `source-${name}`,
        versionId: `version-${name}`,
      })),
      deletedAt: "2026-09-14T00:00:00.000Z",
    }));
    result.notes = [];
    result.conversations = [];
    result.annotations = [];
    result.organizationJobs = [];
    result.conceptRelations = [];
    result.importJobs = [];
    result.recoverableDrafts = [];
    result.resolvedRecoverableDrafts = [];
    return result;
  }

  function makeStore() {
    data = fixture();
    purge = vi.fn(async () => {});
    workspaceStore = {
      token: 7,
      data,
      ready: true,
      status: "cloud",
      error: "",
      localCacheMode: "normal",
      user: { id: "account-a", email: "learner@example.test" },
      anonymousMigration: { kind: "none", canMigrate: false },
      signOutState: { kind: "ready", canSync: false, canKeepLocalDraft: false },
      organizationStatus: { ready: true, running: false, message: "" },
      update: vi.fn(),
      updateDurably: vi.fn(),
      signOut: vi.fn(),
      ask: vi.fn(),
      cancelImport: vi.fn(),
      checkOrganization: vi.fn(),
      discardAccount: vi.fn(),
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
      previewSourcePurge: vi.fn(
        async (sourceId: string, selection?: PermanentSourceDeletionSelection) => {
          const current = workspaceStore.data as WorkspaceData;
          return {
            revision: 5,
            fingerprint: "a".repeat(64),
            impact: previewPermanentSourceDeletion(current, sourceId, selection),
            blockers: permanentSourceDeletionBlockers(current, sourceId, selection),
            contentSelection: previewPermanentSourceDeletionContent(current, sourceId, selection),
          };
        },
      ),
      purgeSource: purge,
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
  }

  beforeEach(() => {
    vi.useFakeTimers();
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
    makeStore();
    window.history.replaceState(null, "", "#trash");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    window.history.replaceState(null, "", "/");
    for (const [name, descriptor] of [
      ["showModal", dialogDescriptors.show],
      ["close", dialogDescriptors.close],
    ] as const) {
      if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
      else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function render(overrides: Record<string, unknown> = {}) {
    workspaceStore = { ...workspaceStore, ...overrides };
    await act(async () => {
      root.render(createElement(Workspace));
    });
  }

  function dialog() {
    return host.querySelector<HTMLDialogElement>("dialog[open]");
  }

  async function openPurge(sourceId = "source-a") {
    const title = (workspaceStore.data as WorkspaceData).sources.find(
      (source) => source.id === sourceId,
    )!.title;
    const row = [...host.querySelectorAll(".trash-row")].find(
      (candidate) => candidate.querySelector("b")?.textContent === title,
    )!;
    const trigger = [...row.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "彻底删除",
    )!;
    await act(async () => {
      trigger.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(dialog()?.querySelector("h2")?.textContent).toBe(`彻底删除「${title}」？`);
    return title;
  }

  async function startPendingPurge() {
    await render();
    const title = await openPurge();
    const pending = deferred();
    purge.mockImplementationOnce(() => pending.promise);
    await act(async () => {
      const input = dialog()!.querySelector<HTMLInputElement>(
        "input[aria-label='输入资料名称以确认彻底删除']",
      )!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, title);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      [...dialog()!.querySelectorAll("button")]
        .find((button) => button.textContent === "彻底删除资料")!
        .click();
    });
    expect(purge).toHaveBeenCalledOnce();
    expect(purge.mock.calls[0]![0]).toBe("source-a");
    const current = workspaceStore.data as WorkspaceData;
    await render({
      data: { ...current, sources: current.sources.filter((source) => source.id !== "source-a") },
      ready: false,
      purging: true,
      status: "saving",
    });
    expect(dialog()).toBeNull();
    return pending;
  }

  it("reports normal success after the committed metadata removes the source before local completion", async () => {
    const pending = await startPendingPurge();
    await render({ ready: true, purging: false, status: "cloud" });
    await act(async () => {
      pending.resolve();
    });
    expect(host.querySelector(".toast")?.textContent).toContain(successText);
    expect(dialog()).toBeNull();
    expect(purge).toHaveBeenCalledOnce();
  });

  it("discards success independently after an owner, session token or cache-mode change", async () => {
    for (const changed of [
      { user: { id: "account-b", email: "other@example.test" } },
      { token: 8 },
      { localCacheMode: "cloud-read-only" },
    ]) {
      const pending = await startPendingPurge();
      await render({ ...changed, ready: true, purging: false, status: "cloud" });
      await act(async () => {
        pending.resolve();
      });
      expect(
        host.querySelector(".toast")?.textContent ?? "",
        JSON.stringify(changed),
      ).not.toContain(successText);
      expect(purge).toHaveBeenCalledOnce();
      await act(async () => {
        root.unmount();
      });
      root = createRoot(host);
      makeStore();
    }
  });

  it("does not close a newly opened knowledge-base modal when the old purge resolves", async () => {
    const pending = await startPendingPurge();
    await act(async () => {
      host.querySelector<HTMLButtonElement>("button[aria-label='新建知识库']")!.click();
    });
    const newModal = dialog();
    expect(newModal?.querySelector("h2")?.textContent).toBe("新建知识库");
    await act(async () => {
      pending.resolve();
    });
    expect(dialog()).toBe(newModal);
    expect(host.querySelector(".toast")?.textContent ?? "").not.toContain(successText);
  });

  it("keeps a later source's purge confirmation open in the same account and modal kind", async () => {
    const pending = await startPendingPurge();
    await render({ ready: true, purging: false, status: "cloud" });
    await openPurge("source-b");
    const laterModal = dialog();
    await act(async () => {
      pending.resolve();
    });
    expect(dialog()).toBe(laterModal);
    expect(dialog()?.querySelector("h2")?.textContent).toBe("彻底删除「另一份回收站资料」？");
    expect(host.querySelector(".toast")?.textContent ?? "").not.toContain(successText);
    expect(purge).toHaveBeenCalledOnce();
  });

  it("does not affect a fresh Workspace after the original instance unmounts", async () => {
    const pending = await startPendingPurge();
    await act(async () => {
      root.unmount();
    });
    root = createRoot(host);
    makeStore();
    await render({ token: 8, user: { id: "account-b", email: "other@example.test" } });
    await act(async () => {
      host.querySelector<HTMLButtonElement>("button[aria-label='新建知识库']")!.click();
    });
    const newModal = dialog();
    await act(async () => {
      pending.resolve();
    });
    expect(dialog()).toBe(newModal);
    expect(host.querySelector(".toast")?.textContent ?? "").not.toContain(successText);
  });
});
