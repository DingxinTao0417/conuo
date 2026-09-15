import { describe, expect, it } from "vitest";
import { createDemoWorkspace } from "./seed";
import {
  applyKnowledgeUpdate,
  ignoreKnowledgeChange,
  knowledgeUpdateReviewReason,
  snapshotKnowledgeNote,
} from "./knowledge-update";
import { knowledgeUpdateReviewSchema } from "./knowledge-update-schema";
import { organizationJobSchema } from "./organization-schema";
import { workspaceSchema } from "./supabase/validation";
import type { OrganizationJob } from "./organization-types";

function fixture() {
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
  };
  const note = {
    id: "withdraw-note",
    spaceId: data.spaces[0].id,
    title: "学习记录",
    status: "accepted" as const,
    aiGenerated: false,
    content: "<p>原有人工说明。</p>",
    kind: "knowledge" as const,
    citations: [citation],
    contentRevision: 2,
    versions: [],
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    deletedAt: null,
  };
  data.notes = [note];
  const job: OrganizationJob = {
    id: "withdraw-job",
    request: {
      requestId: "withdraw-job",
      kind: "update",
      trigger: "manual",
      spaceId: note.spaceId,
      sourceIds: [source.id],
      sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
      targetNote: { id: note.id, revision: 2, updatedAt: note.updatedAt },
    },
    status: "ready",
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    result: {
      kind: "update",
      mode: "model",
      target: snapshotKnowledgeNote(note),
      changes: [
        {
          id: "applied-a",
          type: "insert_after",
          blockId: "b1",
          before: note.content,
          after: "模型添加的说明。",
          reason: "补充。",
          citations: [citation],
        },
        {
          id: "remaining-b",
          type: "insert_after",
          blockId: "start",
          before: "",
          after: "待审核建议。",
          reason: "补充。",
          citations: [citation],
        },
      ],
      coverage: "所选资料。",
    },
  };
  data.organizationJobs = [job];
  const applied = applyKnowledgeUpdate(data, job.id, [
    { changeId: "applied-a", text: "模型添加的说明。" },
  ]);
  const review = applied.organizationJobs![0].updateReview!;
  const withdrawal = {
    id: "withdraw-receipt",
    at: "2026-09-15T12:00:00.000Z",
    noteRevision: review.note.revision + 1,
    fingerprint: "a".repeat(64),
    restoredChangeIds: ["applied-a"],
    keptChangeIds: [] as string[],
  };
  const frozenJob = {
    ...applied.organizationJobs![0],
    updateReview: { ...review, withdrawal },
  };
  applied.organizationJobs = [frozenJob];
  return { data: applied, job: frozenJob, review, withdrawal };
}

describe("persistent knowledge-update withdrawal receipt contract", () => {
  it("accepts an identity-only receipt with unreviewed suggestions still in history", () => {
    const { data, job } = fixture();
    expect(knowledgeUpdateReviewSchema.safeParse(job.updateReview).success).toBe(true);
    expect(organizationJobSchema.safeParse(job).success).toBe(true);
    expect(workspaceSchema.safeParse(data).success).toBe(true);
  });

  it("freezes remaining acceptance and ignore even when the historical note still matches", () => {
    const { data, job } = fixture();
    expect(knowledgeUpdateReviewReason(data, job)).toContain("撤回");
    expect(() =>
      applyKnowledgeUpdate(data, job.id, [{ changeId: "remaining-b", text: "待审核建议。" }]),
    ).toThrow(/撤回/);
    expect(() => ignoreKnowledgeChange(data, job.id, "remaining-b")).toThrow(/撤回/);
  });

  it("keeps legacy reviews valid and unsealed", () => {
    const { data, job, review } = fixture();
    data.organizationJobs = [{ ...job, updateReview: review }];
    expect(organizationJobSchema.safeParse(data.organizationJobs[0]).success).toBe(true);
    expect(knowledgeUpdateReviewReason(data, data.organizationJobs[0])).toBe("");
    expect(
      ignoreKnowledgeChange(data, job.id, "remaining-b").organizationJobs![0].updateReview,
    ).toMatchObject({ ignored: ["remaining-b"] });
  });

  it("accepts all-keep closure without replacing the original review snapshot", () => {
    const { job, withdrawal, review } = fixture();
    const next = {
      ...job,
      updateReview: {
        ...review,
        withdrawal: { ...withdrawal, restoredChangeIds: [], keptChangeIds: ["applied-a"] },
      },
    };
    expect(organizationJobSchema.safeParse(next).success).toBe(true);
    expect(next.updateReview.note).toEqual(review.note);
  });

  it.each([
    ["missing identity", { id: "" }],
    ["unknown receipt field", { content: "private body" }],
    ["body-shaped fingerprint", { fingerprint: '{"content":"private body"}' }],
    ["uppercase fingerprint", { fingerprint: "A".repeat(64) }],
    ["invalid date", { at: "yesterday" }],
    ["non-integer revision", { noteRevision: 3.5 }],
    ["prior revision", { noteRevision: 2 }],
    ["unsafe revision", { noteRevision: Number.MAX_SAFE_INTEGER }],
    ["repeated restore", { restoredChangeIds: ["applied-a", "applied-a"] }],
    ["repeated keep", { restoredChangeIds: [], keptChangeIds: ["applied-a", "applied-a"] }],
    ["overlapping partition", { keptChangeIds: ["applied-a"] }],
    ["unknown change", { restoredChangeIds: ["not-a-change"] }],
    ["unapplied change", { keptChangeIds: ["remaining-b"] }],
    ["incomplete partition", { restoredChangeIds: [] }],
  ])("rejects %s", (_, invalid) => {
    const { job, review, withdrawal } = fixture();
    const updateReview = { ...review, withdrawal: { ...withdrawal, ...invalid } };
    expect(knowledgeUpdateReviewSchema.safeParse(updateReview).success).toBe(false);
    expect(organizationJobSchema.safeParse({ ...job, updateReview }).success).toBe(false);
  });

  it("rejects a receipt without any previously applied changes", () => {
    const { job, review, withdrawal } = fixture();
    const updateReview = {
      ...review,
      applied: [],
      withdrawal: { ...withdrawal, restoredChangeIds: [] },
    };
    expect(knowledgeUpdateReviewSchema.safeParse(updateReview).success).toBe(false);
    expect(organizationJobSchema.safeParse({ ...job, updateReview }).success).toBe(false);
  });

  it("rejects a forged applied ID even if the receipt partitions it consistently", () => {
    const { job, review, withdrawal } = fixture();
    const updateReview = {
      ...review,
      applied: [{ changeId: "foreign-id", text: "model text" }],
      withdrawal: { ...withdrawal, restoredChangeIds: ["foreign-id"] },
    };
    expect(knowledgeUpdateReviewSchema.safeParse(updateReview).success).toBe(true);
    expect(organizationJobSchema.safeParse({ ...job, updateReview }).success).toBe(false);
  });

  it("rejects receipts with no update result or an inconsistent base target", () => {
    const { job, review } = fixture();
    expect(organizationJobSchema.safeParse({ ...job, result: undefined }).success).toBe(false);
    expect(
      organizationJobSchema.safeParse({
        ...job,
        updateReview: { ...job.updateReview, note: { ...review.note, id: "other-note" } },
      }).success,
    ).toBe(false);
    if (job.result?.kind !== "update") throw new Error("fixture must be update");
    expect(
      organizationJobSchema.safeParse({
        ...job,
        result: { ...job.result, target: { ...job.result.target, revision: review.note.revision } },
      }).success,
    ).toBe(false);
  });
});
