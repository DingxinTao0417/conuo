// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceData } from "@/lib/types";
import ReviewSection from "./review-section";

const mock = vi.hoisted(() => ({
  CloudError: class CloudError extends Error {
    constructor(
      message: string,
      public status = 500,
      public code = "CLOUD_ERROR",
    ) {
      super(message);
    }
  },
  getLearningQueue: vi.fn(),
  getLearningSettings: vi.fn(),
  recordLearningReview: vi.fn(),
  gradeLearningAnswer: vi.fn(),
}));

vi.mock("@/lib/cloud", () => mock);

const data = {
  schemaVersion: 1,
  spaces: [
    {
      id: "space-a",
      name: "机器学习",
      goal: "",
      color: "#4B3FE3",
      archived: false,
      createdAt: "2026-09-24T00:00:00.000Z",
    },
  ],
  sources: [],
  notes: [],
  annotations: [],
  conversations: [],
  aiEnabled: true,
  importJobs: [],
} satisfies WorkspaceData;

const item = {
  itemId: "item-a",
  spaceId: "space-a",
  kind: "short" as const,
  prompt: "解释学习率。",
  choices: null,
  answer: { text: "学习率是步长系数。", keyPoints: ["决定每次更新走多远"] },
  explanation: "它决定每次更新走多远。",
  citations: [],
  origin: "user" as const,
  originRef: null,
  conceptKey: "学习率",
  hints: [],
  status: "active" as const,
  card: { due: "2026-09-24T00:00:00.000Z", reps: 0, lapses: 0, state: 0 },
  dueAt: "2026-09-24T00:00:00.000Z",
  version: 0,
  reps: 0,
  lapses: 0,
  lastReviewAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mock.getLearningQueue.mockResolvedValue([item]);
  mock.getLearningSettings.mockResolvedValue({
    dailyNewLimit: 20,
    desiredRetention: 0.9,
    paused: false,
  });
  mock.recordLearningReview.mockResolvedValue({ ...item, version: 1 });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ReviewSection", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(ReviewSection, {
          data,
          spaceId: "space-a",
          user: { id: "owner-a", email: "learner@example.test" },
          openSource: vi.fn(),
        }),
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("moves from answering to answer reveal and records the selected rating", async () => {
    await act(async () => await Promise.resolve());
    expect(host.textContent).toContain("今日到期 1");
    await act(async () => host.querySelector<HTMLButtonElement>("button")?.click());
    expect(host.textContent).toContain("解释学习率。");

    const answer = host.querySelector<HTMLTextAreaElement>("textarea");
    expect(answer).toBeInstanceOf(HTMLTextAreaElement);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(answer, "学习率是步长。");
      answer!.dispatchEvent(new Event("input", { bubbles: true }));
      answer!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="查看答案"]')?.click(),
    );
    expect(host.textContent).toContain("学习率是步长系数。");
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="评分：记得"]')?.click(),
    );
    expect(mock.recordLearningReview).toHaveBeenCalledWith(
      "owner-a",
      expect.objectContaining({ itemId: "item-a", rating: 3, expectedVersion: 0 }),
    );
  });

  it("supports the space and number shortcuts while reviewing", async () => {
    await act(async () => await Promise.resolve());
    await act(async () => host.querySelector<HTMLButtonElement>("button")?.click());
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" })));
    expect(host.textContent).toContain("学习率是步长系数。");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "4" })));
    expect(mock.recordLearningReview).toHaveBeenCalledWith(
      "owner-a",
      expect.objectContaining({ rating: 4 }),
    );
  });

  it("refreshes the queue after a concurrent review conflict", async () => {
    mock.recordLearningReview.mockRejectedValueOnce(
      new mock.CloudError("冲突", 409, "LEARNING_REVIEW_CONFLICT"),
    );
    await act(async () => await Promise.resolve());
    await act(async () => host.querySelector<HTMLButtonElement>("button")?.click());
    const answer = host.querySelector<HTMLTextAreaElement>("textarea");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(answer, "学习率是步长。");
    answer?.dispatchEvent(new Event("input", { bubbles: true }));
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="查看答案"]')?.click(),
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="评分：记得"]')?.click(),
    );
    expect(host.textContent).toContain("这道题已在其他设备复习过");
    expect(mock.getLearningQueue).toHaveBeenCalledTimes(2);
  });

  it("does not offer a start button while review is paused", async () => {
    mock.getLearningSettings.mockResolvedValueOnce({
      dailyNewLimit: 20,
      desiredRetention: 0.9,
      paused: true,
    });
    await act(async () => {
      root.render(
        createElement(ReviewSection, {
          data,
          spaceId: "all",
          user: { id: "owner-a", email: "learner@example.test" },
          openSource: vi.fn(),
        }),
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(host.textContent).toContain("复习已暂停"));
    const start = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("开始复习"),
    );
    expect(start?.disabled).toBe(true);
    expect(host.textContent).toContain("复习已暂停");
  });
});
