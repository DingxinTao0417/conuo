"use client";
import type { RefObject } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Cloud,
  Columns2,
  Download,
  FileUp,
  History,
  LoaderCircle,
  MapPin,
  MoreHorizontal,
  RotateCcw,
  Search,
  Sparkles,
} from "lucide-react";
import type { SaveState, Source, Space } from "@/lib/types";
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
  searchOpen: boolean;
  sourceActionsOpen: boolean;
  sourceActions: RefObject<HTMLDivElement | null>;
  sourceActionsToggle: RefObject<HTMLButtonElement | null>;
  onBack: () => void;
  onStartComparison: ReaderProps["onStartComparison"];
  onRefreshWeb: ReaderProps["onRefreshWeb"];
  onReplaceFile: ReaderProps["onReplaceFile"];
  download: () => Promise<void>;
  openAiPanel: () => void;
  closeAiPanel: () => void;
  isCompactReaderLayout: () => boolean;
  toggleDocumentSearch: (trigger: HTMLButtonElement) => void;
  panels: ReaderPanels;
};

/**
 * The reader's global bar: where the learner came from, what they are reading,
 * whether it is saved, and four controls — back, find, Ask AI and more.
 *
 * Reading tools deliberately live in the tool strip inside the document
 * instead, because half of them only apply to one format. Keeping them here
 * meant every non-PDF source showed the same bar with holes in it, and the
 * control count changed with the file type.
 */
export default function ReaderTopbar(props: ReaderTopbarProps) {
  const {
    aiOpen,
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
    panels,
    searchOpen,
    source,
    sourceActions,
    sourceActionsOpen,
    sourceActionsToggle,
    space,
    toggleDocumentSearch,
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
      <button
        type="button"
        className="icon-btn reader-find-action"
        data-reader-search-trigger
        aria-label="查找原文"
        aria-controls="reader-find-panel"
        aria-expanded={searchOpen}
        title="搜索文内"
        onClick={(event) => toggleDocumentSearch(event.currentTarget)}
      >
        <Search size={16} />
      </button>
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
            {props.onStartComparison && (
              <button
                type="button"
                className="reader-source-action-item"
                aria-label="选择资料进行对照阅读"
                title="选择同一知识库中的另一份资料并排阅读"
                onClick={() => {
                  panels.close();
                  props.onStartComparison?.();
                }}
              >
                <Columns2 size={16} aria-hidden="true" />
                对照阅读
              </button>
            )}
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
