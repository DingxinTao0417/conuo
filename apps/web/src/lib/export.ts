import JSZip from "jszip";
import { getBlob } from "./local-store";
import { renderNoteForExport, type ExportCitation } from "./note-markdown";
import type {
  AnswerNoteEvidence,
  Citation,
  Source,
  SourceBlobReadOptions,
  WorkspaceData,
} from "./types";
import type { KnowledgeNoteSnapshot } from "./knowledge-update-types";
import { knowledgeNoteKey } from "./knowledge-update";
import { relationAvailabilityReason, relationLabels } from "./concept-relations";
import { getSourceVersion } from "./source-versions";
import { prepareWorkspaceExport, type WorkspaceExportScope } from "./export-scope";
import type { LearningBackup } from "./learning/types";

export type ResolveExportBlob = (
  source: Source,
  options?: SourceBlobReadOptions,
) => Promise<Blob | undefined>;

/** A recoverable problem with one source version's original bytes. */
export interface ExportIssue {
  code: "original-missing" | "original-read-failed";
  sourceId: string;
  versionId: string;
  title: string;
  versionState: "current" | "historical";
  message: string;
}

export interface ExportOriginalProgress {
  phase: "originals";
  completed: number;
  total: number;
  sourceId: string;
  versionId: string;
  title: string;
  versionState: "current" | "historical";
  status: "reading" | "included" | "missing" | "failed";
}

export interface ExportArchiveProgress {
  phase: "archive";
  completed: number;
  total: 1;
}

export type ExportProgress = ExportOriginalProgress | ExportArchiveProgress;
export type OnExportProgress = (progress: ExportProgress) => void;

export interface BuildWorkspaceArchiveOptions {
  resolveBlob?: ResolveExportBlob;
  onProgress?: OnExportProgress;
  scope?: WorkspaceExportScope;
  /** Throw to abort the entire export after account or reviewed-scope drift. */
  assertCanContinue?: () => void;
  learning?: LearningBackup;
}

export interface WorkspaceArchiveResult {
  bytes: Uint8Array;
  issues: ExportIssue[];
}

interface ArchiveCitation extends ExportCitation {
  sourceAvailability: string;
  sourceVersionState: "current" | "historical" | "unavailable";
  availabilityReason: string;
  sourceMetadata: string | null;
  extractedText: string | null;
  textPath: string | null;
  deletedAt: string | null;
}

interface SourceExport {
  sourceId: string;
  versionId: string;
  title: string;
  deletedAt: string | null;
  versionState: "current" | "historical";
  metadata: string;
  chunks: string;
  original: string | null;
  extractedText: string;
  originalStatus: string;
  originalStatusFile: string;
  webSnapshot: string | null;
  createdAt: string;
  archivedAt: string | null;
}

function safeName(value: string): string {
  return (
    Array.from(value.replace(/[<>:"/\\|?*]/g, "_"))
      .filter((character) => character.charCodeAt(0) >= 32)
      .join("")
      .slice(0, 100)
      .replace(/[. ]+$/, "") || "未命名"
  );
}

function escaped(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const EXPORT_ERROR_DETAIL_LIMIT = 480;
const exportErrorTruncation = "…（已截断）";

function exportErrorDetail(cause: unknown): string {
  const detail = cause instanceof Error && cause.message.trim() ? cause.message.trim() : "未知错误";
  if (detail.length <= EXPORT_ERROR_DETAIL_LIMIT) return detail;
  return `${detail.slice(0, EXPORT_ERROR_DETAIL_LIMIT - exportErrorTruncation.length)}${exportErrorTruncation}`;
}

function needsOriginalCheck(
  source: Pick<Source, "blobKey" | "storagePath" | "originalMissing" | "kind" | "text">,
): boolean {
  return Boolean(
    source.blobKey ||
    source.storagePath ||
    source.originalMissing ||
    (source.kind !== "web" && !source.text),
  );
}

export async function buildWorkspaceArchiveResult(
  data: WorkspaceData,
  options: BuildWorkspaceArchiveOptions = {},
): Promise<WorkspaceArchiveResult> {
  const { resolveBlob, onProgress, scope, assertCanContinue } = options;
  let guardFailure: { cause: unknown } | undefined;
  function assertContinue() {
    if (guardFailure) throw guardFailure.cause;
    try {
      assertCanContinue?.();
    } catch (cause) {
      guardFailure = { cause };
      throw cause;
    }
  }
  async function guardedRead<T>(read: () => Promise<T>): Promise<T> {
    assertContinue();
    try {
      const result = await read();
      assertContinue();
      return result;
    } catch (cause) {
      assertContinue();
      throw cause;
    }
  }
  assertContinue();
  const prepared = prepareWorkspaceExport(data, scope);
  const snapshot = prepared.data;
  const zip = new JSZip();
  zip.file("export-scope.json", JSON.stringify(prepared.manifest, null, 2));
  zip.file("workspace.json", JSON.stringify(snapshot, null, 2));
  zip.file("conversations.json", JSON.stringify(snapshot.conversations, null, 2));
  zip.file("annotations.json", JSON.stringify(snapshot.annotations, null, 2));
  zip.file("recoverable-drafts.json", JSON.stringify(snapshot.recoverableDrafts ?? [], null, 2));
  zip.file(
    "resolved-recoverable-drafts.json",
    JSON.stringify(snapshot.resolvedRecoverableDrafts ?? [], null, 2),
  );
  zip.file(
    "recoverable-drafts/README.txt",
    "Conuo 可恢复草稿导出\n\nrecoverable-drafts.json 保存资料删除与离线批注编辑冲突中保留的人工文字。note 是用户新增的批注文字，quote 与 page 只提供原文上下文；记录本身不会自动恢复资料。\n\nresolved-recoverable-drafts.json 保存已处理草稿的追加式标记，不含草稿正文。备份恢复会同时重映射标记的 sourceId、annotationId 与稳定 id，保留阻止较旧设备重新生成已处理草稿的语义。\n",
  );
  zip.file("relations.json", JSON.stringify(snapshot.conceptRelations ?? [], null, 2));
  if (options.learning) zip.file("learning.json", JSON.stringify(options.learning, null, 2));
  const mapping: (SourceExport & { versions: SourceExport[] })[] = [];
  const versionFiles = new Map<string, SourceExport>();
  const versionKey = (sourceId: string, versionId: string) => JSON.stringify([sourceId, versionId]);
  const totalOriginals = snapshot.sources.reduce(
    (total, source) =>
      total +
      [source, ...(source.versions ?? [])].filter((version) => needsOriginalCheck(version)).length,
    0,
  );
  const issues: ExportIssue[] = [];
  let completedOriginals = 0;
  function reportOriginal(
    source: Source,
    versionState: "current" | "historical",
    status: ExportOriginalProgress["status"],
  ) {
    onProgress?.({
      phase: "originals",
      completed: completedOriginals,
      total: totalOriginals,
      sourceId: source.id,
      versionId: source.versionId,
      title: source.title,
      versionState,
      status,
    });
  }
  async function readOriginal(
    source: Source,
    versionState: "current" | "historical",
  ): Promise<{ bytes: ArrayBuffer | null; issue: ExportIssue | null }> {
    if (!needsOriginalCheck(source)) return { bytes: null, issue: null };
    reportOriginal(source, versionState, "reading");
    const failures: string[] = [];
    let bytes: ArrayBuffer | null = null;
    async function readBlob(blob: Blob, label: string) {
      try {
        bytes = await guardedRead(() => blob.arrayBuffer());
      } catch (cause) {
        assertContinue();
        failures.push(`${label}：${exportErrorDetail(cause)}`);
      }
    }
    if (source.blobKey && !resolveBlob) {
      try {
        const local = await guardedRead(() => getBlob(source.blobKey!, "local"));
        if (local) await readBlob(local, "本机原件读取失败");
      } catch (cause) {
        assertContinue();
        failures.push(`本机原件读取失败：${exportErrorDetail(cause)}`);
      }
    }
    if (!bytes && resolveBlob && (source.blobKey || source.storagePath)) {
      try {
        // The app resolves canonical handles and local byte ownership before any read.
        const resolved = await guardedRead(() => resolveBlob(source));
        if (resolved) await readBlob(resolved, "原件读取失败");
      } catch (cause) {
        assertContinue();
        failures.push(`原件读取失败：${exportErrorDetail(cause)}`);
      }
      if (!bytes && source.storagePath) {
        try {
          const resolved = await guardedRead(() => resolveBlob(source, { preferCloud: true }));
          if (resolved) await readBlob(resolved, "云端原件读取失败");
        } catch (cause) {
          assertContinue();
          failures.push(`云端原件下载失败：${exportErrorDetail(cause)}`);
        }
      }
    }
    let issue: ExportIssue | null = null;
    if (!bytes) {
      const message = failures.length
        ? `未包含原文件：${failures.join("；")}`
        : source.originalMissing
          ? "未包含原文件：恢复时的备份未包含此版本原件。"
          : source.blobKey || source.storagePath
            ? "未包含原文件：当前设备与云端读取器均未返回此版本原件。"
            : "未包含原文件：此资料没有可读取的原件。";
      issue = {
        code: failures.length ? "original-read-failed" : "original-missing",
        sourceId: source.id,
        versionId: source.versionId,
        title: source.title,
        versionState,
        message,
      };
      issues.push(issue);
    }
    completedOriginals += 1;
    reportOriginal(
      source,
      versionState,
      issue ? (failures.length ? "failed" : "missing") : "included",
    );
    return { bytes, issue };
  }
  async function writeSource(
    source: Source,
    folder: string,
    versionState: "current" | "historical",
    metadata: unknown,
    archivedAt: string | null,
  ): Promise<SourceExport> {
    const textPath = `${folder}/extracted.txt`;
    const metadataPath = `${folder}/${versionState === "current" ? "metadata" : "source"}.json`;
    const chunksPath = `${folder}/chunks.json`;
    zip.file(textPath, source.text);
    zip.file(metadataPath, JSON.stringify(metadata, null, 2));
    zip.file(chunksPath, JSON.stringify(source.chunks, null, 2));
    const webSnapshotPath = source.webSnapshot ? `${folder}/web-snapshot.json` : null;
    if (webSnapshotPath)
      zip.file(
        webSnapshotPath,
        JSON.stringify(
          {
            sourceId: source.id,
            versionId: source.versionId,
            ...source.webSnapshot,
            extractedText: "extracted.txt",
            resources: [],
          },
          null,
          2,
        ),
      );
    let original: string | null = null;
    let originalStatus = source.originalMissing
      ? "缺少此版本的原文件：恢复时的备份未包含原件；仅保留已有文字与引用记录"
      : source.kind === "web" && !source.blobKey && !source.storagePath
        ? source.status === "link-only"
          ? "仅收藏链接，没有网页正文；地址见资料元数据"
          : "网页阅读版正文保存在 extracted.txt，采集范围与地址见资料元数据；未保存原站 HTML 或外部资源"
        : "缺少此设备上的原文件";
    // A historical projection carries that version's storage handle. Never
    // ask the resolver for the current original as a historical fallback.
    const originalRead = await readOriginal(source, versionState);
    if (originalRead.bytes) {
      let filename = safeName(source.filename);
      if (
        [
          "metadata.json",
          "source.json",
          "extracted.txt",
          "chunks.json",
          "web-snapshot.json",
          "original-status.txt",
          "versions",
        ].includes(filename.toLowerCase())
      )
        filename = `original-${filename}`;
      original = `${folder}/${filename}`;
      zip.file(original, originalRead.bytes);
      originalStatus = "已包含原文件";
    } else if (
      !source.originalMissing &&
      !source.blobKey &&
      !source.storagePath &&
      source.kind !== "web" &&
      source.text
    ) {
      originalStatus = "此资料由文本创建，没有上传的原文件；已包含完整文字";
    }
    if (originalRead.issue?.code === "original-read-failed")
      originalStatus = `${originalStatus}；${originalRead.issue.message}`;
    const originalStatusFile = `${folder}/original-status.txt`;
    zip.file(
      originalStatusFile,
      `${source.deletedAt ? `资料已删除（${source.deletedAt}）；此处仅保留可恢复备份。\n` : ""}${versionState === "historical" ? "这是已保留的历史版本，不代表当前网页或资料内容。\n" : ""}${originalStatus}\nsourceId: ${source.id}\nversionId: ${source.versionId}\n`,
    );
    const files: SourceExport = {
      sourceId: source.id,
      versionId: source.versionId,
      title: source.title,
      deletedAt: source.deletedAt,
      versionState,
      metadata: metadataPath,
      chunks: chunksPath,
      original,
      extractedText: textPath,
      originalStatus,
      originalStatusFile,
      webSnapshot: webSnapshotPath,
      createdAt: source.versionCreatedAt ?? source.webSnapshot?.capturedAt ?? source.createdAt,
      archivedAt,
    };
    versionFiles.set(versionKey(source.id, source.versionId), files);
    return files;
  }
  for (const source of snapshot.sources) {
    const folder = `sources/${safeName(source.id)}`;
    const current = await writeSource(source, folder, "current", source, null);
    const versions: SourceExport[] = [];
    const usedFolders = new Set<string>();
    for (const version of source.versions ?? []) {
      const historical = getSourceVersion(source, version.versionId);
      if (!historical || version.versionId === source.versionId)
        throw new Error(`未完成导出：资料「${source.title}」的历史版本记录无效。`);
      const base = safeName(version.versionId);
      let key = base;
      for (let index = 2; usedFolders.has(key.toLowerCase()); index++) key = `${base}-${index}`;
      usedFolders.add(key.toLowerCase());
      versions.push(
        await writeSource(
          historical,
          `${folder}/versions/${key}`,
          "historical",
          { sourceId: source.id, ...version },
          version.archivedAt,
        ),
      );
    }
    mapping.push({ ...current, versions });
  }
  const noteMapping = [];
  function exportCitations(values: Citation[], relativeRoot: string): ArchiveCitation[] {
    return values.map((citation, index) => {
      const owner = snapshot.sources.find((source) => source.id === citation.sourceId);
      const source = owner ? getSourceVersion(owner, citation.versionId) : null;
      const chunk = source?.chunks.find(
        (item) =>
          item.id === citation.chunkId &&
          item.sourceId === citation.sourceId &&
          item.versionId === citation.versionId,
      );
      // Saved manual excerpts may span chunks or differ only in PDF whitespace.
      // Their text may be checked only against the exactly identified version.
      const quote = citation.quote.replace(/\s/gu, "");
      const matches =
        !!chunk &&
        !!quote &&
        [chunk.text, source!.text].some((text) => text.replace(/\s/gu, "").includes(quote));
      const files = matches
        ? versionFiles.get(versionKey(citation.sourceId, citation.versionId))
        : undefined;
      const sourceVersionState = !source
        ? "unavailable"
        : owner!.versionId === citation.versionId
          ? "current"
          : "historical";
      const sourceAvailability = !owner
        ? "source_missing"
        : !source
          ? "version_missing"
          : !files
            ? "citation_invalid"
            : owner.deletedAt
              ? "deleted"
              : sourceVersionState === "historical"
                ? "historical"
                : "included";
      const reasons: Record<string, string> = {
        included: "当前资料版本；引用已在保存的正文中找到。",
        historical: "已保留历史版本；此处链接当时正文，不代表当前内容。",
        deleted: "资料已删除；此处链接可恢复备份，不表示资料当前可用。",
        source_missing: "所引用的资料版本未包含在本次备份中：资料已缺失。",
        version_missing: "所引用的资料版本未包含在本次备份中：历史版本未保留。",
        citation_invalid: "引用的片段身份或摘录与保存版本不符，无法确认原始依据。",
      };
      const relative = (path: string) =>
        relativeRoot + path.split("/").map(encodeURIComponent).join("/");
      return {
        ...citation,
        number: index + 1,
        metadataPath: files ? relative(files.metadata) : null,
        sourceMetadata: files?.metadata ?? null,
        extractedText: files?.extractedText ?? null,
        textPath: files ? relative(files.extractedText) : null,
        sourceAvailability,
        sourceVersionState,
        availabilityReason:
          reasons[sourceAvailability] +
          (owner?.deletedAt && sourceAvailability !== "deleted"
            ? " 资料已删除；备份内容不表示资料当前可用。"
            : ""),
        deletedAt: owner?.deletedAt ?? null,
      };
    });
  }
  function citationHtml(citations: ArchiveCitation[]): string {
    if (!citations.length) return "";
    return `<section><h2>引用来源</h2><ol>${citations
      .map((citation) => {
        const title = citation.metadataPath
          ? `<a href="${escaped(citation.metadataPath)}">${escaped(citation.title)}</a>`
          : escaped(citation.title);
        return `<li><p>${title}${citation.section ? ` · ${escaped(citation.section)}` : ""}${citation.page !== undefined ? ` · 第 ${citation.page} 页` : ""}</p><p>${escaped(citation.availabilityReason)}${citation.textPath ? ` <a href="${escaped(citation.textPath)}">查看此版本正文</a>` : ""}</p><p>sourceId: <code>${escaped(citation.sourceId)}</code>；versionId: <code>${escaped(citation.versionId)}</code>；chunkId: <code>${escaped(citation.chunkId)}</code></p><blockquote><p>${escaped(citation.quote).replace(/\r?\n/g, "<br>")}</p></blockquote></li>`;
      })
      .join("")}</ol></section>`;
  }
  function noteEvidenceHtml(evidence: readonly AnswerNoteEvidence[]): string {
    if (!evidence.length) return "";
    return `<section><h2>我的笔记依据</h2><p>以下是回答当时引用的个人笔记摘录，不是原始资料。</p><ol>${evidence
      .map(
        (item) =>
          `<li><p><strong>${escaped(item.title)}</strong></p><p>noteId: <code>${escaped(item.noteId)}</code>；知识库：<code>${escaped(item.spaceId)}</code>；资料范围：<code>${escaped(item.sourceId)}</code>；资料版本：<code>${escaped(item.sourceVersionId)}</code>；笔记版本：<code>${escaped(String(item.revision))}</code>；更新于：<code>${escaped(item.updatedAt)}</code>；块：<code>${escaped(item.blockId)}</code></p><blockquote><p>${escaped(item.quote).replace(/\r?\n/g, "<br>")}</p></blockquote></li>`,
      )
      .join("")}</ol></section>`;
  }
  function writeNote(
    folder: string,
    title: string,
    content: string,
    citations: ArchiveCitation[] = [],
    noteEvidence: readonly AnswerNoteEvidence[] = [],
  ) {
    const rendered = renderNoteForExport(title, content);
    const citationContent = citationHtml(citations);
    const citationMarkdown = citations.length
      ? renderNoteForExport(
          "引用来源",
          citationContent
            .replace("<h2>引用来源</h2>", "")
            .replace(/^<section>/, "<div>")
            .replace(/<\/section>$/, "</div>"),
        ).markdown.replace(/^# /, "## ")
      : "";
    const noteEvidenceContent = noteEvidenceHtml(noteEvidence);
    const noteEvidenceMarkdown = noteEvidence.length
      ? renderNoteForExport(
          "我的笔记依据",
          noteEvidenceContent
            .replace("<h2>我的笔记依据</h2>", "")
            .replace(/^<section>/, "<div>")
            .replace(/<\/section>$/, "</div>"),
        ).markdown.replace(/^# /, "## ")
      : "";
    const markdown = `${folder}/${safeName(title)}.md`;
    const html = `${folder}/${safeName(title)}.html`;
    // The exact editor HTML is deliberately saved with .txt as its final
    // extension: a lossless backup must not become executable when opened.
    const original = `${folder}/content.original.${rendered.originalFormat === "html" ? "html" : "md"}.txt`;
    zip.file(
      markdown,
      rendered.markdown +
        (citationMarkdown ? `\n${citationMarkdown}` : "") +
        (noteEvidenceMarkdown ? `\n${noteEvidenceMarkdown}` : ""),
    );
    zip.file(
      html,
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'"><title>${escaped(title)}</title></head><body><h1>${escaped(title)}</h1>${rendered.htmlBody}${citationHtml(citations)}${noteEvidenceContent}</body></html>`,
    );
    zip.file(original, content);
    return { markdown, html, original, originalFormat: rendered.originalFormat };
  }
  const conversationMapping = snapshot.conversations.map((conversation) => {
    const folder = `conversations/${safeName(conversation.id)}`;
    const messages = conversation.messages.map((message, index) => {
      const messageFolder = `${folder}/messages/${String(index + 1).padStart(4, "0")}-${safeName(message.id)}`;
      const citations = exportCitations(message.citations, "../../../../");
      const noteEvidence = message.noteEvidence ?? [];
      const title = `${index + 1}. ${message.role === "user" ? "用户" : "助手"}`;
      const files = writeNote(messageFolder, title, message.content, citations, noteEvidence);
      zip.file(`${messageFolder}/metadata.json`, JSON.stringify(message, null, 2));
      zip.file(`${messageFolder}/citations.json`, JSON.stringify(citations, null, 2));
      if (noteEvidence.length)
        zip.file(`${messageFolder}/note-evidence.json`, JSON.stringify(noteEvidence, null, 2));
      return {
        messageId: message.id,
        role: message.role,
        createdAt: message.createdAt,
        ...files,
        metadata: `${messageFolder}/metadata.json`,
        citations: `${messageFolder}/citations.json`,
        noteEvidence: noteEvidence.length ? `${messageFolder}/note-evidence.json` : null,
      };
    });
    const content = conversation.messages
      .map(
        (message, index) =>
          `<h2>${index + 1}. ${message.role === "user" ? "用户" : "助手"}</h2><p>${escaped(message.content).replace(/\r?\n/g, "<br>")}</p>${citationHtml(exportCitations(message.citations, "../../"))}${noteEvidenceHtml(message.noteEvidence ?? [])}`,
      )
      .join("");
    const files = writeNote(folder, conversation.title, content);
    zip.file(`${folder}/metadata.json`, JSON.stringify(conversation, null, 2));
    return {
      conversationId: conversation.id,
      title: conversation.title,
      ...files,
      metadata: `${folder}/metadata.json`,
      messages,
    };
  });
  zip.file("conversation-mapping.json", JSON.stringify(conversationMapping, null, 2));
  for (const note of snapshot.notes) {
    const folder = `notes/${safeName(note.id)}`;
    const citations = exportCitations(note.citations, "../../");
    const current = writeNote(folder, note.title, note.content, citations);
    zip.file(`${folder}/metadata.json`, JSON.stringify(note, null, 2));
    zip.file(`${folder}/citations.json`, JSON.stringify(citations, null, 2));
    const versions = note.versions.map((version, index) => {
      const versionFolder = `${folder}/versions/${String(index + 1).padStart(4, "0")}-${safeName(version.id)}`;
      // Older versions did not record citations. An explicit [] is a recorded
      // empty snapshot; neither case may inherit the current note's evidence.
      const historicalCitationsAvailable = version.citations !== undefined;
      const historicalCitations = historicalCitationsAvailable
        ? exportCitations(version.citations!, "../../../../")
        : [];
      const citationsPath = historicalCitationsAvailable ? `${versionFolder}/citations.json` : null;
      const files = writeNote(versionFolder, version.title, version.content, historicalCitations);
      if (citationsPath) zip.file(citationsPath, JSON.stringify(historicalCitations, null, 2));
      zip.file(`${versionFolder}/metadata.json`, JSON.stringify(version, null, 2));
      return {
        id: version.id,
        savedAt: version.savedAt,
        ...files,
        metadata: `${versionFolder}/metadata.json`,
        historicalCitationsAvailable,
        citations: citationsPath,
        status: version.status ?? null,
        aiGenerated: version.aiGenerated ?? null,
        spaceId: version.spaceId ?? null,
        contentRevision: version.contentRevision ?? null,
      };
    });
    noteMapping.push({
      noteId: note.id,
      title: note.title,
      kind: note.kind,
      status: note.status,
      deletedAt: note.deletedAt,
      ...current,
      metadata: `${folder}/metadata.json`,
      citations: `${folder}/citations.json`,
      versions,
    });
  }
  zip.file("source-mapping.json", JSON.stringify(mapping, null, 2));
  zip.file("note-mapping.json", JSON.stringify(noteMapping, null, 2));
  function writeEndpoint(folder: string, basis: KnowledgeNoteSnapshot) {
    const current = snapshot.notes.find((note) => note.id === basis.id);
    const availability = !current
      ? "missing"
      : current.deletedAt
        ? "deleted"
        : current.kind !== "knowledge"
          ? "not_knowledge"
          : knowledgeNoteKey(current) !== knowledgeNoteKey(basis)
            ? "changed"
            : "current";
    const labels = {
      missing: "知识页已缺失",
      deleted: "知识页已删除",
      not_knowledge: "当前条目不是知识页",
      changed: "知识页已变化；此处保留关系建立时的版本",
      current: "知识页与记录基线一致",
    };
    const citations = exportCitations(basis.citations, "../../../");
    const files = writeNote(folder, basis.title, basis.content, citations);
    zip.file(`${folder}/snapshot.json`, JSON.stringify(basis, null, 2));
    zip.file(`${folder}/citations.json`, JSON.stringify(citations, null, 2));
    return {
      noteId: basis.id,
      title: basis.title,
      revision: basis.revision,
      updatedAt: basis.updatedAt,
      availability,
      availabilityReason: labels[availability],
      ...files,
      snapshot: `${folder}/snapshot.json`,
      citations: `${folder}/citations.json`,
      currentMetadata:
        availability === "current" ? `notes/${safeName(basis.id)}/metadata.json` : null,
    };
  }
  const relationMapping = (snapshot.conceptRelations ?? []).map((relation) => {
    const folder = `relations/${safeName(relation.id)}`;
    const from = writeEndpoint(`${folder}/from`, relation.from);
    const to = writeEndpoint(`${folder}/to`, relation.to);
    const fromCitations = exportCitations(relation.fromCitations, "../../");
    const toCitations = exportCitations(relation.toCitations, "../../");
    const availabilityReason = relationAvailabilityReason(snapshot, relation);
    const availability = relation.deletedAt
      ? "deleted"
      : availabilityReason
        ? "needs_review"
        : "current";
    const direction = relation.type === "prerequisite" ? "from_before_to" : "symmetric";
    const directionLabel =
      relation.type === "prerequisite"
        ? `起点「${relation.from.title}」是终点「${relation.to.title}」的前置知识`
        : "双向关系；起点与终点分别保留各自的观点和适用条件";
    const paragraph = (value: string) => `<p>${escaped(value).replace(/\r?\n/g, "<br>")}</p>`;
    const side = (
      label: string,
      basis: KnowledgeNoteSnapshot,
      claim: string,
      condition: string,
      endpoint: typeof from,
      citations: ArchiveCitation[],
    ) =>
      `<h2>${label}：${escaped(basis.title)}</h2>${paragraph(`基线 revision：${basis.revision}；更新时间：${basis.updatedAt}`)}${paragraph(`当前可用性：${endpoint.availabilityReason}`)}<h3>记录时的观点</h3>${paragraph(claim)}<h3>适用条件</h3>${paragraph(condition || "未记录适用条件")}<h3>${label}原文依据</h3>${citations.length ? citationHtml(citations) : paragraph("未记录原文引用；这是需要进一步核对的关系建议。")}`;
    const content = `<h2>关系记录</h2>${paragraph(`类型：${relationLabels[relation.type]}（${relation.type}）`)}${paragraph(`来源：${relation.origin === "ai" ? "AI 建议（人工编辑后仍保留 AI 来源）" : "手动记录"}`)}${paragraph(`方向：${directionLabel}`)}${paragraph(`关系 revision：${relation.revision}；删除时间：${relation.deletedAt ?? "未删除"}`)}${paragraph(`当前可用性：${availabilityReason || "当前记录的页面基线和原文依据可用；不等于观点已被证实。"}`)}<h2>关系说明</h2>${paragraph(relation.explanation)}${side("起点", relation.from, relation.fromClaim, relation.fromCondition, from, fromCitations)}${side("终点", relation.to, relation.toClaim, relation.toCondition, to, toCitations)}`;
    const files = writeNote(
      folder,
      `${relationLabels[relation.type]}：${relation.from.title} — ${relation.to.title}`,
      content,
    );
    zip.file(`${folder}/metadata.json`, JSON.stringify(relation, null, 2));
    zip.file(
      `${folder}/citations.json`,
      JSON.stringify({ from: fromCitations, to: toCitations }, null, 2),
    );
    return {
      relationId: relation.id,
      type: relation.type,
      typeLabel: relationLabels[relation.type],
      direction,
      origin: relation.origin,
      revision: relation.revision,
      spaceId: relation.spaceId,
      createdAt: relation.createdAt,
      updatedAt: relation.updatedAt,
      deletedAt: relation.deletedAt,
      availability,
      availabilityReason,
      ...files,
      metadata: `${folder}/metadata.json`,
      citations: `${folder}/citations.json`,
      from,
      to,
    };
  });
  zip.file("relation-mapping.json", JSON.stringify(relationMapping, null, 2));
  zip.file("export-issues.json", JSON.stringify(issues, null, 2));
  zip.file(
    "relations/README.txt",
    "Conuo 知识关系导出\n\nrelations.json 保存全部已保存关系（含已删除记录），relation-mapping.json 列出阅读文件、双侧引用与两页基线快照的路径。每条关系有 Markdown、安全 HTML、metadata.json 与分 from/to 的 citations.json。from/to 子目录保留关系记录时的知识页快照及可读副本，绝不以当前页面替换。\n\ndirection 为 from_before_to 时，起点是终点的前置知识；symmetric 表示其他三类双向关系，仍分别保留两侧观点和条件。origin 为 ai 或 manual，AI 来源不因接受或编辑变为原文事实。关系 availability 为 current、needs_review 或 deleted；current 仅表示当前基线与依据可用，不证明观点成立。端点 availability 为 current、changed、deleted、missing 或 not_knowledge；只有 current 时提供当前页面的 currentMetadata，其余为 null。各引用的 sourceAvailability、sourceMetadata 与 metadataPath 遵守主 README 的资料版本规则。\n\nJSON 和 content.original.*.txt 保留原始数据；可读 Markdown/HTML 对观点、条件和引用原话进行安全转义。\n",
  );
  const missing = mapping
    .flatMap((item) => [item, ...item.versions])
    .filter((item) => item.originalStatus.startsWith("缺少"));
  zip.file(
    "README.txt",
    `Conuo 资料导出\n导出时间：${new Date().toISOString()}\n\nworkspace.json 是完整工作区数据，包含学习空间、资料、笔记及版本、对话、标注、可恢复草稿和回收站状态。\nsource-mapping.json 逐份列出当前资料路径，versions 数组按保存顺序列出全部保留的历史版本（包含没有引用的版本）。当前 sources/<id>/metadata.json 和 extracted.txt 路径保持兼容；历史 sources/<id>/versions/<versionId>/ 下包含 source.json、extracted.txt、chunks.json、可用的 web-snapshot.json，以及原文件或 original-status.txt 说明。网页快照 resources 数组只记录实际保存的资源，当前为空；不会抓取网页或用当前内容填充旧版。引用保留 sourceId、versionId、chunkId，不会绑定到其他版本。\nnotes 目录包含笔记和知识页的 Markdown、经过清理的可读 HTML、带来源和版本记录的 metadata.json，以及 citations.json。note-mapping.json 列出当前内容与每个历史版本的路径。草稿和回收站项目也包含在备份内，status / deletedAt 标明状态。\nrecoverable-drafts.json 单独保存资料删除与离线批注编辑冲突中保留的人工文字。每项以 sourceId、sourceVersionId 和 annotationId 绑定同一份已删除资料、准确版本及原批注；note 是用户新增的批注文字，quote 与 page 只提供原文上下文。记录本身不会自动恢复资料。\nMarkdown 使用 GFM 表格和删除线；表格单元格内换行使用固定 <br>，合并单元格展开为空白占位。字体、颜色、下划线和其他编辑器布局不属于 Markdown 的保真范围。\ncontent.original.*.txt 与 workspace.json 保留原始编辑器内容，不进行清理；.txt 后缀避免直接打开原始 HTML 时执行脚本。可读 Markdown / HTML 会移除执行性内容、危险链接和远程图片。\nversions 包含每次已保存历史版本的正文和元数据。已记录引用快照的版本会将当时的引用写入 Markdown、HTML 和独立 citations.json，并标记 historicalCitationsAvailable: true；空数组也表示已记录。旧版未记录引用快照时标记 false、citations 路径为 null，不生成引用文件，也不使用当前笔记的引用。版本当时的 status、aiGenerated、spaceId、contentRevision 在有记录时一并保留，缺失值在映射中为 null。\ncitations.json 的 sourceAvailability 保持 included 表示当前版本，historical 表示已保留的历史版本，deleted 表示已删除但可恢复的资料；source_missing、version_missing、citation_invalid 分别表示资料缺失、所引版本缺失、引用身份或摘录无法核对。sourceVersionState 独立标明 current、historical 或 unavailable，availabilityReason 提供说明。只有资料 ID、版本 ID、片段 ID 及摘录在确切版本中可核对时，才提供 sourceMetadata / extractedText（归档根路径）和 metadataPath / textPath（相对引用文件路径）；手动摘录允许同版正文中的选段和空白差异。缺失或无效时路径为 null，仍保留引用原话，不把现存新版本当作历史证据。已删除资料的引用可以打开备份中的准确版本，但带有删除警示，不表示仍可用于 AI。\nconversations.json 保留原始对话；conversation-mapping.json 映射每段对话及消息的可读副本和独立 citations.json，其历史引用同样指向确切版本。若消息使用了个人笔记依据，消息目录另有 note-evidence.json，消息映射的 noteEvidence 指向该文件。它与 citations.json 分开：每项保留原始问答 spaceId、sourceId、sourceVersionId、noteId、笔记 revision / updatedAt、块 ID、标题和摘录；可读 Markdown / HTML 以“我的笔记依据”显示，明确不是原始资料。备份恢复会重映射这些身份；资料后来更新、回收或彻底删除时，快照仅说明历史，不会让该资料重新参与新 AI。\nexport-issues.json 列出本次未包含原文件的逐项结构化原因；original-status.txt 也可定位到同一资料版本。\n\n原文件缺失：${missing.length} 份（含历史版本）。原件读取问题：${issues.length} 项。${missing.length ? "本次导出不完整：部分当前或历史版本缺少原件。文字和引用仍已保留，逐项状态见 source-mapping.json 与 export-issues.json。" : "此设备可取得的原文件已全部包含。"}\n`,
  );
  if (scope?.kind === "space") {
    const readme = await guardedRead(() => zip.file("README.txt")!.async("string"));
    zip.file(
      "README.txt",
      readme.replace(
        "workspace.json 是完整工作区数据",
        `导出范围：指定学习空间「${prepared.preview.spaceName}」。export-scope.json 列出范围、数量、额外引用资料、缺失引用与已知原件缺失。所选空间之外的当前笔记、对话和学习空间正文不包含；保留的知识关系和个人笔记依据仍可能含历史快照。额外引用资料包含当前完整正文、全部保留历史版本及其全部批注／可恢复草稿，不关联到所选空间。\nworkspace.json 是本次指定范围的业务快照`,
      ),
    );
  }
  assertContinue();
  onProgress?.({ phase: "archive", completed: 0, total: 1 });
  const bytes = await guardedRead(() =>
    zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    }),
  );
  onProgress?.({ phase: "archive", completed: 1, total: 1 });
  assertContinue();
  return { bytes, issues };
}

/** Backwards-compatible archive-only entry point for existing callers. */
export async function buildWorkspaceArchive(
  data: WorkspaceData,
  resolveBlob?: ResolveExportBlob,
): Promise<Uint8Array> {
  return (await buildWorkspaceArchiveResult(data, { resolveBlob })).bytes;
}

export async function exportWorkspace(
  data: WorkspaceData,
  resolveBlob?: ResolveExportBlob,
  options: Omit<BuildWorkspaceArchiveOptions, "resolveBlob"> = {},
): Promise<WorkspaceArchiveResult> {
  const result = await buildWorkspaceArchiveResult(data, { ...options, resolveBlob });
  const blob = new Blob([new Uint8Array(result.bytes)], { type: "application/zip" });
  options.assertCanContinue?.();
  const url = URL.createObjectURL(blob);
  let link: HTMLAnchorElement | undefined;
  try {
    options.assertCanContinue?.();
    link = document.createElement("a");
    link.href = url;
    const date = new Date().toISOString().slice(0, 10);
    const exportScope = options.scope;
    link.download =
      exportScope?.kind === "space"
        ? `conuo-${safeName(data.spaces.find((space) => space.id === exportScope.spaceId)!.name)}-${date}.zip`
        : `conuo-backup-${date}.zip`;
    document.body.appendChild(link);
    options.assertCanContinue?.();
    link.click();
  } catch (cause) {
    URL.revokeObjectURL(url);
    throw cause;
  } finally {
    link?.remove();
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return result;
}
