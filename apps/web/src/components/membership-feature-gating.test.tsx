// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountMembership } from "@/lib/membership";

const mock = vi.hoisted(() => ({ getAccountMembership: vi.fn() }));
vi.mock("@/lib/cloud", () => mock);

import { resetMembershipFeatureCache, useMembershipFeature } from "@/lib/use-membership-features";

const membership: AccountMembership = {
  planCode: "free",
  planName: "免费版",
  source: null,
  startsAt: null,
  endsAt: null,
  afterEnd: null,
  enforcement: "on",
  limits: { aiDailyRequests: 20, learningSpaces: 1 },
  features: {
    vision_region: false,
    organization: false,
    learning_ai: false,
    deep_thinking: false,
    tutor_mode: false,
  },
  plans: [],
};

function Probe({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function FeatureProbe({ feature }: { feature: "organization" | "learning_ai" }) {
  const state = useMembershipFeature("owner-a", feature);
  return (
    <div>
      <span data-ready={state.ready ? "yes" : "no"}>{state.allowed ? "可用" : "不可用"}</span>
      <p>{state.reason}</p>
    </div>
  );
}

describe("membership AI feature gating", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubEnv("NEXT_PUBLIC_CONUO_FEATURE_ORGANIZATION", "on");
    vi.stubEnv("NEXT_PUBLIC_CONUO_FEATURE_LEARNING", "on");
    mock.getAccountMembership.mockResolvedValue(membership);
    resetMembershipFeatureCache();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    resetMembershipFeatureCache();
  });

  it("shares one membership read and disables a feature closed by the plan", async () => {
    await act(async () => root.render(<FeatureProbe feature="organization" />));
    await act(async () => await Promise.resolve());
    expect(host.textContent).toContain("不可用");
    expect(host.textContent).toContain("当前会员等级未开放此功能");
    expect(mock.getAccountMembership).toHaveBeenCalledOnce();

    await act(async () => root.render(<FeatureProbe feature="learning_ai" />));
    await act(async () => await Promise.resolve());
    expect(mock.getAccountMembership).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("不可用");
  });

  it("keeps local workspaces on the deployment switch without a cloud account", async () => {
    function LocalProbe() {
      const state = useMembershipFeature(undefined, "organization");
      return <span>{state.allowed ? "可用" : "不可用"}</span>;
    }
    await act(async () =>
      root.render(
        <Probe>
          <LocalProbe />
        </Probe>,
      ),
    );
    expect(host.textContent).toBe("可用");
    expect(mock.getAccountMembership).not.toHaveBeenCalled();
  });

  it("falls back to the deployment switch when the membership endpoint is unavailable", async () => {
    mock.getAccountMembership.mockRejectedValue(new Error("staging migration missing"));
    await act(async () => root.render(<FeatureProbe feature="organization" />));
    await act(async () => await Promise.resolve());
    expect(host.querySelector("span")?.textContent).toBe("可用");
    expect(host.querySelector("span")?.dataset.ready).toBe("yes");
    expect(host.querySelector("p")?.textContent).toBe("");
  });

  it("retries a failed read and picks up a later grant when the page regains focus", async () => {
    vi.useFakeTimers();
    try {
      mock.getAccountMembership.mockRejectedValueOnce(new Error("temporary"));
      await act(async () => root.render(<FeatureProbe feature="organization" />));
      await act(async () => await Promise.resolve());
      expect(mock.getAccountMembership).toHaveBeenCalledTimes(1);

      // Too soon after a failure: no request storm.
      await act(async () => window.dispatchEvent(new Event("focus")));
      expect(mock.getAccountMembership).toHaveBeenCalledTimes(1);

      await act(async () => vi.advanceTimersByTime(16_000));
      await act(async () => window.dispatchEvent(new Event("focus")));
      await act(async () => await Promise.resolve());
      expect(mock.getAccountMembership).toHaveBeenCalledTimes(2);
      expect(host.textContent).toContain("当前会员等级未开放此功能");

      mock.getAccountMembership.mockResolvedValue({
        ...membership,
        features: { ...membership.features, organization: true },
      });
      await act(async () => vi.advanceTimersByTime(61_000));
      await act(async () => window.dispatchEvent(new Event("focus")));
      await act(async () => await Promise.resolve());
      expect(mock.getAccountMembership).toHaveBeenCalledTimes(3);
      expect(host.querySelector("span")?.textContent).toBe("可用");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the last known plan when a refresh fails", async () => {
    vi.useFakeTimers();
    try {
      await act(async () => root.render(<FeatureProbe feature="organization" />));
      await act(async () => await Promise.resolve());
      mock.getAccountMembership.mockRejectedValue(new Error("temporary"));
      await act(async () => vi.advanceTimersByTime(61_000));
      await act(async () => window.dispatchEvent(new Event("focus")));
      await act(async () => await Promise.resolve());
      expect(mock.getAccountMembership).toHaveBeenCalledTimes(2);
      expect(host.textContent).toContain("当前会员等级未开放此功能");
    } finally {
      vi.useRealTimers();
    }
  });
});
