import { describe, expect, it } from "vitest";
import { aiFeatureEnabled } from "./features";

describe("AI feature switches", () => {
  it("treats empty and off as disabled and on as enabled", () => {
    expect(aiFeatureEnabled("LONG_CONTEXT", {})).toBe(false);
    expect(aiFeatureEnabled("LONG_CONTEXT", { CONUO_FEATURE_LONG_CONTEXT: "off" })).toBe(false);
    expect(aiFeatureEnabled("LONG_CONTEXT", { CONUO_FEATURE_LONG_CONTEXT: "on" })).toBe(true);
  });

  it("rejects invalid switch values", () => {
    expect(() =>
      aiFeatureEnabled("RICH_ANSWERS", { CONUO_FEATURE_RICH_ANSWERS: "yes" }),
    ).toThrowError("功能开关配置无效");
  });
});
