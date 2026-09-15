import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ config: vi.fn(), fetch: vi.fn() }));
vi.mock("./supabase/config", () => ({ getSupabaseConfig: mock.config }));

import { CloudError, previewAccountDeletion, requestAccountDeletion } from "./cloud";

const ownerId = "86d5eaa8-3ab9-4d1b-bd73-210f353e8052";
const preview = {
  state: null,
  allowed: true,
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mock.fetch);
  mock.config.mockReturnValue({ url: "https://project.example.test", key: "publishable-test-key" });
  mock.fetch.mockResolvedValue(
    new Response(JSON.stringify(preview), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("account deletion cloud adapter", () => {
  it.each([
    { state: "storage_processing", allowed: true },
    { state: null, allowed: false },
  ])("rejects contradictory access metadata %j", async (access) => {
    mock.fetch.mockResolvedValue(
      new Response(JSON.stringify({ ...preview, ...access }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(previewAccountDeletion(ownerId)).rejects.toMatchObject({ code: "CLOUD_ERROR" });
  });
  it("reads a counts-only preview using the active account binding", async () => {
    await expect(previewAccountDeletion(ownerId)).resolves.toEqual(preview);
    expect(mock.fetch).toHaveBeenCalledExactlyOnceWith(
      "/api/v1/account/deletion",
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
        headers: expect.objectContaining({ "X-Conuo-User": ownerId }),
      }),
    );
  });

  it("sends only a validated confirmation payload", async () => {
    mock.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          deletionId: "11111111-1111-4111-8111-111111111111",
          state: "storage_pending",
          storageObjects: 3,
          readyForAuthDeletion: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await requestAccountDeletion(
      { email: "reader@example.test", password: "current-password", confirmation: "DELETE" },
      ownerId,
    );
    expect(mock.fetch).toHaveBeenCalledWith(
      "/api/v1/account/deletion",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          email: "reader@example.test",
          password: "current-password",
          confirmation: "DELETE",
        }),
      }),
    );
  });

  it("rejects malformed confirmation before a network request", async () => {
    const result = await requestAccountDeletion(
      {
        email: "reader@example.test",
        password: "current-password",
        confirmation: "delete",
      } as never,
      ownerId,
    ).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(CloudError);
    expect(result).toMatchObject({ status: 400, code: "INVALID_ACCOUNT_DELETION_CONFIRMATION" });
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it("does not accept an unexpected server response as a completed deletion request", async () => {
    mock.fetch.mockResolvedValue(
      new Response(JSON.stringify({ deletionId: "private" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(
      requestAccountDeletion(
        { email: "reader@example.test", password: "current-password", confirmation: "DELETE" },
        ownerId,
      ),
    ).rejects.toMatchObject({ code: "CLOUD_ERROR" });
  });
});
