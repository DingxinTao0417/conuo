import { describe, expect, it } from "vitest";
import { evalCaseSchema, loadEvalDataset } from "./dataset";

describe("evaluation dataset", () => {
  it("loads the committed core dataset and covers every category", () => {
    const cases = loadEvalDataset();
    expect(cases.length).toBeGreaterThanOrEqual(60);
    expect(new Set(cases.map((item) => item.category)).size).toBe(15);
  });

  it("rejects unknown fields and malformed IDs", () => {
    expect(() =>
      evalCaseSchema.parse({
        id: "Bad ID",
        category: "summary",
        question: "x",
        scope: { type: "document", doc: "ml" },
        expect: { answerable: true, extra: true },
      }),
    ).toThrow();
  });
});
