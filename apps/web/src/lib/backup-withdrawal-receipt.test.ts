import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createDemoWorkspace, createEmptyWorkspace } from "./seed";
import { applyKnowledgeUpdate, snapshotKnowledgeNote } from "./knowledge-update";
import { reviseNote } from "./note-versions";
import { prepareBackupRestore, mergeBackupRestore } from "./backup-restore";
import { buildWorkspaceArchiveResult } from "./export";
import { readWorkspaceBackup } from "./backup-archive";
import { prepareWorkspaceExport } from "./export-scope";
import { workspaceSchema } from "./supabase/validation";
import type { PreparedBackup } from "./backup-types";
import type { OrganizationJob } from "./organization-types";
import type { Note } from "./types";

function fixture(): PreparedBackup {
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
  const note: Note = {
    id: "receipt-note",
    spaceId: data.spaces[0].id,
    title: "模型更新撤回历史",
    content: '<p data-human="keep">人工正文一。</p>\n<p>人工正文二。</p>',
    kind: "knowledge",
    status: "accepted",
    aiGenerated: false,
    contentRevision: 1,
    citations: [citation],
    versions: [],
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    deletedAt: null,
  };
  data.notes = [note];
  const job: OrganizationJob = {
    id: "receipt-job",
    request: {
      requestId: "receipt-job",
      kind: "update",
      trigger: "manual",
      spaceId: note.spaceId,
      sourceIds: [source.id],
      sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
      targetNote: { id: note.id, revision: 1, updatedAt: note.updatedAt },
    },
    status: "ready",
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    result: {
      kind: "update",
      mode: "model",
      target: snapshotKnowledgeNote(note),
      changes: [
        {
          id: "restored-a",
          type: "insert_after",
          blockId: "b1",
          before: '<p data-human="keep">人工正文一。</p>',
          after: "AI 插入 A。",
          reason: "补充。",
          citations: [citation],
        },
        {
          id: "kept-b",
          type: "insert_after",
          blockId: "start",
          before: "",
          after: "AI 插入 B。",
          reason: "补充。",
          citations: [citation],
        },
        {
          id: "pending-c",
          type: "remove",
          blockId: "b2",
          before: "<p>人工正文二。</p>",
          after: "",
          reason: "建议。",
          citations: [citation],
        },
      ],
      coverage: "所选资料片段。",
    },
  };
  data.organizationJobs = [job];
  const next = applyKnowledgeUpdate(data, job.id, [
    { changeId: "restored-a", text: "AI 插入 A。" },
    { changeId: "kept-b", text: "AI 插入 B。" },
  ]);
  const review = next.organizationJobs![0].updateReview!;
  const restoredNote = reviseNote(
    next.notes[0],
    { content: `<p>AI 插入 B。 [1]</p>${note.content}` },
    "always",
  );
  next.notes = [restoredNote];
  next.organizationJobs![0].updateReview = {
    ...review,
    withdrawal: {
      id: "receipt-operation",
      at: restoredNote.updatedAt,
      noteRevision: restoredNote.contentRevision!,
      fingerprint: "d".repeat(64),
      restoredChangeIds: ["restored-a"],
      keptChangeIds: ["kept-b"],
    },
  };
  return { data: next, fingerprint: "b".repeat(64), originals: [], missingOriginals: [] };
}

describe("withdrawal receipts in export and backup restore", () => {
  it("preserves receipt identity and historical bodies in whole/space export projections", () => {
    const { data } = fixture();
    const review = data.organizationJobs![0].updateReview!;
    for (const scope of [undefined, { kind: "space" as const, spaceId: data.spaces[0].id }]) {
      const snapshot = prepareWorkspaceExport(data, scope).data;
      expect(snapshot.organizationJobs![0].updateReview).toEqual(review);
      expect(snapshot.notes[0].versions).toEqual(data.notes[0].versions);
      expect(workspaceSchema.safeParse(snapshot).success).toBe(true);
    }
    expect(Object.keys(review.withdrawal!).sort()).toEqual(
      ["id", "at", "noteRevision", "fingerprint", "restoredChangeIds", "keptChangeIds"].sort(),
    );
    expect(JSON.stringify(review.withdrawal)).not.toMatch(/人工正文|AI 插入/);
  });

  it("remaps receipt/change identities consistently while preserving historical digest/revisions", () => {
    const backup = fixture();
    const before = structuredClone(backup.data);
    const originalJob = backup.data.organizationJobs![0];
    const originalReceipt = originalJob.updateReview!.withdrawal!;
    const plan = prepareBackupRestore(backup);
    const job = plan.data.organizationJobs![0];
    const receipt = job.updateReview?.withdrawal;
    expect(receipt).toBeDefined();
    expect(receipt!.id).not.toBe(originalReceipt.id);
    expect(receipt).toMatchObject({
      at: originalReceipt.at,
      noteRevision: originalReceipt.noteRevision,
      fingerprint: originalReceipt.fingerprint,
    });
    if (job.result?.kind !== "update") throw new Error("restored job must retain update result");
    expect(receipt!.restoredChangeIds).toEqual([job.result.changes[0].id]);
    expect(receipt!.keptChangeIds).toEqual([job.result.changes[1].id]);
    expect(job.updateReview!.applied.map((item) => item.changeId)).toEqual([
      ...receipt!.restoredChangeIds,
      ...receipt!.keptChangeIds,
    ]);
    expect(job.updateReview!.note.id).toBe(plan.data.notes[0].id);
    expect(job.updateReview!.note.revision).toBe(originalJob.updateReview!.note.revision);
    expect(job.updateReview!.note.content).toBe(originalJob.updateReview!.note.content);
    expect(plan.data.notes[0].versions.map((version) => version.content)).toEqual(
      backup.data.notes[0].versions.map((version) => version.content),
    );
    expect(workspaceSchema.safeParse(plan.data).success).toBe(true);
    const merged = mergeBackupRestore(createEmptyWorkspace(), plan);
    const remainingChangeId = job.result.changes[2].id;
    expect(merged.organizationJobs![0].updateReview?.withdrawal).toEqual(receipt);
    expect(() =>
      applyKnowledgeUpdate(merged, job.id, [{ changeId: remainingChangeId, text: "" }]),
    ).toThrow(/撤回/);
    expect(mergeBackupRestore(merged, plan)).toBe(merged);
    expect(backup.data).toEqual(before);
  });

  it("exports and reopens a real ZIP with a persistent receipt and intact note histories", async () => {
    const { data } = fixture();
    const archive = await buildWorkspaceArchiveResult(data);
    const zip = await JSZip.loadAsync(archive.bytes);
    const raw = JSON.parse(await zip.file("workspace.json")!.async("string"));
    expect(raw.organizationJobs[0].updateReview.withdrawal).toEqual(
      data.organizationJobs![0].updateReview!.withdrawal,
    );
    const reopened = await readWorkspaceBackup(
      new Blob([new Uint8Array(archive.bytes)], { type: "application/zip" }),
    );
    expect(reopened.data.organizationJobs![0].updateReview).toEqual(
      data.organizationJobs![0].updateReview,
    );
    expect(reopened.data.notes[0].versions).toEqual(data.notes[0].versions);
    const restored = prepareBackupRestore(reopened).data;
    expect(restored.organizationJobs![0].updateReview?.withdrawal).toBeDefined();
    expect(workspaceSchema.safeParse(restored).success).toBe(true);
  });
});
