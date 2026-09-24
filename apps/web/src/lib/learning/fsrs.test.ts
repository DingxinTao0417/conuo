import { describe, expect, it } from "vitest";
import { newReviewCard, scheduleReview } from "./fsrs";

describe("learning FSRS scheduling", () => {
  it("creates a card that is due immediately and survives JSON round trips", () => {
    const now = new Date("2026-09-24T12:00:00.000Z");
    const created = newReviewCard(now);
    expect(created.dueAt).toBe(now.toISOString());
    expect(created.card.due).toBe(now.toISOString());

    const scheduled = scheduleReview(created.card, 3, 0.9, now);
    expect(scheduled.card.due).toBe(scheduled.dueAt);
    expect(new Date(scheduled.dueAt).getTime()).toBeGreaterThan(now.getTime());
  });

  it("orders the first review intervals by rating", () => {
    const now = new Date("2026-09-24T12:00:00.000Z");
    const card = newReviewCard(now).card;
    const due = ([1, 2, 3, 4] as const).map((rating) =>
      new Date(scheduleReview(card, rating, 0.9, now).dueAt).getTime(),
    );
    expect(due[0]).toBeLessThan(due[1]);
    expect(due[1]).toBeLessThan(due[2]);
    expect(due[2]).toBeLessThan(due[3]);
  });
});
