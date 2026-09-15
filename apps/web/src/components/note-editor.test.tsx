// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeEditor = {
  isDestroyed: boolean;
  getHTML: () => string;
  commands: { setContent: ReturnType<typeof vi.fn> };
  state: { doc: unknown; selection: unknown; plugins: unknown[] };
  view: { updateState: ReturnType<typeof vi.fn> };
  isActive: () => boolean;
  chain: () => Record<string, unknown>;
};

type UpdateHandler = (payload: { editor: FakeEditor }) => void;

const tiptap = vi.hoisted(() => ({
  html: "",
  initialized: false,
  onUpdate: undefined as UpdateHandler | undefined,
  editor: undefined as FakeEditor | undefined,
}));

vi.mock("@tiptap/react", async () => {
  const React = await import("react");
  const chain = new Proxy<Record<string, unknown>>(
    {},
    {
      get: (_, key) => (key === "run" ? () => true : () => chain),
    },
  );
  const editor: FakeEditor = {
    isDestroyed: false,
    getHTML: () => tiptap.html,
    commands: {
      setContent: vi.fn((content: string) => {
        tiptap.html = content;
        return true;
      }),
    },
    state: { doc: {}, selection: {}, plugins: [] },
    view: { updateState: vi.fn() },
    isActive: () => false,
    chain: () => chain,
  };
  tiptap.editor = editor;
  return {
    useEditor: (options: { content: string; onUpdate: UpdateHandler }) => {
      if (!tiptap.initialized) {
        tiptap.html = options.content;
        tiptap.initialized = true;
      }
      tiptap.onUpdate = options.onUpdate;
      return editor;
    },
    EditorContent: () => React.createElement("div", { className: "note-content" }),
  };
});

vi.mock("@tiptap/pm/state", () => ({
  EditorState: { create: vi.fn((config: unknown) => config) },
}));

import NoteEditor from "./note-editor";

describe("NoteEditor controlled content", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    tiptap.html = "";
    tiptap.initialized = false;
    tiptap.onUpdate = undefined;
    tiptap.editor?.commands.setContent.mockClear();
    tiptap.editor?.view.updateState.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("applies a chosen cloud copy to the mounted editor without saving it as a new edit", async () => {
    const onChange = vi.fn();
    const local = "<p>本机未同步正文</p>";
    const remote = "<p>云端确认正文</p>";
    await act(async () => {
      root.render(createElement(NoteEditor, { content: local, onChange }));
    });
    expect(tiptap.html).toBe(local);

    await act(async () => {
      root.render(createElement(NoteEditor, { content: remote, onChange }));
    });

    expect(tiptap.editor?.commands.setContent).toHaveBeenCalledWith(remote, {
      emitUpdate: false,
    });
    expect(tiptap.html).toBe(remote);
    expect(onChange).not.toHaveBeenCalled();

    const continued = `${remote}<p>继续补充</p>`;
    tiptap.html = continued;
    await act(async () => tiptap.onUpdate?.({ editor: tiptap.editor! }));
    expect(onChange).toHaveBeenLastCalledWith(continued);
    expect(continued).not.toContain("本机未同步正文");

    await act(async () => {
      root.render(createElement(NoteEditor, { content: continued, onChange }));
    });
    expect(tiptap.editor?.commands.setContent).toHaveBeenCalledTimes(1);
  });

  it("preserves structured HTML from a manual merge without emitting a sync echo", async () => {
    const onChange = vi.fn();
    const merged = "<p>合并后的解释</p><ul><li><p>保留的要点</p></li></ul>";
    await act(async () => {
      root.render(
        createElement(NoteEditor, {
          content: "<p>本机正文</p>",
          onChange,
        }),
      );
    });

    await act(async () => {
      root.render(createElement(NoteEditor, { content: merged, onChange }));
    });

    expect(tiptap.html).toBe(merged);
    expect(tiptap.editor?.commands.setContent).toHaveBeenLastCalledWith(merged, {
      emitUpdate: false,
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps common mobile actions visible and closes the expanded menu after choosing a format", async () => {
    await act(async () => {
      root.render(
        createElement(NoteEditor, {
          content: "<p>移动端笔记</p>",
          onChange: vi.fn(),
        }),
      );
    });

    const mobileToolbar = host.querySelector<HTMLElement>(".editor-toolbar-mobile")!;
    const primaryLabels = [...mobileToolbar.querySelectorAll(":scope > button")].map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(primaryLabels).toEqual(["粗体", "斜体", "无序列表", "撤销"]);
    const more = mobileToolbar.querySelector<HTMLDetailsElement>(".editor-toolbar-more")!;
    const menuLabels = [...more.querySelectorAll<HTMLButtonElement>("button")].map((button) =>
      button.textContent?.trim(),
    );
    expect(menuLabels).toEqual(["二级标题", "有序列表", "代码块", "插入表格", "添加链接", "重做"]);

    more.setAttribute("open", "");
    const link = [...more.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "添加链接",
    )!;
    await act(async () => link.click());

    expect(more.hasAttribute("open")).toBe(false);
    expect(host.querySelector('input[aria-label="链接网址"]')).toBeInstanceOf(HTMLInputElement);
  });
});
