// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Modal from "./modal";

describe("modal accessibility", () => {
  let host: HTMLDivElement;
  let root: Root;
  let previousShow: PropertyDescriptor | undefined;
  let previousClose: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    previousShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
    previousClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
    // jsdom has no native top layer or dialog focus restoration. Move focus on open,
    // but leave close restoration to the component; browser behavior is checked separately.
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true;
        this.querySelector<HTMLButtonElement>("button")?.focus();
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      writable: true,
      value(this: HTMLDialogElement) {
        this.open = false;
      },
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
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

  it("labels simultaneous dialogs with their own visible title and keeps the name current", async () => {
    const render = async (confirmationTitle: string) => {
      await act(async () =>
        root.render(
          <>
            <Modal title="添加资料" onClose={vi.fn()}>
              <p>网页正文与其他内容不能代替弹窗名称。</p>
            </Modal>
            <Modal title={confirmationTitle} onClose={vi.fn()}>
              <button>继续编辑</button>
            </Modal>
          </>,
        ),
      );
    };
    await render("放弃尚未保存的输入？");
    const dialogs = [...host.querySelectorAll<HTMLDialogElement>("dialog[open]")];
    expect(dialogs).toHaveLength(2);
    const titleIds = dialogs.map((dialog) => dialog.getAttribute("aria-labelledby"));
    expect(titleIds.every(Boolean)).toBe(true);
    expect(new Set(titleIds).size).toBe(2);
    const titles = titleIds.map((id, index) => {
      const title = document.getElementById(id!);
      expect(title).toBe(dialogs[index].querySelector("h2"));
      return title;
    });
    expect(titles.map((title) => title?.textContent)).toEqual(["添加资料", "放弃尚未保存的输入？"]);

    await render("放弃手动合并草稿？");
    expect(dialogs.map((dialog) => dialog.getAttribute("aria-labelledby"))).toEqual(titleIds);
    expect(titles[0]?.textContent).toBe("添加资料");
    expect(titles[1]?.textContent).toBe("放弃手动合并草稿？");
  });

  async function renderFlow({
    open = false,
    confirmation = false,
    trigger = true,
    dismissible = true,
    onClose = vi.fn(),
  } = {}) {
    await act(async () =>
      root.render(
        <>
          {trigger && <button id="open-import">导入资料</button>}
          <button id="next-page">新页面操作</button>
          {open && (
            <Modal title="添加资料" onClose={onClose} dismissible={dismissible}>
              <button id="open-confirmation">放弃输入</button>
            </Modal>
          )}
          {confirmation && (
            <Modal title="放弃尚未保存的输入？" onClose={vi.fn()}>
              <button>继续编辑</button>
            </Modal>
          )}
        </>,
      ),
    );
  }

  it("closes before its DOM is removed and restores the opening control", async () => {
    await renderFlow();
    const trigger = document.getElementById("open-import")!;
    trigger.focus();
    await renderFlow({ open: true });
    const dialog = host.querySelector("dialog")!;
    expect(dialog.contains(document.activeElement)).toBe(true);
    const connectedAtClose: boolean[] = [];
    dialog.close = () => {
      connectedAtClose.push(dialog.isConnected);
      dialog.open = false;
    };
    await renderFlow();
    expect(connectedAtClose).toEqual([true]);
    expect(document.activeElement).toBe(trigger);
  });

  it("returns from confirmation to its parent, or to the entry when both dialogs close", async () => {
    await renderFlow();
    const trigger = document.getElementById("open-import")!;
    trigger.focus();
    await renderFlow({ open: true });
    const confirmationTrigger = document.getElementById("open-confirmation")!;
    confirmationTrigger.focus();
    await renderFlow({ open: true, confirmation: true });
    await renderFlow({ open: true });
    expect(document.activeElement).toBe(confirmationTrigger);

    await renderFlow({ open: true, confirmation: true });
    await renderFlow();
    expect(host.querySelector("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not steal focus already moved to another control", async () => {
    await renderFlow();
    document.getElementById("open-import")!.focus();
    await renderFlow({ open: true });
    const nextPage = document.getElementById("next-page")!;
    nextPage.focus();
    await renderFlow();
    expect(document.activeElement).toBe(nextPage);
  });

  it("does not restore a trigger removed by navigation", async () => {
    await renderFlow();
    const trigger = document.getElementById("open-import")!;
    trigger.focus();
    await renderFlow({ open: true });
    const focus = vi.spyOn(trigger, "focus");
    await renderFlow({ trigger: false });
    expect(trigger.isConnected).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it("respects a focus destination already assigned while the dialog closes", async () => {
    await renderFlow();
    document.getElementById("open-import")!.focus();
    await renderFlow({ open: true });
    const dialog = host.querySelector("dialog")!;
    const nextPage = document.getElementById("next-page")!;
    dialog.close = () => {
      dialog.open = false;
      nextPage.focus();
    };
    await renderFlow();
    expect(document.activeElement).toBe(nextPage);
  });

  it("keeps busy dialogs open for Escape and the disabled close control", async () => {
    const onClose = vi.fn();
    await renderFlow({ open: true, dismissible: false, onClose });
    const dialog = host.querySelector("dialog")!;
    const close = dialog.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!;
    const cancel = new Event("cancel", { cancelable: true });
    await act(async () => {
      dialog.dispatchEvent(cancel);
      close.click();
    });
    expect(cancel.defaultPrevented).toBe(true);
    expect(close.disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);
  });
});
