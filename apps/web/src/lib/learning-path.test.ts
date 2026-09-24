import { describe, expect, it } from "vitest";
import type { ConceptRelation } from "./concept-relation-types";
import type { Note } from "./types";
import { buildLearningPath } from "./learning-path";

const note = (id: string, createdAt: string): Note => ({
  id,
  spaceId: "space-a",
  title: id.toUpperCase(),
  content: id,
  kind: "knowledge",
  status: "accepted",
  citations: [],
  versions: [],
  createdAt,
  updatedAt: createdAt,
  deletedAt: null,
});

const relation = (from: Note, to: Note, deletedAt: string | null = null): ConceptRelation => ({
  id: `${from.id}-${to.id}`,
  spaceId: "space-a",
  type: "prerequisite",
  from: {
    id: from.id,
    spaceId: from.spaceId,
    title: from.title,
    content: from.content,
    revision: 0,
    updatedAt: from.updatedAt,
    citations: [],
    status: from.status,
    aiGenerated: false,
  },
  to: {
    id: to.id,
    spaceId: to.spaceId,
    title: to.title,
    content: to.content,
    revision: 0,
    updatedAt: to.updatedAt,
    citations: [],
    status: to.status,
    aiGenerated: false,
  },
  origin: "manual",
  revision: 0,
  fromClaim: "from",
  toClaim: "to",
  fromCondition: "",
  toCondition: "",
  explanation: "",
  fromCitations: [],
  toCitations: [],
  createdAt: from.createdAt,
  updatedAt: from.updatedAt,
  deletedAt,
});

describe("learning path", () => {
  it("orders a linear prerequisite chain and exposes direct prerequisites", () => {
    const a = note("a", "2026-01-01T00:00:00.000Z");
    const b = note("b", "2026-01-02T00:00:00.000Z");
    const c = note("c", "2026-01-03T00:00:00.000Z");
    const result = buildLearningPath([c, b, a], [relation(b, c), relation(a, b)], "space-a");
    expect(result.items.map((item) => item.note.id)).toEqual(["a", "b", "c"]);
    expect(result.items[2]?.prerequisites.map((item) => item.id)).toEqual(["b"]);
    expect(result.hasCycle).toBe(false);
  });

  it("keeps multiple prerequisites before their dependent", () => {
    const a = note("a", "2026-01-01T00:00:00.000Z");
    const b = note("b", "2026-01-02T00:00:00.000Z");
    const c = note("c", "2026-01-03T00:00:00.000Z");
    const result = buildLearningPath([a, b, c], [relation(a, c), relation(b, c)], "space-a");
    expect(result.items.map((item) => item.note.id)).toEqual(["a", "b", "c"]);
    expect(result.items[2]?.prerequisites.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("breaks a cycle at the oldest node and marks the result", () => {
    const a = note("a", "2026-01-01T00:00:00.000Z");
    const b = note("b", "2026-01-02T00:00:00.000Z");
    const c = note("c", "2026-01-03T00:00:00.000Z");
    const result = buildLearningPath(
      [a, b, c],
      [relation(a, b), relation(b, c), relation(c, a)],
      "space-a",
    );
    expect(result.hasCycle).toBe(true);
    expect(result.items.map((item) => item.note.id)).toEqual(["a", "b", "c"]);
    expect(result.items.some((item) => item.cycle)).toBe(true);
  });

  it("does not render a path when the space has no prerequisite relation", () => {
    const a = note("a", "2026-01-01T00:00:00.000Z");
    const b = note("b", "2026-01-02T00:00:00.000Z");
    const result = buildLearningPath([a, b], [], "space-a");
    expect(result.items).toEqual([]);
    expect(result.hasPrerequisites).toBe(false);
  });
});
