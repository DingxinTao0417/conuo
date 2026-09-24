import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import { callModel, readModelProfile } from "@/lib/ai/model";
import { createRequestStore, finishRequest, reserveRequest } from "@/lib/ai/requests";
import {
  GRADING_CONTRACT_VERSION,
  bindGradeResult,
  gradingMessages,
  validateGradeResult,
} from "@/lib/ai/grading";
import { id, requireLearningFeature } from "../_utils";
import { assertLearningEvidence, loadLearningWorkspace, readLearningItem } from "../_ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const inputSchema = z
  .object({ requestId: id, itemId: id, answer: z.string().trim().min(1).max(4_000) })
  .strict();

export async function POST(request: Request) {
  let reservation:
    | { store: ReturnType<typeof createRequestStore>; ownerId: string; requestId: string }
    | undefined;
  try {
    const { supabase, user } = await requireUser(request);
    requireLearningFeature();
    const parsed = inputSchema.safeParse(await readJson(request, 32_000));
    if (!parsed.success) throw new ApiError(400, "INVALID_LEARNING_REQUEST", "批改请求格式无效。");
    const input = parsed.data;
    const workspace = await loadLearningWorkspace(supabase, user.id);
    if (!workspace.aiEnabled) throw new ApiError(403, "AI_DISABLED", "请先开启 AI，再进行批改。");
    const item = await readLearningItem(supabase, input.itemId);
    const citations = assertLearningEvidence(workspace, item.citations);
    const keyPoints = Array.isArray(item.answer.keyPoints)
      ? item.answer.keyPoints.filter((value): value is string => typeof value === "string")
      : [];
    const referenceText = typeof item.answer.text === "string" ? item.answer.text : "";
    if (!referenceText || !keyPoints.length)
      throw new ApiError(409, "INVALID_LEARNING_REQUEST", "题目参考答案格式无效。");
    const profile = readModelProfile("default");
    if (!profile)
      throw new ApiError(503, "MODEL_NOT_CONFIGURED", "尚未配置生成模型，暂不能批改答案。");
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          GRADING_CONTRACT_VERSION,
          profile.profile,
          profile.config.baseUrl,
          profile.config.model,
          profile.config.jsonMode,
          profile.config.thinkingMode ?? null,
          item.itemId,
          item.prompt,
          referenceText,
          keyPoints,
          input.answer,
          citations.map((value) => [value.sourceId, value.versionId, value.chunkId, value.quote]),
        ]),
      )
      .digest("hex");
    const store = createRequestStore();
    const saved = await reserveRequest(store, user.id, input.requestId, fingerprint);
    if (saved.kind === "reserved")
      reservation = { store, ownerId: user.id, requestId: input.requestId };
    const result =
      saved.kind === "cached"
        ? validateGradeResult(saved.result, citations, keyPoints.length)
        : bindGradeResult(
            await callModel(
              profile.config,
              gradingMessages({ prompt: item.prompt, answer: input.answer, keyPoints }, citations),
              request.signal,
            ),
            citations,
            keyPoints.length,
          );
    if (reservation) {
      await finishRequest(store, user.id, input.requestId, result);
      reservation = undefined;
    }
    return json(result);
  } catch (error) {
    if (reservation)
      await finishRequest(
        reservation.store,
        reservation.ownerId,
        reservation.requestId,
        undefined,
        error instanceof ApiError ? error.code : "GRADING_FAILED",
      ).catch(() => undefined);
    return failure(error);
  }
}
