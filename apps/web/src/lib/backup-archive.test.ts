import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKUP_LIMITS, readWorkspaceBackup } from "./backup-archive";
import { buildWorkspaceArchive, buildWorkspaceArchiveResult } from "./export";
import { makeWebSource } from "./import";
import type { Citation, Source, SourceVersion, WorkspaceData } from "./types";
import type { LearningBackup } from "./learning/types";

const mocks = vi.hoisted(() => ({ getBlob: vi.fn() }));
vi.mock("./local-store", () => ({ getBlob: mocks.getBlob }));
const now = "2026-09-12T12:00:00.000Z";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const utf8 = (value: string) => new TextEncoder().encode(value);
const asBlob = (bytes: Uint8Array) =>
  new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/zip" });
function version(id: string, text: string, kind: "text" | "markdown"): SourceVersion {
  const bytes = utf8(text);
  return {
    versionId: id,
    title: "恢复验收-资料",
    filename: kind === "text" ? "当前.txt" : "历史.md",
    kind,
    mime: kind === "text" ? "text/plain" : "text/markdown",
    size: bytes.length,
    hash: sha(bytes),
    status: "ready",
    text,
    chunks: [
      {
        id: `chunk-${id}`,
        sourceId: "restore-file",
        versionId: id,
        text,
        section: "正文",
        order: 0,
      },
    ],
    createdAt: now,
    archivedAt: now,
    blobKey: `old-original-${id}`,
    storagePath: `prior-owner/${id}/restore-file.${kind === "text" ? "txt" : "md"}`,
  };
}
function fixture() {
  const current = version("current", "恢复验收当前资料：学习率为 24。", "text");
  const history = version("history", "# 恢复验收历史资料\n\n学习率为 12。", "markdown");
  const { archivedAt: _archived, ...fields } = current;
  void _archived;
  const source: Source = {
    ...fields,
    id: "restore-file",
    versions: [history],
    spaceIds: ["restore-space"],
    tags: ["恢复验收"],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    aiAllowed: true,
    starred: false,
  };
  const cite: Citation = {
    sourceId: source.id,
    versionId: history.versionId,
    chunkId: history.chunks[0].id,
    title: history.title,
    quote: history.text,
    section: "正文",
  };
  const web = makeWebSource({
    url: "https://example.com/conuo-restore",
    title: "恢复验收-网页",
    spaceId: "restore-space",
    text: "# 恢复验收网页\n\n这是包内保留的完整网页阅读正文。",
  });
  const link = makeWebSource({
    url: "https://example.com/conuo-link",
    title: "恢复验收-仅链接",
    spaceId: "restore-space",
    text: "",
  });
  const data: WorkspaceData = {
    schemaVersion: 1,
    spaces: [
      {
        id: "restore-space",
        name: "恢复验收知识库",
        goal: "验证完整恢复",
        color: "#4b3fe3",
        archived: false,
        createdAt: now,
      },
    ],
    sources: [source, web, link],
    aiEnabled: true,
    semanticSearch: false,
    autoOrganize: false,
    notes: ["note", "knowledge"].map((kind) => ({
      id: `restore-${kind}`,
      spaceId: "restore-space",
      title: `恢复验收-${kind === "note" ? "笔记" : "知识页"}`,
      content: "<p>核对历史资料中的学习率 12。</p>",
      kind: kind as "note" | "knowledge",
      status: "accepted",
      citations: [cite],
      versions: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })),
    annotations: [
      {
        id: "restore-annotation",
        sourceId: source.id,
        versionId: history.versionId,
        quote: history.text,
        note: "恢复验收历史标注",
        createdAt: now,
      },
    ],
    conversations: [
      {
        id: "restore-chat",
        spaceId: "restore-space",
        sourceId: source.id,
        sourceIds: [source.id],
        title: "恢复验收-历史对话",
        scope: "document",
        resolved: false,
        updatedAt: now,
        messages: [
          {
            id: "restore-answer",
            role: "assistant",
            content: "历史学习率为 12。",
            citations: [cite],
            createdAt: now,
            mode: "extractive",
          },
        ],
      },
    ],
  };
  const originals = new Map(
    [source, history].map((v) => [v.blobKey!, new Blob([v.text], { type: v.mime })]),
  );
  return { data, source, history, originals };
}
async function archive(data?: WorkspaceData, blobs?: Map<string, Blob>) {
  if (!data) {
    const f = fixture();
    data = f.data;
    blobs = f.originals;
  }
  mocks.getBlob.mockImplementation(async (key: string) => blobs?.get(key));
  const bytes = await buildWorkspaceArchive(data);
  mocks.getBlob.mockReset();
  return bytes;
}
async function edit(
  bytes: Uint8Array,
  change: (zip: JSZip) => Promise<void> | void,
  compression: "STORE" | "DEFLATE" = "DEFLATE",
) {
  const zip = await JSZip.loadAsync(bytes);
  await change(zip);
  return zip.generateAsync({ type: "uint8array", compression });
}
async function json(zip: JSZip, name: string) {
  return JSON.parse(await zip.file(name)!.async("string"));
}
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
type RawEntry = {
  name: string | Uint8Array;
  data?: Uint8Array;
  localName?: string;
  method?: number;
  flags?: number;
  size?: number;
  crc?: number;
  extra?: Uint8Array;
  attrs?: number;
};
function rawZip(items: RawEntry[]) {
  const local: Uint8Array[] = [],
    central: Uint8Array[] = [];
  let offset = 0;
  for (const item of items) {
    const name = typeof item.name === "string" ? utf8(item.name) : item.name;
    const localName = item.localName ? utf8(item.localName) : name;
    const data = item.data ?? new Uint8Array(),
      method = item.method ?? 0,
      flags = item.flags ?? 0x800;
    const compressed = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const extra = item.extra ?? new Uint8Array(),
      size = item.size ?? data.length,
      crc = item.crc ?? crc32(data);
    const header = new Uint8Array(30 + localName.length + extra.length),
      h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, flags, true);
    h.setUint16(8, method, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, compressed.length, true);
    h.setUint32(22, size, true);
    h.setUint16(26, localName.length, true);
    h.setUint16(28, extra.length, true);
    header.set(localName, 30);
    header.set(extra, 30 + localName.length);
    const record = new Uint8Array(46 + name.length + extra.length),
      c = new DataView(record.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 0x314, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, flags, true);
    c.setUint16(10, method, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, compressed.length, true);
    c.setUint32(24, size, true);
    c.setUint16(28, name.length, true);
    c.setUint16(30, extra.length, true);
    c.setUint32(38, item.attrs ?? 0, true);
    c.setUint32(42, offset, true);
    record.set(name, 46);
    record.set(extra, 46 + name.length);
    local.push(header, compressed);
    central.push(record);
    offset += header.length + compressed.length;
  }
  const centralSize = central.reduce((sum, value) => sum + value.length, 0);
  const end = new Uint8Array(22),
    e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, items.length, true);
  e.setUint16(10, items.length, true);
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let cursor = 0;
  for (const part of [...local, ...central, end]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("strict portable workspace ZIP reader", () => {
  it("round trips the optional learning.json archive alongside the workspace", async () => {
    const { data, originals } = fixture();
    const learning: LearningBackup = {
      schemaVersion: 1,
      items: [],
      reviewLogs: [],
      settings: { dailyNewLimit: 20, desiredRetention: 0.9, paused: false },
    };
    const archive = await buildWorkspaceArchiveResult(data, {
      learning,
      resolveBlob: async (source) => (source.blobKey ? originals.get(source.blobKey) : undefined),
    });
    const restored = await readWorkspaceBackup(asBlob(archive.bytes));
    expect(restored.learning).toEqual(learning);
  });
  it("roundtrips current/history originals, web text/links, historical citations, notes, annotations and conversations", async () => {
    const f = fixture();
    const snapshot = structuredClone(f.data);
    const bytes = await archive(f.data, f.originals);
    const network = vi.spyOn(globalThis, "fetch");
    const progress = vi.fn();
    const result = await readWorkspaceBackup(asBlob(bytes), { onProgress: progress });
    expect(result.data).toEqual(snapshot);
    expect(f.data).toEqual(snapshot);
    expect(result.fingerprint).toBe(sha(bytes));
    expect(result.missingOriginals).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.originals.map((o) => [o.sourceId, o.versionId])).toEqual([
      [f.source.id, "current"],
      [f.source.id, "history"],
    ]);
    expect(await result.originals[1].blob.text()).toBe(f.history.text);
    expect(result.originals[1].blob.type).toBe("text/markdown");
    expect(result.data.notes[0].citations[0].versionId).toBe("history");
    expect(result.data.sources[2].status).toBe("link-only");
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "ready" }));
    expect(mocks.getBlob).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    if (process.env.CONUO_WRITE_BACKUP_FIXTURES === "1") {
      const root = new URL("../../../../work/backup-restore-preview/", import.meta.url);
      await mkdir(root, { recursive: true });
      await writeFile(new URL("valid-backup.zip", root), bytes);
      const missing = await archive(f.data, new Map());
      await writeFile(new URL("missing-backup.zip", root), missing);
      const broken = bytes.slice();
      broken[40] ^= 0xff;
      await writeFile(new URL("corrupt-backup.zip", root), broken);
      expect((await readWorkspaceBackup(asBlob(missing))).missingOriginals).toHaveLength(2);
      await expect(readWorkspaceBackup(asBlob(broken))).rejects.toThrow();
    }
  });
  it("also accepts STORE and streamed data descriptors from a compatible ZIP writer", async () => {
    const bytes = await archive();
    const store = await edit(bytes, () => {}, "STORE");
    expect((await readWorkspaceBackup(asBlob(store))).originals).toHaveLength(2);
    const zip = await JSZip.loadAsync(bytes);
    const stream = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      streamFiles: true,
    });
    expect((await readWorkspaceBackup(asBlob(stream))).originals).toHaveLength(2);
  });
  it("keeps explicit missing originals for every exact version, never resolving old storage or blob paths", async () => {
    const f = fixture();
    f.source.deletedAt = now;
    const bytes = await archive(f.data, new Map());
    const result = await readWorkspaceBackup(asBlob(bytes));
    expect(result.originals).toEqual([]);
    expect(result.missingOriginals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: f.source.id, versionId: "current" }),
        expect.objectContaining({
          sourceId: f.source.id,
          versionId: "history",
          reason: expect.stringContaining("不使用当前原件"),
        }),
      ]),
    );
    expect(result.missingOriginals).toHaveLength(2);
    expect(result.data.sources[0].deletedAt).toBe(now);
    expect(mocks.getBlob).not.toHaveBeenCalled();
  });
  it("preserves originalMissing through missing exports and clears it only for verified contained bytes", async () => {
    const f = fixture();
    f.source.originalMissing = true;
    delete f.source.blobKey;
    delete f.source.storagePath;
    const bytes = await archive(f.data, f.originals);
    expect((await readWorkspaceBackup(asBlob(bytes))).missingOriginals).toEqual([
      expect.objectContaining({ versionId: "current" }),
    ]);
    const complete = fixture();
    const contained = await edit(await archive(complete.data, complete.originals), async (zip) => {
      const data = await json(zip, "workspace.json");
      data.sources[0].originalMissing = true;
      delete data.sources[0].blobKey;
      delete data.sources[0].storagePath;
      zip.file("workspace.json", JSON.stringify(data));
      zip.file("sources/restore-file/metadata.json", JSON.stringify(data.sources[0]));
    });
    const present = await readWorkspaceBackup(asBlob(contained));
    expect(present.data.sources[0].originalMissing).toBeUndefined();
  });
  it("recomputes legacy hashes only in the prepared copy and warns, but rejects wrong SHA or original size", async () => {
    const f = fixture();
    f.source.hash = "legacy";
    const result = await readWorkspaceBackup(asBlob(await archive(f.data, f.originals)));
    expect(result.data.sources[0].hash).toBe(sha(utf8(f.source.text)));
    expect(f.source.hash).toBe("legacy");
    expect(result.warnings).toHaveLength(1);
    f.source.hash = "0".repeat(64);
    await expect(readWorkspaceBackup(asBlob(await archive(f.data, f.originals)))).rejects.toThrow(
      "SHA-256",
    );
    f.source.hash = "";
    f.source.size++;
    await expect(readWorkspaceBackup(asBlob(await archive(f.data, f.originals)))).rejects.toThrow(
      "大小",
    );
  });
  it.each([
    "missing-source",
    "duplicate-source",
    "missing-history",
    "wrong-history",
    "wrong-original",
    "metadata",
    "text",
    "chunks",
    "webSnapshot",
  ])("rejects %s mapping/content inconsistency", async (kind) => {
    const changed = await edit(await archive(), async (zip) => {
      const mapping = await json(zip, "source-mapping.json");
      if (kind === "missing-source") mapping.pop();
      if (kind === "duplicate-source") mapping[1] = mapping[0];
      if (kind === "missing-history") mapping[0].versions = [];
      if (kind === "wrong-history") mapping[0].versions[0].versionId = "current";
      if (kind === "wrong-original") mapping[0].versions[0].original = mapping[0].original;
      if (kind === "metadata") zip.file(mapping[0].metadata, JSON.stringify({ id: "forged" }));
      if (kind === "text")
        zip.file(mapping[0].versions[0].extractedText, "current body substituted");
      if (kind === "chunks") zip.file(mapping[0].chunks, "[]");
      if (kind === "webSnapshot") zip.file(mapping[1].webSnapshot, "{}");
      zip.file("source-mapping.json", JSON.stringify(mapping));
    });
    await expect(readWorkspaceBackup(asBlob(changed))).rejects.toThrow();
  });
  it("allows a missing mapped original with a warning item, but never tolerates missing canonical metadata", async () => {
    const original = await archive();
    const missing = await edit(original, async (zip) => {
      zip.remove((await json(zip, "source-mapping.json"))[0].versions[0].original);
    });
    expect((await readWorkspaceBackup(asBlob(missing))).missingOriginals[0]).toMatchObject({
      versionId: "history",
    });
    const broken = await edit(original, async (zip) => {
      zip.remove((await json(zip, "source-mapping.json"))[0].metadata);
    });
    await expect(readWorkspaceBackup(asBlob(broken))).rejects.toThrow("缺失");
  });
  it.each(["unknown-field", "duplicate-id", "wrong-chunk", "invalid-version"])(
    "requires strict workspace identity/schema: %s",
    async (mode) => {
      const changed = await edit(await archive(), async (zip) => {
        const data = await json(zip, "workspace.json");
        if (mode === "unknown-field") data.secretCommand = "do something";
        if (mode === "duplicate-id") data.spaces.push(data.spaces[0]);
        if (mode === "wrong-chunk") data.sources[1].chunks[0].sourceId = "restore-file";
        if (mode === "invalid-version") data.schemaVersion = 999;
        zip.file("workspace.json", JSON.stringify(data));
      });
      await expect(readWorkspaceBackup(asBlob(changed))).rejects.toThrow();
    },
  );
  it.each([
    "../escape",
    "/absolute",
    "C:/drive",
    "folder\\escape",
    "a/./b",
    "a//b",
    "bad\u0000path",
  ])("rejects unsafe raw path %j before JSZip normalization", async (name) => {
    await expect(readWorkspaceBackup(asBlob(rawZip([{ name }])))).rejects.toThrow("路径");
  });
  it("rejects duplicate raw paths, file/directory conflicts, invalid UTF8 and unmatched local names", async () => {
    for (const values of [
      [{ name: "workspace.json" }, { name: "workspace.json" }],
      [{ name: "a" }, { name: "a/b" }],
      [{ name: new Uint8Array([0xc3, 0x28]) }],
      [{ name: "central", localName: "local" }],
    ])
      await expect(readWorkspaceBackup(asBlob(rawZip(values)))).rejects.toThrow();
  });
  it("rejects alternate Unicode paths and inconsistent or overlapping local header records", async () => {
    const replacement = utf8("different");
    const extra = new Uint8Array(9 + replacement.length),
      view = new DataView(extra.buffer);
    view.setUint16(0, 0x7075, true);
    view.setUint16(2, 5 + replacement.length, true);
    extra[4] = 1;
    view.setUint32(5, crc32(utf8("entry")), true);
    extra.set(replacement, 9);
    await expect(readWorkspaceBackup(asBlob(rawZip([{ name: "entry", extra }])))).rejects.toThrow(
      "Unicode",
    );
    const inconsistent = rawZip([{ name: "entry", data: utf8("body") }]);
    new DataView(inconsistent.buffer).setUint32(14, 1, true);
    await expect(readWorkspaceBackup(asBlob(inconsistent))).rejects.toThrow("本地");
    const overlap = rawZip([{ name: "first" }, { name: "other" }]),
      h = new DataView(overlap.buffer);
    const central = h.getUint32(overlap.length - 6, true);
    h.setUint32(central + 46 + 5 + 42, 0, true);
    await expect(readWorkspaceBackup(asBlob(overlap))).rejects.toThrow();
  });
  it("rejects non-UTF8 JSON instead of repairing replacement characters", async () => {
    const bytes = await edit(await archive(), (zip) => {
      zip.file("workspace.json", new Uint8Array([0xc3, 0x28]));
    });
    await expect(readWorkspaceBackup(asBlob(bytes))).rejects.toThrow("UTF-8 JSON");
  });
  it.each(["encryption", "compression", "zip64", "symlink", "multi-volume"])(
    "rejects unsupported %s records",
    async (mode) => {
      const item: RawEntry = { name: "entry" };
      if (mode === "encryption") item.flags = 1;
      if (mode === "compression") item.method = 12;
      if (mode === "zip64") item.extra = new Uint8Array([1, 0, 0, 0]);
      if (mode === "symlink") item.attrs = 0xa1ff0000;
      const bytes = rawZip([item]);
      if (mode === "multi-volume") new DataView(bytes.buffer).setUint16(bytes.length - 18, 1, true);
      await expect(readWorkspaceBackup(asBlob(bytes))).rejects.toThrow();
    },
  );
  it("rejects CRC damage even for unused entries and detects a forged tiny expanded size while streaming", async () => {
    const zip = await JSZip.loadAsync(await archive());
    const files: RawEntry[] = [];
    for (const file of Object.values(zip.files).filter((f) => !f.dir)) {
      const data = await file.async("uint8array");
      files.push({ name: file.name, data, method: data.length ? 8 : 0 });
    }
    await expect(
      readWorkspaceBackup(
        asBlob(rawZip([...files, { name: "unused.bin", data: utf8("bytes"), crc: 1 }])),
      ),
    ).rejects.toThrow("CRC");
    await expect(
      readWorkspaceBackup(
        asBlob(
          rawZip([
            ...files,
            { name: "bomb.bin", data: new Uint8Array(4 * 1024 * 1024), method: 8, size: 1 },
          ]),
        ),
      ),
    ).rejects.toMatchObject({ code: "BACKUP_LIMIT" });
  });
  it("checks archive, declared entry, JSON, total expansion and entry-count limits before inflating", async () => {
    const tooBig = { size: BACKUP_LIMITS.archive + 1, arrayBuffer: vi.fn() } as unknown as Blob;
    await expect(readWorkspaceBackup(tooBig)).rejects.toMatchObject({ code: "BACKUP_LIMIT" });
    expect(tooBig.arrayBuffer).not.toHaveBeenCalled();
    const candidates = [
      rawZip([{ name: "large", method: 8, size: BACKUP_LIMITS.entry + 1 }]),
      rawZip([{ name: "workspace.json", method: 8, size: BACKUP_LIMITS.json + 1 }]),
      rawZip(
        Array.from({ length: 6 }, (_, i) => ({
          name: `entry-${i}`,
          method: 8,
          size: BACKUP_LIMITS.entry,
        })),
      ),
    ];
    const count = rawZip([]),
      view = new DataView(count.buffer);
    view.setUint16(8, 50_001, true);
    view.setUint16(10, 50_001, true);
    candidates.push(count);
    for (const bytes of candidates)
      await expect(readWorkspaceBackup(asBlob(bytes))).rejects.toMatchObject({
        code: "BACKUP_LIMIT",
      });
  });
  it("rejects a real DEFLATE payload falsely declared empty before JSZip discards its compressed data", async () => {
    const zip = await JSZip.loadAsync(await archive());
    const files: RawEntry[] = [];
    for (const file of Object.values(zip.files).filter((f) => !f.dir)) {
      const data = await file.async("uint8array");
      files.push({ name: file.name, data, method: data.length ? 8 : 0 });
    }
    const bytes = rawZip([
      ...files,
      { name: "unused.bin", data: utf8("must be checked"), method: 8, size: 0, crc: 0 },
    ]);
    const load = vi.spyOn(JSZip, "loadAsync");
    await expect(readWorkspaceBackup(asBlob(bytes))).rejects.toMatchObject({
      code: "INVALID_ARCHIVE",
    });
    expect(load).not.toHaveBeenCalled();
  });
  it("supports cancellation before reading, during directory validation and during entry verification", async () => {
    const bytes = await archive();
    for (const phase of ["before", "directory", "verify"]) {
      const controller = new AbortController();
      if (phase === "before") controller.abort();
      await expect(
        readWorkspaceBackup(asBlob(bytes), {
          signal: controller.signal,
          onProgress: (p) => {
            if (p.phase === phase) controller.abort();
          },
        }),
      ).rejects.toMatchObject({ code: "BACKUP_CANCELLED" });
    }
  });
  it("cancels during a real entry's streamed decompression and does not continue to later entries", async () => {
    const bytes = await edit(await archive(), (zip) => {
      zip.file("cancel-me.bin", new Uint8Array(2 * 1024 * 1024));
      zip.file("later.bin", "later");
    });
    const controller = new AbortController();
    const progress = vi.fn();
    let entered = false;
    const load = JSZip.loadAsync.bind(JSZip);
    vi.spyOn(JSZip, "loadAsync").mockImplementation(async (...args) => {
      const zip = await load(...args);
      const item = zip.files["cancel-me.bin"] as JSZip.JSZipObject & {
        internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
      };
      const stream = item.internalStream.bind(item);
      item.internalStream = (type) =>
        stream(type).on("data", () => {
          entered = true;
          controller.abort();
        });
      return zip;
    });
    await expect(
      readWorkspaceBackup(asBlob(bytes), { signal: controller.signal, onProgress: progress }),
    ).rejects.toMatchObject({ code: "BACKUP_CANCELLED" });
    expect(entered).toBe(true);
    expect(progress).not.toHaveBeenCalledWith(expect.objectContaining({ phase: "ready" }));
  });
});
