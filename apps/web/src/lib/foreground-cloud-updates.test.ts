// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startForegroundCloudUpdateChecks } from "./foreground-cloud-updates";

let visibility = "visible";
let online = true;
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  online = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility as DocumentVisibilityState,
  );
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
});
afterEach(() => {
  cleanups.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
describe("foreground cloud update scheduler", () => {
  it("checks immediately and polls only after the previous check settles", async () => {
    let finish!: () => void;
    const check = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    cleanups.push(startForegroundCloudUpdateChecks(check));
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(12_000);
    expect(check).toHaveBeenCalledTimes(1);
    finish();
    await settle();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(check).toHaveBeenCalledTimes(2);
  });
  it("pauses while hidden/offline and immediately resumes on return", async () => {
    const check = vi.fn(async () => {});
    cleanups.push(startForegroundCloudUpdateChecks(check));
    await settle();
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(check).toHaveBeenCalledTimes(1);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(check).toHaveBeenCalledTimes(2);
    online = false;
    window.dispatchEvent(new Event("offline"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(check).toHaveBeenCalledTimes(2);
    online = true;
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(check).toHaveBeenCalledTimes(3);
  });
  it("aborts the active read on hide and removes listeners/timers on cleanup", async () => {
    let current!: AbortSignal;
    const check = vi.fn((signal: AbortSignal) => {
      current = signal;
      return new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    });
    const stop = startForegroundCloudUpdateChecks(check);
    cleanups.push(stop);
    await settle();
    window.dispatchEvent(new Event("pagehide"));
    expect(current.aborted).toBe(true);
    await settle();
    window.dispatchEvent(new Event("pageshow"));
    await settle();
    expect(check).toHaveBeenCalledTimes(2);
    stop();
    expect(current.aborted).toBe(true);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(check).toHaveBeenCalledTimes(2);
  });
  it("never starts in a background or offline tab", async () => {
    visibility = "hidden";
    const check = vi.fn(async () => {});
    cleanups.push(startForegroundCloudUpdateChecks(check));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(check).not.toHaveBeenCalled();
  });
});
