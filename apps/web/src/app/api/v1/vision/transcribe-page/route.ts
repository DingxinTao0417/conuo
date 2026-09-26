import { ApiError, failure, json, readJson, requireUser } from "@/lib/supabase/api";
import { workspaceSchema } from "@/lib/supabase/validation";
import { callVisionModel, readModelProfile } from "@/lib/ai/model";
import { createRequestStore } from "@/lib/ai/requests";
import {
  bindPageTranscriptionResult,
  pageTranscriptionMessages,
  pageTranscriptionRequestSchema,
  reserveOcrPages,
  validatePageTranscriptionImage,
} from "@/lib/ai/page-transcription";
import { VISION_REGION_MAX_BODY_BYTES } from "@/lib/vision-region-contract";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

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

function assertTranscriptionSource(
  workspace: Awaited<ReturnType<typeof loadWorkspace>>,
  sourceId: string,
  versionId: string,
  page: number,
) {
  if (!workspace.aiEnabled)
    throw new ApiError(403, "AI_DISABLED", "请先开启 AI，再使用扫描件识别。");
  const source = workspace.sources.find((item) => item.id === sourceId);
  if (!source || source.deletedAt)
    throw new ApiError(404, "VISION_SOURCE_NOT_FOUND", "这份资料已不可用，请返回资料库后重试。");
  if (source.kind !== "pdf")
    throw new ApiError(422, "VISION_PDF_REQUIRED", "扫描件识别仅支持 PDF 资料。");
  if (source.versionId !== versionId)
    throw new ApiError(
      409,
      "VISION_SOURCE_VERSION_CHANGED",
      "资料版本已改变，请重新识别当前版本。",
    );
  if (!source.aiAllowed)
    throw new ApiError(403, "SOURCE_AI_DISABLED", "这份资料不允许用于 AI，请先调整资料权限。");
  if (source.pageCount !== undefined && page > source.pageCount)
    throw new ApiError(409, "VISION_PAGE_CHANGED", "所选页面已不在当前资料版本中，请重新识别。");
}

export async function POST(request: Request) {
  try {
    const { supabase, user } = await requireUser(request);
    let body: unknown;
    try {
      body = await readJson(request, VISION_REGION_MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof ApiError && error.code === "TOO_LARGE")
        throw new ApiError(413, "VISION_IMAGE_TOO_LARGE", "页面图片过大，请缩小后重试。");
      throw error;
    }
    const parsed = pageTranscriptionRequestSchema.safeParse(body);
    if (!parsed.success)
      throw new ApiError(400, "INVALID_VISION_REQUEST", "请重新选择 PDF 页面并重试。");
    const input = parsed.data;
    const image = validatePageTranscriptionImage(input.image);
    const workspace = await loadWorkspace(supabase, user.id);
    assertTranscriptionSource(workspace, input.sourceId, input.versionId, input.page);
    const selectedProfile = readModelProfile("vision");
    const config = selectedProfile?.config;
    if (!selectedProfile || !config)
      throw new ApiError(
        503,
        "VISION_MODEL_NOT_CONFIGURED",
        "尚未启用支持图片输入的模型，本次页面图片未发送。",
      );
    const ledger = createRequestStore();
    await reserveOcrPages(user.id, input.requestId, ledger);
    let promptTokens = 0;
    let completionTokens = 0;
    const raw = await callVisionModel(
      config,
      pageTranscriptionMessages(),
      { mimeType: image.mimeType, base64: image.base64 },
      request.signal,
      {
        onUsage: (usage) => {
          if (Number.isSafeInteger(usage.promptTokens) && usage.promptTokens! >= 0)
            promptTokens += usage.promptTokens!;
          if (Number.isSafeInteger(usage.completionTokens) && usage.completionTokens! >= 0)
            completionTokens += usage.completionTokens!;
        },
      },
    );
    if (promptTokens || completionTokens)
      await ledger.rpc("record_ai_token_usage", {
        p_owner: user.id,
        p_request_id: input.requestId,
        p_route: "ocr",
        p_prompt_tokens: promptTokens,
        p_completion_tokens: completionTokens,
      });
    return json({ page: input.page, markdown: bindPageTranscriptionResult(raw) });
  } catch (error) {
    return failure(error);
  }
}
