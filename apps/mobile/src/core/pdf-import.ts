import type { Source, Workspace } from "./contracts.ts";

export const PDF_MAX_FILE_BYTES = 30 * 1024 * 1024;
export const MAX_CLOUD_WORKSPACE_BYTES = 3 * 1024 * 1024;
const PDF_CHUNK_SIZE = 1200;

export type PdfPageText = { page: number; text: string };

export function validatePdfFile(name: string, size: number) {
  const cleanName = name.trim();
  if (!cleanName || cleanName.length > 512)
    throw new Error("文件名无效或过长，请控制在 512 个字符以内。");
  if (cleanName.split(".").at(-1)?.toLowerCase() !== "pdf")
    throw new Error("移动端文件导入目前支持 PDF；其他格式可在网页版导入。");
  if (!Number.isSafeInteger(size) || size < 1)
    throw new Error("无法读取文件大小，请重新从“文件”中选择 PDF。");
  if (size > PDF_MAX_FILE_BYTES)
    throw new Error("文件超过 30 MiB，请拆分后重新导入。");
  return cleanName;
}

function normalizeText(value: string) {
  return value.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
}

function safeEnd(text: string, requested: number) {
  let end = Math.min(text.length, requested);
  if (end < text.length) {
    const previous = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
      end--;
  }
  return end;
}

function chunksForPage(
  text: string,
  sourceId: string,
  versionId: string,
  page: number,
  createId: () => string,
) {
  const chunks: Source["chunks"] = [];
  let section = "正文";
  const blocks = normalizeText(text).split(/\n\s*\n/).filter(Boolean);
  for (const block of blocks) {
    const heading = block.match(/^#{1,6}\s+([^\n]+)/);
    if (heading) section = heading[1].trim().slice(0, 512) || "正文";
    let remaining = block.trim();
    while (remaining) {
      let end = safeEnd(remaining, PDF_CHUNK_SIZE);
      if (remaining.length > PDF_CHUNK_SIZE) {
        const window = remaining.slice(PDF_CHUNK_SIZE - 300, end);
        const boundaries = [...window.matchAll(/[。！？.!?;；\n]\s*/g)];
        const last = boundaries.at(-1);
        if (last && last.index !== undefined)
          end = safeEnd(remaining, PDF_CHUNK_SIZE - 300 + last.index + last[0].length);
      }
      const chunk = remaining.slice(0, end).trim();
      if (chunk)
        chunks.push({
          id: createId(),
          sourceId,
          versionId,
          text: chunk,
          section,
          page,
          order: 0,
        });
      remaining = remaining.slice(end).trimStart();
    }
  }
  return chunks;
}

function unavailablePageRanges(pages: number[]) {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const page of [...new Set(pages)].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && page === last.end + 1) last.end = page;
    else ranges.push({ start: page, end: page });
  }
  return ranges;
}

export function buildPdfSource(input: {
  id: string;
  versionId: string;
  filename: string;
  size: number;
  hash: string;
  spaceId: string;
  aiAllowed: boolean;
  pageCount: number;
  pages: PdfPageText[];
  parseError?: string;
  createId?: () => string;
  now?: string;
}): Source {
  if (!/^[a-f0-9]{64}$/u.test(input.hash)) throw new Error("文件内容指纹无效。");
  const pages = input.pages
    .filter((item) => Number.isSafeInteger(item.page) && item.page > 0)
    .map((item) => ({ page: item.page, text: normalizeText(item.text) }))
    .filter((item) => item.page <= input.pageCount);
  const chunks = pages.flatMap((item) =>
    chunksForPage(
      item.text,
      input.id,
      input.versionId,
      item.page,
      input.createId ?? (() => globalThis.crypto.randomUUID()),
    ),
  );
  chunks.forEach((chunk, order) => {
    chunk.order = order;
  });
  const parsedPageNumbers = new Set(chunks.map((chunk) => chunk.page).filter(Number.isInteger));
  const unavailablePages = Array.from(
    { length: Math.max(0, Math.min(input.pageCount, 100_000)) },
    (_, index) => index + 1,
  ).filter((page) => !parsedPageNumbers.has(page));
  const failed = chunks.length === 0;
  const partial = !failed && (input.parseError || unavailablePages.length > 0);
  const now = input.now ?? new Date().toISOString();
  const filename = input.filename.trim();
  const error = input.parseError
    ? `原文件已保存，但 PDF 正文提取未完成：${input.parseError.slice(0, 180)}`
    : failed
      ? "原文件已保存，但没有提取到可检索文字。扫描件或图片 PDF 暂不支持 OCR，可继续打开原件阅读。"
      : partial
        ? `仅从 ${parsedPageNumbers.size}/${input.pageCount} 页提取到文字；问答仅使用已解析页面。`
        : undefined;

  return {
    id: input.id,
    versionId: input.versionId,
    title: filename.replace(/\.pdf$/iu, "") || filename,
    filename,
    kind: "pdf",
    mime: "application/pdf",
    size: input.size,
    hash: input.hash,
    spaceIds: input.spaceId ? [input.spaceId] : [],
    tags: [],
    status: failed ? "failed" : partial ? "partial" : "ready",
    coverage: {
      captureScope: "full",
      parseState: failed ? "failed" : partial ? "partial" : "complete",
      ...(unavailablePages.length
        ? { unavailablePageRanges: unavailablePageRanges(unavailablePages) }
        : {}),
    },
    text: pages
      .filter((item) => item.text)
      .map((item) => item.text)
      .join("\n\n"),
    chunks,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    aiAllowed: input.aiAllowed,
    starred: false,
    parsedPages: parsedPageNumbers.size,
    ...(input.pageCount > 0 ? { pageCount: input.pageCount } : {}),
    ...(error ? { error } : {}),
  };
}

/** Reuses identical active originals and only changes their explicit library membership. */
export function mergePdfIntoWorkspace(workspace: Workspace, incoming: Source, spaceId: string) {
  if (spaceId && !workspace.spaces.some((space) => space.id === spaceId && !space.archived))
    throw new Error("所选知识库已不可用，请刷新后重新选择保存位置。");
  const existing = workspace.sources.find(
    (source) => !source.deletedAt && source.kind === "pdf" && source.hash === incoming.hash,
  );
  if (!existing) {
    return {
      workspace: { ...workspace, sources: [incoming, ...workspace.sources] },
      source: incoming,
      duplicate: false,
      changed: true,
    };
  }
  const restored =
    existing.id === incoming.id && incoming.storagePath && !existing.storagePath
      ? { ...existing, storagePath: incoming.storagePath, originalMissing: false }
      : existing;
  if (restored === existing && (!spaceId || existing.spaceIds.includes(spaceId)))
    return { workspace, source: existing, duplicate: true, changed: false };
  const linked = {
    ...restored,
    spaceIds:
      spaceId && !restored.spaceIds.includes(spaceId)
        ? [...restored.spaceIds, spaceId]
        : restored.spaceIds,
  };
  return {
    workspace: {
      ...workspace,
      sources: workspace.sources.map((source) => (source.id === existing.id ? linked : source)),
    },
    source: linked,
    duplicate: true,
    changed: true,
  };
}

export function assertPdfWorkspaceCapacity(
  workspace: Workspace,
  incoming: Source,
  spaceId: string,
) {
  const result = mergePdfIntoWorkspace(workspace, incoming, spaceId);
  const bytes = new TextEncoder().encode(JSON.stringify(result.workspace)).byteLength;
  if (bytes > MAX_CLOUD_WORKSPACE_BYTES)
    throw new Error(
      "加入这份 PDF 后会超过工作区 3 MiB 云端容量；原件尚未上传，请先整理资料后重试。",
    );
  return result;
}
