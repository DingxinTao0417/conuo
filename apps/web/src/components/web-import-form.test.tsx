// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebImportForm, { type WebImportFormProps } from "./web-import-form";
import type { Source } from "@/lib/types";
import type { WebPreview } from "@/lib/web-import";
import { makeCapturedWebSource } from "@/lib/web-import";

vi.mock("@/lib/local-store", () => ({ putBlob: vi.fn(), getBlob: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
const firstUrl = "https://example.org/first#reading";
const secondUrl = "https://example.org/second";
const makePreview = (url = firstUrl, title = "提取的学习资料"): WebPreview => ({
  originalUrl: url,
  finalUrl: url,
  title,
  text: "学习率控制更新步长。\n\n更新过大时可能产生振荡。",
  excerpt: "学习率控制更新步长。",
  capturedAt: "2026-09-12T12:00:00.000Z",
  kind: "article",
  warnings: ["只包含本次提取的正文。"],
});

interface PendingRequest {
  input: RequestInfo | URL;
  init: RequestInit;
  response: ReturnType<typeof deferred<Response>>;
}

describe("WebImportForm request and save boundaries", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let props: WebImportFormProps;
  let capability: { available: boolean; reason?: string };
  let requests: PendingRequest[];
  let fetchMock: ReturnType<
    typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>
  >;
  let onImport: ReturnType<typeof vi.fn<(source: Source) => void | Promise<void>>>;
  let onSaved: ReturnType<typeof vi.fn<(source: Source) => void>>;
  let onBusyChange: ReturnType<typeof vi.fn<(busy: boolean) => void>>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    onImport = vi.fn();
    onSaved = vi.fn();
    onBusyChange = vi.fn();
    props = {
      targetSpaceId: "space-one",
      cloudUserId: "account-one",
      onImport,
      onSaved,
      onBusyChange,
    };
    capability = { available: true };
    requests = [];
    fetchMock = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      if (input !== "/api/v1/web/preview")
        throw new Error(`Unexpected fetch target: ${String(input)}`);
      if (init.method === "GET") return Promise.resolve(json(capability));
      const response = deferred<Response>();
      requests.push({ input, init, response });
      // Deliberately ignore cancellation: a late response must still be rejected by the UI.
      return response.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    if (root)
      await act(async () => {
        root!.unmount();
        root = null;
      });
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function render(next: Partial<WebImportFormProps> = {}) {
    props = { ...props, ...next };
    await act(async () => {
      root!.render(createElement(WebImportForm, props));
    });
  }
  function button(name: string): HTMLButtonElement {
    const found = [...container.querySelectorAll("button")].filter(
      (item) => item.textContent?.replace(/\s+/g, "").trim() === name.replace(/\s+/g, ""),
    );
    expect(found, `button ${name}`).toHaveLength(1);
    return found[0];
  }
  function field(label: string): HTMLInputElement | HTMLTextAreaElement {
    const found = [...container.querySelectorAll("label")].filter((item) =>
      item.textContent?.replace(/\s+/g, "").startsWith(label.replace(/\s+/g, "")),
    );
    expect(found, `label ${label}`).toHaveLength(1);
    const control = found[0].querySelector("input,textarea");
    expect(control).toBeTruthy();
    return control as HTMLInputElement | HTMLTextAreaElement;
  }
  async function type(label: string, value: string) {
    await act(async () => {
      const control = field(label);
      const prototype =
        control instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      // Bypass React's own value tracker, just as a native input edit would.
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, value);
      control.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function click(name: string) {
    const control = button(name);
    expect(control.disabled, `${name} should be usable`).toBe(false);
    await act(async () => {
      control.click();
    });
  }
  function displayedPreview() {
    return container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="应用内学习阅读版全文（只读纯文本）"]',
    );
  }
  function originLink() {
    return container.querySelector<HTMLAnchorElement>('a[aria-label="打开原站（新标签页）"]');
  }
  async function begin(url = firstUrl) {
    await type("网页地址", url);
    await click("提取预览");
    const request = requests.at(-1)!;
    expect(request.init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(String(request.init.body))).toEqual({ url });
    expect(request.init.signal?.aborted).toBe(false);
    return request;
  }
  async function respond(request: PendingRequest, preview: unknown = makePreview()) {
    await act(async () => {
      request.response.resolve(json(preview));
    });
  }
  async function readyPreview() {
    await render();
    const request = await begin();
    await respond(request);
    expect(displayedPreview()?.value).toBe(makePreview().text);
    expect(container.querySelector('[aria-label="应用内学习阅读版（只读纯文本）"]')).not.toBeNull();
    expect(container.textContent).toContain("应用内学习阅读版（只读纯文本）");
    return request;
  }

  it("only checks its same-origin capability endpoint until extraction is explicitly requested", async () => {
    await render();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/web/preview");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "GET", credentials: "same-origin" });
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("X-Conuo-User")).toBe(
      "account-one",
    );
    await type("网页地址", firstUrl);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(0);
    expect(onImport).not.toHaveBeenCalled();
    expect(onBusyChange).not.toHaveBeenCalled();
  });

  it("shows a safe new-tab origin link only for a normalized URL without invoking import work", async () => {
    await render();
    expect(originLink()).toBeNull();

    await type("网页地址", "not a valid URL");
    expect(originLink()).toBeNull();

    await type("网页地址", firstUrl);
    const link = originLink();
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe(firstUrl);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");

    link!.addEventListener("click", (event) => event.preventDefault(), { once: true });
    await act(async () => {
      link!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(0);
    expect(onImport).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onBusyChange).not.toHaveBeenCalled();
  });

  it("keeps manual saving usable without extraction configuration or login", async () => {
    capability = { available: false, reason: "网页提取尚未启用" };
    await render({ cloudUserId: undefined });
    await type("网页地址", firstUrl);
    expect(button("提取预览").disabled).toBe(true);
    await click("手动粘贴");
    await type("标题", "用户手动记录");
    await type("手动粘贴的正文", "手动核对的学习率资料。");
    await click("保存粘贴正文");
    expect(onImport).toHaveBeenCalledTimes(1);
    const source = onImport.mock.calls[0][0];
    expect(source).toMatchObject({
      title: "用户手动记录",
      text: "手动核对的学习率资料。",
      status: "ready",
      spaceIds: ["space-one"],
      aiAllowed: false,
      webSnapshot: { method: "manual", scope: "pasted", originalUrl: firstUrl },
    });
    expect(source.chunks.length).toBeGreaterThan(0);
    expect(onSaved).toHaveBeenCalledWith(source);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(0);
    expect(onBusyChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain("请留意工作台保存状态");
  });

  it("does not overwrite a newer preview when an older URL request eventually resolves", async () => {
    await render();
    const first = await begin();
    await type("网页地址", secondUrl);
    expect(first.init.signal?.aborted).toBe(true);
    expect(displayedPreview()).toBeNull();
    const second = await begin(secondUrl);
    await respond(second, makePreview(secondUrl, "新网址资料"));
    await respond(first);
    expect(field("保存标题").value).toBe("新网址资料");
    expect(onImport).not.toHaveBeenCalled();
    await click("保存提取正文");
    expect(onImport.mock.calls[0][0]).toMatchObject({
      url: secondUrl,
      title: "新网址资料",
      webSnapshot: { originalUrl: secondUrl },
    });
    expect(onBusyChange.mock.calls.map(([busy]) => busy)).toEqual([true, false, true, false]);
  });

  it("carries a user's explicit AI opt-in into a newly saved webpage", async () => {
    await render({ aiAllowed: true });
    await type("网页地址", firstUrl);
    await click("手动粘贴");
    await type("标题", "明确授权的网页");
    await type("手动粘贴的正文", "这段文字可用于有出处的 AI 问答。");
    await click("保存粘贴正文");

    expect(onImport.mock.calls[0][0]).toMatchObject({ aiAllowed: true, spaceIds: ["space-one"] });
  });

  it.each([
    ["account", { cloudUserId: "account-two" }],
    ["destination", { targetSpaceId: "space-two" }],
  ] as const)("discards a pending response when the %s changes", async (_name, changed) => {
    await render();
    const request = await begin();
    await render(changed);
    expect(request.init.signal?.aborted).toBe(true);
    expect(field("网页地址").value).toBe("");
    await respond(request);
    expect(displayedPreview()).toBeNull();
    expect(field("网页地址").value).toBe("");
    expect(onImport).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "GET")).toHaveLength(2);
  });

  it("aborts and ignores a response after unmount", async () => {
    await render();
    const request = await begin();
    await act(async () => {
      root!.unmount();
      root = null;
    });
    expect(request.init.signal?.aborted).toBe(true);
    await respond(request);
    expect(container.childElementCount).toBe(0);
    expect(onImport).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onBusyChange.mock.calls.map(([busy]) => busy)).toEqual([true, false]);
  });

  it("keeps a cancelled request from restoring its preview or importing content", async () => {
    await render();
    const request = await begin();
    await click("取消提取");
    expect(request.init.signal?.aborted).toBe(true);
    await respond(request);
    expect(displayedPreview()).toBeNull();
    expect(container.textContent).toContain("已取消提取");
    expect(onImport).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(button("提取预览").disabled).toBe(false);
  });

  it("stops a pending extraction when switching to manual mode", async () => {
    await render();
    const request = await begin();
    await click("手动粘贴");
    expect(request.init.signal?.aborted).toBe(true);
    await type("标题", "自己的标题");
    await respond(request);
    expect(field("标题").value).toBe("自己的标题");
    expect(displayedPreview()).toBeNull();
    expect(onImport).not.toHaveBeenCalled();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("rejects a schema-valid response for a different original URL", async () => {
    await render();
    const request = await begin();
    await respond(request, makePreview(secondUrl));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "来源与本次输入的网址不一致",
    );
    expect(displayedPreview()).toBeNull();
    expect(onImport).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("retains the preview after an import refusal and only reports success on an accepted retry", async () => {
    await readyPreview();
    onImport.mockImplementationOnce(() => {
      throw new Error("工作区容量不足，本次未加入。");
    });
    await click("保存提取正文");
    expect(onImport).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("工作区容量不足");
    expect(displayedPreview()?.value).toBe(makePreview().text);
    expect(field("保存标题").value).toBe(makePreview().title);
    expect(field("网页地址").value).toBe(firstUrl);
    await click("保存提取正文");
    expect(onImport).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith(onImport.mock.calls[1][0]);
    expect(displayedPreview()).toBeNull();
  });

  it("imports only once for two immediate clicks while the same save is pending", async () => {
    await readyPreview();
    const saving = deferred<void>();
    onImport.mockImplementation(() => saving.promise);
    const save = button("保存提取正文");
    await act(async () => {
      save.click();
      save.click();
    });
    expect(onImport).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
    expect(button("保存提取正文").disabled).toBe(true);
    await act(async () => {
      saving.resolve();
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onImport.mock.calls[0][0].webSnapshot).toMatchObject({
      method: "server",
      scope: "article",
    });
    expect(onBusyChange.mock.calls.map(([busy]) => busy)).toEqual([true, false]);
  });

  it("rejects a response body that completes after extraction has timed out", async () => {
    await render();
    vi.useFakeTimers();
    const request = await begin();
    const body = deferred<unknown>();
    await act(async () => {
      request.response.resolve({ ok: true, json: () => body.promise } as Response);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_001);
    });
    expect(request.init.signal?.aborted).toBe(true);
    await act(async () => {
      body.resolve(makePreview());
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("提取超时");
    expect(displayedPreview()).toBeNull();
    expect(onImport).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("pre-fills and locks a refresh source, preserves its name, and requires explicit new-version save", async () => {
    const source = makeCapturedWebSource({
      preview: makePreview(),
      title: "原资料名称",
      scope: "article",
      spaceId: "space-one",
      aiAllowed: true,
    });
    await render({ refreshSource: source, aiAllowed: false });
    expect(field("网页地址").value).toBe(firstUrl);
    expect(field("网页地址").readOnly).toBe(true);
    expect(requests).toHaveLength(0);
    await click("提取预览");
    await respond(requests[0], makePreview(firstUrl, "网页上的新标题"));
    expect(field("保存标题").value).toBe("原资料名称");
    expect(field("保存标题").readOnly).toBe(true);
    expect(onImport).not.toHaveBeenCalled();
    await click("保存为新版本");
    const candidate = onImport.mock.calls[0][0];
    expect(candidate.title).toBe("原资料名称");
    expect(candidate.aiAllowed).toBe(true);
    expect(candidate.versionId).not.toBe(source.versionId);
    expect(candidate.webSnapshot).toMatchObject({ originalUrl: firstUrl, scope: "article" });
    expect(onSaved).toHaveBeenCalledWith(candidate);
    expect(container.textContent).toContain("旧版与原有引用保留");
  });

  it("cancels an in-flight refresh when the current source version changes", async () => {
    const source = makeCapturedWebSource({
      preview: makePreview(),
      scope: "article",
      spaceId: "space-one",
    });
    await render({ refreshSource: source });
    await click("提取预览");
    const request = requests[0];
    await render({ refreshSource: { ...source, versionId: "new-current-version" } });
    expect(request.init.signal?.aborted).toBe(true);
    await respond(request);
    expect(displayedPreview()).toBeNull();
    expect(onImport).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps the original source intact when refresh extraction fails", async () => {
    const source = makeCapturedWebSource({
      preview: makePreview(),
      scope: "article",
      spaceId: "space-one",
    });
    const originalText = source.text;
    await render({ refreshSource: source });
    await click("提取预览");
    await act(async () => {
      requests[0].response.resolve(
        new Response(JSON.stringify({ error: "网站暂时不可访问" }), { status: 502 }),
      );
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("网站暂时不可访问");
    expect(source.text).toBe(originalText);
    expect(onImport).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(button("仅链接保存为新版本").disabled).toBe(false);
  });

  it.each(["selection", "link", "manual"] as const)(
    "allows an explicit %s refresh while keeping the original title and URL",
    async (scope) => {
      const source = makeCapturedWebSource({
        preview: makePreview(),
        title: "固定名称",
        scope: "article",
        spaceId: "space-one",
      });
      await render({ refreshSource: source });
      if (scope === "link") await click("仅链接保存为新版本");
      else if (scope === "manual") {
        await click("手动粘贴");
        expect(field("标题").readOnly).toBe(true);
        await type("手动粘贴的正文", "用户手工核对的新文字。");
        await click("保存为新版本");
      } else {
        await click("提取预览");
        await respond(requests[0]);
        await act(async () => {
          container.querySelector<HTMLInputElement>('input[value="selection"]')!.click();
        });
        await type("要保存的原文选段", "更新过大时可能产生振荡。");
        await click("保存为新版本");
      }
      expect(onImport).toHaveBeenCalledTimes(1);
      const candidate = onImport.mock.calls[0][0];
      expect(candidate).toMatchObject({ title: "固定名称", url: firstUrl });
      expect(candidate.webSnapshot?.scope).toBe(scope === "manual" ? "pasted" : scope);
      expect(candidate.status).toBe(scope === "link" ? "link-only" : "ready");
      expect(candidate.coverage).toEqual(
        scope === "link"
          ? { captureScope: "link", parseState: "not-requested" }
          : scope === "selection"
            ? { captureScope: "selection", parseState: "complete" }
            : scope === "manual"
              ? { captureScope: "manual", parseState: "complete" }
              : { captureScope: "full", parseState: "complete" },
      );
      expect(onSaved).toHaveBeenCalledWith(candidate);
    },
  );
});
