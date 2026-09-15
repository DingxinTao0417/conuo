import type { AnswerRequest, Source, WorkspaceData } from "./types";
import { ANSWER_CONTEXT_VERSION, normalizeUserQuestionContext } from "./answer-context";
import { selectedDocumentNoteEvidence } from "./retrieval";
import { isCrossLibraryAnswerRequest } from "./cross-library-ask";

/**
 * The evidence boundary of one question. Shared by browser invalidation and
 * server request fingerprints; never include request IDs or UI/persistence state.
 * This is a comparison key, not a permission check or a model prompt.
 */
export function questionContextKey(data: WorkspaceData, request: AnswerRequest): string {
  const space = data.spaces.find((item) => item.id === request.spaceId);
  const selectedIds = new Set(request.sourceIds);
  const crossLibrary = isCrossLibraryAnswerRequest(request);
  const sources = data.sources.filter((source) => {
    if (crossLibrary) return selectedIds.has(source.id);
    const inSpace =
      request.spaceId === "inbox"
        ? source.spaceIds.length === 0
        : source.spaceIds.includes(request.spaceId);
    if (!inSpace) return false;
    switch (request.scope) {
      case "selection":
      case "document":
      case "document-notes":
        return source.id === request.sourceId;
      case "sources":
        return selectedIds.has(source.id);
      case "space":
        return true;
      default:
        return false;
    }
  });
  const evidence = (source: Source) => ({
    id: source.id,
    versionId: source.versionId,
    title: source.title,
    kind: source.kind,
    text: source.text,
    chunks: source.chunks.map((chunk) => ({
      id: chunk.id,
      sourceId: chunk.sourceId,
      versionId: chunk.versionId,
      text: chunk.text,
      section: chunk.section,
      page: chunk.page ?? null,
      order: chunk.order,
    })),
    status: source.status,
    ...(source.coverage ? { coverage: source.coverage } : {}),
    deletedAt: source.deletedAt,
    aiAllowed: source.aiAllowed,
    pageCount: source.pageCount ?? null,
    parsedPages: source.parsedPages ?? null,
    // A cross-library request must stop if a selected source loses its final
    // active-space association. Keep the association/archival state in its
    // boundary key rather than relying on a later candidate filter.
    ...(crossLibrary
      ? {
          spaceMembership: [...source.spaceIds].sort().map((spaceId) => {
            const item = data.spaces.find((candidate) => candidate.id === spaceId);
            return { id: spaceId, archived: item?.archived ?? null };
          }),
        }
      : {}),
  });
  const noteEvidence =
    request.scope === "document-notes"
      ? selectedDocumentNoteEvidence(data, request).map((item) => {
          const note = data.notes.find((candidate) => candidate.id === item.noteId)!;
          return {
            ...item,
            // Keep provenance in the fingerprint too. A manually edited note
            // can remain text-identical while its asserted source basis changes.
            citations: note.citations.map((citation) => ({
              sourceId: citation.sourceId,
              versionId: citation.versionId,
              chunkId: citation.chunkId,
              title: citation.title,
              quote: citation.quote,
              page: citation.page ?? null,
              section: citation.section,
            })),
          };
        })
      : [];
  return JSON.stringify({
    answerContextVersion: ANSWER_CONTEXT_VERSION,
    question: request.question,
    userContext: normalizeUserQuestionContext(request.userContext),
    scope: request.scope,
    spaceId: request.spaceId,
    sourceId:
      request.scope === "selection" ||
      request.scope === "document" ||
      request.scope === "document-notes"
        ? (request.sourceId ?? null)
        : null,
    sourceIds: request.scope === "sources" || crossLibrary ? [...selectedIds].sort() : [],
    sourceVersions: request.sourceVersions
      ? [...request.sourceVersions].sort((left, right) =>
          left.sourceId === right.sourceId
            ? left.versionId.localeCompare(right.versionId)
            : left.sourceId.localeCompare(right.sourceId),
        )
      : [],
    comparison:
      request.scope === "sources" && request.comparison
        ? {
            leftSourceId: request.comparison.leftSourceId,
            leftVersionId: request.comparison.leftVersionId,
            rightSourceId: request.comparison.rightSourceId,
            rightVersionId: request.comparison.rightVersionId,
          }
        : null,
    selection: request.scope === "selection" ? (request.selection ?? null) : null,
    aiEnabled: data.aiEnabled,
    semanticSearch: data.semanticSearch === true,
    space:
      request.spaceId === "all" && crossLibrary
        ? { exists: true, archived: false }
        : request.spaceId === "inbox"
          ? { exists: true, archived: false }
          : { exists: !!space, archived: space?.archived ?? null },
    sources: sources.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(evidence),
    noteEvidence,
  });
}
