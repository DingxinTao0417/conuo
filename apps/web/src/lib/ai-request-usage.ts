import { z } from "zod";

export const AI_DAILY_REQUEST_LIMIT_MIN = 1;
export const AI_DAILY_REQUEST_LIMIT_MAX = 500;
export const AI_DEFAULT_DAILY_REQUEST_LIMIT = 50;
export const AI_DAILY_TOKEN_LIMIT_MAX = 100_000_000;
export const AI_DEFAULT_DAILY_TOKEN_LIMIT = 0;
export const AI_USAGE_CHANGED_EVENT = "conuo-ai-usage-changed";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const utcTimestamp = z.iso.datetime({ precision: 3 });
/** Resolved plan summary; present only when membership enforcement is shadow or on. */
const membershipSummary = z
  .object({
    planCode: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    planName: z.string().min(1).max(100),
    source: z.enum(["manual", "promotion", "trial", "system", "payment"]).nullable(),
    endsAt: utcTimestamp.nullable(),
    afterEnd: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/)
      .nullable(),
    enforced: z.boolean(),
  })
  .strict();

const tokenUsage = z
  .object({
    promptTokens: count,
    completionTokens: count,
    limit: z.number().int().min(0).max(AI_DAILY_TOKEN_LIMIT_MAX),
  })
  .strict();

/** A sampled reservation count, never provider token usage or a billing balance. */
export const aiRequestUsageSchema = z
  .object({
    usedCount: count,
    dailyLimit: z.number().int().min(AI_DAILY_REQUEST_LIMIT_MIN).max(AI_DAILY_REQUEST_LIMIT_MAX),
    remainingCount: count,
    windowStart: utcTimestamp,
    resetsAt: utcTimestamp,
    checkedAt: utcTimestamp,
    counting: z.literal("reserved_requests"),
    includesFailedAndCancelled: z.literal(true),
    tokens: tokenUsage,
    membership: membershipSummary.optional(),
  })
  .strict()
  .superRefine((usage, context) => {
    const start = Date.parse(usage.windowStart);
    const reset = Date.parse(usage.resetsAt);
    const checked = Date.parse(usage.checkedAt);
    if (
      !usage.windowStart.endsWith("T00:00:00.000Z") ||
      reset - start !== 86_400_000 ||
      checked < start ||
      checked >= reset
    )
      context.addIssue({ code: "custom", message: "模型用量的 UTC 统计日期无效。" });
    if (usage.remainingCount !== Math.max(0, usage.dailyLimit - usage.usedCount))
      context.addIssue({ code: "custom", path: ["remainingCount"], message: "模型剩余次数无效。" });
  });

export type AiRequestUsage = z.infer<typeof aiRequestUsageSchema>;

/** No account identifiers, questions, source names, or model results in the event. */
export function notifyAiUsageChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AI_USAGE_CHANGED_EVENT));
}
