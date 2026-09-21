// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import type { NoteSyncPlan } from "@/lib/sync-conflicts";
import type { Note } from "@/lib/types";
import SyncConflictModal from "./sync-conflict-modal";

vi.mock("../lazy-panels", async () => ({
  NoteEditor: (await import("../../note-editor")).default,
}));

describe("readable note conflict comparison and merging", () => {
  let root: Root;
  let host: HTMLDivElement;
  let onResolve: ReturnType<typeof vi.fn<ComponentProps<typeof SyncConflictModal>["onResolve"]>>;
  let onClose: ReturnType<typeof vi.fn<() => void>>;
  let previousShow: PropertyDescriptor | undefined;
  let previousClose: PropertyDescriptor | undefined;
  let plan: NoteSyncPlan;
  const localHtml =
    "<h2>当前解释</h2><p><strong>学习率</strong>控制步长。</p><ul><li><p>保留列表</p></li></ul><table><tbody><tr><th><p>参数</p></th><th><p>作用</p></th></tr><tr><td><p>步长</p></td><td><p>调整幅度</p></td></tr></tbody></table>";
  const note = (content: string): Note => ({
    id: "note",
    title: "学习笔记",
    spaceId: "",
    kind: "note",
    status: "accepted",
    content,
    citations: [],
    versions: [],
    createdAt: "2026-09-21T00:00:00Z",
    updatedAt: "2026-09-21T00:00:00Z",
    deletedAt: null,
  });
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    previousShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
    previousClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: vi.fn(),
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    onResolve = vi.fn().mockResolvedValue(undefined);
    onClose = vi.fn();
    plan = {
      baseKnown: true,
      safe: [],
      conflicts: [
        {
          id: "conflict",
          noteId: "note",
          kind: "both-edited",
          local: note(localHtml),
          remote: note(
            '<h2>另一份解释</h2><p>保留这条 <a href="https://example.org">参考链接</a>。</p>',
          ),
          base: note("<p>原文</p>"),
          localState: "live",
          remoteState: "live",
        },
      ],
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    if (previousShow) Object.defineProperty(HTMLDialogElement.prototype, "showModal", previousShow);
    else delete (HTMLDialogElement.prototype as { showModal?: () => void }).showModal;
    if (previousClose) Object.defineProperty(HTMLDialogElement.prototype, "close", previousClose);
    else delete (HTMLDialogElement.prototype as { close?: () => void }).close;
    vi.unstubAllGlobals();
  });
  async function render() {
    await act(async () =>
      root.render(
        createElement(SyncConflictModal, { storageMode: "cloud", plan, onResolve, onClose }),
      ),
    );
  }
  async function choose(name: string) {
    const label = [...host.querySelectorAll("label")].find(
      (el) => el.textContent?.trim() === name,
    )!;
    await act(async () => {
      label.querySelector("input")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  async function save() {
    await act(async () =>
      [...host.querySelectorAll("button")].find((el) => el.textContent === "保存合并结果")!.click(),
    );
  }
  function liveEditor() {
    const element = host.querySelector<HTMLElement>('[aria-label="笔记正文"]')!;
    return { element, editor: (element as HTMLElement & { editor: Editor }).editor };
  }

  it("renders headings, lists, tables and safe links without executing source HTML", async () => {
    plan.conflicts[0].remote!.content +=
      '<script>bad()</script><img src="https://example.org/tracker" onerror="bad()"><a href="javascript:bad()">不安全链接</a>';
    await render();
    expect(host.querySelector('[aria-label="当前页面正文"] h2')?.textContent).toBe("当前解释");
    expect(host.querySelector('[aria-label="当前页面正文"] strong')?.textContent).toBe("学习率");
    expect(host.querySelector('[aria-label="当前页面正文"] ul li')?.textContent).toBe("保留列表");
    expect(host.querySelectorAll('[aria-label="当前页面正文"] table td')).toHaveLength(2);
    expect(host.querySelector('[aria-label="云端正文"] a')?.getAttribute("href")).toBe(
      "https://example.org",
    );
    expect(host.querySelector("script,img,iframe,[onerror]")).toBeNull();
    expect(host.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(host.textContent).not.toContain("<h2>");
    await choose("保留当前页面版本");
    await save();
    expect(onResolve).toHaveBeenCalledWith([
      { conflictId: "conflict", choice: "local", content: undefined },
    ]);
    expect(plan.conflicts[0].local!.content).toBe(localHtml);
  });

  it("opening manual editing preserves exact raw payload when nothing is edited", async () => {
    await render();
    await choose("手动合并");
    expect(liveEditor().element.querySelector("table td")?.textContent).toBe("步长");
    expect(host.querySelector("textarea")).toBeNull();
    await save();
    expect(onResolve).toHaveBeenCalledWith([
      { conflictId: "conflict", choice: "manual", content: localHtml },
    ]);
  });

  it("preserves rich-text edits and prior manual work across choices and failed saves", async () => {
    onResolve.mockRejectedValue(new Error("模拟保存失败"));
    await render();
    await choose("手动合并");
    const { editor } = liveEditor();
    await act(async () =>
      editor.commands.insertContentAt(editor.state.doc.content.size, "<p><em>新增解释</em></p>"),
    );
    await choose("保留云端版本");
    await choose("手动合并");
    expect(liveEditor().element.querySelector("em")?.textContent).toBe("新增解释");
    await save();
    const payload = onResolve.mock.calls[0][0][0].content as string;
    expect(payload).toContain("<strong>学习率</strong>");
    expect(payload).toContain("<table");
    expect(payload).toContain("<em>新增解释</em>");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("模拟保存失败");
    expect(liveEditor().element.textContent).toContain("新增解释");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps link insertion separate from resolution and locks the editor while saving", async () => {
    let finish!: () => void;
    onResolve.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await choose("手动合并");
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="添加链接"]')!.click(),
    );
    expect(host.querySelector("form form")).toBeNull();
    expect(host.querySelectorAll("form")).toHaveLength(1);
    expect(onResolve).not.toHaveBeenCalled();
    await save();
    expect(host.querySelector(".sync-conflict-manual [inert]")).not.toBeNull();
    expect(
      [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')].every(
        (input) => input.disabled,
      ),
    ).toBe(true);
    await act(async () => finish());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each(["close", "escape", "cancel"])(
    "protects edited manual text on %s after a failed save, including when another choice is selected",
    async (method) => {
      onResolve.mockRejectedValue(new Error("模拟保存失败"));
      await render();
      await choose("手动合并");
      const { editor } = liveEditor();
      await act(async () =>
        editor.commands.insertContentAt(
          editor.state.doc.content.size,
          "<p>还没有保存的合并想法</p>",
        ),
      );
      await save();
      await choose("保留云端版本");
      const unload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(true);
      await act(async () => {
        if (method === "escape")
          host.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
        else if (method === "close")
          host.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click();
        else
          [...host.querySelectorAll("button")]
            .find((button) => button.textContent === "取消")!
            .click();
      });
      expect(onClose).not.toHaveBeenCalled();
      expect(host.textContent).toContain("放弃手动合并草稿？");
      await act(async () =>
        [...host.querySelectorAll("button")]
          .find((button) => button.textContent === "继续编辑")!
          .click(),
      );
      await choose("手动合并");
      expect(liveEditor().element.textContent).toContain("还没有保存的合并想法");
      await act(async () =>
        [...host.querySelectorAll("button")]
          .find((button) => button.textContent === "取消")!
          .click(),
      );
      await act(async () =>
        [...host.querySelectorAll("button")]
          .find((button) => button.textContent === "放弃草稿并离开")!
          .click(),
      );
      expect(onClose).toHaveBeenCalledOnce();
      expect(onResolve).toHaveBeenCalledOnce();
    },
  );

  it.each(["保留当前页面版本", "手动合并"])(
    "does not confirm exit after only selecting %s without new input",
    async (choice) => {
      await render();
      await choose(choice);
      await act(async () =>
        [...host.querySelectorAll("button")]
          .find((button) => button.textContent === "取消")!
          .click(),
      );
      expect(onClose).toHaveBeenCalledOnce();
      expect(host.textContent).not.toContain("放弃手动合并草稿？");
    },
  );

  it("closes directly after an edited draft is successfully confirmed", async () => {
    await render();
    await choose("手动合并");
    const { editor } = liveEditor();
    await act(async () =>
      editor.commands.insertContentAt(editor.state.doc.content.size, "<p>已确认的新想法</p>"),
    );
    await save();
    expect(onClose).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain("放弃手动合并草稿？");
    expect(onResolve.mock.calls[0][0][0].content).toContain("已确认的新想法");
  });
});
