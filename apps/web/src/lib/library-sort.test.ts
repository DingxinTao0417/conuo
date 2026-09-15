import { describe, expect, it } from "vitest";
import { isLibrarySort, sortLibrarySources, type LibrarySort } from "./library-sort";

interface TestSource {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

const sources: TestSource[] = [
  {
    id: "older",
    title: "第10课",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  {
    id: "newer",
    title: "第2课",
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
  },
  {
    id: "invalid",
    title: "英语",
    createdAt: "not-a-date",
    updatedAt: "also-not-a-date",
  },
];

function ids(sort: LibrarySort, values: readonly TestSource[] = sources): string[] {
  return sortLibrarySources(values, sort).map((source) => source.id);
}

describe("library source sorting", () => {
  it("defaults to most recently updated without mutating its input", () => {
    const originalOrder = sources.map((source) => source.id);

    expect(sortLibrarySources(sources).map((source) => source.id)).toEqual([
      "newer",
      "older",
      "invalid",
    ]);
    expect(sources.map((source) => source.id)).toEqual(originalOrder);
  });

  it("sorts newest creation dates first and leaves malformed dates at the end", () => {
    expect(ids("created")).toEqual(["newer", "older", "invalid"]);
  });

  it("uses Chinese-aware natural title ordering", () => {
    expect(ids("name")).toEqual(["newer", "older", "invalid"]);
  });

  it("preserves source order when the selected values compare equally", () => {
    const tied = [
      { ...sources[0], id: "first", title: "ＡＩ", updatedAt: "invalid" },
      { ...sources[1], id: "second", title: "ai", updatedAt: "invalid" },
      { ...sources[2], id: "third", title: "AI", updatedAt: "invalid" },
    ];

    expect(ids("updated", tied)).toEqual(["first", "second", "third"]);
    expect(ids("name", tied)).toEqual(["first", "second", "third"]);
  });

  it("recognizes only supported route values", () => {
    expect(isLibrarySort("updated")).toBe(true);
    expect(isLibrarySort("created")).toBe(true);
    expect(isLibrarySort("name")).toBe(true);
    expect(isLibrarySort("recent")).toBe(false);
  });
});
