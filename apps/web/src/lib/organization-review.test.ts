import { describe, expect, it } from "vitest";
import { createDemoWorkspace } from "./seed";
import {
  organizationContextKey,
  organizationReviewReason,
  organizationUnavailableReason,
  knowledgeAcceptanceReason,
} from "./organization";
import {
  applyOrganizationTags,
  undoOrganizationTags,
  saveOrganizationPage,
  ignoreOrganizationPage,
  dismissOrganizationJob,
  setSourceTags,
  acceptKnowledgePage,
} from "./organization-review";
import { organizationJobSchema, organizationRequestSchema } from "./organization-schema";
import { workspaceSchema } from "./supabase/validation";
import type { OrganizationJob, OrganizationRequest } from "./organization-types";

function fixture(kind: "source" | "knowledge" = "source") {
  const data = createDemoWorkspace();
  const source = data.sources[0];
  const chunk = source.chunks.find((item) => item.text.length > 60)!;
  const citation = {
    sourceId: source.id,
    versionId: source.versionId,
    chunkId: chunk.id,
    title: source.title,
    quote: chunk.text,
    page: chunk.page,
    section: chunk.section,
  };
  const request: OrganizationRequest = {
    requestId: "job1",
    kind,
    trigger: "manual",
    spaceId: data.spaces[0].id,
    sourceIds: [source.id],
    sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
  };
  const page = {
    title: "学习率",
    content: "## 解释\n\n学习率控制更新的步长。 [1]",
    citations: [citation],
  };
  const job: OrganizationJob = {
    id: request.requestId,
    request,
    status: "ready",
    createdAt: source.createdAt,
    updatedAt: source.createdAt,
    result:
      kind === "source"
        ? {
            kind,
            mode: "model",
            summary: page,
            tags: [
              { label: "优化方法", citations: [citation] },
              { label: "梯度下降", citations: [citation] },
            ],
            topics: [{ label: "学习率", citations: [citation] }],
            coverage: "使用 1 份资料的部分片段。",
          }
        : {
            kind,
            mode: "model",
            pages: [page, { ...page, title: "步长与稳定性" }],
            coverage: "使用 1 份资料的部分片段。",
          },
  };
  data.organizationJobs = [job];
  return { data, source, request, job, citation };
}

describe("organization boundaries and compatible persistence", () => {
  it("reads legacy workspaces without enabling automatic organization", () => {
    const result = workspaceSchema.parse(createDemoWorkspace());
    expect(result.autoOrganize).toBeUndefined();
    expect(result.organizationJobs).toBeUndefined();
  });
  it("accepts only durable source and knowledge jobs", () => {
    const { job } = fixture();
    expect(organizationJobSchema.safeParse({ ...job, durable: true }).success).toBe(true);
    expect(organizationJobSchema.safeParse({ ...job, durable: false }).success).toBe(false);
    expect(
      organizationJobSchema.safeParse({
        ...job,
        durable: true,
        result: undefined,
        request: {
          ...job.request,
          kind: "update",
          targetNote: {
            id: "note-update",
            revision: 0,
            updatedAt: job.createdAt,
          },
        },
      }).success,
    ).toBe(false);
  });
  it("round-trips source suggestions and accepted generated pages", () => {
    expect(workspaceSchema.safeParse(fixture().data).success).toBe(true);
    const { data } = fixture("knowledge");
    expect(
      workspaceSchema.parse(saveOrganizationPage(data, "job1", 0, "accepted", "note1")).notes[0]
        .aiGenerated,
    ).toBe(true);
  });
  it("rejects mismatched versions, duplicate selection and automatic knowledge requests", () => {
    const { request } = fixture();
    expect(organizationRequestSchema.safeParse({ ...request, sourceVersions: [] }).success).toBe(
      false,
    );
    expect(
      organizationRequestSchema.safeParse({
        ...request,
        sourceIds: [request.sourceIds[0], request.sourceIds[0]],
      }).success,
    ).toBe(false);
    expect(
      organizationRequestSchema.safeParse({ ...request, kind: "knowledge", trigger: "automatic" })
        .success,
    ).toBe(false);
  });
  it("requires opt-in only for automatic requests", () => {
    const { data, request } = fixture();
    expect(organizationUnavailableReason(data, request)).toBe("");
    expect(organizationUnavailableReason(data, { ...request, trigger: "automatic" })).toContain(
      "自动整理已关闭",
    );
    data.autoOrganize = true;
    expect(organizationUnavailableReason(data, { ...request, trigger: "automatic" })).toBe("");
  });
  it("does not start on AI opt-out, unavailable parsing, deleted or stale versions", () => {
    for (const alter of [
      (f: ReturnType<typeof fixture>) => {
        f.data.aiEnabled = false;
      },
      (f: ReturnType<typeof fixture>) => {
        f.source.aiAllowed = false;
      },
      (f: ReturnType<typeof fixture>) => {
        f.source.status = "link-only";
      },
      (f: ReturnType<typeof fixture>) => {
        f.source.deletedAt = f.source.createdAt;
      },
      (f: ReturnType<typeof fixture>) => {
        f.source.versionId = "new-version";
      },
    ]) {
      const f = fixture();
      alter(f);
      expect(organizationUnavailableReason(f.data, f.request)).not.toBe("");
    }
  });
  it("enforces inbox and real-space membership without excluding archived-space management elsewhere", () => {
    const { data, source, request } = fixture();
    expect(organizationUnavailableReason(data, { ...request, spaceId: "inbox" })).not.toBe("");
    source.spaceIds = [];
    expect(organizationUnavailableReason(data, { ...request, spaceId: "inbox" })).toBe("");
    expect(organizationUnavailableReason(data, { ...request, spaceId: "unknown" })).not.toBe("");
  });
  it("context changes for evidence or automatic permission, not note/tag bookkeeping", () => {
    const { data, source, request } = fixture();
    const initial = organizationContextKey(data, request);
    source.tags.push("手动标签");
    source.tagsLocked = true;
    data.organizationJobs![0].error = "处理中";
    expect(organizationContextKey(data, request)).toBe(initial);
    data.autoOrganize = true;
    expect(organizationContextKey(data, request)).toBe(initial);
    const auto = { ...request, trigger: "automatic" as const };
    const autoKey = organizationContextKey(data, auto);
    data.autoOrganize = false;
    expect(organizationContextKey(data, auto)).not.toBe(autoKey);
    source.text += " 原文变更";
    expect(organizationContextKey(data, request)).not.toBe(initial);
  });
});

describe("review never overwrites manual organization", () => {
  it("appends only checked new labels and supports exact undo", () => {
    const { data, source } = fixture();
    const initial = [...source.tags];
    const applied = applyOrganizationTags(data, "job1", ["优化方法", "梯度下降", "梯度下降"]);
    expect(applied.sources[0].tags).toEqual([...initial, "梯度下降"]);
    expect(applied.organizationJobs![0].appliedTags!.added).toEqual(["梯度下降"]);
    expect(data.sources[0].tags).toEqual(initial);
    expect(undoOrganizationTags(applied, "job1").sources[0].tags).toEqual(initial);
  });
  it("does not replace fixed labels or silently accept arbitrary labels", () => {
    const { data, source } = fixture();
    source.tagsLocked = true;
    expect(() => applyOrganizationTags(data, "job1", ["梯度下降"])).toThrow("固定");
    source.tagsLocked = false;
    expect(() => applyOrganizationTags(data, "job1", ["未知标签"])).toThrow("本次建议");
    expect(() => applyOrganizationTags(data, "job1", [])).toThrow("勾选");
  });
  it("refuses undo after later manual edits or locking and preserves those edits", () => {
    const { data } = fixture();
    const applied = applyOrganizationTags(data, "job1", ["梯度下降"]);
    applied.sources[0].tags.push("用户新标签");
    expect(() => undoOrganizationTags(applied, "job1")).toThrow("已被修改");
    expect(applied.sources[0].tags).toContain("用户新标签");
    applied.sources[0].tagsLocked = true;
    expect(() => undoOrganizationTags(applied, "job1")).toThrow("固定");
  });
  it("rejects repeated apply but permits archiving without rolling back applied tags", () => {
    const { data } = fixture();
    const applied = applyOrganizationTags(data, "job1", ["梯度下降"]);
    expect(() => applyOrganizationTags(applied, "job1", ["梯度下降"])).toThrow("已经应用");
    const archived = dismissOrganizationJob(applied, "job1");
    expect(archived.sources[0].tags).toContain("梯度下降");
    expect(archived.organizationJobs![0].appliedTags).toEqual(
      applied.organizationJobs![0].appliedTags,
    );
    expect(archived.organizationJobs![0].status).toBe("dismissed");
  });
  it("manual delete-and-readd cannot restore an old undo authorization", () => {
    const { data } = fixture();
    const applied = applyOrganizationTags(data, "job1", ["梯度下降"]);
    const removed = setSourceTags(applied, applied.sources[0].id, data.sources[0].tags);
    const readded = setSourceTags(removed, removed.sources[0].id, applied.sources[0].tags);
    expect(readded.sources[0].tags).toEqual(applied.sources[0].tags);
    expect(readded.sources[0].tagsRevision).toBe(applied.sources[0].tagsRevision! + 2);
    expect(() => undoOrganizationTags(readded, "job1")).toThrow("已被修改");
    expect(dismissOrganizationJob(readded, "job1").sources[0].tags).toContain("梯度下降");
  });
  it("a no-op manual save preserves a valid tag undo, while legacy records cannot authorize undo", () => {
    const { data } = fixture();
    const applied = applyOrganizationTags(data, "job1", ["梯度下降"]);
    const unchanged = setSourceTags(applied, applied.sources[0].id, applied.sources[0].tags);
    expect(unchanged).toBe(applied);
    expect(undoOrganizationTags(unchanged, "job1").sources[0].tags).not.toContain("梯度下降");
    delete applied.organizationJobs![0].appliedTags!.revision;
    expect(() => undoOrganizationTags(applied, "job1")).toThrow();
  });
  it("validates manual label limits before changing any source", () => {
    const { data } = fixture();
    const previous = structuredClone(data);
    expect(() => setSourceTags(data, data.sources[0].id, ["x".repeat(101)])).toThrow("100");
    expect(data).toEqual(previous);
  });
  it("allows reading/review of valid existing suggestions with AI disabled", () => {
    const { data, job } = fixture();
    data.aiEnabled = false;
    data.sources[0].aiAllowed = false;
    expect(organizationReviewReason(data, job)).toBe("");
    expect(applyOrganizationTags(data, "job1", ["梯度下降"]).sources[0].tags).toContain("梯度下降");
  });
  it("blocks stale, deleted and forged citations before application", () => {
    for (const change of ["version", "deleted", "quote", "page", "section"] as const) {
      const { data, source, citation, job } = fixture();
      if (change === "version") source.versionId = "v2";
      if (change === "deleted") source.deletedAt = source.createdAt;
      if (change === "quote") citation.quote = "不存在的原话";
      if (change === "page") citation.page = 999;
      if (change === "section") citation.section = "不存在的章节";
      expect(organizationReviewReason(data, job)).not.toBe("");
      expect(() => applyOrganizationTags(data, "job1", ["梯度下降"])).toThrow();
    }
  });
  it("does not trust stale chunks after the source body changes without a version bump", () => {
    const { data, job, source } = fixture();
    source.text = "完全替换的正文，旧片段已经不在原文中。";
    expect(workspaceSchema.safeParse(data).success).toBe(true);
    expect(organizationReviewReason(data, job)).toContain("原文引用已变化");
    expect(() => applyOrganizationTags(data, "job1", ["梯度下降"])).toThrow();
  });
});

describe("individual knowledge theme decisions", () => {
  it("saves only the chosen theme with citations, AI origin and an explicit draft/accepted state", () => {
    const { data } = fixture("knowledge");
    const next = saveOrganizationPage(data, "job1", 0, "draft", "note1");
    expect(next.notes).toHaveLength(1);
    expect(next.notes[0]).toMatchObject({
      id: "note1",
      title: "学习率",
      status: "draft",
      aiGenerated: true,
    });
    expect(next.notes[0].citations).toHaveLength(1);
    expect(next.notes[0].content).toContain("部分片段");
    const both = saveOrganizationPage(next, "job1", 1, "accepted", "note2");
    expect(both.notes[0].status).toBe("accepted");
    expect(both.organizationJobs![0].savedPages).toHaveLength(2);
    expect(data.notes).toHaveLength(0);
  });
  it("does not save a theme twice or revive a separately deleted note", () => {
    const { data } = fixture("knowledge");
    const saved = saveOrganizationPage(data, "job1", 0, "draft", "note1");
    saved.notes[0].deletedAt = saved.notes[0].createdAt;
    expect(() => saveOrganizationPage(saved, "job1", 0, "accepted", "note2")).toThrow("已保存");
  });
  it("ignoring one theme does not discard or overwrite another", () => {
    const { data } = fixture("knowledge");
    const ignored = ignoreOrganizationPage(data, "job1", 0);
    expect(ignored.organizationJobs![0].ignoredPages).toEqual([0]);
    expect(() => saveOrganizationPage(ignored, "job1", 0, "draft", "note1")).toThrow("忽略");
    const saved = saveOrganizationPage(ignored, "job1", 1, "accepted", "note2");
    expect(saved.notes[0].title).toBe("步长与稳定性");
    expect(() => ignoreOrganizationPage(saved, "job1", 1)).toThrow("另行保存");
  });
  it("never saves from a running task or missing page", () => {
    const { data, job } = fixture("knowledge");
    expect(() => saveOrganizationPage(data, "job1", 42, "draft", "note1")).toThrow("不可用");
    job.status = "running";
    expect(() => saveOrganizationPage(data, "job1", 0, "draft", "note1")).toThrow("不可审核");
    expect(() => dismissOrganizationJob(data, "job1")).toThrow("先停止");
  });
  it("accepting an independently saved AI draft revalidates its original evidence", () => {
    const { data } = fixture("knowledge");
    const draft = saveOrganizationPage(data, "job1", 0, "draft", "note1");
    expect(knowledgeAcceptanceReason(draft, draft.notes[0])).toBe("");
    expect(acceptKnowledgePage(draft, "note1").notes[0].status).toBe("accepted");
    for (const change of ["delete", "version", "body", "quote"] as const) {
      const stale = structuredClone(draft);
      if (change === "delete") stale.sources[0].deletedAt = stale.sources[0].createdAt;
      if (change === "version") stale.sources[0].versionId = "replaced";
      if (change === "body") stale.sources[0].text = "new body";
      if (change === "quote") stale.notes[0].citations[0].quote = "altered";
      expect(() => acceptKnowledgePage(stale, "note1")).toThrow("原文依据已失效");
      expect(stale.notes[0].status).toBe("draft");
      expect(stale.notes[0].content).toBe(draft.notes[0].content);
    }
  });
  it("keeps handwritten knowledge pages independent of missing external citations", () => {
    const { data } = fixture("knowledge");
    const draft = saveOrganizationPage(data, "job1", 0, "draft", "note1");
    draft.notes[0].aiGenerated = false;
    draft.notes[0].citations = [];
    expect(acceptKnowledgePage(draft, "note1").notes[0].status).toBe("accepted");
  });
});
