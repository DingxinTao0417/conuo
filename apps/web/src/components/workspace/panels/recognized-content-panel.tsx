"use client";
import { FileText, ShieldCheck } from "lucide-react";
import type { Chunk, Citation, Source } from "@/lib/types";
import {
  sourceCaptureScopeNotice,
  sourceParserCoverageNotice,
  sourcePresentationStatus,
} from "@/lib/source-coverage";
import { sourceStatusLabel } from "../shared";

type RecognizedContentState = {
  tone: "ready" | "partial" | "pending" | "unavailable";
  title: string;
  description: string;
};

/**
 * Keeps source processing language consistent with the actual retrieval
 * contract. Saving bytes, extracting text, and permitting AI are deliberately
 * different states for a learner.
 */
function recognizedContentState(source: Source): RecognizedContentState {
  switch (sourcePresentationStatus(source)) {
    case "link-only":
      return {
        tone: "unavailable",
        title: "仅保存了链接",
        description: "没有保存可检索正文，因此暂时没有可打开的已识别片段。",
      };
    case "failed":
      return {
        tone: "unavailable",
        title: "未提取到可检索正文",
        description: "原文件仍可打开或下载，但暂时不能依据正文搜索、问答或整理。",
      };
    case "saved":
      return {
        tone: "pending",
        title: "原文件已保存，等待提取正文",
        description: "原件已经保留；完成文本提取和准备检索后，已识别片段会显示在这里。",
      };
    case "parsing":
      return {
        tone: "pending",
        title: "正在提取正文",
        description: "处理完成前不能保证正文覆盖范围，也不会把资料显示为已可用于 AI。",
      };
    case "partial":
      return {
        tone: "partial",
        title: "部分原文已识别",
        description: source.aiAllowed
          ? "下方只列出当前可用于搜索、问答和整理的原文片段。"
          : "下方只列出当前可用于阅读和关键词搜索的原文片段。",
      };
    default:
      return {
        tone: "ready",
        title: source.aiAllowed ? "原文已识别，可用于 AI" : "原文已识别",
        description: source.aiAllowed
          ? "可从下方片段进入原文，也可用于关键词搜索、问答和整理。"
          : "可从下方片段进入原文并进行关键词搜索。",
      };
  }
}

function recognizedChunkLocation(chunk: Chunk, index: number) {
  const section = chunk.section.replace(/\s+/g, " ").trim();
  if (chunk.page) return section ? `第 ${chunk.page} 页 · ${section}` : `第 ${chunk.page} 页`;
  return section || `已识别片段 ${index + 1}`;
}

function recognizedChunkPreview(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 220 ? `${normalized.slice(0, 220)}…` : normalized;
}

/**
 * One tab of the source detail panel: what of the original text is actually
 * available. Navigation and source actions belong to the panel's own header
 * and footer, so this renders only the coverage explanation and the excerpts.
 */
export default function RecognizedContentPanel({
  source,
  onOpenSource,
}: {
  source: Source;
  onOpenSource: (citation?: Citation) => void;
}) {
  const state = recognizedContentState(source);
  const presentationStatus = sourcePresentationStatus(source);
  const supportsKeywordSearch = presentationStatus === "ready" || presentationStatus === "partial";
  const chunks = source.chunks
    .filter(
      (chunk) =>
        chunk.sourceId === source.id &&
        chunk.versionId === source.versionId &&
        Boolean(chunk.text.trim()),
    )
    .sort((left, right) => left.order - right.order);
  const notices = [sourceCaptureScopeNotice(source), sourceParserCoverageNotice(source)].filter(
    Boolean,
  );

  return (
    <div className="recognized-content-panel">
      <section className={`recognized-content-status recognized-content-status-${state.tone}`}>
        <div>
          <span className="recognized-content-eyebrow">资料可用范围</span>
          <h3>{state.title}</h3>
          <p>{state.description}</p>
        </div>
        <span className="recognized-content-status-label">{sourceStatusLabel(source)}</span>
      </section>

      {!source.aiAllowed && (
        <p className="recognized-content-ai-off" role="status">
          <ShieldCheck size={15} aria-hidden="true" />
          <span>
            <strong>AI 使用已关闭。</strong>
            {supportsKeywordSearch
              ? "原文仍可阅读和关键词搜索，不会用于问答或整理。"
              : "当前没有可用于关键词搜索的正文，也不会用于问答或整理。"}
          </span>
        </p>
      )}

      {notices.length > 0 && (
        <div className="recognized-content-notices" role="status">
          {notices.map((notice) => (
            <p key={notice}>{notice}</p>
          ))}
        </div>
      )}

      <section className="recognized-content-list" aria-labelledby="recognized-content-title">
        <header>
          <div>
            <h3 id="recognized-content-title">已识别内容</h3>
            <p>
              {chunks.length
                ? `当前显示 ${chunks.length} 段可定位的原文。`
                : "当前没有可定位的已识别原文。"}
            </p>
          </div>
          {source.parsedPages !== undefined && source.pageCount !== undefined && (
            <span className="recognized-content-page-count">
              已提取 {source.parsedPages} / {source.pageCount} 页
            </span>
          )}
        </header>

        {chunks.length ? (
          <ol>
            {chunks.map((chunk, index) => {
              const location = recognizedChunkLocation(chunk, index);
              return (
                <li key={chunk.id}>
                  <button
                    type="button"
                    className="recognized-content-chunk"
                    onClick={() =>
                      onOpenSource({
                        sourceId: source.id,
                        versionId: source.versionId,
                        chunkId: chunk.id,
                        title: source.title,
                        quote: chunk.text,
                        page: chunk.page,
                        section: chunk.section.trim() || location,
                      })
                    }
                  >
                    <span>{location}</span>
                    <p>{recognizedChunkPreview(chunk.text)}</p>
                    <small>打开原文</small>
                  </button>
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="recognized-content-empty">
            <FileText size={18} aria-hidden="true" />
            <p>{state.description}</p>
          </div>
        )}
      </section>
    </div>
  );
}
