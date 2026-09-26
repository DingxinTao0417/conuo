import { z } from "zod";

/** Plan feature switches; keep in sync with docs/MEMBERSHIP_SYSTEM_PLAN.md §4.3. */
export const MEMBERSHIP_FEATURES = [
  "vision_region",
  "organization",
  "learning_ai",
  "deep_thinking",
  "tutor_mode",
] as const;
export type MembershipFeatureKey = (typeof MEMBERSHIP_FEATURES)[number];

export const MEMBERSHIP_FEATURE_LABELS: Record<MembershipFeatureKey, string> = {
  vision_region: "区域截图学习",
  organization: "资料整理与术语建议",
  learning_ai: "学习 AI（出题、批改、提示）",
  deep_thinking: "深度思考",
  tutor_mode: "导师模式",
};

export const MEMBERSHIP_SOURCE_LABELS = {
  manual: "管理员开通",
  promotion: "活动赠送",
  trial: "试用",
  system: "系统授予",
  payment: "付费订阅",
} as const;

const planCode = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const utcTimestamp = z.iso.datetime({ precision: 3 });
const limits = z
  .object({
    aiDailyRequests: z.number().int().min(1).max(500),
    learningSpaces: z.number().int().min(1).max(500),
  })
  .strict();

/** GET /api/v1/account/membership: resolved plan, never grant IDs or other accounts. */
export const accountMembershipSchema = z
  .object({
    planCode,
    planName: z.string().min(1).max(100),
    source: z.enum(["manual", "promotion", "trial", "system", "payment"]).nullable(),
    startsAt: utcTimestamp.nullable(),
    endsAt: utcTimestamp.nullable(),
    afterEnd: planCode.nullable(),
    /** off/shadow: plan limits are shown but the site-wide limit still applies. */
    enforcement: z.enum(["off", "shadow", "on"]),
    limits,
    /** What this account can use right now: deployment switch, plus the plan when enforced. */
    features: z.object(
      Object.fromEntries(MEMBERSHIP_FEATURES.map((key) => [key, z.boolean()])) as Record<
        MembershipFeatureKey,
        z.ZodBoolean
      >,
    ),
    plans: z
      .array(
        z
          .object({
            code: planCode,
            name: z.string().min(1).max(100),
            description: z.string().max(1000),
            limits,
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

export type AccountMembership = z.infer<typeof accountMembershipSchema>;
