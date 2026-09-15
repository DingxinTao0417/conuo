// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";

let workspaceStore: Record<string, unknown>;

vi.mock("next/dynamic", () => ({
  default: (() => {
    let dynamicComponentIndex = 0;
    return () => {
      dynamicComponentIndex += 1;
      // Workspace declares ConceptRelations, KnowledgeUpdate, then Organization.
      if (dynamicComponentIndex === 3) {
        return function OrganizationPanelProbe(props: {
          initialSourceIds?: string[];
          spaceId: string;
        }) {
          return createElement("output", {
            "aria-label": "整理页接收参数",
            "data-source-ids": JSON.stringify(props.initialSourceIds || []),
            "data-space-id": props.spaceId,
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

describe("Workspace inbox bulk association handoff", () => {
  let host: HTMLDivElement;
  let root: Root;
  let data: ReturnType<typeof createDemoWorkspace>;

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
    data.spaces.push({
      id: "review-space",
      name: "算法复习",
      goal: "审核新资料的标签建议",
      color: "#377cf6",
      archived: false,
      createdAt: "2026-09-14T00:00:00.000Z",
    });
    data.sources[0]!.title = "成功关联的资料";
    data.sources[1]!.title = "提交前已关联的资料";
    data.sources.forEach((source) => {
      source.spaceIds = [];
    });

    const update = vi.fn((updater: (current: typeof data) => typeof data) => {
      data = updater(data);
      workspaceStore = { ...workspaceStore, data };
    });
    workspaceStore = {
      token: 1,
      data,
      update,
      getCurrentWorkspaceData: () => data,
      updateDurably: vi.fn(async (updater: (current: typeof data) => typeof data) => {
        const previous = data;
        update(updater);
        // Model the coordinator's store publication before the disk ACK.
        root.render(createElement(Workspace));
        return data !== previous;
      }),
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

    window.history.replaceState(null, "", "#library/inbox");
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

  function button(label: string) {
    const normalized = label.replace(/\s+/g, "");
    const match = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.replace(/\s+/g, "") === normalized,
    );
    expect(match, `button ${label}`).toBeInstanceOf(HTMLButtonElement);
    return match as HTMLButtonElement;
  }

  it("passes only newly associated inbox sources and the review space into organization", async () => {
    const succeeded = data.sources[0]!;
    const skipped = data.sources[1]!;

    await act(async () => {
      host.querySelector<HTMLInputElement>(`input[aria-label="选择 ${succeeded.title}"]`)!.click();
    });
    await act(async () => {
      host.querySelector<HTMLInputElement>(`input[aria-label="选择 ${skipped.title}"]`)!.click();
    });
    expect(host.textContent).toContain("已选 2 份");

    await act(async () => button("关联空间").click());
    const reviewSpaceOption = [...host.querySelectorAll<HTMLLabelElement>(".bulk-space-list label")]
      .find((label) => label.textContent?.includes("算法复习"))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(reviewSpaceOption).toBeInstanceOf(HTMLInputElement);
    await act(async () => reviewSpaceOption!.click());

    // Model a stale inbox selection: another tab associated this source after
    // the modal opened, so the mutation must report and exclude it.
    skipped.spaceIds = ["review-space"];
    await act(async () => button("关联到所选空间（1）").click());

    expect(host.querySelector('[aria-label="关联结果"]')?.textContent).toContain("已关联 1 份资料");
    expect(host.querySelector('[aria-label="关联结果"]')?.textContent).toContain(skipped.title);
    expect(host.querySelector('[aria-label="选择继续审核的学习空间"]')).toHaveProperty(
      "value",
      "review-space",
    );

    await act(async () => button("审核标签建议").click());

    expect(window.location.hash).toBe("#organize?space=review-space");
    const probe = host.querySelector<HTMLOutputElement>('[aria-label="整理页接收参数"]');
    expect(probe).toBeInstanceOf(HTMLOutputElement);
    expect(probe?.dataset.spaceId).toBe("review-space");
    expect(JSON.parse(probe?.dataset.sourceIds || "[]")).toEqual([succeeded.id]);
    expect(probe?.dataset.sourceIds).not.toContain(skipped.id);
  });
});
