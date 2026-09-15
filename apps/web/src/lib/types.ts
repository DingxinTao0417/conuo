import type { OrganizationJob } from "./organization-types";
import type { ConceptRelation } from "./concept-relation-types";
import type { WebSnapshot } from "./web-types";
import type { ImportJob } from "./import-queue";

export type SourceKind = "pdf" | "docx" | "markdown" | "text" | "web";
export type ProcessingStatus = "saved" | "parsing" | "ready" | "partial" | "failed" | "link-only";
/** What portion of a source the learner intentionally retained. */
export type SourceCaptureScope = "full" | "selection" | "manual" | "link";
/** Parsing outcome for the retained source bytes, kept separate from capture scope. */
export type SourceParseState = "pending" | "complete" | "partial" | "failed" | "not-requested";
/** A compact, inclusive page range that could not be turned into searchable text. */
export interface SourcePageRange {
  start: number;
  end: number;
}
/**
 * Provenance and parsing coverage for one immutable source version.
 *
 * A deliberately saved webpage selection is complete for its retained text,
 * even though it does not claim to represent the whole webpage. `partial` is
 * reserved for genuine parser gaps in otherwise retained source material.
 */
export interface SourceCoverage {
  captureScope: SourceCaptureScope;
  parseState: SourceParseState;
  unavailablePageRanges?: SourcePageRange[];
}
export interface Space {
  id: string;
  name: string;
  goal: string;
  color: string;
  archived: boolean;
  createdAt: string;
}
export interface Chunk {
  id: string;
  sourceId: string;
  versionId: string;
  text: string;
  section: string;
  page?: number;
  order: number;
}
export interface ReadingPositionAlternative {
  origin: "local" | "remote" | "previous";
  readPage?: number;
  readOffset?: number;
  lastReadAt?: string;
}
export interface Source {
  id: string;
  versionId: string;
  versionCreatedAt?: string;
  versions?: SourceVersion[];
  title: string;
  filename: string;
  kind: SourceKind;
  mime: string;
  size: number;
  hash: string;
  spaceIds: string[];
  tags: string[];
  tagsLocked?: boolean;
  tagsRevision?: number;
  status: ProcessingStatus;
  /** Optional for backward-compatible local and cloud snapshots. New writers set it. */
  coverage?: SourceCoverage;
  text: string;
  chunks: Chunk[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  aiAllowed: boolean;
  starred: boolean;
  pageCount?: number;
  parsedPages?: number;
  error?: string;
  url?: string;
  webSnapshot?: WebSnapshot;
  blobKey?: string;
  storagePath?: string;
  /** This retained version was restored without its original bytes. */
  originalMissing?: boolean;
  readPage?: number;
  readOffset?: number;
  /** Last real reading activity, separate from import and metadata updates. */
  lastReadAt?: string;
  /** Recoverable positions displaced by an explicit cross-device choice. */
  readingPositionAlternatives?: ReadingPositionAlternative[];
}

/** Controls whether an authorized source-byte resolver may consult local storage first. */
export interface SourceBlobReadOptions {
  /** Skip IndexedDB and request only the active account's canonical cloud original. */
  preferCloud?: boolean;
}

/** Immutable retained content; permissions and library membership belong to the live source. */
export type SourceVersion = Pick<
  Source,
  | "versionId"
  | "title"
  | "filename"
  | "kind"
  | "mime"
  | "size"
  | "hash"
  | "status"
  | "coverage"
  | "text"
  | "chunks"
  | "pageCount"
  | "parsedPages"
  | "error"
  | "url"
  | "webSnapshot"
  | "blobKey"
  | "storagePath"
  | "originalMissing"
> & { createdAt: string; archivedAt: string };
export interface Citation {
  sourceId: string;
  versionId: string;
  chunkId: string;
  title: string;
  quote: string;
  page?: number;
  section: string;
}
/**
 * A private, structured identity for one learner-selected source excerpt.
 *
 * Unlike a Citation, this records the selected subset inside a cited chunk so
 * saving the exact same excerpt can stay idempotent after rich-text editing.
 * It intentionally stores no original text.
 */
export interface ManualExcerptReference {
  sourceId: string;
  versionId: string;
  chunkId: string;
  selectionFingerprint: string;
}
/**
 * A current, user-authored note block used as answer evidence. This is separate
 * from a source Citation: notes are helpful personal context, never original
 * source material. The snapshot fields let later validation reject an answer
 * when the note was edited, moved, or removed.
 */
export interface AnswerNoteEvidence {
  noteId: string;
  /** The learning space in which the note and document were jointly eligible. */
  spaceId: string;
  /** The current document that made this note eligible for this answer. */
  sourceId: string;
  /** The exact current document version that made this note eligible. */
  sourceVersionId: string;
  revision: number;
  updatedAt: string;
  blockId: string;
  title: string;
  quote: string;
}
/** UTF16 half-open offsets into the exact retained Source.text. */
export interface AnnotationTextAnchor {
  start: number;
  end: number;
}
export interface Annotation {
  id: string;
  sourceId: string;
  versionId: string;
  quote: string;
  note: string;
  page?: number;
  textAnchor?: AnnotationTextAnchor;
  createdAt: string;
}
/**
 * User-authored annotation text rescued from a source delete-versus-edit race.
 *
 * The matching Annotation and soft-deleted Source stay in the workspace until
 * the learner explicitly restores the source, saves this text elsewhere, or
 * discards it. `capturedAt` is the deletion timestamp so retries can recreate
 * the same record without consulting a device clock.
 */
export interface RecoverableSourceAnnotationDraft {
  id: string;
  kind: "source-annotation";
  reason: "source-deleted-during-offline-edit";
  sourceId: string;
  sourceVersionId: string;
  sourceTitle: string;
  sourceDeletedAt: string;
  annotationId: string;
  annotationCreatedAt: string;
  quote: string;
  note: string;
  page?: number;
  textAnchor?: AnnotationTextAnchor;
  capturedAt: string;
}
/** Durable, content-free acknowledgement that a recovery draft was handled. */
export interface ResolvedRecoverableSourceAnnotationDraft {
  id: string;
  sourceId: string;
  annotationId: string;
  sourceDeletedAt: string;
  /**
   * Whether later merges must keep or remove the source-bound annotation.
   * Missing means a legacy marker created before this distinction existed.
   */
  annotationDisposition?: "retain" | "remove";
}
export interface NoteVersion {
  id: string;
  title: string;
  content: string;
  savedAt: string;
  citations?: Citation[];
  status?: "draft" | "accepted";
  aiGenerated?: boolean;
  spaceId?: string;
  contentRevision?: number;
  manualExcerptRefs?: ManualExcerptReference[];
}
export interface Note {
  id: string;
  spaceId: string;
  title: string;
  content: string;
  kind: "note" | "knowledge";
  aiGenerated?: boolean;
  contentRevision?: number;
  status: "draft" | "accepted";
  citations: Citation[];
  /** Exact manual excerpt identities, persisted independently from editor HTML. */
  manualExcerptRefs?: ManualExcerptReference[];
  versions: NoteVersion[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
/**
 * `cross-library-sources` is deliberately distinct from an ordinary selected
 * source range. It is available only from the all-library workspace and always
 * carries an exact, bounded source-version set.
 */
export type Scope =
  "selection" | "document" | "document-notes" | "sources" | "space" | "cross-library-sources";
/**
 * Frozen user-visible range and follow-up context used for one answer attempt.
 * A retry uses this snapshot instead of a later conversation-wide scope change.
 */
export type AnswerScopeSnapshot = Omit<AnswerRequest, "requestId" | "question">;
export interface AnswerAttempt {
  /** Unique request ID for this try. It is never reused when retrying. */
  id: string;
  /** The original user message this answer is trying to answer. */
  questionMessageId: string;
  scopeSnapshot: AnswerScopeSnapshot;
  status: "completed" | "failed" | "stopped";
  /** The record remains readable after permanent deletion, but cannot be replayed. */
  unavailableReason?: "source-purged";
}
export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  /** Personal-note evidence is answer-only and deliberately not a source citation. */
  noteEvidence?: AnswerNoteEvidence[];
  createdAt: string;
  mode?: "extractive" | "model";
  error?: string;
  /** Present on assistant messages to identify and safely retry one answer attempt. */
  attempt?: AnswerAttempt;
}

/**
 * Immutable identity for a question asked from the two-pane comparison reader.
 * Versions are stored here so reopening a saved comparison never guesses which
 * current source body was used when the question was originally asked.
 */
export interface ComparisonConversationMetadata {
  leftSourceId: string;
  leftVersionId: string;
  rightSourceId: string;
  rightVersionId: string;
}
export interface Conversation {
  id: string;
  spaceId: string;
  sourceId?: string;
  title: string;
  scope: Scope;
  sourceIds: string[];
  /** Present only for a fixed-version, two-source comparison conversation. */
  comparison?: ComparisonConversationMetadata;
  messages: Message[];
  resolved: boolean;
  updatedAt: string;
}
export interface WorkspaceData {
  schemaVersion: 1;
  spaces: Space[];
  sources: Source[];
  notes: Note[];
  annotations: Annotation[];
  /** Optional for backward-compatible snapshots written before AT-20. */
  recoverableDrafts?: RecoverableSourceAnnotationDraft[];
  /** Append-only resolution markers prevent stale devices from reviving handled drafts. */
  resolvedRecoverableDrafts?: ResolvedRecoverableSourceAnnotationDraft[];
  conversations: Conversation[];
  aiEnabled: boolean;
  semanticSearch?: boolean;
  autoOrganize?: boolean;
  /** Local parsing work survives a refresh and is never a source of AI evidence. */
  importJobs?: ImportJob[];
  organizationJobs?: OrganizationJob[];
  conceptRelations?: ConceptRelation[];
}

/** An exact current source-version identity that a request must not silently rebind. */
export interface SourceVersionReference {
  sourceId: string;
  versionId: string;
}
export interface AnswerRequest {
  requestId?: string;
  question: string;
  /** Bounded, prior user questions used only to resolve a follow-up's subject. */
  userContext?: string[];
  scope: Scope;
  sourceId?: string;
  sourceIds: string[];
  /** Exact-version lock required for any explicitly selected source range. */
  sourceVersions?: SourceVersionReference[];
  /** Present only for the fixed two-source comparison reader boundary. */
  comparison?: ComparisonConversationMetadata;
  spaceId: string;
  selection?: string;
}
export interface AnswerResult {
  content: string;
  citations: Citation[];
  /** Current user-note blocks that materially supported this answer. */
  noteEvidence?: AnswerNoteEvidence[];
  mode: "extractive" | "model";
}
export type SaveState = "loading" | "saving" | "local" | "cloud" | "error" | "conflict";
