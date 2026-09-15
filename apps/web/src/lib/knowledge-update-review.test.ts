import { describe, expect, it, vi, afterEach } from "vitest";
import { createDemoWorkspace } from "./seed";
import {
  knowledgeBlocks,
  snapshotKnowledgeNote,
  knowledgeNoteKey,
  knowledgeUpdateTargetReason,
  validateKnowledgeChanges,
  knowledgeUpdateReviewReason,
  applyKnowledgeUpdate,
  ignoreKnowledgeChange,
} from "./knowledge-update";
import { reviseNote, restoreNoteVersion } from "./note-versions";
import { acceptKnowledgePage } from "./organization-review";
import { workspaceSchema, MAX_WORKSPACE_BYTES } from "./supabase/validation";
import { organizationRequestSchema, organizationResultSchema } from "./organization-schema";
import type { Note, Citation } from "./types";
import type { OrganizationJob, OrganizationRequest } from "./organization-types";
import type { KnowledgeChange } from "./knowledge-update-types";

function fixture() {
  const data = createDemoWorkspace();
  const citations: Citation[] = data.sources.flatMap((source) =>
    source.chunks.slice(0, 2).map((chunk) => ({
      sourceId: source.id,
      versionId: source.versionId,
      chunkId: chunk.id,
      title: source.title,
      quote: chunk.text,
      section: chunk.section,
      page: chunk.page,
    })),
  );
  const note: Note = {
    id: "target-note",
    spaceId: data.spaces[0].id,
    title: "学习率",
    content:
      '<h2>解释</h2>\n<p data-user="keep"><strong>学习率</strong>决定步长 &amp; 速度。</p>\n<ul><li>保留 <em>我的例子</em></li></ul>',
    citations: [citations[0]],
    kind: "knowledge",
    status: "accepted",
    aiGenerated: false,
    contentRevision: 2,
    versions: [],
    createdAt: data.sources[0].createdAt,
    updatedAt: data.sources[0].updatedAt,
    deletedAt: null,
  };
  data.notes = [note];
  const request: OrganizationRequest = {
    requestId: "update-1",
    kind: "update",
    trigger: "manual",
    spaceId: note.spaceId,
    sourceIds: data.sources.map((source) => source.id),
    sourceVersions: data.sources.map((source) => ({
      sourceId: source.id,
      versionId: source.versionId,
    })),
    targetNote: { id: note.id, revision: 2, updatedAt: note.updatedAt },
  };
  const blocks = knowledgeBlocks(note.content);
  const changes: KnowledgeChange[] = [
    {
      id: "c1",
      type: "insert_after",
      blockId: "b2",
      before: blocks[1].html,
      after: "新增例子：步长过大时，损失可能振荡。",
      reason: "新资料补充例子。",
      citations: [citations[1]],
    },
    {
      id: "c2",
      type: "replace",
      blockId: "b1",
      before: blocks[0].html,
      after: "更新后的解释。",
      reason: "解释需要修订。",
      citations: [citations.at(-1)!],
    },
    {
      id: "c3",
      type: "remove",
      blockId: "b3",
      before: blocks[2].html,
      after: "",
      reason: "建议删除重复例子。",
      citations: [citations[0]],
    },
  ];
  const job: OrganizationJob = {
    id: request.requestId,
    request,
    status: "ready",
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    result: {
      kind: "update",
      mode: "model",
      target: snapshotKnowledgeNote(note),
      changes,
      coverage: "所选资料片段，需核对原文。",
    },
  };
  data.organizationJobs = [job];
  return { data, note, request, job, changes, blocks, citations };
}
const select = (change: KnowledgeChange) => ({ changeId: change.id, text: change.after });
afterEach(() => vi.useRealTimers());

describe("knowledge update blocks and contracts", () => {
  it("locates raw HTML blocks without rewriting user markup, spaces or entities", () => {
    const { note, blocks } = fixture();
    expect(blocks.map((b) => b.id)).toEqual(["b1", "b2", "b3"]);
    expect(blocks[1].text).toBe("学习率决定步长 & 速度。");
    for (const block of blocks) expect(note.content.slice(block.start, block.end)).toBe(block.html);
    expect(
      knowledgeBlocks("<p>a</p><!-- kept -->\n<table><tr><td>x</td></tr></table>")[1].html,
    ).toBe("<table><tr><td>x</td></tr></table>");
  });
  it("keeps comments and formatting outside the one accepted insertion byte-for-byte", () => {
    const { data, note, changes, blocks } = fixture();
    const next = applyKnowledgeUpdate(data, "update-1", [select(changes[0])]);
    const expected =
      note.content.slice(0, blocks[1].end) +
      `<p>${changes[0].after} [2]</p>` +
      note.content.slice(blocks[1].end);
    expect(next.notes[0].content).toBe(expected);
    expect(next.notes[0].title).toBe(note.title);
    expect(next.notes[0].status).toBe("accepted");
    expect(data.notes[0]).toEqual(note);
    expect(next.notes[0].versions[0]).toMatchObject({
      content: note.content,
      citations: note.citations,
      status: note.status,
      aiGenerated: false,
      contentRevision: 2,
    });
  });
  it("round-trips new optional metadata and legacy workspaces", () => {
    const { data, changes } = fixture();
    expect(
      workspaceSchema.safeParse(applyKnowledgeUpdate(data, "update-1", [select(changes[0])]))
        .success,
    ).toBe(true);
    expect(workspaceSchema.safeParse(createDemoWorkspace()).success).toBe(true);
  });
  it("requires an explicit target only for manual update requests", () => {
    const { request } = fixture();
    expect(organizationRequestSchema.safeParse(request).success).toBe(true);
    expect(organizationRequestSchema.safeParse({ ...request, targetNote: undefined }).success).toBe(
      false,
    );
    expect(organizationRequestSchema.safeParse({ ...request, trigger: "automatic" }).success).toBe(
      false,
    );
    expect(organizationRequestSchema.safeParse({ ...request, kind: "knowledge" }).success).toBe(
      false,
    );
  });
  it("accepts no change and start insertion for an empty page", () => {
    const { data, job, note, changes } = fixture();
    note.content = "";
    if (job.result?.kind !== "update") throw new Error();
    job.result.target = snapshotKnowledgeNote(note);
    job.result.changes = [];
    expect(organizationResultSchema.safeParse(job.result).success).toBe(true);
    expect(knowledgeUpdateReviewReason(data, job)).toBe("");
    const change = { ...changes[0], blockId: "start", before: "" };
    job.result.changes = [change];
    expect(applyKnowledgeUpdate(data, job.id, [select(change)]).notes[0].content).toContain(
      change.after,
    );
  });
  it.each([
    ["unknown anchor", { blockId: "b99" }],
    ["wrong original", { before: "<p>not the target</p>" }],
    ["empty insertion", { after: " " }],
    ["deletion text", { type: "remove", after: "hidden replacement" }],
    ["start replacement", { type: "replace", blockId: "start", before: "" }],
  ])("rejects %s", (_name, patch) => {
    const { job, changes } = fixture();
    if (job.result?.kind !== "update") throw new Error();
    expect(
      validateKnowledgeChanges(job.result.target, [{ ...changes[0], ...patch } as KnowledgeChange]),
    ).toBe(false);
  });
  it("rejects overlapping edits and unchanged replacements", () => {
    const { job, changes, blocks } = fixture();
    if (job.result?.kind !== "update") throw new Error();
    expect(
      validateKnowledgeChanges(job.result.target, [changes[0], { ...changes[0], id: "c4" }]),
    ).toBe(false);
    expect(
      validateKnowledgeChanges(job.result.target, [
        { ...changes[0], type: "replace", after: blocks[1].text },
      ]),
    ).toBe(false);
  });
});

describe("partial review and evidence", () => {
  it("rejects escaped HTML expansion beyond review capacity before changing the workspace", () => {
    const { data, note, job, changes } = fixture();
    note.content = Array.from({ length: 12 }, (_, index) => `<p>段落 ${index}</p>`).join("");
    if (job.result?.kind !== "update") throw new Error();
    job.result.target = snapshotKnowledgeNote(note);
    job.result.changes = knowledgeBlocks(note.content).map((block, index) => ({
      ...changes[0],
      id: `c${index + 1}`,
      blockId: block.id,
      before: block.html,
    }));
    expect(workspaceSchema.safeParse(data).success).toBe(true);
    const before = JSON.stringify(data);
    expect(() =>
      applyKnowledgeUpdate(
        data,
        job.id,
        job.result!.kind === "update"
          ? job.result!.changes.map((change) => ({ changeId: change.id, text: "'".repeat(6000) }))
          : [],
      ),
    ).toThrow("更新记录容量");
    expect(JSON.stringify(data)).toBe(before);
  });
  it("checks the full workspace including newly added history before applying", () => {
    const { data, changes } = fixture();
    const size = new TextEncoder().encode(JSON.stringify(data)).byteLength;
    data.sources[1].text += "x".repeat(MAX_WORKSPACE_BYTES - size - 100);
    expect(new TextEncoder().encode(JSON.stringify(data)).byteLength).toBeLessThan(
      MAX_WORKSPACE_BYTES,
    );
    const before = JSON.stringify(data);
    expect(() => applyKnowledgeUpdate(data, "update-1", [select(changes[0])])).toThrow("3 MiB");
    expect(JSON.stringify(data)).toBe(before);
  });
  it("applies batches in anchor order even when selection order differs", () => {
    const { data, changes } = fixture();
    const one = applyKnowledgeUpdate(data, "update-1", [select(changes[2]), select(changes[0])]);
    expect(one.notes[0].content).toContain(changes[0].after);
    expect(one.notes[0].content).not.toContain("<ul>");
    expect(one.notes[0].content).toContain("<h2>解释</h2>");
  });
  it("retains previously accepted citation numbers when accepting an earlier paragraph later", () => {
    const { data, changes } = fixture();
    const first = applyKnowledgeUpdate(data, "update-1", [select(changes[1])]);
    expect(first.notes[0].content).toContain(`<p>${changes[1].after} [2]</p>`);
    const second = applyKnowledgeUpdate(first, "update-1", [select(changes[0])]);
    expect(second.notes[0].content).toContain(`<p>${changes[1].after} [2]</p>`);
    expect(second.notes[0].content).toContain(`<p>${changes[0].after} [3]</p>`);
    expect(second.notes[0].versions.at(-1)?.content).toBe(first.notes[0].content);
    expect(second.notes[0].contentRevision).toBe(4);
  });
  it("ignores a suggestion without modifying the note; other suggestions remain actionable", () => {
    const { data, changes, note } = fixture();
    const ignored = ignoreKnowledgeChange(data, "update-1", "c2");
    expect(ignored.notes[0]).toBe(note);
    expect(() => applyKnowledgeUpdate(ignored, "update-1", [select(changes[1])])).toThrow();
    expect(
      applyKnowledgeUpdate(ignored, "update-1", [select(changes[0])]).notes[0].content,
    ).toContain(changes[0].after);
  });
  it("does not repeat accepted changes or silently accept unknown IDs", () => {
    const { data, changes } = fixture();
    const next = applyKnowledgeUpdate(data, "update-1", [select(changes[0])]);
    expect(() => applyKnowledgeUpdate(next, "update-1", [select(changes[0])])).toThrow();
    expect(() => ignoreKnowledgeChange(next, "update-1", "c1")).toThrow();
    expect(() =>
      applyKnowledgeUpdate(data, "update-1", [{ changeId: "other", text: "x" }]),
    ).toThrow();
    expect(() => applyKnowledgeUpdate(data, "update-1", [])).toThrow();
  });
  it("saves explicit review edits as inert text, with quoted source references", () => {
    const { data } = fixture();
    const next = applyKnowledgeUpdate(data, "update-1", [
      { changeId: "c1", text: "<img src=x onerror=alert(1)>\n\n我的理解 & 补充" },
    ]);
    expect(next.notes[0].content).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(next.notes[0].content).not.toContain("<img");
    expect(next.notes[0].content).toContain("<p>我的理解 &amp; 补充 [2]</p>");
  });
  it("rejects invalid selected edits atomically", () => {
    const { data, note, changes } = fixture();
    expect(() =>
      applyKnowledgeUpdate(data, "update-1", [select(changes[0]), { changeId: "c2", text: "" }]),
    ).toThrow();
    expect(data.notes[0]).toBe(note);
  });
  it.each(["delete", "version", "body", "section", "move"])("blocks stale source %s", (kind) => {
    const { data, job } = fixture();
    const source = data.sources[0];
    if (kind === "delete") source.deletedAt = new Date().toISOString();
    if (kind === "version") source.versionId = "replacement";
    if (kind === "body") source.text = "Different body, old chunks retained";
    if (kind === "section") source.chunks[0].section = "changed";
    if (kind === "move") source.spaceIds = [];
    expect(knowledgeUpdateReviewReason(data, job)).not.toBe("");
  });
  it("allows reviewing already obtained evidence with AI off but not new generation", () => {
    const { data, job, request } = fixture();
    data.aiEnabled = false;
    data.sources[0].aiAllowed = false;
    expect(knowledgeUpdateReviewReason(data, job)).toBe("");
    expect(knowledgeUpdateTargetReason(data, request)).toContain("不允许 AI");
  });
});

describe("manual edits win and history retains evidence", () => {
  it.each(["content", "title", "space", "status", "deleted", "citations"])(
    "detects manual %s changes",
    (kind) => {
      const { data, job, note } = fixture();
      const patch =
        kind === "content"
          ? { content: "<p>人工改写</p>" }
          : kind === "title"
            ? { title: "新标题" }
            : kind === "space"
              ? { spaceId: "other" }
              : kind === "status"
                ? { status: "draft" as const }
                : kind === "deleted"
                  ? { deletedAt: new Date().toISOString() }
                  : { citations: [] };
      data.notes[0] = reviseNote(note, patch);
      expect(knowledgeUpdateReviewReason(data, job)).not.toBe("");
    },
  );
  it("detects ABA edits even with a frozen clock", () => {
    const { data, note, job } = fixture();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(note.updatedAt));
    const edit = reviseNote(note, { content: "<p>temporary</p>" });
    data.notes[0] = reviseNote(edit, { content: note.content });
    expect(data.notes[0].updatedAt).toBe(note.updatedAt);
    expect(knowledgeNoteKey(data.notes[0])).not.toBe(knowledgeNoteKey(note));
    expect(knowledgeUpdateReviewReason(data, job)).not.toBe("");
  });
  it("does not invalidate on unchanged editor events or another page edit", () => {
    const { data, job, note } = fixture();
    data.notes[0] = reviseNote(note, { content: note.content });
    expect(data.notes[0]).toBe(note);
    data.notes.push({ ...note, id: "another", content: "changed" });
    expect(knowledgeUpdateReviewReason(data, job)).toBe("");
  });
  it("protects manual edits made after a first partial accept", () => {
    const { data, changes } = fixture();
    const first = applyKnowledgeUpdate(data, "update-1", [select(changes[0])]);
    first.notes[0] = reviseNote(first.notes[0], { title: "手工标题" });
    expect(() => applyKnowledgeUpdate(first, "update-1", [select(changes[1])])).toThrow(/修改/);
    expect(first.notes[0].title).toBe("手工标题");
  });
  it("restores pre-merge content, source snapshot and status while keeping the new content in history", () => {
    const { data, changes, note } = fixture();
    const next = applyKnowledgeUpdate(data, "update-1", [select(changes[0])]);
    const restored = restoreNoteVersion(next.notes[0], next.notes[0].versions[0].id);
    expect(restored.content).toBe(note.content);
    expect(restored.citations).toEqual(note.citations);
    expect(restored.aiGenerated).toBe(false);
    expect(restored.status).toBe(note.status);
    expect(restored.versions.at(-1)?.content).toBe(next.notes[0].content);
    expect(restored.contentRevision).toBe(4);
  });
  it("restoring legacy history does not attach current evidence as historical evidence", () => {
    const { note } = fixture();
    note.versions.push({
      id: "legacy",
      title: "Old",
      content: "<p>旧正文</p>",
      savedAt: note.updatedAt,
    });
    const restored = restoreNoteVersion(note, "legacy");
    expect(restored.citations).toEqual([]);
    expect(restored.status).toBe("draft");
  });
  it("accepting an AI draft advances revision and snapshots its original status", () => {
    const { data, note } = fixture();
    note.status = "draft";
    note.aiGenerated = true;
    const next = acceptKnowledgePage(data, note.id).notes[0];
    expect(next.contentRevision).toBe(3);
    expect(next.versions.at(-1)?.status).toBe("draft");
    expect(next.versions.at(-1)?.citations).toEqual(note.citations);
  });
  it("rejects stale request bases and over-limit targets explicitly", () => {
    const { data, request, note } = fixture();
    expect(knowledgeUpdateTargetReason(data, request)).toBe("");
    expect(
      knowledgeUpdateTargetReason(data, {
        ...request,
        targetNote: { ...request.targetNote!, revision: 1 },
      }),
    ).toContain("修改");
    note.content = "<p>x</p>".repeat(101);
    expect(knowledgeUpdateTargetReason(data, request)).toContain("容量");
  });
});
