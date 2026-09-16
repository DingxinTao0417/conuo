"use client";
import type { ReactNode, RefObject } from "react";
import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronRight,
  Cloud,
  Columns2,
  Crop,
  Download,
  FileText,
  FileUp,
  Highlighter,
  History,
  LoaderCircle,
  MapPin,
  MoreHorizontal,
  RotateCcw,
  Search,
  Sparkles,
} from "lucide-react";
import type { Annotation, SaveState, Source, Space } from "@/lib/types";
import type { ReaderOutlineItem } from "../reader-outline";
import { sourcePresentationStatus } from "@/lib/source-coverage";
import { sourceStatusLabel } from "./reader-constants";
import type { ReaderPanels } from "./hooks/use-reader-panels";
import type { ReaderProps } from "./reader-types";

export type ReaderTopbarProps = {
  source: Source;
  space: Space;
  backLabel: string;
  contextualBackLabel: string | undefined;
  historical: boolean;
  saveState: SaveState | undefined;
  saveLabel: string | undefined;
  mobileReadingStatus: string;
  mobileTab: "reading" | "ai" | "citation";
  aiOpen: boolean;
  showText: boolean;
  outlineOpen: boolean;
  outlineItems: ReaderOutlineItem[];
  searchOpen: boolean;
  annotationOpen: boolean;
  sourceAnnotations: Annotation[];
  sourceActionsOpen: boolean;
  sourceActions: RefObject<HTMLDivElement | null>;
  sourceActionsToggle: RefObject<HTMLButtonElement | null>;
  regionCaptureActive: boolean;
  regionStudyBlockedMessage: string;
  onBack: () => void;
  onStartComparison: ReaderProps["onStartComparison"];
  onRefreshWeb: ReaderProps["onRefreshWeb"];
  onReplaceFile: ReaderProps["onReplaceFile"];
  download: () => Promise<void>;
  openAiPanel: () => void;
  closeAiPanel: () => void;
  isCompactReaderLayout: () => boolean;
  pdfReadingModeControls: () => ReactNode;
  toggleOutline: (trigger: HTMLButtonElement) => void;
  togglePdfText: () => void;
  toggleDocumentSearch: (trigger: HTMLButtonElement) => void;
  toggleRegionCapture: () => void;
  setNotice: (notice: string) => void;
  panels: ReaderPanels;
};

export default function ReaderTopbar(props: ReaderTopbarProps) {
  const {
    aiOpen,
    annotationOpen,
    backLabel,
    closeAiPanel,
    contextualBackLabel,
    download,
    historical,
    isCompactReaderLayout,
    mobileReadingStatus,
    mobileTab,
    onBack,
    openAiPanel,
    outlineItems,
    outlineOpen,
    panels,
    pdfReadingModeControls,
    regionCaptureActive,
    regionStudyBlockedMessage,
    searchOpen,
    showText,
    source,
    sourceActions,
    sourceActionsOpen,
    sourceActionsToggle,
    sourceAnnotations,
    space,
    toggleDocumentSearch,
    toggleOutline,
    togglePdfText,
    toggleRegionCapture,
  } = props;
  return (
    <header className="reader-topbar">
      <button
        className={`icon-btn reader-back-button${
          contextualBackLabel ? " reader-back-button-context" : ""
        }`}
        aria-label={backLabel}
        title={backLabel}
        onClick={onBack}
      >
        <ArrowLeft size={18} aria-hidden="true" />
        {contextualBackLabel && <span>{contextualBackLabel}</span>}
      </button>
      <div className="reader-breadcrumb">
        <span>{space.name}</span>
        <ChevronRight size={13} />
        <strong title={source.title}>{source.title}</strong>
        <span
          className="reader-mobile-reading-meta"
          aria-label={`阅读状态：${mobileReadingStatus}`}
        >
          {mobileReadingStatus}
        </span>
      </div>
      <span
        className={`reader-status ${sourcePresentationStatus(source) === "ready" ? "reader-status-ready" : ""}`}
      >
        {historical ? "历史版本 · 只读" : sourceStatusLabel(source)}
      </span>
      {props.saveState && props.saveLabel && (
        <span className={`reader-save-status reader-save-${props.saveState}`} role="status">
          {props.saveState === "saving" || props.saveState === "loading" ? (
            <LoaderCircle size={14} className="spin" />
          ) : props.saveState === "cloud" ? (
            <Cloud size={14} />
          ) : props.saveState === "local" ? (
            <Check size={14} />
          ) : (
            <History size={14} />
          )}
          <span>{props.saveLabel}</span>
        </span>
      )}
      <div className="reader-desktop-topbar-tools" role="group" aria-label="阅读工具">
        {source.kind === "pdf" && !showText && pdfReadingModeControls()}
        {outlineItems.length > 0 && (
          <button
            type="button"
            className="icon-btn"
            data-reader-outline-trigger
            aria-label={`打开资料目录（${outlineItems.length} 项）`}
            aria-controls="reader-outline-panel"
            aria-expanded={outlineOpen}
            title="资料目录"
            onClick={(event) => toggleOutline(event.currentTarget)}
          >
            <BookOpen size={16} />
          </button>
        )}
        {source.kind === "pdf" && (
          <button
            type="button"
            className="icon-btn"
            aria-label={showText ? "查看原始 PDF" : "查看解析文本"}
            aria-pressed={showText}
            title={showText ? "查看原始 PDF" : "查看解析文本"}
            onClick={togglePdfText}
          >
            <FileText size={16} />
          </button>
        )}
        {source.kind === "pdf" && !showText && (
          <button
            type="button"
            className="icon-btn"
            data-reader-region-trigger
            aria-label={regionCaptureActive ? "取消区域框选" : "框选区域交给 AI"}
            aria-pressed={regionCaptureActive}
            title={regionStudyBlockedMessage || "区域视觉学习"}
            disabled={Boolean(regionStudyBlockedMessage)}
            onClick={toggleRegionCapture}
          >
            <Crop size={16} />
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          data-reader-search-trigger
          aria-label="查找原文"
          aria-controls="reader-find-panel"
          aria-expanded={searchOpen}
          title="页内搜索"
          onClick={(event) => toggleDocumentSearch(event.currentTarget)}
        >
          <Search size={16} />
        </button>
        <button
          type="button"
          className="icon-btn"
          data-reader-annotation-trigger
          aria-label={`我的标注（${sourceAnnotations.length}）`}
          aria-controls="reader-annotations-panel"
          aria-expanded={annotationOpen}
          title="我的标注"
          onClick={() => panels.toggle("annotations")}
        >
          <Highlighter size={16} />
        </button>
      </div>
      <div className="reader-source-actions" ref={sourceActions}>
        <button
          ref={sourceActionsToggle}
          type="button"
          className="icon-btn"
          aria-label="更多资料操作"
          aria-controls="reader-source-actions-menu"
          aria-expanded={sourceActionsOpen}
          title="更多资料操作"
          onClick={() => panels.toggle("source-actions")}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !sourceActionsOpen) return;
            event.preventDefault();
            panels.close();
          }}
        >
          <MoreHorizontal size={18} />
        </button>
        {sourceActionsOpen && (
          <div
            id="reader-source-actions-menu"
            className="reader-source-actions-menu"
            role="group"
            aria-label="资料操作"
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              panels.close();
              sourceActionsToggle.current?.focus();
            }}
          >
            <button
              type="button"
              className="reader-source-action-item"
              onClick={() => panels.openVersions("history")}
            >
              <History size={16} aria-hidden="true" />
              {source.kind === "web" ? "网页版本记录" : "资料版本记录"}
            </button>
            {!historical && (source.readingPositionAlternatives?.length ?? 0) > 0 && (
              <button
                type="button"
                className="reader-source-action-item"
                aria-label="已保留阅读位置"
                onClick={() => panels.open("positions")}
              >
                <MapPin size={16} aria-hidden="true" />
                已保留阅读位置（{source.readingPositionAlternatives?.length}）
              </button>
            )}
            {!historical && source.kind === "web" && props.onRefreshWeb && (
              <button
                type="button"
                className="reader-source-action-item"
                onClick={() => panels.openVersions("refresh")}
              >
                <RotateCcw size={16} aria-hidden="true" />
                刷新网页
              </button>
            )}
            {!historical && source.kind !== "web" && props.onReplaceFile && (
              <button
                type="button"
                className="reader-source-action-item"
                onClick={() => panels.openVersions("replace")}
              >
                <FileUp size={16} aria-hidden="true" />
                替换文件
              </button>
            )}
            <button
              type="button"
              className="reader-source-action-item"
              onClick={() => {
                panels.close();
                void download();
              }}
            >
              <Download size={16} aria-hidden="true" />
              下载原文件
            </button>
          </div>
        )}
      </div>
      {props.onStartComparison && (
        <button
          type="button"
          className="btn reader-compare-action"
          aria-label="选择资料进行对照阅读"
          title="选择同一知识库中的另一份资料并排阅读"
          onClick={props.onStartComparison}
        >
          <Columns2 size={15} />
          对照阅读
        </button>
      )}
      <button
        className="btn reader-ai-toggle"
        onClick={() => {
          if (isCompactReaderLayout()) {
            if (mobileTab === "ai") closeAiPanel();
            else openAiPanel();
          } else if (aiOpen) closeAiPanel();
          else openAiPanel();
        }}
      >
        <Sparkles size={15} />
        {historical ? "已有问答" : "问 AI"}
      </button>
    </header>
  );
}
