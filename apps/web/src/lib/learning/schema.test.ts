import { describe, expect, it } from "vitest";
import { learningItemSchema, reviewRequestSchema } from "./schema";

describe("learning request schemas", () => {
  it("accepts bounded learning items and rejects oversized payload fields", () => {
    const valid = learningItemSchema.safeParse({
      itemId: "item-1",
      spaceId: "space-1",
      kind: "choice",
      prompt: "哪一个是正确答案？",
      choices: ["甲", "乙"],
      answer: { text: "甲", correctChoice: 0 },
      citations: [],
      origin: "user",
      status: "active",
    });
    expect(valid.success).toBe(true);
    expect(
      learningItemSchema.safeParse({
        itemId: "item-1",
        spaceId: "space-1",
        kind: "recall",
        prompt: "x".repeat(2001),
        answer: { text: "答案" },
        citations: [],
        origin: "user",
        status: "active",
      }).success,
    ).toBe(false);
  });

  it("requires the expected review version and a valid rating", () => {
    expect(
      reviewRequestSchema.safeParse({ itemId: "item-1", rating: 3, expectedVersion: 0 }).success,
    ).toBe(true);
    expect(
      reviewRequestSchema.safeParse({ itemId: "item-1", rating: 5, expectedVersion: 0 }).success,
    ).toBe(false);
  });
});
