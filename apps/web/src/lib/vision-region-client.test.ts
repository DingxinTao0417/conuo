// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PdfCaptureResult } from "@/components/pdf-capture";
import {
  getVisionRegionAvailability,
  requestVisionRegionStudy,
  VisionRegionClientError,
  visionCaptureDataUrl,
} from "./vision-region-client";

const capture: PdfCaptureResult = {
  identity: { sourceId: "source-one", versionId: "version-one", page: 3 },
  region: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
  pixelRegion: { x: 10, y: 20, width: 320, height: 240 },
  blob: new Blob([Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)], { type: "image/jpeg" }),
  mimeType: "image/jpeg",
  width: 320,
  height: 240,
  bytes: 4,
};

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("vision region client", () => {
  it("checks readiness with no body before any image is encoded", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({ available: true, message: "区域视觉学习已就绪。" }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(getVisionRegionAvailability("account-one")).resolves.toEqual({
      available: true,
      message: "区域视觉学习已就绪。",
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "/api/v1/vision/region-study",
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "X-Conuo-User": "account-one" },
      }),
    );
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty("body");
  });

  it("sends one inline capture with immutable page provenance", async () => {
    const response = {
      mode: "vision",
      task: "ask",
      provenance: {
        sourceId: "source-one",
        versionId: "version-one",
        page: 3,
        region: capture.region,
      },
      visibleText: "x = u + 1",
      content: "这一步使用了变量替换。",
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(response));
    vi.stubGlobal("fetch", fetch);

    await expect(
      requestVisionRegionStudy(
        {
          capture,
          task: "ask",
          question: "这里做了什么？",
          requestId: "request-one",
        },
        "account-one",
      ),
    ).resolves.toEqual(response);

    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      requestId: "request-one",
      task: "ask",
      question: "这里做了什么？",
      provenance: {
        sourceId: "source-one",
        versionId: "version-one",
        page: 3,
        region: capture.region,
      },
      image: { width: 320, height: 240 },
    });
    expect(body.image.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(init.headers).toEqual({
      "X-Conuo-User": "account-one",
      "Content-Type": "application/json",
    });
  });

  it("sends same-region follow-up history with the next request", async () => {
    const response = {
      mode: "vision",
      task: "ask",
      provenance: {
        sourceId: "source-one",
        versionId: "version-one",
        page: 3,
        region: capture.region,
      },
      content: "继续解释。",
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(response));
    vi.stubGlobal("fetch", fetch);
    await requestVisionRegionStudy(
      {
        capture,
        task: "ask",
        question: "继续解释？",
        history: [{ question: "上一问", answer: "上一答" }],
        requestId: "request-two",
      },
      "account-one",
    );
    const body = JSON.parse(String((fetch.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.history).toEqual([{ question: "上一问", answer: "上一答" }]);
  });

  it("rejects a response rebound to another page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          mode: "vision",
          task: "explain",
          provenance: {
            sourceId: "source-one",
            versionId: "version-one",
            page: 4,
            region: capture.region,
          },
          content: "错误页面的结果",
        }),
      ),
    );

    await expect(
      requestVisionRegionStudy(
        { capture, task: "explain", requestId: "request-one" },
        "account-one",
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects unsupported or oversized local blobs before fetch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      visionCaptureDataUrl(new Blob(["x"], { type: "image/gif" })),
    ).rejects.toBeInstanceOf(VisionRegionClientError);
    await expect(
      visionCaptureDataUrl(new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: "image/png" })),
    ).rejects.toMatchObject({ code: "INVALID_IMAGE" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces sanitized server errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ error: "这份资料不允许用于 AI。", code: "SOURCE_AI_DISABLED" }, { status: 403 }),
      ),
    );

    await expect(
      requestVisionRegionStudy({ capture, task: "quiz", requestId: "request-one" }, "account-one"),
    ).rejects.toMatchObject({
      status: 403,
      code: "SOURCE_AI_DISABLED",
      message: "这份资料不允许用于 AI。",
    });
  });
});
