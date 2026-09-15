import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  getUser: vi.fn(),
  unsubscribe: vi.fn(),
  callback: undefined as undefined | ((event: string) => void),
}));
vi.mock("./client", () => ({
  createClient: () => ({
    auth: {
      getUser: mock.getUser,
      onAuthStateChange: (callback: (event: string) => void) => {
        mock.callback = callback;
        return { data: { subscription: { unsubscribe: mock.unsubscribe } } };
      },
    },
  }),
}));
vi.mock("./config", () => ({
  getSupabaseConfig: () => ({ url: "https://example.supabase.co", key: "public-test-key" }),
}));
import { subscribeSession } from "../cloud";

describe("session subscription races", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mock.getUser.mockReset();
    mock.unsubscribe.mockReset();
  });
  afterEach(() => vi.useRealTimers());
  it("ignores cached INITIAL_SESSION and emits a verified user", async () => {
    mock.getUser.mockResolvedValue({
      data: { user: { id: "a", email: "a@example.invalid" } },
      error: null,
    });
    const listener = vi.fn();
    const stop = subscribeSession(listener);
    mock.callback?.("INITIAL_SESSION");
    expect(listener).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(listener).toHaveBeenCalledExactlyOnceWith({ id: "a", email: "a@example.invalid" });
    stop();
  });
  it("defers auth work outside the event callback and discards an earlier account lookup", async () => {
    let resolveOld: (result: unknown) => void = () => {};
    mock.getUser.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    mock.getUser.mockResolvedValue({
      data: { user: { id: "b", email: "b@example.invalid" } },
      error: null,
    });
    const listener = vi.fn();
    const stop = subscribeSession(listener);
    mock.callback?.("SIGNED_IN");
    expect(mock.getUser).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    resolveOld({ data: { user: { id: "a", email: "a@example.invalid" } }, error: null });
    await Promise.resolve();
    expect(listener).toHaveBeenCalledExactlyOnceWith({ id: "b", email: "b@example.invalid" });
    stop();
  });
  it("clears pending verification on logout and unsubscribe", async () => {
    mock.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const listener = vi.fn();
    const stop = subscribeSession(listener);
    mock.callback?.("SIGNED_IN");
    mock.callback?.("SIGNED_OUT");
    expect(listener).toHaveBeenCalledExactlyOnceWith(null);
    stop();
    await vi.runAllTimersAsync();
    expect(mock.getUser).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(mock.unsubscribe).toHaveBeenCalledOnce();
  });
});
