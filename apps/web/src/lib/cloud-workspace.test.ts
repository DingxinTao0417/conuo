import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ config: vi.fn(), fetch: vi.fn<typeof fetch>() }));
vi.mock("./supabase/config", () => ({ getSupabaseConfig: mock.config }));
vi.mock("./supabase/client", () => ({ createClient: vi.fn() }));

import {
  CloudError,
  loadCloudWorkspace,
  loadCloudWorkspaceRevision,
  saveCloudWorkspace,
} from "./cloud";
import { createEmptyWorkspace } from "./seed";

const ownerId = "owner-a";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mock.fetch);
  mock.config.mockReturnValue({ url: "https://project.example.test", key: "publishable-test-key" });
});

afterEach(() => vi.unstubAllGlobals());

describe("workspace cloud adapter", () => {
  it("reads only the revision endpoint with account and cancellation fences", async () => {
    const controller = new AbortController();
    mock.fetch.mockResolvedValue(Response.json({ revision: 0 }));
    await expect(loadCloudWorkspaceRevision(ownerId, controller.signal)).resolves.toEqual({
      revision: 0,
    });
    expect(mock.fetch).toHaveBeenCalledWith(
      "/api/v1/workspace/revision",
      expect.objectContaining({
        signal: controller.signal,
        cache: "no-store",
        headers: expect.objectContaining({ "X-Conuo-User": ownerId }),
      }),
    );
  });
  it.each([
    {},
    { revision: "2" },
    { revision: -1 },
    { revision: 1.2 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { revision: 2, data: {} },
  ])("rejects malformed revision probes: %j", async (body) => {
    mock.fetch.mockResolvedValue(Response.json(body));
    await expect(loadCloudWorkspaceRevision(ownerId)).rejects.toMatchObject({
      code: "INVALID_WORKSPACE_REVISION_RESPONSE",
    });
  });
  it.each([
    { data: null, revision: 1 },
    { data: createEmptyWorkspace(), revision: 0 },
    { data: {}, revision: 2 },
    { data: null, revision: -1 },
  ])("rejects an invalid authoritative read: %j", async (body) => {
    mock.fetch.mockResolvedValue(Response.json(body));
    await expect(loadCloudWorkspace(ownerId)).rejects.toMatchObject({
      code: "INVALID_WORKSPACE_RESPONSE",
    });
  });
  it("returns a validated positive revision for an acknowledged save", async () => {
    mock.fetch.mockResolvedValue(Response.json({ revision: 4 }));

    await expect(saveCloudWorkspace(createEmptyWorkspace(), 3, ownerId)).resolves.toEqual({
      revision: 4,
    });
    expect(mock.fetch).toHaveBeenCalledExactlyOnceWith(
      "/api/v1/workspace",
      expect.objectContaining({
        method: "PUT",
        credentials: "same-origin",
        cache: "no-store",
        headers: expect.objectContaining({ "X-Conuo-User": ownerId }),
      }),
    );
  });

  it("turns a learning-space limit response into a dedicated retained-draft error", async () => {
    mock.fetch.mockResolvedValue(
      Response.json(
        { error: "当前会员可用的学习空间已满。", code: "LEARNING_SPACE_LIMIT" },
        { status: 403 },
      ),
    );

    await expect(saveCloudWorkspace(createEmptyWorkspace(), 3, ownerId)).rejects.toMatchObject({
      status: 403,
      code: "LEARNING_SPACE_LIMIT",
      message: "学习空间已满：当前修改仍保留在此浏览器，请先归档不再使用的空间后重新连接。",
    });
  });

  it.each([
    { revision: 0 },
    { revision: 2.5 },
    {},
    { revision: "4" },
    { revision: 2 },
    { revision: 3 },
    { revision: 5 },
  ])("treats a malformed success response as an unconfirmed save: %j", async (body) => {
    mock.fetch.mockResolvedValue(Response.json(body));

    const result = await saveCloudWorkspace(createEmptyWorkspace(), 3, ownerId).catch(
      (error: unknown) => error,
    );

    expect(result).toBeInstanceOf(CloudError);
    expect(result).toMatchObject({ status: 502, code: "INVALID_WORKSPACE_SAVE_RESPONSE" });
  });
});
