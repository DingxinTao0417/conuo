// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatComparisonRoute } from "@/lib/comparison-route";
import { createDemoWorkspace } from "@/lib/seed";
import type { WorkspaceData } from "@/lib/types";
import type { ComparisonReaderProps } from "./comparison-reader";
import type { ReaderProps } from "./reader";

let workspaceStore: Record<string, unknown>;
const captured = vi.hoisted(() => ({
  reader: null as ReaderProps | null,
  comparison: null as ComparisonReaderProps | null,
}));

vi.mock("next/dynamic", () => ({
  default: () =>
    function DynamicPanel(props: Record<string, unknown>) {
      if ("leftSource" in props) {
        captured.comparison = props as unknown as ComparisonReaderProps;
        return createElement("output", { "data-cloud-integration-comparison": true });
      }
      if ("source" in props && "onSourceChange" in props) {
        captured.reader = props as unknown as ReaderProps;
        return createElement("output", { "data-cloud-integration-reader": true });
      }
      return null;
    },
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
vi.mock("./collection-library", () => ({
  default: () => null,
  CollectionActions: () => null,
}));
vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./workspace-search", () => ({ default: () => null }));
vi.mock("./indexing-panel", () => ({ default: () => null }));
vi.mock("./web-import-form", () => ({ default: () => null }));

import Workspace from "./workspace";

describe("Workspace foreground cloud update integration", () => {
  let host: HTMLDivElement;
  let root: Root;
  let data: WorkspaceData;
  let pendingReadingPosition: ReturnType<typeof vi.fn>;

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

    captured.reader = null;
    captured.comparison = null;
    data = createDemoWorkspace();
    pendingReadingPosition = vi.fn();
    workspaceStore = {
      token: 7,
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
      loadLatestLocal: vi.fn(),
      localUpdateRevision: null,
      loadingLocalUpdate: false,
      cloudUpdateRevision: null,
      checkingCloudUpdate: false,
      loadingCloudUpdate: false,
      cloudUpdateError: "",
      cloudAdoptionSequence: 0,
      loadCloudUpdate: vi.fn(async () => {}),
      checkCloudUpdates: vi.fn(async () => {}),
      setPendingReadingPosition: pendingReadingPosition,
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
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
  });

  async function renderWorkspace(overrides: Record<string, unknown> = {}, hash?: string) {
    workspaceStore = { ...workspaceStore, ...overrides };
    if (hash) window.history.replaceState(null, "", hash);
    await act(async () => {
      root.render(createElement(Workspace));
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await Promise.resolve();
    });
  }

  function notice() {
    return host.querySelector<HTMLElement>('[aria-label="云端工作区更新"]');
  }

  it("keeps routine revision checks silent while preserving the acknowledged save status", async () => {
    await renderWorkspace({ checkingCloudUpdate: true });
    expect(notice()).toBeNull();
    expect(host.querySelector('[aria-label="当前工作区保存状态"]')?.textContent).toContain(
      "工作区已保存到云端",
    );
    expect(workspaceStore.loadCloudUpdate).not.toHaveBeenCalled();
    expect(workspaceStore.checkCloudUpdates).not.toHaveBeenCalled();
  });

  it("routes a discovered-version action to the guarded full load", async () => {
    await renderWorkspace({ cloudUpdateRevision: 9 });
    expect(notice()?.textContent).toContain("云端有新的工作区版本");
    await act(async () => notice()!.querySelector<HTMLButtonElement>("button")!.click());
    expect(workspaceStore.loadCloudUpdate).toHaveBeenCalledOnce();
    expect(workspaceStore.checkCloudUpdates).not.toHaveBeenCalled();
    expect(workspaceStore.update).not.toHaveBeenCalled();
  });

  it("rechecks metadata after a probe error without loading or changing the workspace", async () => {
    await renderWorkspace({ cloudUpdateError: "云端版本检查暂时不可用。" });
    expect(notice()?.textContent).toContain("云端版本检查暂时不可用。");
    await act(async () => notice()!.querySelector<HTMLButtonElement>("button")!.click());
    expect(workspaceStore.checkCloudUpdates).toHaveBeenCalledOnce();
    expect(workspaceStore.loadCloudUpdate).not.toHaveBeenCalled();
    expect(workspaceStore.update).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="当前工作区保存状态"]')?.textContent).toContain(
      "工作区已保存到云端",
    );
  });

  it("passes a confirmed adoption into the mounted reader and stages its exact source-version key", async () => {
    const source = data.sources[0]!;
    await renderWorkspace({}, `#source/${source.id}`);
    const mountedReader = host.querySelector("[data-cloud-integration-reader]");
    expect(mountedReader).not.toBeNull();
    expect(captured.reader?.readingPositionRevision).toBe(0);

    const adopted = {
      ...data,
      sources: data.sources.map((item) =>
        item.id === source.id ? { ...item, readOffset: 640 } : item,
      ),
    };
    await renderWorkspace({ data: adopted, cloudAdoptionSequence: 2 });
    expect(host.querySelector("[data-cloud-integration-reader]")).toBe(mountedReader);
    expect(captured.reader?.source).toMatchObject({
      id: source.id,
      versionId: source.versionId,
      readOffset: 640,
    });
    expect(captured.reader?.readingPositionRevision).toBe(2);
    await act(async () => {
      captured.reader!.onPendingReadingChange!(true);
      captured.reader!.onPendingReadingChange!(false);
    });
    expect(pendingReadingPosition.mock.calls).toEqual([
      [`reader:${source.id}:${source.versionId}`, true],
      [`reader:${source.id}:${source.versionId}`, false],
    ]);
    expect(workspaceStore.update).not.toHaveBeenCalled();
  });

  it("passes adoption positions to both comparison panes and keeps side staging keys distinct", async () => {
    const [left, right] = data.sources;
    await renderWorkspace(
      {},
      formatComparisonRoute({
        leftSourceId: left!.id,
        leftVersionId: left!.versionId,
        rightSourceId: right!.id,
        rightVersionId: right!.versionId,
        spaceId: data.spaces[0]!.id,
      }),
    );
    const mountedComparison = host.querySelector("[data-cloud-integration-comparison]");
    expect(mountedComparison).not.toBeNull();
    expect(captured.comparison?.readingPositionRevision).toBe(0);
    await renderWorkspace({ cloudAdoptionSequence: 3 });
    expect(host.querySelector("[data-cloud-integration-comparison]")).toBe(mountedComparison);
    expect(captured.comparison?.readingPositionRevision).toBe(3);

    const paneProps = captured.comparison!;
    await act(async () => {
      paneProps.readingProgress!.onPendingChange!(paneProps.leftSource, true);
      paneProps.readingProgress!.onPendingChange!(paneProps.rightSource, true);
      paneProps.readingProgress!.onPendingChange!(paneProps.leftSource, false);
      paneProps.readingProgress!.onPendingChange!(paneProps.rightSource, false);
    });
    expect(pendingReadingPosition.mock.calls).toEqual([
      [`comparison:left:${left!.id}:${left!.versionId}`, true],
      [`comparison:right:${right!.id}:${right!.versionId}`, true],
      [`comparison:left:${left!.id}:${left!.versionId}`, false],
      [`comparison:right:${right!.id}:${right!.versionId}`, false],
    ]);
    expect(workspaceStore.update).not.toHaveBeenCalled();
  });
});
