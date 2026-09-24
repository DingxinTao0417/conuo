import { describe, expect, it, vi } from "vitest";
import { readPdfOutline, sectionPathForPage } from "./source-outline";

describe("PDF source outlines", () => {
  it("flattens nested entries, resolves string and array destinations, and skips failures", async () => {
    const firstPage = {};
    const secondPage = {};
    const pdf = {
      getOutline: vi.fn(async () => [
        {
          title: " 第一章 ",
          dest: "first",
          items: [
            { title: "1.1 基础", dest: [firstPage], items: [] },
            { title: "损坏项", dest: "broken", items: [] },
          ],
        },
        { title: "第二章", dest: [secondPage], items: [] },
      ]),
      getDestination: vi.fn(async (name: string) => {
        if (name === "first") return [firstPage];
        throw new Error("missing destination");
      }),
      getPageIndex: vi.fn(async (ref: unknown) => (ref === firstPage ? 4 : 9)),
    };

    await expect(readPdfOutline(pdf)).resolves.toEqual([
      { title: "第一章", level: 1, page: 5 },
      { title: "1.1 基础", level: 2, page: 5 },
      { title: "第二章", level: 1, page: 10 },
    ]);
  });

  it("returns the nearest three-level path and null before the first chapter", () => {
    const items = [
      { title: "无定位标题", level: 1 },
      { title: "第一章", level: 1, page: 3 },
      { title: "1.1 基础", level: 2, page: 4 },
      { title: "1.1.1 定义", level: 3, page: 5 },
      { title: "第二章", level: 1, page: 20 },
    ] as const;
    expect(sectionPathForPage(items, 2)).toBeNull();
    expect(sectionPathForPage(items, 5)).toBe("第一章 › 1.1 基础 › 1.1.1 定义");
    expect(sectionPathForPage(items, 20)).toBe("第二章");
  });
});
