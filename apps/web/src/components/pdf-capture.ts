export interface PdfCaptureIdentity {
  sourceId: string;
  versionId: string;
  page: number;
}

/** Coordinates are fractions of the rendered PDF page, so they survive zoom and resize. */
export interface PdfCaptureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfCapturePoint {
  x: number;
  y: number;
}

export interface PdfCaptureSelection {
  identity: PdfCaptureIdentity;
  region: PdfCaptureRegion;
}

export interface PdfCapturePixelRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PdfCaptureMimeType = "image/jpeg" | "image/png" | "image/webp";

export interface PdfCaptureLimits {
  maxOutputPixels: number;
  maxOutputEdge: number;
  maxBytes: number;
  mimeType: PdfCaptureMimeType;
  initialQuality: number;
  minQuality: number;
}

export interface PdfCaptureResult extends PdfCaptureSelection {
  pixelRegion: PdfCapturePixelRegion;
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
}

interface PdfCaptureCanvasFactory {
  createCanvas: () => HTMLCanvasElement;
}

export type CapturePdfCanvasRegionOptions = Partial<PdfCaptureLimits> &
  Partial<PdfCaptureCanvasFactory>;

interface ObjectUrlApi {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
}

/**
 * Hard client-side ceilings. Callers may request smaller outputs but cannot raise these limits.
 * The defaults keep visual-model uploads bounded without degrading ordinary text-sized selections.
 */
export const PDF_CAPTURE_HARD_LIMITS: Readonly<PdfCaptureLimits> = Object.freeze({
  maxOutputPixels: 3_000_000,
  maxOutputEdge: 2_048,
  maxBytes: 1_500_000,
  mimeType: "image/jpeg",
  initialQuality: 0.9,
  minQuality: 0.5,
});

export class PdfCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfCaptureError";
  }
}

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function positiveIntegerAtMost(value: number | undefined, ceiling: number) {
  return Math.min(ceiling, Math.max(1, Math.floor(finiteOr(value ?? ceiling, ceiling))));
}

export function clampPdfCapturePoint(point: PdfCapturePoint): PdfCapturePoint {
  return {
    x: clamp(finiteOr(point.x, 0), 0, 1),
    y: clamp(finiteOr(point.y, 0), 0, 1),
  };
}

export function pdfCaptureRegionFromPoints(
  first: PdfCapturePoint,
  second: PdfCapturePoint,
): PdfCaptureRegion {
  const start = clampPdfCapturePoint(first);
  const end = clampPdfCapturePoint(second);
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function clampPdfCaptureRegion(region: PdfCaptureRegion): PdfCaptureRegion {
  const first = clampPdfCapturePoint({ x: region.x, y: region.y });
  const second = clampPdfCapturePoint({
    x: finiteOr(region.x, 0) + finiteOr(region.width, 0),
    y: finiteOr(region.y, 0) + finiteOr(region.height, 0),
  });
  return pdfCaptureRegionFromPoints(first, second);
}

export function pdfCaptureRegionToPixels(
  region: PdfCaptureRegion,
  canvasWidth: number,
  canvasHeight: number,
): PdfCapturePixelRegion {
  const width = Math.floor(finiteOr(canvasWidth, 0));
  const height = Math.floor(finiteOr(canvasHeight, 0));
  if (width < 1 || height < 1) throw new PdfCaptureError("PDF 页面尚未完成渲染，请稍后重试。");

  const normalized = clampPdfCaptureRegion(region);
  const left = clamp(Math.floor(normalized.x * width), 0, width - 1);
  const top = clamp(Math.floor(normalized.y * height), 0, height - 1);
  const right = clamp(Math.ceil((normalized.x + normalized.width) * width), left + 1, width);
  const bottom = clamp(Math.ceil((normalized.y + normalized.height) * height), top + 1, height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function resolvedLimits(options: CapturePdfCanvasRegionOptions): PdfCaptureLimits {
  const initialQuality = clamp(finiteOr(options.initialQuality ?? 0.9, 0.9), 0.1, 0.95);
  const minQuality = clamp(
    finiteOr(options.minQuality ?? PDF_CAPTURE_HARD_LIMITS.minQuality, 0.5),
    0.1,
    initialQuality,
  );
  const requestedMime = options.mimeType;
  const mimeType: PdfCaptureMimeType = ["image/jpeg", "image/png", "image/webp"].includes(
    requestedMime || "",
  )
    ? (requestedMime as PdfCaptureMimeType)
    : PDF_CAPTURE_HARD_LIMITS.mimeType;
  return {
    maxOutputPixels: positiveIntegerAtMost(
      options.maxOutputPixels,
      PDF_CAPTURE_HARD_LIMITS.maxOutputPixels,
    ),
    maxOutputEdge: positiveIntegerAtMost(
      options.maxOutputEdge,
      PDF_CAPTURE_HARD_LIMITS.maxOutputEdge,
    ),
    maxBytes: positiveIntegerAtMost(options.maxBytes, PDF_CAPTURE_HARD_LIMITS.maxBytes),
    mimeType,
    initialQuality,
    minQuality,
  };
}

function fitOutputDimensions(
  width: number,
  height: number,
  limits: Pick<PdfCaptureLimits, "maxOutputEdge" | "maxOutputPixels">,
) {
  const scale = Math.min(
    1,
    limits.maxOutputEdge / width,
    limits.maxOutputEdge / height,
    Math.sqrt(limits.maxOutputPixels / (width * height)),
  );
  let outputWidth = Math.max(1, Math.floor(width * scale));
  let outputHeight = Math.max(1, Math.floor(height * scale));
  while (outputWidth * outputHeight > limits.maxOutputPixels) {
    if (outputWidth >= outputHeight) outputWidth -= 1;
    else outputHeight -= 1;
  }
  return { width: outputWidth, height: outputHeight };
}

function defaultCanvasFactory() {
  if (typeof document === "undefined")
    throw new PdfCaptureError("当前环境无法创建图片，请在浏览器中重试。");
  return document.createElement("canvas");
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: PdfCaptureMimeType, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => {
          if (blob && blob.size > 0) resolve(blob);
          else reject(new PdfCaptureError("未能生成截图，请重新框选后再试。"));
        },
        mimeType,
        quality,
      );
    } catch {
      reject(new PdfCaptureError("当前 PDF 页面无法安全生成截图。"));
    }
  });
}

/**
 * Copies the chosen pixels immediately into an isolated canvas, then encodes a bounded image.
 * No object URL is created and no network request is made here.
 */
export async function capturePdfCanvasRegion(
  sourceCanvas: HTMLCanvasElement,
  selection: PdfCaptureSelection,
  options: CapturePdfCanvasRegionOptions = {},
): Promise<PdfCaptureResult> {
  const limits = resolvedLimits(options);
  const normalizedRegion = clampPdfCaptureRegion(selection.region);
  if (normalizedRegion.width <= 0 || normalizedRegion.height <= 0)
    throw new PdfCaptureError("请先框选一个有内容的区域。");

  const pixelRegion = pdfCaptureRegionToPixels(
    normalizedRegion,
    sourceCanvas.width,
    sourceCanvas.height,
  );
  let outputSize = fitOutputDimensions(pixelRegion.width, pixelRegion.height, limits);
  const outputCanvas = (options.createCanvas || defaultCanvasFactory)();
  let lastBlob: Blob | undefined;
  let quality = limits.initialQuality;
  let drawnWidth = 0;
  let drawnHeight = 0;

  try {
    for (let attempt = 0; attempt < 18; attempt += 1) {
      if (drawnWidth !== outputSize.width || drawnHeight !== outputSize.height) {
        outputCanvas.width = outputSize.width;
        outputCanvas.height = outputSize.height;
        const context = outputCanvas.getContext("2d");
        if (!context) throw new PdfCaptureError("当前浏览器无法生成区域截图。");
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, outputSize.width, outputSize.height);
        context.drawImage(
          sourceCanvas,
          pixelRegion.x,
          pixelRegion.y,
          pixelRegion.width,
          pixelRegion.height,
          0,
          0,
          outputSize.width,
          outputSize.height,
        );
        drawnWidth = outputSize.width;
        drawnHeight = outputSize.height;
      }

      lastBlob = await canvasToBlob(outputCanvas, limits.mimeType, quality);
      if (lastBlob.size <= limits.maxBytes) {
        return {
          identity: { ...selection.identity },
          region: normalizedRegion,
          pixelRegion,
          blob: lastBlob,
          mimeType: lastBlob.type || limits.mimeType,
          width: outputSize.width,
          height: outputSize.height,
          bytes: lastBlob.size,
        };
      }

      const supportsQuality = limits.mimeType !== "image/png";
      if (supportsQuality && quality > limits.minQuality) {
        quality = Math.max(limits.minQuality, Math.round((quality - 0.1) * 100) / 100);
        continue;
      }

      const byteScale = Math.sqrt(limits.maxBytes / lastBlob.size) * 0.92;
      const scale = Math.min(0.86, finiteOr(byteScale, 0.75));
      const next = {
        width: Math.max(1, Math.floor(outputSize.width * scale)),
        height: Math.max(1, Math.floor(outputSize.height * scale)),
      };
      if (next.width === outputSize.width && next.height === outputSize.height) break;
      outputSize = next;
    }
  } finally {
    // Release the potentially large backing store once the Blob owns the encoded bytes.
    outputCanvas.width = 1;
    outputCanvas.height = 1;
  }

  throw new PdfCaptureError(
    `截图压缩后仍超过 ${Math.ceil(limits.maxBytes / 1024)} KB，请缩小框选区域。`,
  );
}

/** Runs a preview-only callback and always revokes its temporary object URL. */
export async function withPdfCaptureObjectUrl<T>(
  blob: Blob,
  visitUrl: (url: string) => T | Promise<T>,
  urlApi: ObjectUrlApi = URL,
): Promise<T> {
  const url = urlApi.createObjectURL(blob);
  try {
    return await visitUrl(url);
  } finally {
    urlApi.revokeObjectURL(url);
  }
}
