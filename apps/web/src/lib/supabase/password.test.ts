import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ auth: { getUser: vi.fn(), updateUser: vi.fn() }, rpc: vi.fn() }));
vi.mock("./server", () => ({ createClient: async () => ({ auth: mock.auth, rpc: mock.rpc }) }));
vi.mock("./config", () => ({
  getSupabaseConfig: () => ({ url: "https://example.supabase.co", key: "public-test-key" }),
}));
import { POST } from "@/app/api/v1/account/password/route";

function request(password: string) {
  return new Request("http://localhost/api/v1/account/password", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Conuo-User": "owner-a" },
    body: JSON.stringify({ password }),
  });
}

describe("password update account binding", () => {
  beforeEach(() => {
    mock.auth.getUser.mockReset();
    mock.auth.updateUser.mockReset();
    mock.rpc.mockReset();
    mock.auth.getUser.mockResolvedValue({ data: { user: { id: "owner-a" } }, error: null });
    mock.auth.updateUser.mockResolvedValue({ error: null });
    mock.rpc.mockResolvedValue({
      data: {
        state: null,
        allowed: true,
        sources: 0,
        versions: 0,
        notes: 0,
        conversations: 0,
        annotations: 0,
        spaces: 0,
        currentStorageObjects: 0,
        pendingSourcePurgeObjects: 0,
        totalStorageObjects: 0,
      },
      error: null,
    });
  });
  it("never changes a password after the session switches to another account", async () => {
    mock.auth.getUser.mockResolvedValue({ data: { user: { id: "owner-b" } }, error: null });
    const response = await POST(request("long-test-password"));
    expect(response.status).toBe(409);
    expect(mock.auth.updateUser).not.toHaveBeenCalled();
  });
  it("validates passwords on the server rather than relying on browser constraints", async () => {
    expect((await POST(request("short"))).status).toBe(400);
    expect(mock.auth.updateUser).not.toHaveBeenCalled();
  });
  it("updates the confirmed account and never reflects the password in the response", async () => {
    const response = await POST(request("long-test-password"));
    expect(response.status).toBe(200);
    expect(mock.auth.updateUser).toHaveBeenCalledExactlyOnceWith({
      password: "long-test-password",
    });
    expect(await response.json()).toEqual({ updated: true });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
});
