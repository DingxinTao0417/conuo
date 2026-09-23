import assert from "node:assert/strict";
import test from "node:test";
import type { Source } from "./contracts.ts";
import {
  createSupabaseOriginalUploadPort,
  uploadPdfOriginal,
  type OriginalUploadPort,
} from "./original-upload.ts";

const owner = "123e4567-e89b-42d3-a456-426614174000";
const sourceId = "123e4567-e89b-42d3-a456-426614174001";
const versionId = "123e4567-e89b-42d3-a456-426614174002";
const intentId = "123e4567-e89b-42d3-a456-426614174003";
const reservationToken = "123e4567-e89b-42d3-a456-426614174004";
const bytes = new Uint8Array([1, 2, 3, 4]);
const hash = "b".repeat(64);
const path = `${owner}/${versionId}/${sourceId}.pdf`;

function pdfSource(): Source {
  return {
    id: sourceId,
    versionId,
    title: "test",
    filename: "test.pdf",
    kind: "pdf",
    mime: "application/pdf",
    size: bytes.byteLength,
    hash,
    text: "test",
    spaceIds: [],
    tags: [],
    status: "ready",
    aiAllowed: false,
    starred: false,
    createdAt: "2026-09-23T12:00:00.000Z",
    updatedAt: "2026-09-23T12:00:00.000Z",
    deletedAt: null,
    chunks: [],
  };
}

function makePort(overrides: Partial<OriginalUploadPort> = {}) {
  const calls = { reserve: 0, upload: 0, download: 0, complete: 0 };
  const port: OriginalUploadPort = {
    currentUserId: async () => owner,
    reserve: async () => {
      calls.reserve++;
      return {
        data: {
          status: "reserved",
          intentId,
          storagePath: path,
          reservationToken,
          reservationUntil: "2026-09-23T12:15:00.000Z",
        },
        error: null,
      };
    },
    upload: async () => {
      calls.upload++;
      return { error: null };
    },
    download: async () => {
      calls.download++;
      return { bytes, error: null };
    },
    complete: async () => {
      calls.complete++;
      return {
        data: { status: "uploaded", intentId, storagePath: path, reservationUntil: null },
        error: null,
      };
    },
    sha256: async () => hash,
    ...overrides,
  };
  return { calls, port };
}

test("PDF upload reserves, writes immutable bytes and completes before returning the path", async () => {
  const { calls, port } = makePort();
  assert.equal(await uploadPdfOriginal(pdfSource(), bytes, owner, port), path);
  assert.deepEqual(calls, { reserve: 1, upload: 1, download: 0, complete: 1 });
});

test("an already uploaded reservation completes without uploading a second copy", async () => {
  let reserveCount = 0;
  const { calls, port } = makePort({
    reserve: async () => {
      reserveCount++;
      return {
        data: {
          status: "uploaded",
          intentId,
          storagePath: path,
          reservationToken,
          reservationUntil: "2026-09-23T12:15:00.000Z",
        },
        error: null,
      };
    },
  });
  assert.equal(await uploadPdfOriginal(pdfSource(), bytes, owner, port), path);
  assert.equal(reserveCount, 1);
  assert.deepEqual(calls, { reserve: 0, upload: 0, download: 0, complete: 1 });
});

test("an ambiguous duplicate-path response is accepted only when bytes match the source hash", async () => {
  let uploadAttempts = 0;
  const { calls, port } = makePort({
    upload: async () => {
      uploadAttempts++;
      return { error: { statusCode: "409" } };
    },
  });
  assert.equal(await uploadPdfOriginal(pdfSource(), bytes, owner, port), path);
  assert.equal(uploadAttempts, 1);
  assert.equal(calls.download, 1);

  const mismatch = makePort({
    upload: async () => ({ error: { statusCode: "409" } }),
    download: async () => ({ bytes: new Uint8Array([9]), error: null }),
  });
  await assert.rejects(uploadPdfOriginal(pdfSource(), bytes, owner, mismatch.port), /不同内容/u);
  assert.equal(mismatch.calls.complete, 0);
});

test("account changes and invalid bytes fail before committing an original", async () => {
  const changed = makePort({ currentUserId: async () => "another-user" });
  await assert.rejects(uploadPdfOriginal(pdfSource(), bytes, owner, changed.port), /账号已改变/u);
  assert.equal(changed.calls.reserve, 0);

  const mismatchedBytes = makePort();
  await assert.rejects(
    uploadPdfOriginal(pdfSource(), new Uint8Array([8]), owner, mismatchedBytes.port),
    /大小校验/u,
  );
  assert.equal(mismatchedBytes.calls.reserve, 0);
});

test("the Supabase RPC adapter keeps the client receiver bound", async () => {
  let receiver: unknown;
  const fakeClient = {
    rpc(this: unknown, name: string, args: Record<string, unknown>) {
      receiver = this;
      assert.equal(name, "reserve_original_upload");
      assert.equal(args.p_kind, "pdf");
      return Promise.resolve({
        data: {
          status: "committed",
          intentId,
          storagePath: path,
          reservationToken: null,
          reservationUntil: null,
        },
        error: null,
      });
    },
    auth: { getUser: async () => ({ data: { user: { id: owner } }, error: null }) },
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  };
  const port = createSupabaseOriginalUploadPort(
    fakeClient as never,
    async () => hash,
  );
  await port.reserve({
    sourceId,
    versionId,
    expectedBytes: bytes.byteLength,
    expectedSha256: hash,
    contentType: "application/pdf",
  });
  assert.equal(receiver, fakeClient);
});
