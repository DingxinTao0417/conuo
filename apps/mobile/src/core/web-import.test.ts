import { test } from "node:test";
import assert from "node:assert/strict";
import { blankWorkspace, type Workspace } from "./contracts.ts";
import {
  createWebSource,
  duplicateWebSource,
  normalizeImportUrl,
  webPreviewSchema,
  type WebPreview,
} from "./web-import.ts";

const now = "2026-09-21T10:00:00.000Z";
const input = {
  id: "source-web",
  versionId: "version-web",
  url: "https://example.test/article",
  now,
};
const preview: WebPreview = {
  originalUrl: input.url,
  finalUrl: "https://example.test/read/1",
  capturedAt: now,
  title: "第一篇文章",
  text: "# 学習\r\n\r\n正文 😀\u0000，逐字保存。",
  excerpt: "正文",
  kind: "article",
  warnings: ["网页中部分内容未包含在正文内。"],
  siteName: "学习站点",
};
const workspace = (): Workspace => ({
  ...blankWorkspace(),
  aiEnabled: true,
  futureSetting: { keep: "yes" },
  spaces: [
    {
      id: "space-a",
      name: "学习",
      goal: "",
      color: "#555",
      archived: false,
      createdAt: now,
    },
  ],
});

test("URL syntax rejects credentials, non-web protocols, embedded whitespace and controls", () => {
  assert.equal(
    normalizeImportUrl("  HTTPS://Example.test:443/article#one  "),
    "https://example.test/article#one",
  );
  for (const url of [
    "https://user:pass@example.test",
    "file:///test",
    "javascript:alert(1)",
    "example.test",
    "https://example.test/a b",
    "https://example.test/a\nb",
    "https://example.test/" + "a".repeat(8192),
  ])
    assert.throws(() => normalizeImportUrl(url));
});

test("captured article retains exact source/version identity, text chunks and future workspace fields", () => {
  const original = workspace();
  const frozen = structuredClone(original);
  const next = createWebSource(original, {
    ...input,
    preview,
    spaceId: "space-a",
  });
  const source = next.sources[0];
  assert.equal(source.id, input.id);
  assert.equal(source.versionId, input.versionId);
  assert.equal(source.text, "# 学習\n\n正文 😀，逐字保存。");
  assert.equal(source.size, Buffer.byteLength(source.text));
  assert.equal(source.hash, "");
  assert.equal(source.status, "ready");
  assert.equal(source.aiAllowed, false);
  assert.deepEqual(source.spaceIds, ["space-a"]);
  assert.deepEqual(source.coverage, {
    captureScope: "full",
    parseState: "complete",
  });
  assert.deepEqual(source.webSnapshot, {
    originalUrl: input.url,
    finalUrl: preview.finalUrl,
    capturedAt: now,
    method: "server",
    scope: "article",
    warnings: preview.warnings,
    siteName: preview.siteName,
  });
  source.chunks.forEach((chunk, index) => {
    assert.equal(chunk.sourceId, source.id);
    assert.equal(chunk.versionId, source.versionId);
    assert.equal(chunk.order, index);
    assert.ok(source.text.includes(chunk.text));
  });
  assert.deepEqual(next.futureSetting, { keep: "yes" });
  assert.deepEqual(original, frozen);
  assert.deepEqual(
    createWebSource(original, { ...input, preview, spaceId: "space-a" }),
    next,
  );
});

test("new links are inbox bookmarks with no searchable content or AI permission", () => {
  for (const data of [
    { ...input },
    {
      ...input,
      preview,
      mode: "link" as const,
      spaceId: "inbox",
      aiAllowed: true,
    },
  ]) {
    const source = createWebSource(workspace(), data).sources[0];
    assert.equal(source.text, "");
    assert.deepEqual(source.chunks, []);
    assert.equal(source.aiAllowed, false);
    assert.equal(source.status, "link-only");
    assert.deepEqual(source.spaceIds, []);
    assert.deepEqual(source.coverage, {
      captureScope: "link",
      parseState: "not-requested",
    });
  }
});

test("AI opt-in only applies to articles when workspace AI is enabled", () => {
  assert.equal(
    createWebSource(workspace(), { ...input, preview, aiAllowed: true })
      .sources[0].aiAllowed,
    true,
  );
  assert.throws(
    () =>
      createWebSource(
        { ...workspace(), aiEnabled: false },
        { ...input, preview, aiAllowed: true },
      ),
    /先开启工作区/,
  );
  assert.equal(
    createWebSource({ ...workspace(), aiEnabled: false }, input).sources[0]
      .aiAllowed,
    false,
  );
});

test("duplicate detection follows redirects and ignores fragments without conflating query parameters", () => {
  const first = createWebSource(workspace(), { ...input, preview });
  assert.equal(
    duplicateWebSource(first, input.url + "#paragraph")?.id,
    input.id,
  );
  assert.equal(duplicateWebSource(first, preview.finalUrl)?.id, input.id);
  assert.equal(
    duplicateWebSource(first, input.url + "?different=1"),
    undefined,
  );
  const another = {
    ...input,
    id: "another-source",
    versionId: "another-version",
  };
  assert.throws(() => createWebSource(first, another), /已收藏这个网页/);
  assert.equal(
    createWebSource(first, { ...another, allowDuplicate: true }).sources.length,
    2,
  );
  const deleted = {
    ...first,
    sources: first.sources.map((source) => ({ ...source, deletedAt: now })),
  };
  assert.equal(duplicateWebSource(deleted, input.url), undefined);
  assert.throws(
    () => createWebSource(deleted, { ...input, allowDuplicate: true }),
    /已经保存/,
  );
});

test("cannot reuse source/version identity or silently save into a removed or archived space", () => {
  const first = createWebSource(workspace(), input);
  assert.throws(
    () =>
      createWebSource(first, {
        ...input,
        url: "https://example.test/other",
        id: "another-id",
      }),
    /已经保存/,
  );
  assert.throws(
    () => createWebSource(workspace(), { ...input, spaceId: "missing" }),
    /目标知识库/,
  );
  assert.throws(
    () =>
      createWebSource(
        {
          ...workspace(),
          spaces: workspace().spaces.map((space) => ({
            ...space,
            archived: true,
          })),
        },
        { ...input, spaceId: "space-a" },
      ),
    /目标知识库/,
  );
  assert.throws(
    () => createWebSource(workspace(), { ...input, id: "bad:id" }),
    /身份/,
  );
});

test("stale preview, link-only text inconsistencies and empty article content fail closed", () => {
  assert.throws(
    () =>
      createWebSource(workspace(), {
        ...input,
        url: "https://example.test/other",
        preview,
      }),
    /来源/,
  );
  assert.throws(
    () => createWebSource(workspace(), { ...input, mode: "article" }),
    /没有提取/,
  );
  assert.equal(
    webPreviewSchema.safeParse({ ...preview, kind: "link-only" }).success,
    false,
  );
  assert.equal(
    webPreviewSchema.safeParse({ ...preview, text: "   " }).success,
    false,
  );
  assert.throws(
    () =>
      createWebSource(workspace(), {
        ...input,
        preview: { ...preview, text: "\u0000" },
      }),
    /没有可保存/,
  );
  assert.throws(() =>
    createWebSource(workspace(), {
      ...input,
      preview: { ...preview, text: "a".repeat(120_001) },
    }),
  );
});

test("long text chunks remain valid Unicode and fit Web section and snapshot limits", () => {
  const article = {
    ...preview,
    text:
      "# " +
      "标".repeat(550) +
      "\n\n" +
      "文".repeat(1199) +
      "😀" +
      "学".repeat(1250),
  };
  const source = createWebSource(workspace(), { ...input, preview: article })
    .sources[0];
  source.chunks.forEach((chunk) => {
    assert.ok(chunk.text.length <= 1200);
    assert.ok(chunk.section.length <= 512);
    assert.equal(chunk.text, Buffer.from(chunk.text).toString("utf8"));
    assert.ok(source.text.includes(chunk.text));
  });
  assert.throws(
    () =>
      createWebSource(
        { ...workspace(), futureData: "学".repeat(1_050_000) },
        input,
      ),
    /3 MiB/,
  );
});
