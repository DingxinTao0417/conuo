import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  requireUser: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/api")>();
  return { ...actual, requireUser: mock.requireUser };
});

import { GET, POST } from "@/app/api/v1/sources/[sourceId]/purge/route";
import { createEmptyWorkspace } from "../seed";
import { sourcePurgePreviewFixture } from "../../../tests/fixtures/source-purge";
import { POST as PREVIEW_SELECTION } from "@/app/api/v1/sources/[sourceId]/purge/preview/route";
import { ApiError } from "./api";

const owner = "owner-a";
const sourceId = "source-a";
const fingerprint = "a".repeat(64);
const purgeId = "f5d81be7-8cf9-437c-a371-8ea571c006ca";
const context = { params: Promise.resolve({ sourceId }) };

function request(method: "GET" | "POST", body?: unknown) {
  return new Request(`http://localhost:3000/api/v1/sources/${sourceId}/purge`, {
    method,
    headers: {
      "X-Conuo-User": owner,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.requireUser.mockResolvedValue({ supabase: { rpc: mock.rpc }, user: { id: owner } });
});

describe("source purge route", () => {
  it("returns a server-derived impact preview", async () => {
    mock.rpc.mockResolvedValue({
      data: sourcePurgePreviewFixture(),
      error: null,
    });

    const response = await GET(request("GET"), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ revision: 7, fingerprint });
    expect(mock.rpc).toHaveBeenCalledWith("preview_source_purge", { p_source_id: sourceId });
  });

  it("submits only the preview confirmation and accepts an atomically returned workspace", async () => {
    const data = createEmptyWorkspace();
    mock.rpc.mockResolvedValue({
      data: { revision: 8, data, purgeId, cleanupPending: true },
      error: null,
    });

    const response = await POST(request("POST", { expectedRevision: 7, fingerprint }), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      revision: 8,
      purgeId,
      cleanupPending: true,
    });
    expect(mock.rpc).toHaveBeenCalledWith("request_source_purge", {
      p_source_id: sourceId,
      p_expected_revision: 7,
      p_fingerprint: fingerprint,
    });
  });

  it("does not expose database errors when manual content blocks the operation", async () => {
    mock.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "private detail" } });

    const response = await POST(request("POST", { expectedRevision: 7, fingerprint }), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "这份资料仍有需要你处理的批注或手工关系，请先另存或明确删除这些内容。",
      code: "PURGE_BLOCKED",
    });
  });

  it.each(["40001", "PT409"])("maps a %s stale preview to a redacted conflict", async (code) => {
    mock.rpc.mockResolvedValue({ data: null, error: { code, message: "private purge state" } });
    const response = await POST(request("POST", { expectedRevision: 7, fingerprint }), context);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ code: "PURGE_CONTEXT_CHANGED" });
    expect(JSON.stringify(body)).not.toContain("private purge state");
  });

  it("rejects malformed confirmation input before the database call", async () => {
    const response = await POST(
      request("POST", { expectedRevision: 0, fingerprint: "wrong" }),
      context,
    );

    expect(response.status).toBe(400);
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it("previews exact saved-content choices with a read-only RPC and private response", async () => {
    const selection = { noteIds: ["note-a"], conversationIds: [] };
    mock.rpc.mockResolvedValue({ data: sourcePurgePreviewFixture(selection), error: null });
    const response = await PREVIEW_SELECTION(request("POST", selection), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      impact: {
        removedNotes: 1,
        removedNoteVersions: 2,
        retainedNotes: 0,
        retainedConversations: 1,
      },
      contentSelection: { selection },
    });
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("preview_source_purge_selection", {
      p_source_id: sourceId,
      p_note_ids: ["note-a"],
      p_conversation_ids: [],
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("vary")).toContain("Cookie");
  });

  it("submits selected IDs to the new transaction without accepting paths or snapshots", async () => {
    const selection = { noteIds: ["note-a"], conversationIds: ["conversation-a"] };
    mock.rpc.mockResolvedValue({
      data: { revision: 8, data: createEmptyWorkspace(), purgeId, cleanupPending: true },
      error: null,
    });
    const response = await POST(
      request("POST", { expectedRevision: 7, fingerprint, selection }),
      context,
    );
    expect(response.status).toBe(200);
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("request_source_purge_selection", {
      p_source_id: sourceId,
      p_expected_revision: 7,
      p_fingerprint: fingerprint,
      p_note_ids: ["note-a"],
      p_conversation_ids: ["conversation-a"],
    });
  });

  it.each([
    { noteIds: ["note-a", "note-a"], conversationIds: [] },
    { noteIds: ["../note-a"], conversationIds: [] },
    { noteIds: [], conversationIds: ["x".repeat(101)] },
    { noteIds: [], conversationIds: [], storagePaths: ["other-owner/private"] },
    { noteIds: [], conversationIds: [], data: createEmptyWorkspace() },
  ])("rejects malformed or expanded selection before SQL %#", async (selection) => {
    const response = await PREVIEW_SELECTION(request("POST", selection), context);
    expect(response.status).toBe(400);
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it("rejects a preview that understates selected whole-document versions", async () => {
    const selection = { noteIds: ["note-a"], conversationIds: [] };
    const preview = sourcePurgePreviewFixture(selection);
    preview.impact.removedNoteVersions = 0;
    mock.rpc.mockResolvedValue({ data: preview, error: null });
    const response = await PREVIEW_SELECTION(request("POST", selection), context);
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("contentSelection");
  });

  it("rejects a correctly shaped preview for a different selection", async () => {
    mock.rpc.mockResolvedValue({ data: sourcePurgePreviewFixture(), error: null });
    const response = await PREVIEW_SELECTION(
      request("POST", { noteIds: ["note-a"], conversationIds: [] }),
      context,
    );
    expect(response.status).toBe(503);
  });

  it("does not allow a default GET to preselect user documents", async () => {
    mock.rpc.mockResolvedValue({
      data: sourcePurgePreviewFixture({ noteIds: ["note-a"], conversationIds: [] }),
      error: null,
    });
    expect((await GET(request("GET"), context)).status).toBe(503);
  });

  it("authenticates before parsing selection and rechecks the owner before publishing", async () => {
    mock.requireUser.mockRejectedValueOnce(new ApiError(401, "UNAUTHENTICATED", "请登录。"));
    expect(
      (await PREVIEW_SELECTION(request("POST", { storagePaths: ["private"] }), context)).status,
    ).toBe(401);
    expect(mock.rpc).not.toHaveBeenCalled();
    mock.requireUser.mockResolvedValueOnce({ supabase: { rpc: mock.rpc }, user: { id: owner } });
    mock.requireUser.mockResolvedValueOnce({
      supabase: { rpc: mock.rpc },
      user: { id: "owner-b" },
    });
    mock.rpc.mockResolvedValue({ data: sourcePurgePreviewFixture(), error: null });
    const response = await PREVIEW_SELECTION(
      request("POST", { noteIds: [], conversationIds: [] }),
      context,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "SESSION_CHANGED" });
  });

  it("does not publish a preview after request cancellation", async () => {
    const controller = new AbortController();
    let complete!: (result: unknown) => void;
    mock.rpc.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const input = new Request(`http://localhost/api/v1/sources/${sourceId}/purge/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noteIds: [], conversationIds: [] }),
      signal: controller.signal,
    });
    const pending = PREVIEW_SELECTION(input, context);
    await vi.waitFor(() => expect(mock.rpc).toHaveBeenCalled());
    controller.abort();
    complete({ data: sourcePurgePreviewFixture(), error: null });
    expect((await pending).status).toBe(499);
  });

  it("maps missing selection migrations and unassociated IDs without database details", async () => {
    mock.rpc.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "private SQL schema details" },
    });
    const response = await PREVIEW_SELECTION(
      request("POST", { noteIds: [], conversationIds: [] }),
      context,
    );
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("private SQL");
    mock.rpc.mockResolvedValue({
      data: null,
      error: { code: "22023", message: "other owner's record" },
    });
    expect(
      (
        await PREVIEW_SELECTION(
          request("POST", { noteIds: ["foreign"], conversationIds: [] }),
          context,
        )
      ).status,
    ).toBe(409);
  });
});
