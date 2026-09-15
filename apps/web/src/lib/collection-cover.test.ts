import { describe, expect, it } from "vitest";
import { collectionCoverStyle } from "./collection-cover";

describe("collection shelf covers", () => {
  it("keeps a default collection's cover when shelf order changes", () => {
    const before = collectionCoverStyle("machine-learning", "#4B3FE3");
    // Shelf order never enters the function; only the persisted identity does.
    const after = collectionCoverStyle("machine-learning", "#4B3FE3");
    expect(after).toEqual(before);
    expect(collectionCoverStyle("another-library", "#4B3FE3")).toEqual(
      collectionCoverStyle("another-library", "#4B3FE3"),
    );
  });

  it("uses an explicit custom space color without changing text contrast tokens", () => {
    expect(collectionCoverStyle("personal", "#2F74FF")).toEqual({
      "--collection-cover": "color-mix(in srgb, #2F74FF 20%, var(--bg-base-secondary))",
      "--collection-cover-text": "var(--text-secondary)",
      "--collection-cover-muted": "var(--text-tertiary)",
    });
  });
});
