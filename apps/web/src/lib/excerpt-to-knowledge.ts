import { reviseNote } from "./note-versions";
import { resolveCitation } from "./retrieval";
import { MAX_WORKSPACE_BYTES, workspaceSchema } from "./supabase/validation";
import type { Chunk, Citation, ManualExcerptReference, Note, Source, WorkspaceData } from "./types";

const MAX_KNOWLEDGE_PAGE_CONTENT = 200_000;
const MAX_KNOWLEDGE_PAGE_CITATIONS = 1_000;
const MAX_KNOWLEDGE_PAGE_MANUAL_EXCERPTS = 1_000;

/** Bounds a direct learner excerpt before it becomes persistent page content. */
export const EXCERPT_TO_KNOWLEDGE_LIMITS = {
  selectionCharacters: 6_000,
} as const;

export interface ExcerptToKnowledgeInput {
  /** The visible learning-space scope at the moment the learner saves. */
  spaceId: string;
  /** Current source identity from the reader, never inferred from page content. */
  sourceId: string;
  /** Exact current source version shown by the reader. */
  versionId: string;
  /** User-selected original text. Whitespace can differ only harmlessly from source text. */
  selection: string;
  /** A Reader-resolved current chunk. The domain validates it again before saving. */
  anchorChunkId?: string;
  /** Native PDF page visible when the learner made the selection. */
  anchorPage?: number;
}

export interface AppendExcerptToKnowledgePageInput extends ExcerptToKnowledgeInput {
  /** Existing knowledge page to receive the manual excerpt. */
  noteId: string;
}

export type ExcerptToKnowledgeFailureReason =
  | "invalid-input"
  | "space-unavailable"
  | "target-unavailable"
  | "target-outside-space"
  | "source-unavailable"
  | "source-deleted"
  | "source-version-changed"
  | "source-outside-space"
  | "selection-empty"
  | "selection-too-long"
  | "selection-not-in-source"
  | "selection-cross-chunk"
  | "selection-ambiguous"
  | "selection-anchor-invalid"
  | "source-not-anchorable"
  | "citation-limit"
  | "manual-excerpt-limit"
  | "content-limit"
  | "workspace-invalid"
  | "workspace-capacity";

type ExcerptToKnowledgeSuccess = {
  ok: true;
  data: WorkspaceData;
  note: Note;
  /** A normal, strict source citation that continues to resolve everywhere else. */
  citation: Citation;
  /** False means this exact source/version/selection was already saved to this page. */
  appended: boolean;
};

type ExcerptToKnowledgeFailure = {
  ok: false;
  reason: ExcerptToKnowledgeFailureReason;
  message: string;
};

export type ExcerptToKnowledgeResult = ExcerptToKnowledgeSuccess | ExcerptToKnowledgeFailure;

function failure(
  reason: ExcerptToKnowledgeFailureReason,
  message: string,
): ExcerptToKnowledgeFailure {
  return { ok: false, reason, message };
}

function canonicalSelection(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

/** Only spacing normalization is allowed when proving a visual reader selection belongs to source text. */
function compactWhitespace(value: string): string {
  return value.replace(/\s/gu, "");
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function sourceBelongsToSpace(source: Source, spaceId: string): boolean {
  return spaceId === "inbox" ? source.spaceIds.length === 0 : source.spaceIds.includes(spaceId);
}

function activeSpace(data: WorkspaceData, spaceId: string): boolean {
  return (
    spaceId === "inbox" || data.spaces.some((space) => space.id === spaceId && !space.archived)
  );
}

function validCurrentChunks(source: Source): Chunk[] {
  return source.chunks.filter(
    (chunk) =>
      !!chunk.text &&
      chunk.sourceId === source.id &&
      chunk.versionId === source.versionId &&
      source.text.includes(chunk.text),
  );
}

function citationFromAnchor(source: Source, chunk: Chunk): Citation {
  return {
    sourceId: source.id,
    versionId: source.versionId,
    chunkId: chunk.id,
    title: source.title,
    // Citation quote deliberately remains the exact saved chunk. Keeping the
    // strict Citation contract means the source can still be opened, accepted,
    // exported and checked by all existing consumers.
    quote: chunk.text,
    section: chunk.section,
    ...(chunk.page === undefined ? {} : { page: chunk.page }),
  };
}

function citationKey(citation: Citation): string {
  return JSON.stringify([
    citation.sourceId,
    citation.versionId,
    citation.chunkId,
    citation.quote,
    citation.page ?? null,
    citation.section,
  ]);
}

/**
 * Stable duplicate signature for one selected subset. This is not a security
 * primitive; two independent 32-bit lanes merely make accidental collisions
 * impractical without persisting learner source text in metadata.
 */
function excerptFingerprint(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    first ^= codePoint;
    first = Math.imul(first, 0x01000193);
    second ^= codePoint;
    second = Math.imul(second, 0x27d4eb2d);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

/** Compatibility only for pages saved before excerpt identities moved out of HTML comments. */
function legacyExcerptMarker(source: Source, compactSelection: string): string {
  let hash = 0x811c9dc5;
  for (const character of compactSelection) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `<!-- conuo-excerpt:${source.id}:${source.versionId}:${(hash >>> 0)
    .toString(16)
    .padStart(8, "0")} -->`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function excerptHtml(quote: string, citationNumber: number): string {
  return [
    "<h2>原文摘录</h2>",
    `<blockquote><p>${escapeHtml(quote).replace(/\n/gu, "<br>")}</p></blockquote>`,
    `<p><em>人工摘录 · 原文依据：[${citationNumber}]</em></p>`,
  ].join("");
}

type ValidatedExcerpt = {
  source: Source;
  quote: string;
  citation: Citation;
  reference: ManualExcerptReference;
  legacyMarker: string;
};

function manualExcerptReference(
  source: Source,
  chunk: Chunk,
  compactSelection: string,
): ManualExcerptReference {
  return {
    sourceId: source.id,
    versionId: source.versionId,
    chunkId: chunk.id,
    selectionFingerprint: excerptFingerprint(compactSelection),
  };
}

function manualExcerptReferenceKey(reference: ManualExcerptReference): string {
  return JSON.stringify([
    reference.sourceId,
    reference.versionId,
    reference.chunkId,
    reference.selectionFingerprint,
  ]);
}

function validateExcerpt(
  data: WorkspaceData,
  input: ExcerptToKnowledgeInput,
): ValidatedExcerpt | ExcerptToKnowledgeFailure {
  if (
    ![input.spaceId, input.sourceId, input.versionId].every(
      (value) => typeof value === "string" && value.trim(),
    ) ||
    typeof input.selection !== "string"
  )
    return failure("invalid-input", "摘录保存信息不完整，请重新打开当前资料后再试。");
  if (!activeSpace(data, input.spaceId))
    return failure("space-unavailable", "当前学习空间已不可用，请返回资料库后重新选择。");

  const source = data.sources.find((item) => item.id === input.sourceId);
  if (!source) return failure("source-unavailable", "这份资料已不可用，请返回资料库后重试。");
  if (source.deletedAt)
    return failure("source-deleted", "资料已移入回收站，不能继续保存其中的摘录。");
  if (source.versionId !== input.versionId)
    return failure("source-version-changed", "资料已有新版本，请切回当前版本后重新选择摘录。");
  if (!sourceBelongsToSpace(source, input.spaceId))
    return failure("source-outside-space", "资料已不在当前学习空间中，未保存摘录。");

  const quote = canonicalSelection(input.selection);
  const compactSelection = compactWhitespace(quote);
  if (!compactSelection) return failure("selection-empty", "请先选择一段原文。");
  if (characterCount(quote) > EXCERPT_TO_KNOWLEDGE_LIMITS.selectionCharacters)
    return failure(
      "selection-too-long",
      `单次原文摘录最多 ${EXCERPT_TO_KNOWLEDGE_LIMITS.selectionCharacters.toLocaleString("zh-CN")} 个字符，请拆分后保存。`,
    );
  if (!compactWhitespace(source.text).includes(compactSelection))
    return failure("selection-not-in-source", "所选文字不属于当前资料版本，未保存摘录。");

  const chunks = validCurrentChunks(source);
  if (!chunks.length)
    return failure(
      "source-not-anchorable",
      "当前资料没有可定位的已解析片段，暂不能建立可追溯的原文摘录。",
    );
  if (
    input.anchorPage !== undefined &&
    (!Number.isSafeInteger(input.anchorPage) || input.anchorPage < 1)
  )
    return failure("invalid-input", "原文摘录页码无效，请重新选择后再保存。");
  if (input.anchorChunkId !== undefined && !input.anchorChunkId.trim())
    return failure("invalid-input", "原文摘录定位信息无效，请重新选择后再保存。");

  const matchingChunks = chunks.filter((item) =>
    compactWhitespace(item.text).includes(compactSelection),
  );
  let chunk: Chunk | undefined;
  if (input.anchorChunkId) {
    chunk = chunks.find((item) => item.id === input.anchorChunkId);
    if (
      !chunk ||
      (input.anchorPage !== undefined && chunk.page !== input.anchorPage) ||
      !compactWhitespace(chunk.text).includes(compactSelection)
    )
      return failure(
        "selection-anchor-invalid",
        "所选文字已无法定位到当前原文位置，请重新选择后再保存。",
      );
  } else {
    const candidates =
      input.anchorPage === undefined
        ? matchingChunks
        : matchingChunks.filter((item) => item.page === input.anchorPage);
    if (!candidates.length && input.anchorPage !== undefined)
      return failure(
        "selection-anchor-invalid",
        `所选文字未能定位到第 ${input.anchorPage} 页，请重新选择后再保存。`,
      );
    if (candidates.length > 1)
      return failure(
        "selection-ambiguous",
        "所选文字在多个原文片段中重复出现，请缩小选区后再保存。",
      );
    chunk = candidates[0];
  }
  if (!chunk)
    return failure(
      "selection-cross-chunk",
      "所选文字跨越多个原文片段，暂不能建立精确引用；请缩小选区后再保存。",
    );

  const citation = citationFromAnchor(source, chunk);
  // Guard this invariant here rather than letting an invalid manual citation
  // silently reach search, review, exports or the reader.
  if (!resolveCitation(data, citation))
    return failure("source-not-anchorable", "当前原文片段无法核对，未保存摘录。");

  return {
    source,
    quote,
    citation,
    reference: manualExcerptReference(source, chunk, compactSelection),
    legacyMarker: legacyExcerptMarker(source, compactSelection),
  };
}

function isFailure(
  value: ValidatedExcerpt | ExcerptToKnowledgeFailure,
): value is ExcerptToKnowledgeFailure {
  return "ok" in value && value.ok === false;
}

function withWorkspaceChecks(data: WorkspaceData): ExcerptToKnowledgeFailure | null {
  if (!workspaceSchema.safeParse(data).success)
    return failure("workspace-invalid", "摘录引用或知识页数据无效，未保存任何内容。");
  if (new TextEncoder().encode(JSON.stringify(data)).byteLength > MAX_WORKSPACE_BYTES)
    return failure("workspace-capacity", "保存后工作区会超过容量上限，本次未修改知识页。");
  return null;
}

function existingCitationIndex(note: Note, citation: Citation): number {
  const key = citationKey(citation);
  return note.citations.findIndex((item) => citationKey(item) === key);
}

function addedContent(
  note: Note,
  quote: string,
  citationNumber: number,
): string | ExcerptToKnowledgeFailure {
  const appended = excerptHtml(quote, citationNumber);
  const content = `${note.content}${note.content ? "\n" : ""}${appended}`;
  if (content.length > MAX_KNOWLEDGE_PAGE_CONTENT)
    return failure("content-limit", "知识页内容已达上限，请拆分页面后再保存。");
  return content;
}

/**
 * Create a manual knowledge-page draft from one exact, current reader selection.
 * The direct excerpt is never an AI answer and therefore begins with aiGenerated=false.
 */
export function createKnowledgePageFromExcerpt(
  data: WorkspaceData,
  input: ExcerptToKnowledgeInput,
): ExcerptToKnowledgeResult {
  const validated = validateExcerpt(data, input);
  if (isFailure(validated)) return validated;
  const initialContent = excerptHtml(validated.quote, 1);
  if (initialContent.length > MAX_KNOWLEDGE_PAGE_CONTENT)
    return failure("content-limit", "知识页内容已达上限，请拆分页面后再保存。");
  const now = new Date().toISOString();
  const note: Note = {
    id: crypto.randomUUID(),
    spaceId: input.spaceId,
    title: "未命名知识页",
    content: initialContent,
    kind: "knowledge",
    aiGenerated: false,
    contentRevision: 0,
    status: "draft",
    citations: [{ ...validated.citation }],
    manualExcerptRefs: [{ ...validated.reference }],
    versions: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const next: WorkspaceData = { ...data, notes: [note, ...data.notes] };
  const problem = withWorkspaceChecks(next);
  if (problem) return problem;
  return { ok: true, data: next, note, citation: { ...validated.citation }, appended: true };
}

/**
 * Append a learner-selected original excerpt without rewriting existing text.
 * Existing AI flags are deliberately retained: an AI-assisted page can also
 * contain a clearly marked manual excerpt without being relabelled as human-only.
 */
export function appendExcerptToKnowledgePage(
  data: WorkspaceData,
  input: AppendExcerptToKnowledgePageInput,
): ExcerptToKnowledgeResult {
  if (typeof input.noteId !== "string" || !input.noteId.trim())
    return failure("invalid-input", "目标知识页信息不完整，请重新选择。");
  const note = data.notes.find((item) => item.id === input.noteId && !item.deletedAt);
  if (!note || note.kind !== "knowledge")
    return failure("target-unavailable", "目标知识页已不可用，请重新选择。");
  if (note.spaceId !== input.spaceId)
    return failure("target-outside-space", "只能保存到当前学习空间中的知识页，请重新选择。");

  const validated = validateExcerpt(data, input);
  if (isFailure(validated)) return validated;
  const citationIndex = existingCitationIndex(note, validated.citation);
  const referenceKey = manualExcerptReferenceKey(validated.reference);
  const hasReference = (note.manualExcerptRefs ?? []).some(
    (reference) => manualExcerptReferenceKey(reference) === referenceKey,
  );
  const hasLegacyMarker = note.content.includes(validated.legacyMarker);
  if (hasReference || hasLegacyMarker) {
    if (citationIndex < 0)
      return failure("workspace-invalid", "已有摘录记录不完整，请先核对知识页引用后再保存。");
    if (!hasReference) {
      // Existing comments are retained only for backward compatibility. Move
      // their identity into versioned note metadata before an editor strips it.
      const migrated = reviseNote(
        note,
        { manualExcerptRefs: [...(note.manualExcerptRefs ?? []), { ...validated.reference }] },
        "none",
      );
      const next: WorkspaceData = {
        ...data,
        notes: data.notes.map((item) => (item.id === note.id ? migrated : item)),
      };
      const problem = withWorkspaceChecks(next);
      if (problem) return problem;
      return {
        ok: true,
        data: next,
        note: migrated,
        citation: { ...note.citations[citationIndex]! },
        appended: false,
      };
    }
    return {
      ok: true,
      data,
      note,
      citation: { ...note.citations[citationIndex]! },
      appended: false,
    };
  }
  const citations = note.citations.map((item) => ({ ...item }));
  const manualExcerptRefs = (note.manualExcerptRefs ?? []).map((reference) => ({ ...reference }));
  const number = citationIndex >= 0 ? citationIndex + 1 : citations.length + 1;
  if (citationIndex < 0) citations.push({ ...validated.citation });
  if (citations.length > MAX_KNOWLEDGE_PAGE_CITATIONS)
    return failure("citation-limit", "知识页引用数量已达上限，请拆分页面后再保存。");
  if (manualExcerptRefs.length >= MAX_KNOWLEDGE_PAGE_MANUAL_EXCERPTS)
    return failure("manual-excerpt-limit", "知识页人工摘录数量已达上限，请拆分页面后再保存。");
  manualExcerptRefs.push({ ...validated.reference });
  const content = addedContent(note, validated.quote, number);
  if (typeof content !== "string") return content;

  // `always` preserves the exact old page before the new manual block changes
  // review status. Keep aiGenerated untouched so an AI-assisted page stays
  // accurately labelled after a learner adds their own quoted material.
  const revised = reviseNote(
    note,
    { content, citations, manualExcerptRefs, status: "draft" },
    "always",
  );
  const next: WorkspaceData = {
    ...data,
    notes: data.notes.map((item) => (item.id === note.id ? revised : item)),
  };
  const problem = withWorkspaceChecks(next);
  if (problem) return problem;
  return {
    ok: true,
    data: next,
    note: revised,
    citation: { ...validated.citation },
    appended: true,
  };
}
