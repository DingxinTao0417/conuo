// @vitest-environment jsdom

import "fake-indexeddb/auto";
import { IDBFactory, IDBObjectStore as FakeIDBObjectStore } from "fake-indexeddb";
import { deleteDB } from "idb";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { knowledgeBlocks, snapshotKnowledgeNote } from "@/lib/knowledge-update";
import type { OrganizationJob } from "@/lib/organization-types";
import { createDemoWorkspace } from "@/lib/seed";
import type { Citation, Note } from "@/lib/types";
import {
  KNOWLEDGE_UPDATE_DRAFT_DATABASE,
  loadKnowledgeUpdateReviewDrafts,
} from "@/lib/knowledge-update-review-drafts";

const noteId = "knowledge-update-note";
const jobId = "knowledge-update-job";
const changeId = "knowledge-update-change";
const defaultSuggestion = "模型给出的原始建议。";

let workspaceStore: Record<string, unknown>;

vi.mock("next/dynamic", () => ({
  default: (() => {
    let dynamicComponentIndex = 0;
    return () => {
      dynamicComponentIndex += 1;

      // Workspace declares ConceptRelations, then KnowledgeUpdate.
      if (dynamicComponentIndex === 2) {
        return function KnowledgeUpdatePanelProbe(props: {
          data: ReturnType<typeof createDemoWorkspace>;
          noteId: string;
          reviewDrafts?: Record<
            string,
            { selectedChangeIds: string[]; editedTexts: Record<string, string> }
          >;
          onReviewDraftChange: (
            activeJobId: string,
            draft: {
              selectedChangeIds: string[];
              editedTexts: Record<string, string>;
            } | null,
          ) => void;
          onOpenCitation: (citation: Citation) => void;
        }) {
          const draft = props.reviewDrafts?.[jobId];
          const job = props.data.organizationJobs?.find((candidate) => candidate.id === jobId);
          const citation =
            job?.result?.kind === "update" ? job.result.changes[0]?.citations[0] : undefined;
          return createElement(
            "section",
            { "aria-label": "更新审核探针", "data-note-id": props.noteId },
            createElement("input", {
              "aria-label": "勾选更新建议",
              type: "checkbox",
              checked: draft?.selectedChangeIds.includes(changeId) ?? false,
              onChange: (event: { currentTarget: HTMLInputElement }) =>
                props.onReviewDraftChange(jobId, {
                  selectedChangeIds: event.currentTarget.checked ? [changeId] : [],
                  editedTexts: draft?.editedTexts ?? {},
                }),
            }),
            createElement("textarea", {
              "aria-label": "改写更新建议",
              value: draft?.editedTexts[changeId] ?? defaultSuggestion,
              onChange: (event: { currentTarget: HTMLTextAreaElement }) =>
                props.onReviewDraftChange(jobId, {
                  selectedChangeIds: draft?.selectedChangeIds ?? [],
                  editedTexts: {
                    ...(draft?.editedTexts ?? {}),
                    [changeId]: event.currentTarget.value,
                  },
                }),
            }),
            createElement(
              "button",
              {
                type: "button",
                "aria-label": "打开更新依据",
                disabled: !citation,
                onClick: () => citation && props.onOpenCitation(citation),
              },
              "打开更新依据",
            ),
          );
        };
      }

      // Reader is the sixth dynamic component declared by Workspace.
      if (dynamicComponentIndex === 6) {
        return function ReaderProbe(props: {
          source: { id: string; versionId: string };
          backLabel?: string;
          onBack: () => void;
        }) {
          return createElement(
            "section",
            {
              "aria-label": "阅读器探针",
              "data-source-id": props.source.id,
              "data-version-id": props.source.versionId,
            },
            createElement(
              "button",
              { type: "button", "aria-label": props.backLabel, onClick: props.onBack },
              props.backLabel,
            ),
          );
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

function setTextareaValue(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Workspace knowledge-update evidence return", () => {
  let host: HTMLDivElement;
  let root: Root;
  let citation: Citation;
  let updateRoute: string;
  let sourceRoute: string;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("indexedDB", new IDBFactory());
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
    const source = data.sources[0]!;
    const chunk = source.chunks[0]!;
    citation = {
      sourceId: source.id,
      versionId: source.versionId,
      chunkId: chunk.id,
      title: source.title,
      quote: chunk.text,
      section: chunk.section,
      page: chunk.page,
    };
    const note: Note = {
      id: noteId,
      spaceId: data.spaces[0]!.id,
      title: "学习率复习",
      content: "<h2>定义</h2><p>学习率决定参数更新步长。</p>",
      kind: "knowledge",
      status: "accepted",
      aiGenerated: false,
      contentRevision: 2,
      citations: [citation],
      versions: [],
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      deletedAt: null,
    };
    const job: OrganizationJob = {
      id: jobId,
      status: "ready",
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      request: {
        requestId: jobId,
        kind: "update",
        trigger: "manual",
        spaceId: note.spaceId,
        sourceIds: [source.id],
        sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
        targetNote: { id: note.id, revision: 2, updatedAt: note.updatedAt },
      },
      result: {
        kind: "update",
        mode: "model",
        target: snapshotKnowledgeNote(note),
        changes: [
          {
            id: changeId,
            type: "replace",
            blockId: knowledgeBlocks(note.content)[1]!.id,
            before: "<p>学习率决定参数更新步长。</p>",
            after: defaultSuggestion,
            reason: "补充更精确的解释。",
            citations: [citation],
          },
        ],
        coverage: "已核对所选资料。",
      },
    };
    data.notes = [note];
    data.organizationJobs = [job];
    workspaceStore = {
      token: 1,
      data,
      update: vi.fn(),
      updateDurably: vi.fn(),
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
      organizationStatus: { ready: true, running: false, message: "模型服务已就绪" },
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

    updateRoute = `#note/${note.id}/update`;
    sourceRoute = `#source/${source.id}/version/${source.versionId}`;
    window.history.replaceState(null, "", updateRoute);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(Workspace)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
    await deleteDB(KNOWLEDGE_UPDATE_DRAFT_DATABASE);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the checked edit while opening exact source evidence and returning to review", async () => {
    const review = host.querySelector<HTMLElement>('[aria-label="更新审核探针"]');
    expect(review).toBeInstanceOf(HTMLElement);
    expect(review?.dataset.noteId).toBe(noteId);

    const checkbox = host.querySelector<HTMLInputElement>('[aria-label="勾选更新建议"]')!;
    const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="改写更新建议"]')!;
    await act(async () => checkbox.click());
    await act(async () => setTextareaValue(textarea, "我核对后的更新内容。"));

    expect(checkbox.checked).toBe(true);
    expect(textarea.value).toBe("我核对后的更新内容。");

    const pushState = vi.spyOn(window.history, "pushState");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="打开更新依据"]')!.click();
    });

    expect(pushState).toHaveBeenLastCalledWith(null, "", sourceRoute);
    expect(window.location.hash).toBe(sourceRoute);
    const reader = host.querySelector<HTMLElement>('[aria-label="阅读器探针"]');
    expect(reader).toBeInstanceOf(HTMLElement);
    expect(reader?.dataset.sourceId).toBe(citation.sourceId);
    expect(reader?.dataset.versionId).toBe(citation.versionId);
    expect(host.querySelector('[aria-label="更新审核探针"]')).toBeNull();

    const popstate = new Promise<void>((resolve) =>
      window.addEventListener("popstate", () => resolve(), { once: true }),
    );
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="返回更新审核"]')!.click();
      await popstate;
    });

    expect(window.location.hash).toBe(updateRoute);
    expect(host.querySelector('[aria-label="阅读器探针"]')).toBeNull();
    expect(host.querySelector('[aria-label="更新审核探针"]')).toBeInstanceOf(HTMLElement);
    expect(host.querySelector<HTMLInputElement>('[aria-label="勾选更新建议"]')?.checked).toBe(true);
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="改写更新建议"]')?.value).toBe(
      "我核对后的更新内容。",
    );
  });

  it("restores the same account's checked edit after a complete Workspace remount", async () => {
    await act(async () =>
      host.querySelector<HTMLInputElement>('[aria-label="勾选更新建议"]')!.click(),
    );
    await act(async () =>
      setTextareaValue(
        host.querySelector<HTMLTextAreaElement>('[aria-label="改写更新建议"]')!,
        "刷新后继续审核的草稿。",
      ),
    );
    await act(async () => {
      await vi.waitFor(async () =>
        expect(
          (await loadKnowledgeUpdateReviewDrafts("local")).drafts[0]?.draft.editedTexts[changeId],
        ).toBe("刷新后继续审核的草稿。"),
      );
    });
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(Workspace)));
    await vi.waitFor(async () => {
      await act(async () => {
        await loadKnowledgeUpdateReviewDrafts("local");
      });
      expect(host.querySelector<HTMLTextAreaElement>('[aria-label="改写更新建议"]')?.value).toBe(
        "刷新后继续审核的草稿。",
      );
    });
    expect(host.querySelector<HTMLInputElement>('[aria-label="勾选更新建议"]')?.checked).toBe(true);
  });

  it("shows a failed account cleanup on an empty account home with a retry action", async () => {
    await act(async () =>
      host.querySelector<HTMLInputElement>('[aria-label="勾选更新建议"]')!.click(),
    );
    await act(async () => {
      await vi.waitFor(async () =>
        expect(
          (await loadKnowledgeUpdateReviewDrafts("local")).drafts[0]?.draft.selectedChangeIds,
        ).toEqual([changeId]),
      );
    });
    const originalDelete = FakeIDBObjectStore.prototype.delete;
    const deletion = vi.spyOn(FakeIDBObjectStore.prototype, "delete").mockImplementation(function (
      this: InstanceType<typeof FakeIDBObjectStore>,
      key,
    ) {
      if (this.transaction.db.name === KNOWLEDGE_UPDATE_DRAFT_DATABASE)
        throw new Error("cleanup refused");
      return originalDelete.call(this, key);
    });
    workspaceStore = {
      ...workspaceStore,
      user: { id: "empty-account", email: "empty@example.test" },
      data: {
        schemaVersion: 1,
        spaces: [],
        sources: [],
        notes: [],
        annotations: [],
        conversations: [],
        aiEnabled: true,
      },
    };
    window.history.replaceState(null, "", "#home");
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      root.render(createElement(Workspace));
    });
    await vi.waitFor(async () => {
      await act(async () => {
        await loadKnowledgeUpdateReviewDrafts("empty-account");
      });
      expect(host.querySelector('[aria-label="本机审核草稿保存提示"]')?.textContent).toContain(
        "之前账号的本机审核草稿尚未清理成功",
      );
    });
    const warning = host.querySelector('[aria-label="本机审核草稿保存提示"]')!;
    expect(warning.querySelector("button")?.textContent).toContain("重试本机操作");
    deletion.mockRestore();
    await act(async () => warning.querySelector<HTMLButtonElement>("button")!.click());
    await vi.waitFor(async () => {
      await act(async () => {
        await loadKnowledgeUpdateReviewDrafts("empty-account");
      });
      expect(host.querySelector('[aria-label="本机审核草稿保存提示"]')).toBeNull();
    });
    expect((await loadKnowledgeUpdateReviewDrafts("local")).drafts).toEqual([]);
  });
});
