"use client";
import { X } from "lucide-react";
import type { Citation } from "@/lib/types";

export type CitationPreviewPanelProps = {
  focusedCitation: Citation;
  citationError: string;
  setFocusedCitation: (citation: Citation | null) => void;
  setCitationError: (message: string) => void;
};

export default function CitationPreviewPanel({
  focusedCitation,
  citationError,
  setFocusedCitation,
  setCitationError,
}: CitationPreviewPanelProps) {
  return (
    <div
      className={`reader-citation-target ${citationError ? "reader-citation-warning" : ""}`}
      role="status"
    >
      <div>
        <strong>
          引用原文 · {focusedCitation.title}
          {focusedCitation.page
            ? ` · 第 ${focusedCitation.page} 页`
            : ` · ${focusedCitation.section}`}
        </strong>
        <blockquote>{focusedCitation.quote}</blockquote>
        {citationError && <p>{citationError}</p>}
      </div>
      <button
        className="icon-btn"
        aria-label="关闭引用定位"
        onClick={() => {
          setFocusedCitation(null);
          setCitationError("");
        }}
      >
        <X size={15} />
      </button>
    </div>
  );
}
