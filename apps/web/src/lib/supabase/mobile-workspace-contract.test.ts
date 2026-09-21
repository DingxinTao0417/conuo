import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerScope,
  createTextNote,
  snapshotSchema as mobileSnapshotSchema,
} from "../../../../mobile/src/core/contracts";
import { createDemoWorkspace } from "@/lib/seed";
import { answerRequestSchema, saveRequestSchema, workspaceSchema } from "./validation";

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/supabase/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase/api")>()),
  requireUser: mocks.requireUser,
}));
import { PUT } from "@/app/api/v1/workspace/route";

const now = "2026-09-21T08:00:00.000Z";
const ownerId = "native-contract-owner";

function cloudFixture() {
  const data = createDemoWorkspace();
  const source = data.sources[0];
  source.tagsLocked = true;
  source.tagsRevision = 6;
  source.readOffset = 140;
  source.readingPositionAlternatives = [{ origin: "remote", readOffset: 75, lastReadAt: now }];
  data.semanticSearch = true;
  data.autoOrganize = false;
  data.notes.push({
    id: "existing-note",
    spaceId: data.spaces[0].id,
    title: "已有笔记",
    content: "<p>保留网页版历史与摘录来源。</p>",
    kind: "note",
    status: "accepted",
    contentRevision: 3,
    manualExcerptRefs: [
      {
        sourceId: source.id,
        versionId: source.versionId,
        chunkId: source.chunks[0].id,
        selectionFingerprint: "0123456789abcdef",
      },
    ],
    citations: [],
    versions: [
      {
        id: "note-history",
        title: "旧标题",
        content: "<p>旧内容</p>",
        savedAt: now,
        contentRevision: 2,
      },
    ],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  // Model an actual JSON response, including removal of optional undefined values.
  return workspaceSchema.parse(JSON.parse(JSON.stringify(data)));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ user: { id: ownerId }, supabase: { rpc: mocks.rpc } });
});

describe("native client / real Web workspace contract", () => {
  it("accepts a native text note and preserves server fields the native reader does not model", async () => {
    const original = cloudFixture();
    const snapshot = mobileSnapshotSchema.parse({ data: original, revision: 23 });
    expect(snapshot.data).toEqual(original);

    const next = createTextNote(snapshot.data!, {
      id: "native-note",
      spaceId: original.spaces[0].id,
      title: "  移动端学习笔记 😀  ",
      text: '<b>自己总结</b> & "原文"\n下一段',
      now,
    });
    const payload = JSON.parse(JSON.stringify({ data: next, expectedRevision: snapshot.revision }));
    const parsed = saveRequestSchema.parse(payload);
    expect(parsed.expectedRevision).toBe(23);
    expect(parsed.data.notes.at(-1)).toMatchObject({
      title: "移动端学习笔记 😀",
      content: "<p>&lt;b&gt;自己总结&lt;/b&gt; &amp; &quot;原文&quot;</p><p>下一段</p>",
      kind: "note",
      status: "accepted",
      aiGenerated: false,
      contentRevision: 1,
      createdAt: now,
      updatedAt: now,
    });
    expect({ ...parsed.data, notes: parsed.data.notes.slice(0, -1) }).toEqual(original);
    expect(snapshot.data).toEqual(original);

    mocks.rpc.mockResolvedValue({ data: 24, error: null });
    const response = await PUT(
      new Request("https://example.test/api/v1/workspace", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revision: 24 });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("save_workspace", {
      p_data: parsed.data,
      p_expected_revision: 23,
    });
  });

  it("keeps an unrecognized future field so the current server rejects incompatibility rather than silently deleting it", async () => {
    const snapshot = mobileSnapshotSchema.parse({
      data: { ...cloudFixture(), futureCapability: { enabled: true } },
      revision: 23,
    });
    const next = createTextNote(snapshot.data!, {
      id: "native-note",
      spaceId: snapshot.data!.spaces[0].id,
      title: "新笔记",
      text: "内容",
      now,
    });
    expect(next.futureCapability).toEqual({ enabled: true });
    const response = await PUT(
      new Request("https://example.test/api/v1/workspace", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: next, expectedRevision: snapshot.revision }),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_WORKSPACE" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("uses the server's version-bound document question contract without widening the selected source", () => {
    const snapshot = mobileSnapshotSchema.parse({ data: cloudFixture(), revision: 23 });
    const source = snapshot.data!.sources[0];
    const payload = answerScope(
      snapshot.data!,
      source.id,
      "  这段内容如何理解？  ",
      "native-question",
    );
    expect(answerRequestSchema.parse(JSON.parse(JSON.stringify(payload)))).toEqual({
      requestId: "native-question",
      question: "这段内容如何理解？",
      scope: "document",
      spaceId: source.spaceIds[0],
      sourceId: source.id,
      sourceIds: [source.id],
      sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
    });
  });
});
