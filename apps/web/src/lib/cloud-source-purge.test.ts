import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewSourcePurge, requestSourcePurge } from "./cloud";
import { sourcePurgePreviewSchema, sourcePurgeSelectionSchema } from "./source-purge-contract";
import { createEmptyWorkspace } from "./seed";
import {
  purgeFingerprint,
  purgeSourceId,
  purgeTransactionId,
  sourcePurgePreviewFixture,
} from "../../tests/fixtures/source-purge";

vi.mock("./supabase/config", () => ({
  getSupabaseConfig: () => ({ url: "https://project.example.test", key: "test-key" }),
}));
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("saved-content purge client", () => {
  it("defaults to preserving user content through the existing authenticated GET", async () => {
    const preview = sourcePurgePreviewFixture();
    fetchMock.mockResolvedValue(Response.json(preview));
    expect(await previewSourcePurge(purgeSourceId, "owner-a")).toEqual(preview);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `/api/v1/sources/${purgeSourceId}/purge`,
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
        headers: expect.objectContaining({ "X-Conuo-User": "owner-a" }),
      }),
    );
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("body");
  });

  it("previews selected IDs in a request body and propagates cancellation", async () => {
    const selection = { noteIds: ["note-a"], conversationIds: [] };
    const controller = new AbortController();
    fetchMock.mockResolvedValue(Response.json(sourcePurgePreviewFixture(selection)));
    expect(
      (await previewSourcePurge(purgeSourceId, "owner-a", selection, controller.signal))
        .contentSelection?.selection,
    ).toEqual(selection);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe(`/api/v1/sources/${purgeSourceId}/purge/preview`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(selection);
    controller.abort();
    expect(init.signal.aborted).toBe(true);
  });

  it("keeps the old server preview usable without claiming selection support", async () => {
    const preview = sourcePurgePreviewFixture();
    delete preview.contentSelection;
    delete preview.impact.removedNotes;
    delete preview.impact.removedNoteVersions;
    delete preview.impact.removedConversations;
    delete preview.impact.removedMessages;
    fetchMock.mockImplementation(async () => Response.json(preview));
    expect((await previewSourcePurge(purgeSourceId, "owner-a")).contentSelection).toBeUndefined();
    await expect(
      previewSourcePurge(purgeSourceId, "owner-a", { noteIds: [], conversationIds: [] }),
    ).rejects.toMatchObject({ code: "INVALID_PURGE_PREVIEW" });
  });

  it("rejects an echoed choice mismatch and an unexpected default selection", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(sourcePurgePreviewFixture()));
    await expect(
      previewSourcePurge(purgeSourceId, "owner-a", { noteIds: ["note-a"], conversationIds: [] }),
    ).rejects.toMatchObject({ code: "INVALID_PURGE_PREVIEW" });
    fetchMock.mockResolvedValueOnce(
      Response.json(sourcePurgePreviewFixture({ noteIds: ["note-a"], conversationIds: [] })),
    );
    await expect(previewSourcePurge(purgeSourceId, "owner-a")).rejects.toMatchObject({
      code: "INVALID_PURGE_PREVIEW",
    });
  });

  it("submits only confirmed choices, revision and fingerprint to the deletion endpoint", async () => {
    const selection = { noteIds: ["note-a"], conversationIds: ["conversation-a"] };
    fetchMock.mockResolvedValue(
      Response.json({
        revision: 8,
        data: createEmptyWorkspace(),
        purgeId: purgeTransactionId,
        cleanupPending: true,
      }),
    );
    const result = await requestSourcePurge(
      purgeSourceId,
      7,
      purgeFingerprint,
      "owner-a",
      selection,
    );
    expect(result.cleanupPending).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      expectedRevision: 7,
      fingerprint: purgeFingerprint,
      selection,
    });
  });

  it("does not accept a response that retains a selected record", async () => {
    const data = createEmptyWorkspace();
    data.notes.push({
      id: "note-a",
      spaceId: data.spaces[0].id,
      title: "还在的笔记",
      content: "正文",
      kind: "note",
      status: "accepted",
      citations: [],
      versions: [],
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
      deletedAt: null,
    });
    fetchMock.mockResolvedValue(
      Response.json({ revision: 8, data, purgeId: purgeTransactionId, cleanupPending: true }),
    );
    await expect(
      requestSourcePurge(purgeSourceId, 7, purgeFingerprint, "owner-a", {
        noteIds: ["note-a"],
        conversationIds: [],
      }),
    ).rejects.toMatchObject({ code: "INVALID_PURGE_RESULT" });
  });

  it("rejects malformed choices before network transmission", async () => {
    const selection = { noteIds: ["note-a", "note-a"], conversationIds: [] };
    await expect(previewSourcePurge(purgeSourceId, "owner-a", selection)).rejects.toMatchObject({
      code: "INVALID_PURGE_SELECTION",
    });
    await expect(
      requestSourcePurge(purgeSourceId, 7, purgeFingerprint, "owner-a", selection),
    ).rejects.toMatchObject({ code: "INVALID_PURGE_SELECTION" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never publishes a response arriving after cancellation", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => {
      controller.abort();
      return Response.json(sourcePurgePreviewFixture());
    });
    await expect(
      previewSourcePurge(purgeSourceId, "owner-a", undefined, controller.signal),
    ).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  });

  it("fails before fetching when the request is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      previewSourcePurge(purgeSourceId, "owner-a", undefined, controller.signal),
    ).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("purge preview integrity", () => {
  it("accepts the full existing workspace selection capacity with strict object shape", () => {
    expect(
      sourcePurgeSelectionSchema.safeParse({
        noteIds: Array.from({ length: 10_000 }, (_, i) => `note-${i}`),
        conversationIds: Array.from({ length: 5_000 }, (_, i) => `conversation-${i}`),
      }).success,
    ).toBe(true);
    expect(
      sourcePurgeSelectionSchema.safeParse({ noteIds: [], conversationIds: [], data: {} }).success,
    ).toBe(false);
    expect(
      sourcePurgeSelectionSchema.safeParse({
        noteIds: Array.from({ length: 10_001 }, (_, i) => `note-${i}`),
        conversationIds: [],
      }).success,
    ).toBe(false);
  });

  it.each([
    "removedNotes",
    "removedNoteVersions",
    "removedConversations",
    "removedMessages",
    "retainedNotes",
    "retainedConversations",
  ] as const)("rejects incorrect %s instead of understating deletion", (key) => {
    const preview = sourcePurgePreviewFixture({
      noteIds: ["note-a"],
      conversationIds: ["conversation-a"],
    });
    preview.impact[key] = (preview.impact[key] ?? 0) + 1;
    expect(sourcePurgePreviewSchema.safeParse(preview).success).toBe(false);
  });

  it("rejects duplicate candidates, unknown selections and unsupported versions", () => {
    for (const change of [
      (p: ReturnType<typeof sourcePurgePreviewFixture>) =>
        p.contentSelection!.notes.push({ ...p.contentSelection!.notes[0] }),
      (p: ReturnType<typeof sourcePurgePreviewFixture>) =>
        p.contentSelection!.selection.noteIds.push("unassociated"),
      (p: ReturnType<typeof sourcePurgePreviewFixture>) =>
        Object.assign(p.contentSelection!, { version: 2 }),
    ]) {
      const preview = sourcePurgePreviewFixture();
      change(preview);
      expect(sourcePurgePreviewSchema.safeParse(preview).success).toBe(false);
    }
  });
});
