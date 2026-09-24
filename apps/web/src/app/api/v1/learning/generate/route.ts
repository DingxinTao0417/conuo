import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import { buildGrounding } from "@/lib/ai/grounding";
import { callModel, readModelProfile } from "@/lib/ai/model";
import { createRequestStore, finishRequest, reserveRequest } from "@/lib/ai/requests";
import { createKnowledgePageEvidenceAnswerRequest } from "@/lib/knowledge-page-evidence";
import {
  PRACTICE_CONTRACT_VERSION,
  bindPracticeResult,
  practiceMessages,
  validatePracticeResult,
} from "@/lib/ai/practice";
import { learningKinds } from "@/lib/learning/types";
import { id, requireLearningFeature } from "../_utils";
import {
  assertLearningEvidence,
  learningAiRangeSchema,
  learningItemRows,
  loadLearningWorkspace,
  makeAnswerRequest,
} from "../_ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const inputSchema = z
  .object({
    requestId: id,
    source: z.union([learningAiRangeSchema, z.object({ knowledgePageId: id }).strict()]),
    count: z.number().int().min(3).max(8),
    kinds: z.array(z.enum(learningKinds)).min(1).max(5).optional(),
    focus: z.string().trim().max(200).optional(),
    learningItemIds: z.array(id).max(5).optional(),
  })
  .strict();

export async function POST(request: Request) {
  let reservation:
    | { store: ReturnType<typeof createRequestStore>; ownerId: string; requestId: string }
    | undefined;
  try {
    const { supabase, user } = await requireUser(request);
    requireLearningFeature();
    const parsed = inputSchema.safeParse(await readJson(request, 64_000));
    if (
      !parsed.success ||
      (parsed.data.kinds && new Set(parsed.data.kinds).size !== parsed.data.kinds.length)
    )
      throw new ApiError(400, "INVALID_LEARNING_REQUEST", "出题范围或题型格式无效。");
    const input = parsed.data;
    const data = await loadLearningWorkspace(supabase, user.id);
    if (!data.aiEnabled) throw new ApiError(403, "AI_DISABLED", "请先开启 AI，再生成练习题。");
    const question = input.focus || "请根据这些原文生成帮助学习者检查理解的练习题。";
    const source = input.source;
    const answerRequest =
      "knowledgePageId" in source
        ? createKnowledgePageEvidenceAnswerRequest(
            data,
            data.notes.find((note) => note.id === source.knowledgePageId) ??
              (() => {
                throw new ApiError(404, "LEARNING_SOURCE_UNAVAILABLE", "知识页不可用。");
              })(),
            { question, requestId: input.requestId },
          )
        : makeAnswerRequest(source, input.requestId, question);
    const grounding = input.learningItemIds?.length
      ? await (async () => {
          const related = await supabase.rpc("list_learning_items", {
            p_space_id: null,
            p_status: null,
            p_limit: 100,
            p_before: null,
          });
          if (related.error) throw related.error;
          const items = learningItemRows(related.data).filter((item) =>
            input.learningItemIds!.includes(item.itemId),
          );
          if (items.length !== input.learningItemIds!.length)
            throw new ApiError(
              409,
              "LEARNING_SOURCE_UNAVAILABLE",
              "针对性练习依据已变化，请刷新后重试。",
            );
          const citations = assertLearningEvidence(
            data,
            items.flatMap((item) => item.citations),
          ).filter(
            (citation, index, all) =>
              all.findIndex(
                (candidate) =>
                  candidate.sourceId === citation.sourceId &&
                  candidate.versionId === citation.versionId &&
                  candidate.chunkId === citation.chunkId &&
                  candidate.quote === citation.quote,
              ) === index,
          );
          return {
            evidence: citations,
            noteEvidence: [],
            coverage: "只使用相关练习题仍有效的原文引用。",
            layout: "retrieval" as const,
            fallback: { mode: "extractive" as const, citations, content: "" },
          };
        })()
      : buildGrounding(data, answerRequest);
    if (!grounding.evidence.length)
      throw new ApiError(409, "LEARNING_SOURCE_UNAVAILABLE", "当前资料没有可用于出题的原文依据。");
    const profile = readModelProfile("default");
    if (!profile)
      throw new ApiError(503, "MODEL_NOT_CONFIGURED", "尚未配置生成模型，暂不能生成练习题。");
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          PRACTICE_CONTRACT_VERSION,
          profile.profile,
          profile.config.baseUrl,
          profile.config.model,
          profile.config.jsonMode,
          profile.config.thinkingMode ?? null,
          input.count,
          input.kinds ?? null,
          input.focus ?? null,
          input.learningItemIds ?? null,
          grounding.evidence.map((item) => [
            item.sourceId,
            item.versionId,
            item.chunkId,
            item.quote,
          ]),
        ]),
      )
      .digest("hex");
    const store = createRequestStore();
    const saved = await reserveRequest(store, user.id, input.requestId, fingerprint);
    if (saved.kind === "reserved")
      reservation = { store, ownerId: user.id, requestId: input.requestId };
    const result =
      saved.kind === "cached"
        ? validatePracticeResult(saved.result, grounding.evidence)
        : bindPracticeResult(
            await callModel(
              profile.config,
              practiceMessages(grounding.evidence, {
                count: input.count,
                kinds: input.kinds,
                focus: input.focus,
              }),
              request.signal,
            ),
            grounding.evidence,
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
        error instanceof ApiError ? error.code : "PRACTICE_FAILED",
      ).catch(() => undefined);
    return failure(error);
  }
}
