import { describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  enabled: false,
  readModelProfile: vi.fn(),
}));

vi.mock("./features", () => ({
  aiFeatureEnabled: () => mock.enabled,
}));
vi.mock("./model", () => ({
  readModelProfile: mock.readModelProfile,
}));

import { selectAnswerProfile } from "./model-routing";

describe("model routing", () => {
  it("keeps deep answers on default while the feature is disabled", () => {
    mock.enabled = false;
    mock.readModelProfile.mockReturnValue({ profile: "default", config: {} });
    selectAnswerProfile("deep");
    expect(mock.readModelProfile).toHaveBeenLastCalledWith("default");
  });

  it("uses reasoning for deep answers when the feature is enabled", () => {
    mock.enabled = true;
    mock.readModelProfile.mockReturnValue({ profile: "reasoning", config: {} });
    selectAnswerProfile("deep");
    expect(mock.readModelProfile).toHaveBeenLastCalledWith("reasoning");
  });
});
