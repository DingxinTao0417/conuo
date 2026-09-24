import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import { buildGrounding } from "@/lib/ai/grounding";
import { callModel, readModelProfile } from "@/lib/ai/model";
import { createRequestStore, finishRequest, reserveRequest } from "@/lib/ai/requests";
import {
  EXPLAIN_CONTRACT_VERSION,
  bindExplainFeedback,
  explainMessages,
  validateExplainFeedback,
} from "@/lib/ai/grading";
import { createKnowledgePageEvidenceAnswerRequest } from "@/lib/knowledge-page-evidence";
import { assertLearningEvidence, loadLearningWorkspace, makeAnswerRequest } from "../_ai";
import { id, requireLearningFeature } from "../_utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const targetSchema = z.union([
  z.object({ knowledgePageId: id }).strict(),
  z
    .object({ sourceId: id, versionId: id, selection: z.string().trim().min(1).max(20_000) })
    .strict(),
  z.object({ glossaryTermId: id }).strict(),
]);
const inputSchema = z
  .object({ requestId: id, target: targetSchema, explanation: z.string().trim().min(1).max(4_000) })
  .strict();

export async function POST(request: Request) {
  let reservation:
    | { store: ReturnType<typeof createRequestStore>; ownerId: string; requestId: string }
    | undefined;
  try {
    const { supabase, user } = await requireUser(request);
    requireLearningFeature();
    const parsed = inputSchema.safeParse(await readJson(request, 48_000));
    if (!parsed.success)
      throw new ApiError(400, "INVALID_LEARNING_REQUEST", "解释反馈请求格式无效。");
    const input = parsed.data;
    const data = await loadLearningWorkspace(supabase, user.id);
    if (!data.aiEnabled) throw new ApiError(403, "AI_DISABLED", "请先开启 AI，再提交解释。");
    const target = input.target;
    let evidenceRequest;
    if ("knowledgePageId" in target) {
      const note = data.notes.find((candidate) => candidate.id === target.knowledgePageId);
      if (!note) throw new ApiError(404, "LEARNING_SOURCE_UNAVAILABLE", "知识页不可用。");
      evidenceRequest = createKnowledgePageEvidenceAnswerRequest(data, note, {
        question: input.explanation,
        requestId: input.requestId,
      });
    } else if ("sourceId" in target) {
      const source = data.sources.find(
        (candidate) => candidate.id === target.sourceId && !candidate.deletedAt,
      );
      if (!source || source.versionId !== target.versionId || !source.aiAllowed)
        throw new ApiError(
          409,
          "LEARNING_SOURCE_UNAVAILABLE",
          "解释依据的资料已变化，请重新选择原文。",
        );
      const spaceId = source.spaceIds[0] ?? "inbox";
      evidenceRequest = makeAnswerRequest(
        {
          scope: "selection",
          sourceId: source.id,
          sourceIds: [],
          sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
          spaceId,
          selection: target.selection,
        },
        input.requestId,
        input.explanation,
      );
    } else {
      const terms: unknown[] = [];
      for (const space of data.spaces.filter((space) => !space.archived)) {
        const result = await supabase.rpc("list_glossary_terms", { p_space_id: space.id });
        if (!result.error && Array.isArray(result.data)) terms.push(...result.data);
      }
      const term = terms.find(
        (value) => (value as { termId?: string }).termId === target.glossaryTermId,
      ) as
        | {
            spaceId?: string;
            definition?: {
              chunkRefs?: Array<{ sourceId: string; versionId: string; chunkId: string }>;
            };
          }
        | undefined;
      if (!term?.definition?.chunkRefs?.length)
        throw new ApiError(404, "LEARNING_SOURCE_UNAVAILABLE", "术语或其原文依据不可用。");
      const citations = term.definition.chunkRefs.flatMap((ref) => {
        const source = data.sources.find(
          (candidate) =>
            candidate.id === ref.sourceId &&
            candidate.versionId === ref.versionId &&
            !candidate.deletedAt &&
            candidate.aiAllowed,
        );
        const chunk = source?.chunks.find((candidate) => candidate.id === ref.chunkId);
        return source && chunk
          ? [
              {
                sourceId: source.id,
                versionId: source.versionId,
                chunkId: chunk.id,
                title: source.title,
                quote: chunk.text,
                ...(chunk.page === undefined ? {} : { page: chunk.page }),
                section: chunk.section,
              },
            ]
          : [];
      });
      assertLearningEvidence(data, citations);
      evidenceRequest = makeAnswerRequest(
        {
          scope: "sources",
          sourceIds: [...new Set(citations.map((citation) => citation.sourceId))],
          sourceVersions: [
            ...new Map(
              citations.map((citation) => [
                citation.sourceId,
                { sourceId: citation.sourceId, versionId: citation.versionId },
              ]),
            ).values(),
          ],
          spaceId: term.spaceId ?? "inbox",
        },
        input.requestId,
        input.explanation,
      );
    }
    const grounding = buildGrounding(data, evidenceRequest);
    if (!grounding.evidence.length)
      throw new ApiError(409, "LEARNING_SOURCE_UNAVAILABLE", "当前没有可用于解释反馈的原文依据。");
    const profile = readModelProfile("default");
    if (!profile)
      throw new ApiError(503, "MODEL_NOT_CONFIGURED", "尚未配置生成模型，暂不能生成解释反馈。");
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          EXPLAIN_CONTRACT_VERSION,
          profile.profile,
          profile.config.baseUrl,
          profile.config.model,
          profile.config.jsonMode,
          profile.config.thinkingMode ?? null,
          input.target,
          input.explanation,
          grounding.evidence.map((value) => [
            value.sourceId,
            value.versionId,
            value.chunkId,
            value.quote,
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
        ? validateExplainFeedback(saved.result, grounding.evidence)
        : bindExplainFeedback(
            await callModel(
              profile.config,
              explainMessages(input.explanation, grounding.evidence),
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
        error instanceof ApiError ? error.code : "EXPLAIN_FAILED",
      ).catch(() => undefined);
    return failure(error);
  }
}
