import { describe, expect, it } from "vitest";
import {
  formatComparisonRoute,
  parseComparisonRoute,
  type ComparisonRoute,
} from "./comparison-route";

const route: ComparisonRoute = {
  leftSourceId: "source-left",
  leftVersionId: "version-left",
  rightSourceId: "source-right",
  rightVersionId: "version-right",
  spaceId: "space-a",
};

describe("comparison route", () => {
  it("round-trips the two versions and their owning space", () => {
    const hash =
      "#compare/source-left/version/version-left/with/source-right/version/version-right?space=space-a";

    expect(parseComparisonRoute(hash)).toEqual(route);
    expect(formatComparisonRoute(route)).toBe(hash);
  });

  it("percent-encodes every identifier so reserved path characters remain data", () => {
    const encoded: ComparisonRoute = {
      leftSourceId: "左 / #?",
      leftVersionId: "版本 / 1",
      rightSourceId: "right&source",
      rightVersionId: "version?2",
      spaceId: "学习 / 空间",
    };

    expect(formatComparisonRoute(encoded)).toBe(
      "#compare/%E5%B7%A6%20%2F%20%23%3F/version/%E7%89%88%E6%9C%AC%20%2F%201/with/right%26source/version/version%3F2?space=%E5%AD%A6%E4%B9%A0%20%2F%20%E7%A9%BA%E9%97%B4",
    );
    expect(parseComparisonRoute(formatComparisonRoute(encoded))).toEqual(encoded);
  });

  it("keeps encoded slashes inside their original identifier", () => {
    expect(
      parseComparisonRoute(
        "#compare/source%2Fleft/version/version%2Fleft/with/source-right/version/version-right?space=space%2Fa",
      ),
    ).toEqual({
      leftSourceId: "source/left",
      leftVersionId: "version/left",
      rightSourceId: "source-right",
      rightVersionId: "version-right",
      spaceId: "space/a",
    });
  });

  it.each([
    "compare/source-left/version/version-left/with/source-right/version/version-right?space=space-a",
    "#compare/source-left/version/version-left/with/source-right/version/version-right",
    "#compare/source-left/version/version-left/with/source-right/version/version-right?space=",
    "#compare/source-left/version/version-left/with/source-right/version/version-right?other=space-a",
    "#compare/source-left/version/version-left/with/source-right/version/version-right?space=space-a&view=split",
    "#compare/source-left/version/version-left/with/source-right/version/version-right/extra?space=space-a",
    "#compare/source-left/version/version-left/with/source-right/version/?space=space-a",
    "#compare/source-left/version/version-left/with/source-left/version/version-right?space=space-a",
    "#compare/%E0%A4%A/version/version-left/with/source-right/version/version-right?space=space-a",
    "#compare/source-left/version/version-left/with/source-right/version/version-right?space=%E0%A4%A",
  ])("rejects invalid or incomplete fragments: %s", (hash) => {
    expect(parseComparisonRoute(hash)).toBeUndefined();
  });

  it.each([
    { ...route, leftSourceId: "" },
    { ...route, leftVersionId: "" },
    { ...route, rightSourceId: "" },
    { ...route, rightVersionId: "" },
    { ...route, spaceId: "" },
    { ...route, rightSourceId: route.leftSourceId },
  ])("refuses invalid formatter input", (invalidRoute) => {
    expect(() => formatComparisonRoute(invalidRoute)).toThrow();
  });
});
