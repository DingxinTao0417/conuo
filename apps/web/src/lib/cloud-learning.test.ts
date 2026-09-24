import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn<typeof fetch>();

vi.mock("./supabase/config", () => ({
  getSupabaseConfig: () => ({ url: "https://project.example.test", key: "test-key" }),
}));

import {
  getLearningQueue,
  getLearningSettings,
  recordLearningReview,
  saveLearningSettings,
} from "./cloud";

const item = {
  itemId: "item-a",
  spaceId: "space-a",
  kind: "short",
  prompt: "解释学习率。",
  choices: null,
  answer: { text: "学习率是步长系数。" },
  explanation: "它决定每次更新走多远。",
  citations: [],
  origin: "user",
  originRef: null,
  conceptKey: "学习率",
  hints: [],
  status: "active",
  createdAt: "2026-09-24T00:00:00.000Z",
  updatedAt: "2026-09-24T00:00:00.000Z",
  deletedAt: null,
  card: { due: "2026-09-24T00:00:00.000Z", reps: 0, lapses: 0, state: 0 },
  dueAt: "2026-09-24T00:00:00.000Z",
  version: 0,
  reps: 0,
  lapses: 0,
  lastReviewAt: null,
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("learning cloud adapter", () => {
  it("loads a validated queue with the owner header", async () => {
    fetchMock.mockResolvedValue(Response.json({ items: [item] }));

    await expect(getLearningQueue("space-a", "owner-a")).resolves.toEqual([item]);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/v1/learning/queue?spaceId=space-a&limit=100",
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
        headers: expect.objectContaining({ "X-Conuo-User": "owner-a" }),
      }),
    );
  });

  it("rejects malformed queue entries instead of rendering them", async () => {
    fetchMock.mockResolvedValue(Response.json({ items: [{ ...item, version: -1 }] }));
    await expect(getLearningQueue("space-a", "owner-a")).rejects.toMatchObject({
      code: "INVALID_LEARNING_QUEUE_RESPONSE",
    });
  });

  it("round trips settings and review records through strict endpoints", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ dailyNewLimit: 20, desiredRetention: 0.9, paused: false }),
      )
      .mockResolvedValueOnce(
        Response.json({ dailyNewLimit: 12, desiredRetention: 0.85, paused: true }),
      )
      .mockResolvedValueOnce(Response.json(item));

    await expect(getLearningSettings("owner-a")).resolves.toEqual({
      dailyNewLimit: 20,
      desiredRetention: 0.9,
      paused: false,
    });
    await expect(
      saveLearningSettings("owner-a", { dailyNewLimit: 12, desiredRetention: 0.85, paused: true }),
    ).resolves.toEqual({ dailyNewLimit: 12, desiredRetention: 0.85, paused: true });
    await expect(
      recordLearningReview("owner-a", {
        itemId: "item-a",
        rating: 3,
        answerText: "学习率是步长。",
        expectedVersion: 0,
      }),
    ).resolves.toMatchObject({ itemId: "item-a", version: 0 });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/learning/settings");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/v1/learning/reviews");
  });
});
