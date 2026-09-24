import { buildGrounding } from "../../src/lib/ai/grounding";
import { retrieveEvidence } from "../../src/lib/retrieval";
import type { AnswerRequest, WorkspaceData } from "../../src/lib/types";
import type { EvalCase } from "./dataset";

export interface RetrievalCaseResult {
  id: string;
  category: EvalCase["category"];
  evidenceHit: boolean;
  isolationOk: boolean;
  evidenceCount: number;
}

export interface RetrievalEvaluation {
  contract: "grounding-v7";
  overall: { evidenceHitRate: number; count: number };
  categories: Record<string, { evidenceHitRate: number; count: number }>;
  cases: RetrievalCaseResult[];
  isolationFailures: string[];
}

export function evaluateRetrieval(
  data: WorkspaceData,
  cases: readonly EvalCase[],
  options: { toRequest: (item: EvalCase) => AnswerRequest; writeReport?: boolean },
): RetrievalEvaluation {
  const results = cases.map((item): RetrievalCaseResult => {
    const request = options.toRequest(item);
    const retrieved = retrieveEvidence(data, request);
    const grounding = buildGrounding(data, request, retrieved);
    const evidence = grounding.evidence;
    const evidenceHit = item.expect.evidence.length
      ? item.expect.evidenceMode === "all"
        ? item.expect.evidence.every((expected) =>
            evidence.some(
              (citation) =>
                citation.sourceId === `src-${expected.doc}` &&
                citation.quote.includes(expected.contains),
            ),
          )
        : item.expect.evidence.some((expected) =>
            evidence.some(
              (citation) =>
                citation.sourceId === `src-${expected.doc}` &&
                citation.quote.includes(expected.contains),
            ),
          )
      : true;
    const isolationOk = !evidence.some((citation) =>
      item.expect.forbiddenDocs.includes(citation.sourceId.replace(/^src-/, "")),
    );
    return {
      id: item.id,
      category: item.category,
      evidenceHit,
      isolationOk,
      evidenceCount: evidence.length,
    };
  });
  const grouped = new Map<string, RetrievalCaseResult[]>();
  for (const result of results)
    grouped.set(result.category, [...(grouped.get(result.category) ?? []), result]);
  const rate = (items: RetrievalCaseResult[]) =>
    items.length ? items.filter((item) => item.evidenceHit).length / items.length : 1;
  return {
    contract: "grounding-v7",
    overall: { evidenceHitRate: rate(results), count: results.length },
    categories: Object.fromEntries(
      [...grouped].map(([category, items]) => [
        category,
        { evidenceHitRate: rate(items), count: items.length },
      ]),
    ),
    cases: results,
    isolationFailures: results.filter((item) => !item.isolationOk).map((item) => item.id),
  };
}
