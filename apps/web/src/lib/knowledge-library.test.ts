import { describe, expect, it } from "vitest";
import type { Citation, Note, Space, WorkspaceData } from "./types";
import {
  knowledgePageAssociatedSourceCount,
  knowledgePageStatusLabel,
  knowledgePageSummary,
  selectKnowledgeLibrary,
} from "./knowledge-library";

const earlier = "2026-09-12T08:00:00.000Z";
const later = "2026-09-14T09:00:00.000Z";

function space(id: string, name: string, archived = false): Space {
  return { id, name, goal: "", color: "#4B3FE3", archived, createdAt: earlier };
}

function citation(sourceId: string, suffix = "1"): Citation {
  return {
    sourceId,
    versionId: `${sourceId}-version`,
    chunkId: `${sourceId}-chunk-${suffix}`,
    title: `资料 ${sourceId}`,
    quote: `关于 ${sourceId} 的原文`,
    section: "正文",
  };
}

function note(id: string, spaceId: string, options: Partial<Note> = {}): Note {
  return {
    id,
    spaceId,
    title: `知识页 ${id}`,
    content: `<p>${id} 的正文</p>`,
    kind: "knowledge",
    aiGenerated: false,
    status: "accepted",
    citations: [],
    versions: [],
    createdAt: earlier,
    updatedAt: earlier,
    deletedAt: null,
    ...options,
  };
}

function workspace(spaces: Space[], notes: Note[]): WorkspaceData {
  return {
    schemaVersion: 1,
    spaces,
    sources: [],
    notes,
    annotations: [],
    conversations: [],
    aiEnabled: true,
  };
}

describe("knowledge library projection", () => {
  it("groups current knowledge pages by space and keeps equal timestamps stable", () => {
    const data = workspace(
      [space("space-a", "机器学习"), space("space-b", "设计")],
      [
        note("equal-first", "space-a", { updatedAt: later }),
        note("other-space", "space-b", { updatedAt: later }),
        note("newest", "space-a", { updatedAt: "2026-09-14T10:00:00.000Z" }),
        note("equal-second", "space-a", { updatedAt: later }),
        note("deleted", "space-a", { deletedAt: later }),
        note("ordinary-note", "space-a", { kind: "note" }),
      ],
    );

    const view = selectKnowledgeLibrary(data);

    expect(view.groups.map((group) => group.name)).toEqual(["机器学习", "设计"]);
    expect(view.groups[0]!.items.map((item) => item.note.id)).toEqual([
      "newest",
      "equal-first",
      "equal-second",
    ]);
    expect(view.groups[1]!.items.map((item) => item.note.id)).toEqual(["other-space"]);
    expect(view.resultCount).toBe(4);
  });

  it("combines scope, normalized search, and status filters while counts follow the query", () => {
    const data = workspace(
      [space("space-a", "机器学习"), space("space-b", "设计")],
      [
        note("ai-draft", "space-a", {
          title: "理解学习率",
          content: "<p>损失震荡</p>",
          status: "draft",
          aiGenerated: true,
        }),
        note("saved", "space-a", {
          title: "梯度下降",
          content: "<p>也讨论了学习率</p>",
        }),
        note("other", "space-b", { title: "学习率设计" }),
      ],
    );

    const pending = selectKnowledgeLibrary(data, {
      spaceId: "space-a",
      query: " 学习率 ",
      filter: "pending",
    });
    const saved = selectKnowledgeLibrary(data, {
      spaceId: "space-a",
      query: "学习率",
      filter: "saved",
    });

    expect(pending.counts).toEqual({ all: 2, pending: 1, saved: 1 });
    expect(pending.groups[0]!.items.map((item) => item.note.id)).toEqual(["ai-draft"]);
    expect(saved.groups[0]!.items.map((item) => item.note.id)).toEqual(["saved"]);
    expect(selectKnowledgeLibrary(data, { query: "不存在" })).toEqual({
      counts: { all: 0, pending: 0, saved: 0 },
      groups: [],
      resultCount: 0,
    });
  });

  it("derives explicit states, unique associated sources, and safe summaries", () => {
    const aiDraft = note("ai", "space-a", {
      status: "draft",
      aiGenerated: true,
      citations: [citation("source-a"), citation("source-a", "2"), citation("source-b")],
      content: "<p>学习率&nbsp;决定步长。</p><script>alert('x')</script><p>继续说明。</p>",
    });
    const manualDraft = note("manual", "space-a", { status: "draft" });
    const saved = note("saved", "space-a");

    expect(knowledgePageStatusLabel(aiDraft)).toBe("AI 草稿");
    expect(knowledgePageStatusLabel(manualDraft)).toBe("人工草稿");
    expect(knowledgePageStatusLabel(saved)).toBe("已保存");
    expect(knowledgePageAssociatedSourceCount(aiDraft)).toBe(2);
    expect(knowledgePageSummary(aiDraft)).toBe("学习率 决定步长。 继续说明。");
    expect(knowledgePageSummary(note("empty", "space-a", { content: "<p> </p>" }))).toBe(
      "还没有正文，开始整理这个主题。",
    );
    expect(knowledgePageSummary(aiDraft, 4)).toBe("学习率…");
  });

  it("keeps archived and missing-space knowledge pages visible in explicit groups", () => {
    const data = workspace(
      [space("archived", "旧课程", true)],
      [note("archived-note", "archived"), note("orphan", "removed-space")],
    );

    const view = selectKnowledgeLibrary(data);

    expect(view.groups).toHaveLength(2);
    expect(view.groups[0]).toMatchObject({ name: "旧课程", space: { archived: true } });
    expect(view.groups[1]).toMatchObject({ id: "removed-space", name: "其他知识页", space: null });
  });
});
