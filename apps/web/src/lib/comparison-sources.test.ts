import { describe, expect, it } from "vitest";
import type { ComparisonRoute } from "./comparison-route";
import { resolveComparisonSources } from "./comparison-sources";
import type { Chunk, Source, SourceVersion, WorkspaceData } from "./types";

const now = "2026-09-13T12:00:00.000Z";

function chunk(sourceId: string, versionId: string, text: string): Chunk {
  return {
    id: `${sourceId}-${versionId}-chunk`,
    sourceId,
    versionId,
    text,
    section: "正文",
    order: 0,
  };
}

function source(id: string, spaceIds: string[], patch: Partial<Source> = {}): Source {
  const versionId = patch.versionId ?? `${id}-v1`;
  const text = patch.text ?? `${id} current text`;
  return {
    id,
    versionId,
    title: `${id} title`,
    filename: `${id}.txt`,
    kind: "text",
    mime: "text/plain",
    size: text.length,
    hash: `${id}-hash`,
    spaceIds,
    tags: [],
    status: "ready",
    text,
    chunks: [chunk(id, versionId, text)],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    aiAllowed: true,
    starred: false,
    ...patch,
  };
}

function historicVersion(sourceId: string, versionId: string, text: string): SourceVersion {
  return {
    versionId,
    title: `${sourceId} historical title`,
    filename: `${sourceId}-${versionId}.txt`,
    kind: "text",
    mime: "text/plain",
    size: text.length,
    hash: `${sourceId}-${versionId}-hash`,
    status: "ready",
    text,
    chunks: [chunk(sourceId, versionId, text)],
    createdAt: "2026-09-12T12:00:00.000Z",
    archivedAt: now,
  };
}

function workspace(sources: Source[] = []): WorkspaceData {
  return {
    schemaVersion: 1,
    spaces: [
      { id: "space-a", name: "Space A", goal: "", color: "#111", archived: false, createdAt: now },
      { id: "space-b", name: "Space B", goal: "", color: "#222", archived: false, createdAt: now },
      {
        id: "archived-space",
        name: "Archived",
        goal: "",
        color: "#333",
        archived: true,
        createdAt: now,
      },
    ],
    sources,
    notes: [],
    annotations: [],
    conversations: [],
    aiEnabled: true,
  };
}

function route(patch: Partial<ComparisonRoute> = {}): ComparisonRoute {
  return {
    leftSourceId: "left",
    leftVersionId: "left-v1",
    rightSourceId: "right",
    rightVersionId: "right-v1",
    spaceId: "space-a",
    ...patch,
  };
}

describe("resolveComparisonSources", () => {
  it("returns two exact versions only when both sources belong to the active route space", () => {
    const left = source("left", ["space-a"], {
      versionId: "left-v2",
      text: "left current text",
      chunks: [chunk("left", "left-v2", "left current text")],
      versions: [historicVersion("left", "left-v1", "left historical text")],
    });
    const right = source("right", ["space-a", "space-b"]);
    const data = workspace([left, right]);

    const result = resolveComparisonSources(data, route());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.space.id).toBe("space-a");
    expect(result.left).toMatchObject({
      isCurrentVersion: false,
      source: {
        id: "left",
        versionId: "left-v1",
        title: "left historical title",
        text: "left historical text",
      },
    });
    expect(result.left.source.chunks).toEqual([chunk("left", "left-v1", "left historical text")]);
    expect(result.right).toMatchObject({
      isCurrentVersion: true,
      source: { id: "right", versionId: "right-v1" },
    });
    expect(data.sources[0]?.versionId).toBe("left-v2");
  });

  it("rejects a source that is not a member of the comparison space", () => {
    const result = resolveComparisonSources(
      workspace([source("left", ["space-a"]), source("right", ["space-b"])]),
      route(),
    );

    expect(result).toEqual({ ok: false, reason: "source-not-in-space", side: "right" });
  });

  it("does not permit a recycled source or a source removed by permanent deletion", () => {
    const recycled = resolveComparisonSources(
      workspace([source("left", ["space-a"], { deletedAt: now }), source("right", ["space-a"])]),
      route(),
    );
    const permanentlyDeleted = resolveComparisonSources(
      workspace([source("right", ["space-a"])]),
      route(),
    );

    expect(recycled).toEqual({ ok: false, reason: "source-recycled", side: "left" });
    expect(permanentlyDeleted).toEqual({ ok: false, reason: "source-missing", side: "left" });
  });

  it("rejects missing and archived spaces before exposing either document", () => {
    const sources = [source("left", ["space-a"]), source("right", ["space-a"])];

    expect(resolveComparisonSources(workspace(sources), route({ spaceId: "missing" }))).toEqual({
      ok: false,
      reason: "space-missing",
    });
    expect(
      resolveComparisonSources(workspace(sources), route({ spaceId: "archived-space" })),
    ).toEqual({ ok: false, reason: "space-archived" });
  });

  it("requires a version owned by the matching source and never substitutes another source version", () => {
    const result = resolveComparisonSources(
      workspace([
        source("left", ["space-a"]),
        source("right", ["space-a"], {
          versionId: "right-v2",
          versions: [historicVersion("right", "right-v1", "right historical text")],
        }),
      ]),
      route({ leftVersionId: "right-v1" }),
    );

    expect(result).toEqual({ ok: false, reason: "version-missing", side: "left" });
  });

  it("defensively rejects a direct route object that names the same source twice", () => {
    const result = resolveComparisonSources(
      workspace([source("left", ["space-a"])]),
      route({ rightSourceId: "left", rightVersionId: "left-v1" }),
    );

    expect(result).toEqual({ ok: false, reason: "same-source" });
  });
});
