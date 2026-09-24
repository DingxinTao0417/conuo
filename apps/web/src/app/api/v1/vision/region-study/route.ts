import { createHash } from "node:crypto";
import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import { workspaceSchema } from "@/lib/supabase/validation";
import {
  VISION_REGION_MAX_BODY_BYTES,
  sameVisionProvenance,
  visionStudyRequestSchema,
  visionStudyResultSchema,
  type VisionStudyRequest,
} from "@/lib/vision-region-contract";
import { callVisionModel, readModelProfile, type ModelProfileName } from "@/lib/ai/model";
import {
  VISION_STUDY_SEMANTICS_VERSION,
  assertVisionSource,
  bindVisionStudyResult,
  validateVisionImage,
  visionSourceContextKey,
  visionStudyMessages,
} from "@/lib/ai/vision-region";
import { createRequestStore, finishRequest, reserveRequest } from "@/lib/ai/requests";
import { createTraceRecorder } from "@/lib/ai/traces";
import { aiFeatureEnabled } from "@/lib/ai/features";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;
const LEDGER_CLEANUP_MS = 2_000;

type UserClient = Awaited<ReturnType<typeof requireUser>>["supabase"];

async function loadWorkspace(supabase: UserClient, ownerId: string) {
  const { data, error } = await supabase
    .from("workspaces")
    .select("data,revision")
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ApiError(404, "NO_WORKSPACE", "请先将资料保存到云端。");
  const workspace = workspaceSchema.safeParse(data.data);
  if (!workspace.success)
    throw new ApiError(422, "INVALID_CLOUD_DATA", "云端资料格式暂时无法读取。");
  return workspace.data;
}

function pageTextForRequest(
  workspace: Awaited<ReturnType<typeof loadWorkspace>>,
  input: VisionStudyRequest,
) {
  const source = workspace.sources.find(
    (candidate) =>
      candidate.id === input.provenance.sourceId &&
      candidate.versionId === input.provenance.versionId,
  );
  if (!source) return undefined;
  const pageText = source.chunks
    .filter((chunk) => chunk.versionId === source.versionId && chunk.page === input.provenance.page)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((chunk) => chunk.text)
    .join("\n\n")
    .slice(0, 6_000);
  return pageText.trim() ? pageText : undefined;
}

function cancelled(): ApiError {
  return new ApiError(499, "REQUEST_CANCELLED", "区域视觉学习已停止，请重新选择区域后再试。");
}

/** Readiness never accepts or reads image bytes. */
export async function GET(request: Request) {
  try {
    await requireUser(request);
    try {
      if (!readModelProfile("vision"))
        return json({
          available: false,
          message: "尚未启用支持图片输入的模型，区域视觉学习暂不可用。",
        });
      const store = createRequestStore();
      const { error } = await store.from("ai_requests").select("request_id").limit(0);
      if (error)
        return json({
          available: false,
          message: "模型请求记录服务尚未就绪，区域视觉学习不会上传区域图片。",
        });
      return json({
        available: true,
        message: "区域视觉学习配置已就绪；确认操作后才会上传区域图片，实际调用以模型响应为准。",
      });
    } catch (error) {
      if (
        error instanceof ApiError &&
        ["MODEL_CONFIGURATION", "MODEL_LEDGER_NOT_CONFIGURED", "MODEL_LEDGER_UNAVAILABLE"].includes(
          error.code,
        )
      )
        return json({
          available: false,
          message: "区域视觉学习服务尚未配置完整，区域图片不会上传。",
        });
      throw error;
    }
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  let reservation:
    | {
        store: ReturnType<typeof createRequestStore>;
        ownerId: string;
        requestId: string;
      }
    | undefined;
  let reservationCleanup: Promise<void> | undefined;
  let traceRecorder: ReturnType<typeof createTraceRecorder> | undefined;
  let traceOutcome:
    "completed" | "insufficient" | "failed" | "cancelled" | "cached" | "extractive" = "failed";
  let traceErrorCode: string | undefined;
  let traceModelName: string | undefined;
  let traceModelProfile: ModelProfileName | undefined;
  const failReservation = (error: unknown): Promise<void> => {
    if (reservationCleanup) return reservationCleanup;
    const pending = reservation;
    reservation = undefined;
    if (!pending) return Promise.resolve();
    reservationCleanup = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          finishRequest(
            pending.store,
            pending.ownerId,
            pending.requestId,
            undefined,
            error instanceof ApiError ? error.code : "VISION_REQUEST_FAILED",
          ),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, LEDGER_CLEANUP_MS);
          }),
        ]);
      } catch {
        /* The original safe error remains authoritative when cleanup fails. */
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    return reservationCleanup;
  };

  try {
    const { supabase, user } = await requireUser(request);
    if (request.signal.aborted) throw cancelled();
    let body: unknown;
    try {
      body = await readJson(request, VISION_REGION_MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof ApiError && error.code === "TOO_LARGE")
        throw new ApiError(413, "VISION_IMAGE_TOO_LARGE", "区域图片过大，请缩小后重试。");
      throw error;
    }
    const parsed = visionStudyRequestSchema.safeParse(body);
    if (!parsed.success)
      throw new ApiError(400, "INVALID_VISION_REQUEST", "请重新截取区域并检查学习任务。");
    const input: VisionStudyRequest = parsed.data;
    traceRecorder = createTraceRecorder("vision", user.id, input.requestId);
    const image = validateVisionImage(input.image);
    const initial = await loadWorkspace(supabase, user.id);
    assertVisionSource(initial, input);
    const pageText = pageTextForRequest(initial, input);
    const contextKey = visionSourceContextKey(initial, input);
    if (request.signal.aborted) throw cancelled();

    const selectedProfile = readModelProfile("vision");
    const config = selectedProfile?.config;
    if (!selectedProfile || !config)
      throw new ApiError(
        503,
        "VISION_MODEL_NOT_CONFIGURED",
        "尚未启用支持图片输入的模型，本次区域图片未发送。",
      );
    // This must succeed before the first provider call. Missing privileged
    // credentials or migrations fail closed rather than bypassing the ledger.
    const store = createRequestStore();
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          VISION_STUDY_SEMANTICS_VERSION,
          config.baseUrl,
          config.model,
          config.jsonMode,
          config.thinkingMode ?? null,
          config.tokenLimitParameter,
          selectedProfile.profile,
          input.task,
          input.question ?? null,
          input.provenance,
          pageText ?? null,
          input.history ?? null,
          image.mimeType,
          image.width,
          image.height,
          image.sha256,
        ]),
      )
      .digest("hex");
    const saved = await reserveRequest(store, user.id, input.requestId, fingerprint);
    if (saved.kind === "reserved")
      reservation = { store, ownerId: user.id, requestId: input.requestId };

    const assertCurrent = async () => {
      if (request.signal.aborted) throw cancelled();
      const auth = await requireUser(request);
      if (auth.user.id !== user.id)
        throw new ApiError(409, "SESSION_CHANGED", "当前账号已改变，本次区域视觉学习结果未保存。");
      const latest = await loadWorkspace(auth.supabase, user.id);
      if (visionSourceContextKey(latest, input) !== contextKey)
        throw new ApiError(
          409,
          "VISION_CONTEXT_CHANGED",
          "资料版本、页面范围或 AI 权限已改变，请重新截取区域。",
        );
    };

    // A reservation may wait behind another request. Revalidate before sending
    // pixels to the provider or returning a cached result.
    await assertCurrent();
    let result;
    if (saved.kind === "cached") {
      const cached = visionStudyResultSchema.safeParse(saved.result);
      if (
        !cached.success ||
        cached.data.task !== input.task ||
        !sameVisionProvenance(cached.data.provenance, input.provenance)
      )
        throw new ApiError(
          503,
          "INVALID_SAVED_VISION_RESULT",
          "已保存的区域视觉学习结果无法读取，请重新发起请求。",
        );
      result = cached.data;
      traceOutcome = "cached";
    } else {
      traceRecorder.mark("modelStart");
      const raw = aiFeatureEnabled("AI_TRACES")
        ? await callVisionModel(
            config,
            visionStudyMessages(input, pageText),
            { mimeType: image.mimeType, base64: image.base64 },
            request.signal,
            { onUsage: (usage) => traceRecorder?.addUsage(usage) },
          )
        : await callVisionModel(
            config,
            visionStudyMessages(input, pageText),
            { mimeType: image.mimeType, base64: image.base64 },
            request.signal,
          );
      result = bindVisionStudyResult(raw, input);
      traceRecorder.mark("modelEnd");
      traceOutcome = "completed";
    }
    traceModelName = config.model;
    traceModelProfile = selectedProfile.profile;
    await assertCurrent();
    if (reservation) {
      await finishRequest(store, user.id, input.requestId, result);
      reservation = undefined;
      await assertCurrent();
    }
    void traceRecorder?.finish(traceOutcome, {
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
    void traceRecorder?.finish(traceOutcome, {
      errorCode: traceErrorCode,
      modelProfile: traceModelProfile ?? "default",
      modelName: traceModelName,
    });
    await failReservation(error);
    return failure(error);
  }
}
