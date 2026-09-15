import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { buildWorkspaceArchive } from "./export";
import { chunkText } from "./import";
import { createDemoWorkspace, createEmptyWorkspace } from "./seed";
import { getSourceVersion } from "./source-versions";
import type { Source, SourceVersion, WorkspaceData } from "./types";
import { WorkspaceCoordinator, type WorkspaceIO } from "./use-workspace";

vi.mock("./cloud", () => ({
  askCloud: vi.fn(),
  cancelOrganizationJob: vi.fn(),
  cancelImportParse: vi.fn(),
  claimImportParse: vi.fn(),
  enqueueOrganizationJob: vi.fn(),
  finishImportParse: vi.fn(),
  heartbeatImportParse: vi.fn(),
  releaseImportParse: vi.fn(),
  retryImportParse: vi.fn(),
  organizeCloud: vi.fn(),
  getModelStatus: vi.fn(),
  downloadSourceBlob: vi.fn(),
  isCloudConfigured: () => false,
  loadCloudWorkspace: vi.fn(),
  previewSourcePurge: vi.fn(),
  requestSourcePurge: vi.fn(),
  previewSourceVersionPurge: vi.fn(),
  requestSourceVersionPurge: vi.fn(),
  reconcileOrganizationJobs: vi.fn(),
  saveCloudWorkspace: vi.fn(),
  subscribeSession: vi.fn(),
  uploadSourceBlob: vi.fn(),
}));
vi.mock("./local-store", () => ({
  getBlob: vi.fn(async () => undefined),
  putBlob: vi.fn(),
  loadLocalWorkspace: vi.fn(),
  saveLocalWorkspace: vi.fn(),
  subscribeLocalWorkspaceCommits: vi.fn(() => () => undefined),
}));
const accountA = { id: "A", email: "a@example.com" };
const accountB = { id: "B", email: "b@example.com" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function setup(local = false) {
  const data = createDemoWorkspace();
  const source = data.sources[0];
  source.id = "source";
  source.versionId = "v2";
  source.blobKey = "current-local";
  source.storagePath = "A/v2/source.md";
  source.chunks = chunkText(source.text, source.id, source.versionId);
  const historical: SourceVersion = {
    versionId: "v1",
    title: "旧原件",
    filename: "old.md",
    kind: "markdown",
    mime: "text/markdown",
    size: 9,
    hash: "",
    status: "ready",
    text: "旧版本的正文。",
    chunks: chunkText("旧版本的正文。", source.id, "v1"),
    blobKey: "historical-local",
    storagePath: "A/v1/source.md",
    createdAt: source.createdAt,
    archivedAt: source.updatedAt,
  };
  source.versions = [historical];
  data.sources = [source];
  const io: WorkspaceIO = {
    loadLocal: vi.fn(async () => (local ? structuredClone(data) : null)),
    saveLocal: vi.fn(async () => {}),
    loadCloud: vi.fn(async (id) => ({
      data: id === "A" ? structuredClone(data) : createEmptyWorkspace(),
      revision: 1,
    })),
    saveCloud: vi.fn(async (_snapshot, revision) => ({ revision: revision + 1 })),
    getBlob: vi.fn(async () => undefined),
    uploadBlob: vi.fn(),
    downloadBlob: vi.fn(async () => undefined),
    askCloud: vi.fn(),
    cancelImportParse: vi.fn(),
    claimImportParse: vi.fn(),
    finishImportParse: vi.fn(),
    heartbeatImportParse: vi.fn(),
    releaseImportParse: vi.fn(),
    retryImportParse: vi.fn(),
    organizeCloud: vi.fn(),
    getModelStatus: vi.fn(async () => ({ mode: "extractive", message: "未配置模型" })),
    readLegacyMeta: vi.fn(() => null),
  };
  const coordinator = new WorkspaceCoordinator(io);
  await coordinator.activate(local ? null : accountA);
  const token = coordinator.getSnapshot().token;
  const old = getSourceVersion(coordinator.getSnapshot().data.sources[0], "v1")!;
  const change = (modify: (source: Source) => Source) =>
    coordinator.update((current) => ({ ...current, sources: current.sources.map(modify) }), token);
  return { data, io, coordinator, token, old, change };
}

describe("account-bound retained original reads", () => {
  it("reads the exact local historical original, including deleted recoverable sources, without trusting caller paths", async () => {
    const { coordinator, io, token, old, change } = await setup(true);
    change((source) => ({ ...source, deletedAt: "2026-09-12T23:00:00Z", aiAllowed: false }));
    const blob = new Blob(["historical bytes"]);
    vi.mocked(io.getBlob).mockResolvedValue(blob);
    const forged = {
      ...old,
      blobKey: "other-account-secret",
      storagePath: "B/v1/secret.md",
      kind: "pdf" as const,
    };
    expect(await coordinator.sourceBlob(forged, token)).toBe(blob);
    expect(io.getBlob).toHaveBeenCalledExactlyOnceWith("historical-local");
    expect(io.downloadBlob).not.toHaveBeenCalled();
  });

  it("downloads only the account-owned historical projection and keeps the source unchanged", async () => {
    const { coordinator, io, token, old } = await setup();
    const original = structuredClone(coordinator.getSnapshot().data);
    const blob = new Blob(["cloud historical bytes"]);
    vi.mocked(io.downloadBlob).mockResolvedValue(blob);
    expect(
      await coordinator.sourceBlob({ ...old, storagePath: "B/secret", blobKey: "fake" }, token),
    ).toBe(blob);
    expect(io.getBlob).toHaveBeenCalledExactlyOnceWith("historical-local");
    expect(io.downloadBlob).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: "source",
        versionId: "v1",
        title: "旧原件",
        kind: "markdown",
        blobKey: "historical-local",
        storagePath: "A/v1/source.md",
      }),
      "A",
    );
    expect(coordinator.getSnapshot().data).toEqual(original);
  });

  it("can skip a failed local store and download only the canonical cloud original", async () => {
    const { coordinator, io, token, old } = await setup();
    const blob = new Blob(["cloud-only historical bytes"]);
    vi.mocked(io.getBlob).mockRejectedValue(new Error("IndexedDB transaction closed"));
    vi.mocked(io.downloadBlob).mockResolvedValue(blob);

    await expect(
      coordinator.sourceBlob(
        { ...old, blobKey: "forged-local", storagePath: "B/secret/history.md" },
        token,
        { preferCloud: true },
      ),
    ).resolves.toBe(blob);
    expect(io.getBlob).not.toHaveBeenCalled();
    expect(io.downloadBlob).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: "source",
        versionId: "v1",
        blobKey: "historical-local",
        storagePath: "A/v1/source.md",
      }),
      "A",
    );
  });

  it("rejects missing histories and sources without reading current bytes or caller handles", async () => {
    const { coordinator, io, token, old } = await setup();
    for (const identity of [{ versionId: "missing-version" }, { id: "missing-source" }]) {
      await expect(coordinator.sourceBlob({ ...old, ...identity }, token)).rejects.toThrow(
        "资料版本已改变",
      );
    }
    expect(io.getBlob).not.toHaveBeenCalled();
    expect(io.downloadBlob).not.toHaveBeenCalled();
  });

  it("returns missing for an original-less history instead of borrowing current handles", async () => {
    const { coordinator, io, token, old, change } = await setup();
    change((source) => ({
      ...source,
      versions: source.versions!.map((version) => ({
        ...version,
        blobKey: undefined,
        storagePath: undefined,
      })),
    }));
    expect(await coordinator.sourceBlob(old, token)).toBeUndefined();
    expect(io.getBlob).not.toHaveBeenCalled();
    expect(io.downloadBlob).not.toHaveBeenCalled();
  });

  it.each(["local", "cloud"] as const)(
    "rejects both successful and failed late %s responses after an account switch without leaking old details",
    async (stage) => {
      for (const fail of [false, true]) {
        const { coordinator, io, token, old } = await setup();
        const pending = deferred<Blob | undefined>();
        vi.mocked(stage === "local" ? io.getBlob : io.downloadBlob).mockReturnValueOnce(
          pending.promise,
        );
        const outcome = coordinator.sourceBlob(old, token).then(
          (value) => ({ value, error: "" }),
          (error: Error) => ({ value: undefined, error: error.message }),
        );
        if (stage === "cloud")
          await vi.waitFor(() => expect(io.downloadBlob).toHaveBeenCalledOnce());
        await coordinator.activate(accountB);
        if (fail) pending.reject(new Error("A/private-path secret old-account-token"));
        else pending.resolve(new Blob(["PRIVATE_A_BYTES"]));
        const result = await outcome;
        expect(result.value).toBeUndefined();
        expect(result.error).toContain("当前账号已改变");
        expect(result.error).not.toMatch(/private|secret|token|PRIVATE/);
        expect(coordinator.getSnapshot().user?.id).toBe("B");
        if (stage === "local") expect(io.downloadBlob).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["v1", "v2"])(
    "rejects a changed original handle during an asynchronous read of %s",
    async (versionId) => {
      const { coordinator, io, token, change } = await setup();
      const requested = getSourceVersion(coordinator.getSnapshot().data.sources[0], versionId)!;
      const pending = deferred<Blob | undefined>();
      vi.mocked(io.downloadBlob).mockReturnValueOnce(pending.promise);
      const outcome = coordinator
        .sourceBlob(requested, token)
        .catch((error: Error) => error.message);
      await vi.waitFor(() => expect(io.downloadBlob).toHaveBeenCalledOnce());
      change((source) =>
        versionId === source.versionId
          ? { ...source, storagePath: "A/replaced-original.md" }
          : {
              ...source,
              versions: source.versions!.map((version) => ({
                ...version,
                storagePath: "A/replaced-old-original.md",
              })),
            },
      );
      pending.resolve(new Blob(["stale bytes"]));
      expect(await outcome).toContain("资料原件记录已变化");
    },
  );

  it("checks a removed historical version before continuing from local lookup to cloud download", async () => {
    const { coordinator, io, token, old, change } = await setup();
    const pending = deferred<Blob | undefined>();
    vi.mocked(io.getBlob).mockReturnValueOnce(pending.promise);
    const outcome = coordinator.sourceBlob(old, token).catch((error: Error) => error.message);
    change((source) => ({ ...source, versions: [] }));
    pending.resolve(undefined);
    expect(await outcome).toContain("资料版本已改变");
    expect(io.downloadBlob).not.toHaveBeenCalled();
  });

  it("exports current and retained cloud originals through the real coordinator resolver with valid archive CRC", async () => {
    const { coordinator, io, token } = await setup();
    vi.mocked(io.getBlob).mockRejectedValue(new Error("IndexedDB transaction closed"));
    vi.mocked(io.downloadBlob).mockImplementation(
      async (source) => new Blob([`${source.versionId} original bytes`]),
    );
    const state: WorkspaceData = coordinator.getSnapshot().data;
    const bytes = await buildWorkspaceArchive(state, (source, options) =>
      coordinator.sourceBlob(source, token, options),
    );
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const mapping = JSON.parse(await zip.file("source-mapping.json")!.async("string"))[0];
    expect(await zip.file(mapping.original)!.async("string")).toBe("v2 original bytes");
    expect(await zip.file(mapping.versions[0].original)!.async("string")).toBe("v1 original bytes");
    expect(io.getBlob).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(io.downloadBlob)
        .mock.calls.map(([source, owner]) => [source.versionId, source.storagePath, owner]),
    ).toEqual([
      ["v2", "A/v2/source.md", "A"],
      ["v1", "A/v1/source.md", "A"],
    ]);
  });
});
