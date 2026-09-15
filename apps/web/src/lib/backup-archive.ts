import JSZip from "jszip";
import { z } from "zod";
import { workspaceSchema } from "./supabase/validation";
import type { PreparedBackup } from "./backup-types";
import type { Source, SourceVersion, WorkspaceData } from "./types";

export const BACKUP_LIMITS = Object.freeze({
  archive: 128 * 1024 * 1024,
  expanded: 256 * 1024 * 1024,
  entry: 50 * 1024 * 1024,
  json: 24 * 1024 * 1024,
  entries: 50_000,
});
export class BackupArchiveError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BackupArchiveError";
  }
}
type Options = {
  signal?: AbortSignal;
  onProgress?: (progress: { phase: string; completed: number; total: number }) => void;
};
type Entry = {
  name: string;
  directory: boolean;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  end: number;
};
const bad = (message = "备份 ZIP 结构无效或已损坏。") =>
  new BackupArchiveError("INVALID_ARCHIVE", message);
const limit = () =>
  new BackupArchiveError("BACKUP_LIMIT", "备份超过支持的容量或条目上限，未截断或恢复任何内容。");
function check(signal?: AbortSignal) {
  if (signal?.aborted) throw new BackupArchiveError("BACKUP_CANCELLED", "已停止读取备份。");
}
function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw bad("备份包含无效的 UTF-8 内容。");
  }
}
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function crcUpdate(value: number, bytes: Uint8Array): number {
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return value >>> 0;
}
const crc32 = (bytes: Uint8Array) => (crcUpdate(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
function safePath(name: string) {
  if (!name || name.length > 4096 || name.startsWith("/") || /[\\:\x00-\x1f\x7f]/.test(name))
    throw bad("备份包含不安全的文件路径。");
  const segments = name.replace(/\/$/, "").split("/");
  if (segments.some((part) => !part || part === "." || part === ".."))
    throw bad("备份包含不安全的文件路径。");
}

/** Validate raw central/local records before JSZip can normalize paths or overwrite duplicate names.
 * ZIP record layout: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 * This deliberately accepts only single-volume STORE/DEFLATE archives, without ZIP64/encryption. */
function inspect(bytes: Uint8Array, options: Options): Entry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (offset: number, size: number) => {
    if (offset < 0 || size < 0 || offset + size > bytes.length) throw bad();
  };
  const u16 = (offset: number) => {
    need(offset, 2);
    return view.getUint16(offset, true);
  };
  const u32 = (offset: number) => {
    need(offset, 4);
    return view.getUint32(offset, true);
  };
  let end = -1;
  for (let pos = bytes.length - 22; pos >= Math.max(0, bytes.length - 65_557); pos--) {
    if (u32(pos) === 0x06054b50 && pos + 22 + u16(pos + 20) === bytes.length) {
      end = pos;
      break;
    }
  }
  if (end < 0) throw bad();
  const count = u16(end + 10),
    centralSize = u32(end + 12),
    centralOffset = u32(end + 16);
  if (
    u16(end + 4) !== 0 ||
    u16(end + 6) !== 0 ||
    u16(end + 8) !== count ||
    count === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  )
    throw bad("不支持分卷或 ZIP64 备份。");
  if (count > BACKUP_LIMITS.entries) throw limit();
  if (centralOffset + centralSize !== end) throw bad();
  decode(bytes.subarray(end + 22));
  const entries: Entry[] = [],
    names = new Set<string>();
  let cursor = centralOffset,
    expanded = 0;
  function extras(offset: number, length: number, filename: Uint8Array, comment: Uint8Array) {
    need(offset, length);
    const stop = offset + length,
      ids = new Set<number>();
    while (offset < stop) {
      if (offset + 4 > stop) throw bad();
      const id = u16(offset),
        size = u16(offset + 2);
      offset += 4;
      if (offset + size > stop || ids.has(id)) throw bad();
      ids.add(id);
      if ([0x0001, 0x0017, 0x9901].includes(id)) throw bad("不支持 ZIP64 或加密备份。");
      if (id === 0x7075 || id === 0x6375) {
        const raw = id === 0x7075 ? filename : comment;
        if (
          size < 5 ||
          bytes[offset] !== 1 ||
          u32(offset + 1) !== crc32(raw) ||
          decode(bytes.subarray(offset + 5, offset + size)) !== decode(raw)
        )
          throw bad("备份的 Unicode 文件名或注释不一致。");
      }
      offset += size;
    }
  }
  for (let i = 0; i < count; i++) {
    check(options.signal);
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) throw bad();
    const version = u16(cursor + 6),
      flags = u16(cursor + 8),
      method = u16(cursor + 10);
    const crc = u32(cursor + 16),
      compressed = u32(cursor + 20),
      size = u32(cursor + 24);
    const nameSize = u16(cursor + 28),
      extraSize = u16(cursor + 30),
      commentSize = u16(cursor + 32);
    const offset = u32(cursor + 42),
      attributes = u32(cursor + 38),
      unixType = (attributes >>> 16) & 0xf000;
    if (
      version < 10 ||
      version > 20 ||
      (flags & ~0x080e) !== 0 ||
      ![0, 8].includes(method) ||
      (method === 0 && (flags & 6) !== 0) ||
      u16(cursor + 34) !== 0 ||
      offset === 0xffffffff ||
      compressed === 0xffffffff ||
      size === 0xffffffff
    )
      throw bad("备份使用了不支持的压缩、加密、多卷或 ZIP64 格式。");
    if (unixType && ![0x4000, 0x8000].includes(unixType))
      throw bad("备份包含不支持的链接或特殊文件。");
    const next = cursor + 46 + nameSize + extraSize + commentSize;
    if (next > end) throw bad();
    const filename = bytes.subarray(cursor + 46, cursor + 46 + nameSize);
    const name = decode(filename);
    safePath(name);
    if (names.has(name)) throw bad("备份包含重复文件路径。");
    names.add(name);
    const directory = name.endsWith("/");
    if (
      (attributes & 8) !== 0 ||
      ((attributes & 16) !== 0 && !directory) ||
      (unixType === 0x4000 && !directory) ||
      (directory && (size !== 0 || compressed !== 0 || crc !== 0))
    )
      throw bad();
    if (
      size > BACKUP_LIMITS.entry ||
      (["workspace.json", "source-mapping.json"].includes(name) && size > BACKUP_LIMITS.json)
    )
      throw limit();
    expanded += size;
    if (expanded > BACKUP_LIMITS.expanded) throw limit();
    // JSZip replaces entries declaring zero expanded bytes with an empty string,
    // bypassing the compressed payload and its CRC. Our exporter stores empty
    // entries with zero compressed bytes, so reject the ambiguous form up front.
    if (size === 0 && compressed !== 0) throw bad("空文件记录包含未验证的压缩数据。");
    if (method === 0 && compressed !== size) throw bad();
    const comment = bytes.subarray(next - commentSize, next);
    decode(comment);
    extras(cursor + 46 + nameSize, extraSize, filename, comment);
    if (
      offset + 30 > centralOffset ||
      u32(offset) !== 0x04034b50 ||
      u16(offset + 4) !== version ||
      u16(offset + 6) !== flags ||
      u16(offset + 8) !== method
    )
      throw bad("备份的本地文件头与中央目录不一致。");
    const localNameSize = u16(offset + 26),
      localExtraSize = u16(offset + 28);
    const dataStart = offset + 30 + localNameSize + localExtraSize;
    if (
      dataStart + compressed > centralOffset ||
      !equalBytes(filename, bytes.subarray(offset + 30, offset + 30 + localNameSize))
    )
      throw bad("备份的文件名或数据范围不一致。");
    extras(offset + 30 + localNameSize, localExtraSize, filename, comment);
    let localEnd = dataStart + compressed;
    const sameHeader =
      u32(offset + 14) === crc && u32(offset + 18) === compressed && u32(offset + 22) === size;
    if (flags & 8) {
      if (
        !sameHeader &&
        (u32(offset + 14) !== 0 || u32(offset + 18) !== 0 || u32(offset + 22) !== 0)
      )
        throw bad();
      const descriptor = u32(localEnd) === 0x08074b50 ? localEnd + 4 : localEnd;
      if (
        descriptor + 12 > centralOffset ||
        u32(descriptor) !== crc ||
        u32(descriptor + 4) !== compressed ||
        u32(descriptor + 8) !== size
      )
        throw bad("备份的数据描述符不一致。");
      localEnd = descriptor + 12;
    } else if (!sameHeader) throw bad("备份的本地大小或校验值不一致。");
    entries.push({ name, directory, crc, compressed, size, offset, end: localEnd });
    cursor = next;
    options.onProgress?.({ phase: "directory", completed: i + 1, total: count });
  }
  if (cursor !== end) throw bad();
  let localCursor = 0;
  for (const entry of [...entries].sort((a, b) => a.offset - b.offset)) {
    if (entry.offset !== localCursor) throw bad("备份包含重叠、未登记或不连续的文件数据。");
    localCursor = entry.end;
  }
  if (localCursor !== centralOffset) throw bad();
  // A regular file cannot also serve as another entry's parent directory.
  for (const entry of entries) {
    const pieces = entry.name.replace(/\/$/, "").split("/");
    for (let i = 1; i < pieces.length; i++)
      if (names.has(pieces.slice(0, i).join("/"))) throw bad("备份的文件与目录路径冲突。");
  }
  return entries;
}

// JSZip documents internalStream, but 3.10.1's declaration omits it on JSZipObject.
type StreamingEntry = JSZip.JSZipObject & {
  internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
};
async function readEntry(
  zip: JSZip,
  entry: Entry,
  keep: boolean,
  budget: { actual: number },
  signal?: AbortSignal,
): Promise<Uint8Array> {
  check(signal);
  const file = zip.files[entry.name];
  if (
    !file ||
    file.name !== entry.name ||
    file.dir !== entry.directory ||
    (file.unsafeOriginalName !== undefined && file.unsafeOriginalName !== entry.name)
  )
    throw bad();
  if (entry.directory) return new Uint8Array();
  return new Promise((resolve, reject) => {
    const stream = (file as StreamingEntry).internalStream("uint8array");
    let length = 0,
      crc = 0xffffffff,
      settled = false;
    let pieces: Uint8Array[] = [];
    const stop = (error: Error) => {
      if (settled) return;
      settled = true;
      stream.pause();
      pieces = [];
      signal?.removeEventListener("abort", abort);
      reject(error);
    };
    const abort = () => stop(new BackupArchiveError("BACKUP_CANCELLED", "已停止读取备份。"));
    signal?.addEventListener("abort", abort, { once: true });
    stream
      .on("data", (chunk) => {
        if (settled) return;
        length += chunk.length;
        budget.actual += chunk.length;
        if (signal?.aborted) {
          abort();
          return;
        }
        if (
          length > entry.size ||
          length > BACKUP_LIMITS.entry ||
          budget.actual > BACKUP_LIMITS.expanded
        ) {
          stop(limit());
          return;
        }
        crc = crcUpdate(crc, chunk);
        if (keep) pieces.push(chunk);
      })
      .on("error", () => stop(bad("备份文件解压失败或内容已损坏。")))
      .on("end", () => {
        if (settled) return;
        if (length !== entry.size || (crc ^ 0xffffffff) >>> 0 !== entry.crc) {
          stop(bad("备份文件的长度或 CRC 校验不匹配。"));
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", abort);
        const result = new Uint8Array(keep ? length : 0);
        let cursor = 0;
        for (const piece of pieces) {
          result.set(piece, cursor);
          cursor += piece.length;
        }
        pieces = [];
        resolve(result);
      });
    if (signal?.aborted) abort();
    else stream.resume();
  });
}
function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decode(bytes));
  } catch {
    throw bad("备份 JSON 不是有效的 UTF-8 JSON 文档。");
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const path = z.string().min(1).max(4096);
const mappingVersion = z
  .object({
    sourceId: z.string(),
    versionId: z.string(),
    title: z.string().max(512),
    deletedAt: z.string().nullable(),
    versionState: z.enum(["current", "historical"]),
    metadata: path,
    chunks: path,
    original: path.nullable(),
    extractedText: path,
    originalStatus: z.string().max(2000),
    originalStatusFile: path,
    webSnapshot: path.nullable(),
    createdAt: z.string(),
    archivedAt: z.string().nullable(),
  })
  .strict();
const mappingSchema = z
  .array(mappingVersion.extend({ versions: z.array(mappingVersion).max(200) }).strict())
  .max(5000);
function archiveFilename(value: string) {
  let name =
    Array.from(value.replace(/[<>:"/\\|?*]/g, "_"))
      .filter((c) => c.charCodeAt(0) >= 32)
      .join("")
      .slice(0, 100)
      .replace(/[. ]+$/, "") || "未命名";
  if (
    [
      "metadata.json",
      "source.json",
      "extracted.txt",
      "chunks.json",
      "web-snapshot.json",
      "original-status.txt",
      "versions",
    ].includes(name.toLowerCase())
  )
    name = `original-${name}`;
  return name;
}
function validateIdentities(data: WorkspaceData) {
  for (const values of [
    data.spaces,
    data.sources,
    data.notes,
    data.annotations,
    data.conversations,
    data.organizationJobs ?? [],
    data.conceptRelations ?? [],
  ])
    if (new Set(values.map((v) => v.id)).size !== values.length)
      throw bad("工作区包含重复对象标识。");
  for (const source of data.sources) {
    const versions = [source, ...(source.versions ?? [])];
    if (new Set(versions.map((v) => v.versionId)).size !== versions.length)
      throw bad("资料版本标识重复。");
    for (const version of versions) {
      if (
        new Set(version.chunks.map((c) => c.id)).size !== version.chunks.length ||
        version.chunks.some(
          (c) =>
            c.sourceId !== source.id ||
            c.versionId !== version.versionId ||
            !version.text.includes(c.text),
        )
      )
        throw bad("资料片段与准确版本不一致。");
    }
  }
}
async function digest(bytes: Uint8Array, signal?: AbortSignal) {
  check(signal);
  const result = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  check(signal);
  return Array.from(new Uint8Array(result), (v) => v.toString(16).padStart(2, "0")).join("");
}

/** Read only bytes contained in this archive. Never resolve archived cloud paths or local blob keys. */
export async function readWorkspaceBackup(
  file: Blob,
  options: Options = {},
): Promise<PreparedBackup> {
  check(options.signal);
  if (file.size > BACKUP_LIMITS.archive) throw limit();
  if (file.size < 22) throw bad();
  const bytes = new Uint8Array(await file.arrayBuffer());
  check(options.signal);
  if (bytes.length !== file.size || bytes.length > BACKUP_LIMITS.archive) throw limit();
  const entries = inspect(bytes, options),
    byPath = new Map(entries.map((e) => [e.name, e]));
  check(options.signal);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, {
      checkCRC32: false,
      createFolders: false,
      decodeFileName: (value) => {
        if (!(value instanceof Uint8Array)) throw bad("备份文件名编码不受支持。");
        return decode(value);
      },
    });
  } catch {
    throw bad("备份 ZIP 无法读取。");
  }
  if (Object.keys(zip.files).length !== entries.length || entries.some((e) => !zip.files[e.name]))
    throw bad("备份目录在读取时发生了路径变化。");
  const budget = { actual: 0 },
    checked = new Set<string>();
  async function required(name: string) {
    const entry = byPath.get(name);
    if (!entry || entry.directory) throw bad("备份缺少必要的工作区、映射或正文文件。");
    const value = await readEntry(zip, entry, true, budget, options.signal);
    checked.add(name);
    return value;
  }
  const parsed = workspaceSchema.safeParse(parseJson(await required("workspace.json")));
  if (!parsed.success) throw bad("工作区结构或数据版本不受支持，未恢复任何内容。");
  const data = parsed.data;
  validateIdentities(data);
  const mapped = mappingSchema.safeParse(parseJson(await required("source-mapping.json")));
  if (!mapped.success || mapped.data.length !== data.sources.length)
    throw bad("资料原件映射不完整或格式无效。");
  const mapping = new Map(mapped.data.map((m) => [m.sourceId, m]));
  if (mapping.size !== mapped.data.length) throw bad("资料原件映射包含重复标识。");
  const validators = new Map<string, (value: Uint8Array) => void>();
  const originalPaths = new Map<string, { source: Source; version: Source | SourceVersion }>();
  const originals: PreparedBackup["originals"] = [],
    missingOriginals: PreparedBackup["missingOriginals"] = [],
    warnings: string[] = [];
  const verified: { version: Source | SourceVersion; hash: string }[] = [];
  function validateFile(name: string, validate: (value: Uint8Array) => void) {
    if (
      validators.has(name) ||
      originalPaths.has(name) ||
      !byPath.has(name) ||
      byPath.get(name)!.directory
    )
      throw bad("备份正文映射缺失或路径重复。");
    validators.set(name, validate);
  }
  function jsonFile(name: string, value: unknown) {
    const expected = canonical(value);
    validateFile(name, (bytes) => {
      if (canonical(parseJson(bytes)) !== expected)
        throw bad("备份元数据或片段与工作区中的准确版本不一致。");
    });
  }
  function bind(
    source: Source,
    version: Source | SourceVersion,
    item: z.infer<typeof mappingVersion>,
    folder: string,
    historical: boolean,
  ) {
    const metadata = `${folder}/${historical ? "source" : "metadata"}.json`,
      text = `${folder}/extracted.txt`,
      chunks = `${folder}/chunks.json`;
    const capture = version.webSnapshot ? `${folder}/web-snapshot.json` : null;
    if (
      item.sourceId !== source.id ||
      item.versionId !== version.versionId ||
      item.title !== version.title ||
      item.deletedAt !== source.deletedAt ||
      item.versionState !== (historical ? "historical" : "current") ||
      item.metadata !== metadata ||
      item.extractedText !== text ||
      item.chunks !== chunks ||
      item.webSnapshot !== capture ||
      item.originalStatusFile !== `${folder}/original-status.txt` ||
      item.archivedAt !== (historical ? (version as SourceVersion).archivedAt : null) ||
      item.createdAt !==
        (historical
          ? version.createdAt
          : (source.versionCreatedAt ?? source.webSnapshot?.capturedAt ?? source.createdAt))
    )
      throw bad("资料映射与当前或历史版本身份不一致。");
    jsonFile(metadata, historical ? { sourceId: source.id, ...version } : source);
    jsonFile(chunks, version.chunks);
    validateFile(text, (bytes) => {
      if (decode(bytes) !== version.text) throw bad("备份提取正文与工作区版本不一致。");
    });
    validateFile(item.originalStatusFile, (bytes) => {
      decode(bytes);
    });
    if (capture)
      jsonFile(capture, {
        sourceId: source.id,
        versionId: version.versionId,
        ...version.webSnapshot,
        extractedText: "extracted.txt",
        resources: [],
      });
    const original = `${folder}/${archiveFilename(version.filename)}`;
    if (item.original !== null && item.original !== original)
      throw bad("原件映射指向了错误的资料版本或文件。");
    if (item.original === null && byPath.has(original) && !validators.has(original))
      throw bad("原件文件与缺失映射不一致。");
    if (item.original !== null && byPath.has(original)) {
      if (
        originalPaths.has(original) ||
        validators.has(original) ||
        byPath.get(original)!.directory
      )
        throw bad("原件映射路径重复或无效。");
      originalPaths.set(original, { source, version });
    } else if (
      item.original !== null ||
      version.blobKey ||
      version.storagePath ||
      version.originalMissing ||
      ["pdf", "docx"].includes(version.kind)
    ) {
      missingOriginals.push({
        sourceId: source.id,
        versionId: version.versionId,
        title: version.title,
        filename: version.filename,
        reason: historical
          ? "此历史版本未包含原件；保留准确的历史正文，不使用当前原件替代。"
          : "此版本未包含原件；不会从旧云端路径或本机存储读取。",
      });
    }
  }
  for (const source of data.sources) {
    check(options.signal);
    const item = mapping.get(source.id);
    if (!item || item.versions.length !== (source.versions?.length ?? 0))
      throw bad("资料映射没有一一覆盖全部版本。");
    bind(source, source, item, `sources/${source.id}`, false);
    const used = new Set<string>();
    for (const [index, version] of (source.versions ?? []).entries()) {
      let name = version.versionId;
      for (let suffix = 2; used.has(name.toLowerCase()); suffix++)
        name = `${version.versionId}-${suffix}`;
      used.add(name.toLowerCase());
      bind(source, version, item.versions[index], `sources/${source.id}/versions/${name}`, true);
    }
  }
  let completed = checked.size;
  options.onProgress?.({ phase: "verify", completed, total: entries.length });
  for (const entry of entries) {
    check(options.signal);
    if (checked.has(entry.name)) continue;
    const original = originalPaths.get(entry.name),
      validate = validators.get(entry.name);
    const content = await readEntry(zip, entry, !!original || !!validate, budget, options.signal);
    validate?.(content);
    if (original) {
      if (content.length !== original.version.size) throw bad("备份原件大小与此版本记录不一致。");
      const hash = await digest(content, options.signal);
      if (/^[a-fA-F0-9]{64}$/.test(original.version.hash)) {
        if (original.version.hash.toLowerCase() !== hash)
          throw bad("备份原件 SHA-256 与此版本记录不一致。");
      } else
        warnings.push(
          `「${original.version.title}」版本 ${original.version.versionId} 没有有效的旧 SHA-256；已按包内原件补算，无法核对旧指纹。`,
        );
      originals.push({
        sourceId: original.source.id,
        versionId: original.version.versionId,
        blob: new Blob([content as Uint8Array<ArrayBuffer>], { type: original.version.mime }),
      });
      verified.push({ version: original.version, hash });
      options.onProgress?.({
        phase: "originals",
        completed: originals.length,
        total: originalPaths.size,
      });
    }
    completed++;
    options.onProgress?.({ phase: "verify", completed, total: entries.length });
  }
  for (const { version, hash } of verified) {
    version.hash = hash;
    delete version.originalMissing;
  }
  check(options.signal);
  const fingerprint = await digest(bytes, options.signal);
  options.onProgress?.({ phase: "ready", completed: entries.length, total: entries.length });
  check(options.signal);
  return { data, originals, missingOriginals, fingerprint, warnings };
}
