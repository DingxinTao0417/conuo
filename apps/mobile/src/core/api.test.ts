import { test } from "node:test";
import assert from "node:assert/strict";
import { createApi, validateApiUrl, type Identity } from "./api.ts";
import { blankWorkspace } from "./contracts.ts";
const owner = { userId: "test-owner", accessToken: "test-access" };
test("only HTTPS root origins are accepted, without credentials, path or query", () => {
  assert.equal(validateApiUrl("https://example.test"), "https://example.test");
  for (const bad of [
    "http://example.test",
    "https://name@example.test",
    "https://example.test/path",
    "https://example.test/?token=x",
    "file:///tmp",
  ])
    assert.throws(() => validateApiUrl(bad));
});
test("requests use bearer identity and omit browser cookies", async () => {
  let observed = false;
  const api = createApi(
    "https://example.test",
    async () => owner,
    async (url, init) => {
      assert.equal(url, "https://example.test/api/v1/workspace");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.redirect, "error");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Authorization"), "Bearer test-access");
      assert.equal(headers.get("X-Conuo-User"), owner.userId);
      assert.equal(headers.get("Cookie"), null);
      observed = true;
      return Response.json({ data: null, revision: 0 });
    },
  );
  assert.deepEqual(await api.load(owner.userId), { data: null, revision: 0 });
  assert.ok(observed);
});
test("wrong identity is rejected before network and late responses after sign-out are discarded", async () => {
  let calls = 0,
    current: Identity | null = owner;
  const api = createApi(
    "https://example.test",
    async () => current,
    async () => {
      calls++;
      current = null;
      return Response.json({ data: null, revision: 0 });
    },
  );
  await assert.rejects(api.load("other-user"), { code: "SESSION_CHANGED" });
  assert.equal(calls, 0);
  await assert.rejects(api.load(owner.userId), { code: "SESSION_CHANGED" });
  assert.equal(calls, 1);
});
test("save keeps the CAS revision and does not retry a conflict", async () => {
  let calls = 0;
  const api = createApi(
    "https://example.test",
    async () => owner,
    async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(String(init?.body)).expectedRevision, 5);
      return Response.json(
        { error: "Concurrent edit", code: "REVISION_CONFLICT" },
        { status: 409 },
      );
    },
  );
  await assert.rejects(
    api.save(
      owner.userId,
      { data: blankWorkspace(), revision: 5 },
      blankWorkspace(),
    ),
    { status: 409, code: "REVISION_CONFLICT" },
  );
  assert.equal(calls, 1);
});
test("malformed success responses and wrong revision increments are not accepted", async () => {
  const api = createApi(
    "https://example.test",
    async () => owner,
    async () => Response.json({ revision: 10 }),
  );
  await assert.rejects(api.load(owner.userId), { code: "INVALID_WORKSPACE" });
  await assert.rejects(
    api.save(owner.userId, { data: null, revision: 0 }, blankWorkspace()),
    { code: "INVALID_SAVE" },
  );
});

const preview = {
  originalUrl: "https://public.test/article",
  finalUrl: "https://public.test/read/1",
  capturedAt: "2026-09-21T10:00:00.000Z",
  title: "文章",
  text: "正文",
  excerpt: "正文",
  kind: "article",
  warnings: [],
};
test("web preview goes through the authenticated Conuo endpoint, never the entered website directly", async () => {
  const api = createApi(
    "https://example.test",
    async () => owner,
    async (url, init) => {
      assert.equal(url, "https://example.test/api/v1/web/preview");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        url: preview.originalUrl,
      });
      assert.equal(init?.credentials, "omit");
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer test-access",
      );
      return Response.json(preview);
    },
  );
  assert.deepEqual(
    await api.previewWeb(owner.userId, "  HTTPS://public.test/article  "),
    preview,
  );
});

test("web preview rejects a changed origin, invalid structure and late responses from another session", async () => {
  for (const value of [
    { ...preview, originalUrl: "https://another.test/" },
    { ...preview, text: "" },
  ]) {
    const api = createApi(
      "https://example.test",
      async () => owner,
      async () => Response.json(value),
    );
    await assert.rejects(api.previewWeb(owner.userId, preview.originalUrl), {
      code: "INVALID_WEB_PREVIEW",
    });
  }
  let identity: Identity | null = owner;
  const api = createApi(
    "https://example.test",
    async () => identity,
    async () => {
      identity = null;
      return Response.json(preview);
    },
  );
  await assert.rejects(api.previewWeb(owner.userId, preview.originalUrl), {
    code: "SESSION_CHANGED",
  });
});

test("web preview propagates cancellation and API failures without retrying or persisting", async () => {
  let calls = 0;
  const controller = new AbortController();
  const api = createApi(
    "https://example.test",
    async () => owner,
    async (_url, init) => {
      calls++;
      controller.abort();
      assert.equal(init?.signal?.aborted, true);
      return Response.json(preview);
    },
  );
  await assert.rejects(
    api.previewWeb(owner.userId, preview.originalUrl, controller.signal),
    { code: "CANCELLED" },
  );
  assert.equal(calls, 1);
  const failApi = createApi(
    "https://example.test",
    async () => owner,
    async () =>
      Response.json(
        { error: "无法提取这个网页", code: "WEB_EXTRACTION_FAILED" },
        { status: 422 },
      ),
  );
  await assert.rejects(failApi.previewWeb(owner.userId, preview.originalUrl), {
    code: "WEB_EXTRACTION_FAILED",
    status: 422,
  });
});
