// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import type { WorkspaceData } from "@/lib/types";
import type { ReaderProps } from "./reader";

let workspaceStore: Record<string, unknown>;

vi.mock("next/dynamic", () => ({
  default: (() => {
    let dynamicComponentIndex = 0;
    return () => {
      dynamicComponentIndex += 1;
      // Reader is the sixth panel in workspace/lazy-panels.tsx.
      if (dynamicComponentIndex !== 6) return () => null;
      return function ReaderProbe(props: Pick<ReaderProps, "source" | "space" | "onSaveNote">) {
        return createElement(
          "section",
          {
            "aria-label": "阅读器空间探针",
            "data-source-id": props.source.id,
            "data-space-id": props.space.id,
          },
          createElement(
            "button",
            {
              type: "button",
              onClick: () => {
                const chunk = props.source.chunks[0]!;
                props.onSaveNote(
                  chunk.text,
                  [
                    {
                      sourceId: props.source.id,
                      versionId: props.source.versionId,
                      chunkId: chunk.id,
                      title: props.source.title,
                      quote: chunk.text,
                      section: chunk.section,
                    },
                  ],
                  "note",
                  false,
                );
              },
            },
            "从当前原文创建笔记",
          ),
        );
      };
    };
  })(),
}));
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

describe("Workspace source navigation keeps the document's actual learning space", () => {
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
    const template = data.spaces[0]!;
    data.spaces = [
      { ...template, id: "space-a", name: "知识库 A" },
      { ...template, id: "space-archived", name: "已归档知识库", archived: true },
      { ...template, id: "space-b", name: "知识库 B" },
    ];
    data.sources[0]!.title = "B 库置顶资料";
    data.sources[0]!.spaceIds = ["space-b"];
    data.sources[0]!.starred = true;
    data.sources[1]!.spaceIds = ["space-a"];
    data.sources[1]!.starred = false;
    workspaceStore = {
      token: 1,
      data,
      ready: true,
      status: "local",
      localCacheMode: "normal",
      user: undefined,
      error: "",
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
      organizationStatus: undefined,
      organize: vi.fn(),
      purging: false,
      refreshOrganizationStatus: vi.fn(),
      sourceBlob: vi.fn(async () => undefined),
    };
    window.history.replaceState(null, "", "#library/space-a");
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

  async function openPinnedSource() {
    const button = host.querySelector<HTMLButtonElement>(
      '[aria-label="打开置顶资料 B 库置顶资料"]',
    );
    expect(button).toBeInstanceOf(HTMLButtonElement);
    await act(async () => button!.click());
    const reader = host.querySelector<HTMLElement>('[aria-label="阅读器空间探针"]');
    expect(reader).toBeInstanceOf(HTMLElement);
    expect(reader!.dataset.sourceId).toBe(data.sources[0]!.id);
    expect(window.location.hash).toBe(`#source/${data.sources[0]!.id}`);
    return reader!;
  }

  async function openHash(hash: string) {
    await act(async () => {
      window.history.replaceState(null, "", hash);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  }

  it("uses B when a learner opens B's pinned source while browsing A", async () => {
    expect(host.querySelector('[aria-label="知识库 A 的空间导航"]')).toBeTruthy();
    const reader = await openPinnedSource();
    expect(reader.dataset.spaceId).toBe("space-b");
  });

  it("saves a source note in B with the actual B source citation after leaving A", async () => {
    const reader = await openPinnedSource();
    const source = data.sources[0]!;
    await act(async () => reader.querySelector<HTMLButtonElement>("button")!.click());

    expect(data.notes).toHaveLength(1);
    expect(data.notes[0]).toMatchObject({
      spaceId: "space-b",
      kind: "note",
      citations: [
        {
          sourceId: source.id,
          versionId: source.versionId,
          chunkId: source.chunks[0]!.id,
        },
      ],
    });
    expect(window.location.hash).toBe(`#note/${data.notes[0]!.id}`);
  });

  it("returns from a newly saved B source note to a list containing that note", async () => {
    const reader = await openPinnedSource();
    await act(async () => reader.querySelector<HTMLButtonElement>("button")!.click());
    const savedNote = data.notes[0]!;
    expect(savedNote.spaceId).toBe("space-b");

    // This is NotePage's actual toolbar, not a mocked editor callback.
    const back = [
      ...host.querySelectorAll<HTMLButtonElement>(".note-page .content-toolbar button"),
    ].find((button) => button.textContent?.trim() === "返回");
    expect(back).toBeInstanceOf(HTMLButtonElement);
    await act(async () => back!.click());

    expect(host.querySelector(".note-page")).toBeNull();
    expect(window.location.hash).toBe("#notes?space=space-b");
    const savedCard = [...host.querySelectorAll<HTMLButtonElement>(".note-card")].find(
      (card) => card.querySelector("h3")?.textContent === savedNote.title,
    );
    expect(savedCard).toBeInstanceOf(HTMLButtonElement);
    await act(async () => savedCard!.click());
    expect(window.location.hash).toBe(`#note/${savedNote.id}`);
  });

  it("picks an available associated space from a global source view", async () => {
    data.sources[0]!.spaceIds = ["missing-space", "space-archived", "space-b"];
    await openHash("#library/all");
    const reader = await openPinnedSource();
    expect(reader.dataset.spaceId).toBe("space-b");
  });

  it("preserves the chosen space when the source truly belongs to both A and B", async () => {
    data.sources[0]!.spaceIds = ["space-b", "space-a"];
    const reader = await openPinnedSource();
    expect(reader.dataset.spaceId).toBe("space-a");
  });

  it("uses the inbox for an unassigned pinned source opened from A", async () => {
    data.sources[0]!.spaceIds = [];
    const reader = await openPinnedSource();
    expect(reader.dataset.spaceId).toBe("inbox");
  });
});
