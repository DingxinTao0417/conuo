import { describe, expect, it } from "vitest";
import {
  SUMMARY_CONTRACT_VERSION,
  buildSummarySections,
  bindSummaryOutput,
  parseSummaryOutput,
  sectionSummaryPrompt,
} from "./source-summary";

const chunk = (id: string, order: number, text: string, page?: number) => ({
  id,
  sourceId: "source-a",
  versionId: "version-a",
  text,
  section: "body",
  order,
  ...(page === undefined ? {} : { page }),
});

describe("source summaries", () => {
  it("builds page-bound sections from an outline", () => {
    const sections = buildSummarySections(
      [chunk("e1", 0, "前言", 1), chunk("e2", 1, "第一章内容", 3), chunk("e3", 2, "第二章内容", 8)],
      [
        { title: "第一章", level: 1, page: 3 },
        { title: "第二章", level: 1, page: 8 },
      ],
    );
    expect(sections.map(({ title, chunks }) => [title, chunks.map((item) => item.id)])).toEqual([
      ["前言", ["e1"]],
      ["第一章", ["e2"]],
      ["第二章", ["e3"]],
    ]);
  });

  it("uses sequential windows without an outline and splits oversized sections", () => {
    const sections = buildSummarySections(
      [chunk("e1", 0, "a".repeat(8_000), 1), chunk("e2", 1, "b".repeat(8_000), 2)],
      null,
    );
    expect(sections.length).toBe(2);
    expect(sections[0]?.title).toContain("第 1 页");
    expect(sections[1]?.title).toContain("第 2 页");

    const split = buildSummarySections(
      [chunk("e3", 0, "c".repeat(8_000), 1), chunk("e4", 1, "d".repeat(8_000), 1)],
      [{ title: "第一章", level: 1, page: 1 }],
    );
    expect(split.map((item) => item.title)).toEqual(["第一章", "第一章（续）"]);
  });

  it("merges adjacent sections to the sixty section limit", () => {
    const sections = buildSummarySections(
      Array.from({ length: 61 }, (_, index) => chunk(`e${index}`, index, "x", index + 1)),
      Array.from({ length: 61 }, (_, index) => ({
        title: `第${index + 1}章`,
        level: 1,
        page: index + 1,
      })),
    );
    expect(sections.length).toBeLessThanOrEqual(60);
  });

  it("binds only original evidence IDs and rejects summary IDs", () => {
    expect(
      parseSummaryOutput(
        '{"title":"章","paragraphs":[{"text":"结论","evidenceIds":["e1"]},{"text":"条件","evidenceIds":["e1"]}]}',
      ),
    ).toEqual({
      title: "章",
      paragraphs: [
        { text: "结论", evidenceIds: ["e1"] },
        { text: "条件", evidenceIds: ["e1"] },
      ],
    });
    expect(() =>
      parseSummaryOutput(
        '{"title":"章","paragraphs":[{"text":"结论","evidenceIds":["s1"]},{"text":"条件","evidenceIds":["e1"]}]}',
      ),
    ).toThrow();
    expect(
      bindSummaryOutput(
        {
          title: "章",
          paragraphs: [
            { text: "结论", evidenceIds: ["e1"] },
            { text: "条件", evidenceIds: ["e1"] },
          ],
        },
        [{ id: "e1", text: "原文" }],
      ),
    ).toEqual({
      title: "章",
      paragraphs: [
        { text: "结论", chunkIds: ["e1"] },
        { text: "条件", chunkIds: ["e1"] },
      ],
    });
    expect(SUMMARY_CONTRACT_VERSION).toBe("summary-v1");
    expect(sectionSummaryPrompt).toContain("Return ONLY JSON");
  });
});
