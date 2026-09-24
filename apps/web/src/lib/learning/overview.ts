import { z } from "zod";
import { citationSchema } from "@/lib/citation-schema";
import { learningIdSchema } from "./schema";

export const learningWeakConceptSchema = z
  .object({
    conceptKey: z.string().trim().min(1).max(120),
    forgottenCount: z.number().int().min(0).max(5),
    latestIncorrect: z.boolean(),
    spaceId: learningIdSchema,
    itemIds: z.array(learningIdSchema).max(5),
    citations: z.array(citationSchema).max(6),
  })
  .strict();

export const learningOverviewSchema = z
  .object({
    dueCount: z.number().int().min(0),
    newCount: z.number().int().min(0),
    reviewsLast7d: z.number().int().min(0),
    weakConcepts: z.array(learningWeakConceptSchema).max(5),
  })
  .strict();

export type LearningWeakConcept = z.infer<typeof learningWeakConceptSchema>;
export type LearningOverview = z.infer<typeof learningOverviewSchema>;

export function hasLearningOverviewData(overview: LearningOverview): boolean {
  return (
    overview.dueCount > 0 ||
    overview.newCount > 0 ||
    overview.reviewsLast7d > 0 ||
    overview.weakConcepts.length > 0
  );
}
