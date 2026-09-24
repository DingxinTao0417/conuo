import { beforeEach, describe, expect, it, vi } from "vitest";
import { chunkText, importFile, makeWebSource, prepareImportFile } from "./import";
import { sourceOutlineCache } from "./source-outline";

const mocks = vi.hoisted(() => ({
  putBlob: vi.fn(),
  pages: [] as (string | Error | { str: string; hasEOL?: boolean; transform?: number[] })[],
  destroy: vi.fn(),
  loadError: null as Error | null,
}));
vi.mock("./local-store", () => ({ putBlob: mocks.putBlob }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: () => ({
    promise: mocks.loadError
      ? Promise.reject(mocks.loadError)
      : Promise.resolve({
          numPages: mocks.pages.length,
          getPage: async (number: number) => {
            const value = mocks.pages[number - 1];
            if (value instanceof Error) throw value;
            const item = typeof value === "string" ? { str: value, hasEOL: true } : value;
            return {
              getTextContent: async () => ({ items: [item] }),
              cleanup: vi.fn(),
            };
          },
        }),
    destroy: mocks.destroy,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pages = [];
  mocks.loadError = null;
});

describe("file import", () => {
  it("keeps new material out of AI use unless the caller explicitly opts in", async () => {
    const defaultFile = await importFile(new File(["默认不授权"], "default.txt"), "space-a");
    const optedInFile = await importFile(new File(["明确授权"], "allowed.txt"), "space-a", true);
    const prepared = await prepareImportFile(new File(["准备阶段"], "prepared.txt"), "space-a");
    const defaultWeb = makeWebSource({
      url: "https://example.com/default",
      title: "默认网页",
      text: "默认不授权",
      spaceId: "space-a",
    });
    const optedInWeb = makeWebSource({
      url: "https://example.com/allowed",
      title: "授权网页",
      text: "明确授权",
      spaceId: "space-a",
      aiAllowed: true,
    });

    expect(defaultFile.aiAllowed).toBe(false);
    expect(prepared.aiAllowed).toBe(false);
    expect(defaultWeb.aiAllowed).toBe(false);
    expect(optedInFile.aiAllowed).toBe(true);
    expect(optedInWeb.aiAllowed).toBe(true);
  });

  it("fingerprints exact bytes independently of the filename and preserves both originals", async () => {
    const first = await importFile(new File(["学习率决定步长。"], "one.txt"), "space-a");
    const renamed = await importFile(new File(["学习率决定步长。"], "two.txt"), "space-a");
    const changed = await importFile(new File(["梯度决定方向。"], "one.txt"), "space-a");
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(renamed.hash).toBe(first.hash);
    expect(changed.hash).not.toBe(first.hash);
    expect(renamed.id).not.toBe(first.id);
    expect(renamed.versionId).not.toBe(first.versionId);
    expect(first.status).toBe("ready");
    expect(first.coverage).toEqual({ captureScope: "full", parseState: "complete" });
    expect(mocks.putBlob).toHaveBeenCalledTimes(3);
    const original = mocks.putBlob.mock.calls[0][1] as Blob;
    expect(await original.text()).toBe("学习率决定步长。");
  });

  it("retains an empty file as failed instead of declaring it AI-ready", async () => {
    const source = await importFile(new File(["  \n"], "empty.txt"), "space-a");
    expect(source.status).toBe("failed");
    expect(source.blobKey).toBeTruthy();
    expect(source.chunks).toEqual([]);
    expect(mocks.putBlob).toHaveBeenCalledOnce();
  });

  it("rejects unsupported and oversized uploads before writing blobs", async () => {
    await expect(importFile(new File(["x"], "image.png"), "space-a")).rejects.toThrow("暂不支持");
    const large = new File(["x"], "large.txt");
    Object.defineProperty(large, "size", { value: 30 * 1024 * 1024 + 1 });
    await expect(importFile(large, "space-a")).rejects.toThrow("30 MB");
    expect(mocks.putBlob).not.toHaveBeenCalled();
  });

  it("does not declare success if the original cannot be saved", async () => {
    mocks.putBlob.mockRejectedValueOnce(new Error("quota exceeded"));
    await expect(importFile(new File(["text"], "note.txt"), "space-a")).rejects.toThrow(
      "quota exceeded",
    );
  });

  it("distinguishes partial PDF extraction and preserves physical page numbers", async () => {
    mocks.pages = [
      "学习率决定每一步走多远。",
      "",
      new Error("page damaged"),
      "梯度表示损失上升的方向。",
    ];
    const source = await importFile(new File(["%PDF-test"], "partial.pdf"), "space-a");
    expect(source.status).toBe("partial");
    expect(source.pageCount).toBe(4);
    expect(source.parsedPages).toBe(2);
    expect(source.chunks.map((chunk) => chunk.page)).toEqual([1, 4]);
    expect(source.error).toContain("2、3");
    expect(source.coverage).toEqual({
      captureScope: "full",
      parseState: "partial",
      unavailablePageRanges: [{ start: 2, end: 3 }],
    });
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("recognizes PDF heading lines from relative font sizes", async () => {
    mocks.pages = [
      { str: "普通正文。", hasEOL: true, transform: [1, 0, 10, 1, 0, 0] },
      { str: "普通正文。", hasEOL: true, transform: [1, 0, 10, 1, 0, 0] },
      { str: "普通正文。", hasEOL: true, transform: [1, 0, 10, 1, 0, 0] },
      { str: "普通正文。", hasEOL: true, transform: [1, 0, 10, 1, 0, 0] },
      { str: "第一章 梯度下降", hasEOL: true, transform: [1, 0, 20, 1, 0, 0] },
      { str: "1.1 学习率", hasEOL: true, transform: [1, 0, 15, 1, 0, 0] },
    ];
    const source = await importFile(new File(["%PDF-test"], "headings.pdf"), "space-a");
    expect(sourceOutlineCache.get(source)).toEqual({
      method: "heading-heuristic",
      items: [
        { title: "第一章 梯度下降", level: 1, page: 5 },
        { title: "1.1 学习率", level: 2, page: 6 },
      ],
    });
  });

  it("keeps scanned PDFs available while excluding them from searchable text", async () => {
    mocks.pages = ["", ""];
    const source = await importFile(new File(["%PDF-test"], "scan.pdf"), "space-a");
    expect(source.status).toBe("failed");
    expect(source.parsedPages).toBe(0);
    expect(source.pageCount).toBe(2);
    expect(source.error).toContain("OCR");
    expect(source.blobKey).toBeTruthy();
    expect(source.coverage).toEqual({
      captureScope: "full",
      parseState: "failed",
      unavailablePageRanges: [{ start: 1, end: 2 }],
    });
  });

  it("retains a damaged PDF as an independently failed import", async () => {
    mocks.loadError = new Error("Invalid PDF structure");

    const source = await importFile(new File(["not-a-pdf"], "damaged.pdf"), "space-a");

    expect(source).toMatchObject({
      filename: "damaged.pdf",
      kind: "pdf",
      status: "failed",
      coverage: { captureScope: "full", parseState: "failed" },
      text: "",
      chunks: [],
    });
    expect(source.error).toContain("Invalid PDF structure");
    expect(source.blobKey).toBeTruthy();
    expect(mocks.putBlob).toHaveBeenCalledOnce();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
});

describe("chunk identities and web snapshots", () => {
  it("keeps original sentences, section, order and exact source-version mapping", () => {
    const sentence = "学习率决定更新参数时的步长，较大的步长可能带来振荡。";
    const text = `# 训练基础\n\n${sentence.repeat(100)}\n\n## 检查结果\n\n比较训练损失曲线。`;
    const chunks = chunkText(text, "source-a", "version-2");
    expect(chunks.length).toBeGreaterThan(3);
    expect(
      chunks.every((chunk) => chunk.sourceId === "source-a" && chunk.versionId === "version-2"),
    ).toBe(true);
    expect(chunks.every((chunk) => text.includes(chunk.text) && chunk.text.length <= 1200)).toBe(
      true,
    );
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(chunks.length);
    expect(chunks.map((chunk) => chunk.order)).toEqual(chunks.map((_, index) => index));
    expect(chunks.at(-1)?.section).toBe("检查结果");
    expect(
      chunks
        .map((chunk) => chunk.text)
        .join("")
        .replace(/\s/g, ""),
    ).toBe(text.replace(/\s/g, ""));
  });

  it("marks bare links as link-only and rejects executable schemes", () => {
    const link = makeWebSource({
      url: "https://example.com",
      title: "文章",
      text: "",
      spaceId: "space-a",
    });
    expect(link.status).toBe("link-only");
    expect(link.coverage).toEqual({ captureScope: "link", parseState: "not-requested" });
    expect(link.chunks).toEqual([]);
    expect(link.hash).toBe("");
    expect(() =>
      makeWebSource({ url: "javascript:alert(1)", title: "x", text: "x", spaceId: "space-a" }),
    ).toThrow("http");
  });
});
