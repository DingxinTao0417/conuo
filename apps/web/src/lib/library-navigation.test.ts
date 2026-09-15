import { describe, expect, it } from "vitest";
import { pinnedLibrarySources } from "./library-navigation";
import type { Source } from "./types";

const at = "2026-09-13T00:00:00.000Z";

function source(id: string, patch: Partial<Source> = {}): Source {
  return {
    id,
    versionId: `${id}-version`,
    title: id,
    filename: `${id}.txt`,
    kind: "text",
    mime: "text/plain",
    size: 1,
    hash: "a".repeat(64),
    spaceIds: [],
    tags: [],
    status: "ready",
    text: id,
    chunks: [],
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    aiAllowed: true,
    starred: false,
    ...patch,
  };
}

describe("pinnedLibrarySources", () => {
  it("only returns readable documents the user starred", () => {
    const pinned = pinnedLibrarySources([
      source("starred", { starred: true }),
      source("ordinary"),
      source("recycled", { starred: true, deletedAt: at }),
    ]);

    expect(pinned.map((item) => item.id)).toEqual(["starred"]);
  });

  it("orders by actual reading activity before metadata changes and caps the rail", () => {
    const pinned = pinnedLibrarySources(
      [
        source("recent-read", { starred: true, lastReadAt: "2026-09-13T12:00:00.000Z" }),
        source("old-read", {
          starred: true,
          lastReadAt: "2026-09-12T12:00:00.000Z",
          updatedAt: "2026-09-14T12:00:00.000Z",
        }),
        source("never-read", { starred: true, updatedAt: "2026-09-15T12:00:00.000Z" }),
      ],
      2,
    );

    expect(pinned.map((item) => item.id)).toEqual(["recent-read", "old-read"]);
  });
});
