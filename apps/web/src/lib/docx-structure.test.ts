import { describe, expect, it } from "vitest";
import { chunkText } from "./import";
import {
  applyDocxSections,
  docxTableEvidenceRanges,
  parseDocxHtml,
  type DocxBlock,
} from "./docx-structure";

describe("DOCX restricted structure", () => {
  it("keeps headings, paragraphs, lists and basic tables without retaining document HTML", () => {
    const blocks = parseDocxHtml(`
      <h1 onclick="steal()">可信标题<script>alert("bad")</script></h1>
      <p>安全的 <a href="javascript:steal()">链接文字</a><img src="x" onerror="steal()"></p>
      <ul><li>第一项</li><li>第二项</li></ul>
      <table data-secret="nope">
        <tr><th>名称</th><th>值</th></tr>
        <tr><td><p>速度</p></td><td>42</td></tr>
      </table>
      <iframe src="https://invalid.example">不可信框架</iframe>
      <style>.reader { display: none }</style>
    `);

    expect(blocks).toEqual([
      { type: "heading", id: "docx-heading-0", level: 1, text: "可信标题" },
      { type: "paragraph", text: "安全的 链接文字" },
      { type: "list", ordered: false, items: ["第一项", "第二项"] },
      {
        type: "table",
        rows: [
          [
            { text: "名称", header: true },
            { text: "值", header: true },
          ],
          [
            { text: "速度", header: false },
            { text: "42", header: false },
          ],
        ],
      },
    ]);
    expect(JSON.stringify(blocks)).not.toMatch(/onclick|javascript:|onerror|alert|iframe|style/iu);
  });

  it("maps heading anchors onto existing plain-text chunks in document order", () => {
    const text = "第一章\n\n过渡段落。\n\n第一章\n\n章节内容。\n\n第二章\n\n结尾。";
    const blocks: DocxBlock[] = [
      { type: "paragraph", text: "第一章" },
      { type: "paragraph", text: "过渡段落。" },
      { type: "heading", id: "docx-heading-0", level: 1, text: "第一章" },
      { type: "paragraph", text: "章节内容。" },
      { type: "heading", id: "docx-heading-1", level: 2, text: "第二章" },
      { type: "paragraph", text: "结尾。" },
    ];
    const chunks = chunkText(text, "source", "version");
    const originalIdentity = chunks.map((chunk) => [chunk.id, chunk.text]);

    const sectioned = applyDocxSections(chunks, text, blocks);

    expect(sectioned.map((chunk) => chunk.section)).toEqual([
      "正文",
      "正文",
      "第一章",
      "第一章",
      "第二章",
      "第二章",
    ]);
    expect(sectioned.map((chunk) => [chunk.id, chunk.text])).toEqual(originalIdentity);
  });

  it("does not guess a table position after raw and structured text disagree", () => {
    const blocks = parseDocxHtml(
      "<p>提取内容不一致</p><table><tr><td>学习率</td><td>0.001</td></tr></table>",
    );
    const result = docxTableEvidenceRanges("未识别的原文\n\n学习率\n\n0.001", blocks, 1200);
    expect(result.ranges).toEqual([]);
    expect(result.messages).toEqual([
      expect.stringContaining("第 1 个表格结构与原文位置无法可靠对应"),
    ]);
  });
});
