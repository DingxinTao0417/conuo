import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adoptSnapshot,
  answerScope,
  blankWorkspace,
  createTextNote,
  readingBlocks,
  snapshotSchema,
  type Workspace,
} from "./contracts.ts";
const now = "2026-09-21T00:00:00.000Z";
function workspace(): Workspace {
  return {
    ...blankWorkspace(),
    aiEnabled: true,
    spaces: [
      {
        id: "library",
        name: "Library",
        goal: "",
        color: "#abc",
        archived: false,
        createdAt: now,
      },
    ],
    sources: [
      {
        id: "source",
        versionId: "version",
        title: "Document",
        filename: "doc.txt",
        kind: "text",
        text: "A source paragraph",
        chunks: [
          {
            id: "chunk",
            sourceId: "source",
            versionId: "version",
            text: "A source paragraph",
            section: "",
          },
        ],
        spaceIds: ["library"],
        tags: [],
        status: "ready",
        aiAllowed: true,
        starred: false,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
  };
}
test("answer request fixes the exact current version and active library", () => {
  const payload = answerScope(workspace(), "source", " why? ", "attempt");
  assert.equal(payload.question, "why?");
  assert.equal(payload.spaceId, "library");
  assert.deepEqual(payload.sourceVersions, [
    { sourceId: "source", versionId: "version" },
  ]);
});
test("archived, deleted, AI-disabled and unparsed sources cannot be submitted", () => {
  for (const mutate of [
    (w: Workspace) => {
      w.spaces[0].archived = true;
    },
    (w: Workspace) => {
      w.sources[0].deletedAt = now;
    },
    (w: Workspace) => {
      w.aiEnabled = false;
    },
    (w: Workspace) => {
      w.sources[0].aiAllowed = false;
    },
    (w: Workspace) => {
      w.sources[0].chunks = [];
    },
  ]) {
    const w = workspace();
    mutate(w);
    assert.throws(() => answerScope(w, "source", "why", "attempt"));
  }
});
test("inbox is used only when a source has no library membership", () => {
  const w = workspace();
  w.sources[0].spaceIds = [];
  assert.equal(answerScope(w, "source", "why", "a").spaceId, "inbox");
  w.sources[0].spaceIds = ["missing"];
  assert.throws(() => answerScope(w, "source", "why", "a"));
});
test("snapshot parsing preserves fields that the mobile reader does not edit", () => {
  const w = workspace();
  w.conceptRelations = [{ id: "keep-this" }];
  w.sources[0].versions = [{ versionId: "old" }];
  const parsed = snapshotSchema.parse({ data: w, revision: 4 });
  assert.deepEqual(parsed.data, w);
  assert.equal(
    snapshotSchema.safeParse({ data: null, revision: 4 }).success,
    false,
  );
});
test("creating a plain-text note escapes HTML and preserves all unrelated workspace fields", () => {
  const w = workspace();
  w.organizationJobs = [{ id: "pending-job" }];
  const next = createTextNote(w, {
    id: "new",
    spaceId: "library",
    title: "My note",
    text: "<script>alert(1)</script>\n& learning",
    now,
  });
  assert.equal(
    next.notes[0].content,
    "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p><p>&amp; learning</p>",
  );
  assert.equal(next.notes[0].aiGenerated, false);
  assert.equal(next.notes[0].status, "accepted");
  assert.deepEqual(next.organizationJobs, w.organizationJobs);
  assert.equal(w.notes.length, 0);
  assert.throws(() =>
    createTextNote(next, {
      id: "new",
      spaceId: "library",
      title: "retry",
      text: "retry",
      now,
    }),
  );
});
test("a late refresh never rolls a committed snapshot back", () => {
  const current = { data: workspace(), revision: 8 };
  assert.equal(adoptSnapshot(current, { data: null, revision: 0 }), current);
  assert.equal(
    adoptSnapshot(current, { data: workspace(), revision: 7 }),
    current,
  );
  assert.equal(
    adoptSnapshot(current, { data: workspace(), revision: 9 }).revision,
    9,
  );
});
test("reading anchors preserve the full source text once and avoid ambiguous quotes", () => {
  const source = workspace().sources[0];
  source.text = `Before.\n${source.chunks[0].text}\nAfter.`;
  const blocks = readingBlocks(source);
  assert.equal(blocks.map((block) => block.text).join(""), source.text);
  assert.equal(blocks.filter((block) => block.chunkId).length, 1);
  source.text += source.chunks[0].text;
  assert.equal(
    readingBlocks(source).filter((block) => block.chunkId).length,
    0,
  );
});
