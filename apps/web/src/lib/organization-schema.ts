import { z } from "zod";
import { citationSchema } from "./citation-schema";
import { relationProposalSchema } from "./concept-relation-schema";
import {
  knowledgeChangeSchema,
  knowledgeNoteSnapshotSchema,
  knowledgeUpdateReviewSchema,
  noteRevisionSchema,
} from "./knowledge-update-schema";
import type {
  OrganizationJob,
  OrganizationRequest,
  OrganizationResult,
} from "./organization-types";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const tag = z.string().trim().min(1).max(100);
const label = z
  .object({
    label: tag,
    citations: z.array(citationSchema).min(1).max(12),
  })
  .strict();
const page = z
  .object({
    title: z.string().trim().min(1).max(200),
    content: z.string().trim().min(1).max(30_000),
    citations: z.array(citationSchema).min(1).max(12),
  })
  .strict();

export const organizationRequestSchema: z.ZodType<OrganizationRequest> = z
  .object({
    requestId: id,
    kind: z.enum(["source", "knowledge", "update", "relations"]),
    trigger: z.enum(["automatic", "manual"]),
    spaceId: id,
    sourceIds: z.array(id).min(1).max(10),
    sourceVersions: z
      .array(z.object({ sourceId: id, versionId: id }).strict())
      .min(1)
      .max(10),
    topic: z.string().trim().max(200).optional(),
    targetNote: z
      .object({
        id,
        revision: noteRevisionSchema,
        updatedAt: z.string().datetime({ offset: true }),
      })
      .strict()
      .optional(),
    compareNote: z
      .object({
        id,
        revision: noteRevisionSchema,
        updatedAt: z.string().datetime({ offset: true }),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.kind === "update" || value.kind === "relations") !== Boolean(value.targetNote))
      ctx.addIssue({
        code: "custom",
        message: "知识页更新和关系建议必须绑定目标知识页，其他整理不接受目标页。",
      });
    if (
      (value.kind === "relations") !== Boolean(value.compareNote) ||
      (value.compareNote && value.compareNote.id === value.targetNote?.id)
    )
      ctx.addIssue({
        code: "custom",
        message: "关系建议必须选择两个不同知识页；其他整理不接受对照页。",
      });
    const ids = new Set(value.sourceIds);
    if (
      ids.size !== value.sourceIds.length ||
      value.sourceVersions.length !== ids.size ||
      new Set(value.sourceVersions.map((v) => v.sourceId)).size !== ids.size ||
      value.sourceVersions.some((v) => !ids.has(v.sourceId))
    ) {
      ctx.addIssue({ code: "custom", message: "资料与版本需要一一对应。" });
    }
    if (value.kind === "source" && value.sourceIds.length !== 1) {
      ctx.addIssue({ code: "custom", message: "资料分析每次只处理一份资料。" });
    }
    if (value.trigger === "automatic" && value.kind !== "source") {
      ctx.addIssue({ code: "custom", message: "知识主题草稿由用户主动生成。" });
    }
  });

export const organizationResultSchema: z.ZodType<OrganizationResult> = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("relations"),
        mode: z.literal("model"),
        target: knowledgeNoteSnapshotSchema,
        compare: knowledgeNoteSnapshotSchema,
        relations: z.array(relationProposalSchema).max(4),
        coverage: z.string().min(1).max(2000),
      })
      .strict(),
    z
      .object({
        kind: z.literal("source"),
        mode: z.literal("model"),
        summary: page,
        tags: z.array(label).max(8),
        topics: z.array(label).max(5),
        coverage: z.string().min(1).max(2000),
      })
      .strict(),
    z
      .object({
        kind: z.literal("update"),
        mode: z.literal("model"),
        target: knowledgeNoteSnapshotSchema,
        changes: z.array(knowledgeChangeSchema).max(12),
        coverage: z.string().min(1).max(2000),
      })
      .strict(),
    z
      .object({
        kind: z.literal("knowledge"),
        mode: z.literal("model"),
        pages: z.array(page).min(1).max(3),
        coverage: z.string().min(1).max(2000),
      })
      .strict(),
  ],
);

export const organizationJobSchema: z.ZodType<OrganizationJob> = z
  .object({
    id,
    restoredFromBackup: z.boolean().optional(),
    durable: z.literal(true).optional(),
    request: organizationRequestSchema,
    status: z.enum(["queued", "running", "ready", "failed", "cancelled", "dismissed"]),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    result: organizationResultSchema.optional(),
    error: z.string().max(10_000).optional(),
    appliedTags: z
      .object({
        added: z.array(tag).max(100),
        before: z.array(tag).max(100),
        after: z.array(tag).max(100),
        revision: z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER - 1)
          .optional(),
      })
      .strict()
      .optional(),
    savedPages: z
      .array(z.object({ index: z.number().int().min(0).max(2), noteId: id }).strict())
      .max(3)
      .optional(),
    ignoredPages: z.array(z.number().int().min(0).max(2)).max(3).optional(),
    updateReview: knowledgeUpdateReviewSchema.optional(),
    savedRelations: z
      .array(z.object({ proposalId: id, relationId: id }).strict())
      .max(4)
      .optional(),
    ignoredRelations: z.array(id).max(4).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.durable && value.request.kind !== "source" && value.request.kind !== "knowledge")
      ctx.addIssue({
        code: "custom",
        message: "仅资料分析和知识草稿任务支持后台执行。",
      });
    if (value.updateReview && value.request.kind !== "update")
      ctx.addIssue({ code: "custom", message: "仅知识更新任务允许保存段落审核记录。" });
    if (value.updateReview?.withdrawal) {
      const result = value.result;
      const review = value.updateReview;
      if (
        result?.kind !== "update" ||
        !["ready", "dismissed"].includes(value.status) ||
        result.target.id !== value.request.targetNote?.id ||
        result.target.revision !== value.request.targetNote.revision ||
        result.target.updatedAt !== value.request.targetNote.updatedAt ||
        result.target.spaceId !== value.request.spaceId ||
        review.note.id !== result.target.id ||
        review.note.spaceId !== result.target.spaceId ||
        review.note.revision <= result.target.revision
      )
        ctx.addIssue({ code: "custom", message: "撤回记录与已应用知识更新的基础版本不一致。" });
      if (result?.kind === "update") {
        const changeIds = new Set(result.changes.map((change) => change.id));
        const reviewed = [...review.applied.map((change) => change.changeId), ...review.ignored];
        if (changeIds.size !== result.changes.length || reviewed.some((id) => !changeIds.has(id)))
          ctx.addIssue({ code: "custom", message: "撤回记录引用了重复或未知的更新建议。" });
      }
    }
    if ((value.savedRelations || value.ignoredRelations) && value.request.kind !== "relations")
      ctx.addIssue({ code: "custom", message: "仅关系任务允许保存关系审核记录。" });
    const relationIds = [
      ...(value.savedRelations?.map((item) => item.proposalId) ?? []),
      ...(value.ignoredRelations ?? []),
    ];
    if (new Set(relationIds).size !== relationIds.length)
      ctx.addIssue({ code: "custom", message: "关系审核记录不能重复。" });
    if (
      value.id !== value.request.requestId ||
      (value.result && value.result.kind !== value.request.kind)
    ) {
      ctx.addIssue({ code: "custom", message: "整理任务标识或结果类型不一致。" });
    }
  });
