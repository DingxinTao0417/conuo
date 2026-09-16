"use client";
import { useState, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Crop,
  FileText,
  Highlighter,
  Minus,
  Plus,
  Settings2,
} from "lucide-react";
import type { Source } from "@/lib/types";
import type { ReaderOutlineItem } from "../reader-outline";
import type { ReaderPanel } from "./hooks/use-reader-panels";

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
 * Phones collapse the format-specific half behind one 工具 control so the
 * position and zoom the learner needs constantly keep their place at 360px;
 * narrower combinations (a tablet with the AI panel over it) scroll that half
 * horizontally rather than wrapping the strip into a second row.
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
              <input
                aria-label="跳转页码"
                type="number"
                min={1}
                max={pages}
                value={page}
                disabled={showText}
                onChange={(event) => changePage(Number(event.target.value))}
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
      <span className="reader-tool-divider reader-document-zoom-divider" />
      <div className="reader-tool-group reader-document-zoom-controls">
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
      <div className="reader-tool-spacer" />
      <button
        type="button"
        className="reader-toolstrip-toggle"
        data-reader-toolstrip-toggle
        aria-controls="reader-toolstrip-tools"
        aria-expanded={toolsExpanded}
        aria-label={`${source.kind === "pdf" ? "PDF" : "资料"}阅读工具`}
        onClick={() => setToolsExpanded((current) => !current)}
      >
        <Settings2 size={15} aria-hidden="true" />
        <span>工具</span>
      </button>
      <div
        id="reader-toolstrip-tools"
        className="reader-toolstrip-tools"
        data-reader-toolstrip-tools
      >
        {nativePdf && pdfReadingModeControls()}
        {pdf && (
          <button className="reader-tool-text" aria-pressed={showText} onClick={togglePdfText}>
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
            onClick={(event) => toggleOutline(event.currentTarget)}
          >
            目录
          </button>
        )}
        <button
          className="icon-btn"
          data-reader-annotation-trigger
          aria-label={`我的标注（${annotationCount}）`}
          aria-controls="reader-annotations-panel"
          aria-expanded={activePanel === "annotations"}
          onClick={toggleAnnotations}
        >
          <Highlighter size={16} />
        </button>
      </div>
    </div>
  );
}
