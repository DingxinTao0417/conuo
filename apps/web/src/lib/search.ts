import { knowledgeBlocks } from "./knowledge-update";
import { getSourceVersion } from "./source-versions";
import { sourceCoverageNotices } from "./source-coverage";
import { searchCandidatesSchema, searchRequestSchema } from "./search-types";
import type {
  SearchCandidate,
  SearchHit,
  SearchProvenance,
  SearchRequest,
  SearchResult,
  SearchScope,
} from "./search-types";
import type { Note, Source, WorkspaceData } from "./types";

const normalize = (value: string) =>
  value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
const compact = (value: string) => value.replace(/\s/gu, "");
const MAX_SNIPPET = 260;

export class SearchBoundaryError extends Error {
  constructor(message = "搜索范围或内容版本已改变，请重新搜索。") {
    super(message);
    this.name = "SearchBoundaryError";
  }
}

/** Shared deterministic keyword baseline, including single Han characters and C++/C# terms. */
export function searchTokens(query: string): string[] {
  const values: string[] = [];
  for (const match of normalize(query).matchAll(/[a-z0-9][a-z0-9_+#.-]*|[\p{Script=Han}]+/gu)) {
    const text = match[0];
    if (/\p{Script=Han}/u.test(text)) {
      const letters = Array.from(text);
      if (letters.length === 1) values.push(text);
      else
        for (let index = 0; index < letters.length - 1; index++)
          values.push(letters.slice(index, index + 2).join(""));
    } else values.push(text);
  }
  return [...new Set(values)];
}

export function validateSearchRequest(data: WorkspaceData, value: SearchRequest): SearchRequest {
  const parsed = searchRequestSchema.safeParse(value);
  if (!parsed.success) throw new SearchBoundaryError("请检查搜索词、筛选条件与明确的搜索范围。");
  const request = parsed.data;
  const scope = request.scope;
  if (
    scope.kind === "space" &&
    !data.spaces.some((space) => space.id === scope.spaceId && !space.archived)
  )
    throw new SearchBoundaryError("所选知识库不可用，请切换后重新搜索。");
  return request;
}

function inScope(spaceIds: string[], scope: SearchScope): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "inbox") return !spaceIds.length;
  return spaceIds.includes(scope.spaceId);
}

function within(date: string, range?: { from?: string; to?: string }): boolean {
  if (!range) return true;
  const instant = Date.parse(date);
  return (
    Number.isFinite(instant) &&
    (!range.from || instant >= Date.parse(range.from)) &&
    (!range.to || instant < Date.parse(range.to))
  );
}

/** Ordinary-search metadata filter for a validated request, applied before database top-K.
 * This deliberately ignores AI consent and must not be reused as an AI evidence authorization check.
 */
export function searchItemEligible(item: Source | Note, request: SearchRequest): boolean {
  const isSource = "versionId" in item;
  const spaces = isSource ? item.spaceIds : item.spaceId === "inbox" ? [] : [item.spaceId];
  if (item.deletedAt || !inScope(spaces, request.scope)) return false;
  if (!isSource && item.status === "draft" && !request.includeDrafts) return false;
  const filters = request.filters;
  if (filters?.types?.length && !filters.types.includes(item.kind)) return false;
  if (filters?.starred !== undefined && (!isSource || item.starred !== filters.starred))
    return false;
  if (
    filters?.tags?.length &&
    (!isSource ||
      !filters.tags.every((tag) => item.tags.some((value) => normalize(value) === normalize(tag))))
  )
    return false;
  return within(item.createdAt, filters?.created) && within(item.updatedAt, filters?.updated);
}

function rank(query: string, title: string, tags: string[], body: string): number {
  if (!query.trim()) return 1;
  const needle = normalize(query);
  const fields = [normalize(title), normalize(tags.join(" ")), normalize(body)];
  const phrase = fields.map((field) => field.includes(needle));
  const terms = searchTokens(query);
  const matched = terms.filter((term) => fields.some((field) => field.includes(term)));
  if (!phrase.some(Boolean) && matched.length < Math.min(2, terms.length)) return 0;
  return (
    (phrase[0] ? 100 : 0) +
    (phrase[1] ? 60 : 0) +
    (phrase[2] ? 30 : 0) +
    matched.reduce(
      (score, term) => score + (fields[0].includes(term) ? 8 : fields[1].includes(term) ? 5 : 1),
      0,
    )
  );
}

function snippet(text: string, query: string): string {
  const content = text.replace(/\s+/gu, " ").trim();
  if (Array.from(content).length <= MAX_SNIPPET) return content;
  // Search normalization is not used for persisted offsets or quotations.
  const terms = [query.trim(), ...searchTokens(query)].filter(Boolean);
  const lower = content.toLowerCase();
  const matches = terms
    .map((term) => lower.indexOf(term.toLowerCase()))
    .filter((index) => index >= 0);
  const index = matches.length ? Math.min(...matches) : 0;
  const characterIndex = Array.from(content.slice(0, index)).length;
  const characters = Array.from(content);
  const start = Math.max(0, characterIndex - 60);
  const end = Math.min(characters.length, start + MAX_SNIPPET - 2);
  return `${start ? "…" : ""}${characters.slice(start, end).join("")}${end < characters.length ? "…" : ""}`;
}

function noteProvenance(data: WorkspaceData, note: Note): SearchProvenance {
  let historicalCount = 0,
    unavailableCount = 0,
    aiRestrictedCount = 0;
  for (const citation of note.citations) {
    const owner = data.sources.find((source) => source.id === citation.sourceId);
    if (owner && !owner.aiAllowed) aiRestrictedCount++;
    const source = owner && !owner.deletedAt ? getSourceVersion(owner, citation.versionId) : null;
    const chunk = source?.chunks.find(
      (value) =>
        value.id === citation.chunkId &&
        value.sourceId === citation.sourceId &&
        value.versionId === citation.versionId,
    );
    const quote = compact(citation.quote);
    if (
      !source ||
      !chunk ||
      !source.text.includes(chunk.text) ||
      !quote ||
      chunk.page !== citation.page ||
      chunk.section !== citation.section ||
      (!compact(chunk.text).includes(quote) && !compact(source.text).includes(quote))
    )
      unavailableCount++;
    else if (owner!.versionId !== citation.versionId) historicalCount++;
  }
  return {
    origin: note.aiGenerated ? "ai" : "user",
    label: note.aiGenerated
      ? note.status === "draft"
        ? "AI 草稿"
        : note.kind === "knowledge"
          ? "AI 整理 · 已接受知识页"
          : "AI 生成笔记"
      : note.kind === "knowledge"
        ? "用户知识页"
        : "用户笔记",
    referenceState: unavailableCount
      ? "unavailable"
      : historicalCount
        ? "historical"
        : note.citations.length
          ? "current"
          : "none",
    historicalCount,
    unavailableCount,
    aiRestrictedCount,
  };
}

function canonical(
  data: WorkspaceData,
  request: SearchRequest,
  candidate: SearchCandidate,
): SearchHit {
  if (candidate.kind === "source") {
    const source = data.sources.find((value) => value.id === candidate.objectId);
    if (!source || !searchItemEligible(source, request) || source.versionId !== candidate.versionId)
      throw new SearchBoundaryError();
    const chunk =
      candidate.blockId === null
        ? undefined
        : source.chunks.find(
            (value) =>
              value.id === candidate.blockId &&
              value.sourceId === source.id &&
              value.versionId === source.versionId &&
              !!value.text.trim() &&
              source.text.includes(value.text),
          );
    if (candidate.blockId !== null && !chunk)
      throw new SearchBoundaryError("搜索片段与当前原文无法核对，请重新搜索。");
    return {
      ...candidate,
      id: JSON.stringify([candidate.kind, source.id, source.versionId, candidate.blockId]),
      title: source.title,
      snippet: snippet(chunk?.text ?? source.text, request.query),
      sourceKind: source.kind,
      tags: [...source.tags],
      spaceIds: [...source.spaceIds],
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      draft: false,
      locator: chunk
        ? {
            kind: "chunk",
            section: chunk.section,
            order: chunk.order,
            ...(chunk.page ? { page: chunk.page } : {}),
          }
        : { kind: "metadata" },
      provenance: {
        origin: "original",
        label: "原始资料",
        referenceState: "current",
        historicalCount: 0,
        unavailableCount: 0,
        aiRestrictedCount: source.aiAllowed ? 0 : 1,
      },
      warnings: sourceCoverageNotices([source]),
    };
  }
  const note = data.notes.find((value) => value.id === candidate.objectId);
  if (
    !note ||
    note.kind !== candidate.kind ||
    !searchItemEligible(note, request) ||
    (note.contentRevision ?? 0) !== candidate.revision ||
    note.updatedAt !== candidate.updatedAt
  )
    throw new SearchBoundaryError();
  const blocks = knowledgeBlocks(note.content);
  const block =
    candidate.blockId === null
      ? undefined
      : blocks.find((value) => value.id === candidate.blockId && value.text.trim());
  if (candidate.blockId !== null && !block)
    throw new SearchBoundaryError("笔记正文位置已改变，请重新搜索。");
  const provenance = noteProvenance(data, note);
  return {
    ...candidate,
    id: JSON.stringify([note.kind, note.id, candidate.revision, note.updatedAt, candidate.blockId]),
    title: note.title,
    snippet: snippet(block?.text ?? blocks.map((value) => value.text).join("\n"), request.query),
    tags: [],
    spaceIds: note.spaceId === "inbox" ? [] : [note.spaceId],
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    draft: note.status === "draft",
    locator: block
      ? { kind: "note-block", start: block.start, end: block.end }
      : { kind: "metadata" },
    provenance,
    warnings: [
      ...(provenance.unavailableCount
        ? ["部分引用来源已删除、缺失或无法核对；此处仍保留你已保存的笔记文字。"]
        : []),
      ...(provenance.historicalCount ? ["部分引用指向历史版本，不代表来源当前内容。"] : []),
      ...(provenance.aiRestrictedCount
        ? ["引用包含已禁用 AI 使用的资料，普通搜索和阅读仍可使用。"]
        : []),
      ...(note.status === "draft" ? ["待审核草稿，不作为未来 AI 问答依据。"] : []),
    ],
  };
}

/** Local keyword search is independent of AI consent; it never invokes embeddings or a model. */
export function searchWorkspace(data: WorkspaceData, input: SearchRequest): SearchResult {
  const request = validateSearchRequest(data, input);
  const candidates: SearchCandidate[] = [];
  for (const source of data.sources) {
    if (!searchItemEligible(source, request)) continue;
    const blocks = source.chunks.filter(
      (chunk) =>
        chunk.sourceId === source.id &&
        chunk.versionId === source.versionId &&
        !!chunk.text.trim() &&
        source.text.includes(chunk.text),
    );
    const metadataScore = rank(request.query, source.title, source.tags, "");
    for (const block of blocks) {
      const score = rank(request.query, source.title, source.tags, block.text);
      if (score)
        candidates.push({
          kind: "source",
          objectId: source.id,
          versionId: source.versionId,
          blockId: block.id,
          score,
        });
    }
    if (!blocks.length && metadataScore)
      candidates.push({
        kind: "source",
        objectId: source.id,
        versionId: source.versionId,
        blockId: null,
        score: metadataScore,
      });
  }
  for (const note of data.notes) {
    if (!searchItemEligible(note, request)) continue;
    const blocks = knowledgeBlocks(note.content).filter((block) => block.text.trim());
    for (const block of blocks) {
      const score = rank(request.query, note.title, [], block.text);
      if (score)
        candidates.push({
          kind: note.kind,
          objectId: note.id,
          revision: note.contentRevision ?? 0,
          updatedAt: note.updatedAt,
          blockId: block.id,
          score,
        });
    }
    const score = rank(request.query, note.title, [], "");
    if (!blocks.length && score)
      candidates.push({
        kind: note.kind,
        objectId: note.id,
        revision: note.contentRevision ?? 0,
        updatedAt: note.updatedAt,
        blockId: null,
        score,
      });
  }
  const sorted = bestPerObject(candidates);
  const limit = request.limit ?? 30;
  return {
    query: request.query,
    scope: request.scope,
    hits: sorted.slice(0, limit).map((candidate) => canonical(data, request, candidate)),
    total: sorted.length,
    hasMore: sorted.length > limit,
  };
}

function bestPerObject<T extends SearchCandidate>(candidates: T[]): T[] {
  const unique = new Map<string, T>();
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.kind, candidate.objectId]);
    const previous = unique.get(key);
    if (!previous || candidate.score > previous.score) unique.set(key, candidate);
  }
  return [...unique.values()].sort(
    (a, b) =>
      b.score - a.score || a.kind.localeCompare(b.kind) || a.objectId.localeCompare(b.objectId),
  );
}

/** RPC adapters supply identities/ranks only. Titles, excerpts and provenance are rebuilt locally.
 * The server must authenticate and filter before returning candidates; this is a second boundary check.
 */
export function materializeSearchCandidates(
  data: WorkspaceData,
  input: SearchRequest,
  values: unknown,
): SearchResult {
  const request = validateSearchRequest(data, input);
  const parsed = searchCandidatesSchema.safeParse(values);
  if (!parsed.success) throw new SearchBoundaryError("搜索服务返回了无效的片段标识，请重新搜索。");
  // Validate every row before limiting; a stale/out-of-scope row must not disappear behind truncation.
  const hits = bestPerObject(parsed.data.map((candidate) => canonical(data, request, candidate)));
  const limit = request.limit ?? 30;
  return {
    query: request.query,
    scope: request.scope,
    hits: hits.slice(0, limit),
    total: null,
    hasMore: hits.length > limit,
  };
}
