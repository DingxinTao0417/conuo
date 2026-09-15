import { sourcePresentationStatus } from "./source-coverage";
import type { Source, SourceKind } from "./types";

const kindLabels: Record<SourceKind, string> = {
  pdf: "PDF",
  docx: "DOCX",
  markdown: "Markdown",
  text: "TXT",
  web: "网页",
};

const webScopeLabels = {
  article: "网页正文",
  selection: "网页选段",
  pasted: "手动粘贴的网页正文",
  link: "网页链接",
} as const;

export function sourceKindLabel(source: Pick<Source, "kind">): string {
  return kindLabels[source.kind];
}

export function sourceOriginLabel(source: Pick<Source, "kind" | "url" | "webSnapshot">): string {
  if (source.kind !== "web") return "本机文件上传";
  return source.webSnapshot ? webScopeLabels[source.webSnapshot.scope] : "网页";
}

export function sourceReadingStatus(
  source: Pick<Source, "kind" | "lastReadAt" | "readPage" | "readOffset" | "pageCount">,
): string {
  if (!source.lastReadAt) return "未开始阅读";
  if (source.kind === "pdf" && source.pageCount) {
    const page = Math.min(Math.max(source.readPage || 1, 1), source.pageCount);
    return `上次读到第 ${page} / ${source.pageCount} 页`;
  }
  if ((source.readOffset || 0) > 0) return "已记录正文阅读位置";
  return "已开始阅读";
}

export function sourceAiStatus(
  source: Pick<
    Source,
    "aiAllowed" | "status" | "coverage" | "kind" | "text" | "chunks" | "pageCount"
  >,
): string {
  if (!source.aiAllowed) return "未允许 AI 使用";
  switch (sourcePresentationStatus(source)) {
    case "ready":
      return "已允许，可用于问答与整理";
    case "partial":
      return "已允许，可使用已识别部分";
    case "saved":
    case "parsing":
      return "已允许，等待正文处理完成";
    default:
      return "已允许，但当前没有可用正文";
  }
}

export function sourceTimestampLabel(value: string): string {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return "时间未知";
  return instant.toLocaleString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
