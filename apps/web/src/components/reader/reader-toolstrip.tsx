"use client";
import { useId, useRef, useState, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Crop,
  FileText,
  Highlighter,
  List,
  Minus,
  Plus,
  Settings2,
} from "lucide-react";
import type { Source } from "@/lib/types";
import type { ReaderOutlineItem } from "../reader-outline";
import type { ReaderPanel } from "./hooks/use-reader-panels";
import ReaderPageInput from "./reader-page-input";

export type ReaderToolstripProps = {
  source: Source;
  showText: boolean;
  page: number;
  pages: number;
  zoom: number;
  outlineItems: ReaderOutlineItem[];
  annotationCount: number;
  activePanel: ReaderPanel | null;
  regionCaptureActive: boolean;
  regionStudyBlockedMessage: string;
  pdfReadingModeControls: () => ReactNode;
  changePage: (value: number) => void;
  setZoom: (zoom: number) => void;
  togglePdfText: () => void;
  toggleRegionCapture: () => void;
  toggleOutline: (trigger: HTMLButtonElement) => void;
  toggleAnnotations: () => void;
};

const FORMAT_LABELS: Partial<Record<Source["kind"], string>> = { web: "网页快照" };

/**
 * The reading tools, in the document they act on.
 *
 * These controls used to sit in the global top bar, where a learner reading a
 * web clipping still met a row of conditionally rendered gaps left by the PDF
 * tools. Here the strip renders what the open format actually supports: page
 * position and framing only exist for PDFs, structure only appears for
 * documents that have any.
 *
 * Phones keep page navigation visible and expand reading settings on demand.
 * The strip remains in reach while scrolling, with explicit labels for tools.
 */
export default function ReaderToolstrip({
  source,
  showText,
  page,
  pages,
  zoom,
  outlineItems,
  annotationCount,
  activePanel,
  regionCaptureActive,
  regionStudyBlockedMessage,
  pdfReadingModeControls,
  changePage,
  setZoom,
  togglePdfText,
  toggleRegionCapture,
  toggleOutline,
  toggleAnnotations,
}: ReaderToolstripProps) {
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const toolsToggle = useRef<HTMLButtonElement>(null);
  const blockedHintId = useId();
  const pdf = source.kind === "pdf";
  const nativePdf = pdf && !showText;
  return (
    <div
      className="reader-document-tools"
      data-reader-document-tools
      data-tools-expanded={toolsExpanded}
      role="group"
      aria-label="阅读工具条"
    >
      <div
        className={`reader-tool-group ${
          pdf ? "reader-document-page-controls" : "reader-document-structure-controls"
        }`}
      >
        {pdf ? (
          <>
            <button
              className="icon-btn"
              aria-label="上一页"
              disabled={page <= 1 || showText}
              onClick={() => changePage(page - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <label className="reader-page-control">
              <ReaderPageInput
                page={page}
                pages={pages}
                sourceKey={`${source.id}:${source.versionId}`}
                disabled={showText}
                onCommit={changePage}
              />
              <span>/ {pages}</span>
            </label>
            <button
              className="icon-btn"
              aria-label="下一页"
              disabled={page >= pages || showText}
              onClick={() => changePage(page + 1)}
            >
              <ChevronRight size={16} />
            </button>
          </>
        ) : (
          <span className="reader-format">
            <FileText size={15} />
            {FORMAT_LABELS[source.kind] ?? source.kind.toUpperCase()}
          </span>
        )}
      </div>
      <div className="reader-tool-spacer" />
      <button
        ref={toolsToggle}
        type="button"
        className="reader-toolstrip-toggle"
        data-reader-toolstrip-toggle
        aria-controls="reader-toolstrip-tools"
        aria-expanded={toolsExpanded}
        aria-label={`${source.kind === "pdf" ? "PDF" : "资料"}阅读工具`}
        onClick={() => setToolsExpanded((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && toolsExpanded) {
            event.preventDefault();
            event.stopPropagation();
            setToolsExpanded(false);
          }
        }}
      >
        <Settings2 size={15} aria-hidden="true" />
        <span>{toolsExpanded ? "收起工具" : "阅读工具"}</span>
      </button>
      <div
        id="reader-toolstrip-tools"
        className="reader-toolstrip-tools"
        data-reader-toolstrip-tools
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !toolsExpanded || event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          setToolsExpanded(false);
          toolsToggle.current?.focus();
        }}
      >
        {nativePdf && pdfReadingModeControls()}
        <div className="reader-tool-group reader-document-zoom-controls" aria-label="缩放">
          <button
            className="icon-btn"
            aria-label="缩小"
            disabled={zoom <= 60}
            onClick={() => setZoom(Math.max(60, zoom - 10))}
          >
            <Minus size={15} />
          </button>
          <button className="reader-zoom" title="恢复默认缩放" onClick={() => setZoom(100)}>
            {zoom}%
          </button>
          <button
            className="icon-btn"
            aria-label="放大"
            disabled={zoom >= 200}
            onClick={() => setZoom(Math.min(200, zoom + 10))}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="reader-toolstrip-actions">
          {pdf && (
            <button className="reader-tool-text" aria-pressed={showText} onClick={togglePdfText}>
              <FileText size={15} aria-hidden="true" />
              {showText ? "原始 PDF" : "解析文本"}
            </button>
          )}
          {nativePdf && (
            <button
              type="button"
              className="reader-tool-text reader-region-trigger"
              data-reader-region-trigger
              aria-label={regionCaptureActive ? "取消区域框选" : "框选区域交给 AI"}
              aria-pressed={regionCaptureActive}
              title={regionStudyBlockedMessage || "区域视觉学习"}
              disabled={Boolean(regionStudyBlockedMessage)}
              aria-describedby={regionStudyBlockedMessage ? blockedHintId : undefined}
              onClick={toggleRegionCapture}
            >
              <Crop size={14} aria-hidden="true" />
              <span>{regionCaptureActive ? "取消框选" : "区域学习"}</span>
            </button>
          )}
          {outlineItems.length > 0 && (
            <button
              type="button"
              className="reader-tool-text reader-outline-trigger"
              data-reader-outline-trigger
              aria-label={`打开资料目录（${outlineItems.length} 项）`}
              aria-controls="reader-outline-panel"
              aria-expanded={activePanel === "outline"}
              onClick={(event) => {
                toggleOutline(event.currentTarget);
                setToolsExpanded(false);
                if (toolsExpanded) toolsToggle.current?.focus();
              }}
            >
              <List size={15} aria-hidden="true" />
              目录
            </button>
          )}
          <button
            className="reader-tool-text reader-annotation-trigger"
            data-reader-annotation-trigger
            aria-label={`我的标注（${annotationCount}）`}
            aria-controls="reader-annotations-panel"
            aria-expanded={activePanel === "annotations"}
            onClick={() => {
              toggleAnnotations();
              setToolsExpanded(false);
              if (toolsExpanded) toolsToggle.current?.focus();
            }}
          >
            <Highlighter size={15} aria-hidden="true" />
            <span>标注</span>
            {annotationCount > 0 && <span className="reader-tool-count">{annotationCount}</span>}
          </button>
        </div>
        {nativePdf && regionStudyBlockedMessage && (
          <p id={blockedHintId} className="reader-toolstrip-hint">
            区域学习：{regionStudyBlockedMessage}
          </p>
        )}
      </div>
    </div>
  );
}
