import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  onChange: vi.fn(),
  removeChannel: vi.fn(),
  subscribe: vi.fn(),
  on: vi.fn(),
  channel: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: mock.createClient }));

import { subscribeToInkPageHeads } from "./ink-live";

afterEach(() => {
  vi.clearAllMocks();
});

describe("ink live subscription", () => {
  it("listens for the owner's page-head writes and tears the channel down", () => {
    const channel = {
      on: mock.on.mockReturnThis(),
      subscribe: mock.subscribe.mockReturnThis(),
    };
    mock.channel.mockReturnValue(channel);
    mock.createClient.mockReturnValue({
      channel: mock.channel,
      removeChannel: mock.removeChannel,
    });

    const stop = subscribeToInkPageHeads({
      ownerId: "user-a",
      onChange: mock.onChange,
    });
    expect(mock.channel).toHaveBeenCalledWith("ink-page-heads:user-a");
    expect(mock.on).toHaveBeenCalledWith(
      "postgres_changes",
      expect.objectContaining({
        table: "ink_page_heads",
        filter: "owner_id=eq.user-a",
      }),
      expect.any(Function),
    );

    const handler = mock.on.mock.calls[0]?.[2] as () => void;
    handler();
    expect(mock.onChange).toHaveBeenCalledTimes(1);

    stop();
    expect(mock.removeChannel).toHaveBeenCalledWith(channel);
  });

  it("stays inert when realtime client setup fails", () => {
    mock.createClient.mockImplementation(() => {
      throw new Error("not configured");
    });
    expect(() =>
      subscribeToInkPageHeads({ ownerId: "user-a", onChange: mock.onChange }),
    ).not.toThrow();
    expect(mock.onChange).not.toHaveBeenCalled();
  });
});
