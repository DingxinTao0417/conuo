import { describe, expect, it } from "vitest";
import { appendAnswerToKnowledgePage, renumberAnswerCitationMarkers } from "./answer-to-knowledge";
import { createDemoWorkspace } from "./seed";
import { workspaceSchema } from "./supabase/validation";
import type { Citation, Note, WorkspaceData } from "./types";

function citation(data: WorkspaceData, index: number): Citation {
  const source = data.sources[0];
  const chunk = source.chunks[index];
  return {
    sourceId: source.id,
    versionId: source.versionId,
    chunkId: chunk.id,
    title: source.title,
    quote: chunk.text,
    section: chunk.section,
    ...(chunk.page ? { page: chunk.page } : {}),
  };
}

function fixture(): { data: WorkspaceData; note: Note; citations: Citation[] } {
  const data = createDemoWorkspace();
  const citations = [citation(data, 0), citation(data, 1)];
  const now = data.sources[0].createdAt;
  const note: Note = {
    id: "knowledge-page",
    spaceId: data.spaces[0].id,
    title: "学习率复盘",
    content: "<h2>已有理解</h2><p>我先记录自己的判断。</p>",
    kind: "knowledge",
    status: "accepted",
    aiGenerated: false,
    citations: [citations[0]],
    versions: [],
    contentRevision: 2,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  data.notes = [note];
  return { data, note, citations };
}

describe("appendAnswerToKnowledgePage", () => {
  it("appends instead of replacing, versions the prior page, and carries forward evidence", () => {
    const { data, note, citations } = fixture();
    const next = appendAnswerToKnowledgePage(data, {
      noteId: note.id,
      spaceId: note.spaceId,
      content: "学习率过大时会振荡。 [1]",
      citations: [citations[1]],
      mode: "model",
    });

    const saved = next.notes[0];
    expect(saved.title).toBe(note.title);
    expect(saved.content).toContain(note.content);
    expect(saved.content).toContain("<h2>资料问答</h2>");
    expect(saved.content).toContain("学习率过大时会振荡。 [2]");
    expect(saved.content).toContain("本段原文依据：[2]");
    expect(saved.citations).toEqual(citations);
    expect(saved.status).toBe("draft");
    expect(saved.aiGenerated).toBe(true);
    expect(saved.contentRevision).toBe(3);
    expect(saved.versions).toHaveLength(1);
    expect(saved.versions[0]).toMatchObject({
      content: note.content,
      citations: [citations[0]],
      status: "accepted",
      aiGenerated: false,
      contentRevision: 2,
    });
    expect(data.notes[0]).toBe(note);
    expect(workspaceSchema.safeParse(next).success).toBe(true);
  });

  it("deduplicates shared citations while preserving an answer's local marker order", () => {
    const { data, note, citations } = fixture();
    const next = appendAnswerToKnowledgePage(data, {
      noteId: note.id,
      spaceId: note.spaceId,
      content: "已有判断 [1]，补充证据 [2]，再次引用 [1]。",
      citations: [citations[0], citations[1], citations[0]],
      mode: "extractive",
    });

    const saved = next.notes[0];
    expect(saved.citations).toEqual(citations);
    expect(saved.content).toContain("已有判断 [1]，补充证据 [2]，再次引用 [1]。");
    expect(saved.content).toContain("本段原文依据：[1] [2] [1]");
    expect(saved.aiGenerated).toBe(false);
    expect(saved.status).toBe("draft");
  });

  it("does not rewrite marker-like text in a link or code sample", () => {
    expect(
      renumberAnswerCitationMarkers(
        '<p>正文 [1]。</p><p><a href="https://example.com">[1]</a></p><pre><code>[1]</code></pre>',
        [9],
      ),
    ).toBe(
      '<p>正文 [9]。</p><p><a href="https://example.com">[1]</a></p><pre><code>[1]</code></pre>',
    );
  });

  it.each(["version", "space", "deleted", "target"])(
    "rejects unavailable target or source evidence: %s",
    (kind) => {
      const { data, note, citations } = fixture();
      const before = structuredClone(data);
      if (kind === "version") data.sources[0].versionId = "new-version";
      if (kind === "space") data.sources[0].spaceIds = [];
      if (kind === "deleted") data.sources[0].deletedAt = data.sources[0].createdAt;
      if (kind === "target") data.notes[0].deletedAt = data.notes[0].createdAt;

      expect(() =>
        appendAnswerToKnowledgePage(data, {
          noteId: note.id,
          spaceId: note.spaceId,
          content: "这条回答有引用。 [1]",
          citations: [citations[1]],
          mode: "model",
        }),
      ).toThrow();
      if (kind === "target") expect(data.notes[0].content).toBe(before.notes[0].content);
    },
  );

  it("rejects unsourced content before changing the target", () => {
    const { data, note } = fixture();
    const before = structuredClone(data);
    expect(() =>
      appendAnswerToKnowledgePage(data, {
        noteId: note.id,
        spaceId: note.spaceId,
        content: "没有依据的结论。",
        citations: [],
        mode: "model",
      }),
    ).toThrow("缺少可核对的原文依据");
    expect(data).toEqual(before);
  });
});
