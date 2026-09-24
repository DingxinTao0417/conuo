import { describe, expect, it } from "vitest";
import { fuseCandidates } from "./server-search";
import type { SearchCandidate } from "./search-types";

const candidate = (id: string, score = 1): SearchCandidate => ({
  kind: "source",
  objectId: id,
  versionId: `${id}-version`,
  blockId: `${id}-block`,
  score,
});

describe("fuseCandidates", () => {
  it("deduplicates query lists and orders by reciprocal rank", () => {
    const result = fuseCandidates([
      [candidate("shared"), candidate("keyword-only")],
      [candidate("semantic-only"), candidate("shared")],
    ]);
    expect(result[0]?.objectId).toBe("shared");
    expect(new Set(result.map((item) => item.objectId))).toEqual(
      new Set(["shared", "keyword-only", "semantic-only"]),
    );
    expect(result[0]?.score).toBeGreaterThan(result[1]?.score ?? 0);
  });
});
