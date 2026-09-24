import { createHash } from "node:crypto";
import { resolveCitation } from "../retrieval";
import type { AnswerRequest, Citation, Source, WorkspaceData } from "../types";

const EMPTY: PriorAnswerContext = { answers: [], citations: [], key: null };
const MAX_ANSWERS = 2;
const MAX_CITATIONS = 6;
const MAX_TEXT_CHARS = 1_500;

export interface PriorAnswerContext {
  answers: Array<{ text: string }>;
  citations: Citation[];
  /** Changes whenever the remembered text or its evidence changes. */
  key: string | null;
}

function cleanAnswer(text: string): string {
  return text
    .split("\n\n---\n\n", 1)[0]!
    .replace(/\[\d+\]/gu, "")
    .replace(/\[\[conuo-[^\]]+\]\]/gu, "")
    .trim()
    .slice(0, MAX_TEXT_CHARS)
    .trim();
}

function citationKey(citation: Citation): string {
  return JSON.stringify([citation.sourceId, citation.versionId, citation.chunkId, citation.quote]);
}

/** Loads bounded, server-owned conversation memory without treating it as evidence. */
export function priorAnswerContext(
  data: WorkspaceData,
  request: AnswerRequest,
  allowedSources: readonly Source[],
): PriorAnswerContext {
  if (!request.conversationId) return EMPTY;
  const conversation = data.conversations.find(
    (candidate) =>
      candidate.id === request.conversationId &&
      candidate.spaceId === request.spaceId &&
      candidate.scope === request.scope,
  );
  if (!conversation) return EMPTY;

  const eligible = conversation.messages
    .filter(
      (message) =>
        message.role === "assistant" &&
        message.mode === "model" &&
        message.error === undefined &&
        message.attempt?.status === "completed",
    )
    .slice(-MAX_ANSWERS);
  const answers = eligible
    .map((message) => ({ text: cleanAnswer(message.content) }))
    .filter((answer) => answer.text.length > 0);
  const allowed = new Map(allowedSources.map((source) => [source.id, source.versionId]));
  const citations: Citation[] = [];
  const seen = new Set<string>();
  for (const message of eligible) {
    for (const citation of message.citations) {
      const resolved = resolveCitation(data, citation);
      if (!resolved || allowed.get(citation.sourceId) !== citation.versionId) continue;
      const key = citationKey(citation);
      if (seen.has(key)) continue;
      seen.add(key);
      citations.push(citation);
      if (citations.length >= MAX_CITATIONS) break;
    }
    if (citations.length >= MAX_CITATIONS) break;
  }
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        eligible.map((message) => message.id),
        answers.map((answer) => answer.text),
        citations.map(citationKey),
      ]),
    )
    .digest("hex");
  return { answers, citations, key };
}
