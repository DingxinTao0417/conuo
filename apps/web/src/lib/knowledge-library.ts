import type { Note, Space, WorkspaceData } from "./types";
import type { KnowledgeLibraryFilter } from "./workspace-section-route";
export type KnowledgePageStatusLabel = "AI 草稿" | "人工草稿" | "已保存";

export interface KnowledgeLibraryItem {
  note: Note;
  status: Exclude<KnowledgeLibraryFilter, "all">;
  statusLabel: KnowledgePageStatusLabel;
  associatedSourceCount: number;
  summary: string;
}

export interface KnowledgeLibraryGroup {
  id: string;
  name: string;
  space: Space | null;
  items: KnowledgeLibraryItem[];
}

export type KnowledgeLibraryCounts = Record<KnowledgeLibraryFilter, number>;

export interface KnowledgeLibraryView {
  counts: KnowledgeLibraryCounts;
  groups: KnowledgeLibraryGroup[];
  resultCount: number;
}

export interface KnowledgeLibraryOptions {
  /** `all` includes knowledge pages from every current or historical space. */
  spaceId?: string;
  query?: string;
  filter?: KnowledgeLibraryFilter;
}

type IndexedKnowledgeItem = KnowledgeLibraryItem & { sourceIndex: number };

const EMPTY_SUMMARY = "还没有正文，开始整理这个主题。";
const DEFAULT_SUMMARY_LIMIT = 132;

function plainText(value: string): string {
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, " ")
    .replace(/<br\s*\/?>/giu, " ")
    .replace(/<\/(?:blockquote|div|h[1-6]|li|ol|p|pre|table|tr|ul)>/giu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizedSearch(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function itemStatus(note: Note): Exclude<KnowledgeLibraryFilter, "all"> {
  return note.status === "draft" ? "pending" : "saved";
}

export function knowledgePageStatusLabel(note: Note): KnowledgePageStatusLabel {
  if (note.status === "accepted") return "已保存";
  return note.aiGenerated ? "AI 草稿" : "人工草稿";
}

export function knowledgePageAssociatedSourceCount(note: Note): number {
  return new Set(note.citations.map((citation) => citation.sourceId)).size;
}

export function knowledgePageSummary(
  note: Pick<Note, "content">,
  limit = DEFAULT_SUMMARY_LIMIT,
): string {
  const content = plainText(note.content);
  if (!content) return EMPTY_SUMMARY;
  if (!Number.isSafeInteger(limit) || limit < 1) return EMPTY_SUMMARY;

  const characters = Array.from(content);
  if (characters.length <= limit) return content;
  return `${characters.slice(0, limit).join("").trimEnd()}…`;
}

function matchesQuery(note: Note, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const searchable = [
    note.title,
    plainText(note.content),
    ...note.citations.map((citation) => `${citation.title} ${citation.quote}`),
  ].join("\n");
  return normalizedSearch(searchable).includes(normalizedQuery);
}

function compareByLatestUpdate(left: IndexedKnowledgeItem, right: IndexedKnowledgeItem): number {
  const byUpdatedAt = timestamp(right.note.updatedAt) - timestamp(left.note.updatedAt);
  return byUpdatedAt || left.sourceIndex - right.sourceIndex;
}

function groupName(spaceId: string, space: Space | undefined): string {
  if (space) return space.name;
  if (spaceId === "inbox" || !spaceId) return "未归入知识库";
  return "其他知识页";
}

/**
 * Builds the complete, local-only P06 library projection. Counts reflect the
 * current space and search query before the selected status is applied, so a
 * learner can see which other status contains matching pages.
 */
export function selectKnowledgeLibrary(
  data: WorkspaceData,
  options: KnowledgeLibraryOptions = {},
): KnowledgeLibraryView {
  const spaceId = options.spaceId ?? "all";
  const filter = options.filter ?? "all";
  const normalizedQuery = normalizedSearch(options.query?.trim() ?? "");
  const items = data.notes
    .map((note, sourceIndex): IndexedKnowledgeItem | null => {
      if (
        note.deletedAt ||
        note.kind !== "knowledge" ||
        (spaceId !== "all" && note.spaceId !== spaceId) ||
        !matchesQuery(note, normalizedQuery)
      )
        return null;

      return {
        note,
        sourceIndex,
        status: itemStatus(note),
        statusLabel: knowledgePageStatusLabel(note),
        associatedSourceCount: knowledgePageAssociatedSourceCount(note),
        summary: knowledgePageSummary(note),
      };
    })
    .filter((item): item is IndexedKnowledgeItem => item !== null);

  const pending = items.filter((item) => item.status === "pending").length;
  const counts: KnowledgeLibraryCounts = {
    all: items.length,
    pending,
    saved: items.length - pending,
  };
  const filteredItems = items.filter((item) => filter === "all" || item.status === filter);
  const itemsBySpace = new Map<string, IndexedKnowledgeItem[]>();
  for (const item of filteredItems) {
    const current = itemsBySpace.get(item.note.spaceId) ?? [];
    current.push(item);
    itemsBySpace.set(item.note.spaceId, current);
  }

  const knownSpaces = new Map(data.spaces.map((space) => [space.id, space]));
  const orderedGroupIds =
    spaceId === "all"
      ? [
          ...data.spaces.map((space) => space.id),
          ...[...itemsBySpace.keys()].filter((id) => !knownSpaces.has(id)),
        ]
      : [spaceId];
  const seen = new Set<string>();
  const groups: KnowledgeLibraryGroup[] = [];

  for (const id of orderedGroupIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const groupItems = itemsBySpace.get(id);
    if (!groupItems?.length) continue;
    const space = knownSpaces.get(id);
    groups.push({
      id,
      name: groupName(id, space),
      space: space ?? null,
      items: groupItems.sort(compareByLatestUpdate).map((item) => ({
        note: item.note,
        status: item.status,
        statusLabel: item.statusLabel,
        associatedSourceCount: item.associatedSourceCount,
        summary: item.summary,
      })),
    });
  }

  return { counts, groups, resultCount: filteredItems.length };
}
