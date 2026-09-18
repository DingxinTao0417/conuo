// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCrossLibraryAnswerRequest } from "@/lib/cross-library-ask";
import { parseLibraryRoute } from "@/lib/library-route";
import { createDemoWorkspace } from "@/lib/seed";
import type { AnswerScopeSnapshot } from "@/lib/types";

let workspaceStore: Record<string, unknown>;

vi.mock("next/dynamic", () => ({
  default: (() => {
    let index = 0;
    return () => {
      index += 1;
      if (index === 12) {
        return function CrossLibraryProbe(props: { initialConversationId?: string }) {
          return createElement("section", {
            "aria-label": "跨库问答探针",
            "data-conversation-id": props.initialConversationId,
          });
        };
      }
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
vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./workspace-search", () => ({ default: () => null }));
vi.mock("./indexing-panel", () => ({ default: () => null }));
vi.mock("./web-import-form", () => ({ default: () => null }));

import Workspace from "./workspace";

describe("Cross-library conversation library route state", () => {
  let host: HTMLDivElement;
  let root: Root;
  let scopedRoute: string;
  const canonicalRoute = "#library/all?ask=1&conversation=cross-library-thread";

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

    const data = createDemoWorkspace();
    const now = "2026-09-17T12:00:00.000Z";
    data.spaces.push({ ...data.spaces[0]!, id: "space-b", name: "第二知识库" });
    data.sources[0]!.title = "A 空间资料";
    data.sources[0]!.tags = ["仅此空间"];
    data.sources[0]!.updatedAt = "2026-09-15T12:00:00.000Z";
    data.sources[1]!.title = "Z 跨库网页资料";
    data.sources[1]!.spaceIds = ["space-b"];
    data.sources[1]!.tags = ["其他标签"];
    data.sources[1]!.createdAt = "2025-01-01T12:00:00.000Z";
    data.sources[1]!.updatedAt = now;
    const request = createCrossLibraryAnswerRequest(data, {
      question: "两份资料有什么共同点？",
      sourceIds: data.sources.map((source) => source.id),
    });
    const scopeSnapshot: AnswerScopeSnapshot = {
      scope: request.scope,
      spaceId: request.spaceId,
      sourceIds: [...request.sourceIds],
      sourceVersions: request.sourceVersions?.map((reference) => ({ ...reference })),
    };
    data.conversations = [
      {
        id: "cross-library-thread",
        spaceId: "all",
        title: "已保存的跨库问题",
        scope: "cross-library-sources",
        sourceIds: [...request.sourceIds],
        messages: [
          {
            id: "question",
            role: "user",
            content: request.question,
            citations: [],
            createdAt: now,
          },
          {
            id: "answer",
            role: "assistant",
            content: "固定资料范围的回答。",
            citations: [],
            createdAt: now,
            attempt: {
              id: "attempt",
              questionMessageId: "question",
              scopeSnapshot,
              status: "completed",
            },
          },
        ],
        resolved: false,
        updatedAt: now,
      },
    ];
    workspaceStore = {
      token: 1,
      data,
      update: vi.fn(),
      updateDurably: vi.fn(),
      ready: true,
      status: "cloud",
      error: "",
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
      resolveReadingProgressConflicts: vi.fn(),
      restoreBackup: vi.fn(),
      retry: vi.fn(),
      retryImport: vi.fn(),
      retryOrganization: vi.fn(),
      sourceBlob: vi.fn(async () => undefined),
      stopOrganization: vi.fn(),
      useRemote: vi.fn(),
    };
    scopedRoute = `#library/${data.spaces[0]!.id}?q=旧检索&filter=markdown&time=7d&sort=name&layout=grid&tag=仅此空间`;
    window.history.replaceState(null, "", scopedRoute);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(Workspace)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function openHash(hash: string, push = false) {
    await act(async () => {
      window.history[push ? "pushState" : "replaceState"](null, "", hash);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }

  async function click(selector: string) {
    const target = host.querySelector<HTMLButtonElement>(selector);
    expect(target, selector).toBeInstanceOf(HTMLButtonElement);
    await act(async () => target!.click());
  }

  async function libraryView() {
    const query = host.querySelector<HTMLInputElement>('input[aria-label="搜索资料"]')?.value;
    const rowTitles = [...host.querySelectorAll(".source-row .source-open b")].map(
      (heading) => heading.textContent,
    );
    await click('button[aria-label^="筛选资料"]');
    const filter = host.querySelector<HTMLSelectElement>('[aria-label="筛选资料类型"]')?.value;
    const time = host.querySelector<HTMLSelectElement>('[aria-label="按添加时间筛选资料"]')?.value;
    const tags = [
      ...host.querySelectorAll<HTMLInputElement>(".tag-filter-options input:checked"),
    ].map((input) => input.getAttribute("aria-label"));
    await click('button[aria-label^="筛选资料"]');
    await click('button[aria-label="资料视图设置"]');
    const sort = host.querySelector<HTMLSelectElement>('[aria-label="资料排序方式"]')?.value;
    const layout =
      host.querySelector('[aria-label="列表视图"]')?.getAttribute("aria-pressed") === "true"
        ? "list"
        : "grid";
    await click('button[aria-label="资料视图设置"]');
    return { query, rowTitles, filter, time, tags, sort, layout };
  }

  async function expectDefaultAllLibrary() {
    expect(
      host.querySelector('[aria-label="跨库问答探针"]')?.getAttribute("data-conversation-id"),
    ).toBe("cross-library-thread");
    expect(host.querySelector('[aria-label$="的空间导航"]')).toBeNull();
    expect(await libraryView()).toEqual({
      query: "",
      rowTitles: ["Z 跨库网页资料", "A 空间资料"],
      filter: "all",
      time: "all",
      tags: [],
      sort: "updated",
      layout: "list",
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

  it("opens a saved cross-library question with the same complete default state written to its URL", async () => {
    expect(await libraryView()).toMatchObject({
      query: "旧检索",
      filter: "markdown",
      time: "7d",
      sort: "name",
      layout: "grid",
      tags: ["标签 仅此空间"],
    });
    // Enter the global question route without resetting the hidden library
    // controls: opening the conversation itself must adopt its whole route.
    await openHash("#questions");
    await click(".question-history-continue");
    expect(window.location.hash).toBe(canonicalRoute);
    expect(parseLibraryRoute(window.location.hash)).toEqual({
      spaceId: "all",
      files: true,
      query: "",
      filter: "all",
      time: "all",
      sort: "updated",
      layout: "list",
      crossLibraryAsk: { conversationId: "cross-library-thread" },
    });
    await expectDefaultAllLibrary();
  });

  it("also resets stale library controls when resolving a direct cross-library conversation link", async () => {
    await openHash("#conversation/cross-library-thread");
    expect(window.location.hash).toBe("#conversation/cross-library-thread");
    await expectDefaultAllLibrary();
  });

  it("restores the same cross-library list after browser traversal and remounting its canonical link", async () => {
    await openHash("#questions", true);
    await click(".question-history-continue");
    expect(window.location.hash).toBe(canonicalRoute);
    const openedView = await libraryView();
    await openHash(scopedRoute, true);
    expect(await libraryView()).toMatchObject({
      query: "旧检索",
      filter: "markdown",
      time: "7d",
      sort: "name",
      layout: "grid",
      tags: ["标签 仅此空间"],
    });
    await moveHistory("back");
    expect(window.location.hash).toBe(canonicalRoute);
    await expectDefaultAllLibrary();
    expect(await libraryView()).toEqual(openedView);
    await moveHistory("forward");
    expect(parseLibraryRoute(window.location.hash)?.spaceId).not.toBe("all");
    await moveHistory("back");
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(Workspace)));
    expect(window.location.hash).toBe(canonicalRoute);
    await expectDefaultAllLibrary();
    expect(await libraryView()).toEqual(openedView);
  });
});
