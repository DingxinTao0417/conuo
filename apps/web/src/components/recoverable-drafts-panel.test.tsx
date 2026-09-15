// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RecoverableDraftsPanel, {
  type RecoverableDraftItem,
  type RecoverableDraftsPanelProps,
} from "./recoverable-drafts-panel";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const drafts: RecoverableDraftItem[] = [
  {
    id: "draft-annotation",
    sourceId: "source-learning",
    title: "费曼学习法补充",
    content: "先不用术语解释，再定位自己说不清的部分。",
    sourceTitle: "高效学习方法",
    sourceDeletedAt: "2026-09-14T08:00:00.000Z",
    kind: "annotation",
    excerpt: "如果不能简单地解释，就还没有真正理解。",
    location: "第 12 页",
    updatedAt: "2026-09-14T08:30:00.000Z",
  },
  {
    id: "draft-note",
    sourceId: "source-memory",
    title: "间隔复习安排",
    content: "第一次复习放到第二天。",
    sourceTitle: "记忆心理学",
    sourceDeletedAt: "2026-09-14T08:45:00.000Z",
    kind: "note",
    updatedAt: "2026-09-14T09:00:00.000Z",
  },
];

describe("RecoverableDraftsPanel", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: RecoverableDraftsPanelProps;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    props = {
      drafts,
      onRestoreSource: vi.fn(),
      onSaveAsNote: vi.fn(),
      onDiscard: vi.fn(),
      onCopy: vi.fn(),
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(next: Partial<RecoverableDraftsPanelProps> = {}) {
    props = { ...props, ...next };
    await act(async () => root.render(createElement(RecoverableDraftsPanel, props)));
  }

  function button(text: string) {
    const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === text,
    );
    expect(found, text).toBeTruthy();
    return found!;
  }

  async function click(text: string) {
    await act(async () => button(text).click());
  }

  it("renders a selectable list and a complete, source-aware preview", async () => {
    await render();

    const list = host.querySelector('[aria-label="可恢复草稿列表"]');
    expect(list).toBeTruthy();
    expect(list?.querySelectorAll("li")).toHaveLength(2);
    expect(host.textContent).toContain("资料在其他设备被删除时");
    expect(host.textContent).toContain("费曼学习法补充");
    expect(host.textContent).toContain("如果不能简单地解释");
    expect(host.textContent).toContain("第 12 页");
    expect(host.textContent).toContain("不会让资料自动恢复");
    expect(host.textContent).toContain("原资料仍在回收站");

    const first = list?.querySelector<HTMLButtonElement>('button[aria-current="true"]');
    expect(first?.getAttribute("aria-controls")).toBe(
      host.querySelector(".recoverable-drafts__preview")?.id,
    );

    await act(async () => [...list!.querySelectorAll<HTMLButtonElement>("button")][1].click());
    expect(host.querySelector(".recoverable-drafts__preview h3")?.textContent).toBe("间隔复习安排");
    expect(host.textContent).toContain("第一次复习放到第二天");
    expect(list?.querySelectorAll('button[aria-current="true"]')).toHaveLength(1);
  });

  it("copies only the recovered writing and announces success", async () => {
    await render();
    await click("复制文字");

    expect(props.onCopy).toHaveBeenCalledExactlyOnceWith(drafts[0].content, drafts[0]);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("草稿文字已复制");
  });

  it("keeps preview and copy available in read-only recovery mode", async () => {
    await render({ readOnly: true });

    expect(button("保存为新笔记").disabled).toBe(true);
    expect(button("恢复整份资料").disabled).toBe(true);
    expect(button("丢弃草稿").disabled).toBe(true);
    expect(button("复制文字").disabled).toBe(false);
    await click("复制文字");
    expect(props.onCopy).toHaveBeenCalledExactlyOnceWith(drafts[0].content, drafts[0]);
  });

  it("restores the whole source through a separate, explicit action", async () => {
    await render();
    const restore = button("恢复整份资料");
    expect(restore.title).toContain("不是只取回当前草稿");

    await act(async () => restore.click());
    expect(props.onRestoreSource).toHaveBeenCalledExactlyOnceWith(drafts[0]);
    expect(props.onSaveAsNote).not.toHaveBeenCalled();
    expect(props.onDiscard).not.toHaveBeenCalled();
  });

  it("saves the selected draft as a new note and prevents duplicate submissions", async () => {
    const saving = deferred<void>();
    await render({ onSaveAsNote: vi.fn(() => saving.promise) });

    await act(async () => {
      button("保存为新笔记").click();
      button("保存为新笔记").click();
    });
    expect(props.onSaveAsNote).toHaveBeenCalledExactlyOnceWith(drafts[0]);
    expect(host.querySelector(".recoverable-drafts")?.getAttribute("aria-busy")).toBe("true");
    expect(button("正在保存…").disabled).toBe(true);

    await act(async () => saving.resolve());
    expect(host.querySelector('[role="status"]')?.textContent).toContain("已保存为新笔记");
    expect(host.querySelector(".recoverable-drafts")?.getAttribute("aria-busy")).toBe("false");
  });

  it("requires an explicit second step before discarding", async () => {
    await render();
    await click("丢弃草稿");

    expect(props.onDiscard).not.toHaveBeenCalled();
    expect(host.textContent).toContain("丢弃后无法从回收站恢复");
    await click("取消");
    expect(button("丢弃草稿")).toBeTruthy();

    await click("丢弃草稿");
    await click("确认丢弃");
    expect(props.onDiscard).toHaveBeenCalledExactlyOnceWith(drafts[0]);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("草稿已丢弃");
  });

  it("keeps a failed action retryable and exposes its error accessibly", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("本机草稿尚未保存"))
      .mockResolvedValueOnce(undefined);
    await render({ onSaveAsNote: save });

    await click("保存为新笔记");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("本机草稿尚未保存");
    expect(button("保存为新笔记").disabled).toBe(false);

    await click("保存为新笔记");
    expect(save.mock.calls).toEqual([[drafts[0]], [drafts[0]]]);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("已保存为新笔记");
  });

  it("falls back to the first remaining draft and supports a quiet empty state", async () => {
    await render();
    const items = host.querySelectorAll<HTMLButtonElement>(".recoverable-drafts__item");
    await act(async () => items[1].click());
    expect(host.querySelector(".recoverable-drafts__preview h3")?.textContent).toBe("间隔复习安排");

    await render({ drafts: [drafts[0]] });
    expect(host.querySelector(".recoverable-drafts__preview h3")?.textContent).toBe(
      "费曼学习法补充",
    );

    await render({ drafts: [] });
    expect(host.textContent).toContain("没有待处理的草稿");
    expect(host.querySelector(".recoverable-drafts__preview")).toBeNull();
    expect(host.querySelector("[aria-busy]")?.getAttribute("aria-busy")).toBe("false");
  });

  it("collapses long recovered writing until the user expands it", async () => {
    const longDraft = {
      ...drafts[0],
      content: "这是一段离线补充。".repeat(45),
    };
    await render({ drafts: [longDraft] });

    const content = host.querySelector(".recoverable-drafts__content p");
    expect(content?.classList.contains("is-collapsed")).toBe(true);
    const expand = button("展开完整草稿");
    expect(expand.getAttribute("aria-expanded")).toBe("false");

    await act(async () => expand.click());
    expect(content?.classList.contains("is-collapsed")).toBe(false);
    expect(button("收起长草稿").getAttribute("aria-expanded")).toBe("true");
  });
});
