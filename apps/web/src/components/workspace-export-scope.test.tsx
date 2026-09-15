// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import type { Source, WorkspaceData } from "@/lib/types";
import type { ExportProgress } from "@/lib/export";

let workspaceStore: Record<string, unknown>;
const exportIO = vi.hoisted(() => ({ exportWorkspace: vi.fn(), download: vi.fn() }));

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/use-workspace", () => ({ useWorkspace: () => workspaceStore }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { signOut: vi.fn() } }) }));
vi.mock("@/lib/cloud", () => ({
  isCloudConfigured: () => true,
  previewAccountDeletion: vi.fn(),
  requestAccountDeletion: vi.fn(),
}));
vi.mock("@/lib/export", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/export")>()),
  exportWorkspace: exportIO.exportWorkspace,
}));
vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./workspace-search", () => ({ default: () => null }));
vi.mock("./indexing-panel", () => ({ default: () => null }));
vi.mock("./web-import-form", () => ({ default: () => null }));

import Workspace from "./workspace";

type ExportOptions = {
  scope: { kind: string; spaceId?: string };
  assertCanContinue: () => void;
  onProgress?: (progress: ExportProgress) => void;
};

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("Workspace reviewed knowledge-base backup exports", () => {
  let host: HTMLDivElement;
  let root: Root;
  let data: WorkspaceData;
  let dialogDescriptors: { show?: PropertyDescriptor; close?: PropertyDescriptor };
  const result = { bytes: new Uint8Array(), issues: [] };

  beforeEach(async () => {
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
      value: vi.fn(),
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: vi.fn(),
    });
    data = fixture();
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
    exportIO.exportWorkspace.mockReset().mockResolvedValue(result);
    exportIO.download.mockReset();
    window.history.replaceState(null, "", "#settings");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await render();
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

  function fixture() {
    const workspace = createDemoWorkspace();
    const now = "2026-09-14T00:00:00.000Z";
    workspace.spaces = [
      { ...workspace.spaces[0]!, id: "space-a", name: "算法学习", archived: false },
      { ...workspace.spaces[0]!, id: "space-b", name: "其他已归档知识库", archived: true },
    ];
    const base = workspace.sources[0]!;
    const source = (
      id: string,
      text: string,
      spaceId = "space-a",
      deletedAt: string | null = null,
    ): Source => ({
      ...base,
      id,
      versionId: `${id}-version`,
      title: id,
      filename: `${id}.md`,
      text,
      spaceIds: [spaceId],
      deletedAt,
      chunks: [
        {
          id: `${id}-chunk`,
          sourceId: id,
          versionId: `${id}-version`,
          text,
          section: "正文",
          order: 0,
        },
      ],
    });
    workspace.sources = [
      source("selected-source", "SELECTED_SOURCE_BODY"),
      source("recycled-source", "RECYCLED_SOURCE_BODY", "space-a", now),
      source("external-reference", "EXTERNAL_REFERENCE_BODY", "space-b"),
      source("unrelated-source", "OTHER_SOURCE_PRIVATE_BODY", "space-b"),
    ];
    const cite = (id: string) => {
      const item = workspace.sources.find((candidate) => candidate.id === id)!;
      return {
        sourceId: id,
        versionId: item.versionId,
        chunkId: item.chunks[0]!.id,
        title: item.title,
        quote: item.text,
        section: "正文",
      };
    };
    workspace.notes = [
      {
        id: "selected-note",
        spaceId: "space-a",
        title: "算法笔记",
        content: "<p>SELECTED_NOTE_BODY</p>",
        kind: "note",
        status: "accepted",
        citations: [cite("selected-source")],
        versions: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: "selected-knowledge",
        spaceId: "space-a",
        title: "算法知识页",
        content: "<p>SELECTED_KNOWLEDGE_BODY</p>",
        kind: "knowledge",
        status: "accepted",
        citations: [cite("external-reference")],
        versions: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: "unrelated-note",
        spaceId: "space-b",
        title: "其他库笔记",
        content: "<p>OTHER_NOTE_PRIVATE_BODY</p>",
        kind: "note",
        status: "accepted",
        citations: [],
        versions: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ];
    workspace.annotations = [
      {
        id: "selected-annotation",
        sourceId: "selected-source",
        versionId: "selected-source-version",
        quote: "SELECTED_SOURCE_BODY",
        textAnchor: { start: 0, end: 20 },
        note: "算法批注",
        createdAt: now,
      },
    ];
    workspace.conversations = [
      {
        id: "selected-question",
        spaceId: "space-a",
        title: "算法问答",
        scope: "space",
        sourceIds: ["selected-source"],
        messages: [],
        resolved: false,
        updatedAt: now,
      },
      {
        id: "other-question",
        spaceId: "space-b",
        title: "OTHER_QUESTION_PRIVATE_BODY",
        scope: "space",
        sourceIds: ["unrelated-source"],
        messages: [],
        resolved: false,
        updatedAt: now,
      },
    ];
    return workspace;
  }

  async function render(patch: Record<string, unknown> = {}, hash?: string) {
    workspaceStore = { ...workspaceStore, ...patch };
    if (hash) window.history.replaceState(null, "", hash);
    await act(async () => {
      root.render(createElement(Workspace));
      if (hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
      await Promise.resolve();
    });
  }

  function button(label: string, within: ParentNode = host) {
    const match = [...within.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.replace(/\s/gu, "") === label.replace(/\s/gu, ""),
    );
    expect(match, `button ${label}`).toBeTruthy();
    return match!;
  }

  async function click(label: string, within: ParentNode = host) {
    await act(async () => button(label, within).click());
  }

  function dialog() {
    const modal = [...host.querySelectorAll<HTMLDialogElement>('dialog, [role="dialog"]')].find(
      (candidate) => candidate.querySelector("h2")?.textContent === "导出备份",
    );
    expect(modal, "export confirmation dialog").toBeTruthy();
    return modal!;
  }

  function scopeSelect() {
    const select = dialog().querySelector<HTMLSelectElement>('[aria-label="导出范围"]');
    expect(select).toBeTruthy();
    return select!;
  }

  async function selectSpace(id = "space-a") {
    await act(async () => {
      scopeSelect().value = `space:${id}`;
      scopeSelect().dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  function expectSelectedScope() {
    expect(scopeSelect().value).toBe("space:space-a");
    const preview = dialog().querySelector('[aria-label="导出范围预览"]');
    expect(preview).toBeTruthy();
    const counts = Object.fromEntries(
      [...preview!.querySelectorAll("dl > div")].map((row) => [
        row.querySelector("dt")!.textContent,
        Number(row.querySelector("dd")!.textContent),
      ]),
    );
    expect(counts).toEqual({ 资料: 3, 资料版本: 3, 笔记: 1, 知识页: 1, 对话: 1, 批注: 1 });
    expect(dialog().textContent).toMatch(/引用.*库外|库外.*引用/);
    expect(preview!.textContent).toMatch(/历史|保留.*版本/);
    expect(preview!.textContent).toContain("回收站");
    expect(preview!.textContent).not.toContain("OTHER_SOURCE_PRIVATE_BODY");
    expect(preview!.textContent).not.toContain("OTHER_NOTE_PRIVATE_BODY");
  }

  it("opens a full-workspace preview without exporting, then confirms only the selected knowledge-base scope", async () => {
    await click("导出备份");
    expect(exportIO.exportWorkspace).not.toHaveBeenCalled();
    expect(scopeSelect().value).toBe("workspace");
    expect(
      [...scopeSelect().options].some((option) => option.textContent?.includes("其他已归档知识库")),
    ).toBe(true);
    await selectSpace();
    expectSelectedScope();
    await click("下载 ZIP", dialog());
    expect(exportIO.exportWorkspace).toHaveBeenCalledOnce();
    const [reviewed, resolver, options] = exportIO.exportWorkspace.mock.calls[0]!;
    expect(reviewed).toEqual(data);
    expect(reviewed).not.toBe(data);
    expect(resolver).toEqual(expect.any(Function));
    expect(options.scope).toEqual({ kind: "space", spaceId: "space-a" });
    expect(options.assertCanContinue).toEqual(expect.any(Function));
    expect(workspaceStore.update).not.toHaveBeenCalled();
  });

  it("preselects the active knowledge base from both its materials and knowledge-page headers", async () => {
    for (const hash of ["#library/space-a", "#knowledge?space=space-a"]) {
      await render({}, hash);
      await click("导出此知识库");
      expectSelectedScope();
      expect(exportIO.exportWorkspace).not.toHaveBeenCalled();
      await click("取消", dialog());
    }
  });

  it("requires a fresh review after snapshot changes or removal of the selected knowledge base", async () => {
    for (const deletedSpace of [false, true]) {
      await click("导出备份");
      await selectSpace();
      const changed = structuredClone(data);
      if (deletedSpace) changed.spaces = changed.spaces.filter((space) => space.id !== "space-a");
      else changed.notes[0]!.content = "<p>确认前新增的笔记文字。</p>";
      await render({ data: changed });
      const confirm = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.replace(/\s/gu, "") === "下载ZIP",
      );
      if (confirm) await act(async () => confirm.click());
      expect(exportIO.exportWorkspace).not.toHaveBeenCalled();
      expect(host.textContent).toMatch(/变化|不存在|删除|重新.*预览|重新.*确认/);
      const cancel = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === "取消",
      );
      if (cancel) await act(async () => cancel.click());
      await render({ data });
    }
  });

  it("prevents same-event duplicate exports and retains the reviewed scope after an IO error", async () => {
    const gate = deferred();
    exportIO.exportWorkspace.mockImplementation(async () => {
      await gate.promise;
      return result;
    });
    await click("导出备份");
    await selectSpace();
    const confirm = button("下载 ZIP", dialog());
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    expect(exportIO.exportWorkspace).toHaveBeenCalledOnce();
    await act(async () => {
      gate.reject(new Error("原文件读取失败，已有资料未改变。"));
      await Promise.resolve();
    });
    expect(scopeSelect().value).toBe("space:space-a");
    expect(host.textContent).toContain("原文件读取失败");
    expect(workspaceStore.update).not.toHaveBeenCalled();
    exportIO.exportWorkspace.mockResolvedValue(result);
    await click("下载 ZIP", dialog());
    expect(exportIO.exportWorkspace).toHaveBeenCalledTimes(2);
  });

  it("allows the reviewed snapshot during unrelated edits but aborts a delayed download after an account change", async () => {
    const gate = deferred();
    let running: ExportOptions | undefined;
    exportIO.exportWorkspace.mockImplementation(
      async (_reviewed: WorkspaceData, _resolver: unknown, options: ExportOptions) => {
        running = options;
        await gate.promise;
        options.assertCanContinue();
        exportIO.download();
        return result;
      },
    );
    await click("导出备份");
    await selectSpace();
    await click("下载 ZIP", dialog());
    expect(exportIO.exportWorkspace).toHaveBeenCalledOnce();
    const edited = structuredClone(data);
    edited.notes[2]!.content = "<p>导出期间修改其他知识库。</p>";
    await render({ data: edited });
    expect(() => running!.assertCanContinue()).not.toThrow();
    await render({ token: 8, user: { id: "account-b", email: "other@example.test" } });
    expect(() => running!.assertCanContinue()).toThrow();
    await act(async () => {
      try {
        running!.onProgress?.({
          phase: "originals",
          completed: 0,
          total: 1,
          sourceId: "selected-source",
          versionId: "selected-source-version",
          title: "旧账号读取标题",
          versionState: "current",
          status: "reading",
        });
      } catch (cause) {
        // Throwing to abort the old pipeline and silently ignoring a stale callback
        // both preserve the new account's UI; neither may publish the old progress.
        expect(cause).toBeInstanceOf(Error);
      }
    });
    expect(host.textContent).not.toContain("旧账号读取标题");
    await act(async () => {
      gate.resolve();
      await Promise.resolve();
    });
    expect(exportIO.download).not.toHaveBeenCalled();
    expect(exportIO.exportWorkspace).toHaveBeenCalledOnce();
    expect(workspaceStore.update).not.toHaveBeenCalled();
  });
});
