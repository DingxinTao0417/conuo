import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  config: vi.fn(),
  requireUser: vi.fn(),
  fetch: vi.fn(),
  extract: vi.fn(),
  reserve: vi.fn(),
  persistence: vi.fn(),
  model: vi.fn(),
}));

// Keep real body/origin validation and response headers without importing cookies.
vi.mock("@/lib/supabase/server", () => ({ createClient: mock.persistence }));
vi.mock("@/lib/supabase/config", () => ({ getSupabaseConfig: mock.config }));
vi.mock("@/lib/supabase/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase/api")>()),
  requireUser: mock.requireUser,
}));
vi.mock("@/lib/web/fetch-page", () => ({
  fetchWebPage: mock.fetch,
  WebFetchError: class WebFetchError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/lib/web/extract-article", () => ({ extractArticle: mock.extract }));
vi.mock("@/lib/web/preview-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/web/preview-limit")>()),
  previewLimiter: { reserve: mock.reserve },
}));
vi.mock("@/lib/ai/model", () => ({ callModel: mock.model, readModelConfig: mock.model }));

import { GET, POST } from "@/app/api/v1/web/preview/route";
import { ApiError } from "@/lib/supabase/api";
import { WebFetchError } from "./fetch-page";
import { PreviewLimiter } from "./preview-limit";

const owner = "owner-a";
const pageUrl = "https://article.example/lesson";
const apiUrl = "http://localhost:3000/api/v1/web/preview";
const fetched = {
  originalUrl: pageUrl,
  finalUrl: "https://article.example/final-lesson",
  html: "<article>Fetched private-to-request raw HTML</article>",
  contentType: "text/html; charset=utf-8",
  fetchedAt: "2026-09-13T03:00:00.000Z",
};
const article = {
  title: "学习方法",
  text: "这是一份经过正文抽取的学习材料。",
  excerpt: "学习材料摘要。",
  byline: "作者甲",
  siteName: "学习站点",
  warnings: ["提取内容可能不含动态区块，请核对正文。"],
  kind: "article" as const,
};
const session = (id = owner) => ({
  user: { id },
  supabase: { from: mock.persistence, rpc: mock.persistence, storage: { from: mock.persistence } },
});

function request(
  options: {
    url?: string;
    body?: string;
    input?: unknown;
    user?: string | null;
    headers?: HeadersInit;
    signal?: AbortSignal;
  } = {},
) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.user !== null) headers.set("X-Conuo-User", options.user ?? owner);
  new Headers(options.headers).forEach((value, key) => headers.set(key, value));
  return new Request(options.url ?? apiUrl, {
    method: "POST",
    headers,
    body: options.body ?? JSON.stringify(options.input ?? { url: pageUrl }),
    signal: options.signal,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NODE_ENV", "production");
  mock.config.mockReturnValue({ url: "https://test.supabase.co", key: "public-test-key" });
  mock.requireUser.mockResolvedValue(session());
  mock.fetch.mockResolvedValue({ ...fetched });
  mock.extract.mockReturnValue({ ...article });
  mock.persistence.mockImplementation(() => {
    throw new Error("Preview must not persist data");
  });
  mock.model.mockImplementation(() => {
    throw new Error("Preview must not invoke AI");
  });
  const limiter = new PreviewLimiter();
  mock.reserve.mockImplementation((userId: string) => limiter.reserve(userId));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("web preview route authorization", () => {
  it("GET only checks availability, with no fetching, extraction or limiter reservation", async () => {
    const response = await GET(new Request(apiUrl, { headers: { "X-Conuo-User": owner } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: true });
    expect(mock.requireUser).toHaveBeenCalledTimes(1);
    expect(mock.fetch).not.toHaveBeenCalled();
    expect(mock.extract).not.toHaveBeenCalled();
    expect(mock.reserve).not.toHaveBeenCalled();
  });

  it("production never enables anonymous extraction just because the URL is loopback", async () => {
    mock.config.mockReturnValue(null);
    const status = await GET(new Request(apiUrl));
    expect(await status.json()).toMatchObject({ available: false });
    const result = await POST(request({ user: null }));
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ code: "WEB_NOT_CONFIGURED" });
    expect(mock.requireUser).not.toHaveBeenCalled();
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it("rejects a missing or expired production login without fetching", async () => {
    mock.requireUser.mockRejectedValue(new ApiError(401, "UNAUTHENTICATED", "请先登录。"));
    expect(await (await GET(new Request(apiUrl))).json()).toMatchObject({ available: false });
    const result = await POST(request());
    expect(result.status).toBe(401);
    expect(await result.json()).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(mock.fetch).not.toHaveBeenCalled();
    expect(mock.reserve).not.toHaveBeenCalled();
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "permits anonymous development only at loopback host %s without Supabase",
    async (host) => {
      vi.stubEnv("NODE_ENV", "development");
      mock.config.mockReturnValue(null);
      const response = await POST(
        request({ url: `http://${host}:3000/api/v1/web/preview`, user: null }),
      );
      expect(response.status).toBe(200);
      expect(mock.requireUser).not.toHaveBeenCalled();
      expect(mock.reserve).toHaveBeenCalledWith("local-development");
      expect(mock.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["development", "production", "test"] as const)(
    "does not trust forwarded loopback host claims in %s",
    async (environment) => {
      vi.stubEnv("NODE_ENV", environment);
      mock.config.mockReturnValue(null);
      const response = await POST(
        request({
          url: "https://preview.example/api/v1/web/preview",
          user: null,
          headers: { Host: "localhost:3000", "X-Forwarded-Host": "127.0.0.1:3000" },
        }),
      );
      expect(response.status).toBe(503);
      expect(mock.fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["owner-a", ""])(
    "rejects any present account header in local anonymous mode (%j)",
    async (user) => {
      vi.stubEnv("NODE_ENV", "development");
      mock.config.mockReturnValue(null);
      const response = await POST(request({ user }));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "SESSION_CHANGED" });
      expect(mock.fetch).not.toHaveBeenCalled();
    },
  );

  it("requires the authenticated session in development when Supabase is configured", async () => {
    vi.stubEnv("NODE_ENV", "development");
    mock.requireUser.mockRejectedValue(new ApiError(401, "UNAUTHENTICATED", "请先登录。"));
    expect((await POST(request({ user: null }))).status).toBe(401);
    expect(mock.requireUser).toHaveBeenCalledTimes(1);
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it("rejects a session mismatch before any network activity", async () => {
    mock.requireUser.mockRejectedValue(new ApiError(409, "SESSION_CHANGED", "当前账号已改变。"));
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "SESSION_CHANGED" });
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it("rechecks the identity after fetching and never returns one account's preview to another", async () => {
    mock.requireUser.mockResolvedValueOnce(session()).mockResolvedValueOnce(session("owner-b"));
    const response = await POST(request());
    expect(response.status).toBe(409);
    const result = await response.json();
    expect(result).toMatchObject({ code: "SESSION_CHANGED" });
    expect(result).not.toHaveProperty("text");
    expect(mock.requireUser).toHaveBeenCalledTimes(2);
  });

  it("rejects session expiry during extraction", async () => {
    mock.requireUser
      .mockResolvedValueOnce(session())
      .mockRejectedValueOnce(new ApiError(401, "UNAUTHENTICATED", "会话已过期。"));
    expect((await POST(request())).status).toBe(401);
    expect(mock.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not return anonymous results after local configuration switches to an account", async () => {
    vi.stubEnv("NODE_ENV", "development");
    mock.config.mockReturnValue(null);
    mock.fetch.mockImplementation(async () => {
      mock.config.mockReturnValue({ url: "https://test.supabase.co", key: "test" });
      return fetched;
    });
    const response = await POST(request({ user: null }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "SESSION_CHANGED" });
  });
});

describe("web preview request boundaries", () => {
  it.each([
    [{ Origin: "https://outside.example" }, 403, "CROSS_ORIGIN"],
    [{ "Sec-Fetch-Site": "cross-site" }, 403, "CROSS_ORIGIN"],
    [{ "Content-Type": "application/x-www-form-urlencoded" }, 415, "JSON_REQUIRED"],
    [{ "Content-Type": "text/plain" }, 415, "JSON_REQUIRED"],
    [{ "Content-Length": "20000" }, 413, "TOO_LARGE"],
  ] as const)(
    "rejects unsafe request headers before contacting any service: %j",
    async (headers, status, code) => {
      const response = await POST(request({ headers }));
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
      expect(mock.requireUser).not.toHaveBeenCalled();
      expect(mock.fetch).not.toHaveBeenCalled();
      expect(mock.reserve).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "1"])(
    "enforces actual UTF-8 body bytes with content-length %j",
    async (length) => {
      const response = await POST(
        request({
          body: JSON.stringify({ url: "https://article.example/" + "学".repeat(6000) }),
          headers: length ? { "Content-Length": length } : {},
        }),
      );
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ code: "TOO_LARGE" });
      expect(mock.fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed JSON without reflecting input secrets", async () => {
    const response = await POST(request({ body: '{"url": "SECRET_UNPARSEABLE_PAYLOAD"' }));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("SECRET_UNPARSEABLE_PAYLOAD");
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { url: "" },
    { url: 4 },
    { url: pageUrl, sourceId: "cannot-overwrite" },
    { url: "file:///etc/passwd" },
    { url: "javascript:alert(1)" },
    { url: "https://name:SECRET_PASSWORD@article.example/" },
    { url: "https://article.example/" + "x".repeat(8192) },
  ])("refuses invalid or extended payloads before fetching: %j", async (input) => {
    const response = await POST(request({ input }));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("SECRET_PASSWORD");
    expect(mock.fetch).not.toHaveBeenCalled();
    expect(mock.reserve).not.toHaveBeenCalled();
  });

  it("returns only validated preview metadata, with no persistence or AI side effects", async () => {
    const input = request({
      input: { url: "  HTTPS://ARTICLE.EXAMPLE/lesson  " },
      headers: { Origin: "http://localhost:3000" },
    });
    const response = await POST(input);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...article,
      originalUrl: pageUrl,
      finalUrl: fetched.finalUrl,
      capturedAt: fetched.fetchedAt,
    });
    expect(mock.fetch).toHaveBeenCalledWith(pageUrl, input.signal);
    expect(mock.extract).toHaveBeenCalledWith(fetched.html, fetched.finalUrl);
    expect(mock.persistence).not.toHaveBeenCalled();
    expect(mock.model).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("returns an explicit link-only preview when no article could be extracted", async () => {
    mock.extract.mockReturnValue({
      title: "需要登录",
      kind: "link-only",
      text: "",
      excerpt: "",
      warnings: ["请手动提供正文。"],
    });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: "link-only",
      text: "",
      originalUrl: pageUrl,
    });
  });

  it.each([
    { ...article, title: "长".repeat(513) },
    { ...article, text: "" },
    { ...article, kind: "link-only", text: "must not escape" },
    { ...article, html: "SECRET_UNVALIDATED_HTML" },
  ])("does not return malformed extraction results or extra raw HTML", async (invalid) => {
    mock.extract.mockReturnValue(invalid);
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("SECRET_UNVALIDATED_HTML");
  });

  it("surfaces a recognized public fetch failure and hides unexpected low-level errors", async () => {
    mock.fetch.mockRejectedValueOnce(
      new WebFetchError("WEB_ADDRESS_BLOCKED", "此地址不属于可抓取的公开网页。"),
    );
    const blocked = await POST(request());
    expect(blocked.status).toBe(422);
    expect(await blocked.json()).toEqual({
      code: "WEB_ADDRESS_BLOCKED",
      error: "此地址不属于可抓取的公开网页。",
    });
    mock.fetch.mockRejectedValueOnce(
      new Error("SECRET_UPSTREAM_TOKEN dns/internal/connection detail"),
    );
    const failed = await POST(request());
    expect(failed.status).toBe(502);
    const result = await failed.json();
    expect(result.code).toBe("WEB_EXTRACTION_FAILED");
    expect(JSON.stringify(result)).not.toMatch(/SECRET_UPSTREAM_TOKEN|dns\/internal/);
  });
});

describe("web preview cancellation and reservation release", () => {
  it("does not reserve or fetch for a previously cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = await POST(request({ signal: controller.signal }));
    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({ code: "WEB_CANCELLED" });
    expect(mock.fetch).not.toHaveBeenCalled();
    expect(mock.reserve).not.toHaveBeenCalled();
  });

  it("discards a late fetch after cancellation and releases the active slot", async () => {
    const release = vi.fn();
    mock.reserve.mockReturnValue(release);
    const controller = new AbortController();
    const pending = deferred<typeof fetched>();
    mock.fetch.mockReturnValue(pending.promise);
    const response = POST(request({ signal: controller.signal }));
    await vi.waitFor(() => expect(mock.fetch).toHaveBeenCalledTimes(1));
    controller.abort();
    pending.resolve(fetched);
    expect((await response).status).toBe(499);
    expect(mock.extract).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("checks cancellation again after the second authorization completes", async () => {
    const controller = new AbortController();
    const release = vi.fn();
    mock.reserve.mockReturnValue(release);
    mock.requireUser.mockResolvedValueOnce(session()).mockImplementationOnce(async () => {
      controller.abort();
      return session();
    });
    const response = await POST(request({ signal: controller.signal }));
    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({ code: "WEB_CANCELLED" });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each(["fetch", "extract", "reauthorize", "schema", "success"])(
    "releases a reservation exactly once after %s",
    async (phase) => {
      const release = vi.fn();
      mock.reserve.mockReturnValue(release);
      if (phase === "fetch") mock.fetch.mockRejectedValue(new Error("failed fetch"));
      if (phase === "extract")
        mock.extract.mockImplementation(() => {
          throw new Error("failed extraction");
        });
      if (phase === "reauthorize")
        mock.requireUser
          .mockResolvedValueOnce(session())
          .mockRejectedValueOnce(new ApiError(401, "UNAUTHENTICATED", "会话失效。"));
      if (phase === "schema") mock.extract.mockReturnValue({ ...article, text: "" });
      await POST(request());
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it("frees concurrency on fetch failures while still counting failed requests toward the minute quota", async () => {
    mock.fetch.mockRejectedValue(new Error("ordinary failure"));
    for (let count = 0; count < 10; count++) expect((await POST(request())).status).toBe(502);
    const limited = await POST(request());
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "WEB_BUSY" });
    expect(mock.fetch).toHaveBeenCalledTimes(10);
  });

  it("limits two pending requests per account before starting a third network request", async () => {
    const first = deferred<typeof fetched>();
    const second = deferred<typeof fetched>();
    mock.fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const one = POST(request());
    const two = POST(request());
    await vi.waitFor(() => expect(mock.fetch).toHaveBeenCalledTimes(2));
    expect((await POST(request())).status).toBe(429);
    expect(mock.fetch).toHaveBeenCalledTimes(2);
    first.resolve(fetched);
    second.resolve(fetched);
    expect((await one).status).toBe(200);
    expect((await two).status).toBe(200);
    expect((await POST(request())).status).toBe(200);
  });
});

describe("PreviewLimiter real backpressure", () => {
  it("allows ten starts per account and recovers at the next minute", () => {
    let now = 1000;
    const limiter = new PreviewLimiter(() => now);
    for (let i = 0; i < 10; i++) limiter.reserve(owner)();
    expect(() => limiter.reserve(owner)).toThrow(
      expect.objectContaining({ status: 429, code: "WEB_BUSY" }),
    );
    now = 60999;
    expect(() => limiter.reserve(owner)).toThrow();
    now = 61000;
    const release = limiter.reserve(owner);
    release();
  });

  it("keeps separate per-account quotas", () => {
    const limiter = new PreviewLimiter();
    for (let i = 0; i < 10; i++) limiter.reserve("owner-a")();
    const release = limiter.reserve("owner-b");
    expect(() => limiter.reserve("owner-a")).toThrow();
    release();
  });

  it("holds at most two slots per account and release is idempotent", () => {
    const limiter = new PreviewLimiter();
    const first = limiter.reserve(owner);
    const second = limiter.reserve(owner);
    expect(() => limiter.reserve(owner)).toThrow();
    first();
    first();
    const third = limiter.reserve(owner);
    expect(() => limiter.reserve(owner)).toThrow();
    second();
    third();
  });

  it("holds at most four active slots globally, even across different users", () => {
    const limiter = new PreviewLimiter();
    const releases = ["a", "b", "c", "d"].map((id) => limiter.reserve(id));
    expect(() => limiter.reserve("e")).toThrow(expect.objectContaining({ status: 429 }));
    releases[0]();
    const final = limiter.reserve("e");
    expect(() => limiter.reserve("f")).toThrow();
    releases.forEach((release) => release());
    final();
  });

  it("does not reset live concurrency when the rate window advances", () => {
    let now = 0;
    const limiter = new PreviewLimiter(() => now);
    const first = limiter.reserve(owner);
    const second = limiter.reserve(owner);
    now = 60000;
    expect(() => limiter.reserve(owner)).toThrow();
    first();
    const third = limiter.reserve(owner);
    expect(() => limiter.reserve(owner)).toThrow();
    second();
    third();
  });

  it("bounds retained account entries and recovers capacity after idle entries expire", () => {
    let now = 0;
    const limiter = new PreviewLimiter(() => now);
    for (let i = 0; i < 256; i++) limiter.reserve(`user-${i}`)();
    expect(() => limiter.reserve("new-user")).toThrow(expect.objectContaining({ status: 429 }));
    now = 60000;
    limiter.reserve("new-user")();
  });
});
