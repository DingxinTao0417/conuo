// @vitest-environment jsdom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";

let workspaceStore: Record<string, unknown>;
const panelLifecycle = vi.hoisted(() => ({
  mounts: 0,
  unmounts: 0,
  controller: null as AbortController | null,
}));

vi.mock("next/dynamic", () => ({
  default: () =>
    function DynamicPanel(props: Record<string, unknown>) {
      const isCrossLibraryPanel = typeof props.onActiveConversationChange === "function";

      useEffect(() => {
        if (!isCrossLibraryPanel) return;
        const controller = new AbortController();
        panelLifecycle.controller = controller;
        panelLifecycle.mounts += 1;
        return () => {
          controller.abort();
          panelLifecycle.unmounts += 1;
        };
      }, [isCrossLibraryPanel]);

      if (!isCrossLibraryPanel) return null;
      return createElement(
        "button",
        {
          type: "button",
          onClick: () => {
            (props.onBusyChange as ((busy: boolean) => void) | undefined)?.(true);
            (props.onActiveConversationChange as (conversationId: string) => void)(
              "new-cross-library-thread",
            );
          },
        },
        "模拟发送预填问题",
      );
    },
}));
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
vi.mock("./workspace-search", () => ({
  default: (props: {
    data: { sources: { id: string }[] };
    askDisabled?: boolean;
    onAskSources: (draft: { question: string; sourceIds: string[] }) => void;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        disabled: props.askDisabled,
        onClick: () =>
          props.onAskSources({
            question: "这些资料如何解释学习率？",
            sourceIds: [props.data.sources[0]!.id],
          }),
      },
      "模拟选择问题资料",
    ),
}));
vi.mock("./indexing-panel", () => ({ default: () => null }));
vi.mock("./web-import-form", () => ({ default: () => null }));

import Workspace from "./workspace";

describe("Workspace question-search handoff", () => {
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

    panelLifecycle.mounts = 0;
    panelLifecycle.unmounts = 0;
    panelLifecycle.controller = null;
    const data = createDemoWorkspace();
    workspaceStore = {
      token: 1,
      data,
      update: vi.fn(),
      updateDurably: vi.fn(),
      ready: true,
      status: "local",
      user: undefined,
      localCacheMode: "local",
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
      readingProgressSyncPlan: undefined,
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
    window.history.replaceState(null, "", "#library/all");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(Workspace)));
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await Promise.resolve();
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
  });

  /** The single all-library question entry that replaced "跨库问 AI". */
  function askEntry() {
    return [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.replace(/\s+/gu, "").trim() === "问AI",
    );
  }

  async function openPrefilledPanel() {
    const questionMode = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("用问题找资料"),
    );
    expect(questionMode).toBeTruthy();
    await act(async () => questionMode!.click());

    const query = host.querySelector<HTMLInputElement>('[aria-label="输入问题找资料"]');
    expect(query).toBeTruthy();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        query,
        "如何选择学习率？",
      );
      query!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const searchHandoff = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("模拟选择问题资料"),
    );
    expect(searchHandoff, host.textContent ?? "").toBeTruthy();

    await act(async () => searchHandoff!.click());
    expect(panelLifecycle).toMatchObject({ mounts: 1, unmounts: 0 });
  }

  it("keeps the prefilled panel mounted when the first answer creates its conversation route", async () => {
    await openPrefilledPanel();

    const send = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("模拟发送预填问题"),
    );
    expect(send).toBeTruthy();
    await act(async () => send!.click());

    expect(window.location.hash).toContain("conversation=new-cross-library-thread");
    expect(panelLifecycle).toMatchObject({ mounts: 1, unmounts: 0 });
  });

  it("starts a fresh panel when the merged ask entry clears a search draft", async () => {
    await openPrefilledPanel();

    const blankQuestion = askEntry();
    expect(blankQuestion).toBeTruthy();
    await act(async () => blankQuestion!.click());

    expect(panelLifecycle).toMatchObject({ mounts: 2, unmounts: 1 });
  });

  it("does not let external entry points replace an in-flight answer panel", async () => {
    await openPrefilledPanel();
    const send = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("模拟发送预填问题"),
    );
    expect(send).toBeTruthy();
    await act(async () => send!.click());

    const blankQuestion = askEntry();
    const searchHandoff = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("模拟选择问题资料"),
    );
    expect(blankQuestion?.disabled).toBe(true);
    expect(searchHandoff?.disabled).toBe(true);

    await act(async () => {
      blankQuestion!.click();
      searchHandoff!.click();
    });
    expect(panelLifecycle).toMatchObject({ mounts: 1, unmounts: 0 });
    expect(panelLifecycle.controller?.signal.aborted).toBe(false);
  });

  it("offers exactly one all-library ask entry", async () => {
    // The former "跨库问 AI" button and the question-mode switch were two ways
    // into the same panel; only the merged entry opens it now.
    const entries = [...host.querySelectorAll<HTMLButtonElement>("button")].filter(
      (button) => button.textContent?.replace(/\s+/gu, "").trim() === "问AI",
    );
    expect(entries).toHaveLength(1);
    expect(
      [...host.querySelectorAll<HTMLButtonElement>("button")].some((button) =>
        button.textContent?.replace(/\s+/gu, "").trim().includes("跨库问AI"),
      ),
    ).toBe(false);

    await act(async () => entries[0]!.click());
    expect(panelLifecycle).toMatchObject({ mounts: 1, unmounts: 0 });
  });
});
