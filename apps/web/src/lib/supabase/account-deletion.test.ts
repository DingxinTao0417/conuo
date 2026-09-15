import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  createClient: vi.fn(),
  config: vi.fn(),
  signInWithPassword: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient: mock.createClient }));
vi.mock("./config", () => ({ getSupabaseConfig: mock.config }));

import { prepareAccountDeletion, verifyAccountDeletionConfirmation } from "./account-deletion";

const ownerId = "86d5eaa8-3ab9-4d1b-bd73-210f353e8052";
const deletionId = "11111111-1111-4111-8111-111111111111";
const confirmation = {
  email: "reader@example.test",
  password: "current-password",
  confirmation: "DELETE" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mock.config.mockReturnValue({ url: "https://project.example.test", key: "publishable-test-key" });
  mock.createClient.mockReturnValue({ auth: { signInWithPassword: mock.signInWithPassword } });
  mock.signInWithPassword.mockResolvedValue({ data: { user: { id: ownerId } }, error: null });
  mock.rpc.mockResolvedValue({
    data: {
      deletionId,
      state: "storage_pending",
      storageObjects: 2,
      readyForAuthDeletion: false,
    },
    error: null,
  });
});

describe("account deletion confirmation", () => {
  it("uses an isolated no-persistence client and binds the credential to the verified session user", async () => {
    await expect(
      verifyAccountDeletionConfirmation(
        { id: ownerId, email: "reader@example.test" },
        confirmation,
      ),
    ).resolves.toBeUndefined();
    expect(mock.createClient).toHaveBeenCalledExactlyOnceWith(
      "https://project.example.test",
      "publishable-test-key",
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
    );
    expect(mock.signInWithPassword).toHaveBeenCalledExactlyOnceWith({
      email: "reader@example.test",
      password: "current-password",
    });
  });

  it("rejects another email before creating an auth client", async () => {
    const result = await verifyAccountDeletionConfirmation(
      { id: ownerId, email: "reader@example.test" },
      { ...confirmation, email: "other@example.test" },
    ).catch((error: unknown) => error);
    expect(result).toMatchObject({ status: 401, code: "ACCOUNT_DELETION_CONFIRMATION_FAILED" });
    expect(mock.createClient).not.toHaveBeenCalled();
    expect(mock.signInWithPassword).not.toHaveBeenCalled();
  });

  it("does not expose an auth provider error when the password is wrong", async () => {
    mock.signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { message: "private provider credential detail" },
    });
    const result = await verifyAccountDeletionConfirmation(
      { id: ownerId, email: "reader@example.test" },
      confirmation,
    ).catch((error: unknown) => error);
    expect(result).toMatchObject({ status: 401, code: "ACCOUNT_DELETION_CONFIRMATION_FAILED" });
    expect(String(result)).not.toContain("private provider");
  });

  it("rejects a correct credential that resolves to another account", async () => {
    mock.signInWithPassword.mockResolvedValue({ data: { user: { id: "owner-b" } }, error: null });
    await expect(
      verifyAccountDeletionConfirmation(
        { id: ownerId, email: "reader@example.test" },
        confirmation,
      ),
    ).rejects.toMatchObject({ status: 409, code: "ACCOUNT_DELETION_SESSION_CHANGED" });
  });
});

describe("account deletion preparation", () => {
  it("submits only the verified account ID to the service-only transaction", async () => {
    await expect(prepareAccountDeletion({ rpc: mock.rpc }, ownerId)).resolves.toEqual({
      deletionId,
      state: "storage_pending",
      storageObjects: 2,
      readyForAuthDeletion: false,
    });
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("prepare_account_deletion", {
      p_owner_id: ownerId,
    });
  });

  it("refuses an invalid account identity before calling the admin RPC", async () => {
    await expect(prepareAccountDeletion({ rpc: mock.rpc }, "owner-a")).rejects.toMatchObject({
      status: 503,
      code: "ACCOUNT_DELETION_UNAVAILABLE",
    });
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it("maps a transaction conflict without exposing database details", async () => {
    mock.rpc.mockResolvedValue({
      data: null,
      error: { code: "40001", message: "private lock detail" },
    });
    const result = await prepareAccountDeletion({ rpc: mock.rpc }, ownerId).catch(
      (error: unknown) => error,
    );
    expect(result).toMatchObject({ status: 409, code: "ACCOUNT_DELETION_STATE_CHANGED" });
    expect(String(result)).not.toContain("private lock");
  });

  it("masks malformed or unavailable privileged results", async () => {
    mock.rpc.mockResolvedValue({ data: { deletionId: "not-a-uuid" }, error: null });
    await expect(prepareAccountDeletion({ rpc: mock.rpc }, ownerId)).rejects.toMatchObject({
      status: 503,
      code: "ACCOUNT_DELETION_UNAVAILABLE",
    });
  });
});
