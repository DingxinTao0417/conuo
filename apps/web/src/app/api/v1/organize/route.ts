import { createHash } from "node:crypto";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import { workspaceSchema } from "@/lib/supabase/validation";
import { organizationRequestSchema } from "@/lib/organization-schema";
import { organizationContextKey } from "@/lib/organization";
import { snapshotKnowledgeNote } from "@/lib/knowledge-update";
import { callModel, readModelProfile, type ModelProfileName } from "@/lib/ai/model";
import { selectFastProfile } from "@/lib/ai/model-routing";
import { createRequestStore, reserveRequest, finishRequest } from "@/lib/ai/requests";
import { createTraceRecorder } from "@/lib/ai/traces";
import {
  assertOrganizationScope,
  buildOrganizationGrounding,
  organizationMessages,
  bindOrganizationResult,
  validateOrganizationResult,
  organizationTargetSignature,
  ORGANIZATION_MODEL_CONTRACT_VERSION,
} from "@/lib/ai/organization";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  let reservation:
    | { store: ReturnType<typeof createRequestStore>; ownerId: string; requestId: string }
    | undefined;
  let traceRecorder: ReturnType<typeof createTraceRecorder> | undefined;
  let traceOutcome:
    "completed" | "insufficient" | "failed" | "cancelled" | "cached" | "extractive" = "failed";
  let traceErrorCode: string | undefined;
  let traceModelName: string | undefined;
  let traceModelProfile: ModelProfileName | undefined;
  try {
    const { supabase, user } = await requireUser(request);
    const parsed = organizationRequestSchema.safeParse(await readJson(request, 50_000));
    if (!parsed.success)
      throw new ApiError(400, "INVALID_ORGANIZATION", "请检查整理方式、资料范围和版本。");
    const input = parsed.data;
    traceRecorder = createTraceRecorder("organize", user.id, input.requestId);
    const load = async () => {
      const { data, error } = await supabase
        .from("workspaces")
        .select("data")
        .eq("owner_id", user.id)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new ApiError(404, "NO_WORKSPACE", "请先将资料保存到云端。");
      const workspace = workspaceSchema.safeParse(data.data);
      if (!workspace.success)
        throw new ApiError(422, "INVALID_CLOUD_DATA", "云端资料格式暂时无法读取。");
      return workspace.data;
    };
    const assertNotCancelled = () => {
      if (request.signal.aborted) throw new ApiError(499, "REQUEST_CANCELLED", "整理已停止。");
    };
    const initial = await load();
    assertNotCancelled();
    assertOrganizationScope(initial, input);
    // The browser sends only a version reference, never the target page body.
    const targetNote =
      input.kind === "update" || input.kind === "relations"
        ? initial.notes.find((note) => note.id === input.targetNote?.id)
        : undefined;
    const target = targetNote ? snapshotKnowledgeNote(targetNote) : undefined;
    if ((input.kind === "update" || input.kind === "relations") && !target)
      throw new ApiError(404, "KNOWLEDGE_TARGET_UNAVAILABLE", "目标知识页不可用。");
    const compareNote =
      input.kind === "relations"
        ? initial.notes.find((note) => note.id === input.compareNote?.id)
        : undefined;
    const compare = compareNote ? snapshotKnowledgeNote(compareNote) : undefined;
    if (input.kind === "relations" && !compare)
      throw new ApiError(404, "KNOWLEDGE_TARGET_UNAVAILABLE", "关系终点知识页不可用。");
    const requestedProfile = process.env.CONUO_ORGANIZATION_MODEL_PROFILE?.trim() || "default";
    if (requestedProfile !== "default" && requestedProfile !== "fast")
      throw new ApiError(503, "MODEL_CONFIGURATION", "模型服务配置不完整或无效，请联系管理员。");
    const selectedProfile =
      requestedProfile === "fast" ? selectFastProfile() : readModelProfile("default");
    const config = selectedProfile?.config;
    if (!selectedProfile || !config)
      throw new ApiError(
        503,
        "MODEL_NOT_CONFIGURED",
        "尚未配置生成模型，暂不能生成整理建议。原文阅读和检索仍可使用。",
      );
    const grounding = buildOrganizationGrounding(initial, input);
    const contextKey = organizationContextKey(initial, input);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          ORGANIZATION_MODEL_CONTRACT_VERSION,
          config.baseUrl,
          config.model,
          config.jsonMode,
          config.thinkingMode ?? null,
          selectedProfile.profile,
          contextKey,
        ]),
      )
      .digest("hex");
    const store = createRequestStore();
    // Shares the same account quota/concurrency ledger with questions.
    const saved = await reserveRequest(store, user.id, input.requestId, fingerprint);
    if (saved.kind === "reserved")
      reservation = { store, ownerId: user.id, requestId: input.requestId };
    const assertCurrent = async () => {
      assertNotCancelled();
      const auth = await requireUser(request);
      if (auth.user.id !== user.id)
        throw new ApiError(409, "SESSION_CHANGED", "当前账号已改变，本次整理未保存。");
      const latest = await load();
      assertNotCancelled();
      const targetChanged = [target, compare].some((basis) => {
        if (!basis) return false;
        const latestNote = latest.notes.find(
          (note) => note.id === basis.id && !note.deletedAt && note.kind === "knowledge",
        );
        return (
          !latestNote ||
          organizationTargetSignature(snapshotKnowledgeNote(latestNote)) !==
            organizationTargetSignature(basis)
        );
      });
      if (targetChanged || organizationContextKey(latest, input) !== contextKey)
        throw new ApiError(
          409,
          "ORGANIZATION_CONTEXT_CHANGED",
          "资料、知识页版本或 AI 使用权限已改变，本次整理未发布。请基于当前内容重新发起。",
        );
      assertOrganizationScope(latest, input);
    };
    // A reservation may wait on another worker. Recheck before disclosing evidence.
    await assertCurrent();
    let result;
    if (saved.kind === "cached") {
      traceOutcome = "cached";
      result = validateOrganizationResult(saved.result, grounding, input, target, compare);
    } else {
      traceRecorder.mark("modelStart");
      result = bindOrganizationResult(
        await callModel(
          config,
          organizationMessages(grounding, input, target, compare),
          request.signal,
          { onUsage: (usage) => traceRecorder?.addUsage(usage) },
        ),
        grounding,
        input,
        target,
        compare,
      );
      traceOutcome = "completed";
      traceRecorder.mark("modelEnd");
    }
    traceModelName = config.model;
    traceModelProfile = selectedProfile.profile;
    await assertCurrent();
    if (reservation) {
      await finishRequest(store, user.id, input.requestId, result);
      reservation = undefined;
      // Also guard the time spent writing the shared ledger cache.
      await assertCurrent();
    }
    if (traceRecorder)
      void traceRecorder.finish(traceOutcome, {
        modelProfile: traceModelProfile ?? "default",
        modelName: traceModelName,
      });
    return json(result);
  } catch (error) {
    if (error instanceof ApiError) {
      traceErrorCode = error.code;
      if (error.code === "REQUEST_CANCELLED" || error.code === "MODEL_CANCELLED")
        traceOutcome = "cancelled";
    }
    if (traceRecorder)
      void traceRecorder.finish(traceOutcome, {
        errorCode: traceErrorCode,
        modelProfile: traceModelProfile ?? "default",
        modelName: traceModelName,
      });
    if (reservation) {
      try {
        await finishRequest(
          reservation.store,
          reservation.ownerId,
          reservation.requestId,
          undefined,
          error instanceof ApiError ? error.code : "MODEL_REQUEST_FAILED",
        );
      } catch {
        /* Keep unresolved reservations non-replayable; do not call the model again. */
      }
    }
    return failure(error);
  }
}
