import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  requireUser: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  abortSignal: vi.fn(),
  maybeSingle: vi.fn(),
}));
vi.mock("@/lib/supabase/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase/api")>()),
  requireUser: mock.requireUser,
}));
import { GET } from "@/app/api/v1/workspace/revision/route";
import { ApiError } from "./api";

beforeEach(() => {
  vi.clearAllMocks();
  const chain = {
    select: mock.select,
    eq: mock.eq,
    abortSignal: mock.abortSignal,
    maybeSingle: mock.maybeSingle,
  };
  mock.from.mockReturnValue(chain);
  mock.select.mockReturnValue(chain);
  mock.eq.mockReturnValue(chain);
  mock.abortSignal.mockReturnValue(chain);
  mock.requireUser.mockResolvedValue({ user: { id: "owner-a" }, supabase: { from: mock.from } });
});
describe("workspace revision route", () => {
  it("selects only the authenticated owner's revision under RLS", async () => {
    mock.maybeSingle.mockResolvedValue({
      data: { revision: 7, data: "never projected" },
      error: null,
    });
    const request = new Request("http://localhost/api/v1/workspace/revision?owner_id=other");
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({ revision: 7 });
    expect(mock.select).toHaveBeenCalledExactlyOnceWith("revision");
    expect(mock.eq).toHaveBeenCalledExactlyOnceWith("owner_id", "owner-a");
    expect(mock.abortSignal).toHaveBeenCalledExactlyOnceWith(request.signal);
  });
  it("returns zero for a missing workspace without bootstrapping it", async () => {
    mock.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(
      (await GET(new Request("http://localhost/api/v1/workspace/revision"))).json(),
    ).resolves.toEqual({ revision: 0 });
  });
  it.each([0, -1, 1.2, "7", Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed stored revision %j",
    async (revision) => {
      mock.maybeSingle.mockResolvedValue({ data: { revision }, error: null });
      expect((await GET(new Request("http://localhost/api/v1/workspace/revision"))).status).toBe(
        422,
      );
    },
  );
  it.each([401, 409, 423])("preserves authentication/account/session gate %i", async (status) => {
    mock.requireUser.mockRejectedValue(new ApiError(status, "GATED", "不可读取"));
    expect((await GET(new Request("http://localhost/api/v1/workspace/revision"))).status).toBe(
      status,
    );
    expect(mock.from).not.toHaveBeenCalled();
  });
  it("does not read after its request was cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await GET(
      new Request("http://localhost/api/v1/workspace/revision", { signal: controller.signal }),
    );
    expect(mock.requireUser).not.toHaveBeenCalled();
  });
});
