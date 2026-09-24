// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyWorkspace } from "@/lib/seed";
import HomeSection from "./home-section";

const getLearningOverview = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cloud", () => ({ getLearningOverview }));

describe("HomeSection learning overview", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_CONUO_FEATURE_LEARNING", "on");
    getLearningOverview.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllEnvs();
  });

  function renderHome() {
    const data = createEmptyWorkspace();
    const space = data.spaces[0]!;
    data.conversations.push({
      id: "open-question",
      spaceId: space.id,
      title: "最近的问题",
      scope: "space",
      sourceIds: [],
      messages: [],
      resolved: false,
      updatedAt: new Date().toISOString(),
    });
    return act(async () => {
      root.render(
        createElement(HomeSection, {
          data,
          activeSpace: space,
          user: { id: "owner-a", email: "learner@example.test" },
          busy: false,
          visibleSources: [],
          scopedNotes: [],
          primaryContinuation: null,
          secondaryContinuedSources: [],
          pendingQuestions: data.conversations,
          update: vi.fn(),
          setToast: vi.fn(),
          navigate: vi.fn(),
          openImport: vi.fn(),
          openSpaceCreation: vi.fn(),
          openSource: vi.fn(),
          openNote: vi.fn(),
          openConversation: vi.fn(),
          newNote: vi.fn(),
          openExport: vi.fn(),
          setSpaceToDeleteId: vi.fn(),
          setModal: vi.fn(),
          startReview: vi.fn(),
          openTargetedPractice: vi.fn(),
        }),
      );
      await Promise.resolve();
    });
  }

  it("shows today's learning card with recent questions and weak concepts", async () => {
    getLearningOverview.mockResolvedValue({
      dueCount: 2,
      newCount: 1,
      reviewsLast7d: 4,
      weakConcepts: [
        {
          conceptKey: "梯度下降",
          forgottenCount: 2,
          latestIncorrect: false,
          spaceId: "space-1",
          itemIds: ["item-1"],
          citations: [],
        },
      ],
    });
    await renderHome();

    await vi.waitFor(() => expect(host.textContent).toContain("今日学习"));
    expect(host.textContent).toContain("今日到期 2 道");
    expect(host.textContent).toContain("最近的问题");
    expect(host.textContent).toContain("梯度下降");
    expect(host.textContent).toContain("最近答错较多");
  });

  it("does not render an empty learning card when the overview has no data", async () => {
    const data = createEmptyWorkspace();
    getLearningOverview.mockResolvedValue({
      dueCount: 0,
      newCount: 0,
      reviewsLast7d: 0,
      weakConcepts: [],
    });
    await act(async () => {
      root.render(
        createElement(HomeSection, {
          data,
          activeSpace: data.spaces[0]!,
          user: { id: "owner-a", email: "learner@example.test" },
          busy: false,
          visibleSources: [],
          scopedNotes: [],
          primaryContinuation: null,
          secondaryContinuedSources: [],
          pendingQuestions: [],
          update: vi.fn(),
          setToast: vi.fn(),
          navigate: vi.fn(),
          openImport: vi.fn(),
          openSpaceCreation: vi.fn(),
          openSource: vi.fn(),
          openNote: vi.fn(),
          openConversation: vi.fn(),
          newNote: vi.fn(),
          openExport: vi.fn(),
          setSpaceToDeleteId: vi.fn(),
          setModal: vi.fn(),
          startReview: vi.fn(),
          openTargetedPractice: vi.fn(),
        }),
      );
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain("今日学习");
  });
});
