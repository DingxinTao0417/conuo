import { resolveCitation } from "./retrieval";
import type { AnswerRequest, Note, Source, SourceVersionReference, WorkspaceData } from "./types";

export type KnowledgePageEvidenceUnavailableReason =
  | "not-knowledge-page"
  | "not-accepted"
  | "page-unavailable"
  | "space-unavailable"
  | "no-current-original-sources";

export class KnowledgePageEvidenceError extends Error {
  constructor(
    public readonly code: KnowledgePageEvidenceUnavailableReason,
    message: string,
  ) {
    super(message);
    this.name = "KnowledgePageEvidenceError";
  }
}

export type KnowledgePageOriginalEvidence =
  | {
      ok: true;
      sources: Source[];
      sourceIds: string[];
      sourceVersions: SourceVersionReference[];
    }
  | {
      ok: false;
      reason: KnowledgePageEvidenceUnavailableReason;
      message: string;
    };

function sourceBelongsToNoteSpace(source: Source, spaceId: string) {
  return spaceId === "inbox" ? source.spaceIds.length === 0 : source.spaceIds.includes(spaceId);
}

function unavailable(
  reason: KnowledgePageEvidenceUnavailableReason,
  message: string,
): KnowledgePageOriginalEvidence {
  return { ok: false, reason, message };
}

/**
 * Resolves only the current, original-source records that an accepted knowledge
 * page explicitly cites. The page body is deliberately absent from this
 * boundary: it is a learner-facing synthesis, never question evidence.
 */
export function resolveKnowledgePageOriginalEvidence(
  data: WorkspaceData,
  note: Note,
): KnowledgePageOriginalEvidence {
  if (note.kind !== "knowledge")
    return unavailable("not-knowledge-page", "只有知识页可以基于原始依据发起提问。");
  if (note.deletedAt)
    return unavailable("page-unavailable", "这个知识页已删除，不能再发起基于原始依据的提问。");
  if (note.status !== "accepted")
    return unavailable("not-accepted", "请先接受知识页，再基于其原始依据提问。");
  if (
    note.spaceId !== "inbox" &&
    !data.spaces.some((space) => space.id === note.spaceId && !space.archived)
  )
    return unavailable("space-unavailable", "这个知识页所在的知识库当前不可用。");

  const sources: Source[] = [];
  const included = new Set<string>();
  for (const citation of note.citations) {
    if (included.has(citation.sourceId)) continue;
    const source = data.sources.find((candidate) => candidate.id === citation.sourceId);
    if (
      !source ||
      source.deletedAt ||
      !sourceBelongsToNoteSpace(source, note.spaceId) ||
      source.versionId !== citation.versionId ||
      !source.aiAllowed ||
      !resolveCitation(data, citation)
    )
      continue;
    included.add(source.id);
    sources.push(source);
  }

  if (!sources.length)
    return unavailable(
      "no-current-original-sources",
      "当前知识页没有可用于问答的原始资料。仅会使用同一知识库中未删除、当前版本且已允许 AI 使用的引用资料。",
    );

  return {
    ok: true,
    sources,
    sourceIds: sources.map((source) => source.id),
    sourceVersions: sources.map((source) => ({
      sourceId: source.id,
      versionId: source.versionId,
    })),
  };
}

/**
 * Builds the narrow question request for an accepted knowledge page. It has no
 * knowledge-page text, no note IDs, no selected excerpt, and no document-note
 * scope, so the request can only retrieve the verified original sources above.
 */
export function createKnowledgePageEvidenceAnswerRequest(
  data: WorkspaceData,
  note: Note,
  input: Pick<AnswerRequest, "question" | "requestId" | "userContext">,
): AnswerRequest {
  const evidence = resolveKnowledgePageOriginalEvidence(data, note);
  if (!evidence.ok) throw new KnowledgePageEvidenceError(evidence.reason, evidence.message);
  return {
    question: input.question,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.userContext?.length ? { userContext: [...input.userContext] } : {}),
    scope: "sources",
    sourceIds: [...evidence.sourceIds],
    sourceVersions: evidence.sourceVersions.map((reference) => ({ ...reference })),
    spaceId: note.spaceId,
  };
}
