import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const evalCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{3,80}$/),
    category: z.enum([
      "single-early",
      "single-middle",
      "single-late",
      "cross-doc",
      "comparison",
      "summary",
      "no-answer",
      "conflict",
      "partial-parse",
      "cross-language",
      "follow-up",
      "selection",
      "injection",
      "isolation",
      "formula",
    ]),
    question: z.string().min(1).max(4000),
    userContext: z.array(z.string().min(1).max(800)).max(6).optional(),
    scope: z.discriminatedUnion("type", [
      z.object({ type: z.literal("document"), doc: z.string() }).strict(),
      z.object({ type: z.literal("selection"), doc: z.string(), selection: z.string() }).strict(),
      z.object({ type: z.literal("sources"), docs: z.array(z.string()).min(1).max(10) }).strict(),
      z.object({ type: z.literal("space"), space: z.string() }).strict(),
    ]),
    expect: z
      .object({
        answerable: z.boolean(),
        evidence: z
          .array(z.object({ doc: z.string(), contains: z.string().min(4) }).strict())
          .default([]),
        evidenceMode: z.enum(["any", "all"]).default("any"),
        forbiddenDocs: z.array(z.string()).default([]),
        keyPoints: z.array(z.string().min(2)).default([]),
        mustNotSay: z.array(z.string().min(2)).default([]),
      })
      .strict(),
    notes: z.string().optional(),
  })
  .strict();

export type EvalCase = z.infer<typeof evalCaseSchema>;

const datasetPath = fileURLToPath(new URL("../datasets/core.jsonl", import.meta.url));

export function loadEvalDataset(path = datasetPath): EvalCase[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, index }) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`Invalid evaluation JSON on line ${index + 1}`);
      }
      const parsed = evalCaseSchema.safeParse(value);
      if (!parsed.success)
        throw new Error(
          `Invalid evaluation case on line ${index + 1}: ${JSON.stringify(parsed.error.issues)}`,
        );
      return parsed.data;
    });
}
