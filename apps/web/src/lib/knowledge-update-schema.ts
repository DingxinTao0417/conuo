import { z } from "zod";
import { citationSchema } from "./citation-schema";
import type {
  KnowledgeChange,
  KnowledgeNoteSnapshot,
  KnowledgeUpdateReview,
  KnowledgeUpdateWithdrawalReceipt,
} from "./knowledge-update-types";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const noteRevisionSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
export const knowledgeNoteSnapshotSchema: z.ZodType<KnowledgeNoteSnapshot> = z
  .object({
    id,
    spaceId: id,
    title: z.string().max(512),
    content: z.string().max(200_000),
    citations: z.array(citationSchema).max(1000),
    status: z.enum(["draft", "accepted"]),
    aiGenerated: z.boolean(),
    revision: noteRevisionSchema,
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const knowledgeChangeSchema: z.ZodType<KnowledgeChange> = z
  .object({
    id,
    type: z.enum(["insert_after", "replace", "remove"]),
    blockId: z.string().regex(/^(start|b[1-9][0-9]*)$/),
    before: z.string().max(60_000),
    after: z.string().max(6000),
    reason: z.string().trim().min(1).max(1000),
    citations: z.array(citationSchema).min(1).max(12),
  })
  .strict();

export const knowledgeUpdateWithdrawalReceiptSchema: z.ZodType<KnowledgeUpdateWithdrawalReceipt> = z
  .object({
    id,
    at: z.string().datetime({ offset: true }),
    noteRevision: noteRevisionSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    restoredChangeIds: z.array(id).max(12),
    keptChangeIds: z.array(id).max(12),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = [...value.restoredChangeIds, ...value.keptChangeIds];
    if (!ids.length || new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", message: "撤回记录必须包含不重复的已应用建议。" });
  });

export const knowledgeUpdateReviewSchema: z.ZodType<KnowledgeUpdateReview> = z
  .object({
    note: knowledgeNoteSnapshotSchema,
    applied: z.array(z.object({ changeId: id, text: z.string().max(6000) }).strict()).max(12),
    ignored: z.array(id).max(12),
    withdrawal: knowledgeUpdateWithdrawalReceiptSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = [...value.applied.map((change) => change.changeId), ...value.ignored];
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", message: "更新建议的审核记录重复。" });
    if (value.withdrawal) {
      const applied = new Set(value.applied.map((change) => change.changeId));
      const partition = [...value.withdrawal.restoredChangeIds, ...value.withdrawal.keptChangeIds];
      if (
        !applied.size ||
        partition.length !== applied.size ||
        new Set(partition).size !== partition.length ||
        partition.some((id) => !applied.has(id))
      )
        ctx.addIssue({ code: "custom", message: "撤回选择必须完整对应本次已应用建议。" });
      if (value.withdrawal.noteRevision <= value.note.revision)
        ctx.addIssue({ code: "custom", message: "撤回必须建立新的知识页版本。" });
    }
  });
