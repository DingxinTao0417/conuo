// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InstallAppPanel from "./install-app-panel";

type MatchMediaListener = (event: MediaQueryListEvent) => void;

let host: HTMLDivElement;
let root: Root;
let standalone = false;
let listeners = new Set<MatchMediaListener>();
let originalUserAgent: PropertyDescriptor | undefined;
let originalMaxTouchPoints: PropertyDescriptor | undefined;
let originalStandalone: PropertyDescriptor | undefined;

function setNavigator({ userAgent = "Mozilla/5.0", maxTouchPoints = 0, installed = false } = {}) {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: userAgent,
  });
  Object.defineProperty(window.navigator, "maxTouchPoints", {
    configurable: true,
    value: maxTouchPoints,
  });
  Object.defineProperty(window.navigator, "standalone", {
    configurable: true,
    value: installed,
  });
}

async function render() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<InstallAppPanel />));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  standalone = false;
  listeners = new Set();
  originalUserAgent = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");
  originalMaxTouchPoints = Object.getOwnPropertyDescriptor(window.navigator, "maxTouchPoints");
  originalStandalone = Object.getOwnPropertyDescriptor(window.navigator, "standalone");
  vi.stubGlobal(
    "matchMedia",
    vi.fn(
      (query: string) =>
        ({
          matches: query === "(display-mode: standalone)" && standalone,
          media: query,
          addEventListener: (_: "change", listener: MatchMediaListener) => listeners.add(listener),
          removeEventListener: (_: "change", listener: MatchMediaListener) =>
            listeners.delete(listener),
        }) as unknown as MediaQueryList,
    ),
  );
  setNavigator();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  if (originalUserAgent) Object.defineProperty(window.navigator, "userAgent", originalUserAgent);
  if (originalMaxTouchPoints)
    Object.defineProperty(window.navigator, "maxTouchPoints", originalMaxTouchPoints);
  if (originalStandalone) Object.defineProperty(window.navigator, "standalone", originalStandalone);
  vi.unstubAllGlobals();
});

describe("InstallAppPanel", () => {
  it("uses a browser-provided prompt only after the learner asks to install", async () => {
    const prompt = vi.fn(async () => undefined);
    const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: "accepted"; platform: string }>;
    };
    Object.assign(event, {
      prompt,
      userChoice: Promise.resolve({ outcome: "accepted", platform: "web" }),
    });
    await render();

    await act(async () => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    const button = host.querySelector<HTMLButtonElement>("button");
    expect(button?.textContent).toContain("安装应用");
    expect(prompt).not.toHaveBeenCalled();

    await act(async () => button?.click());
    expect(prompt).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("已请求浏览器安装 Conuo");
  });

  it("explains the manual Safari route without claiming offline support", async () => {
    setNavigator({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" });
    await render();

    expect(host.textContent).toContain("添加到主屏");
    expect(host.textContent).toContain("Safari");
    expect(host.textContent).toContain("安装不下载离线资料");
    expect(host.querySelector("button")).toBeNull();
  });

  it("reports standalone mode after an install event", async () => {
    await render();

    await act(async () => window.dispatchEvent(new Event("appinstalled")));
    expect(host.textContent).toContain("已作为应用打开");
    expect(host.textContent).toContain("Conuo 已添加到此设备");
  });
});
