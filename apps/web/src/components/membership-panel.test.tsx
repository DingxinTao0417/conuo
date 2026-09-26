// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountMembership } from "@/lib/membership";

const mock = vi.hoisted(() => ({ getAccountMembership: vi.fn() }));
vi.mock("@/lib/cloud", () => ({ getAccountMembership: mock.getAccountMembership }));
import MembershipPanel from "./membership-panel";

const plans: AccountMembership["plans"] = [
  {
    code: "free",
    name: "免费版",
    description: "",
    limits: { aiDailyRequests: 20, learningSpaces: 1 },
  },
  {
    code: "pro",
    name: "专业版",
    description: "",
    limits: { aiDailyRequests: 100, learningSpaces: 5 },
  },
  {
    code: "max",
    name: "旗舰版",
    description: "",
    limits: { aiDailyRequests: 300, learningSpaces: 20 },
  },
];
function membership(overrides: Partial<AccountMembership> = {}): AccountMembership {
  return {
    planCode: "free",
    planName: "免费版",
    source: null,
    startsAt: null,
    endsAt: null,
    afterEnd: null,
    enforcement: "on",
    limits: { aiDailyRequests: 20, learningSpaces: 1 },
    features: {
      vision_region: true,
      organization: true,
      learning_ai: false,
      deep_thinking: true,
      tutor_mode: true,
    },
    plans,
    ...overrides,
  };
}

describe("membership panel", () => {
  let host: HTMLDivElement;
  let root: Root;
  const render = async (userId: string | undefined, enabled = true) => {
    await act(async () =>
      root.render(createElement(MembershipPanel, { userId, contextKey: "1:normal", enabled })),
    );
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mock.getAccountMembership.mockReset().mockResolvedValue(membership());
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("shows the default free plan, its limits, unavailable features and a disabled upgrade", async () => {
    await render("owner-a");
    expect(mock.getAccountMembership).toHaveBeenCalledWith("owner-a", expect.any(AbortSignal));
    expect(host.querySelector(".membership-badge")?.textContent).toBe("免费版");
    expect(host.textContent).toContain("未开通会员，默认免费版");
    expect(host.textContent).toContain("20 次");
    const learning = [...host.querySelectorAll(".membership-features li")].find((item) =>
      item.textContent?.includes("学习 AI"),
    );
    expect(learning?.textContent).toContain("未开放");
    expect(host.querySelector('tr[aria-current="true"]')?.textContent).toContain("免费版");
    const upgrade = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("升级"),
    );
    expect(upgrade?.disabled).toBe(true);
    expect(host.textContent).not.toContain("已付款");
    expect(host.textContent).not.toContain("自动续费");
  });

  it("shows a promotion's end and the plan it falls back to", async () => {
    mock.getAccountMembership.mockResolvedValue(
      membership({
        planCode: "max",
        planName: "旗舰版",
        source: "promotion",
        startsAt: "2026-09-25T00:00:00.000Z",
        endsAt: "2026-10-25T00:00:00.000Z",
        afterEnd: "pro",
        limits: { aiDailyRequests: 300, learningSpaces: 20 },
      }),
    );
    await render("owner-a");
    expect(host.textContent).toContain("活动赠送");
    expect(host.querySelector('time[datetime="2026-10-25T00:00:00.000Z"]')).not.toBeNull();
    expect(host.textContent).toContain("到期后为专业版");
  });

  it("explains that plan limits are not yet enforced", async () => {
    mock.getAccountMembership.mockResolvedValue(membership({ enforcement: "shadow" }));
    await render("owner-a");
    expect(host.textContent).toContain("会员额度试运行中");
  });

  it("reports an unavailable membership without guessing a plan", async () => {
    mock.getAccountMembership.mockRejectedValue(
      Object.assign(new Error("暂时无法读取会员信息，请稍后刷新。"), { name: "CloudError" }),
    );
    await render("owner-a");
    expect(host.textContent).toContain("会员信息暂不可用");
    expect(host.querySelector(".membership-badge")).toBeNull();
  });

  it("does not read before sign-in or while the workspace is not ready", async () => {
    await render(undefined);
    expect(host.textContent).toContain("登录后可查看");
    await render("owner-a", false);
    expect(mock.getAccountMembership).not.toHaveBeenCalled();
  });
});
