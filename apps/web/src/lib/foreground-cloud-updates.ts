export const CLOUD_UPDATE_CHECK_INTERVAL_MS = 4_000;

/** One cancellable lightweight check at a time; background tabs never poll. */
export function startForegroundCloudUpdateChecks(
  check: (signal: AbortSignal) => Promise<void>,
  intervalMs = CLOUD_UPDATE_CHECK_INTERVAL_MS,
): () => void {
  let stopped = false;
  let suspended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let resumeRequested = false;
  const eligible = () =>
    !stopped && !suspended && document.visibilityState === "visible" && navigator.onLine !== false;
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const pause = () => {
    clearTimer();
    controller?.abort();
  };
  const run = () => {
    clearTimer();
    if (!eligible() || controller) return;
    const current = new AbortController();
    controller = current;
    void Promise.resolve()
      .then(() => check(current.signal))
      .catch(() => {})
      .finally(() => {
        if (controller === current) controller = undefined;
        if (eligible()) {
          if (resumeRequested) {
            resumeRequested = false;
            run();
          } else timer = setTimeout(run, intervalMs);
        }
      });
  };
  const resume = () => {
    if (eligible()) {
      if (controller?.signal.aborted) resumeRequested = true;
      run();
    } else pause();
  };
  const hide = () => {
    suspended = true;
    pause();
  };
  const show = () => {
    suspended = false;
    resume();
  };
  window.addEventListener("focus", resume);
  window.addEventListener("online", resume);
  window.addEventListener("offline", pause);
  window.addEventListener("pagehide", hide);
  window.addEventListener("pageshow", show);
  document.addEventListener("visibilitychange", resume);
  run();
  return () => {
    stopped = true;
    pause();
    window.removeEventListener("focus", resume);
    window.removeEventListener("online", resume);
    window.removeEventListener("offline", pause);
    window.removeEventListener("pagehide", hide);
    window.removeEventListener("pageshow", show);
    document.removeEventListener("visibilitychange", resume);
  };
}
