import type { Citation } from "./types";
import type { RelationProposal } from "./concept-relation-types";
import type {
  KnowledgeChange,
  KnowledgeNoteSnapshot,
  KnowledgeUpdateReview,
} from "./knowledge-update-types";

export interface OrganizationRequest {
  requestId: string;
  kind: "source" | "knowledge" | "update" | "relations";
  trigger: "automatic" | "manual";
  spaceId: string;
  sourceIds: string[];
  sourceVersions: { sourceId: string; versionId: string }[];
  topic?: string;
  targetNote?: { id: string; revision: number; updatedAt: string };
  compareNote?: { id: string; revision: number; updatedAt: string };
}

export interface OrganizationPage {
  title: string;
  content: string;
  citations: Citation[];
}

export interface OrganizationLabel {
  label: string;
  citations: Citation[];
}

export type OrganizationResult =
  | {
      kind: "relations";
      mode: "model";
      target: KnowledgeNoteSnapshot;
      compare: KnowledgeNoteSnapshot;
      relations: RelationProposal[];
      coverage: string;
    }
  | {
      kind: "source";
      mode: "model";
      summary: OrganizationPage;
      tags: OrganizationLabel[];
      topics: OrganizationLabel[];
      coverage: string;
    }
  | {
      kind: "knowledge";
      mode: "model";
      pages: OrganizationPage[];
      coverage: string;
    }
  | {
      kind: "update";
      mode: "model";
      target: KnowledgeNoteSnapshot;
      changes: KnowledgeChange[];
      coverage: string;
    };

/** Saved with the workspace. Results remain suggestions until individually reviewed. */
export interface OrganizationJob {
  id: string;
  /** Restored history has no resumable request in this account's provider ledger. */
  restoredFromBackup?: boolean;
  /** A server-backed source or knowledge task that outlives the browser page. */
  durable?: true;
  request: OrganizationRequest;
  status: "queued" | "running" | "ready" | "failed" | "cancelled" | "dismissed";
  createdAt: string;
  updatedAt: string;
  result?: OrganizationResult;
  error?: string;
  appliedTags?: { added: string[]; before: string[]; after: string[]; revision?: number };
  savedPages?: { index: number; noteId: string }[];
  ignoredPages?: number[];
  updateReview?: KnowledgeUpdateReview;
  savedRelations?: { proposalId: string; relationId: string }[];
  ignoredRelations?: string[];
}
