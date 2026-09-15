import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ admin: vi.fn(), run: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mock.admin }));
vi.mock("@/lib/supabase/source-purge-cleanup", () => ({ runSourcePurgeCleanup: mock.run }));

import { GET, POST } from "@/app/api/internal/source-purge-cleanup/route";

const secret = "cleanup-private-credential-123456789";
const client = { storage: { from: vi.fn() }, rpc: vi.fn() };

function get(headers: HeadersInit = {}) {
  return new Request("http://localhost:3000/api/internal/source-purge-cleanup", {
    headers: { Authorization: `Bearer ${secret}`, ...headers },
  });
}
function post(input: unknown, headers: HeadersInit = {}, body?: string) {
  return new Request("http://localhost:3000/api/internal/source-purge-cleanup", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}`, ...headers },
    body: body ?? JSON.stringify(input),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONUO_CLEANUP_SECRET", secret);
  vi.stubEnv("CRON_SECRET", "");
  mock.admin.mockReturnValue(client);
  mock.run.mockResolvedValue({ claimed: 1, completed: 1, retried: 0, failed: 0, cancelled: false });
});
afterEach(() => vi.unstubAllEnvs());

describe("source purge cleanup route identity", () => {
  it.each(["", "short", "a".repeat(4097), "unsafe secret has spaces in it 1234567890"])(
    "rejects missing or unsafe cleanup configuration before opening admin Storage",
    async (value) => {
      vi.stubEnv("CONUO_CLEANUP_SECRET", value);
      const res = await GET(get());
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("CLEANUP_NOT_CONFIGURED");
      expect(mock.admin).not.toHaveBeenCalled();
      expect(mock.run).not.toHaveBeenCalled();
    },
  );

  it.each(["", "Bearer wrong", `bearer ${secret}`, `Bearer ${secret}x`, "x".repeat(8193)])(
    "requires an exact cleanup identity before any privileged action",
    async (authorization) => {
      const res = await GET(get({ Authorization: authorization }));
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain(secret);
      expect(mock.admin).not.toHaveBeenCalled();
      expect(mock.run).not.toHaveBeenCalled();
    },
  );

  it("accepts Vercel's CRON_SECRET when no dedicated cleanup secret is configured", async () => {
    vi.stubEnv("CONUO_CLEANUP_SECRET", "");
    vi.stubEnv("CRON_SECRET", secret);
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect(mock.run).toHaveBeenCalledOnce();
  });

  it("runs a small fixed cron batch without accepting caller controlled paths", async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      claimed: 1,
      completed: 1,
      retried: 0,
      failed: 0,
      cancelled: false,
    });
    expect(mock.admin).toHaveBeenCalledOnce();
    expect(mock.run).toHaveBeenCalledWith(
      client,
      client.storage,
      expect.objectContaining({
        workerId: "vercel-source-purge-cleanup",
        limit: 3,
        leaseSeconds: 120,
      }),
    );
  });
});

describe("source purge cleanup route request boundary", () => {
  it.each([
    [{ workerId: "worker", storagePath: "other-user/private.pdf" }, 400],
    [{ workerId: "worker", limit: 0 }, 400],
    [{ workerId: "worker", limit: 6 }, 400],
    [{ workerId: "worker", leaseSeconds: 181 }, 400],
    [{ workerId: "worker/unsafe" }, 400],
    [{ workerId: "worker", purgeId: "11111111-1111-4111-8111-111111111111" }, 400],
  ])(
    "rejects caller supplied outbox identifiers or unsafe batch settings %#",
    async (input, status) => {
      const res = await POST(post(input));
      expect(res.status).toBe(status);
      expect(mock.admin).not.toHaveBeenCalled();
      expect(mock.run).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ "Content-Type": "text/plain" }, "{}", 415],
    [{ Origin: "https://other.example" }, "{}", 403],
    [{ "Sec-Fetch-Site": "cross-site" }, "{}", 403],
    [{ "Content-Length": "4097" }, "{}", 413],
    [{}, "{", 400],
  ] as const)(
    "rejects unsafe POST transport before admin operations",
    async (headers, body, status) => {
      const res = await POST(post(null, headers, body));
      expect(res.status).toBe(status);
      expect(mock.admin).not.toHaveBeenCalled();
      expect(mock.run).not.toHaveBeenCalled();
    },
  );

  it("forwards only validated bounded worker settings to the cleanup runner", async () => {
    const res = await POST(post({ workerId: "nightly-worker", limit: 5, leaseSeconds: 30 }));
    expect(res.status).toBe(200);
    expect(mock.run).toHaveBeenCalledWith(
      client,
      client.storage,
      expect.objectContaining({
        workerId: "nightly-worker",
        limit: 5,
        leaseSeconds: 30,
      }),
    );
  });

  it("masks unexpected privileged errors", async () => {
    mock.run.mockRejectedValue(new Error("private storage response: secret object path"));
    const res = await POST(post({ workerId: "nightly-worker" }));
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain("private storage");
    expect(body).not.toContain("secret object path");
  });
});
