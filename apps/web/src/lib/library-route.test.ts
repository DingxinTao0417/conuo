import { describe, expect, it } from "vitest";
import { formatLibraryRoute, normalizeLibraryTags, parseLibraryRoute } from "./library-route";

describe("library route", () => {
  it.each([
    "library/space-a",
    "#library/",
    "#library/space-a/extra",
    "#library/space-a/",
    "#library//space-a",
    "#library/%E0%A4%A",
    "#library/%00",
  ])("does not silently redirect an invalid library path: %s", (hash) => {
    expect(parseLibraryRoute(hash)).toBeUndefined();
  });

  it("retains encoded library identities that the existing formatter supports", () => {
    const route = {
      spaceId: "机器学习 / 课程",
      files: true,
      filter: "all" as const,
      time: "all" as const,
      sort: "updated" as const,
      layout: "list" as const,
      query: "",
    };
    expect(parseLibraryRoute(formatLibraryRoute(route))).toEqual(route);
  });

  it.each(["note", "knowledge"] as const)(
    "preserves %s type and time when filtering before typing",
    (filter) => {
      const route = {
        spaceId: "space-a",
        files: true,
        filter,
        time: "7d" as const,
        sort: "updated" as const,
        layout: "list" as const,
        query: "",
      };
      expect(parseLibraryRoute(formatLibraryRoute(route))).toEqual(route);
      expect(parseLibraryRoute(`${formatLibraryRoute(route)}&q=微积分`)).toMatchObject({
        filter,
        time: "7d",
        query: "微积分",
      });
    },
  );
  it("restores a filtered card view and its source query after a refresh", () => {
    expect(parseLibraryRoute("#library/space-a?q=gradient+descent&filter=pdf&layout=grid")).toEqual(
      {
        spaceId: "space-a",
        files: true,
        filter: "pdf",
        time: "all",
        sort: "updated",
        layout: "grid",
        query: "gradient descent",
      },
    );
  });

  it("keeps collection-library search independent from the all-sources view", () => {
    expect(parseLibraryRoute("#library?q=machine+learning")).toEqual({
      spaceId: "all",
      files: false,
      filter: "all",
      time: "all",
      sort: "updated",
      layout: "list",
      query: "machine learning",
    });
  });

  it("falls back safely for malformed view preferences", () => {
    expect(parseLibraryRoute("#library/space-a?filter=unknown&layout=columns")).toMatchObject({
      spaceId: "space-a",
      files: true,
      filter: "all",
      time: "all",
      sort: "updated",
      layout: "list",
    });
  });

  it("serializes only meaningful preferences and safely encodes route data", () => {
    expect(
      formatLibraryRoute({
        spaceId: "机器学习 / 课程",
        files: true,
        filter: "docx",
        time: "all",
        sort: "updated",
        layout: "grid",
        query: "学习率 & 梯度",
      }),
    ).toBe(
      "#library/%E6%9C%BA%E5%99%A8%E5%AD%A6%E4%B9%A0%20%2F%20%E8%AF%BE%E7%A8%8B?q=%E5%AD%A6%E4%B9%A0%E7%8E%87+%26+%E6%A2%AF%E5%BA%A6&filter=docx&layout=grid",
    );
    expect(
      formatLibraryRoute({
        spaceId: "all",
        files: false,
        filter: "pdf",
        time: "30d",
        sort: "name",
        layout: "grid",
        query: "",
      }),
    ).toBe("#library");
  });

  it("round-trips the explicit all-library cross-question panel and its optional conversation", () => {
    const route = {
      spaceId: "all",
      files: true,
      filter: "all" as const,
      time: "all" as const,
      sort: "updated" as const,
      layout: "list" as const,
      query: "学习率",
      crossLibraryAsk: { conversationId: "cross_library-01" },
    };
    const hash = formatLibraryRoute(route);

    expect(hash).toBe(
      "#library/all?q=%E5%AD%A6%E4%B9%A0%E7%8E%87&ask=1&conversation=cross_library-01",
    );
    expect(parseLibraryRoute(hash)).toEqual(route);
    expect(parseLibraryRoute("#library/all?ask=1")).toMatchObject({
      spaceId: "all",
      files: true,
      crossLibraryAsk: {},
    });
  });

  it("does not open the cross-library panel from a normal library or malformed conversation id", () => {
    expect(parseLibraryRoute("#library/space-a?ask=1&conversation=cross_library-01")).toEqual({
      spaceId: "space-a",
      files: true,
      filter: "all",
      time: "all",
      sort: "updated",
      layout: "list",
      query: "",
    });
    expect(parseLibraryRoute("#library/all?ask=1&conversation=not%20a%20route-id")).toMatchObject({
      spaceId: "all",
      files: true,
      crossLibraryAsk: {},
    });
    expect(
      formatLibraryRoute({
        spaceId: "space-a",
        files: true,
        filter: "all",
        time: "all",
        sort: "updated",
        layout: "list",
        query: "",
        crossLibraryAsk: { conversationId: "cross_library-01" },
      }),
    ).toBe("#library/space-a");
  });

  it("parses repeated tag filters into a safe, canonical unique list", () => {
    const oversized = "x".repeat(101);

    expect(
      parseLibraryRoute(
        `#library/space-a?tag=++%EF%BC%A1%EF%BC%A9++&tag=ai&tag=%E6%9C%BA%E5%99%A8%E5%AD%A6%E4%B9%A0&tag=&tag=%00bad&tag=${oversized}`,
      ),
    ).toEqual({
      spaceId: "space-a",
      files: true,
      filter: "all",
      time: "all",
      sort: "updated",
      layout: "list",
      query: "",
      tags: ["AI", "机器学习"],
    });
  });

  it("writes repeated canonical tag parameters only for a files view", () => {
    expect(
      formatLibraryRoute({
        spaceId: "space-a",
        files: true,
        filter: "pdf",
        time: "all",
        sort: "updated",
        layout: "grid",
        query: "gradient descent",
        tags: ["  AI  ", "ai", "C++"],
      }),
    ).toBe("#library/space-a?q=gradient+descent&filter=pdf&layout=grid&tag=AI&tag=C%2B%2B");
    expect(
      formatLibraryRoute({
        spaceId: "all",
        files: false,
        filter: "all",
        time: "all",
        sort: "updated",
        layout: "list",
        query: "",
        tags: ["AI"],
      }),
    ).toBe("#library");
  });

  it("keeps tags when a view patch omits them and replaces them when it supplies tags", () => {
    const current = parseLibraryRoute("#library/space-a?tag=AI&tag=机器学习")!;

    expect(formatLibraryRoute({ ...current, layout: "grid" })).toBe(
      "#library/space-a?layout=grid&tag=AI&tag=%E6%9C%BA%E5%99%A8%E5%AD%A6%E4%B9%A0",
    );
    expect(formatLibraryRoute({ ...current, tags: ["复习", "复习"] })).toBe(
      "#library/space-a?tag=%E5%A4%8D%E4%B9%A0",
    );
  });

  it("shares tag normalization between route reads and writes", () => {
    expect(normalizeLibraryTags(["  alpha  ", "ALPHA", "beta\nnotes", ""])).toEqual([
      "alpha",
      "beta notes",
    ]);
    expect(parseLibraryRoute("#library?tag=AI")).toEqual({
      spaceId: "all",
      files: false,
      filter: "all",
      time: "all",
      sort: "updated",
      layout: "list",
      query: "",
    });
  });

  it("round-trips a rolling creation-time filter and ignores invalid values", () => {
    const route = parseLibraryRoute("#library/space-a?time=30d")!;

    expect(route.time).toBe("30d");
    expect(formatLibraryRoute(route)).toBe("#library/space-a?time=30d");
    expect(parseLibraryRoute("#library/space-a?time=forever")?.time).toBe("all");
    expect(parseLibraryRoute("#library?time=7d")?.time).toBe("all");
  });

  it("round-trips non-default sorting and canonicalizes defaults or invalid values", () => {
    const created = parseLibraryRoute("#library/space-a?sort=created")!;

    expect(created.sort).toBe("created");
    expect(formatLibraryRoute(created)).toBe("#library/space-a?sort=created");
    expect(formatLibraryRoute({ ...created, sort: "updated" })).toBe("#library/space-a");
    expect(parseLibraryRoute("#library/space-a?sort=unknown")?.sort).toBe("updated");
    expect(parseLibraryRoute("#library?sort=name")?.sort).toBe("updated");
  });
});
