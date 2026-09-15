import { describe, expect, it } from "vitest";
import { selectReadingPositionAlternative } from "./reading-position-alternatives";

describe("selectReadingPositionAlternative", () => {
  it("promotes the selected candidate while retaining, deduplicating, and bounding recoverable positions", () => {
    const source = {
      readPage: 2,
      readOffset: 120,
      lastReadAt: "2026-09-14T08:00:00.000Z",
      readingPositionAlternatives: [
        {
          origin: "remote" as const,
          readPage: 7,
          readOffset: 720,
          lastReadAt: "2026-09-14T09:00:00.000Z",
        },
        {
          origin: "previous" as const,
          readPage: 2,
          readOffset: 120,
          lastReadAt: "2026-09-14T08:00:00.000Z",
        },
        ...Array.from({ length: 9 }, (_, index) => ({
          origin: "local" as const,
          readOffset: 900 + index,
          lastReadAt: `2026-09-14T10:00:${String(index).padStart(2, "0")}.000Z`,
        })),
      ],
    };

    const result = selectReadingPositionAlternative(source, 0);

    expect(result).toMatchObject({
      readPage: 7,
      readOffset: 720,
      lastReadAt: "2026-09-14T09:00:00.000Z",
    });
    expect(result.readingPositionAlternatives).toHaveLength(8);
    expect(result.readingPositionAlternatives[0]).toEqual({
      origin: "previous",
      readPage: 2,
      readOffset: 120,
      lastReadAt: "2026-09-14T08:00:00.000Z",
    });
    expect(
      result.readingPositionAlternatives.filter(
        (candidate) =>
          candidate.readPage === 2 &&
          candidate.readOffset === 120 &&
          candidate.lastReadAt === "2026-09-14T08:00:00.000Z",
      ),
    ).toHaveLength(1);
    expect(source.readingPositionAlternatives).toHaveLength(11);
  });

  it("rejects a stale candidate index", () => {
    expect(() => selectReadingPositionAlternative({ readingPositionAlternatives: [] }, 0)).toThrow(
      "选择的阅读位置已不存在",
    );
  });
});
