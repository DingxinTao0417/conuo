// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Space } from "@/lib/types";
import LearningSpaceNameInput from "./learning-space-name-input";

describe("learning space name draft", () => {
  let host: HTMLDivElement;
  let root: Root;
  let space: Space;
  let onRename: Mock<(name: string, expectedName: string) => boolean>;
  let onInvalid: Mock<() => void>;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    space = {
      id: "space-a",
      name: "机器学习",
      goal: "",
      archived: false,
      color: "#4b3fe3",
      createdAt: "2026-09-14T10:00:00.000Z",
    };
    onRename = vi.fn(() => true);
    onInvalid = vi.fn();
    await render();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(name = space.name) {
    space = { ...space, name };
    await act(async () =>
      root.render(createElement(LearningSpaceNameInput, { space, onRename, onInvalid })),
    );
  }

  const input = () => host.querySelector("input")!;

  async function edit(name: string) {
    await act(async () => {
      input().focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input(),
        name,
      );
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("follows a remote rename without writing the previous name back on blur", async () => {
    await act(async () => input().focus());
    await render("深度学习");
    expect(input().value).toBe("深度学习");
    await act(async () => input().blur());
    expect(onRename).not.toHaveBeenCalled();
  });

  it("preserves typed input across a remote rename and requires an explicit choice", async () => {
    await edit("我的学习笔记");
    await render("深度学习");
    expect(input().value).toBe("我的学习笔记");
    await act(async () => input().blur());
    expect(onRename).not.toHaveBeenCalled();
    expect(host.textContent).toContain("名称已更新为“深度学习”");
    const mine = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "采用我的名称",
    )!;
    await act(async () => mine.click());
    expect(onRename).toHaveBeenCalledWith("我的学习笔记", "深度学习");
  });

  it("allows retaining the latest name without committing the old draft", async () => {
    await edit("我的名称");
    await render("云端名称");
    const latest = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "使用最新名称",
    )!;
    await act(async () => latest.click());
    expect(input().value).toBe("云端名称");
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  });

  it("keeps rejected edits and protects the saved workspace from a temporary empty name", async () => {
    onRename.mockReturnValue(false);
    await edit("新名称");
    await act(async () => input().blur());
    expect(input().value).toBe("新名称");
    expect(onRename).toHaveBeenCalledWith("新名称", "机器学习");
    await edit("");
    await act(async () => input().blur());
    expect(input().value).toBe("机器学习");
    expect(onInvalid).toHaveBeenCalledOnce();
    expect(onRename).toHaveBeenCalledOnce();
  });
});
