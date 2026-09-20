import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  config: vi.fn(),
  createClient: vi.fn(),
  getUser: vi.fn(),
  rpc: vi.fn(),
  storageFrom: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
}));

vi.mock("./supabase/config", () => ({ getSupabaseConfig: mock.config }));
vi.mock("./supabase/client", () => ({ createClient: mock.createClient }));

import { CloudError, uploadSourceBlob } from "./cloud";
import type { Source } from "./types";

const ownerId = "2f4e4c7a-7777-4a13-85aa-bc1f3b4d1e90";
const sourceId = "source-intent";
const versionId = "version-intent";
const intentId = "8f7b0ac3-9e48-4ba0-b1f0-3b0d2ea9e5ec";
const reservationToken = "1bc32c86-7c42-4b32-83e0-dca42f978d11";
const reservationUntil = "2026-09-14T12:05:00.000Z";
const canonicalPath = `${ownerId}/${versionId}/${sourceId}.txt`;

async function sha256(blob: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function original(text = "stable source bytes") {
  const blob = new Blob([text], { type: "text/plain" });
  const source: Source = {
    id: sourceId,
    versionId,
    title: "上传事务资料",
    filename: "intent.txt",
    kind: "text",
    mime: "text/plain",
    size: blob.size,
    hash: await sha256(blob),
    spaceIds: [],
    tags: [],
    status: "saved",
    text: "",
    chunks: [],
    createdAt: "2026-09-14T12:00:00.000Z",
    updatedAt: "2026-09-14T12:00:00.000Z",
    deletedAt: null,
    aiAllowed: true,
    starred: false,
  };
  return { blob, source };
}

function reservation(status: "reserved" | "uploaded" | "committed" = "reserved") {
  return {
    status,
    intentId,
    storagePath: canonicalPath,
    reservationToken: status === "committed" ? null : reservationToken,
    reservationUntil: status === "committed" ? null : reservationUntil,
  };
}

function completion(status: "uploaded" | "committed" = "uploaded") {
  return { status, intentId, storagePath: canonicalPath, reservationUntil };
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.config.mockReturnValue({ url: "https://project.example.test", key: "publishable-test-key" });
  mock.createClient.mockReturnValue({
    auth: { getUser: mock.getUser },
    rpc: mock.rpc,
    storage: { from: mock.storageFrom },
  });
  mock.getUser.mockResolvedValue({ data: { user: { id: ownerId } }, error: null });
  mock.storageFrom.mockReturnValue({ upload: mock.upload, download: mock.download });
});

describe("original upload intent cloud adapter", () => {
  it("reserves the canonical source, writes Storage, then confirms the same intent", async () => {
    const { blob, source } = await original();
    mock.rpc.mockResolvedValueOnce({ data: reservation(), error: null });
    mock.upload.mockResolvedValueOnce({ error: null });
    mock.rpc.mockResolvedValueOnce({ data: completion(), error: null });

    await expect(uploadSourceBlob(source, blob, ownerId)).resolves.toBe(canonicalPath);

    expect(source.hash).toBe(await sha256(blob));
    expect(mock.rpc).toHaveBeenNthCalledWith(1, "reserve_original_upload", {
      p_source_id: sourceId,
      p_version_id: versionId,
      p_kind: "text",
      p_expected_bytes: blob.size,
      p_expected_sha256: source.hash,
      p_content_type: "text/plain",
    });
    expect(mock.upload).toHaveBeenCalledExactlyOnceWith(canonicalPath, await blob.arrayBuffer(), {
      contentType: "text/plain",
      upsert: false,
    });
    expect(mock.rpc).toHaveBeenNthCalledWith(2, "complete_original_upload", {
      p_intent_id: intentId,
      p_reservation_token: reservationToken,
    });
    expect(mock.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      mock.upload.mock.invocationCallOrder[0],
    );
    expect(mock.upload.mock.invocationCallOrder[0]).toBeLessThan(
      mock.rpc.mock.invocationCallOrder[1],
    );
  });

  it("confirms an uploaded reservation without writing the immutable object again", async () => {
    const { blob, source } = await original();
    mock.rpc.mockResolvedValueOnce({ data: reservation("uploaded"), error: null });
    mock.rpc.mockResolvedValueOnce({ data: completion(), error: null });

    await expect(uploadSourceBlob(source, blob, ownerId)).resolves.toBe(canonicalPath);

    expect(mock.rpc).toHaveBeenNthCalledWith(1, "reserve_original_upload", expect.any(Object));
    expect(mock.rpc).toHaveBeenNthCalledWith(2, "complete_original_upload", {
      p_intent_id: intentId,
      p_reservation_token: reservationToken,
    });
    expect(mock.storageFrom).not.toHaveBeenCalled();
    expect(mock.upload).not.toHaveBeenCalled();
  });

  it("returns a committed reservation directly without another confirmation or Storage write", async () => {
    const { blob, source } = await original();
    mock.rpc.mockResolvedValueOnce({ data: reservation("committed"), error: null });

    await expect(uploadSourceBlob(source, blob, ownerId)).resolves.toBe(canonicalPath);

    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("reserve_original_upload", expect.any(Object));
    expect(mock.storageFrom).not.toHaveBeenCalled();
    expect(mock.upload).not.toHaveBeenCalled();
  });

  it("confirms a matching immutable object after Storage reports a 409 conflict", async () => {
    const { blob, source } = await original();
    mock.rpc.mockResolvedValueOnce({ data: reservation(), error: null });
    mock.upload.mockResolvedValueOnce({ error: { statusCode: "409", message: "object exists" } });
    mock.download.mockResolvedValueOnce({
      data: new Blob([await blob.arrayBuffer()]),
      error: null,
    });
    mock.rpc.mockResolvedValueOnce({ data: completion(), error: null });

    await expect(uploadSourceBlob(source, blob, ownerId)).resolves.toBe(canonicalPath);

    expect(mock.upload).toHaveBeenCalledExactlyOnceWith(canonicalPath, await blob.arrayBuffer(), {
      contentType: "text/plain",
      upsert: false,
    });
    expect(mock.download).toHaveBeenCalledExactlyOnceWith(canonicalPath);
    expect(mock.rpc).toHaveBeenNthCalledWith(2, "complete_original_upload", {
      p_intent_id: intentId,
      p_reservation_token: reservationToken,
    });
    expect(mock.upload.mock.invocationCallOrder[0]).toBeLessThan(
      mock.download.mock.invocationCallOrder[0],
    );
    expect(mock.download.mock.invocationCallOrder[0]).toBeLessThan(
      mock.rpc.mock.invocationCallOrder[1],
    );
  });

  it.each(["40001", "PT409"])("maps a %s reservation fence to a cloud conflict", async (code) => {
    const { blob, source } = await original();
    mock.rpc.mockResolvedValueOnce({
      data: null,
      error: { code, message: "private upload state" },
    });

    const error = await uploadSourceBlob(source, blob, ownerId).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 409, code: "ORIGINAL_UPLOAD_STATE_CHANGED" });
    expect(String(error)).not.toContain("private upload state");
    expect(mock.upload).not.toHaveBeenCalled();
  });

  it("fails closed for malformed reservation data and never exposes server RPC details", async () => {
    const { blob, source } = await original();
    mock.rpc.mockResolvedValueOnce({
      data: { ...reservation(), privateServerDetail: "do-not-copy-malformed-response" },
      error: null,
    });

    const malformed = await uploadSourceBlob(source, blob, ownerId).catch(
      (error: unknown) => error,
    );
    expect(malformed).toBeInstanceOf(CloudError);
    expect(malformed).toMatchObject({
      status: 502,
      code: "INVALID_ORIGINAL_UPLOAD_RESPONSE",
      message: "云端原件预留返回无效，文件仍保存在本机。",
    });
    expect(String(malformed)).not.toContain("do-not-copy-malformed-response");
    expect(mock.upload).not.toHaveBeenCalled();

    mock.rpc.mockReset();
    mock.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "XX000", status: 500, message: "do-not-copy-database-stack" },
    });

    const rpcFailure = await uploadSourceBlob(source, blob, ownerId).catch(
      (error: unknown) => error,
    );
    expect(rpcFailure).toBeInstanceOf(CloudError);
    expect(rpcFailure).toMatchObject({
      status: 500,
      code: "ORIGINAL_UPLOAD_UNAVAILABLE",
      message: "原件云端确认失败，文件仍保存在本机。请稍后重试。",
    });
    expect(String(rpcFailure)).not.toContain("do-not-copy-database-stack");
  });
});
