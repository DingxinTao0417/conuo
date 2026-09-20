import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  requireUser: vi.fn(),
  rpc: vi.fn(),
  admin: vi.fn(),
  verify: vi.fn(),
  prepare: vi.fn(),
}));

vi.mock("@/lib/supabase/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/api")>();
  return { ...actual, requireUser: mock.requireUser };
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mock.admin }));
vi.mock("@/lib/supabase/account-deletion", () => ({
  verifyAccountDeletionConfirmation: mock.verify,
  prepareAccountDeletion: mock.prepare,
}));

import { GET, POST } from "@/app/api/v1/account/deletion/route";

const ownerId = "86d5eaa8-3ab9-4d1b-bd73-210f353e8052";
const deletionId = "11111111-1111-4111-8111-111111111111";
const preview = {
  state: null,
  sources: 2,
  versions: 3,
  notes: 4,
  conversations: 5,
  annotations: 6,
  spaces: 1,
  currentStorageObjects: 2,
  pendingSourcePurgeObjects: 1,
  totalStorageObjects: 3,
};

function request(method: "GET" | "POST", body?: unknown, headers: HeadersInit = {}) {
  return new Request("http://localhost:3000/api/v1/account/deletion", {
    method,
    headers: {
      "X-Conuo-User": ownerId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.requireUser.mockResolvedValue({
    supabase: { rpc: mock.rpc },
    user: { id: ownerId, email: "reader@example.test" },
    accountDeletion: { state: null, allowed: true },
  });
  mock.rpc.mockResolvedValue({ data: preview, error: null });
  mock.admin.mockReturnValue({ rpc: vi.fn() });
  mock.verify.mockResolvedValue(undefined);
  mock.prepare.mockResolvedValue({
    deletionId,
    state: "storage_pending",
    storageObjects: 3,
    readyForAuthDeletion: false,
  });
});

describe("account deletion route", () => {
  it("returns a counts-only server-derived preview and allows the pending status to be read", async () => {
    const response = await GET(request("GET"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...preview, allowed: true });
    expect(mock.requireUser).toHaveBeenCalledWith(expect.any(Request), {
      allowAccountDeletion: true,
    });
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("preview_account_deletion", {});
  });

  it("does not return a malformed preview from an incomplete migration", async () => {
    mock.rpc.mockResolvedValue({ data: { state: null }, error: null });
    const response = await GET(request("GET"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "ACCOUNT_DELETION_UNAVAILABLE" });
  });

  it.each(["40001", "PT409"])("maps a %s preview fence to a redacted conflict", async (code) => {
    mock.rpc.mockResolvedValue({ data: null, error: { code, message: "private deletion state" } });
    const response = await GET(request("GET"));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ code: "ACCOUNT_DELETION_STATE_CHANGED" });
    expect(JSON.stringify(body)).not.toContain("private deletion state");
  });

  it("requires confirmation before it creates an admin client or queues deletion", async () => {
    const response = await POST(request("POST", { email: "reader@example.test" }));
    expect(response.status).toBe(400);
    expect(mock.verify).not.toHaveBeenCalled();
    expect(mock.admin).not.toHaveBeenCalled();
    expect(mock.prepare).not.toHaveBeenCalled();
  });

  it("binds confirmation to the current user before submitting only their verified ID", async () => {
    const response = await POST(
      request("POST", {
        email: "reader@example.test",
        password: "current-password",
        confirmation: "DELETE",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      deletionId,
      state: "storage_pending",
      storageObjects: 3,
      readyForAuthDeletion: false,
    });
    expect(mock.verify).toHaveBeenCalledExactlyOnceWith(
      { id: ownerId, email: "reader@example.test" },
      { email: "reader@example.test", password: "current-password", confirmation: "DELETE" },
    );
    expect(mock.prepare).toHaveBeenCalledExactlyOnceWith(
      mock.admin.mock.results[0]?.value,
      ownerId,
    );
  });

  it("keeps privileged errors out of the response", async () => {
    mock.prepare.mockRejectedValue(new Error("private account id and secret storage object"));
    const response = await POST(
      request("POST", {
        email: "reader@example.test",
        password: "current-password",
        confirmation: "DELETE",
      }),
    );
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain("private account");
    expect(body).not.toContain("secret storage");
  });

  it("rejects cross-site confirmation before privileged operations", async () => {
    const response = await POST(
      request(
        "POST",
        { email: "reader@example.test", password: "current-password", confirmation: "DELETE" },
        { Origin: "https://untrusted.example" },
      ),
    );
    expect(response.status).toBe(403);
    expect(mock.verify).not.toHaveBeenCalled();
    expect(mock.admin).not.toHaveBeenCalled();
  });
});
