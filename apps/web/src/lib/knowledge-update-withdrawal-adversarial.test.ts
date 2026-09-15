import { describe, expect, it } from "vitest";
import { createDemoWorkspace } from "./seed";
import { applyKnowledgeUpdate, knowledgeBlocks, snapshotKnowledgeNote } from "./knowledge-update";
import { reviseNote } from "./note-versions";
import {
  previewKnowledgeUpdateWithdrawal,
  prepareKnowledgeUpdateWithdrawal,
  commitKnowledgeUpdateWithdrawal,
  type KnowledgeUpdateWithdrawalSelection,
} from "./knowledge-update-withdrawal";
import type { Citation, Note, WorkspaceData } from "./types";
import type { KnowledgeChange } from "./knowledge-update-types";

const jobId = "adversarial-job";
function fixture(
  content: string,
  patches: { block: number; after: string; type?: KnowledgeChange["type"]; citation?: number }[],
) {
  const data = createDemoWorkspace();
  const citations: Citation[] = data.sources.slice(0, 2).map((source) => {
    const chunk = source.chunks[0];
    return {
      sourceId: source.id,
      versionId: source.versionId,
      chunkId: chunk.id,
      title: source.title,
      quote: chunk.text,
      section: chunk.section,
      page: chunk.page,
    };
  });
  const note: Note = {
    id: "adversarial-note",
    spaceId: data.spaces[0].id,
    title: "独立编辑保护样例",
    content,
    kind: "knowledge",
    status: "accepted",
    aiGenerated: false,
    contentRevision: 1,
    citations,
    versions: [],
    createdAt: data.sources[0].createdAt,
    updatedAt: data.sources[0].updatedAt,
    deletedAt: null,
  };
  const blocks = knowledgeBlocks(content);
  const changes: KnowledgeChange[] = patches.map((patch, i) => ({
    id: `change-${i + 1}`,
    type: patch.type ?? "replace",
    blockId: blocks[patch.block].id,
    before: blocks[patch.block].html,
    after: patch.after,
    reason: "依据资料更新",
    citations: [citations[patch.citation ?? 0]],
  }));
  data.notes = [note];
  data.organizationJobs = [
    {
      id: jobId,
      status: "ready",
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      request: {
        requestId: jobId,
        kind: "update",
        trigger: "manual",
        spaceId: note.spaceId,
        sourceIds: data.sources.map((source) => source.id),
        sourceVersions: data.sources.map((source) => ({
          sourceId: source.id,
          versionId: source.versionId,
        })),
        targetNote: { id: note.id, revision: 1, updatedAt: note.updatedAt },
      },
      result: {
        kind: "update",
        mode: "model",
        target: snapshotKnowledgeNote(note),
        changes,
        coverage: "所选资料",
      },
    },
  ];
  const applied = applyKnowledgeUpdate(
    data,
    jobId,
    changes.map((change) => ({ changeId: change.id, text: change.after })),
  );
  return { applied, note, changes };
}
function edit(data: WorkspaceData, content: string, citations?: Citation[]): WorkspaceData {
  return {
    ...data,
    notes: [reviseNote(data.notes[0], { content, ...(citations ? { citations } : {}) }, "always")],
  };
}
async function commit(data: WorkspaceData, selections: KnowledgeUpdateWithdrawalSelection[] = []) {
  const plan = await previewKnowledgeUpdateWithdrawal(data, jobId);
  const prepared = await prepareKnowledgeUpdateWithdrawal(
    data,
    jobId,
    plan.fingerprint,
    selections,
  );
  return commitKnowledgeUpdateWithdrawal(data, prepared);
}

describe("independent applied-update withdrawal adversarial editing", () => {
  it("can withdraw after the user independently moved the page to inbox without reverting its location or title", async () => {
    const { applied, note } = fixture("<p>原本说明。</p>", [{ block: 0, after: "模型新说明。" }]);
    const current = {
      ...applied,
      notes: [
        reviseNote(applied.notes[0], { spaceId: "inbox", title: "我移动后的标题" }, "always"),
      ],
    };
    const next = await commit(current);
    expect(next.notes[0].content).toBe(note.content);
    expect(next.notes[0].spaceId).toBe("inbox");
    expect(next.notes[0].title).toBe("我移动后的标题");
    expect(next.notes[0].versions.at(-1)?.spaceId).toBe("inbox");
  });

  it("does not auto-delete a newly copied AI-looking block after the original AI block was deleted", async () => {
    const { applied } = fixture("<p>左边唯一锚点。</p><p>右边唯一锚点。</p>", [
      { block: 0, type: "insert_after", after: "模型补充的整段说明。" },
    ]);
    const added = knowledgeBlocks(applied.notes[0].content)[1].html;
    const content =
      applied.notes[0].content.replace(added, "") + "<p>我后来建立的独立区域。</p>" + added;
    const current = edit(applied, content);
    const plan = await previewKnowledgeUpdateWithdrawal(current, jobId);
    expect(plan.changes[0].kind).toBe("conflict");
    await expect(
      prepareKnowledgeUpdateWithdrawal(current, jobId, plan.fingerprint, []),
    ).rejects.toThrow(/选择|位置|合并/);
    const next = await commit(current, [{ changeId: "change-1", action: "keep" }]);
    expect(next.notes[0].content).toBe(content);
    expect(next.notes[0].versions.at(-1)?.content).toBe(content);
  });

  it("requires an explicit repeated position and modifies only the chosen copy", async () => {
    const { applied } = fixture("<p>左边唯一锚点。</p><p>右边唯一锚点。</p>", [
      { block: 0, type: "insert_after", after: "相同整段说明。" },
    ]);
    const added = knowledgeBlocks(applied.notes[0].content)[1].html;
    const content = applied.notes[0].content + "<p>独立副本区域。</p>" + added;
    const current = edit(applied, content),
      plan = await previewKnowledgeUpdateWithdrawal(current, jobId);
    expect(plan.conflictCount).toBe(1);
    expect(plan.changes[0].candidates).toHaveLength(2);
    const selected = plan.changes[0].candidates.find(
      (candidate) => candidate.start === content.lastIndexOf(added),
    )!;
    expect(selected).toBeDefined();
    const next = await commit(current, [
      { changeId: "change-1", action: "restore", candidateId: selected.id },
    ]);
    expect(next.notes[0].content).toBe(content.slice(0, content.lastIndexOf(added)));
    expect(next.notes[0].content).toContain(added + "<p>右边唯一锚点。</p>");
  });

  it("does not treat a copied block as the original merely because one neighboring boundary still matches", async () => {
    const { applied } = fixture("<p>左边唯一锚点。</p><p>右边唯一锚点。</p>", [
      { block: 0, type: "insert_after", after: "模型补充的整段说明。" },
    ]);
    const added = knowledgeBlocks(applied.notes[0].content)[1].html;
    const removed = edit(applied, applied.notes[0].content.replace(added, ""));
    const content = removed.notes[0].content.replace(
      "<p>右边唯一锚点。</p>",
      "<p>我在这里新建的独立区域。</p>" + added + "<p>右边唯一锚点。</p>",
    );
    const current = edit(removed, content);
    expect(current.notes[0].versions.at(-1)?.content).not.toContain(added);
    const plan = await previewKnowledgeUpdateWithdrawal(current, jobId);
    expect(plan.changes[0].kind).toBe("conflict");
    await expect(
      prepareKnowledgeUpdateWithdrawal(current, jobId, plan.fingerprint, []),
    ).rejects.toThrow(/选择|位置|合并/);
    const next = await commit(current, [{ changeId: "change-1", action: "keep" }]);
    expect(next.notes[0].content).toBe(content);
  });

  it("does not ignore recorded deletion and original-position rebuilding when the current HTML equals the applied snapshot", async () => {
    const { applied } = fixture("<p>左边唯一锚点。</p><p>右边唯一锚点。</p>", [
      { block: 0, type: "insert_after", after: "模型补充的整段说明。" },
    ]);
    const added = knowledgeBlocks(applied.notes[0].content)[1].html;
    const removed = edit(applied, applied.notes[0].content.replace(added, ""));
    const current = edit(removed, applied.notes[0].content);
    expect(current.notes[0].content).toBe(applied.notes[0].content);
    expect(current.notes[0].contentRevision).toBe(applied.notes[0].contentRevision! + 2);
    expect(current.notes[0].versions.at(-1)).toMatchObject({
      content: removed.notes[0].content,
      contentRevision: applied.notes[0].contentRevision! + 1,
    });
    expect(current.notes[0].versions.at(-1)?.content).not.toContain(added);
    const plan = await previewKnowledgeUpdateWithdrawal(current, jobId);
    expect(plan.changes[0].kind).toBe("conflict");
    await expect(
      prepareKnowledgeUpdateWithdrawal(current, jobId, plan.fingerprint, []),
    ).rejects.toThrow(/选择|位置|合并/);
    const next = await commit(current, [{ changeId: "change-1", action: "keep" }]);
    expect(next.notes[0].content).toBe(current.notes[0].content);
    expect(next.notes[0].versions.at(-1)?.content).toBe(current.notes[0].content);
  });

  it("combines adjacent inverse changes sharing a mapped range while retaining separate later edits", async () => {
    const { applied } = fixture("<p>甲旧词。保留甲说明。</p><p>乙旧词。保留乙说明。</p>", [
      { block: 0, after: "甲新词。保留甲说明。" },
      { block: 1, after: "乙新词。保留乙说明。" },
    ]);
    const current = edit(
      applied,
      applied.notes[0].content
        .replace("保留甲说明。", "我扩写甲说明🙂。")
        .replace("保留乙说明。", "我扩写乙说明🙂。"),
    );
    const plan = await previewKnowledgeUpdateWithdrawal(current, jobId);
    expect(plan.safeCount).toBe(2);
    const next = await commit(current);
    expect(next.notes[0].content).toBe(
      "<p>甲旧词。我扩写甲说明🙂。</p><p>乙旧词。我扩写乙说明🙂。</p>",
    );
    expect(next.notes[0].versions.at(-1)?.content).toBe(current.notes[0].content);
    expect(next.organizationJobs![0].updateReview?.withdrawal?.restoredChangeIds).toEqual([
      "change-1",
      "change-2",
    ]);
  });

  it("keeps appended paragraphs, internal links, comments, entities and Unicode bytes outside the reversed change", async () => {
    const initial =
      '<p>原结论🙂 &amp; 说明。</p><!--个人注释--><p data-user="retain">用户原来的第二段。</p>';
    const { applied } = fixture(initial, [{ block: 0, after: "新结论🙂 & 说明。" }]);
    const independent =
      '<p data-user="retain">用户原来的第二段。<a title="比较 > 小于" href="#note/my-note?x=1&amp;y=2">我的链接🧑‍🎓 &amp; 引用</a></p><p>我追加的段落：&#x1F642; &lt;测试&gt;。</p>';
    const current = edit(
      applied,
      applied.notes[0].content.replace('<p data-user="retain">用户原来的第二段。</p>', independent),
    );
    const next = await commit(current);
    expect(next.notes[0].content).toBe("<p>原结论🙂 &amp; 说明。</p><!--个人注释-->" + independent);
    expect(next.notes[0].versions.at(-1)?.content).toBe(current.notes[0].content);
  });

  it("retains current reordered citation numbering in independent paragraphs and remaps restored markers", async () => {
    const { applied } = fixture("<p>原始甲结论 [1]</p><p>独立乙依据 [2]</p>", [
      { block: 0, after: "AI改写甲结论", citation: 0 },
    ]);
    const reordered = [...applied.notes[0].citations].reverse();
    const content =
      applied.notes[0].content.replace(/\[(1|2)\]/g, (_, number: string) =>
        number === "1" ? "[2]" : "[1]",
      ) + "<p>我追加的乙来源判断 [1]</p>";
    const current = edit(applied, content, reordered),
      plan = await previewKnowledgeUpdateWithdrawal(current, jobId);
    const row = plan.changes[0];
    expect(row.candidates).toHaveLength(1);
    expect(row.candidates[0].canRestore).toBe(true);
    const next = await commit(current, [
      { changeId: row.id, action: "restore", candidateId: row.candidates[0].id },
    ]);
    expect(next.notes[0].content).toBe(
      "<p>原始甲结论 [2]</p><p>独立乙依据 [1]</p><p>我追加的乙来源判断 [1]</p>",
    );
    expect(next.notes[0].citations).toEqual(reordered);
    expect(next.notes[0].versions.at(-1)?.citations).toEqual(reordered);
  });

  it("does not silently omit the last manual candidate when a large current page exceeds the candidate limit", async () => {
    const { applied } = fixture("<p>原本短解释。</p>", [{ block: 0, after: "模型短解释。" }]);
    const paragraphs = Array.from(
      { length: 30 },
      (_, i) => `<p>独立区域${i}：${"长".repeat(900)}</p>`,
    );
    const content = paragraphs.join("");
    const current = edit(applied, content),
      plan = await previewKnowledgeUpdateWithdrawal(current, jobId),
      row = plan.changes[0];
    expect(row.kind).toBe("conflict");
    const last = knowledgeBlocks(content).at(-1)!;
    const includesLast = row.candidates.some(
      (candidate) => candidate.start === last.start && candidate.end === last.end,
    );
    if (!includesLast)
      expect(row.reason).toMatch(/候选.*(?:上限|超过|过多|仅|截断)|只.*24|前.*24|缩小.*范围/);
    await expect(
      prepareKnowledgeUpdateWithdrawal(current, jobId, plan.fingerprint, []),
    ).rejects.toThrow(/选择|合并/);
    const next = await commit(current, [{ changeId: row.id, action: "keep" }]);
    expect(next.notes[0].content).toBe(content);
  });
});
