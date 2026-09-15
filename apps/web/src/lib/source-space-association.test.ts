import { describe, expect, it } from "vitest";
import { addSourcesToLearningSpaces } from "./source-space-association";
import type { Source, WorkspaceData } from "./types";

const now = "2026-09-13T12:00:00.000Z";

function source(id: string, spaceIds: string[], deletedAt: string | null = null): Source {
  return {
    id,
    versionId: `${id}-v1`,
    title: id,
    filename: `${id}.md`,
    kind: "markdown",
    mime: "text/markdown",
    size: 1,
    hash: id,
    spaceIds,
    tags: [],
    status: "ready",
    text: id,
    chunks: [],
    createdAt: now,
    updatedAt: "2026-09-12T12:00:00.000Z",
    deletedAt,
    aiAllowed: true,
    starred: false,
  };
}

function workspace(): WorkspaceData {
  return {
    schemaVersion: 1,
    spaces: [
      { id: "alpha", name: "Alpha", goal: "", color: "#111", archived: false, createdAt: now },
      { id: "beta", name: "Beta", goal: "", color: "#222", archived: false, createdAt: now },
      { id: "archive", name: "Archive", goal: "", color: "#333", archived: true, createdAt: now },
    ],
    sources: [
      source("first", ["alpha"]),
      source("second", []),
      source("recycled", ["alpha"], now),
      source("already-linked", ["alpha", "beta"]),
    ],
    notes: [],
    annotations: [],
    conversations: [],
    aiEnabled: true,
  };
}

describe("bulk learning-space association", () => {
  it("adds multiple active spaces without copying originals or duplicating memberships", () => {
    const before = workspace();
    const result = addSourcesToLearningSpaces(
      before,
      ["first", "second", "first"],
      ["beta", "alpha"],
      now,
    );

    expect(result.addedSourceIds).toEqual(["first", "second"]);
    expect(result.addedAssociations).toBe(3);
    expect(result.skipped).toEqual([]);
    expect(result.data.sources.find((item) => item.id === "first")).toMatchObject({
      spaceIds: ["alpha", "beta"],
      updatedAt: now,
    });
    expect(result.data.sources.find((item) => item.id === "second")).toMatchObject({
      spaceIds: ["beta", "alpha"],
      updatedAt: now,
    });
    expect(result.data.sources).toHaveLength(before.sources.length);
    expect(before.sources[0]?.spaceIds).toEqual(["alpha"]);
  });

  it("retains per-source outcomes for recycled, missing, and already-linked selections", () => {
    const before = workspace();
    const result = addSourcesToLearningSpaces(
      before,
      ["recycled", "missing", "already-linked"],
      ["alpha", "beta"],
      now,
    );

    expect(result.data).toBe(before);
    expect(result.addedSourceIds).toEqual([]);
    expect(result.skipped).toEqual([
      { sourceId: "recycled", reason: "recycled" },
      { sourceId: "missing", reason: "missing" },
      { sourceId: "already-linked", reason: "already-associated" },
    ]);
  });

  it("rejects an empty selection or a missing or archived target before changing any source", () => {
    const before = workspace();

    expect(() => addSourcesToLearningSpaces(before, [], ["alpha"], now)).toThrow(
      "至少选择一份资料",
    );
    expect(() => addSourcesToLearningSpaces(before, ["first"], [], now)).toThrow(
      "至少选择一个学习空间",
    );
    expect(() => addSourcesToLearningSpaces(before, ["first"], ["archive"], now)).toThrow(
      "已不存在或已归档",
    );
    expect(() => addSourcesToLearningSpaces(before, ["first"], ["missing"], now)).toThrow(
      "已不存在或已归档",
    );
    expect(before.sources.find((item) => item.id === "first")?.spaceIds).toEqual(["alpha"]);
  });
});
