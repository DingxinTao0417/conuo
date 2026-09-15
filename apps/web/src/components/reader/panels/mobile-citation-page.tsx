"use client";
import type { RefObject } from "react";
import { ChevronLeft, FileText } from "lucide-react";
import type { Citation, Source } from "@/lib/types";

export type MobileCitationPageProps = {
  focusedCitation: Citation;
  citationError: string;
  source: Source;
  citationReturnButton: RefObject<HTMLButtonElement | null>;
  setMobileTab: (tab: "reading" | "ai" | "citation") => void;
  openCitationSource: () => void;
  focusAiInput: () => void;
};

export default function MobileCitationPage({
  focusedCitation,
  citationError,
  source,
  citationReturnButton,
  setMobileTab,
  openCitationSource,
  focusAiInput,
}: MobileCitationPageProps) {
  return (
    <section
      className="reader-mobile-citation-page"
      aria-label="引用原文"
      aria-labelledby="reader-mobile-citation-title"
    >
      <header className="reader-mobile-citation-header">
        <button
          type="button"
          className="icon-btn"
          aria-label="返回回答"
          ref={citationReturnButton}
          onClick={() => setMobileTab("ai")}
        >
          <ChevronLeft size={18} />
        </button>
        <div>
          <span>引用原文</span>
          <strong id="reader-mobile-citation-title">{focusedCitation.title}</strong>
        </div>
        <button
          type="button"
          className="reader-mobile-citation-open-source"
          aria-label="打开完整原文"
          onClick={openCitationSource}
        >
          打开原文
        </button>
      </header>
      <div className="reader-mobile-citation-scroll">
        <p className="reader-mobile-citation-location">
          <FileText size={15} />
          {focusedCitation.page
            ? `第 ${focusedCitation.page} 页`
            : focusedCitation.section || "当前阅读位置"}
        </p>
        <article
          className={`reader-mobile-citation-excerpt ${
            citationError ? "reader-mobile-citation-excerpt-warning" : ""
          }`}
        >
          <span>原文摘录</span>
          <blockquote>{focusedCitation.quote}</blockquote>
          {citationError ? (
            <p role="status">{citationError}</p>
          ) : focusedCitation.sourceId === source.id &&
            focusedCitation.versionId === source.versionId ? (
            <p>已在阅读区定位到该位置；可查看上下文或返回回答继续追问。</p>
          ) : (
            <p>这段原文来自另一份资料；可打开原文，或返回回答继续追问。</p>
          )}
        </article>
      </div>
      <footer className="reader-mobile-citation-footer">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setMobileTab("ai");
            focusAiInput();
          }}
        >
          继续追问
        </button>
        <button type="button" className="btn" onClick={() => setMobileTab("ai")}>
          <ChevronLeft size={15} />
          返回回答
        </button>
      </footer>
    </section>
  );
}
