import { z } from "zod";

export const citationSchema = z
  .object({
    sourceId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    versionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    chunkId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    title: z.string().max(512),
    quote: z.string().max(3 * 1024 * 1024),
    page: z.number().int().min(1).max(100_000).optional(),
    section: z.string().max(512),
  })
  .strict();

/** Schema for answer-only personal-note evidence. It intentionally cannot
 * masquerade as a source citation. */
export const answerNoteEvidenceSchema = z
  .object({
    noteId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    spaceId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    sourceId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    sourceVersionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    updatedAt: z.string().datetime({ offset: true }),
    blockId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    title: z.string().min(1).max(512),
    quote: z.string().trim().min(1).max(8_000),
  })
  .strict();
