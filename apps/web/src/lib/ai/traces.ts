import "server-only";
import { aiFeatureEnabled } from "./features";
import { createRequestStore } from "./requests";
import type { ModelUsage } from "./model";

export type TraceRoute =
  | "ask"
  | "organize"
  | "organization-job"
  | "vision"
  | "embedding"
  | "summary"
  | "learning"
  | "eval";
export type TraceOutcome =
  "completed" | "insufficient" | "failed" | "cancelled" | "cached" | "extractive";
type MarkName =
  | "retrievalStart"
  | "retrievalEnd"
  | "modelStart"
  | "firstDraft"
  | "modelEnd"
  | "verifyStart"
  | "verifyEnd";
type EvidenceRef = { sourceId: string; versionId: string; chunkId: string };
type TraceValues = Record<string, unknown>;
const metricNames = new Set([
  "intent",
  "scope",
  "searchMode",
  "sourceCount",
  "candidateCount",
  "evidenceCount",
  "evidenceRefs",
  "promptTokens",
  "completionTokens",
  "reasoningTokens",
  "cacheHitTokens",
  "latencyMs",
  "modelCalls",
  "longContext",
  "rerank",
  "rewrite",
  "verify",
]);

function boundedMetric(values: TraceValues): TraceValues {
  const result: TraceValues = {};
  for (const [key, value] of Object.entries(values)) {
    if (!metricNames.has(key)) continue;
    if (key === "evidenceRefs" && Array.isArray(value)) {
      result[key] = value.slice(0, 40).filter((item): item is EvidenceRef => {
        if (!item || typeof item !== "object") return false;
        const ref = item as Record<string, unknown>;
        return ["sourceId", "versionId", "chunkId"].every(
          (field) => typeof ref[field] === "string" && ref[field].length <= 200,
        );
      });
    } else if (key === "modelCalls" && Array.isArray(value)) {
      result[key] = value.slice(0, 8);
    } else if (key === "latencyMs" && value && typeof value === "object") {
      const latency = value as Record<string, unknown>;
      result[key] = Object.fromEntries(
        ["total", "retrieval", "firstDraft", "model", "verify"].flatMap((field) =>
          Number.isSafeInteger(latency[field]) && (latency[field] as number) >= 0
            ? [[field, latency[field]]]
            : [],
        ),
      );
    } else if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      (Number.isSafeInteger(value) && (value as number) >= 0)
    ) {
      result[key] = value;
    }
  }
  return result;
}

function addUsageTotals(target: ModelUsage, usage: ModelUsage) {
  for (const key of [
    "promptTokens",
    "completionTokens",
    "totalTokens",
    "reasoningTokens",
    "cacheHitTokens",
  ] as const) {
    if (usage[key] !== undefined) target[key] = (target[key] ?? 0) + usage[key]!;
  }
}

export function createTraceRecorder(route: TraceRoute, ownerId: string, requestId?: string) {
  const startedAt = Date.now();
  const marks = new Map<MarkName, number>();
  const metrics: TraceValues = {};
  const usageTotals: ModelUsage = {};
  let finished = false;
  return {
    mark(name: MarkName) {
      marks.set(name, Date.now());
    },
    set(values: TraceValues) {
      Object.assign(metrics, values);
    },
    addUsage(usage: ModelUsage) {
      addUsageTotals(usageTotals, usage);
    },
    async finish(
      outcome: TraceOutcome,
      extra: {
        errorCode?: string;
        modelProfile?: "default" | "fast" | "reasoning" | "vision" | "embedding" | "rerank";
        modelName?: string;
        contractVersion?: string;
      } = {},
    ) {
      if (finished || !aiFeatureEnabled("AI_TRACES")) return;
      finished = true;
      const now = Date.now();
      const interval = (start: MarkName, end: MarkName) => {
        const a = marks.get(start),
          b = marks.get(end);
        return a !== undefined && b !== undefined ? Math.max(0, b - a) : undefined;
      };
      const latencyMs = {
        total: Math.max(0, now - startedAt),
        retrieval: interval("retrievalStart", "retrievalEnd"),
        firstDraft:
          marks.get("firstDraft") !== undefined
            ? Math.max(0, marks.get("firstDraft")! - (marks.get("modelStart") ?? startedAt))
            : undefined,
        model: interval("modelStart", "modelEnd"),
        verify: interval("verifyStart", "verifyEnd"),
      };
      const trace = {
        requestId,
        route,
        outcome,
        ...(extra.errorCode ? { errorCode: extra.errorCode } : {}),
        ...(extra.modelProfile ? { modelProfile: extra.modelProfile } : {}),
        ...(extra.modelName ? { modelName: extra.modelName } : {}),
        ...(extra.contractVersion ? { contractVersion: extra.contractVersion } : {}),
        metrics: boundedMetric({
          ...metrics,
          ...usageTotals,
          latencyMs,
        }),
      };
      try {
        const store = createRequestStore();
        await Promise.race([
          store.rpc("record_ai_trace", { p_owner: ownerId, p_trace: trace }),
          new Promise((resolve) => setTimeout(resolve, 1_000)),
        ]);
      } catch {
        // Tracing must never change the user-facing request outcome.
      }
    },
  };
}
