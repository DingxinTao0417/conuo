"use client";

import { z } from "zod";
import type { PdfCaptureResult } from "@/components/pdf-capture";
import { notifyAiUsageChanged } from "./ai-request-usage";
import { observeAccountDeletionFailure } from "./account-deletion-observer";
import {
  VISION_REGION_MAX_IMAGE_BYTES,
  sameVisionProvenance,
  visionStudyRequestSchema,
  visionStudyResultSchema,
  type VisionStudyResult,
} from "./vision-region-contract";

const availabilitySchema = z
  .object({
    available: z.boolean(),
    message: z.string().trim().min(1).max(1_000),
  })
  .strict();

export type VisionRegionAvailability = z.infer<typeof availabilitySchema>;

export class VisionRegionClientError extends Error {
  localCleanupFailed = false;
  constructor(
    message: string,
    public status = 500,
    public code = "VISION_REGION_ERROR",
  ) {
    super(message);
    this.name = "VisionRegionClientError";
  }
}

function cancelled() {
  return new VisionRegionClientError("已停止这次区域视觉学习。", 499, "VISION_REGION_CANCELLED");
}

async function responseJson(response: Response, expectedUserId: string): Promise<unknown> {
  const mime = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (!mime || !/^application\/(?:[a-z0-9.+-]+\+)?json$/.test(mime))
    throw new VisionRegionClientError(
      "区域视觉学习服务返回了无法读取的内容。",
      502,
      "INVALID_RESPONSE",
    );
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const record = body && typeof body === "object" && !Array.isArray(body) ? body : null;
    const message =
      record && "error" in record && typeof record.error === "string"
        ? record.error
        : "区域视觉学习暂时不可用，请稍后重试。";
    const code =
      record && "code" in record && typeof record.code === "string"
        ? record.code
        : "VISION_REGION_REQUEST_FAILED";
    const error = new VisionRegionClientError(message, response.status, code);
    const observation = await observeAccountDeletionFailure(error, expectedUserId);
    error.localCleanupFailed = observation.cleanupFailed;
    throw error;
  }
  return body;
}

function headers(expectedUserId: string) {
  if (!expectedUserId)
    throw new VisionRegionClientError("请先登录并确认资料已同步到云端。", 401, "UNAUTHENTICATED");
  return { "X-Conuo-User": expectedUserId };
}

export async function getVisionRegionAvailability(
  expectedUserId: string,
  signal?: AbortSignal,
): Promise<VisionRegionAvailability> {
  if (signal?.aborted) throw cancelled();
  let response: Response;
  try {
    response = await fetch("/api/v1/vision/region-study", {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal,
      headers: headers(expectedUserId),
    });
  } catch (cause) {
    if (signal?.aborted) throw cancelled();
    if (cause instanceof VisionRegionClientError) throw cause;
    throw new VisionRegionClientError(
      "无法连接区域视觉学习服务，请检查网络后重试。",
      502,
      "CONNECTION_FAILED",
    );
  }
  const parsed = availabilitySchema.safeParse(await responseJson(response, expectedUserId));
  if (!parsed.success)
    throw new VisionRegionClientError("区域视觉学习服务状态格式无效。", 502, "INVALID_RESPONSE");
  return parsed.data;
}

/** Converts only the already-bounded local capture; no URL or external resource is fetched. */
export function visionCaptureDataUrl(blob: Blob, signal?: AbortSignal): Promise<string> {
  if (!blob.size || blob.size > VISION_REGION_MAX_IMAGE_BYTES)
    return Promise.reject(
      new VisionRegionClientError(
        "区域截图大小不符合要求，请缩小区域后重试。",
        400,
        "INVALID_IMAGE",
      ),
    );
  if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(blob.type))
    return Promise.reject(
      new VisionRegionClientError("区域截图格式不受支持，请重新框选。", 400, "INVALID_IMAGE"),
    );
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const onAbort = () => reader.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    reader.onload = () => {
      signal?.removeEventListener("abort", onAbort);
      if (typeof reader.result === "string") resolve(reader.result);
      else
        reject(new VisionRegionClientError("无法读取区域截图，请重新框选。", 400, "INVALID_IMAGE"));
    };
    reader.onerror = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new VisionRegionClientError("无法读取区域截图，请重新框选。", 400, "INVALID_IMAGE"));
    };
    reader.onabort = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(cancelled());
    };
    reader.readAsDataURL(blob);
  });
}

export async function requestVisionRegionStudy(
  input: {
    capture: PdfCaptureResult;
    task: "explain" | "ask" | "quiz";
    question?: string;
    requestId: string;
  },
  expectedUserId: string,
  signal?: AbortSignal,
): Promise<VisionStudyResult> {
  const dataUrl = await visionCaptureDataUrl(input.capture.blob, signal);
  if (signal?.aborted) throw cancelled();
  const request = visionStudyRequestSchema.safeParse({
    requestId: input.requestId,
    task: input.task,
    provenance: {
      sourceId: input.capture.identity.sourceId,
      versionId: input.capture.identity.versionId,
      page: input.capture.identity.page,
      region: input.capture.region,
    },
    image: { dataUrl, width: input.capture.width, height: input.capture.height },
    ...(input.task === "ask" ? { question: input.question?.trim() } : {}),
  });
  if (!request.success)
    throw new VisionRegionClientError(
      "区域视觉学习参数无效，请重新框选后再试。",
      400,
      "INVALID_REQUEST",
    );

  let response: Response;
  try {
    response = await fetch("/api/v1/vision/region-study", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal,
      headers: { ...headers(expectedUserId), "Content-Type": "application/json" },
      body: JSON.stringify(request.data),
    }).finally(notifyAiUsageChanged);
  } catch (cause) {
    if (signal?.aborted) throw cancelled();
    if (cause instanceof VisionRegionClientError) throw cause;
    throw new VisionRegionClientError(
      "区域图片发送失败，请检查网络后重试。",
      502,
      "CONNECTION_FAILED",
    );
  }
  const parsed = visionStudyResultSchema.safeParse(await responseJson(response, expectedUserId));
  if (!parsed.success || !sameVisionProvenance(parsed.data.provenance, request.data.provenance))
    throw new VisionRegionClientError(
      "区域视觉学习结果与当前截图不匹配，请重新框选。",
      502,
      "INVALID_RESPONSE",
    );
  return parsed.data;
}
