import type { AnswerRequest, AnswerScopeSnapshot } from "./types";

/**
 * Turns the frozen range of one answer attempt into the request that is sent.
 *
 * The snapshot is the only input: a retry replays exactly what the learner saw
 * when the question was asked, and the fields a given scope must not carry
 * (`sourceId` outside a single-document range, `sourceIds` outside an explicit
 * selection, `selection` outside a selection range) are dropped here rather
 * than at each call site.
 */
export function answerRequestFromSnapshot(
  snapshot: AnswerScopeSnapshot,
  input: { question: string; requestId?: string },
): AnswerRequest {
  const singleDocument =
    snapshot.scope === "selection" ||
    snapshot.scope === "document" ||
    snapshot.scope === "document-notes";
  return {
    ...(input.requestId ? { requestId: input.requestId } : {}),
    question: input.question,
    ...(snapshot.userContext?.length ? { userContext: [...snapshot.userContext] } : {}),
    scope: snapshot.scope,
    sourceId: singleDocument ? snapshot.sourceId : undefined,
    sourceIds: snapshot.scope === "sources" ? [...snapshot.sourceIds] : [],
    ...(snapshot.sourceVersions
      ? { sourceVersions: snapshot.sourceVersions.map((reference) => ({ ...reference })) }
      : {}),
    ...(snapshot.comparison ? { comparison: { ...snapshot.comparison } } : {}),
    spaceId: snapshot.spaceId,
    selection: snapshot.scope === "selection" ? snapshot.selection : undefined,
  };
}
