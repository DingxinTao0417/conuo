import { describe, expect, it } from "vitest";
import { isCreatedWithinLibraryRange, libraryCreatedRange } from "./library-time-filter";

describe("library creation-time filter", () => {
  const now = new Date("2026-09-13T12:00:00.000Z");

  it("creates inclusive rolling ranges for supported windows", () => {
    expect(libraryCreatedRange("7d", now)).toEqual({
      from: "2026-09-06T12:00:00.000Z",
    });
    expect(libraryCreatedRange("30d", now)).toEqual({
      from: "2026-08-14T12:00:00.000Z",
    });
    expect(libraryCreatedRange("all", now)).toBeUndefined();
  });

  it("includes the lower boundary and rejects older or malformed timestamps", () => {
    const range = libraryCreatedRange("7d", now);

    expect(isCreatedWithinLibraryRange("2026-09-06T12:00:00.000Z", range)).toBe(true);
    expect(isCreatedWithinLibraryRange("2026-09-06T11:59:59.999Z", range)).toBe(false);
    expect(isCreatedWithinLibraryRange("not-a-date", range)).toBe(false);
  });
});
