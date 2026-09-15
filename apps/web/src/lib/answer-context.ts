import type { AnswerRequest, Message } from "./types";

/**
 * A short, user-authored-only thread window lets a follow-up such as
 * “为什么？” recover its subject without treating an old model answer as
 * current evidence. These bounds are shared by the UI, API contract, cache key
 * and retrieval query.
 */
export const ANSWER_USER_CONTEXT_MAX_ITEMS = 6;
export const ANSWER_USER_CONTEXT_ITEM_MAX_CHARS = 800;
export const ANSWER_USER_CONTEXT_MAX_CHARS = 3_600;
export const ANSWER_RETRIEVAL_QUERY_MAX_CHARS = 4_000;
// Source capture coverage now affects the model-facing evidence boundary too.
// Bump this so legacy selected-webpage answers never reuse a response generated
// before selection scope and parser gaps were distinguished.
export const ANSWER_CONTEXT_VERSION = "user-context-v2";

const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();

/**
 * Canonicalizes the bounded, chronological user-question window. Runtime API
 * validation rejects malformed input; this helper also keeps local-only calls
 * within the same privacy and query-size envelope.
 */
export function normalizeUserQuestionContext(value?: readonly string[]): string[] {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => normalize(item).slice(0, ANSWER_USER_CONTEXT_ITEM_MAX_CHARS))
    .filter(Boolean)
    .slice(-ANSWER_USER_CONTEXT_MAX_ITEMS);

  // Preserve the most recent questions when the total window must be shortened,
  // then restore chronological order for the model-facing JSON payload.
  const selected: string[] = [];
  let length = 0;
  for (let index = normalized.length - 1; index >= 0; index--) {
    const item = normalized[index];
    if (length + item.length > ANSWER_USER_CONTEXT_MAX_CHARS) continue;
    selected.push(item);
    length += item.length;
  }
  return selected.reverse();
}

/** Only prior user questions can be automatically carried between turns. */
export function priorUserQuestions(
  messages: readonly Pick<Message, "role" | "content">[],
): string[] {
  return normalizeUserQuestionContext(
    messages.filter((message) => message.role === "user").map((message) => message.content),
  );
}

/**
 * Uses the current question first and adds only as much recent user context as
 * the shared SQL/embedding query ceiling permits. It never expands source or
 * space scope; the caller still applies the ordinary evidence filters.
 */
export function answerRetrievalQuery(request: AnswerRequest): string {
  const current = normalize(request.question).slice(0, ANSWER_RETRIEVAL_QUERY_MAX_CHARS);
  if (current.length >= ANSWER_RETRIEVAL_QUERY_MAX_CHARS) return current;

  const selected: string[] = [];
  let length = current.length;
  for (const item of [...normalizeUserQuestionContext(request.userContext)].reverse()) {
    const separator = length ? 1 : 0;
    if (length + separator + item.length > ANSWER_RETRIEVAL_QUERY_MAX_CHARS) continue;
    selected.push(item);
    length += separator + item.length;
  }
  return [current, ...selected.reverse()].filter(Boolean).join("\n");
}
