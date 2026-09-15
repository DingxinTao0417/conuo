import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ createClient: vi.fn(), config: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mock.createClient }));
vi.mock("./config", () => ({ getSupabaseConfig: mock.config }));

import { createAdminClient } from "./admin";

const client = { rpc: vi.fn(), storage: { from: vi.fn() } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SUPABASE_SECRET_KEY", "");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
  mock.config.mockReturnValue({ url: "https://project.example.test", key: "publishable-test-key" });
  mock.createClient.mockReturnValue(client);
});
afterEach(() => vi.unstubAllEnvs());

describe("internal Supabase admin client", () => {
  it("requires a server-only key and never substitutes a browser publishable key", () => {
    const error = (() => {
      try {
        createAdminClient();
      } catch (value) {
        return value;
      }
    })();
    expect(error).toMatchObject({ status: 503, code: "CLOUD_ADMIN_NOT_CONFIGURED" });
    expect(String(error)).not.toContain("publishable-test-key");
    expect(mock.createClient).not.toHaveBeenCalled();
  });

  it("requires a configured Supabase project as well", () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", "server-secret");
    mock.config.mockReturnValue(null);
    expect(() => createAdminClient()).toThrowError();
    expect(mock.createClient).not.toHaveBeenCalled();
  });

  it("creates a no-session server client", () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", " server-secret ");
    expect(createAdminClient()).toBe(client);
    expect(mock.createClient).toHaveBeenCalledExactlyOnceWith(
      "https://project.example.test",
      "server-secret",
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
    );
  });

  it("supports the old service role variable only when the modern server key is absent", () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", " legacy-secret ");
    createAdminClient();
    expect(mock.createClient.mock.calls[0]?.[1]).toBe("legacy-secret");
    vi.clearAllMocks();
    vi.stubEnv("SUPABASE_SECRET_KEY", "preferred-secret");
    createAdminClient();
    expect(mock.createClient.mock.calls[0]?.[1]).toBe("preferred-secret");
  });
});
