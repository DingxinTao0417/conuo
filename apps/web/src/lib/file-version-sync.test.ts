import { describe, expect, it, vi } from "vitest";
import { prepareFile } from "./import";
import { createEmptyWorkspace } from "./seed";
import { replaceFileSource } from "./source-versions";
import type { Source, WorkspaceData } from "./types";
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
  getBlob: vi.fn(),
  putBlob: vi.fn(),
  loadLocalWorkspace: vi.fn(),
  saveLocalWorkspace: vi.fn(),
  subscribeLocalWorkspaceCommits: vi.fn(() => () => undefined),
}));
const accountA = { id: "A", email: "a@example.com" };
const accountB = { id: "B", email: "b@example.com" };
type Stored = WorkspaceData & { _conuoSync?: { revision: number; dirty: boolean } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function referenced(data: WorkspaceData, key: string) {
  return data.sources.some(
    (source) => source.blobKey === key || source.versions?.some((v) => v.blobKey === key),
  );
}
async function candidate(text: string, kind: "md" | "txt" = "md") {
  const blob = new File([text], `${text.slice(0, 15)}.${kind}`, {
    type: kind === "md" ? "text/markdown" : "text/plain",
  });
  const source = await prepareFile(blob, "");
  return { source, blob };
}
async function setup(cloud = false, initialUploaded = true) {
  const data = createEmptyWorkspace();
  const initial = await candidate("INITIAL original");
  initial.source.spaceIds = [data.spaces[0].id];
  initial.source.title = "用户手动命名";
  initial.source.tags = ["人工标签"];
  initial.source.aiAllowed = false;
  initial.source.starred = true;
  if (cloud && initialUploaded)
    initial.source.storagePath = `A/${initial.source.versionId}/${initial.source.id}.md`;
  data.sources = [initial.source];
  const disk = new Map<string, Stored>();
  if (!cloud) disk.set("local", structuredClone(data));
  const remote = new Map<string, { data: WorkspaceData; revision: number }>([
    ["A", { data: structuredClone(data), revision: 1 }],
    ["B", { data: createEmptyWorkspace(), revision: 1 }],
  ]);
  const blobs = new Map<string, Blob>([[initial.source.blobKey!, initial.blob]]);
  let announceLocalCommit:
    ((event: { accountId: string; localRevision: number; writerId: string }) => void) | undefined;
  const io: WorkspaceIO = {
    loadLocal: vi.fn(async (id = "local") => structuredClone(disk.get(id) ?? null)),
    saveLocal: vi.fn(async (snapshot, id = "local") => {
      disk.set(id, structuredClone(snapshot));
    }),
    loadCloud: vi.fn(async (id) => structuredClone(remote.get(id)!)),
    saveCloud: vi.fn(async (snapshot, revision, id) => {
      if (remote.get(id)!.revision !== revision) throw new Error("409 conflict");
      remote.set(id, { data: structuredClone(snapshot), revision: revision + 1 });
      return { revision: revision + 1 };
    }),
    getBlob: vi.fn(async (key) => blobs.get(key)),
    putBlobIfAbsent: vi.fn(async (key, blob) => {
      if (blobs.has(key)) return false;
      blobs.set(key, blob);
      return true;
    }),
    deleteUnreferencedBlob: vi.fn(async (key) => {
      if ([...disk.values()].some((snapshot) => referenced(snapshot, key))) return false;
      blobs.delete(key);
      return true;
    }),
    subscribeLocalCommits: vi.fn((_accountId, listener) => {
      announceLocalCommit = listener;
      return () => {
        announceLocalCommit = undefined;
      };
    }),
    uploadBlob: vi.fn(
      async (source, _blob, id) =>
        `${id}/${source.versionId}/${source.id}.${source.kind === "markdown" ? "md" : "txt"}`,
    ),
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
  await coordinator.activate(cloud ? accountA : null);
  const token = coordinator.getSnapshot().token;
  const replace = (
    next: { source: Source; blob: Blob },
    expected = coordinator.getSnapshot().data.sources[0].versionId,
  ) => coordinator.replaceFile(initial.source.id, expected, next.source, next.blob, token);
  const change = (modify: (data: WorkspaceData) => WorkspaceData) =>
    coordinator.update(modify, token);
  return {
    data,
    initial,
    coordinator,
    token,
    replace,
    change,
    io,
    disk,
    blobs,
    remote,
    announceLocalCommit: (localRevision: number) =>
      announceLocalCommit?.({
        accountId: cloud ? accountA.id : "local",
        localRevision,
        writerId: "other-tab",
      }),
  };
}
async function status(coordinator: WorkspaceCoordinator, value: string) {
  await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe(value));
}

describe("file replacement staging and cleanup", () => {
  it("resolves only after the replacement metadata is durable in IndexedDB", async () => {
    const { coordinator, io, replace, disk } = await setup();
    const next = await candidate("DURABLE replacement bytes", "txt");
    const write = deferred<void>();
    vi.mocked(io.saveLocal).mockImplementationOnce(async (snapshot, id = "local") => {
      await write.promise;
      disk.set(id, structuredClone(snapshot));
    });

    let settled = false;
    const saving = replace(next).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(io.saveLocal).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).toBe(false);

    write.resolve();
    await saving;
    expect(disk.get("local")!.sources[0]).toMatchObject({
      versionId: next.source.versionId,
      blobKey: next.source.blobKey,
    });
    expect(coordinator.getSnapshot().data.sources[0].versionId).toBe(next.source.versionId);
  });

  it("rechecks a newer tab commit after saving the original and before publishing metadata", async () => {
    const { coordinator, io, replace, initial, blobs, announceLocalCommit } = await setup();
    const next = await candidate("STALE-TAB replacement bytes", "txt");
    const write = deferred<boolean>();
    vi.mocked(io.putBlobIfAbsent!).mockImplementationOnce(async (key, blob) => {
      await write.promise;
      blobs.set(key, blob);
      return true;
    });

    const saving = replace(next);
    await vi.waitFor(() => expect(io.putBlobIfAbsent).toHaveBeenCalledOnce());
    announceLocalCommit(1);
    write.resolve(true);

    await expect(saving).rejects.toThrow("另一个标签页已保存更新");
    expect(coordinator.getSnapshot().data.sources[0].versionId).toBe(initial.source.versionId);
    expect(blobs.has(next.source.blobKey!)).toBe(false);
    expect(io.deleteUnreferencedBlob).toHaveBeenCalledExactlyOnceWith(next.source.blobKey);
  });

  it("waits for an immutable original before replacing and preserves concurrent manual metadata", async () => {
    const { coordinator, io, replace, change, initial, blobs } = await setup();
    const next = await candidate("SECOND original", "txt");
    const write = deferred<boolean>();
    vi.mocked(io.putBlobIfAbsent!).mockImplementationOnce(async (key, blob) => {
      const created = await write.promise;
      blobs.set(key, blob);
      return created;
    });
    const saving = replace(next);
    await vi.waitFor(() => expect(io.putBlobIfAbsent).toHaveBeenCalledOnce());
    expect(coordinator.getSnapshot().data.sources[0].versionId).toBe(initial.source.versionId);
    change((data) => ({
      ...data,
      sources: data.sources.map((source) => ({
        ...source,
        title: "保存途中改名",
        tags: ["新标签"],
      })),
    }));
    write.resolve(true);
    await saving;
    await status(coordinator, "local");
    const source = coordinator.getSnapshot().data.sources[0];
    expect(source).toMatchObject({
      id: initial.source.id,
      title: "保存途中改名",
      tags: ["新标签"],
      filename: next.source.filename,
      kind: "text",
      aiAllowed: false,
      starred: true,
      versionId: next.source.versionId,
      blobKey: next.source.blobKey,
    });
    expect(
      source.chunks.every(
        (chunk) => chunk.sourceId === source.id && chunk.versionId === source.versionId,
      ),
    ).toBe(true);
    expect(source.versions![0]).toMatchObject({
      versionId: initial.source.versionId,
      blobKey: initial.source.blobKey,
      filename: initial.source.filename,
      kind: "markdown",
    });
    expect(await blobs.get(next.source.blobKey!)!.text()).toBe("SECOND original");
    expect(io.deleteUnreferencedBlob).not.toHaveBeenCalled();
  });

  it("rejects stale preflights, byte mismatches and unavailable atomic IO before reserving bytes", async () => {
    const { coordinator, io, replace, initial } = await setup();
    const next = await candidate("NEW bytes");
    await expect(replace(next, "stale-version")).rejects.toThrow("已有新版本");
    await expect(replace({ ...next, blob: new Blob(["bad size"]) })).rejects.toThrow("大小");
    await expect(replace({ ...next, blob: new Blob(["BAD bytes"]) })).rejects.toThrow("内容");
    io.putBlobIfAbsent = undefined;
    await expect(replace(next)).rejects.toThrow("无法安全保存");
    expect(io.getBlob).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().data.sources[0].versionId).toBe(initial.source.versionId);
  });

  it.each(["different bytes", "NEW bytes"])(
    "never overwrites or cleans an already existing key: %s",
    async (text) => {
      const { io, blobs, replace, coordinator, initial } = await setup();
      const next = await candidate("NEW bytes");
      const existing = new Blob([text]);
      blobs.set(next.source.blobKey!, existing);
      await expect(replace(next)).rejects.toThrow();
      expect(blobs.get(next.source.blobKey!)).toBe(existing);
      expect(io.deleteUnreferencedBlob).not.toHaveBeenCalled();
      expect(coordinator.getSnapshot().data.sources[0].versionId).toBe(initial.source.versionId);
    },
  );

  it("rejects a duplicate concurrent candidate and never creates a second history entry", async () => {
    const { io, blobs, replace, coordinator } = await setup();
    const next = await candidate("NEW concurrent bytes");
    const write = deferred<boolean>();
    vi.mocked(io.putBlobIfAbsent!).mockImplementationOnce(async (key, blob) => {
      await write.promise;
      blobs.set(key, blob);
      return true;
    });
    const first = replace(next);
    await expect(replace(next)).rejects.toThrow("正在保存");
    write.resolve(true);
    await first;
    expect(io.putBlobIfAbsent).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot().data.sources[0].versions).toHaveLength(1);
  });

  it.each(["conflict", "capacity"] as const)(
    "cleans only its own unreferenced reservation when post-write validation fails: %s",
    async (reason) => {
      const { coordinator, io, blobs, replace, change, initial } = await setup();
      const next = await candidate("NEW aborted bytes");
      const alternative = await candidate("OTHER accepted bytes");
      const write = deferred<boolean>();
      vi.mocked(io.putBlobIfAbsent!).mockImplementationOnce(async (key, blob) => {
        blobs.set(key, blob);
        return write.promise;
      });
      const result = replace(next).catch((error: Error) => error.message);
      await vi.waitFor(() => expect(io.putBlobIfAbsent).toHaveBeenCalledOnce());
      if (reason === "conflict") {
        blobs.set(alternative.source.blobKey!, alternative.blob);
        change((data) =>
          replaceFileSource(data, initial.source.id, initial.source.versionId, alternative.source),
        );
      } else {
        const legacySource = { ...initial.source };
        delete legacySource.coverage;
        change((data) => ({
          ...data,
          sources: [
            ...data.sources,
            {
              ...legacySource,
              id: "capacity-source",
              text: "x".repeat(3 * 1024 * 1024),
              chunks: [],
            },
          ],
        }));
      }
      write.resolve(true);
      expect(await result).toContain(reason === "conflict" ? "已有新版本" : "3 MiB");
      expect(blobs.has(next.source.blobKey!)).toBe(false);
      expect(io.deleteUnreferencedBlob).toHaveBeenCalledExactlyOnceWith(next.source.blobKey);
      expect(coordinator.getSnapshot().data.sources[0].versionId).not.toBe(next.source.versionId);
    },
  );

  it.each(["memory", "disk", "uncertain"] as const)(
    "preserves an uncommitted original when cleanup cannot prove it unused: %s",
    async (boundary) => {
      const { io, blobs, disk, replace, change, initial } = await setup();
      const next = await candidate("NEW retained bytes");
      const write = deferred<boolean>();
      vi.mocked(io.putBlobIfAbsent!).mockImplementationOnce(async (key, blob) => {
        blobs.set(key, blob);
        return write.promise;
      });
      const result = replace(next).catch((error: Error) => error.message);
      await vi.waitFor(() => expect(io.putBlobIfAbsent).toHaveBeenCalledOnce());
      if (boundary === "memory") {
        change((data) =>
          replaceFileSource(data, initial.source.id, initial.source.versionId, next.source),
        );
      } else {
        change((data) => ({
          ...data,
          sources: data.sources.map((source) => ({
            ...source,
            deletedAt: new Date().toISOString(),
          })),
        }));
        if (boundary === "disk")
          disk.set("recovery:kept", {
            ...createEmptyWorkspace(),
            sources: [{ ...initial.source, blobKey: next.source.blobKey }],
          });
        else
          vi.mocked(io.deleteUnreferencedBlob!).mockRejectedValueOnce(
            new Error("cannot inspect disk"),
          );
      }
      write.resolve(true);
      expect(await result).toContain("未清理");
      expect(blobs.has(next.source.blobKey!)).toBe(true);
      if (boundary === "memory") expect(io.deleteUnreferencedBlob).not.toHaveBeenCalled();
    },
  );

  it("keeps an ambiguous write failure and a committed original after workspace persistence fails", async () => {
    const first = await setup();
    const next = await candidate("UNKNOWN write bytes");
    vi.mocked(first.io.putBlobIfAbsent!).mockImplementationOnce(async (key, blob) => {
      first.blobs.set(key, blob);
      throw new Error("write acknowledgement lost");
    });
    await expect(first.replace(next)).rejects.toThrow("未确认由本次操作创建");
    expect(first.io.deleteUnreferencedBlob).not.toHaveBeenCalled();
    expect(first.coordinator.getSnapshot().data.sources[0].versionId).toBe(
      first.initial.source.versionId,
    );
    const second = await setup();
    const accepted = await candidate("COMMITTED original bytes");
    vi.mocked(second.io.saveLocal).mockRejectedValueOnce(new Error("disk full"));
    await expect(second.replace(accepted)).rejects.toThrow("尚未保存到此浏览器");
    await status(second.coordinator, "error");
    expect(second.coordinator.getSnapshot().data.sources[0].versionId).toBe(
      accepted.source.versionId,
    );
    expect(second.coordinator.getSnapshot().error).toContain("尚未保存到此浏览器");
    expect(second.blobs.has(accepted.source.blobKey!)).toBe(true);
    expect(second.io.deleteUnreferencedBlob).not.toHaveBeenCalled();
    await second.coordinator.retry(second.token);
    expect(second.coordinator.getSnapshot().status).toBe("local");
  });

  it("cleans a newly reserved candidate after an account switch without writing or exposing it to the next account", async () => {
    const { coordinator, io, blobs, replace, disk } = await setup(true);
    const next = await candidate("PRIVATE_A candidate bytes");
    const write = deferred<boolean>();
    vi.mocked(io.putBlobIfAbsent!).mockImplementationOnce(async (key, blob) => {
      await write.promise;
      blobs.set(key, blob);
      return true;
    });
    const result = replace(next).catch((error: Error) => error.message);
    await vi.waitFor(() => expect(io.putBlobIfAbsent).toHaveBeenCalledOnce());
    await coordinator.activate(accountB);
    write.resolve(true);
    const message = await result;
    expect(message).toContain("当前账号已改变");
    expect(message).not.toContain("PRIVATE_A");
    expect(blobs.has(next.source.blobKey!)).toBe(false);
    expect(coordinator.getSnapshot().data.sources).toHaveLength(0);
    expect(disk.get("A")!.sources[0].versionId).not.toBe(next.source.versionId);
  });
});

describe("all-version original synchronization", () => {
  it("retains the new local version offline and uploads current and history before a successful cloud snapshot on retry", async () => {
    const { coordinator, io, replace, remote, initial, token, blobs } = await setup(true, false);
    const next = await candidate("OFFLINE new version", "txt");
    vi.mocked(io.uploadBlob).mockRejectedValueOnce(new Error("offline"));
    await replace(next);
    await status(coordinator, "error");
    expect(io.saveCloud).not.toHaveBeenCalled();
    expect(blobs.has(next.source.blobKey!)).toBe(true);
    expect(coordinator.getSnapshot().data.sources[0].versions![0].versionId).toBe(
      initial.source.versionId,
    );
    await coordinator.retry(token);
    expect(coordinator.getSnapshot().status).toBe("cloud");
    const saved = remote.get("A")!.data.sources[0];
    expect(saved.storagePath).toBe(`A/${next.source.versionId}/${initial.source.id}.txt`);
    expect(saved.versions![0].storagePath).toBe(
      `A/${initial.source.versionId}/${initial.source.id}.md`,
    );
    expect(
      vi.mocked(io.uploadBlob).mock.calls.every(([source]) => source.id === initial.source.id),
    ).toBe(true);
    expect(io.deleteUnreferencedBlob).not.toHaveBeenCalled();
  });

  it("blocks cloud saving for a missing old original while retaining a successfully uploaded current path across retry", async () => {
    const { coordinator, io, replace, initial, token, blobs, disk } = await setup(true, false);
    const next = await candidate("CURRENT complete bytes");
    blobs.delete(initial.source.blobKey!);
    await replace(next);
    await status(coordinator, "error");
    expect(io.saveCloud).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().error).toContain(initial.source.versionId);
    expect(disk.get("A")!.sources[0].storagePath).toContain(next.source.versionId);
    blobs.set(initial.source.blobKey!, initial.blob);
    await coordinator.retry(token);
    expect(coordinator.getSnapshot().status).toBe("cloud");
    expect(
      vi
        .mocked(io.uploadBlob)
        .mock.calls.filter(([source]) => source.versionId === next.source.versionId),
    ).toHaveLength(1);
    expect(coordinator.getSnapshot().data.sources[0].versions![0].storagePath).toContain(
      initial.source.versionId,
    );
  });

  it.each(["upload", "snapshot"] as const)(
    "merges an in-flight %s result into the exact old version after another replacement",
    async (stage) => {
      const { coordinator, io, replace, remote, initial } = await setup(true);
      const second = await candidate("SECOND in flight");
      const third = await candidate("THIRD latest", "txt");
      const gate = deferred<void>();
      if (stage === "upload")
        vi.mocked(io.uploadBlob).mockImplementationOnce(async (source, _blob, id) => {
          await gate.promise;
          return `${id}/${source.versionId}/${source.id}.md`;
        });
      else {
        const save = vi.mocked(io.saveCloud).getMockImplementation()!;
        vi.mocked(io.saveCloud).mockImplementationOnce(async (...args) => {
          await gate.promise;
          return save(...args);
        });
      }
      await replace(second);
      await vi.waitFor(() =>
        expect(stage === "upload" ? io.uploadBlob : io.saveCloud).toHaveBeenCalledOnce(),
      );
      await replace(third, second.source.versionId);
      gate.resolve();
      await status(coordinator, "cloud");
      const saved = remote.get("A")!.data.sources[0];
      expect(saved.versionId).toBe(third.source.versionId);
      expect(saved.storagePath).toBe(`A/${third.source.versionId}/${initial.source.id}.txt`);
      expect(saved.versions!.map((v) => v.versionId)).toEqual([
        second.source.versionId,
        initial.source.versionId,
      ]);
      expect(saved.versions![0].storagePath).toBe(
        `A/${second.source.versionId}/${initial.source.id}.md`,
      );
      expect(
        vi
          .mocked(io.uploadBlob)
          .mock.calls.filter(([source]) => source.versionId === second.source.versionId),
      ).toHaveLength(1);
    },
  );

  it("does not adopt an old upload acknowledgement after switching accounts", async () => {
    const { coordinator, io, replace, disk } = await setup(true);
    const next = await candidate("PRIVATE uploaded bytes");
    const upload = deferred<string>();
    vi.mocked(io.uploadBlob).mockReturnValueOnce(upload.promise);
    await replace(next);
    await vi.waitFor(() => expect(io.uploadBlob).toHaveBeenCalledOnce());
    await coordinator.activate(accountB);
    upload.resolve("A/late-upload/path");
    await vi.waitFor(() => expect(coordinator.getSnapshot().status).toBe("cloud"));
    expect(coordinator.getSnapshot().data.sources).toHaveLength(0);
    expect(disk.get("A")!.sources[0].storagePath).toBeUndefined();
    expect(io.saveCloud).not.toHaveBeenCalled();
  });

  it("rejects altered bytes before upload and rejects an upload result if the same version's original identity changes", async () => {
    const first = await setup(true);
    const next = await candidate("CHECK file bytes");
    const get = vi.mocked(first.io.getBlob).getMockImplementation()!;
    let reads = 0;
    vi.mocked(first.io.getBlob).mockImplementation(async (key) => {
      if (key === next.source.blobKey && ++reads === 2) return new Blob(["TAMPERED bytes"]);
      return get(key);
    });
    await first.replace(next);
    await status(first.coordinator, "error");
    expect(first.io.uploadBlob).not.toHaveBeenCalled();
    expect(first.io.saveCloud).not.toHaveBeenCalled();
    const second = await setup(true);
    const value = await candidate("INFLIGHT identity bytes");
    const upload = deferred<string>();
    vi.mocked(second.io.uploadBlob).mockReturnValueOnce(upload.promise);
    await second.replace(value);
    await vi.waitFor(() => expect(second.io.uploadBlob).toHaveBeenCalledOnce());
    second.change((data) => ({
      ...data,
      sources: data.sources.map((source) => ({ ...source, hash: "f".repeat(64) })),
    }));
    upload.resolve("A/stale-identity/path");
    await status(second.coordinator, "error");
    expect(second.coordinator.getSnapshot().data.sources[0].storagePath).toBeUndefined();
    expect(second.io.saveCloud).not.toHaveBeenCalled();
  });
});
