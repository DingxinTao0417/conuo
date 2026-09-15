import type { Scope } from "./types";

/**
 * The single list of ranges any question surface may offer.
 *
 * A UI option is not the same thing as a server range: `note-evidence` is a
 * knowledge page's own citations, which is an ordinary bounded `sources`
 * request the page computes for the learner instead of asking them to pick the
 * files by hand. Every option therefore declares exactly one
 * `AnswerRequest.scope` it is allowed to produce, and that mapping is locked by
 * ask-scopes.test.ts, so moving an entry point between surfaces can never
 * quietly widen a request to the whole space or to other libraries.
 */
export type AskScope =
  | "selection"
  | "document"
  | "document-notes"
  | "sources"
  | "note-evidence"
  | "space"
  | "cross-library";

export const askScopeServerScope: Record<AskScope, Scope> = {
  selection: "selection",
  document: "document",
  "document-notes": "document-notes",
  sources: "sources",
  "note-evidence": "sources",
  space: "space",
  "cross-library": "cross-library-sources",
};

export const askScopeLabels: Record<AskScope, string> = {
  selection: "选中段落 + 当前资料",
  document: "当前资料",
  "document-notes": "此资料 + 我的笔记",
  sources: "选定资料",
  "note-evidence": "本页引用的资料",
  space: "当前学习空间",
  "cross-library": "跨知识库固定资料",
};

/** The reader and the comparison reader share one document-centred range list. */
export const readerAskScopes: AskScope[] = [
  "selection",
  "document",
  "document-notes",
  "sources",
  "space",
];

/** A knowledge page may only ask about the original sources it already cites. */
export const noteAskScopes: AskScope[] = ["note-evidence"];

/** The all-library surface always locks an explicit, bounded source set first. */
export const libraryAskScopes: AskScope[] = ["cross-library"];

export function serverScopeFor(scope: AskScope): Scope {
  return askScopeServerScope[scope];
}

/** True when a range is pinned to the one document currently on screen. */
export function isSingleDocumentAskScope(scope: AskScope) {
  return scope === "selection" || scope === "document" || scope === "document-notes";
}
