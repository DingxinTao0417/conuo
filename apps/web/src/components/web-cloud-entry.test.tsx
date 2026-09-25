// @vitest-environment jsdom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudUser } from "@/lib/cloud";

const mock = vi.hoisted(() => ({
  configured: vi.fn(),
  subscribe: vi.fn(),
  mounted: vi.fn(),
  unmounted: vi.fn(),
  stop: vi.fn(),
  landing: vi.fn(),
}));

vi.mock("@/lib/cloud", () => ({
  isCloudConfigured: mock.configured,
  subscribeSession: mock.subscribe,
}));
vi.mock("next/image", () => ({
  default: ({
    src,
    alt,
    width,
    height,
  }: {
    src: string;
    alt: string;
    width: number;
    height: number;
  }) => createElement("img", { src, alt, width, height }),
}));
vi.mock("./workspace", () => ({
  default: function MockWorkspace({ storageMode }: { storageMode: string }) {
    useEffect(() => {
      mock.mounted(storageMode);
      return () => {
        mock.unmounted();
      };
    }, [storageMode]);
    return createElement("div", { "data-workspace": storageMode }, "账号工作区");
  },
}));
vi.mock("./account-panel", () => ({
  default: ({
    initialMode,
    onSessionChange,
    onClose,
  }: {
    initialMode?: string;
    onSessionChange: (user: CloudUser | null) => void;
    onClose: () => void;
  }) =>
    createElement(
      "section",
      { "aria-label": "账号登录", "data-mode": initialMode ?? "login" },
      createElement(
        "button",
        { onClick: () => onSessionChange({ id: "unverified", email: "cached@example.test" }) },
        "模拟面板登录通知",
      ),
      createElement("button", { onClick: onClose }, "关闭账号面板"),
    ),
}));

vi.mock("./landing/landing", () => ({
  default: function MockLanding({
    onAuth,
    paused,
  }: {
    onAuth: (mode: "login" | "signup", lang: "zh" | "en") => void;
    paused?: boolean;
  }) {
    useEffect(() => {
      mock.landing();
    }, []);
    return createElement(
      "div",
      { "data-landing": paused ? "paused" : "active" },
      createElement("button", { onClick: () => onAuth("signup", "zh") }, "主页开始使用"),
      createElement("button", { onClick: () => onAuth("login", "en") }, "Homepage log in"),
    );
  },
}));

import WebCloudEntry from "./web-cloud-entry";

const accountA: CloudUser = { id: "account-a", email: "a@example.test" };
const accountB: CloudUser = { id: "account-b", email: "b@example.test" };

describe("WebCloudEntry verified cloud-only gate", () => {
  let host: HTMLDivElement;
  let root: Root;
  let listener: (user: CloudUser | null) => void;
  let identityHint: (id: string | null) => void;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    mock.configured.mockReturnValue(true);
    mock.subscribe.mockImplementation((next: typeof listener, hint: typeof identityHint) => {
      listener = next;
      identityHint = hint;
      return mock.stop;
    });
    window.history.replaceState(null, "", "/#source/source-a");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render() {
    await act(async () => root.render(createElement(WebCloudEntry)));
  }
  async function verify(user: CloudUser | null) {
    await act(async () => listener(user));
  }
  function workspace() {
    return host.querySelector("[data-workspace]");
  }
  function landing() {
    return host.querySelector("[data-landing]");
  }
  function accountPanel() {
    return host.querySelector<HTMLElement>('[aria-label="账号登录"]');
  }
  function button(label: string) {
    const item = [...host.querySelectorAll("button")].find(
      (element) => element.textContent === label,
    );
    expect(item).toBeDefined();
    return item!;
  }

  it("server output only presents verification, never an anonymous workspace", () => {
    const html = renderToString(createElement(WebCloudEntry));
    expect(html).toContain("正在确认登录状态");
    expect(html).not.toContain("data-workspace");
    expect(mock.subscribe).not.toHaveBeenCalled();
  });

  it("keeps all workspace content unmounted until authoritative verification finishes", async () => {
    await render();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("正在确认登录状态");
    expect(workspace()).toBeNull();
    expect(host.querySelector('[aria-label="账号登录"]')).toBeNull();
    expect(mock.mounted).not.toHaveBeenCalled();
  });

  it("requires login with no workspace or anonymous continuation", async () => {
    await render();
    await verify(null);
    expect(host.querySelector('[aria-label="账号登录"]')).not.toBeNull();
    expect(workspace()).toBeNull();
    expect(host.textContent).not.toMatch(/继续使用本机|匿名工作区/);
    expect(mock.mounted).not.toHaveBeenCalled();
    await act(async () => button("关闭账号面板").click());
    expect(workspace()).toBeNull();
  });

  it("does not trust a child panel notification to authorize the cloud workspace", async () => {
    await render();
    await verify(null);
    await act(async () => button("模拟面板登录通知").click());
    expect(workspace()).toBeNull();
    expect(mock.mounted).not.toHaveBeenCalled();
  });

  it("unconfigured cloud presents an explicit failure without subscribing or local fallback", async () => {
    mock.configured.mockReturnValue(false);
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("云端配置");
    expect(host.textContent).toContain("云端服务暂不可用");
    expect(mock.subscribe).not.toHaveBeenCalled();
    expect(workspace()).toBeNull();
    expect(host.querySelector('[aria-label="账号登录"]')).toBeNull();
  });

  it("handles synchronous subscription failures as unavailable instead of local mode", async () => {
    mock.subscribe.mockImplementation(() => {
      throw new Error("browser auth unavailable");
    });
    await render();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(workspace()).toBeNull();
    expect(mock.mounted).not.toHaveBeenCalled();
  });

  it("retry returns to verification and only a later verified account opens cloud storage", async () => {
    mock.configured.mockReturnValue(false);
    await render();
    mock.configured.mockReturnValue(true);
    await act(async () => button("重新连接").click());
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    expect(workspace()).toBeNull();
    await verify(accountA);
    expect(workspace()?.getAttribute("data-workspace")).toBe("cloud");
    expect(mock.mounted).toHaveBeenCalledExactlyOnceWith("cloud");
  });

  it("login and logout preserve the original source deep link", async () => {
    await render();
    await verify(null);
    await verify(accountA);
    expect(workspace()?.getAttribute("data-workspace")).toBe("cloud");
    expect(window.location.hash).toBe("#source/source-a");
    await verify(null);
    expect(workspace()).toBeNull();
    expect(host.querySelector('[aria-label="账号登录"]')).not.toBeNull();
    expect(mock.unmounted).toHaveBeenCalledOnce();
    expect(window.location.hash).toBe("#source/source-a");
  });

  it("an identity hint revokes account A before verification can authorize account B", async () => {
    await render();
    await verify(accountA);
    await act(async () => identityHint(accountB.id));
    expect(workspace()).toBeNull();
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    expect(mock.unmounted).toHaveBeenCalledOnce();
    expect(mock.mounted).toHaveBeenCalledOnce();
    await verify(accountB);
    expect(mock.mounted).toHaveBeenCalledTimes(2);
    expect(workspace()?.getAttribute("data-workspace")).toBe("cloud");
  });

  it("a signout hint immediately removes the previous workspace", async () => {
    await render();
    await verify(accountA);
    await act(async () => identityHint(null));
    expect(workspace()).toBeNull();
    expect(mock.unmounted).toHaveBeenCalledOnce();
    await verify(null);
    expect(host.querySelector('[aria-label="账号登录"]')).not.toBeNull();
  });

  it("same-account token refresh preserves the mounted workspace", async () => {
    await render();
    await verify(accountA);
    await act(async () => identityHint(accountA.id));
    await verify({ ...accountA, email: "updated@example.test" });
    expect(mock.mounted).toHaveBeenCalledOnce();
    expect(mock.unmounted).not.toHaveBeenCalled();
  });

  it("a verified account switch remounts instead of reusing the prior workspace", async () => {
    await render();
    await verify(accountA);
    await verify(accountB);
    expect(mock.unmounted).toHaveBeenCalledOnce();
    expect(mock.mounted).toHaveBeenCalledTimes(2);
  });

  it("shows the public homepage to signed-out visitors without a workspace link", async () => {
    window.history.replaceState(null, "", "/");
    await render();
    expect(landing()).toBeNull();
    await verify(null);
    expect(landing()).not.toBeNull();
    expect(accountPanel()).toBeNull();
    expect(workspace()).toBeNull();
  });

  it("homepage calls to action open the account dialog in the requested mode", async () => {
    window.history.replaceState(null, "", "/");
    await render();
    await verify(null);
    await act(async () => button("主页开始使用").click());
    expect(accountPanel()?.dataset.mode).toBe("signup");
    expect(landing()?.getAttribute("data-landing")).toBe("paused");
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click(),
    );
    expect(accountPanel()).toBeNull();
    expect(landing()?.getAttribute("data-landing")).toBe("active");
    await act(async () => button("Homepage log in").click());
    expect(accountPanel()?.dataset.mode).toBe("login");
    expect(host.textContent).toContain("Log in to keep learning");
    expect(workspace()).toBeNull();
  });

  it("an unavailable cloud still shows the homepage and explains the failure on sign-in", async () => {
    window.history.replaceState(null, "", "/");
    mock.configured.mockReturnValue(false);
    await render();
    expect(landing()).not.toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => button("主页开始使用").click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("云端配置");
    expect(accountPanel()).toBeNull();
  });

  it("verification replaces the homepage with the workspace and closes the dialog", async () => {
    window.history.replaceState(null, "", "/");
    await render();
    await verify(null);
    await act(async () => button("主页开始使用").click());
    await verify(accountA);
    expect(landing()).toBeNull();
    expect(accountPanel()).toBeNull();
    expect(workspace()?.getAttribute("data-workspace")).toBe("cloud");
  });

  it("unsubscribes on unmount and ignores late account verification", async () => {
    await render();
    await act(async () => root.unmount());
    expect(mock.stop).toHaveBeenCalledOnce();
    await verify(accountA);
    expect(host.innerHTML).toBe("");
    expect(mock.mounted).not.toHaveBeenCalled();
    root = createRoot(host);
  });
});
