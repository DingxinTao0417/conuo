import { putBlob } from "./local-store";
import {
  applyDocxSections,
  convertDocxToStructure,
  docxTableEvidenceRanges,
  type DocxBlock,
} from "./docx-structure";
import type { Chunk, Source, SourceKind } from "./types";
import { MAX_WEB_TEXT, normalizeWebUrl } from "./web-types";

const MAX_FILE_BYTES = 30 * 1024 * 1024;
const CHUNK_SIZE = 1200;
const SUPPORTED: Record<string, { kind: SourceKind; mime: string }> = {
  pdf: { kind: "pdf", mime: "application/pdf" },
  docx: {
    kind: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  md: { kind: "markdown", mime: "text/markdown" },
  markdown: { kind: "markdown", mime: "text/markdown" },
  txt: { kind: "text", mime: "text/plain" },
};

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .trim();
}

/** Chunks retain verbatim text and version identity; headings are only metadata. */
export function chunkText(text: string, sourceId: string, versionId: string): Chunk[] {
  const chunks: Chunk[] = [];
  let section = "正文";
  const blocks = normalizeText(text)
    .split(/\n\s*\n/)
    .filter(Boolean);
  for (const block of blocks) {
    const heading = block.match(/^#{1,6}\s+([^\n]+)/);
    if (heading) section = heading[1].trim();
    let remaining = block.trim();
    while (remaining) {
      let end = Math.min(CHUNK_SIZE, remaining.length);
      if (remaining.length > CHUNK_SIZE) {
        // Prefer a nearby sentence/line boundary without dropping any text.
        const window = remaining.slice(CHUNK_SIZE - 300, CHUNK_SIZE);
        const boundaries = [...window.matchAll(/[。！？.!?;；\n]\s*/g)];
        const last = boundaries.at(-1);
        if (last) end = CHUNK_SIZE - 300 + last.index! + last[0].length;
      }
      const chunk = remaining.slice(0, end).trim();
      if (chunk)
        chunks.push({
          id: crypto.randomUUID(),
          sourceId,
          versionId,
          text: chunk,
          section,
          order: chunks.length,
        });
      remaining = remaining.slice(end).trimStart();
    }
  }
  return chunks;
}

/** New material stays out of AI processing until its owner opts in explicitly. */
function createSource(title: string, spaceId: string, aiAllowed = false): Source {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    versionId: crypto.randomUUID(),
    title,
    filename: title,
    kind: "text",
    mime: "text/plain",
    size: 0,
    hash: "",
    spaceIds: spaceId ? [spaceId] : [],
    tags: [],
    status: "saved",
    coverage: { captureScope: "full", parseState: "pending" },
    text: "",
    chunks: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    aiAllowed,
    starred: false,
  };
}

/** Compress sparse failed PDF pages without losing the exact unavailable ranges. */
function pageRanges(pages: number[]) {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const page of [...new Set(pages)].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && page === last.end + 1) last.end = page;
    else ranges.push({ start: page, end: page });
  }
  return ranges;
}

function decodeText(bytes: ArrayBuffer): string {
  const data = new Uint8Array(bytes);
  if (data[0] === 0xff && data[1] === 0xfe)
    return new TextDecoder("utf-16le", { fatal: true }).decode(data);
  if (data[0] === 0xfe && data[1] === 0xff)
    return new TextDecoder("utf-16be", { fatal: true }).decode(data);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    // Older Windows text files commonly use GB18030/GBK.
    return new TextDecoder("gb18030", { fatal: true }).decode(data);
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("导入已取消。", "AbortError");
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError(signal);
}

function rewriteUnsavedOriginalError(source: Source): Source {
  if (!source.error) return source;
  return {
    ...source,
    error: source.error
      .replaceAll("原文件已保存", "原文件尚未保存")
      .replaceAll("原文件已保留", "确认后会保留原文件")
      .replaceAll("可继续预览原文件", "请检查原文件中的文字内容")
      .replaceAll("可下载原文件后检查，或重新导入。", "请检查文件，或选择另一个文件。"),
  };
}

async function extractPdf(source: Source, bytes: ArrayBuffer, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  let destroyed = false;
  const destroy = async () => {
    if (destroyed) return;
    destroyed = true;
    await task.destroy();
  };
  const stop = () => {
    void destroy().catch(() => {});
  };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const pdf = await task.promise;
    throwIfAborted(signal);
    source.pageCount = pdf.numPages;
    source.parsedPages = 0;
    const texts: string[] = [];
    const missedPages: number[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      throwIfAborted(signal);
      try {
        const page = await pdf.getPage(number);
        throwIfAborted(signal);
        const content = await page.getTextContent();
        throwIfAborted(signal);
        let text = "";
        for (const item of content.items) {
          if (!("str" in item)) continue;
          text += item.str + (item.hasEOL ? "\n" : " ");
        }
        text = normalizeText(text);
        if (text) {
          source.parsedPages += 1;
          texts.push(text);
          const pageChunks = chunkText(text, source.id, source.versionId);
          for (const chunk of pageChunks) {
            source.chunks.push({
              ...chunk,
              page: number,
              section: `第 ${number} 页`,
              order: source.chunks.length,
            });
          }
        } else missedPages.push(number);
        page.cleanup();
      } catch (cause) {
        if (signal?.aborted) throw cause;
        missedPages.push(number);
      }
    }
    source.text = texts.join("\n\n");
    if (source.parsedPages === 0) {
      source.status = "failed";
      source.coverage = {
        captureScope: "full",
        parseState: "failed",
        ...(missedPages.length ? { unavailablePageRanges: pageRanges(missedPages) } : {}),
      };
      source.error =
        "原文件已保存，但没有提取到可检索文字。扫描件或图片 PDF 暂不支持 OCR，可继续预览原文件。";
    } else if (missedPages.length) {
      source.status = "partial";
      source.coverage = {
        captureScope: "full",
        parseState: "partial",
        unavailablePageRanges: pageRanges(missedPages),
      };
      const pages = missedPages.slice(0, 20).join("、") + (missedPages.length > 20 ? "等" : "");
      source.error = `仅提取了 ${source.parsedPages}/${source.pageCount} 页。第 ${pages} 页没有可提取文字或解析失败；问答仅使用已解析页面。`;
    } else {
      source.status = "ready";
      source.coverage = { captureScope: "full", parseState: "complete" };
    }
  } finally {
    signal?.removeEventListener("abort", stop);
    await destroy();
  }
}

/** Prepare deterministic file metadata without publishing a source or writing the original. */
export async function prepareImportFile(
  file: File,
  spaceId: string,
  aiAllowed = false,
): Promise<Source> {
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  const supported = SUPPORTED[extension];
  if (!supported) throw new Error("暂不支持此文件格式，请选择 PDF、DOCX、Markdown 或 TXT 文件。");
  if (file.size > MAX_FILE_BYTES) throw new Error("文件超过 30 MB，请拆分文件后重新导入。");
  if (file.name.length > 512) throw new Error("文件名过长，请缩短至 512 个字符以内。");
  const source = createSource(file.name.replace(/\.[^.]+$/, "") || file.name, spaceId, aiAllowed);
  source.filename = file.name;
  source.kind = supported.kind;
  source.mime = supported.mime;
  source.size = file.size;
  const bytes = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  source.hash = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  source.blobKey = `original:${source.id}:${source.versionId}`;
  return source;
}

/**
 * Parse a source whose immutable original is already addressed by `blobKey`.
 * The caller owns persistence and may pass a signal to stop expensive parsing.
 */
export async function parseImportSource(
  input: Source,
  original: Blob,
  options: { signal?: AbortSignal; originalSaved?: boolean } = {},
): Promise<Source> {
  const { signal, originalSaved = true } = options;
  if (input.kind === "web" || !input.blobKey) throw new Error("导入资料身份无效，无法解析原文件。");
  throwIfAborted(signal);
  const source = structuredClone(input);
  source.status = "parsing";
  source.coverage = { captureScope: "full", parseState: "pending" };
  source.text = "";
  source.chunks = [];
  source.error = undefined;
  source.pageCount = undefined;
  source.parsedPages = undefined;
  try {
    const bytes = await original.arrayBuffer();
    throwIfAborted(signal);
    if (source.kind === "pdf") await extractPdf(source, bytes, signal);
    else {
      let docxBlocks: DocxBlock[] | undefined;
      if (source.kind === "docx") {
        const mammoth = await import("mammoth");
        throwIfAborted(signal);
        const result = await mammoth.extractRawText({ arrayBuffer: bytes });
        throwIfAborted(signal);
        source.text = normalizeText(result.value);
        if (result.messages.length)
          source.error = "部分文档结构可能未能提取，原文件已保留。请核对提取内容。";
        try {
          const structure = await convertDocxToStructure(bytes);
          throwIfAborted(signal);
          docxBlocks = structure.blocks;
          if (structure.messages.length)
            source.error = "部分文档结构可能未能提取，原文件已保留。请核对提取内容。";
        } catch {
          throwIfAborted(signal);
          // Raw text remains usable for search, chunks and citations even when
          // the optional structured reading pass cannot interpret the file.
          source.error =
            "已提取可检索文字，但部分文档结构未能解析。问答暂不保证表格行列关系，请核对阅读版内容。";
        }
      } else {
        source.text = normalizeText(decodeText(bytes));
        throwIfAborted(signal);
      }
      source.chunks = chunkText(source.text, source.id, source.versionId);
      if (docxBlocks) {
        const tables = docxTableEvidenceRanges(source.text, docxBlocks, CHUNK_SIZE);
        if (tables.messages.length)
          source.error = [source.error, ...tables.messages].filter(Boolean).join(" ");
        if (tables.ranges.length) {
          const chunks: Chunk[] = [];
          const suffixes = new Map<string, string>();
          let cursor = 0;
          for (const range of tables.ranges) {
            chunks.push(
              ...chunkText(source.text.slice(cursor, range.start), source.id, source.versionId),
            );
            const chunk: Chunk = {
              id: crypto.randomUUID(),
              sourceId: source.id,
              versionId: source.versionId,
              text: source.text.slice(range.start, range.end),
              section: "正文",
              order: 0,
            };
            chunks.push(chunk);
            suffixes.set(chunk.id, range.sectionSuffix);
            cursor = range.end;
          }
          chunks.push(...chunkText(source.text.slice(cursor), source.id, source.versionId));
          source.chunks = applyDocxSections(chunks, source.text, docxBlocks).map((chunk, order) => {
            const suffix = suffixes.get(chunk.id);
            return {
              ...chunk,
              order,
              section: suffix
                ? `${chunk.section.slice(0, 100)} · ${suffix}`.slice(0, 512)
                : chunk.section,
            };
          });
        } else source.chunks = applyDocxSections(source.chunks, source.text, docxBlocks);
      }
      if (!source.chunks.length) {
        source.status = "failed";
        source.coverage = { captureScope: "full", parseState: "failed" };
        source.error = "原文件已保存，但没有提取到可检索文字，请检查文件内容。";
      } else {
        source.status = source.error ? "partial" : "ready";
        source.coverage = {
          captureScope: "full",
          parseState: source.error ? "partial" : "complete",
        };
      }
    }
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    source.status = source.chunks.length ? "partial" : "failed";
    source.coverage = {
      captureScope: "full",
      parseState: source.chunks.length ? "partial" : "failed",
    };
    const detail = error instanceof Error ? error.message : "文件内容无法解析";
    source.error = `原文件已保存，解析未完成：${detail.slice(0, 180)}。可下载原文件后检查，或重新导入。`;
  }
  source.updatedAt = new Date().toISOString();
  return originalSaved ? source : rewriteUnsavedOriginalError(source);
}

/** Normal import makes the original durable before parsing, including parser failures. */
export async function importFile(file: File, spaceId: string, aiAllowed = false): Promise<Source> {
  const source = await prepareImportFile(file, spaceId, aiAllowed);
  await putBlob(source.blobKey!, file);
  return parseImportSource(source, file);
}

/** Replacement previews are memory-only; confirmation must separately persist the original. */
export async function prepareFile(file: File, spaceId: string): Promise<Source> {
  const source = await prepareImportFile(file, spaceId);
  return parseImportSource(source, file, { originalSaved: false });
}

export function makeWebSource({
  url,
  title,
  text,
  spaceId,
  aiAllowed = false,
}: {
  url: string;
  title: string;
  text: string;
  spaceId: string;
  aiAllowed?: boolean;
}): Source {
  const parsedUrl = new URL(normalizeWebUrl(url));
  if (title.trim().length > 512) throw new Error("网页标题请控制在 512 个字符以内。");
  if (text.length > MAX_WEB_TEXT) throw new Error("网页正文超过 12 万字符，请分段保存。");
  const source = createSource(title.trim() || parsedUrl.hostname, spaceId, aiAllowed);
  source.kind = "web";
  source.mime = "text/plain";
  source.filename = `${source.title.slice(0, 508)}.txt`;
  source.url = parsedUrl.toString();
  source.text = normalizeText(text);
  source.size = new TextEncoder().encode(source.text).byteLength;
  source.chunks = chunkText(source.text, source.id, source.versionId);
  source.status = source.chunks.length ? "ready" : "link-only";
  source.coverage = source.chunks.length
    ? { captureScope: "manual", parseState: "complete" }
    : { captureScope: "link", parseState: "not-requested" };
  source.webSnapshot = {
    originalUrl: source.url,
    finalUrl: source.url,
    capturedAt: source.createdAt,
    method: "manual",
    scope: source.chunks.length ? "pasted" : "link",
    warnings: [],
  };
  // URL identity must never masquerade as a cryptographic content fingerprint.
  // File deduplication only applies to non-empty SHA-256 hashes.
  source.hash = "";
  return source;
}
