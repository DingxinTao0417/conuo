import { describe, expect, it, vi, afterEach } from "vitest";
import { createDemoWorkspace } from "./seed";
import { snapshotKnowledgeNote } from "./knowledge-update";
import { reviseNote } from "./note-versions";
import { conceptRelationSchema, relationDraftSchema } from "./concept-relation-schema";
import {
  acceptRelationProposal,
  ignoreRelationProposal,
  saveConceptRelation,
  deleteConceptRelation,
  restoreConceptRelation,
  relationAvailabilityReason,
  relationReviewReason,
  relationTargetsReason,
  validateRelationProposals,
} from "./concept-relations";
import { organizationRequestSchema } from "./organization-schema";
import { MAX_WORKSPACE_BYTES, workspaceSchema, assertWorkspaceOwner } from "./supabase/validation";
import type { Citation, Note } from "./types";
import type { RelationDraft, RelationInput } from "./concept-relation-types";
import type { OrganizationJob } from "./organization-types";

function fixture() {
  const data = createDemoWorkspace();
  const citations: Citation[] = data.sources.map((s) => {
    const c = s.chunks.find((c) => c.text.length > 50)!;
    return {
      sourceId: s.id,
      versionId: s.versionId,
      chunkId: c.id,
      title: s.title,
      quote: c.text,
      page: c.page,
      section: c.section,
    };
  });
  const now = new Date().toISOString();
  const notes: Note[] = citations.map((citation, index) => ({
    id: `note-${index}`,
    spaceId: data.spaces[0].id,
    title: index ? "自我解释" : "学习率",
    content: `<p>我记录的内容 ${index}</p>`,
    kind: "knowledge",
    status: "accepted",
    citations: [citation],
    versions: [],
    contentRevision: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  }));
  data.notes = notes;
  const draft: RelationDraft = {
    type: "related",
    fromClaim: "学习率控制步长。",
    toClaim: "可以用自己的话解释步长。",
    fromCondition: "",
    toCondition: "",
    explanation: "可以用自我解释检查概念理解。",
    fromCitations: [citations[0]],
    toCitations: [citations[1]],
  };
  const input: RelationInput = { ...draft, fromNoteId: notes[0].id, toNoteId: notes[1].id };
  const job: OrganizationJob = {
    id: "relations-request",
    createdAt: now,
    updatedAt: now,
    status: "ready",
    request: {
      requestId: "relations-request",
      kind: "relations",
      trigger: "manual",
      spaceId: notes[0].spaceId,
      sourceIds: data.sources.map((s) => s.id),
      sourceVersions: data.sources.map((s) => ({ sourceId: s.id, versionId: s.versionId })),
      targetNote: { id: notes[0].id, revision: 1, updatedAt: now },
      compareNote: { id: notes[1].id, revision: 1, updatedAt: now },
    },
    result: {
      kind: "relations",
      mode: "model",
      target: snapshotKnowledgeNote(notes[0]),
      compare: snapshotKnowledgeNote(notes[1]),
      relations: [{ ...draft, id: "r1" }],
      coverage: "仅依据测试资料的有限片段。",
    },
  };
  data.organizationJobs = [job];
  return { data, notes, citations, draft, input, job };
}
afterEach(() => vi.useRealTimers());

describe("relation contracts and claims", () => {
  it("keeps legacy workspaces valid and requires two distinct page baselines only for relations", () => {
    const { data, job } = fixture();
    expect(workspaceSchema.safeParse(createDemoWorkspace()).success).toBe(true);
    expect(organizationRequestSchema.safeParse(job.request).success).toBe(true);
    expect(
      organizationRequestSchema.safeParse({ ...job.request, compareNote: undefined }).success,
    ).toBe(false);
    expect(
      organizationRequestSchema.safeParse({ ...job.request, compareNote: job.request.targetNote })
        .success,
    ).toBe(false);
    expect(
      organizationRequestSchema.safeParse({ ...job.request, trigger: "automatic" }).success,
    ).toBe(false);
    expect(() => saveConceptRelation(data, fixture().input)).toThrow("依据");
  });
  it("stores manual relations with independently preserved claims, conditions and source references", () => {
    const { data, input, notes, draft } = fixture();
    const next = saveConceptRelation(data, input);
    expect(next.conceptRelations?.[0]).toMatchObject(draft);
    expect(next.conceptRelations?.[0].from).toEqual(snapshotKnowledgeNote(notes[0]));
    expect(next.conceptRelations?.[0].to).toEqual(snapshotKnowledgeNote(notes[1]));
    expect(next.notes).toBe(data.notes);
    expect(workspaceSchema.safeParse(next).success).toBe(true);
  });
  it("requires original evidence for manual records but keeps uncited AI suggestions explicitly AI-origin", () => {
    const { data, input, job, draft } = fixture();
    expect(() =>
      saveConceptRelation(data, { ...input, fromCitations: [], toCitations: [] }),
    ).toThrow("至少需要");
    if (job.result?.kind !== "relations") throw new Error();
    job.result.relations = [{ ...draft, id: "r1", fromCitations: [], toCitations: [] }];
    const next = acceptRelationProposal(data, job.id, "r1");
    expect(next.conceptRelations?.[0]).toMatchObject({
      origin: "ai",
      fromCitations: [],
      toCitations: [],
    });
    expect(conceptRelationSchema.safeParse(next.conceptRelations?.[0]).success).toBe(true);
  });
  it("requires two distinct statements, conditions and exclusive chunks for conflict", () => {
    const { draft, citations } = fixture();
    const conflict = {
      ...draft,
      type: "conflict" as const,
      fromCondition: "小步长",
      toCondition: "大步长",
    };
    expect(relationDraftSchema.safeParse(conflict).success).toBe(true);
    for (const change of [
      { fromCondition: "" },
      { toClaim: conflict.fromClaim },
      { toCitations: [] },
      { toCitations: [citations[0]] },
      { toCitations: citations },
    ])
      expect(relationDraftSchema.safeParse({ ...conflict, ...change }).success).toBe(false);
  });
  it("allows no proposed relation without fabricating an edge and rejects duplicate types", () => {
    const { job } = fixture();
    if (job.result?.kind !== "relations") throw new Error();
    const { target, compare, relations } = job.result;
    expect(validateRelationProposals(target, compare, [])).toBe(true);
    expect(
      validateRelationProposals(target, compare, [...relations, { ...relations[0], id: "r2" }]),
    ).toBe(false);
    expect(validateRelationProposals(target, target, relations)).toBe(false);
  });
  it("rejects oversized UTF8 page baselines before asking for model generation", () => {
    const { data, job } = fixture();
    data.notes.forEach((note) => {
      note.content = "<p>" + "学".repeat(19_900) + "</p>";
      note.title = "学".repeat(500);
    });
    expect(relationTargetsReason(data, job.request)).toContain("120 KiB");
  });
});

describe("relation scope, review and provenance", () => {
  it("accepts one proposal, links its saved ID and prevents duplicate accept or ignore", () => {
    const { data, job, notes } = fixture();
    expect(relationReviewReason(data, job)).toBe("");
    const next = acceptRelationProposal(data, job.id, "r1");
    expect(next.conceptRelations).toHaveLength(1);
    expect(next.organizationJobs?.[0].savedRelations).toEqual([
      { proposalId: "r1", relationId: next.conceptRelations![0].id },
    ]);
    expect(next.notes).toEqual(notes);
    expect(() => acceptRelationProposal(next, job.id, "r1")).toThrow("已经处理");
    expect(() => ignoreRelationProposal(next, job.id, "r1")).toThrow("已接受");
  });
  it("ignores without changing any page or creating a relation", () => {
    const { data, job } = fixture();
    const next = ignoreRelationProposal(data, job.id, "r1");
    expect(next.notes).toBe(data.notes);
    expect(next.conceptRelations).toBeUndefined();
    expect(next.organizationJobs?.[0].ignoredRelations).toEqual(["r1"]);
    expect(() => acceptRelationProposal(next, job.id, "r1")).toThrow("已经处理");
  });
  it("preserves AI provenance when the user edits an accepted relation", () => {
    const { data, job, input } = fixture();
    const one = acceptRelationProposal(data, job.id, "r1");
    const relation = one.conceptRelations![0];
    const next = saveConceptRelation(
      one,
      { ...input, explanation: "我重新核对后的关系说明。" },
      { id: relation.id, revision: relation.revision },
    );
    expect(next.conceptRelations![0]).toMatchObject({
      origin: "ai",
      jobId: job.id,
      proposalId: "r1",
      revision: 1,
      explanation: "我重新核对后的关系说明。",
    });
  });
  it.each([0, 1])("invalidates suggested and existing relations when page %i changes", (index) => {
    const { data, job, input } = fixture();
    const next = saveConceptRelation(data, input);
    next.notes = next.notes.map((n, i) =>
      i === index ? reviseNote(n, { content: n.content + "<p>人工追加。</p>" }) : n,
    );
    expect(relationReviewReason(next, job)).toContain("已被修改");
    expect(relationAvailabilityReason(next, next.conceptRelations![0])).toContain("页面已变化");
    expect(() => acceptRelationProposal(next, job.id, "r1")).toThrow("已被修改");
  });
  it("guards against edit-and-restore with a frozen device clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));
    const { data, job } = fixture();
    const old = data.notes[1].content;
    data.notes[1] = reviseNote(reviseNote(data.notes[1], { content: "changed" }), { content: old });
    expect(relationReviewReason(data, job)).toContain("已被修改");
  });
  it.each(["version", "deleted", "moved", "text"])(
    "rejects unavailable source evidence: %s",
    (change) => {
      const { data, job, input } = fixture();
      const next = saveConceptRelation(data, input);
      const source = next.sources[0];
      if (change === "version") source.versionId = "new-version";
      if (change === "deleted") source.deletedAt = new Date().toISOString();
      if (change === "moved") source.spaceIds = [];
      if (change === "text") source.text = "现在是另一份正文。";
      expect(relationReviewReason(next, job)).not.toBe("");
      expect(relationAvailabilityReason(next, next.conceptRelations![0])).not.toBe("");
      expect(() => saveConceptRelation(next, input)).toThrow("依据");
    },
  );
  it("blocks cross-space endpoints and self-relations", () => {
    const { data, input } = fixture();
    expect(() => saveConceptRelation(data, { ...input, toNoteId: input.fromNoteId })).toThrow(
      "不同",
    );
    data.notes[1].spaceId = "inbox";
    expect(() => saveConceptRelation(data, input)).toThrow("同一");
  });
  it("keeps read/review available with AI off but prevents fresh transmission of inherited disabled evidence", () => {
    const { data, job, input } = fixture();
    const next = saveConceptRelation(data, input);
    next.aiEnabled = false;
    next.sources[0].aiAllowed = false;
    expect(relationReviewReason(next, job)).toBe("");
    expect(relationAvailabilityReason(next, next.conceptRelations![0])).toBe("");
    expect(relationTargetsReason(next, job.request)).toContain("不允许 AI");
  });
  it("marks uncited AI relations stale when inherited page evidence changes, including after restore", () => {
    const { data, job } = fixture();
    if (job.result?.kind !== "relations") throw new Error();
    job.result.relations[0].fromCitations = [];
    job.result.relations[0].toCitations = [];
    const next = acceptRelationProposal(data, job.id, "r1");
    const r = next.conceptRelations![0];
    next.sources[1].versionId = "replaced-source";
    expect(relationAvailabilityReason(next, r)).toContain("原文依据");
    const restored = restoreConceptRelation(deleteConceptRelation(next, r.id, 0), r.id, 1);
    expect(relationAvailabilityReason(restored, restored.conceptRelations![0])).toContain(
      "原文依据",
    );
  });
  it("does not allow an edited proposal to invent an unrelated quotation", () => {
    const { data, job, draft, citations } = fixture();
    const other = data.sources[0].chunks.find((c) => c.id !== citations[0].chunkId)!;
    const changed = {
      ...citations[0],
      chunkId: other.id,
      quote: other.text,
      section: other.section,
      page: other.page,
    };
    expect(() =>
      acceptRelationProposal(data, job.id, "r1", { ...draft, fromCitations: [changed] }),
    ).toThrow("不属于本次");
  });
});

describe("relation editing, deletion and storage boundaries", () => {
  it("deduplicates symmetric relations but preserves prerequisite direction", () => {
    const { data, input } = fixture();
    const next = saveConceptRelation(data, input);
    expect(() =>
      saveConceptRelation(next, {
        ...input,
        fromNoteId: input.toNoteId,
        toNoteId: input.fromNoteId,
      }),
    ).toThrow("同类型");
    const directed = saveConceptRelation(data, { ...input, type: "prerequisite" });
    expect(
      saveConceptRelation(directed, {
        ...input,
        type: "prerequisite",
        fromNoteId: input.toNoteId,
        toNoteId: input.fromNoteId,
      }).conceptRelations,
    ).toHaveLength(2);
  });
  it("uses optimistic revisions for edits and recoverable deletion without touching notes", () => {
    const { data, input } = fixture();
    const saved = saveConceptRelation(data, input);
    const r = saved.conceptRelations![0];
    const removed = deleteConceptRelation(saved, r.id, 0);
    expect(removed.conceptRelations![0].deletedAt).toBeTruthy();
    expect(removed.notes).toBe(saved.notes);
    expect(() => saveConceptRelation(removed, input, { id: r.id, revision: 0 })).toThrow(
      "其他操作",
    );
    const restored = restoreConceptRelation(removed, r.id, 1);
    expect(restored.conceptRelations![0]).toMatchObject({ deletedAt: null, revision: 2 });
    expect(relationAvailabilityReason(restored, restored.conceptRelations![0])).toBe("");
    expect(() => deleteConceptRelation(restored, r.id, 0)).toThrow("其他操作");
  });
  it("allows explicit rechecking against current pages and preserves an old relation while stale", () => {
    const { data, input } = fixture();
    const saved = saveConceptRelation(data, input);
    const r = saved.conceptRelations![0];
    saved.notes[1] = reviseNote(saved.notes[1], { content: "<p>新理解</p>" });
    const next = saveConceptRelation(
      saved,
      { ...input, toClaim: "新理解" },
      { id: r.id, revision: 0 },
    );
    expect(relationAvailabilityReason(next, next.conceptRelations![0])).toBe("");
    expect(r.to.content).not.toBe(next.conceptRelations![0].to.content);
  });
  it("rejects duplicate relation IDs at the authenticated storage boundary", () => {
    const { data, input } = fixture();
    const next = saveConceptRelation(data, input);
    next.conceptRelations!.push(next.conceptRelations![0]);
    expect(() => assertWorkspaceOwner(next, "test-user")).toThrow("重复标识");
  });
  it("rejects oversized snapshots and total workspace capacity atomically", () => {
    const { data, input } = fixture();
    data.notes[0].content = "x".repeat(200001);
    expect(() => saveConceptRelation(data, input)).toThrow();
    expect(data.conceptRelations).toBeUndefined();
    data.notes[0].content = "small";
    const size = new TextEncoder().encode(JSON.stringify(data)).byteLength;
    data.sources[0].text += "x".repeat(MAX_WORKSPACE_BYTES - size - 100);
    expect(() => saveConceptRelation(data, input)).toThrow("3 MiB");
    expect(data.conceptRelations).toBeUndefined();
  });
});
