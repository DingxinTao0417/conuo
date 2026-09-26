import type { WorkspaceData } from "./types";
import type { LearningBackup } from "./learning/types";

export interface MissingBackupOriginal {
  sourceId: string;
  versionId: string;
  title: string;
  filename?: string;
  reason?: string;
}

/** ZIP parser has checked archive paths, integrity, exact identities and original bytes. */
export interface PreparedBackup {
  data: WorkspaceData;
  originals: { sourceId: string; versionId: string; blob: Blob }[];
  missingOriginals: MissingBackupOriginal[];
  fingerprint: string;
  warnings?: string[];
  learning?: LearningBackup;
}

export interface RestorePlan {
  /** Stable for this confirmation attempt; preparing again intentionally creates another copy. */
  id: string;
  fingerprint: string;
  data: WorkspaceData;
  blobs: { key: string; blob: Blob; sourceId: string; versionId: string }[];
  missingOriginals: MissingBackupOriginal[];
  counts: {
    spaces: number;
    sources: number;
    sourceVersions: number;
    notes: number;
    noteVersions: number;
    conversations: number;
    messages: number;
    annotations: number;
    recoverableDrafts: number;
    organizationJobs: number;
    conceptRelations: number;
  };
  warnings: string[];
  /** Number of incoming active spaces archived to fit the current account quota. */
  archivedSpaceCount?: number;
}
