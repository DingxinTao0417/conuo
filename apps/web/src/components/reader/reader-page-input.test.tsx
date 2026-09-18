// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReaderPageInput, { type ReaderPageInputProps } from "./reader-page-input";

describe("ReaderPageInput", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: ReaderPageInputProps;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    props = { page: 12, pages: 48, sourceKey: "source-a:version-one", onCommit: vi.fn() };
    await render();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(overrides: Partial<ReaderPageInputProps> = {}) {
    props = { ...props, ...overrides };
    await act(async () => root.render(createElement(ReaderPageInput, props)));
  }

  function input() {
    return host.querySelector<HTMLInputElement>('input[aria-label="跳转页码"]')!;
  }

  async function edit(value: string) {
    await act(async () => {
      input().focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input(),
        value,
      );
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function press(key: string, isComposing = false) {
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key, isComposing }));
    });
  }

  async function blur() {
    await act(async () => input().blur());
  }

  it("commits the complete page number on Enter instead of navigating for each digit", async () => {
    await edit("");
    await edit("3");
    await edit("30");
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(input().value).toBe("30");

    await press("Enter");
    expect(props.onCommit).toHaveBeenCalledExactlyOnceWith(30);
    await render({ page: 30 });
    await blur();
    expect(props.onCommit).toHaveBeenCalledTimes(1);
    expect(input().value).toBe("30");
  });

  it("commits a valid edited page on blur", async () => {
    await edit("8");
    await blur();
    expect(props.onCommit).toHaveBeenCalledExactlyOnceWith(8);
  });

  it("does not record navigation merely for focusing then leaving the field", async () => {
    await act(async () => input().focus());
    await blur();
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it("preserves a draft while continuous scrolling changes the visible page", async () => {
    await edit("30");
    await render({ page: 15 });
    expect(input().value).toBe("30");
    await press("Enter");
    expect(props.onCommit).toHaveBeenCalledExactlyOnceWith(30);
  });

  it("Escape restores the latest visible page and cancels a later blur commit", async () => {
    await edit("30");
    await render({ page: 15 });
    await press("Escape");
    expect(input().value).toBe("15");
    await blur();
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it.each(["", "0", "-2", "1.5", "1e2", "abc", "NaN", "9007199254740992"])(
    "rejects the invalid draft %j without navigating",
    async (draft) => {
      await edit(draft);
      await press("Enter");
      await blur();
      expect(input().value).toBe("12");
      expect(props.onCommit).not.toHaveBeenCalled();
    },
  );

  it("discards an invalid draft on blur", async () => {
    await edit("2.5");
    await blur();
    expect(input().value).toBe("12");
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it("clamps a valid positive integer to the current document page count", async () => {
    await edit("99");
    await render({ pages: 24 });
    await press("Enter");
    expect(props.onCommit).toHaveBeenCalledExactlyOnceWith(24);
  });

  it("allows an explicit same-page Enter to return to the page heading", async () => {
    await press("Enter");
    expect(props.onCommit).toHaveBeenCalledExactlyOnceWith(12);
  });

  it.each(["source-b:version-one", "source-a:version-two"])(
    "discards an old draft when the document identity changes to %s",
    async (sourceKey) => {
      const previous = input();
      await edit("30");
      await render({ sourceKey, page: 5 });
      expect(input()).not.toBe(previous);
      expect(input().value).toBe("5");
      await blur();
      expect(props.onCommit).not.toHaveBeenCalled();
    },
  );

  it("discards a pending jump when parsed text disables physical page navigation", async () => {
    await edit("30");
    await render({ disabled: true });
    expect(input().disabled).toBe(true);
    expect(input().value).toBe("12");
    await press("Enter");
    expect(props.onCommit).not.toHaveBeenCalled();
    await render({ disabled: false, page: 8 });
    expect(input().value).toBe("8");
  });

  it("does not treat a composition confirmation as navigation", async () => {
    await edit("30");
    await press("Enter", true);
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(input().value).toBe("30");
  });

  it("offers a numeric keyboard and announces the commit and cancel controls", () => {
    expect(input().type).toBe("text");
    expect(input().inputMode).toBe("numeric");
    expect(input().getAttribute("enterkeyhint")).toBe("go");
    const description = document.getElementById(input().getAttribute("aria-describedby")!);
    expect(description?.textContent).toContain("Enter");
    expect(description?.textContent).toContain("Esc");
    expect(input().title).toContain("共 48 页");
  });
});
