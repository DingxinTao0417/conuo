import type {
  ProcessingStatus,
  Source,
  SourceCoverage,
  SourcePageRange,
  SourceVersion,
} from "./types";

type CoverageSource = Pick<
  Source,
  "kind" | "status" | "coverage" | "webSnapshot" | "pageCount" | "parsedPages"
>;

function parseStateFromLegacyStatus(source: CoverageSource): SourceCoverage["parseState"] {
  switch (source.status) {
    case "saved":
    case "parsing":
      return "pending";
    case "partial":
      return "partial";
    case "failed":
      return "failed";
    case "link-only":
      return "not-requested";
    default:
      return "complete";
  }
}

/**
 * Reads new structured provenance while keeping older local/cloud snapshots
 * truthful. In particular, legacy web selections used `partial` as a UI
 * shortcut; that was never a parsing failure and must not be presented as one.
 */
export function sourceCoverageOf(source: CoverageSource | SourceVersion): SourceCoverage {
  if (source.coverage) return source.coverage;
  const snapshotScope = source.webSnapshot?.scope;
  if (snapshotScope === "selection") return { captureScope: "selection", parseState: "complete" };
  if (snapshotScope === "link" || source.status === "link-only")
    return { captureScope: "link", parseState: "not-requested" };
  if (snapshotScope === "pasted")
    return { captureScope: "manual", parseState: parseStateFromLegacyStatus(source) };
  return { captureScope: "full", parseState: parseStateFromLegacyStatus(source) };
}

export function isParserCoverageIncomplete(source: CoverageSource | SourceVersion) {
  const state = sourceCoverageOf(source).parseState;
  return state === "partial" || state === "failed";
}

export function formatUnavailablePageRanges(ranges: SourcePageRange[] | undefined) {
  if (!ranges?.length) return "";
  return ranges
    .map(({ start, end }) => (start === end ? `${start}` : `${start}–${end}`))
    .join("、");
}

/** A learner-facing, source-specific note about intentionally retained scope. */
export function sourceCaptureScopeNotice(source: CoverageSource | SourceVersion) {
  switch (sourceCoverageOf(source).captureScope) {
    case "selection":
      return "仅保存了用户选取的网页片段；检索与问答只依据这段文字，不代表整篇网页。";
    case "manual":
      return "这份网页由手动粘贴内容建立；检索与问答只依据已保存的文字。";
    case "link":
      return "仅保存了链接，未保存可检索正文。";
    default:
      return "";
  }
}

/** A learner-facing, source-specific note about actual parsing gaps. */
export function sourceParserCoverageNotice(source: CoverageSource | SourceVersion) {
  const coverage = sourceCoverageOf(source);
  if (coverage.parseState === "partial") {
    const pages = formatUnavailablePageRanges(coverage.unavailablePageRanges);
    return pages
      ? `原文件第 ${pages} 页未能解析；检索与问答只依据已提取文字。`
      : "原文件部分内容未能解析；检索与问答只依据已提取文字。";
  }
  if (coverage.parseState === "failed") return "原文件未提取到可检索文字。";
  if (coverage.parseState === "pending") return "资料仍在解析，暂时不能保证正文覆盖范围。";
  return "";
}

/** Short label for library lists, reader headers and source pickers. */
export function sourceCoverageLabel(source: CoverageSource | SourceVersion) {
  const coverage = sourceCoverageOf(source);
  if (coverage.captureScope === "selection") return "仅保存选段";
  if (coverage.captureScope === "manual") return "手动保存内容";
  if (coverage.captureScope === "link") return "仅保存链接";
  if (coverage.parseState === "partial") return "部分内容已解析";
  if (coverage.parseState === "failed") return "未提取正文";
  if (coverage.parseState === "pending") return "等待解析";
  return "";
}

/**
 * Maps legacy status shortcuts to the truthful visual state. This only affects
 * presentation: persisted legacy records remain byte-for-byte unchanged until
 * they are deliberately replaced with a new source version.
 */
export function sourcePresentationStatus(source: CoverageSource | SourceVersion): ProcessingStatus {
  const coverage = sourceCoverageOf(source);
  if (coverage.captureScope === "link") return "link-only";
  switch (coverage.parseState) {
    case "complete":
      return "ready";
    case "partial":
      return "partial";
    case "failed":
      return "failed";
    case "pending":
      return source.status === "parsing" ? "parsing" : "saved";
    default:
      return "link-only";
  }
}

/**
 * Compact, prompt-safe coverage notes for retrieval and model grounding. The
 * wording deliberately distinguishes a learner's saved scope from a parser
 * failure so the model does not overstate either kind of limitation.
 */
export function sourceCoverageNotices(sources: Array<CoverageSource | SourceVersion>) {
  const captures = new Set<string>();
  let hasPending = false;
  let hasPartial = false;
  let hasFailed = false;
  for (const source of sources) {
    const coverage = sourceCoverageOf(source);
    if (coverage.captureScope === "selection") captures.add("selection");
    if (coverage.captureScope === "manual") captures.add("manual");
    if (coverage.captureScope === "link") captures.add("link");
    if (coverage.parseState === "pending") hasPending = true;
    if (coverage.parseState === "partial") hasPartial = true;
    if (coverage.parseState === "failed") hasFailed = true;
  }
  return [
    captures.has("selection")
      ? "范围说明：其中的网页仅保存了用户选取的片段；回答只依据已保存片段，不代表整篇网页。"
      : "",
    captures.has("manual") ? "范围说明：其中的网页由手动粘贴内容建立；回答只依据已保存文字。" : "",
    captures.has("link") ? "其中有仅保存链接的资料，未作为正文证据使用。" : "",
    hasPending ? "有资料仍在解析，未作为正文证据使用。" : "",
    hasPartial ? "部分原文件内容未能解析；回答只依据已提取文字。" : "",
    hasFailed ? "有资料未提取到可检索文字，未作为正文证据使用。" : "",
  ].filter(Boolean);
}
