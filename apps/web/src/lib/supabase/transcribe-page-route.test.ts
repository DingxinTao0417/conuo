import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import type { WorkspaceData } from "@/lib/types";

const mock = vi.hoisted(() => ({
  requireUser: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  maybeSingle: vi.fn(),
  rpc: vi.fn(),
  readModelProfile: vi.fn(),
  callVisionModel: vi.fn(),
  createRequestStore: vi.fn(),
}));

vi.mock("@/lib/supabase/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase/api")>()),
  requireUser: mock.requireUser,
}));
vi.mock("@/lib/ai/model", () => ({
  readModelProfile: mock.readModelProfile,
  callVisionModel: mock.callVisionModel,
}));
vi.mock("@/lib/ai/requests", () => ({ createRequestStore: mock.createRequestStore }));

import { POST } from "@/app/api/v1/vision/transcribe-page/route";

const owner = "owner-a";
const config = {
  baseUrl: "https://model.example/v1",
  model: "vision-model",
  apiKey: "server-secret",
  jsonMode: true,
  tokenLimitParameter: "max_tokens" as const,
  timeoutMs: 45_000,
};

function write32be(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function png(width = 640, height = 900): string {
  const bytes = new Uint8Array(45);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  write32be(bytes, 8, 13);
  bytes.set([73, 72, 68, 82], 12);
  write32be(bytes, 16, width);
  write32be(bytes, 20, height);
  bytes.set([73, 69, 78, 68], bytes.length - 8);
  return Buffer.from(bytes).toString("base64");
}

function payload(workspace: WorkspaceData) {
  const source = workspace.sources[0];
  return {
    requestId: "ocr-request-1",
    sourceId: source.id,
    versionId: source.versionId,
    page: 2,
    image: { mimeType: "image/png", base64: png(), width: 640, height: 900 },
  };
}

function post(body: unknown) {
  return new Request("http://localhost/api/v1/vision/transcribe-page", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Conuo-User": owner },
    body: JSON.stringify(body),
  });
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ code });
}

describe("PDF page transcription route", () => {
  let workspace: WorkspaceData;

  beforeEach(() => {
    Object.values(mock).forEach((fn) => fn.mockReset());
    workspace = createDemoWorkspace();
    workspace.sources[0].kind = "pdf";
    workspace.sources[0].mime = "application/pdf";
    workspace.sources[0].pageCount = 5;
    const chain = { select: mock.select, eq: mock.eq, maybeSingle: mock.maybeSingle };
    mock.from.mockReturnValue(chain);
    mock.select.mockReturnValue(chain);
    mock.eq.mockReturnValue(chain);
    mock.maybeSingle.mockResolvedValue({ data: { data: workspace, revision: 1 }, error: null });
    mock.requireUser.mockResolvedValue({ user: { id: owner }, supabase: { from: mock.from } });
    mock.createRequestStore.mockReturnValue({ rpc: mock.rpc });
    mock.rpc.mockResolvedValue({ data: { allowed: true }, error: null });
    mock.readModelProfile.mockReturnValue({ profile: "vision", config });
    mock.callVisionModel.mockResolvedValue('{"markdown":"## 标题\\n\\nOCR 正文"}');
    vi.stubEnv("CONUO_OCR_DAILY_PAGE_LIMIT", "100");
  });

  it("returns page markdown only after the PDF/version/AI checks and quota reservation", async () => {
    const response = await POST(post(payload(workspace)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ page: 2, markdown: "## 标题\n\nOCR 正文" });
    expect(mock.rpc).toHaveBeenCalledWith(
      "reserve_ocr_pages",
      expect.objectContaining({ p_pages: 1 }),
    );
    expect(mock.callVisionModel).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "non-pdf",
      (value: WorkspaceData) => (value.sources[0].kind = "text"),
      422,
      "VISION_PDF_REQUIRED",
    ],
    [
      "version changed",
      (value: WorkspaceData) => (value.sources[0].versionId = "other-version"),
      409,
      "VISION_SOURCE_VERSION_CHANGED",
    ],
    ["AI disabled", (value: WorkspaceData) => (value.aiEnabled = false), 403, "AI_DISABLED"],
  ])("rejects %s before the model call", async (_name, mutate, status, code) => {
    const input = payload(workspace);
    mutate(workspace);
    const response = await POST(post(input));
    await expectError(response, status, code);
    expect(mock.callVisionModel).not.toHaveBeenCalled();
  });

  it("rejects an image over 2 MiB", async () => {
    const input = payload(workspace);
    input.image.base64 = "A".repeat(2_800_000);
    const response = await POST(post(input));
    await expectError(response, 413, "VISION_IMAGE_TOO_LARGE");
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it("returns the fixed daily limit error without calling the model", async () => {
    mock.rpc.mockResolvedValue({ data: { allowed: false }, error: null });
    const response = await POST(post(payload(workspace)));
    await expectError(response, 429, "OCR_DAILY_LIMIT");
    expect(mock.callVisionModel).not.toHaveBeenCalled();
  });

  it("fails closed when the vision model profile is invalid", async () => {
    mock.readModelProfile.mockReturnValue(null);
    const response = await POST(post(payload(workspace)));
    await expectError(response, 503, "VISION_MODEL_NOT_CONFIGURED");
    expect(mock.rpc).not.toHaveBeenCalled();
  });
});
