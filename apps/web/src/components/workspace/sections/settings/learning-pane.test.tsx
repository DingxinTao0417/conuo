// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LearningPane from "./learning-pane";

const mock = vi.hoisted(() => ({
  getLearningSettings: vi.fn(),
  saveLearningSettings: vi.fn(),
}));
vi.mock("@/lib/cloud", () => mock);

describe("LearningPane", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    mock.getLearningSettings.mockReset();
    mock.saveLearningSettings.mockReset();
    mock.getLearningSettings.mockResolvedValue({
      dailyNewLimit: 20,
      desiredRetention: 0.9,
      paused: false,
    });
    mock.saveLearningSettings.mockImplementation(async (_userId, settings) => settings);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(LearningPane, {
          user: { id: "owner-a", email: "learner@example.test" },
        }),
      );
      await Promise.resolve();
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("saves pause changes immediately and keeps the retention bounds visible", async () => {
    await vi.waitFor(() => expect(host.textContent).toContain("目标记忆保持率"));
    expect(host.textContent).toContain("0.80–0.95");
    const paused = host.querySelector<HTMLInputElement>('input[aria-label="暂停复习"]');
    expect(paused).toBeInstanceOf(HTMLInputElement);
    await act(async () => {
      paused!.click();
      await Promise.resolve();
    });
    expect(mock.saveLearningSettings).toHaveBeenCalledWith("owner-a", {
      dailyNewLimit: 20,
      desiredRetention: 0.9,
      paused: true,
    });
  });
});
