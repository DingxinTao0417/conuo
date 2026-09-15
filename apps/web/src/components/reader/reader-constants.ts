import { askScopeLabels, readerAskScopes } from "@/lib/ask-scopes";
import { sourceCoverageLabel, sourcePresentationStatus } from "@/lib/source-coverage";
import type {
  AnswerNoteEvidence,
  Note,
  ReadingPositionAlternative,
  Scope,
  Source,
} from "@/lib/types";

// The reader's own ranges share names with their server scopes, so these two
// exports stay a thin projection of the shared list in lib/ask-scopes.
export const scopeLabels: Record<Scope, string> = {
  selection: askScopeLabels.selection,
  document: askScopeLabels.document,
  "document-notes": askScopeLabels["document-notes"],
  sources: askScopeLabels.sources,
  space: askScopeLabels.space,
  "cross-library-sources": askScopeLabels["cross-library"],
};
export const readerScopeOptions = readerAskScopes as Exclude<Scope, "cross-library-sources">[];
export const statuses: Record<Source["status"], string> = {
  saved: "已保存 · 待解析",
  parsing: "正在解析",
  ready: "正文已就绪",
  partial: "部分正文已就绪",
  failed: "解析未完成",
  "link-only": "仅保存链接",
};

export function sourceStatusLabel(source: Source) {
  return sourceCoverageLabel(source) || statuses[sourcePresentationStatus(source)];
}

export const answerPhases = {
  retrieving: "正在查找原文依据…",
  generating: "正在整理回答…",
  validating: "正在核对引用并确认回答…",
};
/**
 * These prompts intentionally stay generic. A follow-up only pre-fills the
 * composer, so the learner can revise it and the next request still uses the
 * visible, current scope rather than silently expanding the answer context.
 */
export const FOLLOW_UP_PROMPTS = ["换个说法解释", "结合当前资料举个例子"] as const;
export const READING_ACTIVITY_THROTTLE_MS = 15_000;
export const READING_OPEN_SETTLE_MS = 1_500;
export const readingPositionOriginLabels: Record<ReadingPositionAlternative["origin"], string> = {
  local: "本机位置",
  remote: "云端位置",
  previous: "先前选择",
};

export function readingPositionSummary(
  progress: Pick<Source, "readPage" | "readOffset">,
  sourceKind: Source["kind"],
): string {
  if (sourceKind === "pdf" && progress.readPage !== undefined)
    return `第 ${Math.max(1, Math.round(progress.readPage))} 页`;
  if (progress.readOffset !== undefined)
    return `正文偏移 ${Math.max(0, Math.round(progress.readOffset))} 像素`;
  if (progress.readPage !== undefined) return `第 ${Math.max(1, Math.round(progress.readPage))} 页`;
  return "资料开头";
}

export function readingPositionMetrics(progress: Pick<Source, "readPage" | "readOffset">): string {
  const page =
    progress.readPage === undefined
      ? "未记录"
      : `第 ${Math.max(1, Math.round(progress.readPage))} 页`;
  const offset =
    progress.readOffset === undefined
      ? "未记录"
      : `${Math.max(0, Math.round(progress.readOffset))} 像素`;
  return `页码：${page} · 正文偏移：${offset}`;
}

export function readingPositionTime(lastReadAt: string | undefined): string {
  if (!lastReadAt) return "记录时间：未记录";
  const parsed = new Date(lastReadAt);
  return `记录时间：${Number.isNaN(parsed.getTime()) ? lastReadAt : parsed.toLocaleString("zh-CN")}`;
}

// Native stylesheets preserve the Custom Highlight API syntax that the current
// build-time CSS parser does not yet recognize. Range registration stays below.
export const highlightStyles =
  "::highlight(reader-annotation){background:#ffdf7475;color:inherit}::highlight(reader-citation){background:#bdb1ff99;color:inherit}::highlight(reader-search){background:#fef3c7;color:inherit}::highlight(reader-search-current){background:#fbbf2499;color:inherit}";

export const EMPTY_NOTE_EVIDENCE: AnswerNoteEvidence[] = [];
export const EMPTY_NOTES: Note[] = [];
