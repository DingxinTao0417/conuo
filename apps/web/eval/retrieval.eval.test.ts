import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildEvalWorkspace } from "./lib/corpus";
import { loadEvalDataset } from "./lib/dataset";
import { toAnswerRequest } from "./lib/requests";
import { writeEvalReport, writeRetrievalBaseline } from "./lib/report";
import { evaluateRetrieval } from "./lib/retrieval-metrics";

describe("offline retrieval evaluation", () => {
  it("keeps the WP-01 retrieval baseline and isolation boundary", () => {
    const workspace = buildEvalWorkspace();
    const cases = loadEvalDataset();
    const result = evaluateRetrieval(workspace, cases, {
      toRequest: (item) => toAnswerRequest(workspace, item),
      writeReport: false,
    });
    if (process.env.CONUO_EVAL_UPDATE_BASELINE === "1") writeRetrievalBaseline(result);
    const baseline = JSON.parse(readFileSync("eval/baselines/retrieval.json", "utf8")) as {
      contract: string;
      overall: number;
      categories: Record<string, number>;
    };
    expect(result.contract).toBe(baseline.contract);
    expect(result.overall.evidenceHitRate).toBeGreaterThanOrEqual(baseline.overall - 0.02);
    for (const [category, score] of Object.entries(baseline.categories))
      expect(result.categories[category]?.evidenceHitRate ?? 0).toBeGreaterThanOrEqual(
        score - 0.02,
      );
    writeEvalReport("retrieval-grounding-v7", result);
    expect(result.overall.evidenceHitRate).toBeGreaterThanOrEqual(0.9);
    expect(result.isolationFailures).toHaveLength(0);
  });
});
