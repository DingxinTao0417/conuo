import { z } from "zod";
import { citationSchema } from "./citation-schema";
import { knowledgeNoteSnapshotSchema, noteRevisionSchema } from "./knowledge-update-schema";
import type {
  ConceptRelation,
  RelationDraft,
  RelationInput,
  RelationProposal,
} from "./concept-relation-types";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const fields = {
  type: z.enum(["synonym", "related", "prerequisite", "conflict"]),
  fromClaim: z.string().trim().min(1).max(2000),
  toClaim: z.string().trim().min(1).max(2000),
  fromCondition: z.string().trim().max(1000),
  toCondition: z.string().trim().max(1000),
  explanation: z.string().trim().min(1).max(2000),
  fromCitations: z.array(citationSchema).max(6),
  toCitations: z.array(citationSchema).max(6),
};
const chunkKey = (c: z.infer<typeof citationSchema>) =>
  JSON.stringify([c.sourceId, c.versionId, c.chunkId]);
function conflictEvidence(value: RelationDraft, ctx: z.RefinementCtx) {
  if (value.type !== "conflict") return;
  const from = new Set(value.fromCitations.map(chunkKey));
  const to = new Set(value.toCitations.map(chunkKey));
  if (![...from].some((key) => !to.has(key)) || ![...to].some((key) => !from.has(key)))
    ctx.addIssue({ code: "custom", message: "冲突观点需分别提供两侧的独立原文依据。" });
  if (!value.fromCondition.trim() || !value.toCondition.trim())
    ctx.addIssue({ code: "custom", message: "请分别说明两侧适用条件；原文未说明时请如实填写。" });
  if (value.fromClaim.replace(/\s+/g, "") === value.toClaim.replace(/\s+/g, ""))
    ctx.addIssue({ code: "custom", message: "两侧相同的观点不能标记为冲突。" });
}
export const relationDraftSchema: z.ZodType<RelationDraft> = z
  .object(fields)
  .strict()
  .superRefine(conflictEvidence);
export const relationInputSchema: z.ZodType<RelationInput> = z
  .object({ ...fields, fromNoteId: id, toNoteId: id })
  .strict()
  .superRefine(conflictEvidence);
export const relationProposalSchema: z.ZodType<RelationProposal> = z
  .object({ ...fields, id })
  .strict()
  .superRefine(conflictEvidence);
export const conceptRelationSchema: z.ZodType<ConceptRelation> = z
  .object({
    ...fields,
    id,
    spaceId: id,
    from: knowledgeNoteSnapshotSchema,
    to: knowledgeNoteSnapshotSchema,
    origin: z.enum(["manual", "ai"]),
    revision: noteRevisionSchema,
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    deletedAt: z.string().datetime({ offset: true }).nullable(),
    jobId: id.optional(),
    proposalId: id.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    conflictEvidence(value, ctx);
    if (
      value.from.id === value.to.id ||
      value.from.spaceId !== value.spaceId ||
      value.to.spaceId !== value.spaceId
    )
      ctx.addIssue({ code: "custom", message: "关系需要两个不同且属于同一知识库的知识页。" });
    if (value.origin === "manual" && !value.fromCitations.length && !value.toCitations.length)
      ctx.addIssue({ code: "custom", message: "手动关系至少需要一处原文依据。" });
  });
