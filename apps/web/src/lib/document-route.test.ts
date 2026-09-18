import { describe, expect, it } from "vitest";
import { parseNoteRoute, parseSourceRoute } from "./document-route";

describe("source route", () => {
  it("reads current and historical source routes without carrying any unrelated state", () => {
    expect(parseSourceRoute("#source/source-a")).toEqual({ sourceId: "source-a" });
    expect(parseSourceRoute("#source/source-a/version/version-2")).toEqual({
      sourceId: "source-a",
      versionId: "version-2",
    });
  });

  it("decodes identities before lookup and preserves an optional query suffix", () => {
    expect(parseSourceRoute("#source/source%2Da/version/version%5F2?from=note")).toEqual({
      sourceId: "source-a",
      versionId: "version_2",
    });
  });

  it.each([
    "",
    "source/source-a",
    "#source",
    "#source/",
    "#source/source-a/",
    "#source/source-a/unknown",
    "#source/source-a/version",
    "#source/source-a/version/",
    "#source/source-a/version/version-2/extra",
    "#source/source-a/version/version-2/",
    "#source/source-a/unknown/version-2",
    "#source/%E0%A4%A",
    "#source/source-a/version/%E0%A4%A",
    "#source/%00",
    "#source/source%2Fa",
    "#source/source%3Fa",
    "#source/source%20a",
    `#source/${"a".repeat(101)}`,
    "#note/source-a",
  ])("does not silently substitute a current version for a malformed route: %s", (hash) => {
    expect(parseSourceRoute(hash)).toBeUndefined();
  });
});

describe("note route", () => {
  it("opens an encoded note identity and all supported panels", () => {
    expect(parseNoteRoute("#note/note%2Da")).toEqual({ noteId: "note-a" });
    for (const panel of ["relations", "update", "ask"] as const) {
      expect(parseNoteRoute(`#note/note-a/${panel}`)).toEqual({ noteId: "note-a", panel });
    }
    expect(parseNoteRoute("#note/note-a/ask?from=search")).toEqual({
      noteId: "note-a",
      panel: "ask",
    });
  });

  it.each([
    "",
    "note/note-a",
    "#note",
    "#note/",
    "#note/note-a/",
    "#note/note-a/unknown",
    "#note/note-a/relations/extra",
    "#note/note-a/update/",
    "#note/%E0%A4%A",
    "#note/%00",
    "#note/note%2Fa",
    "#note/note%20a",
    `#note/${"a".repeat(101)}`,
    "#source/note-a",
  ])("rejects incomplete, ambiguous, or malformed fragments: %s", (hash) => {
    expect(parseNoteRoute(hash)).toBeUndefined();
  });
});
