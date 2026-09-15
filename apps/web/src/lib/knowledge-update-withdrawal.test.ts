import { describe, expect, it } from "vitest";
import { createDemoWorkspace } from "./seed";
import { applyKnowledgeUpdate, knowledgeBlocks, snapshotKnowledgeNote } from "./knowledge-update";
import { reviseNote } from "./note-versions";
import { MAX_WORKSPACE_BYTES, workspaceSchema } from "./supabase/validation";
import {
  previewKnowledgeUpdateWithdrawal,
  prepareKnowledgeUpdateWithdrawal,
  commitKnowledgeUpdateWithdrawal,
  withdrawKnowledgeUpdate,
} from "./knowledge-update-withdrawal";
import type { Note, WorkspaceData } from "./types";
import type { KnowledgeChange } from "./knowledge-update-types";

function fixture(
  content = "<p>学习率是步长。我的笔记需要保留。</p><p>后续的独立例子。</p>",
  updates?: Partial<KnowledgeChange>[],
) {
  const data = createDemoWorkspace();
  const source = data.sources[0];
  const chunk = source.chunks[0];
  const citation = {
    sourceId: source.id,
    versionId: source.versionId,
    chunkId: chunk.id,
    title: source.title,
    quote: chunk.text,
    section: chunk.section,
    page: chunk.page,
  };
  const note: Note = {
    id: "withdraw-note",
    spaceId: data.spaces[0].id,
    title: "学习笔记",
    content,
    citations: [citation],
    kind: "knowledge",
    status: "accepted",
    aiGenerated: false,
    contentRevision: 2,
    versions: [],
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    deletedAt: null,
  };
  data.notes = [note];
  const blocks = knowledgeBlocks(content);
  const changes: KnowledgeChange[] = (
    updates ?? [{ after: "学习率是步幅。我的笔记需要保留。" }]
  ).map((patch, i) => ({
    id: `change-${i + 1}`,
    type: "replace",
    blockId: blocks[i].id,
    before: blocks[i].html,
    after: "新的解释",
    reason: "资料补充",
    citations: [citation],
    ...patch,
  }));
  data.organizationJobs = [
    {
      id: "withdraw-job",
      status: "ready",
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      request: {
        requestId: "withdraw-job",
        kind: "update",
        trigger: "manual",
        spaceId: note.spaceId,
        sourceIds: data.sources.map((s) => s.id),
        sourceVersions: data.sources.map((s) => ({ sourceId: s.id, versionId: s.versionId })),
        targetNote: { id: note.id, revision: 2, updatedAt: note.updatedAt },
      },
      result: {
        kind: "update",
        mode: "model",
        target: snapshotKnowledgeNote(note),
        changes,
        coverage: "所选资料片段。",
      },
    },
  ];
  return {
    data,
    note,
    changes,
    applied: applyKnowledgeUpdate(
      data,
      "withdraw-job",
      changes.map((c) => ({ changeId: c.id, text: c.after })),
    ),
  };
}
function edit(data: WorkspaceData, content: string): WorkspaceData {
  return { ...data, notes: [reviseNote(data.notes[0], { content }, "always")] };
}

describe("safe local withdrawal of an actually applied knowledge update", () => {
  it("restores only the AI change, retaining later independent blocks and saving the entire current version", async () => {
    const { applied, note } = fixture();
    const current = edit(
      applied,
      applied.notes[0].content.replace("后续的独立例子。", "我后来写的独立例子。"),
    );
    const plan = await previewKnowledgeUpdateWithdrawal(current, "withdraw-job");
    expect(plan).toMatchObject({ safeCount: 1, conflictCount: 0 });
    const next = await withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, []);
    expect(next.notes[0].content).toBe(
      note.content.replace("后续的独立例子。", "我后来写的独立例子。"),
    );
    expect(next.notes[0].versions.at(-1)).toMatchObject({
      content: current.notes[0].content,
      citations: current.notes[0].citations,
      contentRevision: current.notes[0].contentRevision,
    });
    expect(next.organizationJobs![0].updateReview?.note).toEqual(
      applied.organizationJobs![0].updateReview?.note,
    );
    expect(next.organizationJobs![0].updateReview?.withdrawal).toMatchObject({
      restoredChangeIds: ["change-1"],
      keptChangeIds: [],
      noteRevision: next.notes[0].contentRevision,
    });
    expect(workspaceSchema.safeParse(next)).toMatchObject({ success: true });
    expect(current.notes[0].content).toContain("步幅");
  });
  it("retains edits to a different sentence in the same paragraph and insertions at both boundaries", async () => {
    const { applied } = fixture();
    const current = edit(
      applied,
      applied.notes[0].content
        .replace("<p>学习率", "<p>前缀🙂学习率")
        .replace("我的笔记需要保留。", "我的独立手写说明已扩展。后缀。"),
    );
    const plan = await previewKnowledgeUpdateWithdrawal(current, "withdraw-job");
    expect(plan.safeCount).toBe(1);
    const next = await withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, []);
    expect(next.notes[0].content).toBe(
      "<p>前缀🙂学习率是步长。我的独立手写说明已扩展。后缀。</p><p>后续的独立例子。</p>",
    );
  });
  it("requires an explicit decision for overlapping edits and escapes a chosen local merge", async () => {
    const { applied } = fixture();
    const current = edit(applied, applied.notes[0].content.replace("步幅", "我独立改写的值"));
    const plan = await previewKnowledgeUpdateWithdrawal(current, "withdraw-job");
    expect(plan.conflictCount).toBe(1);
    await expect(
      withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, []),
    ).rejects.toThrow(/选择|合并/);
    const row = plan.changes[0];
    const next = await withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, [
      {
        changeId: row.id,
        action: "restore",
        candidateId: row.candidates[0].id,
        text: "合并 <script>alert(1)</script> & 🙂",
      },
    ]);
    expect(next.notes[0].content).toContain(
      "<p>合并 &lt;script&gt;alert(1)&lt;/script&gt; &amp; 🙂</p>",
    );
    expect(next.notes[0].content).toContain("<p>后续的独立例子。</p>");
    expect(next.notes[0].content).not.toContain("<script>");
  });
  it("all keep still creates a new version and closes the update without a fake content edit", async () => {
    const { applied } = fixture();
    const plan = await previewKnowledgeUpdateWithdrawal(applied, "withdraw-job");
    const next = await withdrawKnowledgeUpdate(applied, "withdraw-job", plan.fingerprint, [
      { changeId: "change-1", action: "keep" },
    ]);
    expect(next.notes[0].content).toBe(applied.notes[0].content);
    expect(next.notes[0].status).toBe(applied.notes[0].status);
    expect(next.notes[0].contentRevision).toBe(applied.notes[0].contentRevision! + 1);
    expect(next.notes[0].versions.at(-1)?.content).toBe(applied.notes[0].content);
    expect(next.organizationJobs![0].updateReview?.withdrawal?.keptChangeIds).toEqual(["change-1"]);
    await expect(previewKnowledgeUpdateWithdrawal(next, "withdraw-job")).rejects.toThrow(
      /撤回|封存/,
    );
  });
  it("rejects a prepared commit after history/manual reference/target metadata drift, without mutating either snapshot", async () => {
    const { applied } = fixture();
    const plan = await previewKnowledgeUpdateWithdrawal(applied, "withdraw-job");
    const prepared = await prepareKnowledgeUpdateWithdrawal(
      applied,
      "withdraw-job",
      plan.fingerprint,
      [],
    );
    const drift = structuredClone(applied);
    drift.notes[0].versions[0].title = "历史内容已变化";
    expect(() => commitKnowledgeUpdateWithdrawal(drift, prepared)).toThrow(/变化|重新/);
    const refs = { ...applied, notes: [{ ...applied.notes[0], manualExcerptRefs: [] }] };
    expect(() => commitKnowledgeUpdateWithdrawal(refs, prepared)).toThrow(/变化|重新/);
    const jobDrift = structuredClone(applied);
    jobDrift.organizationJobs![0].request.trigger = "automatic";
    expect(() => commitKnowledgeUpdateWithdrawal(jobDrift, prepared)).toThrow(/变化|重新/);
    expect(applied.organizationJobs![0].updateReview?.withdrawal).toBeUndefined();
  });
  it("can correct historical AI content without reauthorizing unavailable sources, and preflights the whole new history", async () => {
    const { applied } = fixture();
    const denied = {
      ...applied,
      sources: applied.sources.map((s) => ({ ...s, aiAllowed: false })),
    };
    const plan = await previewKnowledgeUpdateWithdrawal(denied, "withdraw-job");
    expect(
      (await withdrawKnowledgeUpdate(denied, "withdraw-job", plan.fingerprint, [])).notes[0]
        .content,
    ).toContain("步长");
    const tooBig = {
      ...denied,
      notes: [{ ...denied.notes[0], title: "x".repeat(MAX_WORKSPACE_BYTES) }],
    };
    const capacityPlan = await previewKnowledgeUpdateWithdrawal(tooBig, "withdraw-job");
    await expect(
      withdrawKnowledgeUpdate(tooBig, "withdraw-job", capacityPlan.fingerprint, []),
    ).rejects.toThrow(/容量/);
    expect(tooBig.organizationJobs![0].updateReview?.withdrawal).toBeUndefined();
  });
  it("locates a moved unique applied paragraph instead of using the old bN ordinal", async () => {
    const { applied, note } = fixture("<h2>标题</h2><p>原始内容。</p><p>最后保留。</p>", [
      { blockId: "b2", before: "<p>原始内容。</p>", after: "AI 新内容。" },
    ]);
    const ai = knowledgeBlocks(applied.notes[0].content)[1].html;
    const current = edit(applied, `<p>最后保留。</p><h2>标题</h2>${ai}<p>移动后另写。</p>`);
    const plan = await previewKnowledgeUpdateWithdrawal(current, "withdraw-job");
    expect(plan.conflictCount).toBe(1);
    const next = await withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, [
      { changeId: "change-1", action: "restore", candidateId: plan.changes[0].candidates[0].id },
    ]);
    expect(next.notes[0].content).toBe(
      "<p>最后保留。</p><h2>标题</h2><p>原始内容。</p><p>移动后另写。</p>",
    );
    expect(next.notes[0].content).not.toBe(note.content);
  });
  it("requires a location for duplicate applied paragraphs and changes only the chosen occurrence", async () => {
    const { applied } = fixture();
    const ai = knowledgeBlocks(applied.notes[0].content)[0].html;
    const current = edit(applied, `<h2>我新增的标题</h2>${ai}<p>中间手写。</p>${ai}`);
    const plan = await previewKnowledgeUpdateWithdrawal(current, "withdraw-job");
    expect(plan.conflictCount).toBe(1);
    expect(plan.changes[0].candidates).toHaveLength(2);
    await expect(
      withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, [
        { changeId: "change-1", action: "restore" },
      ]),
    ).rejects.toThrow(/位置/);
    const next = await withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, [
      { changeId: "change-1", action: "restore", candidateId: plan.changes[0].candidates[1].id },
    ]);
    expect(next.notes[0].content).toBe(
      `<h2>我新增的标题</h2>${ai}<p>中间手写。</p><p>学习率是步长。我的笔记需要保留。</p>`,
    );
  });
  it("does not guess that the sole remaining duplicate is the removed original occurrence", async () => {
    const { applied } = fixture("<p>旧一。</p><p>旧二。</p>", [
      { after: "相同的 AI 文字。" },
      { after: "相同的 AI 文字。" },
    ]);
    const ai = knowledgeBlocks(applied.notes[0].content)[0].html;
    const current = edit(applied, `<h2>标题</h2>${ai}`);
    const plan = await previewKnowledgeUpdateWithdrawal(current, "withdraw-job");
    expect(plan.changes.every((row) => row.kind === "conflict")).toBe(true);
    const next = await withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, [
      { changeId: "change-1", action: "keep" },
      { changeId: "change-2", action: "restore", candidateId: plan.changes[1].candidates[0].id },
    ]);
    expect(next.notes[0].content).toBe("<h2>标题</h2><p>旧二。</p>");
  });
  it("reconstructs cumulative partial accepts with edited review text and withdraws multiple blocks", async () => {
    const { data, changes } = fixture("<p>旧一。</p><p>旧二。</p><p>手写末段。</p>", [
      { after: "AI 一。" },
      { after: "AI 二。" },
    ]);
    const first = applyKnowledgeUpdate(data, "withdraw-job", [
      { changeId: changes[1].id, text: "用户审核二。" },
    ]);
    const applied = applyKnowledgeUpdate(first, "withdraw-job", [
      { changeId: changes[0].id, text: "用户审核一。" },
    ]);
    const current = edit(applied, applied.notes[0].content.replace("手写末段。", "后来手写末段。"));
    const plan = await previewKnowledgeUpdateWithdrawal(current, "withdraw-job");
    expect(plan.changes.map((row) => row.appliedHtml)).toEqual([
      "<p>用户审核一。 [1]</p>",
      "<p>用户审核二。 [1]</p>",
    ]);
    const next = await withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, []);
    expect(next.notes[0].content).toBe("<p>旧一。</p><p>旧二。</p><p>后来手写末段。</p>");
    expect(next.organizationJobs![0].updateReview?.withdrawal?.restoredChangeIds).toEqual([
      "change-1",
      "change-2",
    ]);
  });
  it("combines local inverse patches when both adjacent AI blocks were subsequently edited", async () => {
    const { applied } = fixture(
      "<h2>首锚</h2><p>甲值是原值。我的甲注释。</p><p>乙值是旧值。我的乙注释。</p><h2>尾锚</h2>",
      [
        {
          blockId: "b2",
          before: "<p>甲值是原值。我的甲注释。</p>",
          after: "甲值是新值。我的甲注释。",
        },
        {
          blockId: "b3",
          before: "<p>乙值是旧值。我的乙注释。</p>",
          after: "乙值是另值。我的乙注释。",
        },
      ],
    );
    const current = edit(
      applied,
      applied.notes[0].content
        .replace("我的甲注释。", "甲的独立后注释。")
        .replace("我的乙注释。", "乙的独立后注释。"),
    );
    const plan = await previewKnowledgeUpdateWithdrawal(current, "withdraw-job");
    expect(plan.safeCount).toBe(2);
    const next = await withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, []);
    expect(next.notes[0].content).toBe(
      "<h2>首锚</h2><p>甲值是原值。甲的独立后注释。</p><p>乙值是旧值。乙的独立后注释。</p><h2>尾锚</h2>",
    );
  });
  it("can withdraw job one after job two independently revised another sentence in the same paragraph", async () => {
    const { applied } = fixture();
    const second = structuredClone(applied);
    const job = second.organizationJobs![0],
      target = second.notes[0];
    job.id = "job-two";
    job.request = {
      ...job.request,
      requestId: job.id,
      targetNote: { id: target.id, revision: target.contentRevision!, updatedAt: target.updatedAt },
    };
    job.updateReview = undefined;
    job.result = {
      kind: "update",
      mode: "model",
      target: snapshotKnowledgeNote(target),
      changes: [
        {
          id: "second-change",
          type: "replace",
          blockId: "b1",
          before: knowledgeBlocks(target.content)[0].html,
          after: "学习率是步幅。后来模型补充的独立例子。",
          reason: "补充",
          citations: target.citations,
        },
      ],
      coverage: "当前片段",
    };
    second.organizationJobs = [...applied.organizationJobs!, job];
    const current = applyKnowledgeUpdate(second, "job-two", [
      { changeId: "second-change", text: "学习率是步幅。后来模型补充的独立例子。" },
    ]);
    const plan = await previewKnowledgeUpdateWithdrawal(current, "withdraw-job");
    expect(plan.safeCount).toBe(1);
    const next = await withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, []);
    expect(next.notes[0].content).toBe(
      "<p>学习率是步长。后来模型补充的独立例子。</p><p>后续的独立例子。</p>",
    );
    expect(next.organizationJobs![1]).toEqual(current.organizationJobs![1]);
  });
  it.each(["start", "b2"])(
    "removes an AI insertion at %s and retains user paragraphs at both page boundaries",
    async (blockId) => {
      const { applied, note } = fixture("<p>首段。</p><p>末段。</p>", [
        {
          type: "insert_after",
          blockId,
          before: blockId === "start" ? "" : "<p>末段。</p>",
          after: "AI 插入。",
        },
      ]);
      const current = edit(
        applied,
        `<p>用户最前插入。</p>${applied.notes[0].content}<p>用户最后插入。</p>`,
      );
      const plan = await previewKnowledgeUpdateWithdrawal(current, "withdraw-job");
      expect(
        (
          await withdrawKnowledgeUpdate(
            current,
            "withdraw-job",
            plan.fingerprint,
            plan.changes[0].kind === "safe"
              ? []
              : [
                  {
                    changeId: "change-1",
                    action: "restore",
                    candidateId: plan.changes[0].candidates[0].id,
                  },
                ],
          )
        ).notes[0].content,
      ).toBe(`<p>用户最前插入。</p>${note.content}<p>用户最后插入。</p>`);
    },
  );
  it("restores a removed block without deleting new user text inserted at the same verified gap", async () => {
    const { applied } = fixture("<h2>首锚</h2><p>原来被删。</p><h2>尾锚</h2>", [
      { type: "remove", blockId: "b2", before: "<p>原来被删。</p>", after: "" },
    ]);
    const current = edit(applied, "<h2>首锚</h2><p>用户新插入。</p><h2>尾锚</h2>");
    const plan = await previewKnowledgeUpdateWithdrawal(current, "withdraw-job");
    expect(plan.conflictCount).toBe(1);
    const row = plan.changes[0];
    const next = await withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, [
      { changeId: row.id, action: "restore", candidateId: row.candidates[0].id },
    ]);
    expect(next.notes[0].content).toBe(
      "<h2>首锚</h2><p>用户新插入。</p><p>原来被删。</p><h2>尾锚</h2>",
    );
  });
  it.each(["", "<p>用户写的新段。</p>"])(
    "restores a removed sole block with an explicit local decision (current=%s)",
    async (body) => {
      const { applied } = fixture("<p>原始唯一段。</p>", [{ type: "remove", after: "" }]);
      const current = body ? edit(applied, body) : applied,
        plan = await previewKnowledgeUpdateWithdrawal(current, "withdraw-job"),
        row = plan.changes[0];
      const next = await withdrawKnowledgeUpdate(
        current,
        "withdraw-job",
        plan.fingerprint,
        row.kind === "safe"
          ? []
          : [{ changeId: row.id, action: "restore", candidateId: row.candidates[0].id }],
      );
      expect(next.notes[0].content).toBe(`${body}<p>原始唯一段。</p>`);
    },
  );
  it("can keep a user deletion of the AI-inserted block without resurrecting it", async () => {
    const { applied, note } = fixture("<h2>标题</h2><p>原段。</p>", [
      { type: "insert_after", blockId: "b2", before: "<p>原段。</p>", after: "AI 插入。" },
    ]);
    const current = edit(applied, note.content),
      plan = await previewKnowledgeUpdateWithdrawal(current, "withdraw-job");
    const next = await withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, [
      { changeId: "change-1", action: "keep" },
    ]);
    expect(next.notes[0].content).toBe(note.content);
    expect(next.notes[0].contentRevision).toBe(current.notes[0].contentRevision! + 1);
  });
  it("does not tear entities, inline tags, quoted attributes or emoji when restoring original HTML", async () => {
    const original =
      '<p data-label="a > b [1]">🙂 学习率是<strong>步长</strong> &amp; 速度。我的说明。</p><p>尾段。</p>';
    const { applied } = fixture(original, [{ after: "🙂 学习率是步幅 & 速度。我的说明。" }]);
    const current = edit(applied, applied.notes[0].content.replace("我的说明。", "新的独立说明。"));
    const plan = await previewKnowledgeUpdateWithdrawal(current, "withdraw-job");
    expect(plan.safeCount).toBe(1);
    const next = await withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, []);
    expect(next.notes[0].content).toBe(original.replace("我的说明。", "新的独立说明。"));
  });
  it("requires local manual merge for structural overlaps and preserves the other current blocks", async () => {
    const { applied } = fixture("<h2>首锚</h2><p>原始正文。</p><h2>尾锚</h2><p>外部手写。</p>", [
      { blockId: "b2", before: "<p>原始正文。</p>", after: "AI 改写。" },
    ]);
    const current = edit(
      applied,
      applied.notes[0].content.replace(
        "<p>AI 改写。 [1]</p>",
        "<table><tbody><tr><td>用户完全重写表格。</td></tr></tbody></table>",
      ),
    );
    const plan = await previewKnowledgeUpdateWithdrawal(current, "withdraw-job"),
      row = plan.changes[0];
    expect(row.kind).toBe("conflict");
    expect(row.candidates[0].canRestore).toBe(false);
    await expect(
      withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, [
        { changeId: row.id, action: "restore" },
      ]),
    ).rejects.toThrow(/手工/);
    const next = await withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, [
      {
        changeId: row.id,
        action: "restore",
        candidateId: row.candidates[0].id,
        text: "原始正文与用户表格合并。",
      },
    ]);
    expect(next.notes[0].content).toBe(
      "<h2>首锚</h2><p>原始正文与用户表格合并。</p><h2>尾锚</h2><p>外部手写。</p>",
    );
  });
  it("refuses overlapping manual edits but allows one explicitly merged paragraph with the other change kept", async () => {
    const { applied } = fixture("<h2>首锚</h2><p>旧一。</p><p>旧二。</p><h2>尾锚</h2>", [
      { blockId: "b2", before: "<p>旧一。</p>", after: "AI 一。" },
      { blockId: "b3", before: "<p>旧二。</p>", after: "AI 二。" },
    ]);
    const current = edit(
        applied,
        "<h2>首锚</h2><p>用户将两个 AI 段合并为一个独立段。</p><h2>尾锚</h2>",
      ),
      plan = await previewKnowledgeUpdateWithdrawal(current, "withdraw-job");
    const both = plan.changes.map((row) => ({
      changeId: row.id,
      action: "restore" as const,
      candidateId: row.candidates[0].id,
      text: "合并结果",
    }));
    await expect(
      withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, both),
    ).rejects.toThrow(/重叠/);
    const next = await withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, [
      both[0],
      { changeId: both[1].changeId, action: "keep" },
    ]);
    expect(next.notes[0].content).toBe("<h2>首锚</h2><p>合并结果</p><h2>尾锚</h2>");
  });
  it("keeps current citation numbering and appends a missing historical identity without misdirecting later citations", async () => {
    const { data, changes } = fixture('<p data-number="[1]">原引用 [1]。</p><p>独立说明。</p>', [
      { after: "AI 更新。" },
    ]);
    const source = data.sources[1],
      chunk = source.chunks[0],
      foreign = {
        sourceId: source.id,
        versionId: source.versionId,
        chunkId: chunk.id,
        title: source.title,
        quote: chunk.text,
        section: chunk.section,
        page: chunk.page,
      };
    const applied = applyKnowledgeUpdate(
      data,
      "withdraw-job",
      changes.map((c) => ({ changeId: c.id, text: c.after })),
    );
    const edited = edit(applied, applied.notes[0].content + "<p>独立新依据 [1]。</p>"),
      current = { ...edited, notes: [{ ...edited.notes[0], citations: [foreign] }] };
    const plan = await previewKnowledgeUpdateWithdrawal(current, "withdraw-job"),
      next = await withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, []);
    expect(next.notes[0].content).toBe(
      '<p data-number="[1]">原引用 [2]。</p><p>独立说明。</p><p>独立新依据 [1]。</p>',
    );
    expect(next.notes[0].citations).toEqual([foreign, data.notes[0].citations[0]]);
    expect(next.notes[0].versions.at(-1)?.citations).toEqual([foreign]);
    const keep = await withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, [
      { changeId: "change-1", action: "keep" },
    ]);
    expect(keep.notes[0].citations).toEqual([foreign]);
  });
  it("preserves current manual references although B/A snapshots never captured that field", async () => {
    const { applied } = fixture();
    const source = applied.sources[0],
      chunk = source.chunks[0];
    const reference = {
      selectionFingerprint: "a".repeat(16),
      sourceId: source.id,
      versionId: source.versionId,
      chunkId: chunk.id,
    };
    const current = {
        ...applied,
        notes: [{ ...applied.notes[0], manualExcerptRefs: [reference] }],
      },
      plan = await previewKnowledgeUpdateWithdrawal(current, "withdraw-job"),
      next = await withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, []);
    expect(next.notes[0].manualExcerptRefs).toEqual([reference]);
    expect(next.notes[0].versions.at(-1)?.manualExcerptRefs).toEqual([reference]);
    expect(workspaceSchema.safeParse(next).success).toBe(true);
  });
  it("retains the existing 30-history bound and rejects real UTF8 overflow caused by the new current-body snapshot", async () => {
    const { applied } = fixture(),
      historical = applied.notes[0].versions[0];
    const current = {
        ...applied,
        notes: [
          {
            ...applied.notes[0],
            versions: Array.from({ length: 30 }, (_, i) => ({ ...historical, id: `history-${i}` })),
          },
        ],
      },
      plan = await previewKnowledgeUpdateWithdrawal(current, "withdraw-job");
    const next = await withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, []);
    expect(next.notes[0].versions).toHaveLength(30);
    expect(next.notes[0].versions[0].id).toBe("history-1");
    expect(next.notes[0].versions.at(-1)?.content).toBe(current.notes[0].content);
    const largeBase = edit(applied, applied.notes[0].content + `<p>${"中".repeat(150_000)}</p>`);
    const large = {
      ...largeBase,
      notes: [
        {
          ...largeBase.notes[0],
          versions: Array.from({ length: 5 }, (_, i) => ({
            ...historical,
            id: `large-history-${i}`,
            content: `<p>${"文".repeat(150_000)}</p>`,
          })),
        },
      ],
    };
    expect(workspaceSchema.safeParse(large).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(large)).byteLength).toBeLessThan(
      MAX_WORKSPACE_BYTES,
    );
    const largePlan = await previewKnowledgeUpdateWithdrawal(large, "withdraw-job");
    await expect(
      withdrawKnowledgeUpdate(large, "withdraw-job", largePlan.fingerprint, []),
    ).rejects.toThrow(/容量/);
    expect(large.organizationJobs![0].updateReview?.withdrawal).toBeUndefined();
  });
  it("allows the inbox target even though inbox is not a saved Space", async () => {
    const { applied } = fixture();
    const current = structuredClone(applied);
    current.notes[0].spaceId = "inbox";
    const plan = await previewKnowledgeUpdateWithdrawal(current, "withdraw-job"),
      next = await withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, []);
    expect(next.notes[0].spaceId).toBe("inbox");
    expect(next.notes[0].content).toContain("步长");
  });
  it.each(
    [
      [{ changeId: "change-1", action: "restore", candidateId: "" }],
      [{ changeId: "foreign-change", action: "restore" }],
      [{ changeId: "change-1", action: "keep", text: "silently change kept content" }],
      [
        { changeId: "change-1", action: "restore" },
        { changeId: "change-1", action: "keep" },
      ],
      [{ changeId: "change-1", action: "restore", text: "a".repeat(6001) }],
    ].map((selection) => ({ selection })),
  )(
    "rejects invalid or repeated explicit choices atomically (%j)",
    async ({ selection: invalid }) => {
      const { applied } = fixture(),
        plan = await previewKnowledgeUpdateWithdrawal(applied, "withdraw-job");
      await expect(
        withdrawKnowledgeUpdate(
          applied,
          "withdraw-job",
          plan.fingerprint,
          invalid as Parameters<typeof withdrawKnowledgeUpdate>[3],
        ),
      ).rejects.toThrow(/合规|选择/);
      expect(applied.organizationJobs![0].updateReview?.withdrawal).toBeUndefined();
    },
  );
  it("checks the 200k single-page limit after escaping a legal 6000-character local merge", async () => {
    const { applied } = fixture(),
      current = edit(applied, applied.notes[0].content + `<p>${"x".repeat(179_000)}</p>`),
      plan = await previewKnowledgeUpdateWithdrawal(current, "withdraw-job");
    expect(workspaceSchema.safeParse(current).success).toBe(true);
    await expect(
      withdrawKnowledgeUpdate(current, "withdraw-job", plan.fingerprint, [
        { changeId: "change-1", action: "restore", text: "<".repeat(6000) },
      ]),
    ).rejects.toThrow(/单页容量/);
    expect(current.organizationJobs![0].updateReview?.withdrawal).toBeUndefined();
  });
});
