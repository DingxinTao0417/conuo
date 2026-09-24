import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./requests", () => ({ createRequestStore: () => ({ rpc: mock.rpc }) }));
vi.mock("./features", () => ({
  aiFeatureEnabled: vi.fn(() => process.env.CONUO_FEATURE_AI_TRACES === "on"),
}));

import { createTraceRecorder } from "./traces";

beforeEach(() => {
  mock.rpc.mockReset().mockResolvedValue({ data: null, error: null });
  process.env.CONUO_FEATURE_AI_TRACES = "on";
});
afterEach(() => {
  delete process.env.CONUO_FEATURE_AI_TRACES;
  vi.useRealTimers();
});

describe("AI trace recorder", () => {
  it("does not write while the feature is disabled", async () => {
    process.env.CONUO_FEATURE_AI_TRACES = "off";
    await createTraceRecorder("ask", "owner-a", "request-a").finish("completed");
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it("drops unknown metrics and bounds evidence references", async () => {
    const recorder = createTraceRecorder("ask", "owner-a", "request-a");
    recorder.set({
      intent: "explain",
      sourceCount: 2,
      unknown: "private prompt",
      evidenceRefs: Array.from({ length: 42 }, (_, index) => ({
        sourceId: `source-${index}`,
        versionId: `version-${index}`,
        chunkId: `chunk-${index}`,
      })),
    });
    await recorder.finish("completed");
    const trace = mock.rpc.mock.calls[0]![1].p_trace;
    expect(trace.metrics.unknown).toBeUndefined();
    expect(trace.metrics.evidenceRefs).toHaveLength(40);
  });

  it("swallows a slow trace RPC", async () => {
    vi.useFakeTimers();
    mock.rpc.mockReturnValue(new Promise(() => undefined));
    const pending = createTraceRecorder("ask", "owner-a").finish("failed");
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(pending).resolves.toBeUndefined();
  });
});
