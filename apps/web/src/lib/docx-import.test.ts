import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as docxStructure from "./docx-structure";
import { buildGrounding } from "./ai/grounding";
import { parseImportSource, prepareImportFile } from "./import";
import { retrieveEvidence, resolveCitation } from "./retrieval";
import { createEmptyWorkspace } from "./seed";
import type { Source } from "./types";

// Use the real browser bundle selected by the app's bundler. Only module
// resolution changes: both raw extraction and HTML conversion remain real.
vi.mock("mammoth", async () => {
  const { createRequire } = await import("node:module");
  return createRequire(import.meta.url)("mammoth/mammoth.browser.js");
});

const escapeXml = (text: string) =>
  text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
const paragraph = (text: string, heading = false) =>
  `<w:p>${heading ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : ""}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
type Cell = string | string[];
const table = (rows: Cell[][]) =>
  `<w:tbl>${rows.map((row) => `<w:tr>${row.map((cell) => `<w:tc>${(Array.isArray(cell) ? cell : [cell]).map((text) => paragraph(text)).join("")}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;

async function docxFile(body: string) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/_rels/document.xml.rels",
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  );
  zip.file(
    "word/styles.xml",
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>',
  );
  zip.file(
    "word/document.xml",
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  );
  return new File([await zip.generateAsync({ type: "arraybuffer" })], "training.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

async function parse(body: string) {
  const file = await docxFile(body);
  const input = await prepareImportFile(file, "space-training", true);
  return { source: await parseImportSource(input, file, { originalSaved: false }), file };
}

function evidence(source: Source, question: string) {
  const data = createEmptyWorkspace();
  data.spaces[0].id = "space-training";
  data.sources = [source];
  const request = {
    question,
    scope: "document" as const,
    sourceId: source.id,
    sourceIds: [],
    spaceId: "space-training",
  };
  const result = retrieveEvidence(data, request);
  expect(result.citations.every((citation) => resolveCitation(data, citation))).toBe(true);
  expect(buildGrounding(data, request, result).evidence).toEqual(result.citations);
  return result;
}

function expectCanonical(source: Source) {
  expect(
    source.chunks.every((chunk) => source.text.includes(chunk.text) && chunk.text.length <= 1200),
  ).toBe(true);
  expect(
    source.chunks.every(
      (chunk) =>
        chunk.sourceId === source.id &&
        chunk.versionId === source.versionId &&
        chunk.section.length <= 512,
    ),
  ).toBe(true);
  expect(source.chunks.map((chunk) => chunk.order)).toEqual(source.chunks.map((_, index) => index));
  expect(
    source.chunks
      .map((chunk) => chunk.text)
      .join("")
      .replace(/\s/gu, ""),
  ).toBe(source.text.replace(/\s/gu, ""));
}

afterEach(() => vi.restoreAllMocks());

describe("real DOCX import and table evidence", () => {
  it("keeps parameter names and values together through parsing, chunking and retrieval", async () => {
    const { source } = await parse(
      paragraph("训练配置", true) +
        table([
          ["参数", "值"],
          ["学习率", "0.001"],
          ["批量大小", "64"],
        ]) +
        paragraph("以上为第一组配置。"),
    );
    expect(source.status).toBe("ready");
    expect(source.text).toBe(
      "训练配置\n\n参数\n\n值\n\n学习率\n\n0.001\n\n批量大小\n\n64\n\n以上为第一组配置。",
    );
    expectCanonical(source);
    const citations = evidence(source, "学习率是多少？").citations;
    expect(citations).toHaveLength(1);
    expect(citations[0].quote).toContain("学习率\n\n0.001");
    expect(citations[0].quote).toContain("批量大小\n\n64");
    expect(citations[0].section).toContain("训练配置 · 表格 1 · 第 1–3 行 · 2 列");
    expect(citations[0].section).toContain("1:“参数”；2:“值”");
  });

  it("retains multiple paragraphs within a cell and preserves their real column association", async () => {
    const { source, file } = await parse(
      table([
        ["参数", "说明"],
        ["学习率", ["0.001", "建议从这个值开始观察。"]],
        ["优化器", "Adam"],
      ]),
    );
    expect(source.status).toBe("ready");
    expectCanonical(source);
    const structure = await docxStructure.convertDocxToStructure(await file.arrayBuffer());
    expect(structure.blocks[0]).toMatchObject({
      rows: [
        [{}, {}],
        [{ text: "学习率" }, { text: "0.001 建议从这个值开始观察。" }],
        [{}, {}],
      ],
    });
    const citation = evidence(source, "学习率的建议是什么？").citations[0];
    expect(citation.quote).toContain("学习率\n\n0.001\n\n建议从这个值开始观察。");
    expect(citation.section).toContain("2 列");
    expect(citation.section).toContain("1:“参数”；2:“说明”");
  });

  it("bounds long tables at complete rows while retaining column context for late-row retrieval", async () => {
    const rows: Cell[][] = [["配置名", "学习率", "说明"]];
    for (let index = 1; index <= 80; index++)
      rows.push([
        `实验${index}号`,
        `0.${String(index).padStart(3, "0")}`,
        `第${index}次实验的推荐参数，观察损失后再调整。`,
      ]);
    const { source } = await parse(
      paragraph("实验表", true) + table(rows) + paragraph("表格后的完整说明。"),
    );
    expect(source.status).toBe("ready");
    expectCanonical(source);
    const tableChunks = source.chunks.filter((chunk) => chunk.section.includes("表格 1"));
    expect(tableChunks.length).toBeGreaterThan(2);
    for (const chunk of tableChunks) {
      const rowRange = chunk.section.match(/第 (\d+)–(\d+) 行/u)!;
      const first = Number(rowRange[1]);
      const last = Number(rowRange[2]);
      expect(
        chunk.text.startsWith(first === 1 ? "配置名\n\n学习率\n\n说明" : `实验${first - 1}号\n\n`),
      ).toBe(true);
      expect(chunk.text.endsWith(`第${last - 1}次实验的推荐参数，观察损失后再调整。`)).toBe(true);
    }
    const citation = evidence(source, "实验79号的学习率是多少？").citations.find((item) =>
      item.quote.includes("实验79号"),
    );
    expect(citation?.quote).toContain("实验79号\n\n0.079");
    expect(citation?.section).toContain("1:“配置名”；2:“学习率”；3:“说明”");
    expect(source.chunks.at(-1)?.text).toBe("表格后的完整说明。");
  });

  it("reports an oversized row as partial without fabricating a whole-table quote", async () => {
    const { source } = await parse(
      table([
        ["参数", "说明"],
        ["学习率", "调整参数。".repeat(350)],
      ]),
    );
    expect(source.status).toBe("partial");
    expect(source.coverage?.parseState).toBe("partial");
    expect(source.error).toContain("第 1 个表格单行超过证据块容量");
    expect(source.error).toContain("不保证该表格的行列关系");
    expect(source.chunks.every((chunk) => !chunk.section.includes("表格 1"))).toBe(true);
    expectCanonical(source);
  });

  it("does not assert ordinary column relationships for a real merged-cell table", async () => {
    const merged = `<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${paragraph("训练参数")}</w:tc></w:tr><w:tr><w:tc>${paragraph("学习率")}</w:tc><w:tc>${paragraph("0.001")}</w:tc></w:tr></w:tbl>`;
    const { source, file } = await parse(merged);
    expect(source.status).toBe("partial");
    expect(source.error).toContain("合并、嵌套、不规则或空单元格");
    expect(source.chunks.every((chunk) => !chunk.section.includes("表格 1"))).toBe(true);
    expectCanonical(source);
    const structure = await docxStructure.convertDocxToStructure(await file.arrayBuffer());
    expect(structure.blocks[0]).toMatchObject({ type: "table", unreliableLayout: true });
  });

  it("keeps a later confirmed table usable when an earlier table has unsupported layout", async () => {
    const { source } = await parse(
      table([["不规则表"], ["学习率", "未知值"]]) +
        paragraph("下一张表：") +
        table([
          ["参数", "值"],
          ["批量大小", "64"],
        ]),
    );
    expect(source.status).toBe("partial");
    expect(source.error).toContain("第 1 个表格");
    expectCanonical(source);
    const citation = evidence(source, "批量大小是多少？").citations[0];
    expect(citation.quote).toContain("批量大小\n\n64");
    expect(citation.section).toContain("表格 2");
  });

  it("keeps usable raw text when the optional structure conversion fails", async () => {
    vi.spyOn(docxStructure, "convertDocxToStructure").mockRejectedValueOnce(
      new Error("structure pass failed"),
    );
    const { source } = await parse(
      table([
        ["参数", "值"],
        ["学习率", "0.001"],
      ]),
    );
    expect(source.status).toBe("partial");
    expect(source.error).toContain("部分文档结构未能解析");
    expect(source.text).toContain("学习率\n\n0.001");
    expectCanonical(source);
    expect(evidence(source, "学习率").citations[0].quote).toBe("学习率");
  });
});
