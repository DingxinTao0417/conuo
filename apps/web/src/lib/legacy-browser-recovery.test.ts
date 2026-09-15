import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeBackupRestore } from "./backup-restore";
import { createEmptyWorkspace } from "./seed";
import type { Source, SourceVersion } from "./types";
import type { StoredLocalWorkspace } from "./local-store";

const mock = vi.hoisted(() => ({
  load: vi.fn(),
  getBlob: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("./local-store", () => ({
  loadLocalWorkspaceRecord: mock.load,
  getBlob: mock.getBlob,
  saveLocalWorkspace: mock.save,
  deleteUnreferencedBlob: mock.remove,
}));

import { prepareLegacyBrowserRecovery } from "./legacy-browser-recovery";

const at = "2026-09-15T12:00:00.000Z";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function source(versionId: string, text: string): Promise<{ source: Source; blob: Blob }> {
  const blob = new Blob([text], { type: "text/plain" });
  const bytes = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const hash = Array.from(new Uint8Array(bytes), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  return {
    blob,
    source: {
      id: "legacy-source",
      versionId,
      title: "旧版资料",
      filename: "lesson.txt",
      kind: "text",
      mime: "text/plain",
      size: blob.size,
      hash,
      text,
      chunks: [
        {
          id: `chunk-${versionId}`,
          sourceId: "legacy-source",
          versionId,
          text,
          section: "正文",
          order: 0,
        },
      ],
      spaceIds: ["legacy-space"],
      tags: [],
      status: "ready",
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      aiAllowed: true,
      starred: false,
      blobKey: `old:${versionId}`,
      storagePath: `obsolete-cloud/${versionId}.txt`,
    },
  };
}
async function fixture() {
  const current = await source("current", "当前准确版本原件。");
  const older = await source("older", "历史准确版本原件。");
  const previous = older.source;
  current.source.versions = [
    {
      versionId: previous.versionId,
      title: previous.title,
      filename: previous.filename,
      kind: previous.kind,
      mime: previous.mime,
      size: previous.size,
      hash: previous.hash,
      text: previous.text,
      chunks: previous.chunks,
      status: previous.status,
      blobKey: previous.blobKey,
      storagePath: previous.storagePath,
      createdAt: at,
      archivedAt: at,
    } satisfies SourceVersion,
  ];
  const data: StoredLocalWorkspace = createEmptyWorkspace();
  data.spaces[0].id = "legacy-space";
  data.sources = [current.source];
  data.notes = [
    {
      id: "legacy-note",
      spaceId: "legacy-space",
      title: "旧版笔记",
      kind: "note",
      status: "accepted",
      content: '<p><a href="#source/legacy-source/version/older">历史资料</a></p>',
      citations: [
        {
          sourceId: previous.id,
          versionId: previous.versionId,
          chunkId: previous.chunks[0].id,
          title: previous.title,
          quote: previous.text,
          section: "正文",
        },
      ],
      versions: [],
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    },
  ];
  data._conuoSync = { accountId: "must-not-be-migrated", localRevision: 100 };
  data._conuoLocalRevision = 123;
  return { data, current, older };
}

describe("explicit legacy browser recovery archive bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.getBlob.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads only anonymous originals, remaps exact retained identities, and appends to a nonempty account", async () => {
    const value = await fixture();
    mock.load.mockResolvedValue(value.data);
    mock.getBlob.mockImplementation((key: string, owner: string) => {
      expect(owner).toBe("local");
      return Promise.resolve(
        key === value.current.source.blobKey ? value.current.blob : value.older.blob,
      );
    });
    const snapshot = structuredClone(value.data);
    const result = await prepareLegacyBrowserRecovery();
    expect(mock.load).toHaveBeenCalledExactlyOnceWith("local");
    expect(mock.getBlob.mock.calls).toEqual([
      ["old:current", "local"],
      ["old:older", "local"],
    ]);
    expect(result?.archive.type).toBe("application/zip");
    const plan = result!.plan;
    expect(plan.counts.sources).toBe(1);
    expect(plan.counts.sourceVersions).toBe(1);
    expect(plan.counts.notes).toBe(1);
    expect(plan.blobs).toHaveLength(2);
    const restored = plan.data.sources[0];
    const historical = restored.versions![0];
    expect(restored.id).not.toBe(value.current.source.id);
    expect(restored.versionId).not.toBe(value.current.source.versionId);
    expect(historical.versionId).not.toBe(value.older.source.versionId);
    expect(restored.aiAllowed).toBe(false);
    expect(restored.storagePath).toBeUndefined();
    expect(historical.storagePath).toBeUndefined();
    for (const [version, expectedBlob] of [
      [restored, value.current.blob],
      [historical, value.older.blob],
    ] as const) {
      const original = plan.blobs.find((item) => item.versionId === version.versionId)!;
      expect(original.sourceId).toBe(restored.id);
      expect(original.key).toBe(version.blobKey);
      expect(await original.blob.text()).toBe(await expectedBlob.text());
    }
    expect(plan.data.notes[0].citations[0]).toMatchObject({
      sourceId: restored.id,
      versionId: historical.versionId,
      chunkId: historical.chunks[0].id,
    });
    expect(plan.data.notes[0].content).toContain(
      `#source/${restored.id}/version/${historical.versionId}`,
    );
    expect(plan.data).not.toHaveProperty("_conuoSync");
    expect(plan.data).not.toHaveProperty("_conuoLocalRevision");
    const currentAccount = createEmptyWorkspace();
    currentAccount.notes = [
      {
        ...value.data.notes[0],
        id: "cloud-note",
        content: "云端已有内容",
        spaceId: currentAccount.spaces[0].id,
        citations: [],
      },
    ];
    const merged = mergeBackupRestore(currentAccount, plan);
    expect(merged.notes).toHaveLength(2);
    expect(merged.notes[0]).toEqual(currentAccount.notes[0]);
    expect(currentAccount.notes).toHaveLength(1);
    expect(value.data).toEqual(snapshot);
    expect(mock.save).not.toHaveBeenCalled();
    expect(mock.remove).not.toHaveBeenCalled();
  });

  it("never follows obsolete cloud paths and reports missing originals without fabricating bytes", async () => {
    const value = await fixture();
    delete value.data.sources[0].blobKey;
    value.data.sources[0].versions = [];
    value.data.notes = [];
    mock.load.mockResolvedValue(value.data);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const result = await prepareLegacyBrowserRecovery();
    expect(mock.getBlob).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(result!.plan.missingOriginals).toHaveLength(1);
    expect(result!.plan.blobs).toHaveLength(0);
    expect(result!.plan.data.sources[0].text).toBe(value.current.source.text);
    expect(result!.plan.data.sources[0].originalMissing).toBe(true);
    expect(mock.save).not.toHaveBeenCalled();
  });

  it("returns empty for an absent legacy record", async () => {
    mock.load.mockResolvedValue(null);
    expect(await prepareLegacyBrowserRecovery()).toBeNull();
    expect(mock.load).toHaveBeenCalledExactlyOnceWith("local");
    expect(mock.getBlob).not.toHaveBeenCalled();
  });

  it("does not import an empty default workspace as a meaningless copy", async () => {
    mock.load.mockResolvedValue(createEmptyWorkspace());
    expect(await prepareLegacyBrowserRecovery()).toBeNull();
    expect(mock.getBlob).not.toHaveBeenCalled();
  });

  it("supports a note-only legacy workspace without requiring source originals", async () => {
    const value = await fixture();
    value.data.sources = [];
    value.data.notes[0].citations = [];
    value.data.notes[0].content = "<p>只有一篇旧笔记。</p>";
    mock.load.mockResolvedValue(value.data);
    const result = await prepareLegacyBrowserRecovery();
    expect(result!.plan.counts.sources).toBe(0);
    expect(result!.plan.counts.notes).toBe(1);
    expect(mock.getBlob).not.toHaveBeenCalled();
  });

  it("cancel before opening reads nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(prepareLegacyBrowserRecovery(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(mock.load).not.toHaveBeenCalled();
  });

  it("cancellation during the readonly snapshot stops before reading originals or preparing a copy", async () => {
    const value = await fixture();
    const record = deferred<StoredLocalWorkspace>();
    mock.load.mockReturnValue(record.promise);
    const controller = new AbortController();
    const pending = prepareLegacyBrowserRecovery(controller.signal);
    controller.abort();
    record.resolve(value.data);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(mock.getBlob).not.toHaveBeenCalled();
    expect(mock.save).not.toHaveBeenCalled();
  });

  it("cancellation during original export aborts the pipeline instead of becoming a missing-file success", async () => {
    const value = await fixture();
    const original = deferred<Blob>();
    mock.load.mockResolvedValue(value.data);
    mock.getBlob.mockReturnValue(original.promise);
    const controller = new AbortController();
    const pending = prepareLegacyBrowserRecovery(controller.signal);
    await vi.waitFor(() => expect(mock.getBlob).toHaveBeenCalled());
    controller.abort();
    original.resolve(value.current.blob);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(mock.save).not.toHaveBeenCalled();
    expect(mock.remove).not.toHaveBeenCalled();
  });
});
