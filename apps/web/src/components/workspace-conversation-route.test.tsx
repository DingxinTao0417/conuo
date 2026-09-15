// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";

let workspaceStore: Record<string, unknown>;

vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/use-workspace", () => ({
  useWorkspace: () => workspaceStore,
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signOut: vi.fn() } }),
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

describe("Workspace conversation-route cleanup", () => {
  let host: HTMLDivElement;
  let root: Root;
  let showModal: ReturnType<typeof vi.fn>;
  let closeModal: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    showModal = vi.fn();
    closeModal = vi.fn();
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: showModal,
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: closeModal,
    });

    const data = createDemoWorkspace();
    const source = data.sources[0]!;
    const conversation = {
      id: "history-only-thread",
      spaceId: data.spaces[0]!.id,
      sourceId: source.id,
      title: "资料已删除的历史问答",
      scope: "document" as const,
      sourceIds: [source.id],
      messages: [],
      resolved: false,
      updatedAt: "2026-09-13T12:00:00.000Z",
    };
    data.sources[0] = { ...source, deletedAt: "2026-09-13T12:00:00.000Z" };
    data.conversations = [conversation];
    workspaceStore = {
      token: 1,
      data,
      update: vi.fn(),
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
    window.history.replaceState(null, "", "#conversation/history-only-thread");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(Workspace)));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
  });

  it("clears a history-only modal when hash navigation leaves its conversation", async () => {
    expect(showModal).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("原资料当前不可用");

    await act(async () => {
      window.history.replaceState(null, "", "#questions");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    expect(host.querySelector("dialog")).toBeNull();
    const push = vi.spyOn(window.history, "pushState");
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "k" }),
      );
    });
    expect(push).toHaveBeenCalledWith(null, "", expect.stringContaining("#library/"));
  });

  it("labels a saved cross-library thread by its fixed source range instead of as a deleted source", async () => {
    const data = workspaceStore.data as ReturnType<typeof createDemoWorkspace>;
    data.conversations = [
      {
        id: "cross-library-thread",
        spaceId: "all",
        title: "两份资料的共同点",
        scope: "cross-library-sources",
        sourceIds: [data.sources[1]!.id],
        messages: [],
        resolved: false,
        updatedAt: "2026-09-13T12:00:00.000Z",
      },
    ];
    workspaceStore = { ...workspaceStore, data };
    await act(async () => {
      root.render(createElement(Workspace));
      window.history.replaceState(null, "", "#library/all");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      window.history.replaceState(null, "", "#questions");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain("跨库 · 1 份固定资料");
    expect(host.textContent).not.toContain("原资料已删除，可查看记录");
  });
});
