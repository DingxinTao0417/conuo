import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { deleteDB } from "idb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getVisionRegionAvailability, requestVisionRegionStudy } from "./vision-region-client";
import { subscribeConfirmedAccountDeletions } from "./account-deletion-observer";
import type { PdfCaptureResult } from "@/components/pdf-capture";
import { isAccountLocallyDeleted, saveLocalWorkspace } from "./local-store";
import { createEmptyWorkspace } from "./seed";
import { KNOWLEDGE_UPDATE_DRAFT_DATABASE } from "./knowledge-update-review-drafts";
beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
const subscriptions: (() => void)[] = [];
afterEach(async () => {
  for (const stop of subscriptions.splice(0)) stop();
  await deleteDB("conuo-web");
  await deleteDB(KNOWLEDGE_UPDATE_DRAFT_DATABASE);
  vi.unstubAllGlobals();
});
describe("vision deletion observation", () => {
  it("establishes the same actor-bound local fence for explicit vision readiness denial", async () => {
    await saveLocalWorkspace(createEmptyWorkspace(), "A", 0);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code: "ACCOUNT_DELETION_PENDING", error: "账号已停止访问。" },
          { status: 423 },
        ),
      ),
    );
    await expect(getVisionRegionAvailability("A")).rejects.toMatchObject({
      status: 423,
      code: "ACCOUNT_DELETION_PENDING",
    });
    expect(await isAccountLocallyDeleted("A")).toBe(true);
  });

  it.each([
    [401, "UNAUTHENTICATED"],
    [401, "ACCOUNT_DELETION_PENDING"],
    [423, "OTHER_LOCK"],
    [503, "VISION_REGION_ERROR"],
  ])("preserves nonproof HTTP %s/%s without notifying", async (status, code) => {
    await saveLocalWorkspace(createEmptyWorkspace(), "A", 0);
    const listener = vi.fn();
    subscriptions.push(subscribeConfirmedAccountDeletions(listener));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ code, error: "same error" }, { status })),
    );
    await expect(getVisionRegionAvailability("A")).rejects.toMatchObject({
      status,
      code,
      message: "same error",
      localCleanupFailed: false,
    });
    expect(listener).not.toHaveBeenCalled();
    expect(await isAccountLocallyDeleted("A")).toBe(false);
  });

  it("does not treat non-JSON denial as an authoritative account status", async () => {
    await saveLocalWorkspace(createEmptyWorkspace(), "A", 0);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: "ACCOUNT_DELETION_PENDING" }), {
            status: 423,
            headers: { "Content-Type": "text/plain" },
          }),
      ),
    );
    await expect(getVisionRegionAvailability("A")).rejects.toMatchObject({
      status: 502,
      code: "INVALID_RESPONSE",
    });
    expect(await isAccountLocallyDeleted("A")).toBe(false);
  });

  it("captures A for POST image denial and never transmits image or question through the observer", async () => {
    await saveLocalWorkspace(createEmptyWorkspace(), "A", 0);
    await saveLocalWorkspace(createEmptyWorkspace(), "B", 0);
    class TestFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      readAsDataURL(blob: Blob) {
        void blob.arrayBuffer().then((bytes) => {
          this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
          this.onload?.();
        });
      }
      abort() {
        this.onabort?.();
      }
    }
    vi.stubGlobal("FileReader", TestFileReader);
    const capture: PdfCaptureResult = {
      identity: { sourceId: "source-one", versionId: "version-one", page: 1 },
      region: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
      pixelRegion: { x: 10, y: 20, width: 320, height: 240 },
      blob: new Blob([Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)], { type: "image/jpeg" }),
      mimeType: "image/jpeg",
      width: 320,
      height: 240,
      bytes: 4,
    };
    const listener = vi.fn();
    subscriptions.push(subscribeConfirmedAccountDeletions(listener));
    const fetch = vi.fn(async () =>
      Response.json({ code: "ACCOUNT_DELETION_PENDING", error: "A stopped" }, { status: 423 }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      requestVisionRegionStudy(
        { capture, task: "ask", question: "private image question", requestId: "request-one" },
        "A",
      ),
    ).rejects.toMatchObject({
      status: 423,
      code: "ACCOUNT_DELETION_PENDING",
      message: "A stopped",
      localCleanupFailed: false,
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/vision/region-study",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Conuo-User": "A" }),
      }),
    );
    expect(listener).toHaveBeenCalledExactlyOnceWith("A");
    expect(await isAccountLocallyDeleted("A")).toBe(true);
    expect(await isAccountLocallyDeleted("B")).toBe(false);
  });
});
