import type { SourceVersionPurgePreview } from "@/lib/cloud";
import type { OnAnswerProgress } from "@/lib/answer-stream-types";
import type {
  Annotation,
  AnswerRequest,
  AnswerResult,
  Citation,
  Conversation,
  Note,
  SaveState,
  Source,
  Space,
} from "@/lib/types";
import type { PdfCaptureRegion, PdfCaptureResult } from "../pdf-capture";

export type BoundPdfCaptureResult = PdfCaptureResult & {
  accountId: string;
};

export type RegionCaptureStart = {
  accountId: string;
  sourceId: string;
  versionId: string;
};

export type ReaderRegionTarget = {
  sourceId: string;
  versionId: string;
  page: number;
  rect: PdfCaptureRegion;
};

export interface ReaderProps {
  source: Source;
  currentSource?: Source;
  sources: Source[];
  notes?: Note[];
  space: Space;
  conversations: Conversation[];
  annotations: Annotation[];
  aiEnabled: boolean;
  cloudUserId?: string;
  saveState?: SaveState;
  saveLabel?: string;
  /** Monotonic signal for applying an explicitly resolved reading position in place. */
  readingPositionRevision?: number;
  /** Keeps cloud adoption from replacing a scroll position that has not been saved yet. */
  onPendingReadingChange?: (pending: boolean) => void;
  onSourceChange: (
    patch: Partial<
      Pick<
        Source,
        "readPage" | "readOffset" | "lastReadAt" | "readingPositionAlternatives" | "aiAllowed"
      >
    >,
  ) => void;
  onConversationChange: (conversation: Conversation) => void;
  onAnnotationAdd: (annotation: Annotation) => void;
  onAnnotationUpdate?: (annotation: Annotation) => void;
  onAnnotationDelete?: (annotation: Annotation) => void;
  onSaveNote: (
    content: string,
    citations: Citation[],
    kind: "note" | "knowledge",
    aiGenerated?: boolean,
  ) => void;
  /** Appends a source-grounded answer to a current-space knowledge page. */
  onAppendToKnowledgePage?: (input: {
    noteId: string;
    content: string;
    citations: Citation[];
    mode: AnswerResult["mode"];
  }) => string;
  /** Saves a learner-selected original excerpt as a manual knowledge-page draft or appendix. */
  onSaveExcerptToKnowledgePage?: (input: {
    noteId?: string;
    spaceId: string;
    sourceId: string;
    versionId: string;
    quote: string;
    anchorChunkId?: string;
    anchorPage?: number;
  }) => string;
  onAsk: (
    request: AnswerRequest,
    signal: AbortSignal,
    onProgress?: OnAnswerProgress,
  ) => Promise<AnswerResult>;
  /** Opens a wide-screen picker for a second source in the same learning space. */
  onStartComparison?: () => void;
  onOpenSource: (id: string, versionId?: string, citation?: Citation) => void;
  onRefreshWeb?: (candidate: Source, expectedVersionId: string) => void | Promise<void>;
  onReplaceFile?: (candidate: Source, blob: Blob, expectedVersionId: string) => Promise<void>;
  onRestoreVersion?: (versionId: string, expectedCurrentVersionId: string) => void | Promise<void>;
  onPreviewRemoveVersion?: (versionId: string) => Promise<SourceVersionPurgePreview>;
  onRemoveVersion?: (versionId: string, preview: SourceVersionPurgePreview) => Promise<void>;
  onBack: () => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  /** Names the temporary destination when the reader was opened to review source evidence. */
  backLabel?: string;
  /** Opens the learner's account and settings from the phone bottom navigation. */
  onOpenSettings?: () => void;
  /**
   * Selects the phone reader presentation. `auto` detects Android after the
   * client mounts; an explicit value is useful for embedded shells and QA.
   */
  mobilePlatform?: "auto" | "default" | "android";
  getSourceBlob: (source: Source) => Promise<Blob | undefined>;
  initialCitation?: Citation;
  onCitationConsumed?: () => void;
  initialRegion?: ReaderRegionTarget;
  onRegionConsumed?: () => void;
  /** Opens a specific retained thread when navigation came from the question queue. */
  initialConversationId?: string;
}

export type SelectionToolbarPosition = {
  left: number;
  top: number;
  placement: "above" | "below";
};

export type ReaderSearchResult = {
  query: string;
  count: number;
  index: number;
};

export type ExcerptKnowledgeTarget = {
  quote: string;
  sourceId: string;
  versionId: string;
  anchorChunkId?: string;
  anchorPage?: number;
};
