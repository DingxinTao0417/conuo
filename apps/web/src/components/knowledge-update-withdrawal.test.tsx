// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import type { OrganizationJob } from "@/lib/organization-types";

const preview = vi.hoisted(() => vi.fn());
vi.mock("@/lib/knowledge-update-withdrawal", () => ({
  previewKnowledgeUpdateWithdrawal: preview,
}));

import KnowledgeUpdateWithdrawal from "./knowledge-update-withdrawal";
import type { KnowledgeUpdateWithdrawalProps } from "./knowledge-update-withdrawal";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function plan(conflict = false) {
  return {
    jobId: "withdraw-job",
    noteId: "withdraw-note",
    fingerprint: "a".repeat(64),
    safeCount: conflict ? 0 : 1,
    conflictCount: conflict ? 1 : 0,
    changes: [
      {
        id: "change-1",
        kind: conflict ? "conflict" : "safe",
        beforeHtml: "<p>原理解。</p>",
        appliedHtml: "<p>AI 理解。</p>",
        currentHtml: "<p>AI 理解。我的例子。</p>",
        candidates: [
          {
            id: "candidate-1",
            start: 0,
            end: 23,
            currentHtml: "<p>AI 理解。我的例子。</p>",
            currentText: "AI 理解。我的例子。",
            restoreHtml: "<p>原理解。我的例子。</p>",
            canRestore: true,
            edits: [],
          },
        ],
      },
    ],
  };
}

describe("knowledge update withdrawal review", () => {
  let host: HTMLDivElement;
  let root: Root;
  let data: ReturnType<typeof createDemoWorkspace>;
  let job: OrganizationJob;
  let onWithdraw: ReturnType<typeof vi.fn<KnowledgeUpdateWithdrawalProps["onWithdraw"]>>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    data = createDemoWorkspace();
    data.notes = [
      {
        id: "withdraw-note",
        spaceId: data.spaces[0].id,
        title: "复习",
        kind: "knowledge",
        content: "<p>AI 理解。我的例子。</p>",
        citations: [],
        status: "accepted",
        versions: [],
        createdAt: "2026-09-15T00:00:00.000Z",
        updatedAt: "2026-09-15T01:00:00.000Z",
        deletedAt: null,
        contentRevision: 4,
      },
    ];
    job = {
      id: "withdraw-job",
      status: "ready",
      createdAt: data.notes[0].createdAt,
      updatedAt: data.notes[0].updatedAt,
      request: {
        kind: "update",
        requestId: "withdraw-job",
        trigger: "manual",
        spaceId: data.spaces[0].id,
        sourceIds: [data.sources[0].id],
        sourceVersions: [{ sourceId: data.sources[0].id, versionId: data.sources[0].versionId }],
        targetNote: { id: "withdraw-note", revision: 2, updatedAt: data.notes[0].createdAt },
      },
      updateReview: {
        note: { ...data.notes[0], aiGenerated: true, revision: 3 },
        applied: [{ changeId: "change-1", text: "AI 理解。" }],
        ignored: [],
      },
    } as OrganizationJob;
    onWithdraw = vi.fn(async () => {});
    preview.mockReset().mockResolvedValue(plan());
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  async function render(contextKey = "account-a:1", onEditCurrent?: () => void) {
    await act(async () =>
      root.render(
        createElement(KnowledgeUpdateWithdrawal, {
          data,
          job,
          contextKey,
          onWithdraw,
          onEditCurrent,
        }),
      ),
    );
  }
  function button(text: string) {
    const found = [...host.querySelectorAll("button")].find((node) =>
      node.textContent?.includes(text),
    );
    expect(found).toBeDefined();
    return found!;
  }
  async function open() {
    await act(async () => button("预览撤回").click());
  }
  it("previews before writing and restores safe changes only after confirmation", async () => {
    await render();
    expect(onWithdraw).not.toHaveBeenCalled();
    await open();
    expect(host.textContent).toContain("我的例子");
    expect(onWithdraw).not.toHaveBeenCalled();
    await act(async () => button("确认撤回").click());
    expect(onWithdraw).toHaveBeenCalledWith("withdraw-job", "a".repeat(64), [
      { changeId: "change-1", action: "restore", candidateId: "candidate-1" },
    ]);
  });
  it("requires an explicit choice for overlapping edits", async () => {
    preview.mockResolvedValue(plan(true));
    await render();
    await open();
    expect(button("确认撤回").disabled).toBe(true);
    await act(async () => host.querySelector<HTMLInputElement>('input[value="keep"]')!.click());
    await act(async () => button("确认撤回").click());
    expect(onWithdraw).toHaveBeenCalledWith("withdraw-job", "a".repeat(64), [
      { changeId: "change-1", action: "keep" },
    ]);
  });
  it("provides a plain text merge when automatic restoration is unavailable", async () => {
    const value = plan(true);
    value.changes[0].candidates[0].canRestore = false;
    preview.mockResolvedValue(value);
    await render();
    await open();
    await act(async () => host.querySelector<HTMLInputElement>('input[value="merge"]')!.click());
    const field = host.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field,
        "原理解。保留我的例子。<script>文本</script>",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("确认撤回").click());
    expect(onWithdraw.mock.calls[0][2][0]).toEqual({
      changeId: "change-1",
      action: "restore",
      candidateId: "candidate-1",
      text: "原理解。保留我的例子。<script>文本</script>",
    });
  });
  it("latches confirmation before React can rerender", async () => {
    const task = deferred<void>();
    onWithdraw.mockReturnValue(task.promise);
    await render();
    await open();
    await act(async () => {
      button("确认撤回").click();
      button("确认撤回").click();
    });
    expect(onWithdraw).toHaveBeenCalledTimes(1);
    await act(async () => task.resolve());
  });
  it("discards an old preview across account ABA transitions", async () => {
    const task = deferred<ReturnType<typeof plan>>();
    preview.mockReturnValue(task.promise);
    await render("a:1");
    await act(async () => button("预览撤回").click());
    await render("b:2");
    await render("a:3");
    await act(async () => task.resolve(plan()));
    expect(host.textContent).not.toContain("确认撤回");
    expect(onWithdraw).not.toHaveBeenCalled();
  });
  it("discards previews when only note history changes", async () => {
    await render();
    await open();
    data = structuredClone(data);
    data.notes[0].versions = [
      {
        id: "late-history",
        title: "旧标题",
        content: "<p>旧版本</p>",
        savedAt: "2026-09-15T00:00:00.000Z",
      },
    ];
    await render();
    expect(host.textContent).not.toContain("确认撤回");
  });
  it("ignores late failures from an obsolete account", async () => {
    const task = deferred<void>();
    onWithdraw.mockReturnValue(task.promise);
    await render();
    await open();
    await act(async () => button("确认撤回").click());
    await render("b:2");
    await act(async () => task.reject(new Error("旧账号私有失败")));
    expect(host.textContent).not.toContain("旧账号私有失败");
  });
  it("never interprets preview HTML as active DOM", async () => {
    const value = plan();
    value.changes[0].beforeHtml =
      '<p>内容<script>evil()</script><img src="x" onerror="evil()"></p>';
    preview.mockResolvedValue(value);
    await render();
    await open();
    expect(host.querySelector("script, img, [onerror]")).toBeNull();
  });

  it("requires a current location before resolving repeated candidates", async () => {
    const value = plan(true);
    value.changes[0].candidates.push({
      ...value.changes[0].candidates[0],
      id: "candidate-2",
      start: 40,
      end: 63,
    });
    preview.mockResolvedValue(value);
    await render();
    await open();
    expect(button("确认撤回").disabled).toBe(true);
    await act(async () => {
      const select = host.querySelector("select")!;
      select.value = "candidate-2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(button("确认撤回").disabled).toBe(true);
    await act(async () => host.querySelector<HTMLInputElement>('input[value="restore"]')!.click());
    await act(async () => button("确认撤回").click());
    expect(onWithdraw.mock.calls[0][2][0]).toEqual({
      changeId: "change-1",
      action: "restore",
      candidateId: "candidate-2",
    });
  });

  it("cancel closes the preview without changing the note", async () => {
    await render();
    await open();
    await act(async () => button("取消").click());
    expect(host.textContent).not.toContain("确认撤回");
    expect(onWithdraw).not.toHaveBeenCalled();
    expect(data.notes[0].content).toContain("AI 理解");
  });

  it("shows local-save failure without reporting completion", async () => {
    onWithdraw.mockRejectedValue(new Error("操作结果尚未保存到此浏览器"));
    await render();
    await open();
    await act(async () => button("确认撤回").click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("尚未保存");
    expect(host.textContent).toContain("确认撤回");
    expect(host.textContent).not.toContain("这次更新已封存");
  });

  it("shows a sealed receipt as current-page state rather than cloud confirmation", async () => {
    job.updateReview!.withdrawal = {
      id: "receipt-1",
      at: "2026-09-15T02:00:00.000Z",
      noteRevision: 5,
      fingerprint: "a".repeat(64),
      restoredChangeIds: ["change-1"],
      keptChangeIds: [],
    };
    await render();
    expect(host.textContent).toContain("这次更新已封存");
    expect(host.textContent).toContain("保存状态以顶部提示为准");
    expect(host.querySelector("button")).toBeNull();
    expect(preview).not.toHaveBeenCalled();
  });
  it("offers direct manual editing for a position that cannot be safely located", async () => {
    preview.mockResolvedValue(plan(true));
    const edit = vi.fn();
    await render("account-a:1", edit);
    await open();
    await act(async () => button("返回知识页手工编辑").click());
    expect(edit).toHaveBeenCalledTimes(1);
    expect(onWithdraw).not.toHaveBeenCalled();
  });
});
