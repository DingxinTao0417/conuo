import type { AnswerResult } from "./types";

/** Transient updates are never a saved answer. Only complete confirms the result. */
export type AnswerProgress =
  | { type: "progress"; phase: "retrieving" | "generating" | "validating" | "reasoning" }
  | { type: "draft"; answer: AnswerResult };

export type AnswerStreamEvent =
  | AnswerProgress
  | { type: "complete"; answer: AnswerResult }
  | { type: "error"; error: string; code: string; status: number };

export type OnAnswerProgress = (event: AnswerProgress) => void;
