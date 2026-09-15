// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourcePurgePreview } from "@/lib/cloud";
import type { PermanentSourceDeletionSelection } from "@/lib/permanent-deletion";
import { createDemoWorkspace } from "@/lib/seed";
import SourcePurgeModal, { type SourcePurgeModalProps } from "./source-purge-modal";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("source purge selection and reviewed confirmation", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: SourcePurgeModalProps;
  let onPreview: ReturnType<typeof vi.fn<SourcePurgeModalProps["onPreview"]>>;
  let onPurge: ReturnType<typeof vi.fn<SourcePurgeModalProps["onPurge"]>>;
  let onClose: ReturnType<typeof vi.fn<SourcePurgeModalProps["onClose"]>>;

  function serverPreview(
    selection: PermanentSourceDeletionSelection = { noteIds: [], conversationIds: [] },
  ): SourcePurgePreview {
    const notes = [
      { id: "note-a", title: "我的学习笔记", kind: "note" as const, versions: 3 },
      { id: "knowledge-b", title: "综合知识页", kind: "knowledge" as const, versions: 2 },
    ];
    const conversations = [{ id: "conversation-c", title: "涉及其他资料的讨论", messages: 7 }];
    const selectedNotes = notes.filter((note) => selection.noteIds.includes(note.id));
    return {
      revision: 9,
      fingerprint: `fingerprint:${JSON.stringify(selection)}`,
      contentSelection: { version: 1, notes, conversations, selection: structuredClone(selection) },
      impact: {
        source: {
          id: props.source.id,
          title: props.source.title,
          deletedAt: props.source.deletedAt,
        },
        versions: 2,
        annotations: 1,
        blockingAnnotations: 0,
        retainedNotes: notes.length - selection.noteIds.length,
        retainedNoteCitations: 4 - selectedNotes.length,
        retainedConversations: conversations.length - selection.conversationIds.length,
        retainedConversationCitations: selection.conversationIds.length ? 0 : 2,
        removedNotes: selectedNotes.length,
        removedNoteVersions: selectedNotes.reduce((total, note) => total + note.versions, 0),
        removedConversations: selection.conversationIds.length,
        removedMessages: selection.conversationIds.length ? 7 : 0,
        organizationJobs: 1,
        pendingOrganizationJobs: 1,
        conceptRelations: 1,
        blockingConceptRelations: 0,
        importJobs: 1,
        localOriginals: 2,
        cloudOriginals: 2,
      },
      blockers: { annotations: [], conceptRelations: [] },
    };
  }

  async function render() {
    await act(async () => {
      root.render(createElement(SourcePurgeModal, props));
    });
  }

  async function settleInitial() {
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  function button(label: string): HTMLButtonElement {
    const value = [...host.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === label,
    );
    expect(value, `button ${label}`).toBeTruthy();
    return value!;
  }

  function checkbox(label: string): HTMLInputElement {
    const input = host.querySelector<HTMLInputElement>(`input[aria-label='${label}']`);
    expect(input).toBeTruthy();
    return input!;
  }

  function confirmation(): HTMLInputElement {
    const input = host.querySelector<HTMLInputElement>(
      "input[aria-label='输入资料名称以确认彻底删除']",
    );
    expect(input).toBeTruthy();
    return input!;
  }

  async function typeName(value = props.source.title) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        confirmation(),
        value,
      );
      confirmation().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function click(value: HTMLElement) {
    await act(async () => {
      value.click();
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.removeAttribute("open");
      },
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    onPreview = vi.fn(async (selection) => serverPreview(selection));
    onPurge = vi.fn(async () => {});
    onClose = vi.fn();
    const source = structuredClone(createDemoWorkspace().sources[0]!);
    source.title = "梯度下降资料";
    source.deletedAt = "2026-09-14T00:00:00.000Z";
    props = {
      source,
      onClose,
      onPreview,
      onPurge,
      reviewKey: "review-1",
      contextKey: "owner-a:session-a:cache-a",
    };
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts with every independent document and conversation retained and requires the source name", async () => {
    await settleInitial();
    expect(onPreview).toHaveBeenCalledExactlyOnceWith(undefined, expect.any(AbortSignal));
    expect(
      [...host.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].map(
        (input) => input.checked,
      ),
    ).toEqual([false, false, false]);
    expect(host.querySelector("[aria-label='彻底删除影响预览']")!.textContent).toContain(
      "2 篇未选笔记或知识页会保留",
    );
    expect(host.textContent).toContain("正文可能同时包含其他资料");
    expect(host.textContent).toContain("提交成功不表示原件已经清理完毕");
    expect(button("彻底删除资料").disabled).toBe(true);
    await typeName();
    expect(button("彻底删除资料").disabled).toBe(false);
    expect(onPurge).not.toHaveBeenCalled();
  });

  it("requests selected whole content and displays only the matching server-derived impact", async () => {
    await settleInitial();
    await typeName();
    await click(checkbox("一并删除知识页「综合知识页」"));
    expect(onPreview.mock.calls[1]![0]).toEqual({ noteIds: ["knowledge-b"], conversationIds: [] });
    expect(confirmation().value).toBe("");
    await click(checkbox("一并删除对话「涉及其他资料的讨论」"));
    const selection = { noteIds: ["knowledge-b"], conversationIds: ["conversation-c"] };
    expect(onPreview.mock.calls[2]![0]).toEqual(selection);
    expect(host.querySelector("[aria-label='彻底删除影响预览']")!.textContent).toContain(
      "1 个已选完整对话，含 7 条消息",
    );
    expect(host.textContent).toContain("1 篇已选笔记或知识页，含当前与历史共 2 个版本");
    await typeName();
    await click(button("彻底删除资料"));
    expect(onPurge).toHaveBeenCalledExactlyOnceWith(serverPreview(selection));
  });

  it("disables deletion during selection checks and ignores an aborted older selection response", async () => {
    await settleInitial();
    await typeName();
    const earlier = deferred<SourcePurgePreview>();
    const latest = deferred<SourcePurgePreview>();
    onPreview
      .mockImplementationOnce(() => earlier.promise)
      .mockImplementationOnce(() => latest.promise);
    await click(checkbox("一并删除笔记「我的学习笔记」"));
    const oldSignal = onPreview.mock.calls[1]![1]!;
    expect(button("彻底删除资料").disabled).toBe(true);
    expect(confirmation().value).toBe("");
    expect(host.querySelector("[aria-label='彻底删除影响预览']")).toBeNull();
    await click(checkbox("一并删除对话「涉及其他资料的讨论」"));
    expect(oldSignal.aborted).toBe(true);
    const selection = { noteIds: ["note-a"], conversationIds: ["conversation-c"] };
    await act(async () => {
      latest.resolve(serverPreview(selection));
    });
    await typeName();
    await act(async () => {
      earlier.resolve(serverPreview({ noteIds: ["note-a"], conversationIds: [] }));
    });
    expect(checkbox("一并删除对话「涉及其他资料的讨论」").checked).toBe(true);
    expect(confirmation().value).toBe(props.source.title);
    await click(button("彻底删除资料"));
    expect(onPurge).toHaveBeenCalledExactlyOnceWith(serverPreview(selection));
  });

  it("does not reload for inline callbacks and uses the newest callback on the next user choice", async () => {
    await settleInitial();
    const newest = vi.fn(async (selection?: PermanentSourceDeletionSelection) =>
      serverPreview(selection),
    );
    props = { ...props, onPreview: newest };
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(newest).not.toHaveBeenCalled();
    await click(checkbox("一并删除笔记「我的学习笔记」"));
    expect(newest).toHaveBeenCalledExactlyOnceWith(
      { noteIds: ["note-a"], conversationIds: [] },
      expect.any(AbortSignal),
    );
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("invalidates a reviewed local change without silently refreshing and resets choices on explicit review", async () => {
    await settleInitial();
    await click(checkbox("一并删除知识页「综合知识页」"));
    await typeName();
    props = { ...props, reviewKey: "review-2" };
    await render();
    expect(onPreview).toHaveBeenCalledTimes(2);
    expect(button("彻底删除资料").disabled).toBe(true);
    expect(confirmation().value).toBe("");
    expect(host.textContent).toContain("原预览失效");
    await click(button("重新核对"));
    expect(onPreview.mock.calls[2]![0]).toBeUndefined();
    expect(checkbox("一并删除知识页「综合知识页」").checked).toBe(false);
    expect(host.textContent).toContain("已重置为全部保留");
    expect(button("彻底删除资料").disabled).toBe(true);
    await typeName();
    await click(button("彻底删除资料"));
    expect(onPurge).toHaveBeenCalledExactlyOnceWith(serverPreview());
  });

  it.each(["context", "source", "version", "review"] as const)(
    "rejects a late preview after %s identity drift",
    async (changed) => {
      const pending = deferred<SourcePurgePreview>();
      const initialPreview = serverPreview();
      onPreview.mockImplementationOnce(() => pending.promise);
      await settleInitial();
      const oldSignal = onPreview.mock.calls[0]![1]!;
      props =
        changed === "context"
          ? { ...props, contextKey: "owner-b:session-b:cache-b" }
          : changed === "source"
            ? { ...props, source: { ...props.source, id: "source-b" } }
            : changed === "version"
              ? { ...props, source: { ...props.source, versionId: "source-version-b" } }
              : { ...props, reviewKey: "review-b" };
      await render();
      expect(oldSignal.aborted).toBe(true);
      await act(async () => {
        pending.resolve(initialPreview);
      });
      expect(host.querySelector("[aria-label='彻底删除影响预览']")).toBeNull();
      expect(button("彻底删除资料").disabled).toBe(true);
      expect(onPurge).not.toHaveBeenCalled();
      expect(onPreview).toHaveBeenCalledOnce();
    },
  );

  it("does not revive an old reviewed preview or typed name after an identity changes back", async () => {
    await settleInitial();
    await typeName();
    const original = props;
    props = { ...props, reviewKey: "review-away" };
    await render();
    props = original;
    await render();
    expect(button("彻底删除资料").disabled).toBe(true);
    expect(host.querySelector("[aria-label='彻底删除影响预览']")).toBeNull();
    expect(confirmation().value).toBe("");
    expect(onPreview).toHaveBeenCalledOnce();
    await click(button("重新核对"));
    await typeName();
    await click(button("彻底删除资料"));
    expect(onPurge).toHaveBeenCalledOnce();
  });

  it("latches DELETE synchronously and prevents close while the operation remains in flight", async () => {
    await settleInitial();
    await typeName();
    const pending = deferred<void>();
    onPurge.mockImplementationOnce(() => pending.promise);
    const submit = button("彻底删除资料");
    const cancel = button("取消");
    await act(async () => {
      submit.click();
      submit.click();
      cancel.click();
    });
    expect(onPurge).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(button("取消").disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("button[aria-label=关闭]")!.disabled).toBe(true);
    await act(async () => {
      pending.resolve();
    });
    expect(button("取消").disabled).toBe(false);
  });

  it("keeps an error visible and requires a fresh preview plus name after failed DELETE", async () => {
    await settleInitial();
    await click(checkbox("一并删除笔记「我的学习笔记」"));
    await typeName();
    onPurge.mockRejectedValueOnce(new Error("云端范围已变化"));
    await click(button("彻底删除资料"));
    expect(host.textContent).toContain("云端范围已变化");
    expect(button("彻底删除资料").disabled).toBe(true);
    expect(confirmation().value).toBe("");
    expect(checkbox("一并删除笔记「我的学习笔记」").checked).toBe(true);
    await click(button("重新核对"));
    expect(checkbox("一并删除笔记「我的学习笔记」").checked).toBe(false);
    expect(button("彻底删除资料").disabled).toBe(true);
    await typeName();
    await click(button("彻底删除资料"));
    expect(onPurge).toHaveBeenCalledTimes(2);
    expect(onPurge.mock.calls[1]![0]).toEqual(serverPreview());
  });

  it("discards a late DELETE error after the context changes, including a change back", async () => {
    await settleInitial();
    await typeName();
    const pending = deferred<void>();
    onPurge.mockImplementationOnce(() => pending.promise);
    await click(button("彻底删除资料"));
    const original = props;
    props = { ...props, contextKey: "other-owner:other-token:other-cache" };
    await render();
    props = original;
    await render();
    await act(async () => {
      pending.reject(new Error("旧会话删除失败详情"));
    });
    expect(host.textContent).not.toContain("旧会话删除失败详情");
    expect(button("彻底删除资料").disabled).toBe(true);
    expect(confirmation().value).toBe("");
    expect(onPurge).toHaveBeenCalledOnce();
    await click(button("重新核对"));
    expect(onPreview).toHaveBeenCalledTimes(2);
  });

  it("retains recoverable choices on preview failure and explicitly resets them for a new review", async () => {
    await settleInitial();
    onPreview.mockRejectedValueOnce(new Error("暂时无法核对选择"));
    await click(checkbox("一并删除知识页「综合知识页」"));
    expect(host.textContent).toContain("暂时无法核对选择");
    expect(checkbox("一并删除知识页「综合知识页」").checked).toBe(true);
    expect(button("彻底删除资料").disabled).toBe(true);
    expect(host.querySelector("[aria-label='彻底删除影响预览']")).toBeNull();
    await click(button("重新核对"));
    expect(checkbox("一并删除知识页「综合知识页」").checked).toBe(false);
    expect(host.textContent).toContain("已重置为全部保留");
    expect(onPreview.mock.calls[2]![0]).toBeUndefined();
    expect(onPurge).not.toHaveBeenCalled();
  });

  it("fails closed when a server preview does not echo the chosen IDs", async () => {
    await settleInitial();
    onPreview.mockResolvedValueOnce(serverPreview());
    await click(checkbox("一并删除笔记「我的学习笔记」"));
    expect(host.textContent).toContain("云端返回的选择与本次核对不一致");
    expect(button("彻底删除资料").disabled).toBe(true);
    expect(onPurge).not.toHaveBeenCalled();
  });

  it("retains the old default DELETE without exposing content selection when the RPC is not deployed", async () => {
    const legacy = serverPreview();
    delete legacy.contentSelection;
    onPreview.mockResolvedValueOnce(legacy);
    await settleInitial();
    expect(host.querySelector("input[type=checkbox]")).toBeNull();
    expect(host.textContent).toContain("当前云端尚未提供独立内容选择清理");
    await typeName();
    await click(button("彻底删除资料"));
    expect(onPurge).toHaveBeenCalledExactlyOnceWith(legacy);
  });

  it("keeps authored annotation and manual relationship blockers ahead of final confirmation", async () => {
    const blocked = serverPreview();
    blocked.blockers = { annotations: ["annotation-body"], conceptRelations: ["manual-relation"] };
    onPreview.mockResolvedValueOnce(blocked);
    await settleInitial();
    expect(host.textContent).toContain("1 条带正文的批注和 1 条手工关系");
    expect(host.querySelector("input[aria-label='输入资料名称以确认彻底删除']")).toBeNull();
    expect(button("彻底删除资料").disabled).toBe(true);
    expect(onPurge).not.toHaveBeenCalled();
  });

  it("aborts preview on unmount and does not publish its delayed failure", async () => {
    const pending = deferred<SourcePurgePreview>();
    onPreview.mockImplementationOnce(() => pending.promise);
    await settleInitial();
    const signal = onPreview.mock.calls[0]![1]!;
    await act(async () => {
      root.unmount();
    });
    root = createRoot(host);
    expect(signal.aborted).toBe(true);
    await act(async () => {
      pending.reject(new Error("旧账号请求晚到失败"));
    });
    expect(host.textContent).toBe("");
    expect(onPurge).not.toHaveBeenCalled();
  });
});
