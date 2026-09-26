import { createHash } from "node:crypto";
import { z } from "zod";
import {
  bindGlossaryOutput,
  GLOSSARY_CONTRACT_VERSION,
  glossaryMessages,
  validateGlossaryResult,
} from "@/lib/ai/glossary";
import { callModel, readModelProfile } from "@/lib/ai/model";
import { createRequestStore, finishRequest, reserveRequest } from "@/lib/ai/requests";
import { buildGrounding } from "@/lib/ai/grounding";
import type { AnswerRequest, WorkspaceData } from "@/lib/types";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import { workspaceSchema } from "@/lib/supabase/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const inputSchema = z
  .object({
    requestId: id,
    spaceId: id,
    sourceIds: z.array(id).min(1).max(10),
  })
  .strict();

async function loadWorkspace(
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"],
  ownerId: string,
): Promise<WorkspaceData> {
  const { data, error } = await supabase
    .from("workspaces")
    .select("data")
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ApiError(404, "NO_WORKSPACE", "请先将资料保存到云端。");
  const parsed = workspaceSchema.safeParse(data.data);
  if (!parsed.success) throw new ApiError(422, "INVALID_CLOUD_DATA", "云端资料暂时无法读取。");
  return parsed.data;
}

function makeRequest(data: WorkspaceData, input: z.infer<typeof inputSchema>): AnswerRequest {
  const sources = data.sources.filter((source) => input.sourceIds.includes(source.id));
  if (
    sources.length !== input.sourceIds.length ||
    sources.some(
      (source) => source.deletedAt || !source.spaceIds.includes(input.spaceId) || !source.aiAllowed,
    )
  )
    throw new ApiError(404, "INVALID_SCOPE", "部分资料不在当前知识库或不可用于 AI。");
  if (
    sources.some(
      (source) =>
        !["ready", "partial"].includes(source.status) ||
        !source.text.trim() ||
        !source.chunks.length,
    )
  )
    throw new ApiError(
      409,
      "SOURCE_NOT_READY",
      "部分资料尚无可用正文，请完成解析后再生成术语建议。",
    );
  const request: AnswerRequest = {
    requestId: input.requestId,
    question: "总结所选资料中的关键技术术语、别名和定义。",
    scope: "sources",
    sourceIds: sources.map((source) => source.id),
    sourceVersions: sources.map((source) => ({ sourceId: source.id, versionId: source.versionId })),
    spaceId: input.spaceId,
  };
  if (!data.aiEnabled) throw new ApiError(403, "AI_DISABLED", "请先开启 AI，再生成术语建议。");
  if (!data.spaces.some((space) => space.id === input.spaceId && !space.archived))
    throw new ApiError(404, "INVALID_SCOPE", "所选学习空间不可用。");
  return request;
}

function requestFingerprint(
  request: AnswerRequest,
  profile: {
    profile: string;
    config: { baseUrl: string; model: string; jsonMode: boolean; thinkingMode?: string };
  },
  grounding: ReturnType<typeof buildGrounding>,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        GLOSSARY_CONTRACT_VERSION,
        profile.profile,
        profile.config.baseUrl,
        profile.config.model,
        profile.config.jsonMode,
        profile.config.thinkingMode ?? null,
        request.spaceId,
        request.sourceVersions,
        grounding.evidence.map((item) => [item.sourceId, item.versionId, item.chunkId]),
      ]),
    )
    .digest("hex");
}

export async function POST(request: Request) {
  let reservation:
    | { store: ReturnType<typeof createRequestStore>; ownerId: string; requestId: string }
    | undefined;
  let requestId = "";
  try {
    const { supabase, user } = await requireUser(request);
    const parsed = inputSchema.safeParse(await readJson(request, 16_000));
    if (!parsed.success || new Set(parsed.data.sourceIds).size !== parsed.data.sourceIds.length)
      throw new ApiError(400, "INVALID_GLOSSARY", "请检查术语建议的空间和资料范围。");
    requestId = parsed.data.requestId;
    const initial = await loadWorkspace(supabase, user.id);
    const answerRequest = makeRequest(initial, parsed.data);
    const grounding = buildGrounding(initial, answerRequest);
    if (!grounding.evidence.length)
      throw new ApiError(422, "GLOSSARY_INSUFFICIENT", "当前资料没有足够的原文依据生成术语建议。");
    const selectedProfile = readModelProfile("default");
    if (!selectedProfile)
      throw new ApiError(503, "MODEL_NOT_CONFIGURED", "尚未配置生成模型，暂不能生成术语建议。");
    const fingerprint = requestFingerprint(answerRequest, selectedProfile, grounding);
    const store = createRequestStore();
    const saved = await reserveRequest(store, user.id, requestId, fingerprint, {
      route: "glossary",
      features: ["organization"],
    });
    if (saved.kind === "reserved") reservation = { store, ownerId: user.id, requestId };
    const assertCurrent = async () => {
      const latest = await loadWorkspace(supabase, user.id);
      const latestRequest = makeRequest(latest, parsed.data);
      const latestGrounding = buildGrounding(latest, latestRequest);
      const latestFingerprint = requestFingerprint(latestRequest, selectedProfile, latestGrounding);
      if (latestFingerprint !== fingerprint)
        throw new ApiError(
          409,
          "GLOSSARY_CONTEXT_CHANGED",
          "资料、版本或 AI 权限已改变，请重新生成术语建议。",
        );
    };
    await assertCurrent();
    const result =
      saved.kind === "cached"
        ? validateGlossaryResult(saved.result, grounding.evidence)
        : bindGlossaryOutput(
            await callModel(
              selectedProfile.config,
              glossaryMessages(grounding.evidence),
              request.signal,
            ),
            grounding.evidence,
          );
    await assertCurrent();
    if (reservation) {
      await finishRequest(store, user.id, requestId, result);
      reservation = undefined;
    }
    return json(result);
  } catch (error) {
    if (reservation) {
      await finishRequest(
        reservation.store,
        reservation.ownerId,
        reservation.requestId,
        undefined,
        error instanceof ApiError ? error.code : "GLOSSARY_FAILED",
      ).catch(() => undefined);
    }
    return failure(error);
  }
}
