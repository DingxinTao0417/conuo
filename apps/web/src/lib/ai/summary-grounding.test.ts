import { describe, expect, it } from "vitest";
import { buildSummaryGrounding, groundingMessages, parseGeneratedAnswer } from "./grounding";
import type { AnswerRequest, WorkspaceData } from "../types";

const workspace: WorkspaceData = {
  schemaVersion: 1,
  aiEnabled: true,
  spaces: [
    { id: "space-a", name: "A", goal: "", color: "", archived: false, createdAt: "2026-01-01" },
  ],
  sources: [
    {
      id: "source-a",
      versionId: "v1",
      title: "资料",
      filename: "a.md",
      kind: "markdown",
      mime: "text/markdown",
      size: 10,
      hash: "a",
      spaceIds: ["space-a"],
      tags: [],
      status: "ready",
      text: "第一章原文\n第二章原文",
      chunks: [
        {
          id: "c1",
          sourceId: "source-a",
          versionId: "v1",
          text: "第一章原文",
          section: "第一章",
          order: 0,
          page: 1,
        },
        {
          id: "c2",
          sourceId: "source-a",
          versionId: "v1",
          text: "第二章原文",
          section: "第二章",
          order: 1,
          page: 2,
        },
      ],
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      deletedAt: null,
      aiAllowed: true,
      starred: false,
    },
  ],
  notes: [],
  annotations: [],
  conversations: [],
};
const request: AnswerRequest = {
  question: "总结这份资料",
  scope: "document",
  sourceId: "source-a",
  sourceIds: [],
  spaceId: "space-a",
};
const rows = [
  {
    level: "section" as const,
    sectionIndex: 0,
    title: "第一章",
    chunkIds: ["c1"],
    summary: { paragraphs: [{ text: "第一章摘要", chunkIds: ["c1"] }] },
  },
  {
    level: "section" as const,
    sectionIndex: 1,
    title: "第二章",
    chunkIds: ["c2"],
    summary: { paragraphs: [{ text: "第二章摘要", chunkIds: ["c2"] }] },
  },
  {
    level: "document" as const,
    sectionIndex: 0,
    title: "全书摘要",
    chunkIds: ["c1", "c2"],
    summary: { paragraphs: [{ text: "全书导航", chunkIds: ["c1"] }] },
  },
];

describe("summary grounding", () => {
  it("sends summaries as navigation and only original chunks as evidence", () => {
    const grounding = buildSummaryGrounding(workspace, request, rows);
    expect(grounding?.layout).toBe("summary");
    expect(grounding?.summarySections?.map((item) => item.text)).toEqual([
      "第一章摘要",
      "第二章摘要",
    ]);
    const messages = groundingMessages(grounding!, request);
    expect(messages[0]?.content).toContain("never cite them");
    expect(messages[1]?.content).toContain("sectionSummaries");
    expect(messages[1]?.content).toContain('"id":"e1"');
    expect(messages[1]?.content).toContain('"id":"s1"');
    expect(
      JSON.parse(messages[1]!.content).evidence.map((item: { id: string }) => item.id),
    ).not.toContain("s1");
  });

  it("restricts a chapter question to that chapter's chunks", () => {
    const grounding = buildSummaryGrounding(
      workspace,
      { ...request, question: "第三章讲了什么" },
      rows,
    );
    expect(grounding).toBeNull();
    const second = buildSummaryGrounding(
      workspace,
      { ...request, question: "第二章讲了什么" },
      rows,
    );
    expect(second?.evidence.map((item) => item.chunkId)).toEqual(["c2"]);
  });

  it("rejects summary IDs in generated citations", () => {
    const grounding = buildSummaryGrounding(workspace, request, rows)!;
    expect(() =>
      parseGeneratedAnswer(
        JSON.stringify({
          status: "answered",
          paragraphs: [{ text: "x", evidenceIds: ["s1"], kind: "source" }],
        }),
        grounding,
      ),
    ).toThrow();
  });
});
