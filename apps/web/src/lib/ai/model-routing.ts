import "server-only";
import { aiFeatureEnabled } from "./features";
import { readModelProfile, type ModelProfileName } from "./model";

export type AnswerDepth = "standard" | "deep";

/** One place decides which profile answers a question. */
export function selectAnswerProfile(depth: AnswerDepth) {
  const wanted: ModelProfileName =
    depth === "deep" && aiFeatureEnabled("DEEP_THINKING") ? "reasoning" : "default";
  return readModelProfile(wanted);
}
export const selectFastProfile = () => readModelProfile("fast");
