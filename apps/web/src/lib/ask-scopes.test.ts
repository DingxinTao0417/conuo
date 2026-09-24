import { describe, expect, it } from "vitest";
import { answerRequestFromSnapshot } from "./answer-request";
import {
  askScopeLabels,
  askScopeServerScope,
  comparisonAskScopes,
  isSingleDocumentAskScope,
  libraryAskScopes,
  noteAskScopes,
  readerAskScopes,
  serverScopeFor,
  type AskScope,
} from "./ask-scopes";
import { createComparisonAnswerRequest } from "./comparison-answer";
import { createCrossLibraryAnswerRequest } from "./cross-library-ask";
import { createKnowledgePageEvidenceAnswerRequest } from "./knowledge-page-evidence";
import { createDemoWorkspace } from "./seed";
import type { AnswerScopeSnapshot, Note, Scope, Source, WorkspaceData } from "./types";

const allServerScopes: Scope[] = [
  "selection",
  "document",
  "document-notes",
  "sources",
  "space",
  "cross-library-sources",
];

function readySource(data: WorkspaceData, index: number): Source {
  const sources = data.sources.filter(
    (source) => !source.deletedAt && source.aiAllowed && source.chunks.length > 0,
  );
  const source = sources[index];
  if (!source) throw new Error("demo workspace is missing an answerable source");
  return source;
}

/**
 * Publishes a knowledge page whose citations point at current source versions,
 * which is the only state the evidence range accepts.
 */
function acceptedKnowledgePage(data: WorkspaceData, source: Source): Note {
  const chunk = source.chunks[0]!;
  return {
    id: "note-evidence-contract",
    spaceId: source.spaceIds[0]!,
    title: "对照知识页",
    content: "<p>正文不会成为问答证据。</p>",
    kind: "knowledge",
    status: "accepted",
    citations: [
      {
        sourceId: source.id,
        versionId: source.versionId,
        chunkId: chunk.id,
        title: source.title,
        quote: chunk.text,
        ...(chunk.page === undefined ? {} : { page: chunk.page }),
        section: chunk.section ?? "",
      },
    ],
    versions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
  };
}

describe("ask scope enum", () => {
  it("maps every option to exactly one server scope", () => {
    const options = Object.keys(askScopeServerScope) as AskScope[];
    expect(options).toEqual([
      "selection",
      "document",
      "document-notes",
      "sources",
      "comparison",
      "note-evidence",
      "space",
      "cross-library",
    ]);
    for (const option of options) {
      expect(allServerScopes).toContain(serverScopeFor(option));
      expect(askScopeLabels[option]).toBeTruthy();
    }
  });

  it("reaches every server scope the API accepts and adds none", () => {
    const produced = new Set(Object.values(askScopeServerScope));
    expect([...produced].sort()).toEqual([...allServerScopes].sort());
  });

  it("derives the pre-bounded ranges from the ordinary sources scope", () => {
    // A knowledge page's citations and a comparison's two documents are both
    // bounded source lists the app computes, not new API ranges.
    expect(serverScopeFor("note-evidence")).toBe("sources");
    expect(serverScopeFor("comparison")).toBe("sources");
    expect(serverScopeFor("sources")).toBe("sources");
  });

  it("splits the surfaces so no list offers a range its host cannot bound", () => {
    expect(readerAskScopes).toEqual([
      "selection",
      "document",
      "document-notes",
      "sources",
      "space",
    ]);
    expect(comparisonAskScopes).toEqual(["comparison"]);
    expect(noteAskScopes).toEqual(["note-evidence"]);
    expect(libraryAskScopes).toEqual(["cross-library"]);
    expect(readerAskScopes.filter(isSingleDocumentAskScope)).toEqual([
      "selection",
      "document",
      "document-notes",
    ]);
  });
});

describe("answer request contract per scope option", () => {
  const data = createDemoWorkspace();
  const source = readySource(data, 0);
  const other = readySource(data, 1);
  const spaceId = source.spaceIds[0]!;

  function readerSnapshot(scope: AskScope, overrides: Partial<AnswerScopeSnapshot> = {}) {
    const serverScope = serverScopeFor(scope);
    return answerRequestFromSnapshot(
      {
        scope: serverScope,
        ...(isSingleDocumentAskScope(scope) ? { sourceId: source.id } : {}),
        sourceIds: serverScope === "sources" ? [source.id, other.id] : [source.id],
        sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
        spaceId,
        ...(scope === "selection" ? { selection: "一段选中的原文" } : {}),
        ...overrides,
      },
      { question: "这段在讲什么？", requestId: "request-1" },
    );
  }

  it("keeps the selection range pinned to one document and its quote", () => {
    expect(readerSnapshot("selection")).toMatchObject({
      scope: "selection",
      sourceId: source.id,
      sourceIds: [],
      selection: "一段选中的原文",
      spaceId,
    });
  });

  it("carries only the saved conversation identity outside the frozen scope snapshot", () => {
    const request = answerRequestFromSnapshot(
      {
        scope: "document",
        sourceId: source.id,
        sourceIds: [],
        spaceId,
      },
      { question: "继续说明", conversationId: "conversation-saved" },
    );
    expect(request.conversationId).toBe("conversation-saved");
    expect(request).not.toHaveProperty("userContext");
  });

  it("keeps the document and document-notes ranges pinned to one document", () => {
    for (const scope of ["document", "document-notes"] as const) {
      const request = readerSnapshot(scope);
      expect(request.scope).toBe(scope);
      expect(request.sourceId).toBe(source.id);
      expect(request.sourceIds).toEqual([]);
      expect(request.selection).toBeUndefined();
    }
  });

  it("sends an explicit source list only for the selected-sources range", () => {
    const request = readerSnapshot("sources");
    expect(request.scope).toBe("sources");
    expect(request.sourceId).toBeUndefined();
    expect(request.sourceIds).toEqual([source.id, other.id]);
  });

  it("sends the space range without a document or source list", () => {
    const request = readerSnapshot("space");
    expect(request).toMatchObject({ scope: "space", sourceIds: [], spaceId });
    expect(request.sourceId).toBeUndefined();
  });

  it("builds the knowledge-page evidence range as a version-locked sources request", () => {
    const note = acceptedKnowledgePage(data, source);
    const request = createKnowledgePageEvidenceAnswerRequest(data, note, {
      question: "这些资料怎么解释同一个概念？",
      requestId: "request-2",
    });
    expect(request.scope).toBe(serverScopeFor("note-evidence"));
    expect(request.sourceIds).toEqual([source.id]);
    expect(request.sourceVersions).toEqual([{ sourceId: source.id, versionId: source.versionId }]);
    expect(request.spaceId).toBe(note.spaceId);
    // The page body must never travel with the request.
    expect(JSON.stringify(request)).not.toContain("正文不会成为问答证据");
  });

  it("builds the all-library range as its own server scope", () => {
    const request = createCrossLibraryAnswerRequest(data, {
      question: "这些资料有哪些不同解释？",
      requestId: "request-3",
      sourceIds: [source.id, other.id],
    });
    expect(request.scope).toBe(serverScopeFor("cross-library"));
    expect(request.sourceIds).toEqual([source.id, other.id]);
    expect(request.sourceVersions).toHaveLength(2);
  });

  it("keeps the comparison range a two-source, version-locked sources request", () => {
    const space = data.spaces.find((item) => item.id === spaceId)!;
    const request = createComparisonAnswerRequest({
      left: { source, isCurrentVersion: true },
      right: { source: other, isCurrentVersion: true },
      space,
      question: "两份资料的结论为什么不同？",
      requestId: "request-4",
    });
    expect(request.scope).toBe("sources");
    expect(request.sourceIds).toEqual([source.id, other.id]);
    expect(request.comparison).toEqual({
      leftSourceId: source.id,
      leftVersionId: source.versionId,
      rightSourceId: other.id,
      rightVersionId: other.versionId,
    });
  });
});
