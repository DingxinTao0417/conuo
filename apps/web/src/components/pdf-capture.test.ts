import { describe, expect, it, vi } from "vitest";
import {
  PDF_CAPTURE_HARD_LIMITS,
  PdfCaptureError,
  capturePdfCanvasRegion,
  clampPdfCaptureRegion,
  pdfCaptureRegionFromPoints,
  pdfCaptureRegionToPixels,
  withPdfCaptureObjectUrl,
  type PdfCaptureSelection,
} from "./pdf-capture";

const identity = { sourceId: "source-a", versionId: "version-7", page: 4 };

function fakeSourceCanvas(width: number, height: number) {
  return { width, height } as HTMLCanvasElement;
}

function encodingCanvas() {
  const drawImage = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
      fillStyle: "",
      fillRect: vi.fn(),
      drawImage,
    })),
    toBlob: vi.fn((callback: BlobCallback, mimeType?: string, quality?: number) => {
      const estimatedBytes = Math.max(1, Math.ceil(canvas.width * canvas.height * (quality ?? 1)));
      callback(new Blob([new Uint8Array(estimatedBytes)], { type: mimeType }));
    }),
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, drawImage };
}

describe("PDF capture coordinates", () => {
  it("clamps reverse drags to the page and produces a canonical normalized region", () => {
    expect(pdfCaptureRegionFromPoints({ x: 1.4, y: 0.8 }, { x: -0.2, y: 0.1 })).toEqual({
      x: 0,
      y: 0.1,
      width: 1,
      height: 0.7000000000000001,
    });
    expect(clampPdfCaptureRegion({ x: 0.8, y: 0.7, width: -0.5, height: 0.7 })).toEqual({
      x: 0.30000000000000004,
      y: 0.7,
      width: 0.5,
      height: 0.30000000000000004,
    });
  });

  it("keeps the same semantic region when a PDF canvas is rendered at another zoom", () => {
    const region = { x: 0.1, y: 0.2, width: 0.5, height: 0.25 };
    expect(pdfCaptureRegionToPixels(region, 1_000, 2_000)).toEqual({
      x: 100,
      y: 400,
      width: 500,
      height: 500,
    });
    expect(pdfCaptureRegionToPixels(region, 2_000, 4_000)).toEqual({
      x: 200,
      y: 800,
      width: 1_000,
      height: 1_000,
    });
  });

  it("rejects an unrendered page instead of binding coordinates to unknown pixels", () => {
    expect(() => pdfCaptureRegionToPixels({ x: 0, y: 0, width: 1, height: 1 }, 0, 800)).toThrow(
      PdfCaptureError,
    );
  });
});

describe("PDF canvas capture", () => {
  const selection: PdfCaptureSelection = {
    identity,
    region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
  };

  it("copies the exact selected pixels and scales until pixel and byte limits are satisfied", async () => {
    const target = encodingCanvas();
    const result = await capturePdfCanvasRegion(fakeSourceCanvas(4_000, 2_000), selection, {
      maxOutputPixels: 10_000,
      maxOutputEdge: 100,
      maxBytes: 2_000,
      createCanvas: () => target.canvas,
    });

    expect(result.identity).toEqual(identity);
    expect(result.region).toEqual(selection.region);
    expect(result.pixelRegion).toEqual({ x: 1_000, y: 500, width: 2_000, height: 1_000 });
    expect(result.width).toBeLessThanOrEqual(100);
    expect(result.height).toBeLessThanOrEqual(100);
    expect(result.width * result.height).toBeLessThanOrEqual(10_000);
    expect(result.bytes).toBeLessThanOrEqual(2_000);
    expect(result.mimeType).toBe("image/jpeg");
    expect(target.drawImage).toHaveBeenCalledWith(
      expect.anything(),
      1_000,
      500,
      2_000,
      1_000,
      0,
      0,
      result.width,
      result.height,
    );
    expect(target.canvas.width).toBe(1);
    expect(target.canvas.height).toBe(1);
  });

  it("does not allow callers to raise the visual-model payload hard ceilings", async () => {
    const target = encodingCanvas();
    const result = await capturePdfCanvasRegion(
      fakeSourceCanvas(5_000, 5_000),
      { identity, region: { x: 0, y: 0, width: 1, height: 1 } },
      {
        maxOutputPixels: Number.MAX_SAFE_INTEGER,
        maxOutputEdge: Number.MAX_SAFE_INTEGER,
        maxBytes: Number.MAX_SAFE_INTEGER,
        createCanvas: () => target.canvas,
      },
    );

    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(
      PDF_CAPTURE_HARD_LIMITS.maxOutputEdge,
    );
    expect(result.width * result.height).toBeLessThanOrEqual(
      PDF_CAPTURE_HARD_LIMITS.maxOutputPixels,
    );
    expect(result.bytes).toBeLessThanOrEqual(PDF_CAPTURE_HARD_LIMITS.maxBytes);
  });

  it("rejects an empty selection before allocating an output canvas", async () => {
    const createCanvas = vi.fn();
    await expect(
      capturePdfCanvasRegion(
        fakeSourceCanvas(400, 400),
        { identity, region: { x: 0.2, y: 0.2, width: 0, height: 0.4 } },
        { createCanvas },
      ),
    ).rejects.toThrow("有内容的区域");
    expect(createCanvas).not.toHaveBeenCalled();
  });
});

describe("temporary PDF capture URLs", () => {
  it("revokes the URL after successful and failed consumers", async () => {
    const urlApi = {
      createObjectURL: vi.fn(() => "blob:pdf-capture"),
      revokeObjectURL: vi.fn(),
    };
    const blob = new Blob(["capture"], { type: "image/jpeg" });

    await expect(withPdfCaptureObjectUrl(blob, async (url) => `${url}:used`, urlApi)).resolves.toBe(
      "blob:pdf-capture:used",
    );
    expect(urlApi.revokeObjectURL).toHaveBeenLastCalledWith("blob:pdf-capture");

    await expect(
      withPdfCaptureObjectUrl(
        blob,
        () => {
          throw new Error("preview failed");
        },
        urlApi,
      ),
    ).rejects.toThrow("preview failed");
    expect(urlApi.createObjectURL).toHaveBeenCalledTimes(2);
    expect(urlApi.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
});
