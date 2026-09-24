// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OcrPageFlow from "./ocr-page-flow";
import type { Source } from "@/lib/types";

const mock = vi.hoisted(() => ({
  getDocument: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: mock.getDocument,
}));

function source(): Source {
  return {
    id: "pdf-source",
    versionId: "pdf-v1",
    title: "扫描件",
    filename: "scan.pdf",
    kind: "pdf",
    mime: "application/pdf",
    size: 10,
    hash: "a".repeat(64),
    spaceIds: [],
    tags: [],
    status: "partial",
    coverage: {
      captureScope: "full",
      parseState: "partial",
      unavailablePageRanges: [{ start: 2, end: 2 }],
    },
    text: "第一页正文",
    chunks: [],
    createdAt: "2026-09-25T12:00:00.000Z",
    updatedAt: "2026-09-25T12:00:00.000Z",
    deletedAt: null,
    aiAllowed: true,
    starred: false,
    pageCount: 2,
    parsedPages: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("OCR page flow", () => {
  let host: HTMLDivElement;
  let root: Root;
  let replace: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;
  const task = {
    promise: Promise.resolve({
      getPage: vi.fn(async () => ({
        getViewport: () => ({ width: 1000, height: 1400 }),
        render: () => ({ promise: Promise.resolve() }),
        cleanup: vi.fn(),
      })),
    }),
    destroy: vi.fn(async () => {}),
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    replace = vi.fn(async () => {});
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mock.getDocument.mockReset().mockReturnValue(task);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      {} as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) =>
      callback(new Blob(["png"], { type: "image/png" })),
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render() {
    await act(async () =>
      root.render(
        createElement(OcrPageFlow, {
          source: source(),
          getSourceBlob: vi.fn(async () => new Blob(["pdf"])),
          onReplaceFile: replace as unknown as (
            candidate: Source,
            blob: Blob,
            expectedVersionId: string,
          ) => Promise<void>,
        }),
      ),
    );
  }

  it("shows missing pages, can stop in flight work, previews results, and saves only after confirmation", async () => {
    await render();
    expect(host.textContent).toContain("识别缺失页面");
    await act(async () => host.querySelector("button")!.click());
    expect(host.textContent).toContain("第 2 页");

    const pending = deferred<Response>();
    fetchMock.mockReturnValue(pending.promise);
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("开始识别"))!
        .click(),
    );
    expect(host.textContent).toContain("正在识别第 2 页");
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("停止"))!
        .click(),
    );
    pending.reject(new DOMException("stopped", "AbortError"));
    await act(async () => Promise.resolve());
    expect(replace).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ page: 2, markdown: "OCR 正文" }),
    });
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("开始识别"))!
        .click(),
    );
    expect(host.querySelector("textarea")?.value).toBe("OCR 正文");
    expect(replace).not.toHaveBeenCalled();
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("确认并保存"))!
        .click(),
    );
    expect(replace).toHaveBeenCalledOnce();
  });
});
