import { describe, expect, it } from "vitest";
import {
  EXPLAIN_CONTRACT_VERSION,
  GRADING_CONTRACT_VERSION,
  bindExplainFeedback,
  bindGradeResult,
  bindHintResult,
} from "./grading";

const evidence = [
  {
    sourceId: "source-1",
    versionId: "version-1",
    chunkId: "chunk-1",
    title: "学习率",
    quote: "学习率决定每次更新的步长。",
    section: "概念",
  },
];

describe("learning feedback model contracts", () => {
  it("uses the three WP-23 contract versions", () => {
    expect(GRADING_CONTRACT_VERSION).toBe("grading-v1");
    expect(EXPLAIN_CONTRACT_VERSION).toBe("explain-v1");
  });

  it("binds grade evidence and rejects out-of-range ids", () => {
    expect(
      bindGradeResult(
        JSON.stringify({
          verdict: "partial",
          covered: [0],
          missing: [1],
          misconceptions: [{ text: "错误理解", evidenceIds: ["e1"] }],
          feedback: "先肯定正确部分，再补充缺口。",
          evidenceIds: ["e1"],
        }),
        evidence,
        2,
      ),
    ).toMatchObject({ evidence: evidence });
    expect(() =>
      bindGradeResult(
        JSON.stringify({
          verdict: "correct",
          covered: [3],
          missing: [],
          misconceptions: [],
          feedback: "反馈",
          evidenceIds: ["e2"],
        }),
        evidence,
        2,
      ),
    ).toThrow("INVALID_MODEL_GRADING");
  });

  it("does not allow a hint to contain the full answer", () => {
    expect(() => bindHintResult(JSON.stringify({ hint: "步长", level: 1 }), "步长", 1)).toThrow(
      "INVALID_MODEL_HINT",
    );
    expect(bindHintResult(JSON.stringify({ hint: "想想更新幅度", level: 1 }), "步长", 1)).toEqual({
      hint: "想想更新幅度",
      level: 1,
    });
  });

  it("binds all four explain feedback buckets", () => {
    const result = bindExplainFeedback(
      JSON.stringify({
        covered: [{ text: "说对了", evidenceIds: ["e1"] }],
        missing: [],
        possiblyWrong: [],
        cannotJudge: [],
        feedback: "继续补充条件。",
      }),
      evidence,
    );
    expect(result.covered[0]?.citations).toEqual(evidence);
  });
});
