import { describe, expect, it } from "vitest";
import {
  ANSWER_RETRIEVAL_QUERY_MAX_CHARS,
  ANSWER_USER_CONTEXT_ITEM_MAX_CHARS,
  ANSWER_USER_CONTEXT_MAX_CHARS,
  ANSWER_USER_CONTEXT_MAX_ITEMS,
  answerRetrievalQuery,
  normalizeUserQuestionContext,
  priorUserQuestions,
} from "./answer-context";
import type { AnswerRequest } from "./types";

function request(patch: Partial<AnswerRequest> = {}): AnswerRequest {
  return {
    question: "当前问题",
    scope: "space",
    sourceIds: [],
    spaceId: "space-1",
    ...patch,
  };
}

describe("follow-up question context", () => {
  it("keeps only the most recent prior user questions and excludes assistant messages", () => {
    const userQuestions = Array.from(
      { length: ANSWER_USER_CONTEXT_MAX_ITEMS + 1 },
      (_, index) => `USER_QUESTION_${index + 1}`,
    );
    const result = priorUserQuestions([
      { role: "user", content: userQuestions[0] },
      { role: "assistant", content: "ASSISTANT_ONLY_KEYWORD" },
      ...userQuestions.slice(1).map((content) => ({ role: "user" as const, content })),
    ]);

    expect(result).toEqual(userQuestions.slice(-ANSWER_USER_CONTEXT_MAX_ITEMS));
    expect(JSON.stringify(result)).not.toContain("ASSISTANT_ONLY_KEYWORD");
  });

  it("bounds local context and keeps the current question plus only fitting recent history in retrieval", () => {
    const malformed = normalizeUserQuestionContext([
      "  ",
      ...Array.from({ length: 7 }, (_, index) => `${index}`.repeat(900)),
    ]);
    expect(malformed.length).toBeLessThanOrEqual(ANSWER_USER_CONTEXT_MAX_ITEMS);
    expect(malformed.every((item) => item.length <= ANSWER_USER_CONTEXT_ITEM_MAX_CHARS)).toBe(true);
    expect(malformed.reduce((sum, item) => sum + item.length, 0)).toBeLessThanOrEqual(
      ANSWER_USER_CONTEXT_MAX_CHARS,
    );

    const current = "c".repeat(3_400);
    const older = "o".repeat(600);
    const recent = "r".repeat(599);
    const query = answerRetrievalQuery(
      request({ question: current, userContext: [older, recent] }),
    );
    expect(query).toBe(`${current}\n${recent}`);
    expect(query).toHaveLength(ANSWER_RETRIEVAL_QUERY_MAX_CHARS);
  });
});
