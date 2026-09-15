import type { Citation } from "./types";

/** The exact note version used to generate/review a suggestion, without its history. */
export interface KnowledgeNoteSnapshot {
  id: string;
  spaceId: string;
  title: string;
  content: string;
  citations: Citation[];
  status: "draft" | "accepted";
  aiGenerated: boolean;
  revision: number;
  updatedAt: string;
}

export interface KnowledgeChange {
  id: string;
  type: "insert_after" | "replace" | "remove";
  blockId: string;
  before: string;
  /** Plain text. Neither model output nor review edits may provide executable HTML. */
  after: string;
  reason: string;
  citations: Citation[];
}

export interface KnowledgeUpdateReview {
  note: KnowledgeNoteSnapshot;
  applied: { changeId: string; text: string }[];
  ignored: string[];
  /** Closes this review permanently; note bodies remain in the existing version history. */
  withdrawal?: KnowledgeUpdateWithdrawalReceipt;
}

export interface KnowledgeUpdateWithdrawalReceipt {
  id: string;
  at: string;
  /** Revision created by the withdrawal, rather than the historical applied snapshot. */
  noteRevision: number;
  /** SHA-256 of the confirmed preview context, without storing that context's bodies. */
  fingerprint: string;
  restoredChangeIds: string[];
  keptChangeIds: string[];
}

export interface KnowledgeBlock {
  id: string;
  html: string;
  text: string;
  start: number;
  end: number;
}
