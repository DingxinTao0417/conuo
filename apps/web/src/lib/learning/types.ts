export const learningKinds = [
  "recall",
  "choice",
  "cloze",
  "short",
  "derivation",
  "explain",
] as const;
export type LearningKind = (typeof learningKinds)[number];
export type LearningOrigin = "ai" | "user" | "region";
export type LearningStatus = "active" | "suspended" | "archived";
export type ReviewRating = 1 | 2 | 3 | 4;

export interface LearningItem {
  itemId: string;
  spaceId: string;
  kind: LearningKind;
  prompt: string;
  choices?: string[] | null;
  answer: Record<string, unknown>;
  explanation?: string | null;
  citations: unknown[];
  origin: LearningOrigin;
  originRef?: Record<string, unknown> | null;
  conceptKey?: string | null;
  hints?: string[] | null;
  status: LearningStatus;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
  card?: Record<string, unknown>;
  dueAt?: string;
}

export interface ReviewState {
  itemId: string;
  card: Record<string, unknown>;
  dueAt: string;
  reps: number;
  lapses: number;
  lastReviewAt?: string | null;
  version: number;
}

export interface LearningReviewLog {
  logId: string;
  itemId: string;
  rating: ReviewRating;
  answerText?: string | null;
  grade?: Record<string, unknown> | null;
  elapsedMs?: number | null;
  reviewedAt: string;
}

export interface LearningBackup {
  schemaVersion: 1;
  items: LearningItem[];
  reviewLogs: LearningReviewLog[];
  settings: { dailyNewLimit: number; desiredRetention: number; paused: boolean } | null;
}
