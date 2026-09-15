import { describe, expect, it, vi } from "vitest";
import { chunkText } from "./import";
import {
  appendExcerptToKnowledgePage,
  createKnowledgePageFromExcerpt,
  EXCERPT_TO_KNOWLEDGE_LIMITS,
  type ExcerptToKnowledgeFailureReason,
  type ExcerptToKnowledgeResult,
} from "./excerpt-to-knowledge";
import { reviseNote } from "./note-versions";
import { resolveCitation } from "./retrieval";
import { createDemoWorkspace } from "./seed";
import { workspaceSchema } from "./supabase/validation";
import type { Chunk, Note, Source, WorkspaceData } from "./types";

const now = "2026-09-13T12:00:00.000Z";
const selection =
  "学习率是更新参数时的步长系数。参数更新可以写为：新参数 = 旧参数 − 学习率 × 梯度。";

function manualKnowledgePage(data: WorkspaceData, patch: Partial<Note> = {}): Note {
  return {
    id: "manual-knowledge-page",
    spaceId: data.spaces[0]!.id,
    title: "我的学习理解",
    content: "<p>这是我已有的学习理解。</p>",
    kind: "knowledge",
    aiGenerated: false,
    contentRevision: 4,
    status: "accepted",
    citations: [],
    versions: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...patch,
  };
}

function fixture() {
  const data = createDemoWorkspace();
  const note = manualKnowledgePage(data);
  data.notes = [note];
  const source = data.sources[0]!;
  return { data, note, source };
}

function input(source: Source, data: WorkspaceData, patch: Record<string, unknown> = {}) {
  return {
    spaceId: data.spaces[0]!.id,
    sourceId: source.id,
    versionId: source.versionId,
    selection,
    ...patch,
  };
}

function success(result: ExcerptToKnowledgeResult) {
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return result;
}

function chunk(id: string, source: Source, text: string, order: number): Chunk {
  return {
    id,
    sourceId: source.id,
    versionId: source.versionId,
    text,
    section: `第 ${order + 1} 段`,
    order,
  };
}

describe("manual excerpt to knowledge page", () => {
  it("creates a manual draft with an exact current-chunk citation and escaped selection", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    try {
      const { data, source } = fixture();
      const quote = "<script>不执行</script> 学习率是更新参数时的步长系数。";
      source.text = `${source.text}\n\n${quote}`;
      source.chunks = chunkText(source.text, source.id, source.versionId);
      const random = vi
        .spyOn(crypto, "randomUUID")
        .mockReturnValue("11111111-1111-4111-8111-111111111111");

      const result = success(
        createKnowledgePageFromExcerpt(data, input(source, data, { selection: quote })),
      );
      const saved = result.note;

      expect(result.data.notes[0]).toBe(saved);
      expect(saved).toMatchObject({
        id: "11111111-1111-4111-8111-111111111111",
        kind: "knowledge",
        title: "未命名知识页",
        aiGenerated: false,
        status: "draft",
        contentRevision: 0,
      });
      expect(saved.content).toContain("<h2>原文摘录</h2>");
      expect(saved.content).toContain("&lt;script&gt;不执行&lt;/script&gt;");
      expect(saved.content).not.toContain("<script>不执行</script>");
      expect(saved.content).toContain("人工摘录 · 原文依据：[1]");
      expect(saved.content).not.toContain("conuo-excerpt:");
      expect(saved.citations).toEqual([result.citation]);
      expect(saved.manualExcerptRefs).toEqual([
        expect.objectContaining({
          sourceId: source.id,
          versionId: source.versionId,
          chunkId: result.citation.chunkId,
          selectionFingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
        }),
      ]);
      expect(source.chunks.some((item) => item.text === result.citation.quote)).toBe(true);
      expect(resolveCitation(result.data, result.citation)).toMatchObject({ source });
      expect(workspaceSchema.safeParse(result.data).success).toBe(true);
      expect(data.notes).toHaveLength(1);
      random.mockRestore();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("appends to an AI-assisted page without relabelling it, while preserving its old page version", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    try {
      const { data, note, source } = fixture();
      note.aiGenerated = true;
      const result = success(
        appendExcerptToKnowledgePage(data, {
          noteId: note.id,
          ...input(source, data),
        }),
      );
      const saved = result.note;

      expect(saved.content).toContain(note.content);
      expect(saved.status).toBe("draft");
      expect(saved.aiGenerated).toBe(true);
      expect(saved.versions).toHaveLength(1);
      expect(saved.versions[0]).toMatchObject({
        content: note.content,
        status: "accepted",
        aiGenerated: true,
        contentRevision: 4,
      });
      expect(resolveCitation(result.data, result.citation)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("deduplicates from versioned metadata after an ordinary editor revision", () => {
    const { data, note, source } = fixture();
    note.aiGenerated = undefined;
    const first = success(
      appendExcerptToKnowledgePage(data, { noteId: note.id, ...input(source, data) }),
    );
    const editorSavedNote = reviseNote(
      first.note,
      { content: `${first.note.content}<p>编辑后补充的理解。</p>` },
      "always",
    );
    const editorSavedData: WorkspaceData = {
      ...first.data,
      notes: first.data.notes.map((item) => (item.id === note.id ? editorSavedNote : item)),
    };
    const second = success(
      appendExcerptToKnowledgePage(editorSavedData, {
        noteId: note.id,
        ...input(source, editorSavedData, {
          selection:
            "学习率是更新参数时的步长系数。\n 参数更新可以写为：新参数 = 旧参数 − 学习率 × 梯度。",
        }),
      }),
    );

    expect(first.appended).toBe(true);
    expect(second.appended).toBe(false);
    expect(second.data).toBe(editorSavedData);
    expect(second.note).toBe(editorSavedNote);
    expect(second.note.content).toContain("编辑后补充的理解。");
    expect(second.note.aiGenerated).toBeUndefined();
    expect(second.note.citations).toHaveLength(1);
    expect(second.note.manualExcerptRefs).toHaveLength(1);
    expect(second.note.versions).toHaveLength(editorSavedNote.versions.length);
  });

  it("anchors identical PDF wording to the selected page and rejects ambiguous or forged anchors", () => {
    const repeated = "这是 PDF 中每页都会出现的重复句子。";
    const { data, note, source } = fixture();
    source.kind = "pdf";
    source.text = `${repeated}\n\n${repeated}`;
    source.chunks = [
      { ...chunk("pdf-page-one", source, repeated, 0), page: 1, section: "第 1 页" },
      { ...chunk("pdf-page-two", source, repeated, 1), page: 2, section: "第 2 页" },
    ];

    const anchored = success(
      appendExcerptToKnowledgePage(data, {
        noteId: note.id,
        ...input(source, data, {
          selection: repeated,
          anchorChunkId: "pdf-page-two",
          anchorPage: 2,
        }),
      }),
    );
    expect(anchored.citation).toMatchObject({
      chunkId: "pdf-page-two",
      page: 2,
      section: "第 2 页",
    });
    expect(anchored.note.manualExcerptRefs).toEqual([
      expect.objectContaining({ chunkId: "pdf-page-two" }),
    ]);
    expect(resolveCitation(anchored.data, anchored.citation)).toBeTruthy();

    const ambiguous = appendExcerptToKnowledgePage(data, {
      noteId: note.id,
      ...input(source, data, { selection: repeated }),
    });
    expect(ambiguous).toMatchObject({ ok: false, reason: "selection-ambiguous" });

    const forged = appendExcerptToKnowledgePage(data, {
      noteId: note.id,
      ...input(source, data, {
        selection: repeated,
        anchorChunkId: "pdf-page-one",
        anchorPage: 2,
      }),
    });
    expect(forged).toMatchObject({ ok: false, reason: "selection-anchor-invalid" });
  });

  it("rejects a cross-chunk selection instead of storing a citation that cannot resolve", () => {
    const { data, source } = fixture();
    const first = "第一段含有连续的开头。";
    const second = "第二段继续同一段摘录。";
    source.text = `${first}\n\n${second}`;
    source.chunks = [
      chunk("chunk-first", source, first, 0),
      chunk("chunk-second", source, second, 1),
    ];

    const result = appendExcerptToKnowledgePage(data, {
      noteId: data.notes[0]!.id,
      ...input(source, data, { selection: `${first}\n\n${second}` }),
    });

    expect(result).toMatchObject({ ok: false, reason: "selection-cross-chunk" });
    expect(data.notes[0]!.content).toBe("<p>这是我已有的学习理解。</p>");
  });

  const invalidCases: {
    name: string;
    reason: ExcerptToKnowledgeFailureReason;
    mutate: (data: WorkspaceData) => void;
    patch?: Record<string, unknown>;
  }[] = [
    {
      name: "deleted source",
      reason: "source-deleted",
      mutate: (data) => {
        data.sources[0]!.deletedAt = now;
      },
    },
    {
      name: "changed source version",
      reason: "source-version-changed",
      mutate: (data) => {
        data.sources[0]!.versionId = "new-current-version";
      },
    },
    {
      name: "source removed from active space",
      reason: "source-outside-space",
      mutate: (data) => {
        data.sources[0]!.spaceIds = [];
      },
    },
    {
      name: "archived active space",
      reason: "space-unavailable",
      mutate: (data) => {
        data.spaces[0]!.archived = true;
      },
    },
    {
      name: "removed target page",
      reason: "target-unavailable",
      mutate: (data) => {
        data.notes[0]!.deletedAt = now;
      },
    },
    {
      name: "other-space target page",
      reason: "target-outside-space",
      mutate: (data) => {
        data.notes[0]!.spaceId = "other-space";
      },
    },
    {
      name: "fabricated selection",
      reason: "selection-not-in-source",
      mutate: () => {},
      patch: { selection: "资料里从未出现的伪造句子。" },
    },
  ];

  it.each(invalidCases)("rejects $name atomically", ({ reason, mutate, patch }) => {
    const { data, note, source } = fixture();
    const content = note.content;
    const citations = structuredClone(note.citations);
    const request = { noteId: note.id, ...input(source, data, patch) };
    mutate(data);

    const result = appendExcerptToKnowledgePage(data, request);

    expect(result).toMatchObject({ ok: false, reason });
    expect(note.content).toBe(content);
    expect(note.citations).toEqual(citations);
  });

  it("rejects empty, oversized and unanchorable selections before creating a page", () => {
    const { data, source } = fixture();
    const empty = createKnowledgePageFromExcerpt(data, input(source, data, { selection: " \n " }));
    expect(empty).toMatchObject({ ok: false, reason: "selection-empty" });

    const oversized = createKnowledgePageFromExcerpt(
      data,
      input(source, data, {
        selection: "学".repeat(EXCERPT_TO_KNOWLEDGE_LIMITS.selectionCharacters + 1),
      }),
    );
    expect(oversized).toMatchObject({ ok: false, reason: "selection-too-long" });

    const noChunks = structuredClone(data);
    noChunks.sources[0]!.chunks = [];
    const unanchorable = createKnowledgePageFromExcerpt(
      noChunks,
      input(noChunks.sources[0]!, noChunks),
    );
    expect(unanchorable).toMatchObject({ ok: false, reason: "source-not-anchorable" });
    expect(noChunks.notes).toHaveLength(data.notes.length);
  });
});
