// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_USAGE_CHANGED_EVENT, type AiRequestUsage } from "@/lib/ai-request-usage";

const mock = vi.hoisted(() => ({ getAiRequestUsage: vi.fn() }));
vi.mock("@/lib/cloud", () => ({ getAiRequestUsage: mock.getAiRequestUsage }));
import AiUsagePanel from "./ai-usage-panel";

function usage(usedCount = 12, dailyLimit = 50): AiRequestUsage {
  return {
    usedCount,
    dailyLimit,
    remainingCount: Math.max(0, dailyLimit - usedCount),
    windowStart: "2026-09-14T00:00:00.000Z",
    resetsAt: "2026-09-15T00:00:00.000Z",
    checkedAt: "2026-09-14T12:00:00.000Z",
    counting: "reserved_requests",
    includesFailedAndCancelled: true,
    tokens: { promptTokens: 120, completionTokens: 30, limit: 0 },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("AI usage panel", () => {
  let host: HTMLDivElement;
  let root: Root;
  const render = async (
    userId: string | undefined = "owner-a",
    contextKey = "1:normal",
    enabled = true,
  ) => {
    await act(async () =>
      root.render(createElement(AiUsagePanel, { userId, contextKey, enabled })),
    );
  };
  const metric = (label: string) =>
    [...host.querySelectorAll("dl > div")]
      .find((entry) => entry.querySelector("dt")?.textContent === label)
      ?.querySelector("dd")
      ?.textContent?.trim();
  const refresh = async () => {
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T12:00:00.000Z"));
    mock.getAiRequestUsage.mockReset().mockResolvedValue(usage());
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shows only sampled reservation counts, both reset timezones, and the failure/cancellation policy", async () => {
    await render();
    expect(metric("今日已用")).toBe("12 次");
    expect(metric("剩余次数")).toBe("38 次");
    expect(metric("每日上限")).toBe("50 次");
    expect(host.textContent).toContain("每天 UTC 00:00 重置");
    expect(host.querySelector('time[datetime="2026-09-15T00:00:00.000Z"]')).not.toBeNull();
    expect(host.textContent).toContain("本机时间");
    expect(host.textContent).toContain("失败、取消和超时也计入");
    expect(host.textContent).toContain("缓存结果不新增次数");
    expect(host.textContent).toContain("供应商费用另行计算");
    expect(host.textContent).toContain("提示 token");
    expect(host.textContent).toContain("120");
    expect(host.textContent).toContain("补全 token");
    expect(host.textContent).toContain("30");
    expect(host.textContent).toContain("按 token 计量未启用");
  });

  it("shows the configured token limit and approximate usage policy", async () => {
    mock.getAiRequestUsage.mockResolvedValue({
      ...usage(12, 50),
      tokens: { promptTokens: 1200, completionTokens: 300, limit: 2000 },
    });
    await render();
    expect(host.textContent).toContain("token 上限");
    expect(host.textContent).toContain("2,000");
    expect(host.textContent).toContain("近似值");
  });

  it("does not fetch or invent a balance without a confirmed account context", async () => {
    await render("", "local");
    expect(mock.getAiRequestUsage).not.toHaveBeenCalled();
    expect(host.querySelector("dl")).toBeNull();
    await render("owner-a", "loading", false);
    expect(mock.getAiRequestUsage).not.toHaveBeenCalled();
    expect(host.textContent).toContain("正在确认当前工作区");
  });

  it("keeps loading and unavailable balances unknown instead of reporting zero or exhausted", async () => {
    const pending = deferred<AiRequestUsage>();
    mock.getAiRequestUsage.mockReturnValue(pending.promise);
    await render();
    expect(host.textContent).toContain("正在读取当前账号");
    expect(host.querySelector("dl")).toBeNull();
    mock.getAiRequestUsage.mockRejectedValue(
      Object.assign(new Error("请求记录服务尚未配置。"), { name: "CloudError" }),
    );
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(host.textContent).toContain("请求记录服务尚未配置");
    expect(host.textContent).toContain("不代表次数已用完");
    expect(host.querySelector("dl")).toBeNull();
    await act(async () => pending.resolve(usage(0)));
    expect(host.querySelector("dl")).toBeNull();
  });

  it("removes stale numbers on refresh failure and supports a successful explicit retry", async () => {
    await render();
    mock.getAiRequestUsage.mockRejectedValue(new Error("private failed payload"));
    await refresh();
    expect(host.querySelector("dl")).toBeNull();
    expect(host.textContent).toContain("用量暂不可用");
    expect(host.textContent).not.toContain("private failed payload");
    mock.getAiRequestUsage.mockResolvedValue(usage(17));
    await refresh();
    expect(metric("今日已用")).toBe("17 次");
    expect(metric("剩余次数")).toBe("33 次");
  });

  it("keeps used counts larger than a lowered limit and reports real exhaustion", async () => {
    mock.getAiRequestUsage.mockResolvedValue(usage(64, 10));
    await render();
    expect(metric("今日已用")).toBe("64 次");
    expect(metric("每日上限")).toBe("10 次");
    expect(metric("剩余次数")).toBe("0 次");
    expect(host.textContent).toContain("阅读、普通搜索和导出仍可使用");
  });

  it("discards account/context results during render and rejects callbacks from the previous subtree", async () => {
    await render();
    const old = deferred<AiRequestUsage>();
    mock.getAiRequestUsage.mockReturnValueOnce(old.promise);
    await render("owner-a", "2:cloud-readonly");
    expect(host.querySelector("dl")).toBeNull();
    const previousSignal = mock.getAiRequestUsage.mock.calls[1][1] as AbortSignal;
    mock.getAiRequestUsage.mockResolvedValue(usage(8));
    await render("owner-b", "3:normal");
    expect(previousSignal.aborted).toBe(true);
    expect(metric("今日已用")).toBe("8 次");
    await act(async () => old.resolve(usage(33)));
    expect(metric("今日已用")).toBe("8 次");
    await render("owner-b", "3:normal", false);
    expect(host.querySelector("dl")).toBeNull();
  });

  it("refreshes on focus, usage events, and visible-tab return without accepting earlier replies", async () => {
    await render();
    const old = deferred<AiRequestUsage>();
    mock.getAiRequestUsage.mockReturnValueOnce(old.promise).mockResolvedValueOnce(usage(16));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(host.querySelector("dl")).toBeNull();
    const oldSignal = mock.getAiRequestUsage.mock.calls[1][1] as AbortSignal;
    await act(async () => window.dispatchEvent(new Event(AI_USAGE_CHANGED_EVENT)));
    expect(oldSignal.aborted).toBe(true);
    expect(metric("今日已用")).toBe("16 次");
    await act(async () => old.resolve(usage(0)));
    expect(metric("今日已用")).toBe("16 次");
    mock.getAiRequestUsage.mockResolvedValue(usage(18));
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(metric("今日已用")).toBe("18 次");
  });

  it("refreshes at the server UTC reset even if the computer wall clock is wrong", async () => {
    vi.setSystemTime(new Date("2031-01-01T08:00:00.000Z"));
    const oldDay = { ...usage(49), checkedAt: "2026-09-14T23:59:59.000Z" };
    const nextDay = {
      ...usage(0),
      windowStart: "2026-09-15T00:00:00.000Z",
      checkedAt: "2026-09-15T00:00:00.060Z",
      resetsAt: "2026-09-16T00:00:00.000Z",
    };
    mock.getAiRequestUsage.mockResolvedValueOnce(oldDay).mockResolvedValueOnce(nextDay);
    await render();
    expect(metric("剩余次数")).toBe("1 次");
    await act(async () => vi.advanceTimersByTimeAsync(1_100));
    expect(mock.getAiRequestUsage).toHaveBeenCalledTimes(2);
    expect(metric("剩余次数")).toBe("50 次");
  });

  it("does not publish yesterday's count when an in-flight read crosses the reset", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const pending = deferred<AiRequestUsage>();
    mock.getAiRequestUsage.mockReturnValue(pending.promise);
    await render();
    now.mockReturnValue(2_000);
    await act(async () => pending.resolve({ ...usage(49), checkedAt: "2026-09-14T23:59:59.000Z" }));
    expect(host.querySelector("dl")).toBeNull();
    expect(host.textContent).toContain("已过统计日期");
  });

  it("does not make reset or usage-event reads in a hidden tab, and aborts on unmount", async () => {
    mock.getAiRequestUsage.mockResolvedValue({
      ...usage(49),
      checkedAt: "2026-09-14T23:59:59.000Z",
    });
    await render();
    const visible = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => vi.advanceTimersByTimeAsync(1_100));
    await act(async () => window.dispatchEvent(new Event(AI_USAGE_CHANGED_EVENT)));
    expect(mock.getAiRequestUsage).toHaveBeenCalledTimes(1);
    expect(host.querySelector("dl")).toBeNull();
    visible.mockReturnValue("visible");
    const pending = deferred<AiRequestUsage>();
    mock.getAiRequestUsage.mockReturnValue(pending.promise);
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    const signal = mock.getAiRequestUsage.mock.calls[1][1] as AbortSignal;
    await render("", "local");
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(usage(0)));
    expect(host.querySelector("dl")).toBeNull();
  });
});
