import { describe, expect, it } from "vitest";
import type { Citation } from "../types";
import {
  adjacentCitations,
  interleave,
  stratifiedSample,
  uniqueCitations,
} from "./evidence-assembly";

function citation(sourceId: string, chunkId: string): Citation {
  return {
    sourceId,
    versionId: `${sourceId}-version`,
    chunkId,
    title: sourceId,
    quote: chunkId,
    section: "正文",
  };
}

describe("evidence assembly helpers", () => {
  it("stratifies bounded samples across the full input", () => {
    const items = Array.from({ length: 41 }, (_, index) => index);
    expect(stratifiedSample(items, 0)).toEqual([]);
    expect(stratifiedSample(items, 1)).toEqual([0]);
    expect(stratifiedSample([1, 2], 4)).toEqual([1, 2]);
    expect(stratifiedSample(items, 3)).toEqual([0, 20, 40]);
  });

  it("interleaves source queues in round-robin order", () => {
    expect(interleave([["a1", "a2", "a3"], ["b1"], ["c1", "c2"]])).toEqual([
      "a1",
      "b1",
      "c1",
      "a2",
      "c2",
      "a3",
    ]);
  });

  it("keeps the first occurrence of each source chunk", () => {
    const first = citation("source-a", "chunk-1");
    const duplicate = { ...first, quote: "updated duplicate" };
    const second = citation("source-a", "chunk-2");
    expect(uniqueCitations([first, duplicate, second])).toEqual([first, second]);
  });

  it("adds adjacent chunks without crossing the queue boundaries", () => {
    const queue = [
      citation("source-a", "chunk-0"),
      citation("source-a", "chunk-1"),
      citation("source-a", "chunk-2"),
    ];
    expect(adjacentCitations([queue[0]], [queue])).toEqual([queue[1]]);
    expect(adjacentCitations([queue[2]], [queue])).toEqual([queue[1]]);
  });
});
