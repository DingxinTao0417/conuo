// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { findReaderSearchRanges, readerSearchRoot } from "./reader-search";

afterEach(() => {
  document.body.replaceChildren();
});

describe("reader body search", () => {
  it("finds every visible match in reading order, including text split by inline markup", () => {
    document.body.innerHTML = `
      <article data-reader-text="true">
        <p>第一处学习率。</p>
        <p>第二处<strong>学习</strong>率。</p>
        <p>第三处学习率。</p>
      </article>`;

    const ranges = findReaderSearchRanges(
      document.querySelector<HTMLElement>("[data-reader-text]")!,
      "学习率",
    );

    expect(ranges).toHaveLength(3);
    expect(ranges.map((range) => range.toString())).toEqual(["学习率", "学习率", "学习率"]);
    expect(ranges[1].startContainer.parentElement?.tagName).toBe("STRONG");
  });

  it("uses only source prose instead of repeated reader metadata and hidden controls", () => {
    document.body.innerHTML = `
      <section>
        <h1>学习率资料</h1>
        <span aria-hidden="true">学习率装饰文字</span>
        <button>学习率操作</button>
        <article data-reader-text="true"><p>学习率正文。</p><p>learning rate</p></article>
      </section>`;

    const root = readerSearchRoot(document.querySelector<HTMLElement>("section")!);
    expect(root.dataset.readerText).toBe("true");
    expect(findReaderSearchRanges(root, "学习率").map((range) => range.toString())).toEqual([
      "学习率",
    ]);
    expect(findReaderSearchRanges(root, "LEARNING RATE").map((range) => range.toString())).toEqual([
      "learning rate",
    ]);
  });

  it("returns no stale result for blank or absent queries", () => {
    document.body.innerHTML = '<article data-reader-text="true"><p>可检索正文。</p></article>';
    const root = document.querySelector<HTMLElement>("[data-reader-text]")!;

    expect(findReaderSearchRanges(root, "   ")).toEqual([]);
    expect(findReaderSearchRanges(root, "不存在")).toEqual([]);
  });
});
