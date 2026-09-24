import { describe, expect, it } from "vitest";
import type { Citation } from "../types";
import {
  GLOSSARY_CONTRACT_VERSION,
  bindGlossaryOutput,
  glossaryMessages,
  appendGlossaryAliases,
} from "./glossary";

const evidence: Citation[] = [
  {
    sourceId: "source-a",
    versionId: "v1",
    chunkId: "chunk-1",
    title: "资料 A",
    quote: "梯度下降是一种优化算法。",
    section: "第一章",
  },
  {
    sourceId: "source-a",
    versionId: "v1",
    chunkId: "chunk-2",
    title: "资料 A",
    quote: "学习率决定每一步更新的幅度。",
    section: "第二章",
  },
];

describe("glossary model contract", () => {
  it("uses glossary-v1 and binds model evidence ids to source refs", () => {
    expect(GLOSSARY_CONTRACT_VERSION).toBe("glossary-v1");
    const result = bindGlossaryOutput(
      JSON.stringify({
        terms: [
          {
            term: "梯度下降",
            aliases: ["gradient descent"],
            definition: "一种优化算法。",
            evidenceIds: ["e1", "e2"],
          },
          { term: "学习率", aliases: [], definition: "更新步长。", evidenceIds: ["e2"] },
          {
            term: "优化算法",
            aliases: [],
            definition: "用于改进目标的算法。",
            evidenceIds: ["e1"],
          },
          { term: "参数更新", aliases: [], definition: "根据梯度调整参数。", evidenceIds: ["e1"] },
          { term: "训练步长", aliases: [], definition: "每次更新的幅度。", evidenceIds: ["e2"] },
        ],
      }),
      evidence,
    );
    expect(result.terms[0]).toEqual({
      term: "梯度下降",
      aliases: ["gradient descent"],
      definition: "一种优化算法。",
      chunkRefs: [
        { sourceId: "source-a", versionId: "v1", chunkId: "chunk-1" },
        { sourceId: "source-a", versionId: "v1", chunkId: "chunk-2" },
      ],
    });
  });

  it("rejects malformed JSON, extra fields, and out-of-range evidence ids", () => {
    expect(() => bindGlossaryOutput("{}", evidence)).toThrow("INVALID_GLOSSARY_OUTPUT");
    expect(() =>
      bindGlossaryOutput(
        JSON.stringify({
          terms: [{ term: "x", aliases: [], definition: "d", evidenceIds: ["e3"], extra: true }],
        }),
        evidence,
      ),
    ).toThrow("INVALID_GLOSSARY_OUTPUT");
  });

  it("builds a static and dynamic prompt without sending internal ids", () => {
    const messages = glossaryMessages(evidence);
    expect(messages[0].content).toContain("untrusted data");
    expect(messages[1].content).toContain('"id":"e1"');
    expect(messages[1].content).not.toContain("source-a");
    expect(messages[1].content).not.toContain("chunk-1");
  });

  it("adds only other aliases when a term or alias appears and stays within 4000 chars", () => {
    const terms = [
      {
        termId: "t1",
        term: "梯度下降",
        aliases: ["gradient descent", "GD"],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        termId: "t2",
        term: "学习率",
        aliases: ["learning rate"],
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ];
    const expanded = appendGlossaryAliases("解释 gradient descent", terms);
    expect(expanded.query).toContain("GD");
    expect(expanded.query).not.toContain("learning rate");
    expect(expanded.fingerprint).toContain("t1");
    expect(appendGlossaryAliases("x".repeat(3999), terms).query.length).toBeLessThanOrEqual(4000);
  });
});
