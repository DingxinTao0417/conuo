import { z } from "zod";
import { citationSchema } from "@/lib/citation-schema";
import { learningKinds } from "./types";

export const learningIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const answerSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 16_384);
const cardSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 4_096);

export const learningItemSchema = z
  .object({
    itemId: learningIdSchema,
    spaceId: learningIdSchema,
    kind: z.enum(learningKinds),
    prompt: z.string().trim().min(1).max(2_000),
    choices: z.array(z.string().trim().min(1).max(2_000)).min(2).max(6).nullable().optional(),
    answer: answerSchema,
    explanation: z.string().max(4_000).nullable().optional(),
    citations: z.array(citationSchema).max(6),
    origin: z.enum(["ai", "user", "region"]),
    originRef: z.record(z.string(), z.unknown()).nullable().optional(),
    conceptKey: z.string().trim().min(1).max(120).nullable().optional(),
    hints: z.array(z.string().trim().min(1).max(2_000)).max(3).nullable().optional(),
    status: z.enum(["active", "suspended", "archived"]),
    card: cardSchema.optional(),
    dueAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const reviewRequestSchema = z
  .object({
    itemId: learningIdSchema,
    rating: z.number().int().min(1).max(4),
    answerText: z.string().max(4_000).optional(),
    grade: z.record(z.string(), z.unknown()).optional(),
    elapsedMs: z.number().int().min(0).max(86_400_000).optional(),
    expectedVersion: z.number().int().min(0),
  })
  .strict();

export const learningSettingsSchema = z
  .object({
    dailyNewLimit: z.number().int().min(0).max(200),
    desiredRetention: z.number().min(0.7).max(0.97),
    paused: z.boolean(),
  })
  .strict();

export const learningStatusSchema = z.enum(["active", "suspended", "archived"]);

export const learningBackupSchema = z
  .object({
    schemaVersion: z.literal(1),
    items: z.array(learningItemSchema.passthrough()),
    reviewLogs: z.array(
      z
        .object({
          logId: learningIdSchema,
          itemId: learningIdSchema,
          rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
          answerText: z.string().max(4_000).nullable().optional(),
          grade: z.record(z.string(), z.unknown()).nullable().optional(),
          elapsedMs: z.number().int().min(0).max(86_400_000).nullable().optional(),
          reviewedAt: z.string().datetime({ offset: true }),
        })
        .strict(),
    ),
    settings: learningSettingsSchema.nullable(),
  })
  .strict();
