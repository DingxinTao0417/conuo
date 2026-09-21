import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceSchema } from "./contracts.ts";
import {
  createReaderSession,
  readerKey,
  readerModel,
  readingBookmark,
  readingOffset,
} from "./reader.ts";

function source() {
  return sourceSchema.parse({
    id: "source",
    versionId: "version",
    title: "Reading",
    filename: "reading.txt",
    kind: "text",
    text: "Opening.\nFirst paragraph.\nSecond paragraph.\nEnding.",
    chunks: [
      {
        id: "first",
        sourceId: "source",
        versionId: "version",
        text: "First paragraph.",
        section: "First",
      },
      {
        id: "second",
        sourceId: "source",
        versionId: "version",
        text: "Second paragraph.",
        section: "Second",
      },
    ],
    spaceIds: [],
    tags: [],
    status: "ready",
    aiAllowed: false,
    starred: false,
    createdAt: "2026-09-21T00:00:00Z",
    updatedAt: "2026-09-21T00:00:00Z",
    deletedAt: null,
  });
}

test("reader contents only anchor unique current-version chunks without altering source text", () => {
  const input = source();
  input.chunks[1].versionId = "old-version";
  const model = readerModel(input);
  assert.deepEqual(
    model.contents.map((item) => item.chunkId),
    ["first"],
  );
  assert.equal(model.blocks.map((item) => item.text).join(""), input.text);
  input.chunks.push({ ...input.chunks[0], text: "Opening." });
  assert.equal(readerModel(input).contents.length, 0);
});

test("reader never claims precise anchors for repeated or overlapping text", () => {
  const input = source();
  input.text += "\nFirst paragraph.";
  assert.deepEqual(
    readerModel(input).contents.map((item) => item.chunkId),
    ["second"],
  );
  input.chunks.push({
    ...input.chunks[1],
    id: "overlap",
    text: "Second paragraph.\nEnding.",
  });
  assert.equal(readerModel(input).contents.length, 1);
  assert.equal(
    readerModel(input)
      .blocks.map((item) => item.text)
      .join(""),
    input.text,
  );
});

test("Markdown presentation keeps exact source text and versioned chunk locations through font reflow", () => {
  const input = source();
  input.kind = "markdown";
  const table =
    "## 学习计划\n\n| 内容 | 次数 |\n| --- | --- |\n| 主动回忆 | 3 |";
  const practice =
    "> 保留原文中的 -- 与 '引号'\n\n1. 阅读材料\n2. 用自己的话解释\n\n```js\nconst count = 3;\n```";
  input.text = `# 章节\n\n${table}\n\n${practice}\n\n结语。`;
  input.chunks = [
    { ...input.chunks[0], text: table, section: "学习计划" },
    { ...input.chunks[1], text: practice, section: "练习" },
  ];
  const original = structuredClone(input);
  const model = readerModel(input);
  assert.equal(model.blocks.map((block) => block.text).join(""), input.text);
  assert.deepEqual(input, original);
  for (const item of model.contents) {
    const chunk = input.chunks.find(
      (candidate) => candidate.id === item.chunkId,
    )!;
    assert.equal(model.blocks[item.block].text, chunk.text);
  }

  const practiceIndex = model.contents.find(
    (item) => item.chunkId === "second",
  )!.block;
  const before = [{ index: practiceIndex, y: 950, height: 300 }];
  const bookmark = readingBookmark(before, 1100);
  const after = [{ index: practiceIndex, y: 1350, height: 600 }];
  assert.equal(readingOffset(bookmark, after, 2500), 1650);
  input.chunks[1].versionId = "obsolete";
  assert.equal(
    readerModel(input).contents.some((item) => item.chunkId === "second"),
    false,
  );
});

test("reading position follows its paragraph when font size or viewport width reflows text", () => {
  const before = [
    { index: 0, y: 180, height: 200 },
    { index: 1, y: 400, height: 300 },
  ];
  const anchor = readingBookmark(before, 550);
  assert.deepEqual(anchor, { block: 1, fraction: 0.5, offset: 550 });
  const after = [
    { index: 0, y: 200, height: 400 },
    { index: 1, y: 620, height: 600 },
  ];
  assert.equal(readingOffset(anchor, after, 2000), 920);
  assert.equal(readingOffset(anchor, after, 700), 700);
  assert.equal(readingOffset(anchor, [], 2000), 550);
});

test("opening, overscroll, and temporarily empty layouts keep safe offsets", () => {
  const blocks = [{ index: 0, y: 200, height: 100 }];
  assert.deepEqual(readingBookmark(blocks, 30), {
    block: -1,
    fraction: 0,
    offset: 30,
  });
  assert.equal(readingOffset(readingBookmark(blocks, 30), blocks, 500), 30);
  assert.equal(readingBookmark(blocks, -50).offset, 0);
  assert.equal(readingBookmark(blocks, Number.NaN).offset, 0);
  assert.equal(readingBookmark(blocks, 500).fraction, 1);
});

test("reading session ownership and source versions isolate in-memory positions", () => {
  const first = createReaderSession();
  const second = createReaderSession();
  const key = readerKey(source());
  first.positions.set(key, { block: 0, fraction: 0.4, offset: 10 });
  assert.equal(second.positions.size, 0);
  assert.notEqual(readerKey({ id: "source", versionId: "next" }), key);
  assert.notEqual(
    readerKey({ id: "a/b", versionId: "c" }),
    readerKey({ id: "a", versionId: "b/c" }),
  );
});
