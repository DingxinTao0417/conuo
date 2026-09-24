import { describe, expect, it } from "vitest";
import { buildGrounding, bindGeneratedAnswer, groundingMessages } from "../src/lib/ai/grounding";
import { callModel, readModelConfig } from "../src/lib/ai/model";
import { buildEvalWorkspace } from "./lib/corpus";
import { loadEvalDataset } from "./lib/dataset";
import { judgeAnswer, readJudgeConfig } from "./lib/judge";
import { toAnswerRequest } from "./lib/requests";
import { writeModelReport } from "./lib/report";
import { retrieveEvidence } from "../src/lib/retrieval";

describe.skipIf(process.env.CONUO_EVAL_MODEL !== "1")("model evaluation", () => {
  it("is enabled only by explicit local configuration", () => {
    const config = readModelConfig();
    if (!config)
      throw new Error("Set CONUO_MODEL_BASE_URL, CONUO_MODEL_API_KEY, and CONUO_MODEL_NAME first.");
    const judgeConfig = readJudgeConfig();
    if (!judgeConfig) throw new Error("Set a model configuration for the evaluator or judge.");
    const maxRaw = process.env.CONUO_EVAL_MAX_CASES?.trim() || "20";
    const maxCases = Number(maxRaw);
    if (!Number.isInteger(maxCases) || maxCases < 1 || maxCases > 200)
      throw new Error("CONUO_EVAL_MAX_CASES must be an integer from 1 to 200.");
    expect(process.env.CONUO_EVAL_MODEL).toBe("1");
  });

  it("answers the selected core dataset and records judge metrics", async () => {
    const config = readModelConfig();
    if (!config)
      throw new Error("Set CONUO_MODEL_BASE_URL, CONUO_MODEL_API_KEY, and CONUO_MODEL_NAME first.");
    const judgeConfig = readJudgeConfig();
    if (!judgeConfig) throw new Error("Set a model configuration for the evaluator or judge.");
    const maxCases = Math.min(
      200,
      Math.max(1, Number(process.env.CONUO_EVAL_MAX_CASES?.trim() || "20")),
    );
    const data = buildEvalWorkspace();
    const results: Array<Record<string, unknown>> = [];
    const started = Date.now();
    for (const item of loadEvalDataset().slice(0, maxCases)) {
      const request = toAnswerRequest(data, item);
      const grounding = buildGrounding(data, request, retrieveEvidence(data, request));
      const began = Date.now();
      try {
        const raw = await callModel(config, groundingMessages(grounding, request));
        const answer = bindGeneratedAnswer(raw, grounding);
        try {
          const judge = await judgeAnswer(judgeConfig, item, answer, grounding);
          results.push({ id: item.id, latencyMs: Date.now() - began, judge });
        } catch (error) {
          results.push({
            id: item.id,
            latencyMs: Date.now() - began,
            judgeFailure: error instanceof Error ? error.message : "JUDGE_FAILURE",
          });
        }
      } catch (error) {
        results.push({
          id: item.id,
          latencyMs: Date.now() - began,
          formatFailure: error instanceof Error ? error.message : "MODEL_FAILURE",
        });
      }
    }
    const judged = results.flatMap((result) =>
      result.judge
        ? [
            result.judge as {
              keyPoints: Array<{ covered: boolean }>;
              paragraphs: Array<{ support: string }>;
              insufficientCorrect: boolean | null;
              violations: string[];
            },
          ]
        : [],
    );
    const paragraphs = judged.flatMap((judge) => judge.paragraphs);
    const supportDenominator = paragraphs.filter((paragraph) =>
      ["supported", "partial", "unsupported"].includes(paragraph.support),
    ).length;
    const metrics = {
      formatValidRate: results.filter((result) => !result.formatFailure).length / results.length,
      citationSupportRate: supportDenominator
        ? paragraphs.filter((paragraph) => paragraph.support === "supported").length /
          supportDenominator
        : 1,
      insufficientAccuracy: judged.length
        ? judged.filter(
            (judge) => judge.insufficientCorrect === true || judge.insufficientCorrect === null,
          ).length / judged.length
        : 0,
      keyPointCoverage: judged.flatMap((judge) => judge.keyPoints).length
        ? judged.flatMap((judge) => judge.keyPoints).filter((point) => point.covered).length /
          judged.flatMap((judge) => judge.keyPoints).length
        : 1,
      violationRate: judged.length
        ? judged.filter((judge) => judge.violations.length > 0).length / judged.length
        : 0,
      p50LatencyMs: percentile(
        results.map((result) => Number(result.latencyMs)),
        0.5,
      ),
      p95LatencyMs: percentile(
        results.map((result) => Number(result.latencyMs)),
        0.95,
      ),
      durationMs: Date.now() - started,
    };
    writeModelReport({ metrics, results });
    expect(results.length).toBeGreaterThan(0);
  });
});

function percentile(values: number[], percentileValue: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)]!;
}
