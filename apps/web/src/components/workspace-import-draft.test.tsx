// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportModal } from "./workspace/modals/import-modal";

type Props = ComponentProps<typeof ImportModal>;

describe("Web import draft protection", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: Props;
  let previousShowModal: PropertyDescriptor | undefined;
  let previousClose: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Isolated: extraction unavailable")),
    );
    previousShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
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
    props = {
      storageMode: "cloud",
      cloudUserId: "draft-account",
      spaceId: "",
      sources: [],
      jobs: [],
      saveState: "local",
      spaces: [
        {
          id: "new-target",
          name: "学习方法",
          goal: "",
          color: "#555",
          archived: false,
          createdAt: "2026-09-21T00:00:00Z",
        },
      ],
      onWebImport: vi.fn(),
      onImportFile: vi.fn(),
      onRetryImport: vi.fn(),
      onCancelImport: vi.fn(),
      onClose: vi.fn(),
      onOpen: vi.fn(),
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    if (previousShowModal)
      Object.defineProperty(HTMLDialogElement.prototype, "showModal", previousShowModal);
    else delete (HTMLDialogElement.prototype as { showModal?: () => void }).showModal;
    if (previousClose) Object.defineProperty(HTMLDialogElement.prototype, "close", previousClose);
    else delete (HTMLDialogElement.prototype as { close?: () => void }).close;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function render() {
    await act(async () => root.render(createElement(ImportModal, props)));
  }
  function button(text: string) {
    return [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
  }
  async function click(text: string) {
    await act(async () => button(text).click());
  }
  function input(label: string) {
    return [...host.querySelectorAll("label")]
      .find((l) => l.textContent?.trim().startsWith(label))!
      .querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")!;
  }
  async function type(label: string, value: string) {
    const control = input(label);
    await act(async () => {
      const proto =
        control instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(control, value);
      control.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function draft() {
    await render();
    await click("保存网页");
    await click("手动粘贴");
    await type("网页地址", "https://example.org/reading");
    await type("标题", "尚未保存的文章");
    await type("手动粘贴的正文", "这里是用户认真整理的文字。");
  }

  it("retains the real form through destination changes, AI opt-out and switching tabs", async () => {
    await draft();
    await act(async () => {
      const target = host.querySelector("select")!;
      target.value = "new-target";
      target.dispatchEvent(new Event("change", { bubbles: true }));
      host.querySelector<HTMLInputElement>('[aria-label="允许 AI 使用本次导入的资料"]')!.click();
    });
    await click("上传文件");
    await click("保存网页");
    expect(input("标题").value).toBe("尚未保存的文章");
    expect(input("手动粘贴的正文").value).toBe("这里是用户认真整理的文字。");
    await act(async () =>
      host.querySelector<HTMLInputElement>('[aria-label="允许 AI 使用本次导入的资料"]')!.click(),
    );
    await click("保存粘贴正文");
    expect(props.onWebImport).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceIds: ["new-target"],
        aiAllowed: false,
        title: "尚未保存的文章",
      }),
    );
    await click("完成");
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it.each(["close", "escape", "done"])(
    "asks before %s and preserves text when editing continues",
    async (method) => {
      await draft();
      await act(async () => {
        if (method === "escape")
          host.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
        else if (method === "close")
          host.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click();
        else button("完成").click();
      });
      expect(props.onClose).not.toHaveBeenCalled();
      expect(host.textContent).toContain("放弃未保存的网页草稿？");
      await click("继续编辑");
      expect(input("手动粘贴的正文").value).toBe("这里是用户认真整理的文字。");
      await click("完成");
      await click("放弃草稿并离开");
      expect(props.onClose).toHaveBeenCalledOnce();
      expect(props.onWebImport).not.toHaveBeenCalled();
    },
  );

  it("locks closing, destination changes and replay while a save promise is unresolved", async () => {
    let resolve!: () => void;
    props.onWebImport = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    await draft();
    await click("保存粘贴正文");
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')?.disabled).toBe(true);
    expect(host.querySelector("select")?.disabled).toBe(true);
    expect(button("上传文件").disabled).toBe(true);
    await act(async () =>
      host.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })),
    );
    await click("保存粘贴正文");
    expect(props.onWebImport).toHaveBeenCalledOnce();
    expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => resolve());
    await click("完成");
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});
