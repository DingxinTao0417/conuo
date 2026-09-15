// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ImportJob } from "@/lib/import-queue";
import { MEBIBYTE } from "@/lib/import-quota";
import type { Source } from "@/lib/types";

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/use-workspace", () => ({ useWorkspace: vi.fn() }));
vi.mock("./web-import-form", () => ({ default: () => null }));

import { ImportModal } from "./workspace";

type ImportModalProps = ComponentProps<typeof ImportModal>;
type ImportResult = Awaited<ReturnType<ImportModalProps["onImportFile"]>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function source(size: number): Source {
  return {
    id: "retained-source",
    versionId: "retained-version",
    title: "已保留资料",
    filename: "retained.pdf",
    kind: "pdf",
    mime: "application/pdf",
    size,
    hash: "retained-hash",
    spaceIds: [],
    tags: [],
    status: "ready",
    text: "正文",
    chunks: [],
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    deletedAt: null,
    aiAllowed: true,
    starred: false,
  };
}

function queuedJob(sourceId: string): ImportJob {
  return {
    id: `import-${sourceId.length}-${sourceId}-version`,
    sourceId,
    versionId: "version",
    filename: `${sourceId}.pdf`,
    spaceId: "",
    stage: "saving",
    status: "queued",
    originalSaved: false,
    attempt: 0,
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
  };
}

describe("ImportModal local quota UI", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: ImportModalProps;
  let onImportFile: ReturnType<typeof vi.fn<ImportModalProps["onImportFile"]>>;
  let showModal: ReturnType<typeof vi.fn>;
  let close: ReturnType<typeof vi.fn>;
  let previousShowModal: PropertyDescriptor | undefined;
  let previousClose: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    showModal = vi.fn();
    close = vi.fn();
    previousShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
    previousClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: showModal,
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: close,
    });
    onImportFile = vi.fn<ImportModalProps["onImportFile"]>();
    props = {
      spaceId: "",
      spaces: [],
      sources: [],
      jobs: [],
      saveState: "local",
      onWebImport: vi.fn(),
      onImportFile,
      onRetryImport: vi.fn().mockResolvedValue(undefined),
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
    vi.unstubAllGlobals();
  });

  async function render(next: Partial<ImportModalProps> = {}) {
    props = { ...props, ...next };
    await act(async () => {
      root.render(createElement(ImportModal, props));
    });
  }

  async function choose(files: File[]) {
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: files });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
  }

  it("lets a full-account normal selection reach the importer for duplicate detection", async () => {
    const retained = source(512 * MEBIBYTE);
    onImportFile.mockResolvedValue({ kind: "duplicate", source: retained });
    await render({ sources: [retained] });

    const quota = host.querySelector('[aria-label="本机导入额度"]');
    expect(quota?.textContent).toContain("账户已用 512 MiB / 512 MiB");
    expect(quota?.textContent).toContain("剩余 0 B");
    expect(quota?.textContent).toContain("每批最多 20 个文件，合计 150 MiB");

    const file = new File(["内容"], "overage.pdf", { type: "application/pdf" });
    await choose([file]);

    await vi.waitFor(() => expect(onImportFile).toHaveBeenCalledWith(file, "", false, false));
    expect(host.textContent).toContain("overage.pdf");
    expect(host.textContent).toContain("是否可继续将由导入时判定。");
    expect(host.textContent).toContain("检测到相同内容，已关联已有资料。");
  });

  it("keeps an explicitly requested duplicate copy blocked at a full account cap", async () => {
    const retained = source(512 * MEBIBYTE);
    onImportFile.mockResolvedValue({ kind: "duplicate", source: retained });
    await render({ sources: [retained] });
    const file = new File(["内容"], "duplicate.pdf", { type: "application/pdf" });

    await choose([file]);
    await vi.waitFor(() => expect(onImportFile).toHaveBeenCalledWith(file, "", false, false));
    const copy = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "保留副本",
    );
    expect(copy).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      copy?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(onImportFile).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("账号保留原件超过 512 MiB 本机上限。");
  });

  it("starts accepted batch files one at a time", async () => {
    const first = new File(["first"], "first.pdf", { type: "application/pdf" });
    const second = new File(["second"], "second.pdf", { type: "application/pdf" });
    const pendingFirst = deferred<ImportResult>();
    onImportFile.mockImplementation((file) => {
      if (file.name === first.name) return pendingFirst.promise;
      return Promise.resolve({ kind: "queued", job: queuedJob("second-source") });
    });
    await render();

    await choose([first, second]);
    expect(onImportFile).toHaveBeenCalledTimes(1);
    expect(onImportFile).toHaveBeenLastCalledWith(first, "", false, false);

    const consent = host.querySelector<HTMLInputElement>(
      'input[aria-label="允许 AI 使用本次导入的资料"]',
    );
    await act(async () => consent?.click());

    await act(async () => {
      pendingFirst.resolve({ kind: "queued", job: queuedJob("first-source") });
      await pendingFirst.promise;
      await Promise.resolve();
    });

    expect(onImportFile).toHaveBeenCalledTimes(2);
    expect(onImportFile).toHaveBeenLastCalledWith(second, "", false, false);
  });

  it("shows the terminal result of every file in the current mixed-format batch", async () => {
    const pdf = new File(["%PDF-normal"], "normal.pdf", { type: "application/pdf" });
    const damaged = new File(["broken"], "damaged.pdf", { type: "application/pdf" });
    const docx = new File(["PK-normal"], "normal.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const started = new Map([
      [pdf.name, { ...queuedJob("normal-pdf"), filename: pdf.name }],
      [damaged.name, { ...queuedJob("damaged-pdf"), filename: damaged.name }],
      [docx.name, { ...queuedJob("normal-docx"), filename: docx.name }],
    ]);
    onImportFile.mockImplementation(async (file) => ({
      kind: "queued",
      job: started.get(file.name)!,
    }));
    await render();

    await choose([pdf, damaged, docx]);
    await vi.waitFor(() => expect(onImportFile).toHaveBeenCalledTimes(3));

    const completed = (filename: string) => ({
      ...started.get(filename)!,
      stage: "indexing" as const,
      status: "completed" as const,
      originalSaved: true,
      attempt: 1,
      completedAt: "2026-09-13T00:01:00.000Z",
      updatedAt: "2026-09-13T00:01:00.000Z",
    });
    const failed = {
      ...started.get(damaged.name)!,
      stage: "parsing" as const,
      status: "failed" as const,
      originalSaved: true,
      attempt: 1,
      error: "文件损坏，无法提取正文。",
      updatedAt: "2026-09-13T00:01:00.000Z",
    };
    const imported = (id: string, filename: string, kind: Source["kind"]): Source => ({
      ...source(1),
      id,
      versionId: "version",
      title: filename.replace(/\.[^.]+$/u, ""),
      filename,
      kind,
      mime:
        kind === "docx"
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : "application/pdf",
    });
    const failedSource: Source = {
      ...imported("damaged-pdf", damaged.name, "pdf"),
      status: "failed",
      coverage: { captureScope: "full", parseState: "failed" },
      text: "",
      chunks: [],
      error: failed.error,
    };
    await render({
      jobs: [completed(pdf.name), failed, completed(docx.name)],
      sources: [
        imported("normal-pdf", pdf.name, "pdf"),
        failedSource,
        imported("normal-docx", docx.name, "docx"),
      ],
    });

    expect(host.textContent?.match(/解析完成，正文已可检索。/gu)).toHaveLength(2);
    expect(host.textContent).toContain("文件损坏，无法提取正文。");
    expect(host.textContent).not.toContain("原文件已保存，正在后台解析");
    const retry = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "重新解析",
    );
    expect(retry).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      retry?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(props.onRetryImport).toHaveBeenCalledExactlyOnceWith(failed.id);
  });

  it("sends an explicit opt-in for newly selected files", async () => {
    const file = new File(["内容"], "allowed.pdf", { type: "application/pdf" });
    onImportFile.mockResolvedValue({ kind: "queued", job: queuedJob("allowed-source") });
    await render();

    const consent = host.querySelector<HTMLInputElement>(
      'input[aria-label="允许 AI 使用本次导入的资料"]',
    );
    expect(consent?.checked).toBe(false);
    await act(async () => consent?.click());
    expect(consent?.checked).toBe(true);

    await choose([file]);
    await vi.waitFor(() => expect(onImportFile).toHaveBeenCalledWith(file, "", false, true));
  });

  it("keeps local retention and cloud confirmation visibly distinct", async () => {
    const retained = { ...source(1), storagePath: "account/retained-version/retained-source.pdf" };
    const pending = { ...queuedJob(retained.id), versionId: retained.versionId };

    await render({ jobs: [pending] });
    expect(host.querySelector('[aria-label="云端确认"]')?.textContent).toContain(
      "仅保存在此浏览器",
    );

    await render({ cloudUserId: "account", jobs: [pending], saveState: "saving" });
    expect(host.querySelector('[aria-label="云端确认"]')?.textContent).toContain(
      "本机已保存，正在上传并确认资料库",
    );

    await render({ cloudUserId: "account", jobs: [pending], saveState: "cloud" });
    expect(host.querySelector('[aria-label="云端确认"]')?.textContent).toContain(
      "当前工作区已确认云端",
    );

    await render({
      cloudUserId: "account",
      jobs: [pending],
      sources: [retained],
      saveState: "error",
      saveError: "当前工作区超过 3 MiB 云端保存容量。",
    });
    expect(host.querySelector('[aria-label="云端确认"]')?.textContent).toContain(
      "原文件已上传，但资料库云端未确认",
    );
    expect(host.querySelector('[aria-label="云端确认"]')?.textContent).toContain("3 MiB");
  });
});
