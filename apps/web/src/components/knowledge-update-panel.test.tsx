// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyKnowledgeUpdate,
  knowledgeBlocks,
  snapshotKnowledgeNote,
} from "@/lib/knowledge-update";
import type { OrganizationJob } from "@/lib/organization-types";
import { createDemoWorkspace } from "@/lib/seed";
import type { Citation, Note, WorkspaceData } from "@/lib/types";
import KnowledgeUpdatePanel, {
  type KnowledgeUpdatePanelProps,
  type KnowledgeUpdateReviewDraft,
} from "./knowledge-update-panel";

function fixture() {
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
    page: chunk.page,
  };
  const note: Note = {
    id: "knowledge-update-note",
    spaceId: data.spaces[0]!.id,
    title: "学习率",
    content: "<h2>解释</h2><p>学习率决定每一步走多远。</p><p>保留我的例子。</p>",
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
  data.notes = [note];
  const blocks = knowledgeBlocks(note.content);
  const job: OrganizationJob = {
    id: "knowledge-update-job",
    status: "ready",
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    request: {
      requestId: "knowledge-update-job",
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
      coverage: "已核对所选资料片段。",
      changes: [
        {
          id: "change-one",
          type: "replace",
          blockId: blocks[1]!.id,
          before: blocks[1]!.html,
          after: "学习率控制参数更新的步长。",
          reason: "补充更准确的定义。",
          citations: [citation],
        },
        {
          id: "change-two",
          type: "replace",
          blockId: blocks[2]!.id,
          before: blocks[2]!.html,
          after: "保留并补充新的例子。",
          reason: "新资料提供了进一步说明。",
          citations: [citation],
        },
      ],
    },
  };
  data.organizationJobs = [job];
  return { data, note, job, citation };
}

function panelProps(
  data: WorkspaceData,
  noteId: string,
  patch: Partial<KnowledgeUpdatePanelProps> = {},
): KnowledgeUpdatePanelProps {
  return {
    data,
    noteId,
    status: { ready: true, running: false, message: "模型服务已就绪" },
    onGenerate: vi.fn(async () => {}),
    onApply: vi.fn(async () => {}),
    onIgnore: vi.fn(async () => {}),
    onRetry: vi.fn(async () => {}),
    onCheck: vi.fn(async () => {}),
    onStop: vi.fn(),
    onDismiss: vi.fn(async () => {}),
    onOpenCitation: vi.fn(),
    onBack: vi.fn(),
    ...patch,
  };
}

function setTextareaValue(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonByText(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.replace(/\s+/g, "") === label.replace(/\s+/g, ""),
  );
  expect(button, `${label} button`).toBeTruthy();
  return button!;
}

describe("KnowledgeUpdatePanel controlled review drafts", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("restores checked and edited suggestions after opening evidence and remounting", async () => {
    const { data, note, job, citation } = fixture();
    let drafts: Record<string, KnowledgeUpdateReviewDraft> = {};
    const onOpenCitation = vi.fn();
    const onReviewDraftChange = vi.fn((jobId: string, draft: KnowledgeUpdateReviewDraft | null) => {
      const next = { ...drafts };
      if (draft) next[jobId] = structuredClone(draft);
      else delete next[jobId];
      drafts = next;
    });
    const props = () =>
      panelProps(data, note.id, {
        reviewDrafts: drafts,
        onReviewDraftChange,
        onOpenCitation,
      });

    await act(async () => root.render(createElement(KnowledgeUpdatePanel, props())));
    const checkbox = host.querySelector<HTMLInputElement>(
      `#knowledge-update-${job.id}-change-one-select`,
    )!;
    const textarea = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="建议 1 的修改内容"]',
    )!;
    await act(async () => checkbox.click());
    await act(async () => root.render(createElement(KnowledgeUpdatePanel, props())));
    await act(async () => setTextareaValue(textarea, "我核对后的解释。"));
    await act(async () => root.render(createElement(KnowledgeUpdatePanel, props())));
    await act(async () => host.querySelector<HTMLButtonElement>(".organization-citation")!.click());

    expect(onOpenCitation).toHaveBeenCalledWith(citation);
    expect(drafts[job.id]).toEqual({
      selectedChangeIds: ["change-one"],
      editedTexts: { "change-one": "我核对后的解释。" },
    });

    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(KnowledgeUpdatePanel, props())));

    expect(
      host.querySelector<HTMLInputElement>(`#knowledge-update-${job.id}-change-one-select`)
        ?.checked,
    ).toBe(true);
    expect(
      host.querySelector<HTMLTextAreaElement>('textarea[aria-label="建议 1 的修改内容"]')?.value,
    ).toBe("我核对后的解释。");
  });

  it("clears applied selections and their edits while retaining another unselected edit", async () => {
    const { data, note, job } = fixture();
    const onApply = vi.fn(async () => {});
    const onReviewDraftChange = vi.fn();
    const reviewDrafts = {
      [job.id]: {
        selectedChangeIds: ["change-one"],
        editedTexts: {
          "change-one": "采用这段改写。",
          "change-two": "暂存但未勾选的改写。",
        },
      },
    };
    await act(async () => {
      root.render(
        createElement(
          KnowledgeUpdatePanel,
          panelProps(data, note.id, { reviewDrafts, onReviewDraftChange, onApply }),
        ),
      );
    });

    await act(async () => {
      buttonByText(host, "应用所选修改").click();
      await Promise.resolve();
    });

    expect(onApply).toHaveBeenCalledExactlyOnceWith(job.id, [
      { changeId: "change-one", text: "采用这段改写。" },
    ]);
    expect(onReviewDraftChange).toHaveBeenLastCalledWith(job.id, {
      selectedChangeIds: [],
      editedTexts: { "change-two": "暂存但未勾选的改写。" },
    });
  });

  it("removes only the ignored suggestion from the controlled draft", async () => {
    const { data, note, job } = fixture();
    const onIgnore = vi.fn(async () => {});
    const onReviewDraftChange = vi.fn();
    const reviewDrafts = {
      [job.id]: {
        selectedChangeIds: ["change-one", "change-two"],
        editedTexts: {
          "change-one": "不要保留的改写。",
          "change-two": "继续保留的改写。",
        },
      },
    };
    await act(async () => {
      root.render(
        createElement(
          KnowledgeUpdatePanel,
          panelProps(data, note.id, { reviewDrafts, onReviewDraftChange, onIgnore }),
        ),
      );
    });

    await act(async () => {
      buttonByText(host, "忽略此项").click();
      await Promise.resolve();
    });

    expect(onIgnore).toHaveBeenCalledExactlyOnceWith(job.id, "change-one");
    expect(onReviewDraftChange).toHaveBeenLastCalledWith(job.id, {
      selectedChangeIds: ["change-two"],
      editedTexts: { "change-two": "继续保留的改写。" },
    });
  });

  it("clears the whole controlled draft after the update record is dismissed", async () => {
    const { data, note, job } = fixture();
    const onDismiss = vi.fn(async () => {});
    const onReviewDraftChange = vi.fn();
    const reviewDrafts = {
      [job.id]: {
        selectedChangeIds: ["change-one"],
        editedTexts: { "change-one": "尚未应用的改写。" },
      },
    };
    await act(async () => {
      root.render(
        createElement(
          KnowledgeUpdatePanel,
          panelProps(data, note.id, { reviewDrafts, onReviewDraftChange, onDismiss }),
        ),
      );
    });

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="收起这次更新记录"]')!.click();
      await Promise.resolve();
    });

    expect(onDismiss).toHaveBeenCalledExactlyOnceWith(job.id);
    expect(onReviewDraftChange).toHaveBeenLastCalledWith(job.id, null);
  });

  it("offers human withdrawal after sources and model access become unavailable", async () => {
    const { data, note, job } = fixture();
    const applied = applyKnowledgeUpdate(data, job.id, [
      { changeId: "change-one", text: "学习率控制参数更新的步长。" },
    ]);
    applied.aiEnabled = false;
    applied.sources[0].deletedAt = "2026-09-15T00:00:00.000Z";
    await act(async () =>
      root.render(
        createElement(
          KnowledgeUpdatePanel,
          panelProps(applied, note.id, {
            status: { ready: false, running: false, message: "模型未配置" },
            onWithdraw: vi.fn(async () => {}),
          }),
        ),
      ),
    );
    expect(buttonByText(host, "生成更新建议").disabled).toBe(true);
    expect(buttonByText(host, "预览撤回").disabled).toBe(false);
  });

  it("retains a withdrawal entry for an applied update after its record is dismissed", async () => {
    const { data, note, job } = fixture();
    const applied = applyKnowledgeUpdate(data, job.id, [
      { changeId: "change-one", text: "学习率控制参数更新的步长。" },
    ]);
    applied.organizationJobs![0].status = "dismissed";
    await act(async () =>
      root.render(
        createElement(
          KnowledgeUpdatePanel,
          panelProps(applied, note.id, {
            onWithdraw: vi.fn(async () => {}),
          }),
        ),
      ),
    );
    expect(host.textContent).not.toContain("预览撤回");
    await act(async () => buttonByText(host, "已收起的更新（1）").click());
    expect(buttonByText(host, "预览撤回").disabled).toBe(false);
    expect(host.querySelector('[aria-label="收起这次更新记录"]')).toBeNull();
  });
});
