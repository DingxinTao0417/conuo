// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory, IDBObjectStore as FakeIDBObjectStore } from "fake-indexeddb";
import { deleteDB } from "idb";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import KnowledgeUpdatePanel from "@/components/knowledge-update-panel";
import {
  applyKnowledgeUpdate,
  ignoreKnowledgeChange,
  knowledgeBlocks,
  snapshotKnowledgeNote,
} from "./knowledge-update";
import { dismissOrganizationJob } from "./organization-review";
import * as localDrafts from "./knowledge-update-review-drafts";
import { createDemoWorkspace, createEmptyWorkspace } from "./seed";
import type { OrganizationJob } from "./organization-types";
import type { Citation, Note, WorkspaceData } from "./types";
import { useKnowledgeUpdateReviewDrafts } from "./use-knowledge-update-review-drafts";

const accountA = "account-a";
const accountB = "account-b";
const noteId = "draft-note";
const jobId = "draft-job";
const firstChange = "change-one";
const secondChange = "change-two";

function fixture(): WorkspaceData {
  const data = createDemoWorkspace();
  const source = data.sources[0]!;
  const chunk = source.chunks[0]!;
  const citation: Citation = {
    sourceId: source.id,
    versionId: source.versionId,
    chunkId: chunk.id,
    title: source.title,
    quote: chunk.text,
    section: chunk.section,
    ...(chunk.page ? { page: chunk.page } : {}),
  };
  const note: Note = {
    id: noteId,
    spaceId: data.spaces[0]!.id,
    title: "审核草稿",
    content: "<p>第一项原文。</p><p>第二项原文。</p>",
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
  const blocks = knowledgeBlocks(note.content);
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
      targetNote: { id: noteId, revision: 2, updatedAt: note.updatedAt },
    },
    result: {
      kind: "update",
      mode: "model",
      target: snapshotKnowledgeNote(note),
      coverage: "已核对。",
      changes: blocks.map((block, index) => ({
        id: index ? secondChange : firstChange,
        type: "replace",
        blockId: block.id,
        before: block.html,
        after: index ? "第二项建议。" : "第一项建议。",
        reason: "补充解释。",
        citations: [citation],
      })),
    },
  };
  data.notes = [note];
  data.organizationJobs = [job];
  return data;
}

function Harness({
  accountId,
  workspace,
  ready,
  onDataChange,
}: {
  accountId: string;
  workspace: WorkspaceData;
  ready: boolean;
  onDataChange: (data: WorkspaceData) => void;
}) {
  const drafts = useKnowledgeUpdateReviewDrafts(accountId, workspace, ready);
  return createElement(KnowledgeUpdatePanel, {
    data: workspace,
    noteId,
    status: { ready: true, running: false, message: "模型服务已就绪" },
    onGenerate: async () => {},
    onRetry: async () => {},
    onCheck: async () => {},
    onStop: () => {},
    onOpenCitation: () => {},
    onBack: () => {},
    onApply: (id, changes) => {
      onDataChange(applyKnowledgeUpdate(workspace, id, changes));
      drafts.removeChanges(
        noteId,
        id,
        changes.map((change) => change.changeId),
      );
    },
    onIgnore: (id, changeId) => {
      onDataChange(ignoreKnowledgeChange(workspace, id, changeId));
      drafts.removeChanges(noteId, id, [changeId]);
    },
    onDismiss: (id) => {
      onDataChange(dismissOrganizationJob(workspace, id));
      drafts.change(noteId, id, null);
    },
    reviewDrafts: drafts.draftsFor(noteId),
    onReviewDraftChange: (id, draft) => drafts.change(noteId, id, draft),
    reviewDraftSaveStatus: drafts.status,
    onRetryReviewDraftSave: drafts.retry,
  });
}

function setValue(element: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
    element,
    value,
  );
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("knowledge review draft persistence workflow", () => {
  let host: HTMLDivElement;
  let root: Root;
  let workspace: WorkspaceData;
  let accountId: string;
  let ready: boolean;

  const render = () =>
    root.render(
      createElement(Harness, {
        accountId,
        workspace,
        ready,
        onDataChange: (next) => {
          workspace = next;
          render();
        },
      }),
    );
  const firstText = () =>
    host.querySelector<HTMLTextAreaElement>('[aria-label="建议 1 的修改内容"]')!;
  const checkbox = (index = 1) =>
    host.querySelector<HTMLInputElement>(
      `#knowledge-update-${jobId}-change-${index === 1 ? "one" : "two"}-select`,
    )!;
  const saved = async () => (await localDrafts.loadKnowledgeUpdateReviewDrafts(accountId)).drafts;
  async function edit(value = "我核对后的第一项内容。") {
    await act(async () => {
      checkbox().click();
    });
    await act(async () => setValue(firstText(), value));
    await vi.waitFor(async () =>
      expect((await saved())[0]?.draft.editedTexts[firstChange]).toBe(value),
    );
  }
  async function remount() {
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => render());
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("indexedDB", new IDBFactory());
    workspace = fixture();
    accountId = accountA;
    ready = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    await deleteDB(localDrafts.KNOWLEDGE_UPDATE_DRAFT_DATABASE);
    vi.unstubAllGlobals();
  });

  it("restores checked edits on a same-account remount", async () => {
    await act(async () => render());
    await edit();
    await remount();
    await vi.waitFor(() => expect(firstText().value).toBe("我核对后的第一项内容。"));
    expect(checkbox().checked).toBe(true);
    expect(host.textContent).toContain("已保存到本机");
  });

  it("restores equivalent contracts whose object field order changed during serialization", async () => {
    await act(async () => render());
    await edit();
    const job = workspace.organizationJobs![0]!;
    const reordered = Object.fromEntries(
      Object.entries(job.request).reverse(),
    ) as OrganizationJob["request"];
    workspace = { ...workspace, organizationJobs: [{ ...job, request: reordered }] };
    await remount();
    await vi.waitFor(() => expect(firstText().value).toBe("我核对后的第一项内容。"));
    expect(checkbox().checked).toBe(true);
  });

  it("clears a live changed result without falling back to the panel's old internal edit", async () => {
    await act(async () => render());
    await edit();
    const job = structuredClone(workspace.organizationJobs![0]!);
    if (job.result?.kind === "update") job.result.changes[0]!.after = "重新生成后的新建议。";
    workspace = { ...workspace, organizationJobs: [job] };
    await act(async () => render());
    expect(firstText().value).toBe("重新生成后的新建议。");
    expect(checkbox().checked).toBe(false);
    await vi.waitFor(async () => expect(await saved()).toEqual([]));
  });

  it("isolates accounts and clears only the departing account on switching", async () => {
    await act(async () => render());
    await edit();
    const sessionB = await localDrafts.loadKnowledgeUpdateReviewDrafts(accountB);
    await localDrafts.saveKnowledgeUpdateReviewDraft(sessionB, noteId, jobId, {
      accountId: accountB,
      noteId,
      jobId,
      contract: localDrafts.knowledgeUpdateDraftContract(workspace.organizationJobs![0]!),
      draft: { selectedChangeIds: [], editedTexts: { [firstChange]: "账号 B 的草稿。" } },
    });
    accountId = accountB;
    await act(async () => render());
    await vi.waitFor(() => expect(firstText().value).toBe("账号 B 的草稿。"));
    expect(checkbox().checked).toBe(false);
    await vi.waitFor(async () =>
      expect((await localDrafts.loadKnowledgeUpdateReviewDrafts(accountA)).drafts).toEqual([]),
    );
    expect((await saved())[0]?.draft.editedTexts[firstChange]).toBe("账号 B 的草稿。");
  });

  it.each(["failed", "dismissed", "missing", "note-changed", "result-changed"])(
    "does not restore a %s task contract",
    async (reason) => {
      await act(async () => render());
      await edit();
      await act(async () => root.unmount());
      root = createRoot(host);
      if (reason === "missing") workspace.organizationJobs = [];
      else if (reason === "note-changed")
        workspace.notes[0] = {
          ...workspace.notes[0]!,
          content: "<p>新的正文。</p>",
          contentRevision: 3,
        };
      else if (reason === "result-changed") {
        const job = workspace.organizationJobs![0]!;
        if (job.result?.kind === "update") job.result.changes[0]!.after = "新任务结果。";
      } else workspace.organizationJobs![0]!.status = reason as "failed" | "dismissed";
      await act(async () => render());
      await vi.waitFor(async () => expect(await saved()).toEqual([]));
      expect(host.textContent).not.toContain("我核对后的第一项内容。");
      if (firstText()) expect(firstText().value).not.toBe("我核对后的第一项内容。");
    },
  );

  it("waits for workspace readiness before loading or pruning real persisted drafts", async () => {
    await act(async () => render());
    await edit();
    const realWorkspace = workspace;
    await act(async () => root.unmount());
    root = createRoot(host);
    workspace = createEmptyWorkspace();
    ready = false;
    const load = vi.spyOn(localDrafts, "loadKnowledgeUpdateReviewDrafts");
    await act(async () => render());
    expect(load).not.toHaveBeenCalled();
    expect((await saved())[0]?.draft.editedTexts[firstChange]).toBe("我核对后的第一项内容。");
    workspace = realWorkspace;
    ready = true;
    await act(async () => render());
    await vi.waitFor(() => expect(firstText().value).toBe("我核对后的第一项内容。"));
  });

  it("keeps newer user input when an older local read resolves late", async () => {
    await act(async () => render());
    await edit("旧草稿。");
    const originalLoad = localDrafts.loadKnowledgeUpdateReviewDrafts;
    const old = await originalLoad(accountA);
    await act(async () => root.unmount());
    root = createRoot(host);
    let resolve!: (session: localDrafts.KnowledgeUpdateDraftSession) => void;
    const pending = new Promise<localDrafts.KnowledgeUpdateDraftSession>((done) => {
      resolve = done;
    });
    vi.spyOn(localDrafts, "loadKnowledgeUpdateReviewDrafts").mockReturnValueOnce(pending);
    await act(async () => render());
    await act(async () => setValue(firstText(), "读取期间的新编辑。"));
    expect(firstText().value).toBe("读取期间的新编辑。");
    await act(async () => resolve(old));
    await vi.waitFor(async () =>
      expect((await originalLoad(accountA)).drafts[0]?.draft.editedTexts[firstChange]).toBe(
        "读取期间的新编辑。",
      ),
    );
    expect(firstText().value).toBe("读取期间的新编辑。");
  });

  it("cleans applied and ignored changes while keeping another unresolved edit, then cleans dismiss", async () => {
    await act(async () => render());
    await edit();
    const second = host.querySelector<HTMLTextAreaElement>('[aria-label="建议 2 的修改内容"]')!;
    await act(async () => setValue(second, "第二项未完成的草稿。"));
    const apply = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("应用所选修改"),
    )!;
    await act(async () => apply.click());
    await vi.waitFor(async () =>
      expect((await saved())[0]?.draft).toEqual({
        selectedChangeIds: [],
        editedTexts: { [secondChange]: "第二项未完成的草稿。" },
      }),
    );
    const ignore = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "忽略此项",
    )!;
    await act(async () => ignore.click());
    await vi.waitFor(async () => expect(await saved()).toEqual([]));
    workspace = fixture();
    await act(async () => render());
    await edit("再次审核的草稿。");
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="收起这次更新记录"]')!.click(),
    );
    await vi.waitFor(async () => expect(await saved()).toEqual([]));
  });

  it("preserves memory and saved bytes when writing fails, and recovers after retry", async () => {
    await act(async () => render());
    await edit("已落盘的旧编辑。");
    const originalPut = FakeIDBObjectStore.prototype.put;
    const put = vi.spyOn(FakeIDBObjectStore.prototype, "put").mockImplementation(function (
      this: InstanceType<typeof FakeIDBObjectStore>,
      value,
      key,
    ) {
      if (this.transaction.db.name === localDrafts.KNOWLEDGE_UPDATE_DRAFT_DATABASE)
        throw new Error("disk full");
      return originalPut.call(this, value, key);
    });
    await act(async () => setValue(firstText(), "本次内存编辑仍可见。"));
    await vi.waitFor(() => expect(host.textContent).toContain("本机审核草稿未能保存"));
    expect(firstText().value).toBe("本次内存编辑仍可见。");
    expect((await saved())[0]?.draft.editedTexts[firstChange]).toBe("已落盘的旧编辑。");
    put.mockRestore();
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "重试本机操作",
    )!;
    await act(async () => retry.click());
    await vi.waitFor(async () =>
      expect((await saved())[0]?.draft.editedTexts[firstChange]).toBe("本次内存编辑仍可见。"),
    );
    expect(firstText().value).toBe("本次内存编辑仍可见。");
  });

  it("does not replace in-memory input after a read failure", async () => {
    const load = vi
      .spyOn(localDrafts, "loadKnowledgeUpdateReviewDrafts")
      .mockRejectedValue(new Error("read denied"));
    await act(async () => render());
    await vi.waitFor(() => expect(host.textContent).toContain("未能读取本机审核草稿"));
    await act(async () => setValue(firstText(), "未落盘但仍在页面的编辑。"));
    await vi.waitFor(() => expect(host.textContent).toContain("本机审核草稿未能保存"));
    expect(firstText().value).toBe("未落盘但仍在页面的编辑。");
    load.mockRestore();
    expect(await saved()).toEqual([]);
  });

  it("replays a failed deletion on retry so a remount does not resurrect the old selection", async () => {
    await act(async () => render());
    await act(async () => checkbox().click());
    await vi.waitFor(async () =>
      expect((await saved())[0]?.draft.selectedChangeIds).toEqual([firstChange]),
    );
    const originalPut = FakeIDBObjectStore.prototype.put;
    const put = vi.spyOn(FakeIDBObjectStore.prototype, "put").mockImplementation(function (
      this: InstanceType<typeof FakeIDBObjectStore>,
      value,
      key,
    ) {
      if (this.transaction.db.name === localDrafts.KNOWLEDGE_UPDATE_DRAFT_DATABASE)
        throw new Error("disk refuses clear");
      return originalPut.call(this, value, key);
    });
    await act(async () => checkbox().click());
    await vi.waitFor(() => expect(host.textContent).toContain("本机审核草稿未能清理"));
    expect(checkbox().checked).toBe(false);
    expect((await saved())[0]?.draft.selectedChangeIds).toEqual([firstChange]);
    put.mockRestore();
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "重试本机操作",
    )!;
    await act(async () => retry.click());
    await vi.waitFor(async () => expect(await saved()).toEqual([]));
    await remount();
    await vi.waitFor(() => expect(host.textContent).not.toContain("正在读取本机审核草稿"));
    expect(checkbox().checked).toBe(false);
    expect(firstText().value).toBe("第一项建议。");
  });

  it("keeps a failed previous-account cleanup visible after current-account edits save", async () => {
    await act(async () => render());
    await edit();
    const originalDelete = FakeIDBObjectStore.prototype.delete;
    const deletion = vi.spyOn(FakeIDBObjectStore.prototype, "delete").mockImplementation(function (
      this: InstanceType<typeof FakeIDBObjectStore>,
      key,
    ) {
      if (this.transaction.db.name === localDrafts.KNOWLEDGE_UPDATE_DRAFT_DATABASE)
        throw new Error("cleanup denied");
      return originalDelete.call(this, key);
    });
    accountId = accountB;
    await act(async () => render());
    await vi.waitFor(() =>
      expect(host.textContent).toContain("之前账号的本机审核草稿尚未清理成功"),
    );
    await edit("当前账号已落盘的内容。");
    expect(host.textContent).toContain("之前账号的本机审核草稿尚未清理成功");
    expect(host.textContent).not.toContain("审核勾选和编辑已保存到本机");
    deletion.mockRestore();
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "重试本机操作",
    )!;
    await act(async () => retry.click());
    await vi.waitFor(() => expect(host.textContent).toContain("审核勾选和编辑已保存到本机"));
    expect((await localDrafts.loadKnowledgeUpdateReviewDrafts(accountA)).drafts).toEqual([]);
    expect((await saved())[0]?.draft.editedTexts[firstChange]).toBe("当前账号已落盘的内容。");
  });

  it("defers an in-flight read while readiness is lost and restores after the workspace is ready again", async () => {
    await act(async () => render());
    await edit();
    const originalLoad = localDrafts.loadKnowledgeUpdateReviewDrafts;
    const old = await originalLoad(accountA);
    const realWorkspace = workspace;
    await act(async () => root.unmount());
    root = createRoot(host);
    let resolve!: (session: localDrafts.KnowledgeUpdateDraftSession) => void;
    vi.spyOn(localDrafts, "loadKnowledgeUpdateReviewDrafts").mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await act(async () => render());
    workspace = createEmptyWorkspace();
    ready = false;
    await act(async () => {
      render();
      resolve(old);
    });
    expect((await originalLoad(accountA)).drafts[0]?.draft.editedTexts[firstChange]).toBe(
      "我核对后的第一项内容。",
    );
    workspace = realWorkspace;
    ready = true;
    await act(async () => render());
    expect(firstText().value).toBe("我核对后的第一项内容。");
    expect(checkbox().checked).toBe(true);
  });

  it("saves the newest edit made during retry loading and restores that edit on remount", async () => {
    await act(async () => render());
    await edit("先前已保存的内容。");
    const originalPut = FakeIDBObjectStore.prototype.put;
    const put = vi.spyOn(FakeIDBObjectStore.prototype, "put").mockImplementation(function (
      this: InstanceType<typeof FakeIDBObjectStore>,
      value,
      key,
    ) {
      if (this.transaction.db.name === localDrafts.KNOWLEDGE_UPDATE_DRAFT_DATABASE)
        throw new Error("write denied");
      return originalPut.call(this, value, key);
    });
    await act(async () => setValue(firstText(), "失败的第一版编辑。"));
    await vi.waitFor(() => expect(host.textContent).toContain("本机审核草稿未能保存"));
    put.mockRestore();
    const originalLoad = localDrafts.loadKnowledgeUpdateReviewDrafts;
    const old = await originalLoad(accountA);
    let resolve!: (session: localDrafts.KnowledgeUpdateDraftSession) => void;
    vi.spyOn(localDrafts, "loadKnowledgeUpdateReviewDrafts").mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "重试本机操作",
    )!;
    await act(async () => retry.click());
    await act(async () => setValue(firstText(), "重试期间的第二版编辑。"));
    await act(async () => resolve(old));
    await vi.waitFor(async () =>
      expect((await originalLoad(accountA)).drafts[0]?.draft.editedTexts[firstChange]).toBe(
        "重试期间的第二版编辑。",
      ),
    );
    await remount();
    await vi.waitFor(() => expect(firstText().value).toBe("重试期间的第二版编辑。"));
  });

  it("waits for outgoing cleanup on a quick account A to B to A switch", async () => {
    await act(async () => render());
    await edit("切换前的旧草稿。");
    const originalClear = localDrafts.clearAccountKnowledgeUpdateReviewDrafts;
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    vi.spyOn(localDrafts, "clearAccountKnowledgeUpdateReviewDrafts").mockImplementation(
      (owner, options) =>
        owner === accountA
          ? gate.then(() => originalClear(owner, options))
          : originalClear(owner, options),
    );
    accountId = accountB;
    await act(async () => render());
    accountId = accountA;
    await act(async () => render());
    expect(firstText().value).toBe("第一项建议。");
    expect(checkbox().checked).toBe(false);
    expect(host.textContent).not.toContain("审核勾选和编辑已保存到本机");
    await act(async () => release());
    await vi.waitFor(async () => expect(await saved()).toEqual([]));
    await edit("清理完成后的新草稿。");
    await remount();
    await vi.waitFor(() => expect(firstText().value).toBe("清理完成后的新草稿。"));
  });
});
