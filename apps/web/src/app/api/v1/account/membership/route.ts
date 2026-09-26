import { aiFeatureEnabled } from "@/lib/ai/features";
import { readModelProfile } from "@/lib/ai/model";
import { readMembershipEnforcement } from "@/lib/ai/requests";
import {
  accountMembershipSchema,
  MEMBERSHIP_FEATURES,
  type MembershipFeatureKey,
} from "@/lib/membership";
import { ApiError, failure, json, requireUser } from "@/lib/supabase/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function timestamp(value: unknown) {
  if (value === null || value === undefined) return null;
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : value;
}

function visionConfigured() {
  try {
    return readModelProfile("vision") !== null;
  } catch {
    return false;
  }
}

/** Deployment switches; a plan can never enable a feature the deployment turned off. */
function deploymentFeatures(): Record<MembershipFeatureKey, boolean> {
  return {
    vision_region: visionConfigured(),
    organization: true,
    learning_ai: aiFeatureEnabled("LEARNING"),
    deep_thinking: aiFeatureEnabled("DEEP_THINKING"),
    tutor_mode: aiFeatureEnabled("TUTOR_MODE"),
  };
}

const unavailable = () =>
  new ApiError(503, "MEMBERSHIP_UNAVAILABLE", "暂时无法读取会员信息，请稍后刷新。");

export async function GET(request: Request) {
  try {
    const { supabase } = await requireUser(request);
    const enforcement = readMembershipEnforcement();
    const deployment = deploymentFeatures();
    // Both reads use the caller's own session: my_membership() resolves auth.uid()
    // and the plan table only exposes public plans through RLS.
    const [membership, plans] = await Promise.all([
      supabase.rpc("my_membership").abortSignal(request.signal),
      supabase
        .from("membership_plans")
        .select("code,name,description,ai_daily_request_limit,learning_space_limit")
        .order("display_order")
        .abortSignal(request.signal),
    ]);
    if (membership.error || plans.error || !membership.data || typeof membership.data !== "object")
      throw unavailable();
    const data = membership.data as Record<string, unknown>;
    const planFeatures = (data.features ?? {}) as Record<string, unknown>;
    const parsed = accountMembershipSchema.safeParse({
      planCode: data.planCode,
      planName: data.planName,
      source: data.source ?? null,
      startsAt: timestamp(data.startsAt),
      endsAt: timestamp(data.endsAt),
      afterEnd: data.afterEnd ?? null,
      enforcement,
      limits: data.limits,
      features: Object.fromEntries(
        MEMBERSHIP_FEATURES.map((key) => [
          key,
          deployment[key] && (enforcement !== "on" || planFeatures[key] === true),
        ]),
      ),
      plans: (plans.data ?? []).map((plan) => ({
        code: plan.code,
        name: plan.name,
        description: plan.description,
        limits: {
          aiDailyRequests: plan.ai_daily_request_limit,
          learningSpaces: plan.learning_space_limit,
        },
      })),
    });
    if (!parsed.success) throw unavailable();
    return json(parsed.data);
  } catch (error) {
    return failure(error);
  }
}
