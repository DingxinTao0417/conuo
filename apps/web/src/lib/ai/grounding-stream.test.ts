import { describe, expect, it } from "vitest";
import { bindGeneratedAnswer, type Grounding } from "./grounding";
import { createGroundingPreview } from "./grounding-stream";

const grounding: Grounding = {
  evidence: [
    {
      sourceId: "source-1",
      versionId: "v1",
      chunkId: "c1",
      title: "原文一",
      quote: "原文一内容。",
      section: "第一节",
      page: 2,
    },
    {
      sourceId: "source-2",
      versionId: "v2",
      chunkId: "c2",
      title: "原文二",
      quote: "原文二内容。",
      section: "第二节",
    },
  ],
  noteEvidence: [],
  coverage: "仅覆盖这两个片段。",
  layout: "retrieval",
  fallback: { mode: "extractive", content: "原文", citations: [] },
};
const first = { text: "第一段", evidenceIds: ["e2"], kind: "source" };
const second = {
  kind: "inference",
  text: '第二段包含 } ] \\" 引号与\n换行。![图](https://external.test)',
  evidenceIds: ["e1", "e2", "e1"],
};
const raw = JSON.stringify({ status: "answered", paragraphs: [first, second] });

describe("grounded streaming preview", () => {
  it("emits a complete cited paragraph before the provider has completed its JSON", () => {
    const preview = createGroundingPreview(grounding);
    expect(preview.push('{"status":"answered","paragraphs":[{"text":"第一')).toBeUndefined();
    const answer = preview.push('段","evidenceIds":["e2"],"kind":"source"}');
    expect(answer).toEqual(
      bindGeneratedAnswer(JSON.stringify({ status: "answered", paragraphs: [first] }), grounding),
    );
    expect(answer?.citations).toEqual([grounding.evidence[1]]);
    expect(preview.push(",")).toBeUndefined();
    const secondAnswer = preview.push(JSON.stringify(second));
    expect(secondAnswer).toEqual(bindGeneratedAnswer(raw, grounding));
    expect(preview.push("]}")).toBeUndefined();
  });

  it("supports every two-piece split including escapes and any JSON key order", () => {
    const reordered = JSON.stringify({ paragraphs: [second, first], status: "answered" });
    for (const value of [raw, reordered]) {
      for (let split = 0; split <= value.length; split++) {
        const preview = createGroundingPreview(grounding);
        const a = preview.push(value.slice(0, split));
        const b = preview.push(value.slice(split));
        expect(b ?? a).toEqual(bindGeneratedAnswer(value, grounding));
      }
    }
  });

  it("handles character-by-character unicode escapes and never exposes a partial field", () => {
    const value =
      '{"status":"answered","paragraphs":[{"evidenceIds":["e1"],"text":"\\u4e2d\\u6587 \\ud83d\\ude00 \\"quoted\\"","kind":"source"}]}';
    const preview = createGroundingPreview(grounding);
    const outputs = [...value].map((char) => preview.push(char)).filter(Boolean);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toEqual(bindGeneratedAnswer(value, grounding));
  });

  it("waits for answered status when the paragraph array arrives first", () => {
    const preview = createGroundingPreview(grounding);
    expect(preview.push(`{"paragraphs":[${JSON.stringify(first)}],"status":"ans`)).toBeUndefined();
    expect(preview.push('wered"')).toEqual(
      bindGeneratedAnswer(JSON.stringify({ status: "answered", paragraphs: [first] }), grounding),
    );
    expect(preview.push("}")).toBeUndefined();
  });

  it("does not invent a draft for insufficient evidence", () => {
    const preview = createGroundingPreview(grounding);
    expect(preview.push('{"status":"insufficient","paragraphs":[]}')).toBeUndefined();
  });

  it("uses the rich binder for streaming previews", () => {
    const preview = createGroundingPreview(grounding, { format: "rich" });
    const value =
      '{"status":"answered","paragraphs":[{"text":"设 $x^2$ 为平方","evidenceIds":["e1"],"kind":"source"}]}';
    expect(preview.push(value)?.content).toContain("$$x^2$$");
  });

  it("rejects a quantified self-rating before the first draft and never exposes it", () => {
    const preview = createGroundingPreview(grounding);
    const selfRated = {
      text: "本回答的可信度为 95%。",
      evidenceIds: ["e1"],
      kind: "source",
    };
    expect(preview.push('{"status":"answered","paragraphs":[')).toBeUndefined();
    expect(() => preview.push(JSON.stringify(selfRated))).toThrowError(/不可核验的量化自评/);
  });

  it("keeps an earlier safe draft but never exposes a later self-rating", () => {
    const preview = createGroundingPreview(grounding);
    const selfRated = {
      text: "Confidence: 95%.",
      evidenceIds: ["e1"],
      kind: "source",
    };
    const safeDraft = preview.push(`{"status":"answered","paragraphs":[${JSON.stringify(first)}`);

    expect(safeDraft?.content).toContain(first.text);
    expect(() => preview.push(`,${JSON.stringify(selfRated)}`)).toThrowError(/不可核验的量化自评/);
  });

  it.each([
    '{"status":"answered","status":"answered","paragraphs":[]}',
    '{"paragraphs":[],"paragraphs":[],"status":"answered"}',
    '{"status":"answered","unknown":"value"}',
    '{"status":"answered","paragraphs":[{"text":"x","text":"y","evidenceIds":["e1"],"kind":"source"}]}',
    '{"status":"answered","paragraphs":[{"text":"x","evidenceIds":["e1"],"kind":"source","extra":"bad"}]}',
    '{"status":"answered","paragraphs":[{"text":"x","evidenceIds":["e99"],"kind":"source"}]}',
    '{"status":"answered","paragraphs":[{"text":"x","evidenceIds":[],"kind":"source"}]}',
    '{"status":"answered","paragraphs":[],}',
    '{"status":"answered","paragraphs":[,]}',
    '{"status":"answered","paragraphs":[{"text":"x","evidenceIds":["e1",],"kind":"source"}]}',
    '{"status":"answered","paragraphs":[null]}',
    '{"status":"answered","paragraphs":[{"text":true}]}',
    '{"status":"answered","paragraphs":[{"text":"\\q"}]}',
    '{"status":"insufficient","paragraphs":[' + JSON.stringify(first) + "]}",
    '{"paragraphs":[' + JSON.stringify(first) + '],"status":"insufficient"}',
    raw + raw,
    "```json\n" + raw,
    " ".repeat(32_001),
  ])("rejects malformed, ambiguous or out-of-scope JSON without repairing it %#", (value) => {
    const preview = createGroundingPreview(grounding);
    expect(() => preview.push(value)).toThrow();
    expect(() => preview.push(raw)).toThrow();
  });

  it("fails a later invalid paragraph even after an earlier draft was emitted", () => {
    const preview = createGroundingPreview(grounding);
    expect(
      preview.push(`{"status":"answered","paragraphs":[${JSON.stringify(first)}`),
    ).toBeDefined();
    expect(() =>
      preview.push("," + JSON.stringify({ ...second, evidenceIds: ["e13"] })),
    ).toThrowError(/引用/);
  });

  it("does not treat an unfinished root as a valid final answer", () => {
    const prefix = `{"status":"answered","paragraphs":[${JSON.stringify(first)}`;
    expect(createGroundingPreview(grounding).push(prefix)).toBeDefined();
    expect(() => bindGeneratedAnswer(prefix, grounding)).toThrowError(/格式不完整/);
  });
});
