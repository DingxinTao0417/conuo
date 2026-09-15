import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ auth: { getUser: vi.fn() }, rpc: vi.fn() }));
vi.mock("./server", () => ({ createClient: async () => ({ auth: mock.auth, rpc: mock.rpc }) }));
vi.mock("./config", () => ({
  getSupabaseConfig: () => ({ url: "https://example.supabase.co", key: "public-test-key" }),
}));
import { ApiError, readJson, requireUser } from "./api";
import { createEmptyWorkspace } from "../seed";
import { PUT as saveWorkspace } from "../../app/api/v1/workspace/route";

describe("cloud request boundary", () => {
  beforeEach(() => {
    mock.auth.getUser.mockResolvedValue({ data: { user: { id: "owner-a" } }, error: null });
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
  it("uses server-confirmed identity and refuses a stale account header", async () => {
    const stale = new Request("http://localhost/api/v1/workspace", {
      headers: { "X-Conuo-User": "owner-b" },
    });
    await expect(requireUser(stale)).rejects.toMatchObject({
      status: 409,
      code: "SESSION_CHANGED",
    });
    const valid = new Request("http://localhost/api/v1/workspace", {
      headers: { "X-Conuo-User": "owner-a" },
    });
    await expect(requireUser(valid)).resolves.toMatchObject({ user: { id: "owner-a" } });
  });
  it("does not accept a claimed owner without a verified session", async () => {
    mock.auth.getUser.mockResolvedValue({ data: { user: null }, error: { message: "expired" } });
    await expect(
      requireUser(
        new Request("http://localhost/api/v1/workspace", {
          headers: { "X-Conuo-User": "owner-a" },
        }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("blocks every ordinary route when an account deletion exists, but permits its status route", async () => {
    mock.rpc.mockResolvedValue({
      data: {
        state: "storage_pending",
        allowed: false,
        sources: 2,
        versions: 2,
        notes: 0,
        conversations: 0,
        annotations: 0,
        spaces: 1,
        currentStorageObjects: 2,
        pendingSourcePurgeObjects: 0,
        totalStorageObjects: 2,
      },
      error: null,
    });
    const request = new Request("http://localhost/api/v1/workspace", {
      headers: { "X-Conuo-User": "owner-a" },
    });
    await expect(requireUser(request)).rejects.toMatchObject({
      status: 423,
      code: "ACCOUNT_DELETION_PENDING",
    });
    await expect(requireUser(request, { allowAccountDeletion: true })).resolves.toMatchObject({
      accountDeletion: { allowed: false, state: "storage_pending" },
    });
  });
  it("fails closed if the account deletion gate is unavailable or malformed", async () => {
    mock.rpc.mockResolvedValue({ data: null, error: { message: "private migration error" } });
    const request = new Request("http://localhost/api/v1/workspace", {
      headers: { "X-Conuo-User": "owner-a" },
    });
    const result = await requireUser(request).catch((error: unknown) => error);
    expect(result).toMatchObject({ status: 503, code: "ACCOUNT_DELETION_UNAVAILABLE" });
    expect(String(result)).not.toContain("private migration");
  });
  it("rejects cross-site writes and form submissions", async () => {
    await expect(
      readJson(
        new Request("http://localhost/api", {
          method: "PUT",
          body: "{}",
          headers: { "Content-Type": "application/json", Origin: "https://untrusted.example" },
        }),
        100,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      readJson(
        new Request("http://localhost/api", {
          method: "PUT",
          body: "{}",
          headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
        }),
        100,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      readJson(
        new Request("http://localhost/api", {
          method: "POST",
          body: "x=y",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }),
        100,
      ),
    ).rejects.toMatchObject({ status: 415 });
  });
  it("accepts a matching Origin even when an embedded browser retains a stale fetch-site classification", async () => {
    await expect(
      readJson(
        new Request("http://localhost/api", {
          method: "PUT",
          body: JSON.stringify({ text: "同源保存" }),
          headers: {
            "Content-Type": "application/json",
            Origin: "http://localhost",
            "Sec-Fetch-Site": "cross-site",
          },
        }),
        100,
      ),
    ).resolves.toEqual({ text: "同源保存" });
  });
  it.each([
    ["http://localhost:3000/api", "http://127.0.0.1:3000"],
    ["http://127.0.0.1:3000/api", "http://localhost:3000"],
  ])("accepts the exact loopback alias for request %s with Origin %s", async (url, origin) => {
    await expect(
      readJson(
        new Request(url, {
          method: "PUT",
          body: JSON.stringify({ text: "嵌入式浏览器同源保存" }),
          headers: {
            "Content-Type": "application/json",
            Origin: origin,
            "Sec-Fetch-Site": "cross-site",
          },
        }),
        100,
      ),
    ).resolves.toEqual({ text: "嵌入式浏览器同源保存" });
  });
  it.each([
    ["http://localhost:3000/api", "http://127.0.0.1:3001"],
    ["https://localhost:3000/api", "http://127.0.0.1:3000"],
    ["http://localhost:3000/api", "http://[::1]:3000"],
    ["http://localhost:3000/api", "http://127.0.0.1:3000/not-an-origin"],
  ])("rejects loopback lookalike for request %s with Origin %s", async (url, origin) => {
    await expect(
      readJson(
        new Request(url, {
          method: "PUT",
          body: "{}",
          headers: { "Content-Type": "application/json", Origin: origin },
        }),
        100,
      ),
    ).rejects.toMatchObject({ status: 403, code: "CROSS_ORIGIN" });
  });
  it.each(["", " "])("rejects a present but malformed Origin header %j", async (origin) => {
    await expect(
      readJson(
        new Request("http://localhost:3000/api", {
          method: "PUT",
          body: "{}",
          headers: { "Content-Type": "application/json", Origin: origin },
        }),
        100,
      ),
    ).rejects.toMatchObject({ status: 403, code: "CROSS_ORIGIN" });
  });
  it("enforces streamed body length even if content-length is absent or false", async () => {
    const request = new Request("http://localhost/api", {
      method: "PUT",
      body: JSON.stringify({ data: "x".repeat(200) }),
      headers: { "Content-Type": "application/json", "Content-Length": "1" },
    });
    await expect(readJson(request, 100)).rejects.toMatchObject({ status: 413 });
  });
  it("reads valid Unicode and rejects malformed JSON without echoing source text", async () => {
    await expect(
      readJson(
        new Request("http://localhost/api", {
          method: "POST",
          body: JSON.stringify({ text: "学习" }),
          headers: { "Content-Type": "application/json" },
        }),
        100,
      ),
    ).resolves.toEqual({ text: "学习" });
    await expect(
      readJson(
        new Request("http://localhost/api", {
          method: "POST",
          body: "{ secret document",
          headers: { "Content-Type": "application/json" },
        }),
        100,
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });
  it("reports an owner-lock miss as a retryable busy response without leaking database details", async () => {
    mock.rpc
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({
        data: null,
        error: { code: "55P03", message: "private lock and query details" },
      });
    const response = await saveWorkspace(
      new Request("http://localhost/api/v1/workspace", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Conuo-User": "owner-a",
        },
        body: JSON.stringify({ data: createEmptyWorkspace(), expectedRevision: 1 }),
      }),
    );

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({
      code: "WORKSPACE_BUSY",
      error: "云端正在处理同一账号的资料，请稍后重新连接；本地修改仍然保留。",
    });
    expect(JSON.stringify(body)).not.toContain("private lock");
  });
});
