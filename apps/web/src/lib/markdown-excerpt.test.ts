import { describe, expect, it } from "vitest";
import { projectMarkdownVisibleText, resolveMarkdownExcerpt } from "./markdown-excerpt";
import type { Source } from "./types";

function source(
  text: string,
  chunks = [text],
): Pick<Source, "id" | "versionId" | "kind" | "text" | "chunks"> {
  return {
    id: "source",
    versionId: "version",
    kind: "markdown",
    text,
    chunks: chunks.map((value, order) => ({
      id: `chunk-${order}`,
      sourceId: "source",
      versionId: "version",
      text: value,
      order,
      section: `section-${order}`,
    })),
  };
}
function projection(text: string) {
  const result = projectMarkdownVisibleText(text);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result;
}

describe("source-owned Markdown visible excerpts", () => {
  it("maps a visible sentence across bold back to its exact raw quote", () => {
    const text = "学习 **梯度下降** 的步骤。";
    expect(resolveMarkdownExcerpt(source(text), "学习 梯度下降 的步骤。")).toEqual({
      ok: true,
      rawQuote: text,
      visibleQuote: "学习 梯度下降 的步骤。",
      rawStart: 0,
      rawEnd: text.length,
      chunkId: "chunk-0",
      chunkIds: ["chunk-0"],
    });
  });
  it.each([
    ["理解 *概念* 和 ~~旧说法~~。", "理解 概念 和 旧说法。"],
    ['阅读 [学习指南](https://example.test/path "标题") 再思考。', "阅读 学习指南 再思考。"],
    ["阅读 [学习指南][guide] 再思考。\n\n[guide]: https://example.test", "阅读 学习指南 再思考。"],
    ["理解 **很 *重要* 的概念**。", "理解 很 重要 的概念。"],
    ["转义 \\*星号\\* 和 &amp; 符号。", "转义 *星号* 和 & 符号。"],
    ["符号 &#x1F600; 和 &NotEqualTilde;。", "符号 😀 和 ≂̸。"],
  ])("preserves raw inline syntax from %s", (text, visible) => {
    const result = resolveMarkdownExcerpt(source(text), visible);
    expect(result.ok).toBe(true);
    if (result.ok) expect(text.slice(result.rawStart, result.rawEnd)).toBe(result.rawQuote);
    expect(projection(text).compactText).toContain(visible.replace(/\s/gu, ""));
  });
  it("excludes link destinations from selectable visible text", () => {
    const text = "[标签](https://secret.example.test)";
    expect(projection(text).compactText).toBe("标签");
    expect(resolveMarkdownExcerpt(source(text), "secret.example.test").ok).toBe(false);
    expect(resolveMarkdownExcerpt(source(text), "标签")).toMatchObject({
      ok: true,
      rawQuote: "标签",
    });
  });
  it("pins a selection beginning inside formatting to continuous raw characters", () => {
    const text = "学习 **梯度下降** 的步骤。";
    expect(resolveMarkdownExcerpt(source(text), "梯度下降 的步骤")).toMatchObject({
      ok: true,
      rawQuote: "梯度下降** 的步骤",
      visibleQuote: "梯度下降 的步骤",
    });
  });
  it.each([
    ["使用 ` a\nb ` 再检查。", "使用 a b 再检查。"],
    ["代码 `` a ` b ``。", "代码 a ` b。"],
    ["代码 `\\* &amp;`。", "代码 \\* &amp;。"],
    ["```ts\nconst x = 1;\nconst y = 2;\n```", "const x = 1;\nconst y = 2;"],
    ["    first\n    second", "first\nsecond"],
    ["第一行  \n第二行", "第一行\n第二行"],
    ["第一行\n第二行", "第一行\n第二行"],
  ])("maps supported code and line breaks in %s", (text, visible) => {
    const result = resolveMarkdownExcerpt(source(text), visible);
    expect(result.ok).toBe(true);
    if (result.ok) expect(text.slice(result.rawStart, result.rawEnd)).toBe(result.rawQuote);
  });
  it("maps structural quote/list prefixes only when AST text proves them", () => {
    const text = "> 引用文字\n> 下一行\n\n- 第一项\n- 第二项";
    expect(projection(text).compactText).toBe("引用文字下一行第一项第二项");
    expect(resolveMarkdownExcerpt(source(text), "引用文字\n下一行")).toMatchObject({
      ok: true,
      rawQuote: "引用文字\n> 下一行",
    });
  });
  it("projects GFM table cell labels and escaped pipes", () => {
    const text = "A | B\n--|--\nx\\|y | **z**";
    expect(projection(text).compactText).toBe("ABx|yz");
    expect(resolveMarkdownExcerpt(source(text), "x|y z")).toMatchObject({
      ok: true,
      rawQuote: "x\\|y | **z",
    });
  });
  it("preserves compact UTF16 offsets for emoji and refuses partial decoded tokens", () => {
    const text = "先 &#x1F600; 再 **文字**。";
    const result = resolveMarkdownExcerpt(source(text), "文字", { visibleStart: 4 });
    expect(result).toMatchObject({ ok: true, rawQuote: "文字" });
    expect(resolveMarkdownExcerpt(source(text), "\ud83d", { visibleStart: 1 }).ok).toBe(false);
    const units = projection(text).units;
    expect(units[1]).toEqual(units[2]);
  });
  it("never falls back when a supplied visible offset is wrong", () => {
    const text = "先 **目标** 后 **目标**。";
    expect(resolveMarkdownExcerpt(source(text), "目标", { visibleStart: 0 })).toMatchObject({
      ok: false,
      reason: "selection-not-found",
    });
    expect(resolveMarkdownExcerpt(source(text), "目标", { visibleStart: 4 })).toMatchObject({
      ok: true,
      rawStart: text.lastIndexOf("目标"),
    });
    expect(resolveMarkdownExcerpt(source(text), "目标")).toMatchObject({
      ok: false,
      reason: "selection-ambiguous",
    });
  });
  it("disambiguates a repeated second paragraph using its trustworthy block span", () => {
    const first = "# 第一节\n\n学习 **梯度下降** 的步骤。";
    const second = "# 第二节\n\n学习 **梯度下降** 的步骤。";
    const text = `${first}\n\n${second}`;
    const rawStart = text.lastIndexOf("学习");
    expect(
      resolveMarkdownExcerpt(source(text, [first, second]), "学习 梯度下降 的步骤。"),
    ).toMatchObject({ ok: false, reason: "selection-ambiguous" });
    expect(
      resolveMarkdownExcerpt(source(text, [first, second]), "学习 梯度下降 的步骤。", {
        rawStart,
        rawEnd: text.length,
        visibleStart: 0,
      }),
    ).toMatchObject({ ok: true, rawStart, chunkId: "chunk-1", chunkIds: ["chunk-1"] });
  });
  it("uses complete ordered chunk coverage to distinguish identical raw paragraph chunks", () => {
    const text = "**重复段落**\n\n**重复段落**";
    const rawStart = text.lastIndexOf("**重复");
    expect(
      resolveMarkdownExcerpt(source(text, ["**重复段落**", "**重复段落**"]), "重复段落", {
        rawStart,
        rawEnd: text.length,
        visibleStart: 0,
      }),
    ).toMatchObject({ ok: true, chunkId: "chunk-1" });
  });
  it("keeps cross-chunk questions/annotations and rejects only single-chunk knowledge requests", () => {
    const text = "第一 **段落**。\n\n第二 *段落*。";
    const item = source(text, ["第一 **段落**。", "第二 *段落*。"]);
    expect(resolveMarkdownExcerpt(item, "第一 段落。第二 段落。")).toMatchObject({
      ok: true,
      rawQuote: text,
      chunkIds: ["chunk-0", "chunk-1"],
    });
    expect(
      resolveMarkdownExcerpt(item, "第一 段落。第二 段落。", { requireSingleChunk: true }),
    ).toMatchObject({ ok: false, reason: "selection-cross-chunk" });
  });
  it("validates an explicit single-chunk anchor without guessing a different identity", () => {
    const item = source("第一 **段落**。\n\n第二 *段落*。", ["第一 **段落**。", "第二 *段落*。"]);
    expect(
      resolveMarkdownExcerpt(item, "第二 段落。", {
        requireSingleChunk: true,
        anchorChunkId: "chunk-0",
      }),
    ).toMatchObject({ ok: false, reason: "chunk-unavailable" });
  });
  it("allows source-proven questions without inventing chunk evidence from a partial cache", () => {
    const item = source("未索引 **原文**。", []);
    expect(resolveMarkdownExcerpt(item, "未索引 原文。")).toMatchObject({ ok: true, chunkIds: [] });
    expect(resolveMarkdownExcerpt(item, "未索引 原文。", { requireSingleChunk: true }).ok).toBe(
      false,
    );
  });
  it("never presents partial chunk evidence as coverage of a missing middle paragraph", () => {
    const first = "首段 **可定位**。";
    const middle = "中段 *未索引*。";
    const last = "末段 **可定位**。";
    const text = `${first}\n\n${middle}\n\n${last}`;
    const item = source(text, [first, last]);
    expect(resolveMarkdownExcerpt(item, "首段 可定位。中段 未索引。末段 可定位。")).toMatchObject({
      ok: true,
      rawQuote: text,
      chunkIds: [],
    });
    expect(resolveMarkdownExcerpt(item, "首段 可定位。")).toMatchObject({
      ok: true,
      chunkId: "chunk-0",
      chunkIds: ["chunk-0"],
    });
  });
  it.each(["左边 ![隐藏图片文字](https://image.test) 右边", "左边 <span>HTML</span> 右边"])(
    "does not bridge unknown or image ranges: %s",
    (text) => {
      expect(
        resolveMarkdownExcerpt(
          source(text),
          text.startsWith("左边 !") ? "左边 右边" : "左边 HTML 右边",
        ),
      ).toMatchObject({ ok: false, reason: "unsupported-markdown" });
    },
  );
  it("refuses an HTML-only block rather than trusting its rendered text", () => {
    const text = "<div>非 Markdown HTML 片段。</div>";
    expect(resolveMarkdownExcerpt(source(text), "非 Markdown HTML 片段。")).toMatchObject({
      ok: false,
      reason: "unsupported-markdown",
    });
    expect(projection(text).compactText).toBe("");
  });
  it.each([
    { rawStart: 1 },
    { rawStart: -1, rawEnd: 3 },
    { rawStart: 1, rawEnd: 99 },
    { rawStart: 3, rawEnd: 1 },
    { visibleStart: -1 },
  ])("rejects invalid positioning options %j", (options) => {
    expect(resolveMarkdownExcerpt(source("**text**"), "text", options).ok).toBe(false);
  });
  it("does not map selections from another source kind or arbitrary unrendered words", () => {
    const item = source("可见 **文字**。");
    expect(resolveMarkdownExcerpt({ ...item, kind: "text" }, "文字").ok).toBe(false);
    expect(resolveMarkdownExcerpt(item, "不存在的文字").ok).toBe(false);
  });
  it("keeps cached source projections isolated from caller mutation and replaces them for new text", () => {
    const text = "可见 **原文** ![图片](https://image.test) 结尾。";
    const first = projection(text);
    first.units[0].rawStart = 999;
    first.blockedRanges[0].rawStart = 999;
    first.units.splice(1);
    const next = projection(text);
    expect(next.units[0].rawStart).toBe(0);
    expect(next.units.length).toBe(next.compactText.length);
    expect(next.blockedRanges[0].rawStart).toBe(text.indexOf("!["));
    expect(projection("**新文**").compactText).toBe("新文");
    expect(projection(text).compactText).toBe("可见原文结尾。");
  });
});
