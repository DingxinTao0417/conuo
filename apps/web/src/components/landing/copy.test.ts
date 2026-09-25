import { describe, expect, it } from "vitest";
import { authCopy } from "./auth-copy";
import { landingCopy } from "./copy";
import { answerCitations, blockLength, revealedRefs, splitHeadline, tokenizeInline } from "./text";

/** Structural fingerprint: keys and array lengths, ignoring the text itself. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item)]));
  return typeof value;
}

describe("homepage copy", () => {
  it("keeps the Chinese and English homepages structurally identical", () => {
    expect(shape(landingCopy.en)).toEqual(shape(landingCopy.zh));
    expect(shape(authCopy.en)).toEqual(shape(authCopy.zh));
  });

  it("only cites paragraphs that exist in the sample document", () => {
    for (const lang of ["zh", "en"] as const) {
      const ids = landingCopy[lang].demo.paragraphs.map((paragraph) => paragraph.id);
      for (const question of landingCopy[lang].demo.questions) {
        const refs = answerCitations(question.answer);
        expect(refs.length, question.id).toBeGreaterThan(0);
        for (const ref of refs) expect(ids).toContain(ref);
      }
    }
  });

  it("uses the same citations for each question in both languages", () => {
    landingCopy.zh.demo.questions.forEach((question, index) => {
      expect(answerCitations(landingCopy.en.demo.questions[index].answer)).toEqual(
        answerCitations(question.answer),
      );
    });
  });

  it("does not advertise pricing or invented usage numbers", () => {
    const text = JSON.stringify(landingCopy);
    expect(text).not.toMatch(/免费|free|\d+\s*(万|k\+|users|用户)/i);
  });

  it("marks unreleased native clients as not yet available", () => {
    for (const lang of ["zh", "en"] as const) {
      const statuses = landingCopy[lang].platforms.items.map((item) => item.status);
      expect(statuses.filter((status) => status === "available")).toHaveLength(1);
      expect(landingCopy[lang].platforms.items[0].name).toBe("Web");
    }
  });

  it("finds each highlight inside its hero headline", () => {
    for (const lang of ["zh", "en"] as const) {
      const hero = landingCopy[lang].hero;
      expect(hero.titleLines.join(" ")).toContain(hero.highlight);
    }
  });
});

describe("inline answer tokens", () => {
  it("splits bold runs and citation markers", () => {
    expect(tokenizeInline("a **b** c {2}.")).toEqual([
      { kind: "text", value: "a ", bold: false },
      { kind: "text", value: "b", bold: true },
      { kind: "text", value: " c ", bold: false },
      { kind: "cite", ref: 2 },
      { kind: "text", value: ".", bold: false },
    ]);
  });

  it("reveals citations only once the stream reaches them", () => {
    const blocks = [{ kind: "p" as const, text: "ab{1}cd{2}" }];
    expect(blockLength(blocks[0])).toBe(6);
    expect([...revealedRefs(blocks, 2)]).toEqual([]);
    expect([...revealedRefs(blocks, 3)]).toEqual([1]);
    expect([...revealedRefs(blocks, 6)]).toEqual([1, 2]);
  });
});

describe("headline splitting", () => {
  it("animates Chinese per character and marks the highlight", () => {
    const units = splitHeadline("知识学会。", "学会", "zh");
    expect(units.map((unit) => unit.text)).toEqual(["知", "识", "学", "会", "。"]);
    expect(units.filter((unit) => unit.highlight).map((unit) => unit.text)).toEqual(["学", "会"]);
  });

  it("animates English per word and keeps spaces", () => {
    const units = splitHeadline("to really knowing.", "really knowing.", "en");
    expect(units.map((unit) => unit.text)).toEqual(["to", " ", "really", " ", "knowing."]);
    expect(units.filter((unit) => unit.highlight && !unit.space)).toHaveLength(2);
  });
});
