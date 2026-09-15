// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import type { Conversation, WorkspaceData } from "@/lib/types";

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
vi.mock("./collection-library", () => ({
  default: () => null,
  CollectionActions: () => null,
}));
vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./workspace-search", () => ({ default: () => null }));
vi.mock("./indexing-panel", () => ({ default: () => null }));
vi.mock("./web-import-form", () => ({ default: () => null }));

import Workspace from "./workspace";

function question(
  data: WorkspaceData,
  id: string,
  resolved: boolean,
  updatedAt: string,
): Conversation {
  const source = data.sources[0]!;
  const space = data.spaces[0]!;
  return {
    id,
    spaceId: space.id,
    sourceId: source.id,
    title: id === "older-pending" ? "还没想明白的学习率问题" : "已经处理的新问题",
    scope: "document",
    sourceIds: [source.id],
    messages: [],
    resolved,
    updatedAt,
  };
}

describe("Workspace learning continuation", () => {
  let host: HTMLDivElement;
  let root: Root;
  let data: WorkspaceData;

  beforeEach(() => {
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
    data.sources[0]!.lastReadAt = "2026-09-14T12:00:00.000Z";
    data.sources[0]!.readOffset = 480;
    data.sources[1]!.lastReadAt = "2026-09-14T11:00:00.000Z";
    workspaceStore = {
      token: 1,
      data,
      update: vi.fn(),
      ready: true,
      status: "local",
      localCacheMode: "normal",
      user: undefined,
      anonymousMigration: { kind: "none", canMigrate: false },
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
    window.history.replaceState(null, "", `#home?space=${data.spaces[0]!.id}`);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
  });

  async function renderWorkspace() {
    await act(async () => root.render(createElement(Workspace)));
  }

  function primaryAction() {
    const action = host.querySelector<HTMLButtonElement>(".learning-continuation-action");
    expect(action).toBeInstanceOf(HTMLButtonElement);
    return action!;
  }

  it("opens the older unresolved thread even when a newer thread is resolved", async () => {
    data.conversations = [
      question(data, "newer-resolved", true, "2026-09-14T14:00:00.000Z"),
      question(data, "older-pending", false, "2026-09-14T13:00:00.000Z"),
    ];
    await renderWorkspace();

    expect(host.textContent).toContain("还没想明白的学习率问题");
    expect(primaryAction().textContent).toContain("继续讨论");
    expect(host.querySelector(".pending-question-list")?.textContent ?? "").not.toContain(
      "还没想明白的学习率问题",
    );
    expect(host.querySelector('[aria-label="其他最近阅读"]')?.textContent).toContain(
      data.sources[1]!.title,
    );
    await act(async () => primaryAction().click());

    expect(window.location.hash).toBe("#conversation/older-pending");
  });

  it("opens the saved source position when there is no unresolved question", async () => {
    data.conversations = [question(data, "newer-resolved", true, "2026-09-14T14:00:00.000Z")];
    await renderWorkspace();

    expect(host.textContent).toContain("上次读到正文");
    expect(primaryAction().textContent).toContain("继续阅读");
    await act(async () => primaryAction().click());

    expect(window.location.hash).toBe(`#source/${data.sources[0]!.id}`);
  });
});
