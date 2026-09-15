// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NoteEditor from "./note-editor";

describe("NoteEditor with Tiptap", () => {
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

  it("replaces the live ProseMirror document when the parent supplies a conflict result", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        createElement(NoteEditor, {
          content: "<p>本机旧正文</p>",
          onChange,
        }),
      );
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const document = host.querySelector<HTMLElement>('[aria-label="笔记正文"]')!;
    expect(document.innerHTML).toContain("本机旧正文");

    await act(async () => {
      root.render(
        createElement(NoteEditor, {
          content: "<p>手动合并正文</p><ul><li><p>云端要点</p></li></ul>",
          onChange,
        }),
      );
    });

    expect(document.innerHTML).not.toContain("本机旧正文");
    expect(document.innerHTML).toContain("手动合并正文");
    expect(document.querySelector("ul li")?.textContent).toBe("云端要点");
    expect(onChange).not.toHaveBeenCalled();

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="撤销"]')!.click();
    });

    expect(document.innerHTML).not.toContain("本机旧正文");
    expect(document.innerHTML).toContain("手动合并正文");
    expect(onChange).not.toHaveBeenCalled();
  });
});
