import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import { callModel, readModelProfile } from "@/lib/ai/model";
import { createRequestStore, finishRequest, reserveRequest } from "@/lib/ai/requests";
import {
  GRADING_CONTRACT_VERSION,
  bindHintResult,
  hintMessages,
  validateHintResult,
} from "@/lib/ai/grading";
import {
  assertLearningEvidence,
  itemForUpsert,
  loadLearningWorkspace,
  readLearningItem,
} from "../_ai";
import { id, requireLearningFeature } from "../_utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const inputSchema = z
  .object({ requestId: id, itemId: id, level: z.union([z.literal(1), z.literal(2), z.literal(3)]) })
  .strict();

export async function POST(request: Request) {
  let reservation:
    | { store: ReturnType<typeof createRequestStore>; ownerId: string; requestId: string }
    | undefined;
  try {
    const { supabase, user } = await requireUser(request);
    requireLearningFeature();
    const parsed = inputSchema.safeParse(await readJson(request, 16_000));
    if (!parsed.success) throw new ApiError(400, "INVALID_LEARNING_REQUEST", "提示请求格式无效。");
    const input = parsed.data;
    const workspace = await loadLearningWorkspace(supabase, user.id);
    if (!workspace.aiEnabled) throw new ApiError(403, "AI_DISABLED", "请先开启 AI，再生成提示。");
    const item = await readLearningItem(supabase, input.itemId);
    const answerText = typeof item.answer.text === "string" ? item.answer.text : "";
    if (!answerText) throw new ApiError(409, "INVALID_LEARNING_REQUEST", "题目参考答案格式无效。");
    const existing = item.hints?.[input.level - 1];
    if (existing) return json({ hint: existing, level: input.level });
    const citations = assertLearningEvidence(workspace, item.citations);
    if (!citations.length)
      throw new ApiError(
        409,
        "LEARNING_SOURCE_UNAVAILABLE",
        "题目没有可用于生成提示的当前原文依据。",
      );
    const profile = readModelProfile("default");
    if (!profile)
      throw new ApiError(503, "MODEL_NOT_CONFIGURED", "尚未配置生成模型，暂不能生成提示。");
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          GRADING_CONTRACT_VERSION,
          "hint",
          profile.profile,
          profile.config.baseUrl,
          profile.config.model,
          profile.config.jsonMode,
          profile.config.thinkingMode ?? null,
          item.itemId,
          item.prompt,
          answerText,
          input.level,
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
        ? validateHintResult(saved.result, answerText, input.level)
        : bindHintResult(
            await callModel(
              profile.config,
              hintMessages(
                { prompt: item.prompt, answer: answerText, level: input.level },
                citations,
              ),
              request.signal,
            ),
            answerText,
            input.level,
          );
    const hints = [...(item.hints ?? [])];
    hints[input.level - 1] = result.hint;
    while (hints.length < 3) hints.push("先回想题目要求你找出的关键关系。");
    const { error } = await supabase.rpc("upsert_learning_items", {
      p_items: [itemForUpsert(item, hints)],
    });
    if (error) throw error;
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
        error instanceof ApiError ? error.code : "HINT_FAILED",
      ).catch(() => undefined);
    return failure(error);
  }
}
