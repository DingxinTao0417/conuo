import type { Source, SourceVersion, WorkspaceData } from "./types";
import { normalizeWebUrl } from "./web-types";
import { MAX_WORKSPACE_BYTES, workspaceSchema } from "./supabase/validation";

export const MAX_SOURCE_VERSIONS = 200;
const contentKeys = [
  "versionId",
  "title",
  "filename",
  "kind",
  "mime",
  "size",
  "hash",
  "status",
  "coverage",
  "text",
  "chunks",
  "pageCount",
  "parsedPages",
  "error",
  "url",
  "webSnapshot",
  "blobKey",
  "storagePath",
  "originalMissing",
] as const satisfies ReadonlyArray<keyof Source>;
type VersionContent = Omit<SourceVersion, "createdAt" | "archivedAt">;

function contentOf(source: Source | SourceVersion): VersionContent {
  return Object.fromEntries(
    contentKeys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  ) as VersionContent;
}

/** Read the exact requested version. Never substitute the current body for a missing snapshot. */
export function getSourceVersion(source: Source, versionId: string): Source | null {
  if (source.versionId === versionId) return source;
  const matches = source.versions?.filter((item) => item.versionId === versionId) ?? [];
  if (matches.length !== 1) return null;
  const version = matches[0];
  const live = Object.fromEntries(
    Object.entries(source).filter(
      ([key]) => !contentKeys.includes(key as (typeof contentKeys)[number]),
    ),
  ) as Omit<Source, keyof VersionContent>;
  return {
    ...live,
    ...contentOf(version),
    versionCreatedAt: version.createdAt,
    readPage: undefined,
    readOffset: 0,
    lastReadAt: undefined,
    readingPositionAlternatives: undefined,
  };
}

/**
 * Promote one retained version back to current content without creating a new version identity.
 * The current content is archived in the same operation; library metadata and permissions stay live.
 */
export function restoreArchivedSourceVersion(
  data: WorkspaceData,
  sourceId: string,
  expectedCurrentVersionId: string,
  archivedVersionId: string,
): WorkspaceData {
  const current = data.sources.find((item) => item.id === sourceId);
  if (!current || current.deletedAt) throw new Error("资料已删除或不可用，请返回资料库检查。");
  if (current.versionId !== expectedCurrentVersionId)
    throw new Error("这份资料已有新版本，请重新打开版本记录后恢复。");
  if (archivedVersionId === current.versionId)
    throw new Error("当前版本无需恢复，请选择一个历史版本。");

  const matches = current.versions?.filter((item) => item.versionId === archivedVersionId) ?? [];
  if (matches.length !== 1) throw new Error("这个历史版本不存在或记录重复，未改变当前资料。");

  const activeImport = data.importJobs?.some(
    (job) =>
      job.sourceId === sourceId &&
      job.versionId === current.versionId &&
      (job.status === "queued" || job.status === "running"),
  );
  if (activeImport || current.status === "saved" || current.status === "parsing")
    throw new Error("当前版本仍在解析，请等待完成或停止任务后再恢复历史版本。");

  const selected = matches[0];
  if (selected.status === "saved" || selected.status === "parsing")
    throw new Error("这个历史版本没有完成解析，不能直接恢复。请使用保留的原件重新解析。");
  const now = new Date().toISOString();
  const archivedCurrent: SourceVersion = {
    ...structuredClone(contentOf(current)),
    createdAt: current.versionCreatedAt ?? current.webSnapshot?.capturedAt ?? current.createdAt,
    archivedAt: now,
  };
  const identity = Object.fromEntries(
    Object.entries(current).filter(
      ([key]) => !contentKeys.includes(key as (typeof contentKeys)[number]),
    ),
  ) as Omit<Source, keyof VersionContent>;
  const restored: Source = {
    ...identity,
    ...structuredClone(contentOf(selected)),
    id: current.id,
    title: current.title,
    versionCreatedAt: selected.createdAt,
    updatedAt: now,
    chunks: selected.chunks.map((chunk) => ({ ...chunk, sourceId: current.id })),
    versions: [
      archivedCurrent,
      ...structuredClone(
        (current.versions ?? []).filter((item) => item.versionId !== archivedVersionId),
      ),
    ],
    readPage: undefined,
    readOffset: 0,
    lastReadAt: undefined,
    readingPositionAlternatives: undefined,
  };
  const next = {
    ...data,
    sources: data.sources.map((source) => (source.id === sourceId ? restored : source)),
  };
  if (!workspaceSchema.safeParse(next).success)
    throw new Error("历史版本记录不完整或工作区数据超出支持范围；当前资料未改变。");
  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_WORKSPACE_BYTES)
    throw new Error("恢复后会超过工作区 3 MiB 容量，当前资料未改变。");
  return next;
}

/** User-confirmed replacement is atomic. Retained versions are never trimmed to make it fit. */
export function refreshWebSource(
  data: WorkspaceData,
  sourceId: string,
  expectedVersionId: string,
  candidate: Source,
): WorkspaceData {
  const current = data.sources.find((item) => item.id === sourceId);
  if (!current || current.deletedAt || current.kind !== "web")
    throw new Error("网页资料已删除或不可用，请返回资料库检查。");
  if (current.versionId !== expectedVersionId)
    throw new Error("这份资料已有新版本，请重新打开当前版本后刷新。旧预览未保存。");
  if (
    !current.url ||
    !candidate.url ||
    normalizeWebUrl(current.url) !== normalizeWebUrl(candidate.url)
  )
    throw new Error("刷新必须使用这份网页的原始网址；其他网址请另行导入。");
  if (
    candidate.kind !== "web" ||
    !candidate.webSnapshot ||
    candidate.deletedAt ||
    candidate.versions?.length
  )
    throw new Error("新网页快照无效，请重新提取或手动保存。");
  return applySourceReplacement(
    data,
    current,
    candidate,
    current.filename,
    candidate.webSnapshot.capturedAt,
  );
}

/** Explicit file replacement supports changing file formats while retaining each original. */
export function replaceFileSource(
  data: WorkspaceData,
  sourceId: string,
  expectedVersionId: string,
  candidate: Source,
): WorkspaceData {
  const current = data.sources.find((item) => item.id === sourceId);
  if (!current || current.deletedAt || current.kind === "web")
    throw new Error("文件资料已删除或不可用，请返回资料库检查。");
  if (current.versionId !== expectedVersionId)
    throw new Error("这份资料已有新版本，请重新打开替换面板。原文件没有被覆盖。");
  const fileMimes = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    markdown: "text/markdown",
    text: "text/plain",
  };
  if (
    !(candidate.kind in fileMimes) ||
    candidate.deletedAt ||
    candidate.versions?.length ||
    candidate.webSnapshot ||
    candidate.url ||
    candidate.storagePath ||
    candidate.originalMissing ||
    !/^[a-f0-9]{64}$/.test(candidate.hash) ||
    candidate.blobKey !== `original:${candidate.id}:${candidate.versionId}` ||
    candidate.mime !== fileMimes[candidate.kind as keyof typeof fileMimes] ||
    !candidate.filename.trim() ||
    candidate.size > 30 * 1024 * 1024 ||
    !["ready", "partial", "failed"].includes(candidate.status) ||
    (candidate.status === "failed" ? candidate.chunks.length > 0 : !candidate.chunks.length)
  )
    throw new Error("新文件预览无效，请重新选择并解析文件。");
  if (
    data.sources.some((source) =>
      [source, ...(source.versions ?? [])].some((version) => version.blobKey === candidate.blobKey),
    )
  )
    throw new Error("新文件原件标识已使用，请重新选择文件，避免覆盖已有原件。");
  if (current.hash && current.hash === candidate.hash && !current.originalMissing)
    throw new Error("文件内容与当前版本相同，无需创建新版本。可以取消或选择其他文件。");
  const prepared = { ...candidate };
  if (prepared.error)
    prepared.error = prepared.error
      .replaceAll("原文件尚未保存", "原文件已保存")
      .replaceAll("确认后会保留原文件", "原文件已保留");
  return applySourceReplacement(data, current, prepared, candidate.filename, candidate.createdAt);
}

function applySourceReplacement(
  data: WorkspaceData,
  current: Source,
  candidate: Source,
  filename: string,
  versionCreatedAt: string,
): WorkspaceData {
  if (
    candidate.versionId === current.versionId ||
    current.versions?.some((version) => version.versionId === candidate.versionId)
  )
    throw new Error("这个版本已保存，请勿重复提交。");
  if ((current.versions?.length ?? 0) >= MAX_SOURCE_VERSIONS)
    throw new Error("保留版本已达当前上限，已保存内容不受影响。请导出备份后整理资料。");
  if (
    current.spaceIds.some((id) => !data.spaces.some((space) => space.id === id && !space.archived))
  )
    throw new Error("资料所在知识库已不可用，请先检查归属再刷新。");
  if (
    candidate.chunks.some(
      (chunk) => chunk.sourceId !== candidate.id || chunk.versionId !== candidate.versionId,
    )
  )
    throw new Error("新快照的片段不属于该版本，请重新提取。");
  const now = new Date().toISOString();
  const archived: SourceVersion = {
    ...structuredClone(contentOf(current)),
    createdAt: current.versionCreatedAt ?? current.webSnapshot?.capturedAt ?? current.createdAt,
    archivedAt: now,
  };
  // Strip optional content from the previous current version as well: an absent error, original
  // file, or URL metadata in the new capture must never inherit the previous version's content.
  const nextContent = contentOf(candidate);
  const identity = Object.fromEntries(
    Object.entries(current).filter(
      ([key]) => !contentKeys.includes(key as (typeof contentKeys)[number]),
    ),
  ) as Omit<Source, keyof VersionContent>;
  const nextSource: Source = {
    ...identity,
    ...structuredClone(nextContent),
    id: current.id,
    title: current.title,
    filename,
    versionCreatedAt,
    updatedAt: now,
    chunks: candidate.chunks.map((chunk) => ({ ...chunk, sourceId: current.id })),
    versions: [archived, ...structuredClone(current.versions ?? [])],
    readPage: undefined,
    readOffset: 0,
    lastReadAt: undefined,
    readingPositionAlternatives: undefined,
  };
  const next = {
    ...data,
    sources: data.sources.map((source) => (source.id === current.id ? nextSource : source)),
  };
  if (!workspaceSchema.safeParse(next).success)
    throw new Error("资料版本或工作区数据超出支持范围；本次未替换已保存内容。");
  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_WORKSPACE_BYTES)
    throw new Error("保存新旧版本后会超过工作区 3 MiB 容量。旧版本未删除，请先导出并整理资料。");
  return next;
}
