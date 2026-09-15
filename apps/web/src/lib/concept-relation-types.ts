import type { Citation } from "./types";
import type { KnowledgeNoteSnapshot } from "./knowledge-update-types";

export type RelationType = "synonym" | "related" | "prerequisite" | "conflict";
export interface RelationDraft {
  type: RelationType;
  fromClaim: string;
  toClaim: string;
  fromCondition: string;
  toCondition: string;
  explanation: string;
  fromCitations: Citation[];
  toCitations: Citation[];
}
export interface RelationInput extends RelationDraft {
  fromNoteId: string;
  toNoteId: string;
}
export interface RelationProposal extends RelationDraft {
  id: string;
}
/** Only explicitly saved relations are stored here; AI origin never becomes a source claim. */
export interface ConceptRelation extends RelationDraft {
  id: string;
  spaceId: string;
  from: KnowledgeNoteSnapshot;
  to: KnowledgeNoteSnapshot;
  origin: "manual" | "ai";
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  jobId?: string;
  proposalId?: string;
}
