// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CloudUpdateNotice, { type CloudUpdateNoticeProps } from "./cloud-update-notice";

describe("cloud update notice", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: CloudUpdateNoticeProps;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    props = {
      revision: null,
      checking: false,
      loading: false,
      error: "",
      onLoad: vi.fn(),
      onCheck: vi.fn(),
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(patch: Partial<CloudUpdateNoticeProps> = {}) {
    props = { ...props, ...patch };
    await act(async () => root.render(createElement(CloudUpdateNotice, props)));
  }

  it("keeps routine checks quiet and only offers loading after an update is detected", async () => {
    await render({ checking: true });
    expect(host.textContent).toBe("");
    await render({ checking: false, revision: 7 });
    expect(host.textContent).toContain("当前页面内容已保留");
    await act(async () => host.querySelector("button")!.click());
    expect(props.onLoad).toHaveBeenCalledOnce();
    expect(props.onCheck).not.toHaveBeenCalled();
  });

  it("allows a failed check to be retried without offering an unproven cloud version", async () => {
    await render({ error: "连接超时，当前页面内容仍保留。" });
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain("新的工作区版本");
    await act(async () => host.querySelector("button")!.click());
    expect(props.onCheck).toHaveBeenCalledOnce();
    expect(props.onLoad).not.toHaveBeenCalled();
    await render({ checking: true });
    await act(async () => host.querySelector("button")!.click());
    expect(props.onCheck).toHaveBeenCalledOnce();
  });

  it("preserves the detected update and error while blocking repeated loads in flight", async () => {
    await render({ revision: 8, loading: true, error: "上次载入未完成，修改仍在当前页面。" });
    expect(host.textContent).toContain("上次载入未完成");
    expect(host.textContent).toContain("正在载入更新");
    expect(host.querySelector("section")?.getAttribute("aria-busy")).toBe("true");
    await act(async () => host.querySelector("button")!.click());
    expect(props.onLoad).not.toHaveBeenCalled();
  });
});
