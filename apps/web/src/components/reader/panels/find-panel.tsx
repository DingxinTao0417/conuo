"use client";
import type { RefObject } from "react";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import type { Source } from "@/lib/types";
import type { ReaderSearchResult } from "../reader-types";

export type FindPanelProps = {
  search: string;
  searchResult: ReaderSearchResult | null;
  searchInput: RefObject<HTMLInputElement | null>;
  showText: boolean;
  source: Source;
  setSearch: (value: string) => void;
  clearSearchResults: () => void;
  closeDocumentSearch: () => void;
  findInDocument: (direction?: 1 | -1) => void;
};

export default function FindPanel({
  search,
  searchResult,
  searchInput,
  showText,
  source,
  setSearch,
  clearSearchResults,
  closeDocumentSearch,
  findInDocument,
}: FindPanelProps) {
  return (
    <form
      id="reader-find-panel"
      className="reader-find"
      onSubmit={(event) => {
        event.preventDefault();
        findInDocument();
      }}
    >
      <Search size={15} />
      <input
        ref={searchInput}
        aria-label="查找文字"
        placeholder={source.kind === "pdf" && !showText ? "在当前 PDF 页查找" : "在原文中查找"}
        value={search}
        onChange={(event) => {
          clearSearchResults();
          setSearch(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          findInDocument(event.shiftKey ? -1 : 1);
        }}
      />
      <span className="reader-find-count" role="status" aria-live="polite" data-reader-search-count>
        {searchResult?.query.toLowerCase() === search.trim().toLowerCase()
          ? `${searchResult.index + 1} / ${searchResult.count}`
          : search.trim()
            ? "按 Enter 查找"
            : "输入文字"}
      </span>
      <button
        type="button"
        className="icon-btn"
        aria-label="上一处匹配"
        title="上一处匹配（Shift + Enter）"
        disabled={!search.trim()}
        onClick={() => findInDocument(-1)}
      >
        <ChevronLeft size={15} />
      </button>
      <button
        className="icon-btn"
        type="submit"
        aria-label="下一处匹配"
        title="下一处匹配（Enter）"
        disabled={!search.trim()}
      >
        <ChevronRight size={15} />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label="关闭查找"
        onClick={closeDocumentSearch}
      >
        <X size={15} />
      </button>
    </form>
  );
}
