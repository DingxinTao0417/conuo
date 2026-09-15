"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Download } from "lucide-react";

type InstallPromptChoice = { outcome: "accepted" | "dismissed"; platform?: string };

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<InstallPromptChoice>;
}

function isStandaloneWindow() {
  if (typeof window === "undefined") return false;
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return (
    navigatorWithStandalone.standalone === true ||
    (typeof window.matchMedia === "function" &&
      window.matchMedia("(display-mode: standalone)").matches)
  );
}

function isAppleMobileDevice() {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1)
  );
}

function subscribeToAppleMobileDevice() {
  return () => {};
}

function subscribeToInstallMode(onStoreChange: () => void) {
  const displayMode =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(display-mode: standalone)")
      : null;
  displayMode?.addEventListener("change", onStoreChange);
  window.addEventListener("appinstalled", onStoreChange);
  return () => {
    displayMode?.removeEventListener("change", onStoreChange);
    window.removeEventListener("appinstalled", onStoreChange);
  };
}

function serverSnapshot() {
  return false;
}

/**
 * Uses the browser-provided install prompt when it exists and gives Safari a
 * clear manual path. Installing the shell never implies offline availability.
 */
export default function InstallAppPanel() {
  const detectedStandalone = useSyncExternalStore(
    subscribeToInstallMode,
    isStandaloneWindow,
    serverSnapshot,
  );
  const appleMobile = useSyncExternalStore(
    subscribeToAppleMobileDevice,
    isAppleMobileDevice,
    serverSnapshot,
  );
  const [installedThisSession, setInstalledThisSession] = useState(false);
  const standalone = detectedStandalone || installedThisSession;
  const [deferredPrompt, setDeferredPrompt] = useState<InstallPromptEvent | null>(null);
  const [installing, setInstalling] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const capturePrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as InstallPromptEvent);
      setMessage("");
    };
    const markInstalled = () => {
      setInstalledThisSession(true);
      setDeferredPrompt(null);
      setMessage("Conuo 已添加到此设备。");
    };

    window.addEventListener("beforeinstallprompt", capturePrompt);
    window.addEventListener("appinstalled", markInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", capturePrompt);
      window.removeEventListener("appinstalled", markInstalled);
    };
  }, []);

  async function requestInstall() {
    if (!deferredPrompt || installing) return;
    setInstalling(true);
    setMessage("");
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      setDeferredPrompt(null);
      setMessage(
        choice.outcome === "accepted"
          ? "已请求浏览器安装 Conuo。"
          : "已取消安装；你可以随时在这里重新尝试。",
      );
    } catch {
      setMessage("浏览器暂时无法显示安装提示，请稍后再试。");
    } finally {
      setInstalling(false);
    }
  }

  const title = standalone
    ? "已作为应用打开"
    : deferredPrompt
      ? "安装 Conuo"
      : appleMobile
        ? "添加到主屏"
        : "添加到桌面或主屏";
  const description = standalone
    ? "当前窗口正以 Conuo 应用模式运行。"
    : deferredPrompt
      ? "安装后可从桌面或主屏快速打开 Conuo。安装不等于离线可用。"
      : appleMobile
        ? "请在 Safari 中点“分享”，再选择“添加到主屏幕”。安装不下载离线资料。"
        : "浏览器支持时，可在浏览器菜单中选择“安装应用”或“添加到主屏”。安装不等于离线可用。";

  return (
    <div className="setting-row install-app-panel">
      <div>
        <b>{title}</b>
        <p>{description}</p>
        {message && (
          <p className="install-app-status" role="status" aria-live="polite">
            {message}
          </p>
        )}
      </div>
      {deferredPrompt && !standalone && (
        <button
          className="btn"
          type="button"
          disabled={installing}
          onClick={() => void requestInstall()}
        >
          <Download size={15} />
          {installing ? "正在安装…" : "安装应用"}
        </button>
      )}
    </div>
  );
}
