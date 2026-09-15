// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Reader, { type ReaderProps } from "./reader";
import WebVersionPanel from "./web-version-panel";
import PdfReader from "./pdf-reader";
import { prepareFile } from "@/lib/import";
import { makeCapturedWebSource, type WebPreview } from "@/lib/web-import";
import { getSourceVersion } from "@/lib/source-versions";
import type { SourceVersionPurgePreview } from "@/lib/cloud";
import type { Citation, Source, SourceVersion } from "@/lib/types";

vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./pdf-reader", () => ({
  default: vi.fn(({ source }: { source: Source }) =>
    createElement("div", { "data-pdf-version": source.versionId }, source.filename),
  ),
}));
vi.mock("@/lib/import", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/import")>()),
  prepareFile: vi.fn(),
}));
vi.mock("@/lib/local-store", () => ({ putBlob: vi.fn(), getBlob: vi.fn() }));

const preview: WebPreview = {
  originalUrl: "https://example.org/learning",
  finalUrl: "https://example.org/learning",
  title: "学习资料",
  text: "旧版认为学习率应该逐步减小。",
  excerpt: "旧版的学习率观点。",
  capturedAt: "2026-09-12T00:00:00.000Z",
  warnings: [],
  kind: "article",
};

describe("web source history and reader controls", () => {
  let host: HTMLDivElement;
  let root: Root;
  let current: Source;
  let historical: Source;
  let citation: Citation;
  let props: ReaderProps;
  let previousScroll: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.mocked(prepareFile).mockReset();
    vi.mocked(PdfReader).mockClear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(0), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input === "/api/v1/web/preview" && init?.method === "GET")
          return new Response(JSON.stringify({ available: true }));
        throw new Error("This test should not request an external webpage.");
      }),
    );
    previousScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
      }),
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute("open");
      }),
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const old = makeCapturedWebSource({
      preview,
      scope: "article",
      spaceId: "space-one",
      aiAllowed: true,
    });
    const archived: SourceVersion = {
      ...old,
      archivedAt: "2026-09-13T00:00:00.000Z",
      createdAt: preview.capturedAt,
    };
    const latest = makeCapturedWebSource({
      preview: {
        ...preview,
        text: "新版补充了周期变化的学习率。",
        capturedAt: "2026-09-13T00:00:00.000Z",
      },
      scope: "article",
      spaceId: "space-one",
      aiAllowed: true,
    });
    current = {
      ...old,
      versionId: latest.versionId,
      text: latest.text,
      chunks: latest.chunks.map((chunk) => ({ ...chunk, sourceId: old.id })),
      versionCreatedAt: latest.webSnapshot!.capturedAt,
      webSnapshot: latest.webSnapshot,
      versions: [archived],
    };
    historical = getSourceVersion(current, old.versionId)!;
    citation = {
      sourceId: old.id,
      versionId: old.versionId,
      chunkId: old.chunks[0].id,
      quote: old.text,
      title: old.title,
      section: old.chunks[0].section,
    };
    props = {
      source: historical,
      currentSource: current,
      sources: [current],
      space: {
        id: "space-one",
        name: "学习空间",
        goal: "",
        color: "#4b3fe3",
        archived: false,
        createdAt: preview.capturedAt,
      },
      conversations: [],
      annotations: [],
      aiEnabled: true,
      cloudUserId: "account-one",
      onSourceChange: vi.fn(),
      onConversationChange: vi.fn(),
      onAnnotationAdd: vi.fn(),
      onSaveNote: vi.fn(),
      onAsk: vi.fn(async () => ({
        content: "当前资料的回答",
        citations: [],
        mode: "extractive" as const,
      })),
      onOpenSource: vi.fn(),
      onBack: vi.fn(),
      getSourceBlob: vi.fn(async () => undefined),
      onRefreshWeb: vi.fn(),
    };
  });
  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    window.getSelection()?.removeAllRanges();
    host.remove();
    if (previousScroll) Object.defineProperty(Element.prototype, "scrollIntoView", previousScroll);
    else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  async function reader(overrides: Partial<ReaderProps> = {}) {
    props = { ...props, ...overrides };
    await act(async () => {
      root.render(createElement(Reader, props));
    });
  }
  function button(text: string) {
    const matches = [...host.querySelectorAll("button")].filter(
      (item) => item.textContent?.replace(/\s+/g, "") === text.replace(/\s+/g, ""),
    );
    expect(matches, `button ${text}`).toHaveLength(1);
    return matches[0];
  }
  function ariaButton(label: string) {
    const match = [...host.querySelectorAll("button")].find(
      (item) => item.getAttribute("aria-label") === label,
    );
    expect(match, `button labelled ${label}`).toBeTruthy();
    return match!;
  }
  function sourceAction(label: string) {
    const menu = host.querySelector<HTMLElement>("#reader-source-actions-menu");
    expect(menu, "source action menu").toBeTruthy();
    const match = [...menu!.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.replace(/\s+/g, "") === label.replace(/\s+/g, ""),
    );
    expect(match, `source action ${label}`).toBeTruthy();
    return match!;
  }
  function optionalSourceAction(label: string) {
    return [...host.querySelectorAll<HTMLButtonElement>("#reader-source-actions-menu button")].find(
      (item) => item.textContent?.replace(/\s+/g, "") === label.replace(/\s+/g, ""),
    );
  }
  async function click(control: HTMLButtonElement) {
    expect(control.disabled).toBe(false);
    await act(async () => {
      control.click();
    });
  }
  async function openSourceActions() {
    const toggle = ariaButton("更多资料操作");
    if (toggle.getAttribute("aria-expanded") !== "true") await click(toggle);
    expect(host.querySelector("#reader-source-actions-menu")).toBeTruthy();
  }
  async function clickSourceAction(label: string) {
    await openSourceActions();
    await click(sourceAction(label));
  }
  async function type(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
    await act(async () => {
      const prototype =
        control instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, value);
      control.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("labels the exact historical version and prevents questions, annotations and progress writes while permitting an independent excerpt note", async () => {
    vi.useFakeTimers();
    await reader();
    expect(host.textContent).toContain("正在阅读历史版本 · 只读");
    expect(host.textContent).toContain(historical.versionId);
    const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="向资料提问"]')!;
    expect(input.disabled).toBe(true);
    expect(ariaButton("新建对话").disabled).toBe(true);
    expect(ariaButton("发送问题").disabled).toBe(true);
    await openSourceActions();
    expect(optionalSourceAction("刷新网页")).toBeUndefined();
    await click(ariaButton("更多资料操作"));
    await act(async () => {
      host
        .querySelector("form.reader-composer")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(props.onAsk).not.toHaveBeenCalled();
    expect(props.onConversationChange).not.toHaveBeenCalled();
    await act(async () => {
      const paragraph = host.querySelector("[data-reader-text] p")!;
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(button("问 AI").disabled).toBe(true);
    expect(button("高亮").disabled).toBe(true);
    await click(button("存笔记"));
    expect(props.onSaveNote).toHaveBeenCalledWith(
      expect.stringContaining(preview.text),
      [
        expect.objectContaining({
          versionId: historical.versionId,
          sourceId: current.id,
          quote: preview.text,
        }),
      ],
      "note",
    );
    await act(async () => {
      const scroll = host.querySelector<HTMLElement>(".reader-document-scroll")!;
      scroll.scrollTop = 500;
      scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(450);
    });
    expect(props.onSourceChange).not.toHaveBeenCalled();
    expect(props.onAnnotationAdd).not.toHaveBeenCalled();
    await click(button("回到当前版本"));
    expect(props.onOpenSource).toHaveBeenCalledWith(current.id);
  });

  it("keeps progress saving and questions available on the current version", async () => {
    vi.useFakeTimers();
    await reader({ source: current });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="向资料提问"]')!;
    expect(input.disabled).toBe(false);
    await type(input, "当前资料有什么观点？");
    await click(ariaButton("发送问题"));
    expect(props.onAsk).toHaveBeenCalledTimes(1);
    await act(async () => {
      const scroll = host.querySelector<HTMLElement>(".reader-document-scroll")!;
      scroll.scrollTop = 400;
      scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });
    expect(props.onSourceChange).toHaveBeenCalledWith({
      readOffset: 400,
      lastReadAt: expect.any(String),
    });
  });

  it("navigates an old answer citation with its exact version and citation payload", async () => {
    await reader({
      source: current,
      conversations: [
        {
          id: "conversation-one",
          spaceId: "space-one",
          sourceId: current.id,
          title: "之前的问题",
          scope: "document",
          sourceIds: [current.id],
          messages: [
            {
              id: "answer-one",
              role: "assistant",
              content: "这是以前的回答。",
              citations: [citation],
              createdAt: preview.capturedAt,
            },
          ],
          resolved: false,
          updatedAt: preview.capturedAt,
        },
      ],
    });
    const citationChip = host.querySelector<HTMLButtonElement>('[aria-label^="查看引用 1："]');
    expect(citationChip).toBeTruthy();
    await click(citationChip!);
    await click(button("打开原文位置"));
    expect(props.onOpenSource).toHaveBeenCalledWith(current.id, historical.versionId, citation);
    expect(host.querySelector("[data-reader-text]")?.textContent).toContain(current.text);
    expect(props.onSourceChange).not.toHaveBeenCalled();
  });

  it("opens archived content from the version list without substituting current content", async () => {
    await act(async () => {
      root.render(
        createElement(WebVersionPanel, {
          source: current,
          displayedVersionId: current.versionId,
          spaceId: "space-one",
          onOpenSource: props.onOpenSource,
          onClose: vi.fn(),
          onRefreshWeb: props.onRefreshWeb,
        }),
      );
    });
    expect(host.textContent).toContain(historical.versionId);
    expect(host.textContent).toContain(current.versionId);
    await click(ariaButton(`打开历史版本 ${historical.versionId}`));
    expect(props.onOpenSource).toHaveBeenCalledWith(current.id, historical.versionId);
  });

  it("previews and confirms promoting an exact historical version to current", async () => {
    const restore = vi.fn(async () => undefined);
    const close = vi.fn();
    await act(async () => {
      root.render(
        createElement(WebVersionPanel, {
          source: current,
          displayedVersionId: current.versionId,
          spaceId: "space-one",
          onOpenSource: props.onOpenSource,
          onClose: close,
          onRefreshWeb: props.onRefreshWeb,
          onRestoreVersion: restore,
        }),
      );
    });

    await click(ariaButton(`恢复历史版本 ${historical.versionId} 为当前版本`));
    const dialog = host.querySelector<HTMLDialogElement>("dialog");
    expect(dialog?.hasAttribute("open")).toBe(true);
    expect(dialog?.textContent).toContain("现在的");
    expect(dialog?.textContent).toContain("资料名称、标签、知识库归属、收藏和 AI 权限不会改变");
    expect(dialog?.textContent).toContain(historical.versionId);

    await click(button("恢复为当前版本"));
    await act(async () => undefined);
    expect(restore).toHaveBeenCalledWith(historical.versionId, current.versionId);
    expect(close).toHaveBeenCalledTimes(1);
    expect(props.onOpenSource).toHaveBeenCalledWith(current.id);
    expect(host.querySelector("dialog")).toBeNull();
  });

  it("previews and explicitly confirms clearing an exact historical version", async () => {
    const previewRemove = vi.fn(async (): Promise<SourceVersionPurgePreview> => ({
      revision: 7,
      fingerprint: "a".repeat(64),
      impact: {
        source: { id: current.id, title: current.title },
        version: {
          versionId: historical.versionId,
          filename: historical.filename,
          createdAt: historical.versionCreatedAt!,
          archivedAt: current.versions![0].archivedAt,
        },
        annotations: 1,
        blockingAnnotations: 0,
        retainedNotes: 1,
        retainedNoteCitations: 1,
        retainedConversations: 1,
        retainedConversationCitations: 1,
        organizationJobs: 0,
        blockingOrganizationJobs: 0,
        conceptRelations: 0,
        blockingConceptRelations: 0,
        importJobs: 0,
        blockingImportJobs: 0,
        localOriginals: 0,
        cloudOriginals: 1,
      },
      blockers: { annotations: [], conceptRelations: [], organizationJobs: [], importJobs: [] },
    }));
    const remove = vi.fn(async () => undefined);
    const close = vi.fn();
    await act(async () => {
      root.render(
        createElement(WebVersionPanel, {
          source: current,
          displayedVersionId: current.versionId,
          spaceId: "space-one",
          onOpenSource: props.onOpenSource,
          onClose: close,
          onPreviewRemoveVersion: previewRemove,
          onRemoveVersion: remove,
        }),
      );
    });

    await click(ariaButton(`清理历史版本 ${historical.versionId}`));
    await act(async () => {
      await Promise.resolve();
    });
    const dialog = host.querySelector<HTMLDialogElement>("dialog");
    expect(dialog?.textContent).toContain("当前版本及其他版本不会改变");
    expect(dialog?.textContent).toContain("云端原件将由后台任务清理");
    const input = dialog!.querySelector<HTMLInputElement>("input")!;
    await type(input, "清理");
    await click(button("清理历史版本"));
    await act(async () => undefined);
    expect(previewRemove).toHaveBeenCalledWith(historical.versionId);
    expect(remove).toHaveBeenCalledWith(
      historical.versionId,
      expect.objectContaining({ revision: 7 }),
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(props.onOpenSource).toHaveBeenCalledWith(current.id);
  });

  it("offers return to current and disables refreshing from a historical version list", async () => {
    await act(async () => {
      root.render(
        createElement(WebVersionPanel, {
          source: current,
          displayedVersionId: historical.versionId,
          spaceId: "space-one",
          onOpenSource: props.onOpenSource,
          onClose: vi.fn(),
          onRefreshWeb: props.onRefreshWeb,
        }),
      );
    });
    expect(button("刷新网页").disabled).toBe(true);
    expect(ariaButton(`打开历史版本 ${historical.versionId}`).disabled).toBe(true);
    await click(button("查看当前版本"));
    expect(props.onOpenSource).toHaveBeenCalledWith(current.id);
  });

  it("passes the expected current version when the reader saves an explicit manual refresh", async () => {
    await reader({ source: current });
    await clickSourceAction("刷新网页");
    const urlInput = host.querySelector<HTMLInputElement>('input[type="url"]')!;
    expect(urlInput.value).toBe(preview.originalUrl);
    expect(urlInput.readOnly).toBe(true);
    await click(button("手动粘贴"));
    const text = host.querySelector<HTMLTextAreaElement>(".web-import-manual textarea")!;
    await type(text, "人工核对后的新正文。");
    await click(button("保存为新版本"));
    expect(props.onRefreshWeb).toHaveBeenCalledWith(
      expect.objectContaining({
        title: current.title,
        text: "人工核对后的新正文。",
        webSnapshot: expect.objectContaining({ method: "manual", scope: "pasted" }),
      }),
      current.versionId,
    );
    expect(props.onOpenSource).toHaveBeenCalledWith(current.id);
    expect(host.querySelector('[aria-label="网页版本管理"]')).toBeNull();
  });

  function currentFile() {
    return {
      ...current,
      kind: "docx" as const,
      filename: "current-document.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      url: undefined,
      webSnapshot: undefined,
      blobKey: "current-original",
      hash: "current-file-hash",
      versions: [
        {
          ...current.versions![0],
          kind: "pdf" as const,
          filename: "archived-original.pdf",
          mime: "application/pdf",
          blobKey: "archived-original",
          storagePath: "owner/source/archived/original.pdf",
          hash: "archived-file-hash",
          text: "",
          chunks: [],
          status: "failed" as const,
          pageCount: 4,
          parsedPages: 0,
          url: undefined,
          webSnapshot: undefined,
        },
      ],
    };
  }

  it("lists each file version's actual filename and format, including an unparsed PDF original", async () => {
    const file = currentFile();
    await reader({ source: file, currentSource: file, sources: [file], onReplaceFile: vi.fn() });
    await clickSourceAction("资料版本记录");
    expect(host.querySelector('[aria-label="资料版本管理"]')).not.toBeNull();
    expect(host.textContent).toContain("current-document.docx");
    expect(host.textContent).toContain("DOCX");
    expect(host.textContent).toContain("archived-original.pdf");
    expect(host.textContent).toContain("PDF · 无解析正文 · 原件保留 · 4 页");
    expect(host.querySelector('[aria-label="资料版本管理"]')!.textContent).not.toContain("仅链接");
    await click(ariaButton(`打开历史版本 ${file.versions[0].versionId}`));
    expect(props.onOpenSource).toHaveBeenCalledWith(file.id, file.versions[0].versionId);
  });

  it("renders a retained PDF with its own original after the current file became DOCX, while keeping historical read-only rules", async () => {
    const file = currentFile();
    const oldPdf = getSourceVersion(file, file.versions[0].versionId)!;
    await reader({ source: oldPdf, currentSource: file, sources: [file], onReplaceFile: vi.fn() });
    expect(host.querySelector("[data-pdf-version]")?.getAttribute("data-pdf-version")).toBe(
      oldPdf.versionId,
    );
    expect(vi.mocked(PdfReader).mock.calls.at(-1)![0]).toMatchObject({
      source: {
        kind: "pdf",
        versionId: oldPdf.versionId,
        filename: "archived-original.pdf",
        blobKey: "archived-original",
        storagePath: "owner/source/archived/original.pdf",
      },
      getSourceBlob: props.getSourceBlob,
    });
    expect(host.querySelector('button[aria-label="替换文件"]')).toBeNull();
    expect(ariaButton("发送问题").disabled).toBe(true);
    await click(ariaButton("下一页"));
    expect(props.onSourceChange).not.toHaveBeenCalled();
    await clickSourceAction("下载原文件");
    expect(props.getSourceBlob).toHaveBeenCalledWith(oldPdf);
    await clickSourceAction("资料版本记录");
    expect(button("替换文件").disabled).toBe(true);
  });

  it("confirms a file replacement from Reader with original bytes and current version, preserving the displayed title", async () => {
    const file = currentFile();
    const next: Source = {
      ...file,
      id: "prepared-source",
      versionId: "prepared-version",
      filename: "replacement.md",
      kind: "markdown",
      mime: "text/markdown",
      hash: "replacement-hash",
      title: "new filename title",
      blobKey: "prepared-original",
      versions: undefined,
      chunks: file.chunks.map((chunk) => ({
        ...chunk,
        sourceId: "prepared-source",
        versionId: "prepared-version",
      })),
    };
    vi.mocked(prepareFile).mockResolvedValue(next);
    await reader({
      source: file,
      currentSource: file,
      sources: [file],
      onReplaceFile: vi.fn(async () => {}),
    });
    await clickSourceAction("替换文件");
    const original = new File(["# New original"], "replacement.md", { type: "text/markdown" });
    await act(async () => {
      const picker = host.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(picker, "files", { configurable: true, value: [original] });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(props.onReplaceFile).not.toHaveBeenCalled();
    await click(button("保存为新版本"));
    expect(props.onReplaceFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "replacement.md",
        kind: "markdown",
        title: file.title,
      }),
      original,
      file.versionId,
    );
    expect(props.onOpenSource).toHaveBeenCalledWith(file.id);
    expect(host.querySelector('[aria-label="资料版本管理"]')).toBeNull();
  });

  it("closing Reader's file panel discards a late parse, so reopening cannot save the discarded candidate", async () => {
    const file = currentFile();
    let resolve!: (source: Source) => void;
    vi.mocked(prepareFile).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await reader({
      source: file,
      currentSource: file,
      sources: [file],
      onReplaceFile: vi.fn(async () => {}),
    });
    await clickSourceAction("替换文件");
    await act(async () => {
      const picker = host.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(picker, "files", {
        configurable: true,
        value: [new File(["text"], "new.txt")],
      });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(ariaButton("关闭资料版本面板"));
    await act(async () => {
      resolve({ ...file, hash: "new-hash" });
    });
    await clickSourceAction("替换文件");
    expect(host.querySelector('[aria-label="新文件预览"]')).toBeNull();
    expect(button("保存为新版本").disabled).toBe(true);
    expect(props.onReplaceFile).not.toHaveBeenCalled();
  });
});
