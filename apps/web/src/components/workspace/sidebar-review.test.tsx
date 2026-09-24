// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyWorkspace } from "@/lib/seed";
import WorkspaceSidebar from "./sidebar";
import type { Section } from "./navigation";

const { getLearningQueue } = vi.hoisted(() => ({ getLearningQueue: vi.fn() }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/cloud", () => ({ getLearningQueue }));

describe("WorkspaceSidebar review entry", () => {
  let host: HTMLDivElement;
  let root: Root;
  let navigate: (section: Section) => void;

  beforeEach(async () => {
    vi.stubEnv("NEXT_PUBLIC_CONUO_FEATURE_LEARNING", "on");
    getLearningQueue.mockReset();
    getLearningQueue.mockResolvedValue([{ itemId: "item-a" }]);
    navigate = vi.fn<(section: Section) => void>();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(WorkspaceSidebar, {
          data: createEmptyWorkspace(),
          user: { id: "owner-a", email: "learner@example.test" },
          cloudConfigured: true,
          sidebar: false,
          setSidebar: vi.fn(),
          section: "home",
          spaceId: "all",
          sourceId: null,
          currentSource: undefined,
          currentNote: undefined,
          pinnedSources: [],
          navigate,
          openCollectionHome: vi.fn(),
          chooseSpace: vi.fn(),
          openSource: vi.fn(),
          openSpaceCreation: vi.fn(),
          openAccountSettings: vi.fn(),
        }),
      );
      await Promise.resolve();
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllEnvs();
  });

  it("shows the due badge and routes to review", async () => {
    await vi.waitFor(() => expect(host.textContent).toContain("复习"));
    const review = host.querySelector<HTMLButtonElement>('button[aria-label="复习"]');
    expect(review?.textContent).toContain("1");
    await act(async () => review?.click());
    expect(navigate).toHaveBeenCalledWith("review");
  });
});
