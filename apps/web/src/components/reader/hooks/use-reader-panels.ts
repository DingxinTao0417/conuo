"use client";

import { useCallback, useState } from "react";
import type { Citation } from "@/lib/types";

/**
 * Every overlay that competes for the document side of the reader: the drawers
 * above the page, the version manager, the retained-position dialog and the
 * source action menu.
 *
 * The AI panel is deliberately absent. It is the other half of the workspace
 * and stays open next to any of these, which is why `aiOpen` remains a separate
 * flag in the shell.
 */
export type ReaderPanel =
  "outline" | "find" | "annotations" | "citation" | "versions" | "positions" | "source-actions";

/** Which face of the version manager a source action asked for. */
export type ReaderVersionsMode = "history" | "refresh" | "replace";

/** Panels a control can flip on and off on its own. */
export type TogglableReaderPanel = Exclude<ReaderPanel, "versions" | "citation">;

type ActiveReaderPanel =
  { kind: Exclude<ReaderPanel, "versions"> } | { kind: "versions"; mode: ReaderVersionsMode };

const SOURCE_SCOPED_PANELS: ReaderPanel[] = ["annotations", "versions"];

/**
 * One slot for the reader's document-side panels.
 *
 * These used to be seven independent flags whose exclusivity depended on every
 * opener remembering to close the others, so combinations like "outline over
 * annotations" were reachable by accident. A single active panel makes the rule
 * structural instead.
 *
 * The focused citation is kept next to it rather than inside it: an excerpt is
 * evidence that stays located and highlighted in the document even after its
 * card hands the panel slot to something else.
 */
export function useReaderPanels() {
  const [active, setActive] = useState<ActiveReaderPanel | null>(null);
  const [citation, setCitation] = useState<Citation | null>(null);
  const [citationError, setCitationError] = useState("");

  const open = useCallback((panel: TogglableReaderPanel) => setActive({ kind: panel }), []);

  const toggle = useCallback(
    (panel: TogglableReaderPanel) =>
      setActive((current) => (current?.kind === panel ? null : { kind: panel })),
    [],
  );

  const openVersions = useCallback(
    (mode: ReaderVersionsMode) => setActive({ kind: "versions", mode }),
    [],
  );

  const close = useCallback(() => setActive(null), []);

  /** Opens an answer excerpt and locates it; replaces whatever panel was open. */
  const focusCitation = useCallback((next: Citation, problem = "") => {
    setCitation(next);
    setCitationError(problem);
    setActive({ kind: "citation" });
  }, []);

  /**
   * Drops the located excerpt. Other panels keep their slot, so paging away
   * from a citation cannot close an unrelated drawer the learner just opened.
   */
  const clearCitation = useCallback(() => {
    setCitation(null);
    setCitationError("");
    setActive((current) => (current?.kind === "citation" ? null : current));
  }, []);

  /**
   * Clears what a newly opened document must not inherit.
   *
   * The annotation list and the version manager survive, because they describe
   * the source rather than a position inside it: opening an archived version
   * from the version list *is* a document change, and the list has to stay in
   * place for the way back.
   */
  const reset = useCallback(() => {
    setActive((current) =>
      current && SOURCE_SCOPED_PANELS.includes(current.kind) ? current : null,
    );
    setCitation(null);
    setCitationError("");
  }, []);

  return {
    active: active?.kind ?? null,
    versionsMode: active?.kind === "versions" ? active.mode : null,
    citation,
    citationError,
    setCitationError,
    open,
    toggle,
    openVersions,
    close,
    focusCitation,
    clearCitation,
    reset,
  };
}

export type ReaderPanels = ReturnType<typeof useReaderPanels>;
