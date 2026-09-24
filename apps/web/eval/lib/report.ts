import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const reportDir = resolve(process.cwd(), "../../work/eval");

export function writeEvalReport(name: string, report: unknown): string {
  mkdirSync(reportDir, { recursive: true });
  const path = resolve(reportDir, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

export function writeRetrievalBaseline(report: {
  contract: string;
  overall: { evidenceHitRate: number };
  categories: Record<string, { evidenceHitRate: number }>;
}): string {
  const path = resolve(process.cwd(), "eval/baselines/retrieval.json");
  mkdirSync(resolve(process.cwd(), "eval/baselines"), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ contract: report.contract, overall: report.overall.evidenceHitRate, categories: Object.fromEntries(Object.entries(report.categories).map(([key, value]) => [key, value.evidenceHitRate])) }, null, 2)}\n`,
    "utf8",
  );
  return path;
}

export function writeModelReport(report: unknown): { jsonPath: string; markdownPath: string } {
  mkdirSync(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = resolve(reportDir, `model-${stamp}`);
  mkdirSync(directory, { recursive: true });
  const jsonPath = resolve(directory, "report.json");
  const markdownPath = resolve(directory, "summary.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const summary = report as {
    metrics?: Record<string, number>;
    results?: Array<{ id: string; formatFailure?: string; judgeFailure?: string }>;
  };
  writeFileSync(
    markdownPath,
    `# Model evaluation\n\n${Object.entries(summary.metrics ?? {})
      .map(([key, value]) => `- ${key}: ${value}`)
      .join("\n")}\n`,
    "utf8",
  );
  return { jsonPath, markdownPath };
}
