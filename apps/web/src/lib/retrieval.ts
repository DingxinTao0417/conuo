import type {
  AnswerNoteEvidence,
  AnswerRequest,
  AnswerResult,
  Chunk,
  Citation,
  Note,
  Source,
  WorkspaceData,
} from "./types";
import { getSourceVersion } from "./source-versions";
import {
  isCrossLibraryAnswerRequest,
  validateCrossLibraryAnswerRequest,
} from "./cross-library-ask";
import { answerRetrievalQuery } from "./answer-context";
import { answerNoteMarker, extractiveCitationMarker } from "./citation-markers";
import { knowledgeBlocks } from "./knowledge-update";
import { sourceCoverageNotices } from "./source-coverage";

const MAX_NOTE_EVIDENCE = 4;
const MAX_NOTE_EVIDENCE_CHARS = 8_000;
const MAX_NOTE_EVIDENCE_TOTAL_CHARS = 8_000;

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "of",
  "to",
  "for",
  "and",
  "or",
  "in",
  "on",
  "this",
  "that",
  "it",
  "what",
  "how",
  "why",
  "can",
  "please",
  "me",
  "什么",
  "么是",
  "是什",
  "如何",
  "怎么",
  "为什么",
  "为什",
  "为何",
  "请问",
  "请帮",
  "帮我",
  "一下",
  "这篇",
  "篇文",
  "文章",
  "资料",
  "中的",
  "的是",
  "以及",
  "关于",
  "是否",
  "哪些",
  "解释",
  "总结",
  "概括",
]);

function normalize(text: string): string {
  return text.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}
function tokens(text: string): string[] {
  const all: string[] = [];
  for (const match of normalize(text).matchAll(/[a-z0-9][a-z0-9_+-]*|[\p{Script=Han}]+/gu)) {
    const value = match[0];
    if (/\p{Script=Han}/u.test(value)) {
      for (let index = 0; index < value.length - 1; index++)
        all.push(value.slice(index, index + 2));
    } else if (value.length > 1 || /^\d$/.test(value)) all.push(value);
  }
  return [...new Set(all.filter((value) => !STOP_WORDS.has(value)))];
}

function response(
  content: string,
  citations: Citation[] = [],
  noteEvidence: AnswerNoteEvidence[] = [],
): AnswerResult {
  return {
    content,
    citations,
    ...(noteEvidence.length ? { noteEvidence } : {}),
    mode: "extractive",
  };
}

export function isHeadingOnly(source: Source, chunk: Chunk): boolean {
  if (source.kind !== "markdown" && source.kind !== "web") return false;
  const text = chunk.text.trim();
  const lines = text.split("\n").filter((line) => line.trim());
  return (
    lines.every((line) => /^ {0,3}#{1,6}(?:\s+.*)?$/.test(line)) ||
    /^.+\n[ \t]*(?:=+|-+)[ \t]*$/.test(text)
  );
}

export function selectedSources(data: WorkspaceData, request: AnswerRequest): Source[] {
  // Cross-library questions are never an implicit all-space query. The shared
  // validator checks every exact selection and returns no partial subset when
  // one source has changed, lost AI consent or left every active space.
  if (isCrossLibraryAnswerRequest(request)) {
    const resolved = validateCrossLibraryAnswerRequest(data, request);
    return resolved.ok ? resolved.sources : [];
  }
  return data.sources.filter((source) => {
    const inRequestedSpace =
      request.spaceId === "inbox"
        ? source.spaceIds.length === 0
        : source.spaceIds.includes(request.spaceId);
    if (source.deletedAt || !source.aiAllowed || !inRequestedSpace) return false;
    switch (request.scope) {
      case "selection":
      case "document":
      case "document-notes":
        return source.id === request.sourceId;
      case "sources":
        return request.sourceIds.includes(source.id);
      case "space":
        return true;
      default:
        return false;
    }
  });
}

export interface AnswerScopeAvailability {
  eligibleCount: number;
  excludedCount: number;
  blockedMessage?: string;
}

/** The same source-level readiness boundary used by evidence retrieval and the Reader composer. */
export function isSourceAnswerEligible(
  source: Pick<Source, "aiAllowed" | "deletedAt" | "status">,
): boolean {
  return (
    !source.deletedAt &&
    source.aiAllowed &&
    (source.status === "ready" || source.status === "partial")
  );
}

/** Explains whether a scoped question can produce evidence before it creates a conversation turn. */
export function answerScopeAvailability(
  sources: readonly Pick<Source, "aiAllowed" | "deletedAt" | "status">[],
): AnswerScopeAvailability {
  const eligibleCount = sources.filter(isSourceAnswerEligible).length;
  const excludedCount = sources.length - eligibleCount;
  if (eligibleCount) return { eligibleCount, excludedCount };
  if (!sources.length) {
    return {
      eligibleCount,
      excludedCount,
      blockedMessage: "当前范围没有资料，请先选择一份可用资料。",
    };
  }
  if (sources.every((source) => !source.aiAllowed)) {
    return {
      eligibleCount,
      excludedCount,
      blockedMessage: "当前范围没有允许用于 AI 的资料，请先开启资料的使用权限。",
    };
  }
  if (
    sources.some(
      (source) =>
        !source.deletedAt &&
        source.aiAllowed &&
        (source.status === "saved" || source.status === "parsing"),
    )
  ) {
    return {
      eligibleCount,
      excludedCount,
      blockedMessage:
        sources.length === 1
          ? "资料正在解析，完成后即可提问。已输入的问题会保留在本页。"
          : "当前范围的资料仍在解析，完成后即可提问。已输入的问题会保留在本页。",
    };
  }
  return {
    eligibleCount,
    excludedCount,
    blockedMessage:
      sources.length === 1
        ? "这份资料没有可用于问答的正文，请重新解析或选择其他范围。"
        : "当前范围没有可用于问答的正文，请重新解析或选择其他范围。",
  };
}

function documentSourceForNotes(data: WorkspaceData, request: AnswerRequest): Source | null {
  if (request.scope !== "document-notes" || !request.sourceId) return null;
  return (
    selectedSources(data, { ...request, scope: "document", sourceIds: [] }).find(
      (source) => source.id === request.sourceId,
    ) ?? null
  );
}

function noteEligibleForDocument(data: WorkspaceData, note: Note, source: Source, spaceId: string) {
  return (
    !note.deletedAt &&
    note.spaceId === spaceId &&
    note.kind === "note" &&
    note.status === "accepted" &&
    // A legacy or hand-constructed note with no explicit origin cannot be
    // safely distinguished from an AI-generated one. Only explicit human
    // notes may expand an AI request.
    note.aiGenerated === false &&
    // A zero-citation note has no verifiable document association. Do not guess
    // based on the current space: that would broaden a document-scoped request.
    note.citations.length > 0 &&
    note.citations.every(
      (citation) =>
        citation.sourceId === source.id &&
        citation.versionId === source.versionId &&
        resolveCitation(data, citation)?.source === source,
    )
  );
}

type NoteEvidenceCandidate = AnswerNoteEvidence & { normalized: string };

/** The notes that are safely attached to the requested current document. */
export function selectedDocumentNotes(data: WorkspaceData, request: AnswerRequest): Note[] {
  const source = documentSourceForNotes(data, request);
  if (!source) return [];
  return data.notes.filter((note) => noteEligibleForDocument(data, note, source, request.spaceId));
}

/**
 * Returns the bounded, canonical personal-note blocks eligible for one current
 * document. The caller never supplies note IDs, and no note can cross a source
 * version, space, status, AI-origin, or provenance boundary.
 */
export function selectedDocumentNoteEvidence(
  data: WorkspaceData,
  request: AnswerRequest,
): AnswerNoteEvidence[] {
  const source = documentSourceForNotes(data, request);
  if (!source) return [];
  const candidates: NoteEvidenceCandidate[] = [];
  for (const note of selectedDocumentNotes(data, request)) {
    let blocks;
    try {
      blocks = knowledgeBlocks(note.content);
    } catch {
      // A malformed local note must not expand the document's AI evidence.
      continue;
    }
    for (const block of blocks) {
      const quote = block.text.trim();
      if (!quote || quote.length > MAX_NOTE_EVIDENCE_CHARS || !note.title.trim()) continue;
      candidates.push({
        noteId: note.id,
        spaceId: request.spaceId,
        sourceId: source.id,
        sourceVersionId: source.versionId,
        revision: note.contentRevision ?? 0,
        updatedAt: note.updatedAt,
        blockId: block.id,
        title: note.title,
        quote,
        normalized: normalize(quote),
      });
    }
  }
  const terms = tokens(answerRetrievalQuery(request));
  if (!terms.length || !candidates.length) return [];
  const broad = /总结|概括|梳理|要点|主要内容|summary|overview|key points/i.test(request.question);
  const frequencies = new Map(
    terms.map((term) => [
      term,
      candidates.filter((candidate) => candidate.normalized.includes(term)).length,
    ]),
  );
  const ranked = candidates
    .map((candidate, index) => {
      const matches = terms.filter((term) => candidate.normalized.includes(term));
      const meaningful =
        broad ||
        matches.some((term) => /^[a-z0-9]/.test(term)) ||
        matches.length >= Math.min(2, terms.length);
      const score = matches.reduce(
        (total, term) =>
          total + Math.log(1 + candidates.length / ((frequencies.get(term) ?? 0) + 1)),
        0,
      );
      return { candidate, index, score: meaningful ? score : 0 };
    })
    .filter((item) => item.score > 0 || broad)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ candidate }) => candidate);
  const result: AnswerNoteEvidence[] = [];
  let length = 0;
  for (const candidate of ranked) {
    if (result.length >= MAX_NOTE_EVIDENCE) break;
    if (length + candidate.quote.length > MAX_NOTE_EVIDENCE_TOTAL_CHARS) continue;
    result.push({
      noteId: candidate.noteId,
      spaceId: candidate.spaceId,
      sourceId: candidate.sourceId,
      sourceVersionId: candidate.sourceVersionId,
      revision: candidate.revision,
      updatedAt: candidate.updatedAt,
      blockId: candidate.blockId,
      title: candidate.title,
      quote: candidate.quote,
    });
    length += candidate.quote.length;
  }
  return result;
}

/** Resolves a saved note-evidence snapshot to the exact current note block. */
export function resolveAnswerNoteEvidence(
  data: WorkspaceData,
  evidence: AnswerNoteEvidence,
): { note: Note; quote: string } | null {
  const source = data.sources.find(
    (item) =>
      item.id === evidence.sourceId &&
      !item.deletedAt &&
      item.versionId === evidence.sourceVersionId,
  );
  const sourceInSpace =
    evidence.spaceId === "inbox"
      ? source?.spaceIds.length === 0
      : source?.spaceIds.includes(evidence.spaceId);
  if (!source || !source.aiAllowed || !sourceInSpace) return null;
  const note = data.notes.find(
    (item) =>
      item.id === evidence.noteId &&
      !item.deletedAt &&
      (item.contentRevision ?? 0) === evidence.revision &&
      item.updatedAt === evidence.updatedAt &&
      item.title === evidence.title,
  );
  if (!note || !noteEligibleForDocument(data, note, source, evidence.spaceId)) return null;
  try {
    const block = knowledgeBlocks(note.content).find((item) => item.id === evidence.blockId);
    if (!block || block.text.trim() !== evidence.quote) return null;
    return { note, quote: block.text.trim() };
  } catch {
    return null;
  }
}

/** Presentation-only extractive section. Evidence objects remain canonical and typed. */
export function formatNoteEvidenceExtracts(noteEvidence: AnswerNoteEvidence[]) {
  if (!noteEvidence.length) return "";
  return `\n\n---\n\n以下是与问题相关的我的笔记摘录。它们是你保存的个人理解，不是原始资料：\n\n${noteEvidence
    .map(
      (evidence, index) =>
        `**${answerNoteMarker(index)}**\n\n> ${evidence.quote
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}`,
    )
    .join("\n\n")}`;
}

/** Pure, deterministic evidence lookup. It never pretends to call a model. */
export function retrieveEvidence(data: WorkspaceData, request: AnswerRequest): AnswerResult {
  if (!data.aiEnabled) return response("AI 功能已关闭。开启后才会使用资料进行证据检索或问答。");
  const question = request.question.trim();
  if (!question) return response("请输入想了解的问题。");
  const crossLibrary = isCrossLibraryAnswerRequest(request)
    ? validateCrossLibraryAnswerRequest(data, request)
    : undefined;
  if (crossLibrary && !crossLibrary.ok) return response(crossLibrary.error.message);
  if (
    request.scope === "document-notes" &&
    (!request.sourceId || request.sourceIds.length || request.selection !== undefined)
  )
    return response("“此资料 + 我的笔记”只能针对当前一份资料，不能附带其他资料或选段。");
  // Inbox is a virtual scope containing only unassigned sources, never a fallback
  // for unknown spaces or a shortcut around a source's explicit associations.
  if (
    !crossLibrary &&
    request.spaceId !== "inbox" &&
    !data.spaces.some((space) => space.id === request.spaceId && !space.archived)
  ) {
    return response("当前学习空间不可用，请切换到可用空间后重试。");
  }
  const sources = crossLibrary?.ok ? crossLibrary.sources : selectedSources(data, request);
  if (!sources.length)
    return response("当前范围没有可使用的资料。请选择资料，并确认资料未删除且允许 AI 使用。");
  const ready = sources.filter(isSourceAnswerEligible);
  if (!ready.length)
    return response(
      "当前范围的资料尚未提取出可检索文字。原文件仍可阅读；请等待处理完成，或检查解析状态。仅保存链接的网页不参与问答。",
    );
  const selection = normalize(request.selection ?? "");
  if (
    request.scope === "selection" &&
    (!selection || !ready.some((source) => normalize(source.text).includes(selection)))
  ) {
    return response("选段为空或不属于当前资料版本，请重新选择原文。此次未检索其他资料。");
  }
  const indexed = ready.flatMap((source) =>
    source.chunks
      .filter(
        (chunk) =>
          chunk.sourceId === source.id && chunk.versionId === source.versionId && chunk.text.trim(),
      )
      .map((chunk) => ({ source, chunk, normalized: normalize(chunk.text) })),
  );
  if (!indexed.length)
    return response("当前资料的索引尚未就绪，或索引属于旧版本。请重新处理资料后重试。");
  // Keep heading chunks and their IDs intact for existing citations/navigation,
  // but do not let keyword-heavy titles displace actual evidence paragraphs.
  const candidates = indexed.filter(({ source, chunk }) => !isHeadingOnly(source, chunk));
  if (!candidates.length)
    return response(
      "当前范围仅有标题，没有可引用的正文证据。标题本身不足以回答问题，请补充正文资料。",
    );
  const terms = tokens(answerRetrievalQuery(request));
  if (!terms.length) {
    return response(
      "请在问题中加入具体概念或关键词，例如“学习率过高有哪些表现”。当前提供原文证据检索；未配置生成模型时不会生成总结。",
    );
  }
  const frequencies = new Map(
    terms.map((term) => [term, candidates.filter((item) => item.normalized.includes(term)).length]),
  );
  const ranked = candidates
    .map((item) => {
      const matches = terms.filter((term) => item.normalized.includes(term));
      const meaningful =
        matches.some((term) => /^[a-z0-9]/.test(term)) ||
        matches.length >= Math.min(2, terms.length);
      let score = matches.reduce(
        (total, term) =>
          total + Math.log(1 + candidates.length / ((frequencies.get(term) ?? 0) + 1)),
        0,
      );
      if (
        request.scope === "selection" &&
        selection &&
        (item.normalized.includes(selection) || selection.includes(item.normalized))
      )
        score *= 1.5;
      return { ...item, score: meaningful ? score : 0 };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.order - b.chunk.order)
    .slice(0, 4);

  const coverageNotices = sourceCoverageNotices(sources);
  const coverage = coverageNotices.length ? `\n\n${coverageNotices.join(" ")}` : "";
  if (!ranked.length)
    return response(
      `在当前范围的已解析文字中，没有找到与问题足够相关的原文证据。可尝试更具体的关键词或调整资料范围。${coverage}`,
    );
  const citations = ranked.map(({ source, chunk }): Citation => ({
    sourceId: source.id,
    versionId: source.versionId,
    chunkId: chunk.id,
    title: source.title,
    quote: chunk.text,
    page: chunk.page,
    section: chunk.section,
  }));
  const passages = citations
    .map((citation, index) => {
      return `**${extractiveCitationMarker(index)}**\n\n${citation.quote
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}`;
    })
    .join("\n\n");
  const noteEvidence = selectedDocumentNoteEvidence(data, request);
  const notePassages = formatNoteEvidenceExtracts(noteEvidence);
  return response(
    `以下是与问题相关的原文摘录。本次使用关键词检索，未调用生成式 AI；摘录不等同于已经推导出的答案。\n\n${passages}${notePassages}${coverage}`,
    citations,
    noteEvidence,
  );
}

/** Shared citation check for saved conversations and provenance consumers. */
export function resolveCitation(
  data: WorkspaceData,
  citation: Citation,
): { source: Source; chunk: Chunk } | null {
  const source = data.sources.find(
    (item) =>
      item.id === citation.sourceId && !item.deletedAt && item.versionId === citation.versionId,
  );
  const chunk = source?.chunks.find(
    (item) =>
      item.id === citation.chunkId &&
      item.sourceId === citation.sourceId &&
      item.versionId === citation.versionId,
  );
  if (!source || !chunk || chunk.text !== citation.quote) return null;
  return { source, chunk };
}

/** Historical reading/export only. New AI contexts must keep using resolveCitation. */
export function resolveSavedCitation(
  data: WorkspaceData,
  citation: Citation,
): { source: Source; chunk: Chunk } | null {
  const live = data.sources.find((item) => item.id === citation.sourceId && !item.deletedAt);
  const source = live && getSourceVersion(live, citation.versionId);
  const chunk = source?.chunks.find(
    (item) =>
      item.id === citation.chunkId &&
      item.sourceId === citation.sourceId &&
      item.versionId === citation.versionId,
  );
  if (!source || !chunk || chunk.text !== citation.quote) return null;
  return { source, chunk };
}
