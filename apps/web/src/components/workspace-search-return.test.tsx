// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import { parseLibraryRoute } from "@/lib/library-route";
import type { WorkspaceData } from "@/lib/types";

let workspaceStore: Record<string, unknown>;
vi.mock("next/dynamic", () => ({
  default: (() => {
    let index = 0;
    return () => {
      index += 1;
      if (index === 6)
        return function ReaderProbe({ onBack }: { onBack: () => void }) {
          return createElement("button", { onClick: onBack }, "返回搜索资料");
        };
      return () => null;
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
vi.mock("./collection-library", () => ({ default: () => null, CollectionActions: () => null }));
vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./indexing-panel", () => ({ default: () => null }));
vi.mock("./web-import-form", () => ({ default: () => null }));

import Workspace from "./workspace";

describe("search result return context", () => {
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
    data.sources[0]!.title = "学习率资料";
    const now = data.sources[0]!.updatedAt;
    data.notes = ["knowledge", "note"].map((kind) => ({
      id: `search-${kind}`,
      spaceId: data.spaces[0]!.id,
      title: `学习率${kind === "knowledge" ? "知识页" : "笔记"}`,
      content: "<p>学习率控制更新步长。</p>",
      kind: kind as "knowledge" | "note",
      status: "accepted",
      citations: [],
      versions: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }));
    workspaceStore = {
      token: 1,
      data,
      ready: true,
      status: "local",
      error: "",
      localCacheMode: "normal",
      user: { id: "account-a", email: "learner@example.test" },
      update: vi.fn(),
      updateDurably: vi.fn(),
      anonymousMigration: { kind: "none", canMigrate: false },
      signOut: vi.fn(),
      signOutState: { kind: "ready", canSync: false, canKeepLocalDraft: false },
      ask: vi.fn(),
      organizationStatus: undefined,
      organize: vi.fn(),
      purging: false,
      refreshOrganizationStatus: vi.fn(),
      sourceBlob: vi.fn(async () => undefined),
    };
    window.history.replaceState(null, "", "#home");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<Workspace storageMode="cloud" />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function click(selector: string) {
    const button = host.querySelector<HTMLButtonElement>(selector);
    expect(button, selector).toBeInstanceOf(HTMLButtonElement);
    await act(async () => button!.click());
  }
  async function openHash(hash: string) {
    await act(async () => {
      window.history.replaceState(null, "", hash);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
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
  async function returnFromNote() {
    const back = [
      ...host.querySelectorAll<HTMLButtonElement>(".note-page .content-toolbar button"),
    ].find((button) => button.textContent?.trim() === "返回")!;
    await act(async () => back.click());
  }
  async function search(kind: "knowledge" | "note" | "markdown") {
    await click(".topbar-search-trigger");
    const input = host.querySelector<HTMLInputElement>('input[aria-label="搜索资料"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "学习率",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click('button[aria-label^="筛选资料"]');
    const type = host.querySelector<HTMLSelectElement>('[aria-label="筛选资料类型"]')!;
    await act(async () => {
      type.value = kind;
      type.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click('button[aria-label^="筛选资料"]');
    await vi.waitFor(() => expect(host.querySelector(".workspace-search-hit")).toBeTruthy());
    return parseLibraryRoute(window.location.hash)!;
  }

  it.each(["knowledge", "note"] as const)(
    "returns a %s search result to its exact query and filter",
    async (kind) => {
      const route = await search(kind);
      await click(".workspace-search-hit");
      expect(window.location.hash).toBe(`#note/search-${kind}`);
      await returnFromNote();
      expect(parseLibraryRoute(window.location.hash)).toEqual(route);
      expect(host.querySelector<HTMLInputElement>('input[aria-label="搜索资料"]')?.value).toBe(
        "学习率",
      );
    },
  );

  it("returns a source search result to the exact library query and filter", async () => {
    data.sources[0]!.kind = "markdown";
    const route = await search("markdown");
    await click(".workspace-search-hit");
    const back = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "返回搜索资料",
    )!;
    await act(async () => back.click());
    expect(parseLibraryRoute(window.location.hash)).toEqual(route);
  });

  it.each(["knowledge", "note"] as const)(
    "keeps scoped %s search after browser back/forward and explicit return",
    async (kind) => {
      await openHash(`#home?space=${data.spaces[0]!.id}`);
      const route = await search(kind);
      expect(route.spaceId).toBe(data.spaces[0]!.id);
      await click(".workspace-search-hit");
      await moveHistory("back");
      expect(parseLibraryRoute(window.location.hash)).toEqual(route);
      await moveHistory("forward");
      expect(window.location.hash).toBe(`#note/search-${kind}`);
      await returnFromNote();
      expect(parseLibraryRoute(window.location.hash)).toEqual(route);
    },
  );

  it("starts global search after global navigation without inheriting the prior search's space", async () => {
    await openHash(`#home?space=${data.spaces[0]!.id}`);
    await search("knowledge");
    await click(".workspace-search-hit");
    await click('[aria-label="主导航"] [aria-label="学习概览"]');
    expect(window.location.hash).toBe("#home");
    const route = await search("note");
    expect(route.spaceId).toBe("all");
    await click(".workspace-search-hit");
    await returnFromNote();
    expect(parseLibraryRoute(window.location.hash)).toEqual(route);
  });
});
