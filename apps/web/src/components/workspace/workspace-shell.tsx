"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, Cloud, History, Loader2, X } from "lucide-react";
import { useWorkspace } from "@/lib/use-workspace";
import { addWebSource } from "@/lib/web-import";
import {
  getSourceVersion,
  refreshWebSource,
  restoreArchivedSourceVersion,
} from "@/lib/source-versions";
import CloudUpdateNotice from "../cloud-update-notice";
import { exportWorkspace, type ExportIssue, type ExportProgress } from "@/lib/export";
import { workspaceExportFingerprint, type WorkspaceExportScope } from "@/lib/export-scope";
import ExportBackupPanel from "../export-backup-panel";
import SourcePurgeModal from "../source-purge-modal";
import BulkSourceTagsPanel from "../bulk-source-tags-panel";
import BulkSourceActionsPanel from "../bulk-source-actions-panel";
import AccountAccessStopped from "../account-access-stopped";
import {
  permanentSourceDeletionFingerprint,
  previewPermanentSourceDeletionContent,
} from "@/lib/permanent-deletion";
import { isCloudConfigured, type SourcePurgePreview } from "@/lib/cloud";
import { createClient } from "@/lib/supabase/client";
import {
  primaryLearningContinuation,
  recentlyReadSources,
  unresolvedConversations,
} from "@/lib/learning-continue";
import { pinnedLibrarySources } from "@/lib/library-navigation";
import {
  formatLibraryRoute,
  normalizeLibraryTags,
  parseLibraryRoute,
  type LibraryFilter,
  type LibraryRoute,
} from "@/lib/library-route";
import {
  isCreatedWithinLibraryRange,
  libraryCreatedRange,
  type LibraryTimeFilter,
} from "@/lib/library-time-filter";
import { defaultLibrarySort, sortLibrarySources, type LibrarySort } from "@/lib/library-sort";
import {
  formatWorkspaceSectionRoute,
  isScopedWorkspaceSection,
  parseWorkspaceSectionRoute,
  type KnowledgeLibraryFilter,
} from "@/lib/workspace-section-route";
import {
  formatQuestionHistoryRoute,
  parseQuestionHistoryFilter,
  type QuestionHistoryFilter,
} from "@/lib/question-history";
import {
  formatComparisonRoute,
  parseComparisonRoute,
  type ComparisonRoute,
} from "@/lib/comparison-route";
import {
  formatConversationRoute,
  parseConversationRoute,
  resolveConversationRoute,
} from "@/lib/conversation-route";
import {
  resolveComparisonSources,
  type ComparisonSourcesUnavailableReason,
} from "@/lib/comparison-sources";
import {
  ComparisonAnswerRequestError,
  createComparisonAnswerRequest,
  validateComparisonAnswerRequest,
} from "@/lib/comparison-answer";
import { CROSS_LIBRARY_MAX_SOURCES, crossLibrarySourceEligibility } from "@/lib/cross-library-ask";
import { resolveKnowledgePageOriginalEvidence } from "@/lib/knowledge-page-evidence";
import {
  createAnnotation,
  removeAnnotation,
  sameAnnotationTextAnchor,
  updateAnnotation,
} from "@/lib/annotations";
import {
  discardRecoverableDraft,
  restoreSourceAndResolveDrafts,
  restoreSourceFromRecoverableDraft,
  saveRecoverableDraftAsNote,
} from "@/lib/recoverable-draft-actions";
import { persistConversation } from "@/lib/conversations";
import {
  deleteLearningSpace,
  learningSpaceDeletionFingerprint,
  previewLearningSpaceDeletion,
  type SpaceDeletionImpact,
} from "@/lib/space-lifecycle";
import type { Citation, Conversation, Note, Source, Space, WorkspaceData } from "@/lib/types";
import type { ReadingProgressSyncPlan } from "@/lib/sync-conflicts";
import { workspaceSyncPresentation } from "@/lib/workspace-sync-presentation";
import Modal from "../modal";
import { markdownToEditorHtml } from "@/lib/markdown";
import { appendAnswerToKnowledgePage } from "@/lib/answer-to-knowledge";
import {
  appendExcerptToKnowledgePage,
  createKnowledgePageFromExcerpt,
} from "@/lib/excerpt-to-knowledge";
import CollectionLibrary from "../collection-library";
import "../library-workspace.css";
import type { WorkspaceSearchAskDraft, WorkspaceSearchIntent } from "../workspace-search";
import type { RecoverableDraftItem } from "../recoverable-drafts-panel";
import type { SearchHit } from "@/lib/search-types";
import { knowledgeBlocks } from "@/lib/knowledge-update";
import { useKnowledgeUpdateReviewDrafts } from "@/lib/use-knowledge-update-review-drafts";
import { webReviewDraftStore } from "@/lib/web-review-draft-store";
import {
  applyOrganizationTags,
  undoOrganizationTags,
  saveOrganizationPage,
  ignoreOrganizationPage,
  dismissOrganizationJob,
} from "@/lib/organization-review";
import { knowledgeAcceptanceReason } from "@/lib/organization";
import {
  isOrganizationProcessorEnabled,
  organizationProcessorStateFromEnvironment,
} from "@/lib/organization-processor-capability";
import { applyKnowledgeUpdate, ignoreKnowledgeChange } from "@/lib/knowledge-update";
import {
  persistKnowledgeUpdateWithdrawal,
  type KnowledgeUpdateWithdrawalOperationContext,
} from "@/lib/knowledge-update-withdrawal-operation";
import { reviseNote } from "@/lib/note-versions";
import {
  acceptRelationProposal,
  ignoreRelationProposal,
  saveConceptRelation,
  deleteConceptRelation,
  restoreConceptRelation,
} from "@/lib/concept-relations";
import { inboxSpace, isUntouchedStarterWorkspace, normalizedTag, plain } from "./shared";
import RecognizedContentPanel from "./panels/recognized-content-panel";
import AnonymousWorkspaceMigrationNotice from "./anonymous-workspace-migration-notice";
import { ReadingProgressConflictModal } from "./modals/reading-progress-conflict-modal";
import SyncConflictModal from "./modals/sync-conflict-modal";
import ConversationHistoryModal from "./modals/conversation-history-modal";
import DeleteSpaceModal from "./modals/delete-space-modal";
import { ImportModal } from "./modals/import-modal";
import SourceDetailsModal from "./modals/source-details-modal";
import ExportResultModal from "./modals/export-result-modal";
import SpaceCreationModal from "./modals/space-creation-modal";
import ComparisonSourceModal from "./modals/comparison-source-modal";
import NoteHistoryModal from "./modals/note-history-modal";
import HomeSection from "./sections/home-section";
import KnowledgeSection from "./sections/knowledge-section";
import LibrarySection from "./sections/library-section";
import NotesSection from "./sections/notes-section";
import QuestionsSection from "./sections/questions-section";
import SettingsSection from "./sections/settings-section";
import TrashSection from "./sections/trash-section";
import {
  AccountPanel,
  BackupRestorePanel,
  ComparisonReader,
  ConceptRelationsPanel,
  KnowledgeEvidenceAskPanel,
  KnowledgeUpdatePanel,
  LegacyBrowserRecoveryPanel,
  OrganizationPanel,
  Reader,
  TaskCenterPanel,
} from "./lazy-panels";
import type { CrossLibrarySearchDraft, NoteSearchTarget } from "./types";
import NotePage from "./note-page/note-page";
import { labels, spaceTabs, type Section, type SpaceTab } from "./navigation";
import WorkspaceSidebar from "./sidebar";
import WorkspaceTopbar from "./topbar";

type ReaderReturnTarget =
  | { kind: "knowledge-update"; noteId: string }
  | {
      kind: "recognized-content";
      sourceId: string;
      versionId: string;
      libraryRoute: LibraryRoute;
    };
type RecognizedContentReturnTarget = Extract<ReaderReturnTarget, { kind: "recognized-content" }>;

function currentLibraryReturnRoute(hash: string): LibraryRoute {
  return (
    parseLibraryRoute(hash) || {
      spaceId: "all",
      files: false,
      filter: "all",
      time: "all",
      sort: defaultLibrarySort,
      layout: "list",
      query: "",
    }
  );
}

function replaceWithLibraryRoute(route: LibraryRoute): void {
  window.history.replaceState(null, "", formatLibraryRoute(route));
}

const comparisonUnavailableCopy: Record<ComparisonSourcesUnavailableReason, string> = {
  "same-source": "对照阅读需要两份不同的资料。",
  "space-missing": "这个知识库已不存在，不能继续打开对照阅读。",
  "space-archived": "这个知识库已归档，不能继续打开对照阅读。",
  "source-missing": "其中一份资料已被彻底删除，不能用其他资料替代它。",
  "source-recycled": "其中一份资料已在回收站，恢复后才能继续对照阅读。",
  "source-not-in-space": "其中一份资料已不属于这个知识库，不能继续对照阅读。",
  "version-missing": "其中一份指定版本未保留，不能用当前版本替代它。",
};

export default function Workspace({
  storageMode = "hybrid",
}: { storageMode?: "hybrid" | "cloud" } = {}) {
  const store = useWorkspace({ storageMode });
  const durableProcessorState = organizationProcessorStateFromEnvironment();
  const durableProcessorEnabled = isOrganizationProcessorEnabled(durableProcessorState);
  const { signOut: safeSignOut, signOutState } = store;
  const completeLocalSignOut = useCallback(async () => {
    const { error } = await createClient().auth.signOut({ scope: "local" });
    if (error) throw error;
  }, []);
  const signOutControl = useMemo(
    () => ({
      state: signOutState,
      signOut: () => safeSignOut("direct", completeLocalSignOut),
      syncAndSignOut: () => safeSignOut("sync", completeLocalSignOut),
      keepLocalDraftAndSignOut: () => safeSignOut("local", completeLocalSignOut),
    }),
    [completeLocalSignOut, safeSignOut, signOutState],
  );
  const {
    anonymousMigration,
    data,
    error,
    localCacheMode,
    accountDeletionState,
    accountAccessVerificationFailed,
    update,
    updateDurably,
    ready,
    status,
    user,
  } = store;
  const cloudReadOnly = localCacheMode === "cloud-readonly";
  const migrationChoicePending =
    anonymousMigration?.kind === "pending" || anonymousMigration?.kind === "migrating";
  const cloudConfigured = isCloudConfigured();
  const [section, setSection] = useState<Section>("home");
  const [spaceId, setSpaceId] = useState("all");
  const [questionHistoryFilter, setQuestionHistoryFilter] = useState<QuestionHistoryFilter>("all");
  const [knowledgeFilter, setKnowledgeFilter] = useState<KnowledgeLibraryFilter>("all");
  const [libraryFiles, setLibraryFiles] = useState(false);
  const [crossLibraryAsk, setCrossLibraryAsk] = useState<{ conversationId?: string } | null>(null);
  const [crossLibrarySearchDraft, setCrossLibrarySearchDraft] =
    useState<CrossLibrarySearchDraft | null>(null);
  const [crossLibraryAskPanelKey, setCrossLibraryAskPanelKey] = useState("cross-library-ask");
  const [crossLibraryAskBusy, setCrossLibraryAskBusy] = useState(false);
  const [pendingNoteCitation, setPendingNoteCitation] = useState<Citation | undefined>();
  const [pendingConversationId, setPendingConversationId] = useState<string | null>(null);
  const [pendingComparisonConversationId, setPendingComparisonConversationId] = useState<
    string | null
  >(null);
  const [conversationRouteId, setConversationRouteId] = useState<string | null>(null);
  const [conversationRouteIssue, setConversationRouteIssue] = useState("");
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [sourceVersionId, setSourceVersionId] = useState<string | null>(null);
  const [comparisonRoute, setComparisonRoute] = useState<ComparisonRoute | null>(null);
  const [comparisonTargetId, setComparisonTargetId] = useState("");
  const [noteId, setNoteId] = useState<string | null>(null);
  const [noteLibraryReturn, setNoteLibraryReturn] = useState<{
    noteId: string;
    token: number;
    userId: string | null;
    route: LibraryRoute;
  } | null>(null);
  const [noteSearchTarget, setNoteSearchTarget] = useState<NoteSearchTarget>();
  const [readerReturnTarget, setReaderReturnTarget] = useState<ReaderReturnTarget | null>(null);
  const readerReturnTargetRef = useRef<ReaderReturnTarget | null>(null);
  const knowledgeUpdateDraftOwner = user?.id || "local";
  const knowledgeUpdateDraftOwnerRef = useRef(knowledgeUpdateDraftOwner);
  const knowledgeUpdateDrafts = useKnowledgeUpdateReviewDrafts(
    knowledgeUpdateDraftOwner,
    data,
    ready,
    storageMode === "cloud" ? webReviewDraftStore : undefined,
  );
  const [knowledgeUpdateOpen, setKnowledgeUpdateOpen] = useState(false);
  const [conceptRelationsOpen, setConceptRelationsOpen] = useState(false);
  const [knowledgeEvidenceAskOpen, setKnowledgeEvidenceAskOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchIntent, setSearchIntent] = useState<WorkspaceSearchIntent>("keyword");
  const [collectionSearch, setCollectionSearch] = useState("");
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [timeFilter, setTimeFilter] = useState<LibraryTimeFilter>("all");
  const [sort, setSort] = useState<LibrarySort>(defaultLibrarySort);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagFilterOpen, setTagFilterOpen] = useState(false);
  const [layout, setLayout] = useState<"grid" | "list">("list");
  const [sidebar, setSidebar] = useState(false);
  const [modal, setModal] = useState<
    | "import"
    | "space"
    | "account"
    | "details"
    | "recognized-content"
    | "history"
    | "compare-source"
    | "bulk-tags"
    | "bulk-spaces"
    | "bulk-recycle"
    | "export"
    | "export-result"
    | "restore"
    | "legacy-recovery"
    | "delete-space"
    | "purge-source"
    | "conversation-history"
    | "sync-conflict"
    | null
  >(null);
  const [readingPositionResolutionEpoch, setReadingPositionResolutionEpoch] = useState(0);
  const [readingConflictPlanSnapshot, setReadingConflictPlanSnapshot] =
    useState<ReadingProgressSyncPlan | null>(null);
  const readingConflictResolving = useRef(false);
  const latestReadingProgressSyncPlan = useRef(store.readingProgressSyncPlan);
  const [spaceCreationIntent, setSpaceCreationIntent] = useState<"browse" | "import">("browse");
  const [importTargetSpaceId, setImportTargetSpaceId] = useState<string | null>(null);
  const [spaceToDeleteId, setSpaceToDeleteId] = useState<string | null>(null);
  const [sourceToPurgeId, setSourceToPurgeId] = useState<string | null>(null);
  const sourcePurgeOperation = useRef<object | null>(null);
  const accessStopBoundary = useRef<string | null>(null);
  const sourcePurgeContext = useRef<{
    token: number;
    userId: string | null;
    localCacheMode: typeof localCacheMode;
    modal: typeof modal;
    sourceId: string | null;
  } | null>({
    token: store.token,
    userId: user?.id ?? null,
    localCacheMode,
    modal,
    sourceId: sourceToPurgeId,
  });
  const [conversationToInspectId, setConversationToInspectId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const bulkWriteIdentity = useMemo(
    () => ({
      token: store.token,
      userId: user?.id ?? null,
      localCacheMode,
      ready,
      modal,
      sourceIds: selected,
    }),
    [store.token, user?.id, localCacheMode, ready, modal, selected],
  );
  const bulkWriteContext = useRef<typeof bulkWriteIdentity | null>(null);
  useLayoutEffect(() => {
    bulkWriteContext.current = bulkWriteIdentity;
    return () => {
      bulkWriteContext.current = null;
    };
  }, [bulkWriteIdentity]);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [exportIssues, setExportIssues] = useState<ExportIssue[] | null>(null);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportScope, setExportScope] = useState<WorkspaceExportScope>({ kind: "workspace" });
  const exportOperation = useRef<object | null>(null);
  const exportContext = useRef<{
    token: number;
    userId: string | null;
    localCacheMode: typeof localCacheMode;
    ready: boolean;
    data: WorkspaceData;
  } | null>({ token: store.token, userId: user?.id ?? null, localCacheMode, ready, data });
  const [editorKey, setEditorKey] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const tagFilterRef = useRef<HTMLDivElement>(null);
  const latestSources = useRef(data.sources);
  const currentLibraryViewRoute = useMemo<LibraryRoute>(
    () => ({
      spaceId,
      files: libraryFiles,
      filter,
      time: timeFilter,
      sort,
      layout,
      query: libraryFiles ? search : collectionSearch,
      ...(selectedTags.length ? { tags: selectedTags } : {}),
      ...(crossLibraryAsk ? { crossLibraryAsk } : {}),
    }),
    [
      collectionSearch,
      crossLibraryAsk,
      filter,
      layout,
      libraryFiles,
      search,
      selectedTags,
      sort,
      spaceId,
      timeFilter,
    ],
  );
  const latestLibraryViewRoute = useRef(currentLibraryViewRoute);
  const handledInvalidSourceRoute = useRef<string | null>(null);
  const pendingSearchFocus = useRef(false);
  const activeSessionToken = useRef<number | null>(store.token);
  const appliedConversationRoute = useRef<string | null>(null);
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const restoreRecognizedContentTarget = useCallback(
    (target: RecognizedContentReturnTarget, sources: readonly Source[]) => {
      const source = sources.find((item) => item.id === target.sourceId && !item.deletedAt);
      if (!source) {
        setModal(null);
        setToast("这份资料已删除或不可用，无法返回刚才的已识别内容。");
        return false;
      }
      setDetailId(source.id);
      if (source.versionId !== target.versionId) {
        setModal("details");
        setToast("这份资料已有新版本，刚才的已识别内容未重新打开；请在当前资料详情中重新核对。");
        return true;
      }
      setModal("recognized-content");
      return true;
    },
    [setDetailId, setModal, setToast],
  );
  const activeSpace = data.spaces.find((s) => s.id === spaceId);
  const currentSource = data.sources.find((s) => s.id === sourceId && !s.deletedAt);
  const readingSource =
    currentSource &&
    (sourceVersionId === null ? currentSource : getSourceVersion(currentSource, sourceVersionId));
  const comparisonResolution = comparisonRoute
    ? resolveComparisonSources(data, comparisonRoute)
    : null;
  const comparisonAskUnavailableReason = (() => {
    if (!comparisonResolution?.ok) return "对照资料已变化，请重新打开后再提问。";
    if (!data.aiEnabled) return "资料问答已关闭，请先在设置中开启。";
    try {
      createComparisonAnswerRequest({ ...comparisonResolution, question: "检查对照问答范围" });
      return undefined;
    } catch (cause) {
      return cause instanceof ComparisonAnswerRequestError
        ? cause.message
        : "对照资料当前不能用于 AI 问答，请重新确认资料范围。";
    }
  })();
  const currentNote = data.notes.find((n) => n.id === noteId && !n.deletedAt);
  const knowledgeWithdrawalContext = useRef<KnowledgeUpdateWithdrawalOperationContext | null>(null);
  useLayoutEffect(() => {
    knowledgeWithdrawalContext.current = {
      token: store.token,
      userId: user?.id ?? null,
      localCacheMode,
      ready,
      data,
      noteId:
        knowledgeUpdateOpen && !sourceId && currentNote?.kind === "knowledge"
          ? currentNote.id
          : null,
    };
  }, [
    store.token,
    user?.id,
    localCacheMode,
    ready,
    data,
    knowledgeUpdateOpen,
    sourceId,
    currentNote,
  ]);
  useLayoutEffect(
    () => () => {
      knowledgeWithdrawalContext.current = null;
    },
    [],
  );
  const recoverableDraftItems = useMemo<RecoverableDraftItem[]>(
    () =>
      (data.recoverableDrafts ?? []).map((draft) => ({
        id: draft.id,
        sourceId: draft.sourceId,
        title: draft.note.trim().split(/\r?\n/u)[0]?.slice(0, 80) || "离线批注",
        content: draft.note,
        sourceTitle: draft.sourceTitle,
        sourceDeletedAt: draft.sourceDeletedAt,
        updatedAt: draft.capturedAt,
        kind: "annotation",
        excerpt: draft.quote,
        ...(draft.page !== undefined ? { location: `第 ${draft.page} 页` } : {}),
      })),
    [data.recoverableDrafts],
  );
  const knowledgeEvidence =
    currentNote?.kind === "knowledge"
      ? resolveKnowledgePageOriginalEvidence(data, currentNote)
      : undefined;
  const acceptanceReason =
    currentNote?.status === "draft" ? knowledgeAcceptanceReason(data, currentNote) : "";
  const isCollectionHome =
    section === "library" &&
    spaceId === "all" &&
    !libraryFiles &&
    !currentSource &&
    !currentNote &&
    !comparisonRoute;
  const isLibraryWorkspace =
    !currentSource &&
    !currentNote &&
    !comparisonRoute &&
    ["library", "notes", "knowledge"].includes(section);
  const isReadingWorkspace = Boolean(currentSource && readingSource) || Boolean(comparisonRoute);
  const isSpaceWorkspace = Boolean(
    activeSpace &&
    !currentSource &&
    !currentNote &&
    !comparisonRoute &&
    (["home", "library", "knowledge", "questions"] as Section[]).includes(section),
  );
  const libraryTitle = isCollectionHome
    ? "资料库"
    : spaceId === "inbox"
      ? "收件箱"
      : activeSpace?.name || "全部资料";
  const detail = data.sources.find((s) => s.id === detailId);
  const spaceToDelete = data.spaces.find((space) => space.id === spaceToDeleteId);
  const sourceToPurge = data.sources.find((source) => source.id === sourceToPurgeId);
  const sourcePurgeReviewKey = useMemo(() => {
    if (modal !== "purge-source" || !sourceToPurge?.deletedAt) return "";
    const content = previewPermanentSourceDeletionContent(data, sourceToPurge.id);
    return permanentSourceDeletionFingerprint(data, sourceToPurge.id, {
      noteIds: content.notes.map((note) => note.id),
      conversationIds: content.conversations.map((conversation) => conversation.id),
    });
  }, [data, modal, sourceToPurge]);
  const conversationToInspect = conversationToInspectId
    ? data.conversations.find((conversation) => conversation.id === conversationToInspectId)
    : undefined;
  const visibleSources = data.sources.filter(
    (s) =>
      !s.deletedAt &&
      (spaceId === "all" || spaceId === "inbox"
        ? spaceId !== "inbox" || !s.spaceIds.length
        : s.spaceIds.includes(spaceId)),
  );
  const availableTags = useMemo(() => {
    const seen = new Map<string, string>();
    for (const source of visibleSources)
      for (const tag of source.tags) {
        const value = normalizeLibraryTags([tag])[0];
        if (!value) continue;
        const key = normalizedTag(value);
        if (!seen.has(key)) seen.set(key, value);
      }
    return [...seen.values()].sort((left, right) => left.localeCompare(right, "zh-CN"));
  }, [visibleSources]);
  const primaryContinuation = primaryLearningContinuation(data, spaceId);
  const continuedSources = recentlyReadSources(data, spaceId);
  const secondaryContinuedSources = primaryContinuation
    ? continuedSources.filter((source) => source.id !== primaryContinuation.source.id)
    : continuedSources;
  const pendingQuestions = unresolvedConversations(data, spaceId, data.conversations.length)
    .filter((conversation) => conversation.id !== primaryContinuation?.conversation?.id)
    .slice(0, 3);
  const pinnedSources = pinnedLibrarySources(data.sources, 2);
  const activeTaskCount =
    (data.importJobs ?? []).filter((job) => job.status === "queued" || job.status === "running")
      .length +
    (data.organizationJobs ?? []).filter(
      (job) => job.status === "queued" || job.status === "running",
    ).length;
  const matches = (text: string) =>
    text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const createdRange = useMemo(() => libraryCreatedRange(timeFilter), [timeFilter]);
  const derivedLibraryFilter = filter === "note" || filter === "knowledge";
  const filteredSources = sortLibrarySources(
    visibleSources.filter(
      (s) =>
        (filter === "all" || (filter === "starred" && s.starred) || filter === s.kind) &&
        isCreatedWithinLibraryRange(s.createdAt, createdRange) &&
        selectedTags.every((tag) =>
          s.tags.some((sourceTag) => normalizedTag(sourceTag) === normalizedTag(tag)),
        ) &&
        matches(`${s.title} ${s.tags.join(" ")} ${s.text}`),
    ),
    sort,
  );
  const searchExternalFilters =
    filter === "all" && timeFilter === "all" && !selectedTags.length
      ? undefined
      : {
          ...(filter !== "all" && filter !== "starred" ? { types: [filter] } : {}),
          ...(selectedTags.length ? { tags: selectedTags } : {}),
          ...(filter === "starred" ? { starred: true } : {}),
          ...(createdRange ? { created: createdRange } : {}),
        };
  const scopedNotes = data.notes.filter(
    (n) => !n.deletedAt && (spaceId === "all" || n.spaceId === spaceId),
  );
  const notes = scopedNotes.filter(
    (n) => n.kind === "note" && matches(`${n.title} ${plain(n.content)}`),
  );
  const knowledgePageCount = scopedNotes.filter((note) => note.kind === "knowledge").length;
  const sourceSpace: Space =
    data.spaces.find((space) => space.id === spaceId) ||
    data.spaces.find((space) => currentSource?.spaceIds.includes(space.id)) ||
    inboxSpace;
  const comparisonPickerSpace =
    data.spaces.find(
      (space) =>
        !space.archived &&
        space.id === sourceSpace.id &&
        Boolean(currentSource?.spaceIds.includes(space.id)),
    ) ||
    data.spaces.find(
      (space) => !space.archived && Boolean(currentSource?.spaceIds.includes(space.id)),
    );
  const comparisonCandidates =
    currentSource && readingSource && comparisonPickerSpace
      ? data.sources.filter(
          (source) =>
            !source.deletedAt &&
            source.id !== currentSource.id &&
            source.spaceIds.includes(comparisonPickerSpace.id),
        )
      : [];
  const saveLabel =
    accountDeletionState || accountAccessVerificationFailed
      ? "资料访问已暂停"
      : cloudReadOnly
        ? "仅可查看云端资料"
        : {
            loading: "正在载入",
            saving: "正在保存…",
            local: storageMode === "cloud" ? "等待云端保存" : "已保存在此浏览器",
            cloud: "已保存到云端",
            error: "保存需要处理",
            conflict: "存在版本冲突",
          }[status];
  const settingsSyncPresentation = workspaceSyncPresentation({
    storageMode,
    status,
    error,
    cloudConfigured,
    signedIn: Boolean(user),
    cloudReadOnly,
    migrationPending: migrationChoicePending,
    purging: store.purging,
  });

  const retryWorkspace = () => {
    void Promise.resolve()
      .then(() => store.retry())
      .catch((cause) =>
        setToast(cause instanceof Error ? cause.message : "重新连接未完成，请重试。"),
      );
  };

  const loadLatestWorkspace = () => {
    void Promise.resolve()
      .then(() => store.loadLatestLocal((snapshot) => doExport(snapshot)))
      .then((preservedLocalChanges) =>
        setToast(
          preservedLocalChanges
            ? "已载入其他标签页的最新数据；本页修改已下载为可恢复备份。"
            : "已载入其他标签页的最新数据。",
        ),
      )
      .catch((cause) =>
        setToast(cause instanceof Error ? cause.message : "最新数据未能载入，请重试。"),
      );
  };

  const openSyncConflict = () => {
    if (store.readingProgressSyncPlan) {
      setReadingConflictPlanSnapshot(structuredClone(store.readingProgressSyncPlan));
    } else {
      setReadingConflictPlanSnapshot(null);
    }
    setModal("sync-conflict");
  };

  const clearConversationRouteState = useCallback(() => {
    setConversationRouteId(null);
    setConversationRouteIssue("");
    setPendingConversationId(null);
    setPendingComparisonConversationId(null);
    setConversationToInspectId(null);
    // Browser back/forward can remove a history-only route without using the
    // dialog's close button. Clear only this hidden dialog state so keyboard
    // actions such as Cmd/Ctrl+K are not left permanently blocked.
    setModal((current) => (current === "conversation-history" ? null : current));
  }, [setConversationToInspectId, setModal]);

  const applyLibraryRouteState = useCallback(
    (route: LibraryRoute) => {
      clearConversationRouteState();
      setSection("library");
      setSpaceId(route.spaceId);
      setLibraryFiles(route.files);
      setFilter(route.filter);
      if (route.filter === "note" || route.filter === "knowledge") setSearchIntent("keyword");
      setTimeFilter(route.time);
      setSort(route.sort);
      setLayout(route.layout);
      setSelectedTags(normalizeLibraryTags(route.tags));
      setSearch(route.files ? route.query : "");
      setCollectionSearch(route.files ? "" : route.query);
      setCrossLibraryAsk(route.crossLibraryAsk ?? null);
      setCrossLibrarySearchDraft(null);
      setComparisonRoute(null);
      setComparisonTargetId("");
      setSourceId(null);
      setSourceVersionId(null);
      setNoteId(null);
      setNoteLibraryReturn(null);
      setSelected([]);
      setSidebar(false);
    },
    [
      clearConversationRouteState,
      setComparisonTargetId,
      setCrossLibrarySearchDraft,
      setSearch,
      setSearchIntent,
      setSelected,
      setSpaceId,
    ],
  );

  const recoverUnavailableSourceRoute = useCallback(
    (invalidHash: string) => {
      if (location.hash !== invalidHash) return;

      handledInvalidSourceRoute.current = invalidHash;
      const target = readerReturnTargetRef.current;
      const returnRoute =
        target?.kind === "recognized-content"
          ? target.libraryRoute
          : latestLibraryViewRoute.current;

      readerReturnTargetRef.current = null;
      setReaderReturnTarget(null);
      setPendingNoteCitation(undefined);
      setPendingConversationId(null);
      setDetailId(null);
      setModal(null);
      applyLibraryRouteState(returnRoute);
      setToast(
        target?.kind === "recognized-content"
          ? "这份资料已删除或不可用，无法返回刚才的已识别内容。"
          : "这份资料已删除、不存在或当前账号无权访问，已返回资料库。",
      );
      replaceWithLibraryRoute(returnRoute);
    },
    [applyLibraryRouteState, setDetailId, setModal, setPendingNoteCitation, setToast],
  );

  function replaceLibraryView(
    patch: Partial<
      Pick<
        LibraryRoute,
        "filter" | "time" | "sort" | "layout" | "query" | "tags" | "crossLibraryAsk"
      >
    >,
  ) {
    const next: LibraryRoute = {
      spaceId,
      files: libraryFiles,
      filter,
      time: timeFilter,
      sort,
      layout,
      query: libraryFiles ? search : collectionSearch,
      ...(selectedTags.length ? { tags: selectedTags } : {}),
      ...(crossLibraryAsk ? { crossLibraryAsk } : {}),
      ...patch,
    };
    setFilter(next.filter);
    if (next.filter === "note" || next.filter === "knowledge") setSearchIntent("keyword");
    setTimeFilter(next.time);
    setSort(next.sort);
    setLayout(next.layout);
    setSelectedTags(normalizeLibraryTags(next.tags));
    if (next.files) {
      setSearch(next.query);
      setCollectionSearch("");
    } else {
      setCollectionSearch(next.query);
      setSearch("");
    }
    setCrossLibraryAsk(next.crossLibraryAsk ?? null);
    window.history.replaceState(null, "", formatLibraryRoute(next));
  }

  function setActiveCrossLibraryConversation(
    conversationId?: string,
    searchDraft: CrossLibrarySearchDraft | null = null,
  ) {
    const next: LibraryRoute = {
      spaceId: "all",
      files: true,
      filter,
      time: timeFilter,
      sort,
      layout,
      query: search,
      ...(selectedTags.length ? { tags: selectedTags } : {}),
      crossLibraryAsk: conversationId ? { conversationId } : {},
    };
    clearConversationRouteState();
    setSection("library");
    setSpaceId(next.spaceId);
    setLibraryFiles(next.files);
    setCrossLibraryAsk(next.crossLibraryAsk ?? {});
    setCrossLibrarySearchDraft(searchDraft);
    setTimeFilter(next.time);
    setSort(next.sort);
    setSelectedTags(normalizeLibraryTags(next.tags));
    const route = formatLibraryRoute(next);
    if (location.hash !== route) window.history.pushState(null, "", route);
  }

  function openQuestionSearchDraft(draft: WorkspaceSearchAskDraft) {
    if (crossLibraryAskBusy) {
      setToast("当前回答仍在生成，请先等待完成或在问答面板中停止。");
      return;
    }
    const question = draft.question.trim();
    const sourceIds = [...new Set(draft.sourceIds)];
    const sources = sourceIds.map((id) => data.sources.find((source) => source.id === id));
    const valid =
      data.aiEnabled &&
      Boolean(question) &&
      sourceIds.length > 0 &&
      sourceIds.length <= CROSS_LIBRARY_MAX_SOURCES &&
      sourceIds.length === draft.sourceIds.length &&
      sources.every((source) => source && crossLibrarySourceEligibility(data, source).available);

    if (!valid) {
      setToast("资料状态或问答权限已变化，请重新核对搜索结果。");
      return;
    }

    const id = crypto.randomUUID();
    setCrossLibraryAskPanelKey(id);
    setActiveCrossLibraryConversation(undefined, {
      id,
      question,
      sourceIds,
    });
  }

  useEffect(() => {
    activeSessionToken.current = store.token;
    return () => {
      activeSessionToken.current = null;
    };
  }, [store.token]);
  useLayoutEffect(() => {
    const boundary =
      accountDeletionState || accountAccessVerificationFailed
        ? `${store.token}:${accountDeletionState ?? "verification-failed"}`
        : null;
    const changed = boundary !== accessStopBoundary.current;
    accessStopBoundary.current = boundary;
    if (!boundary || !changed) return;
    // Close reviews before paint and drop account-specific transient buffers.
    // Keep the account panel mounted so its captured deletion can finish safely.
    sourcePurgeOperation.current = null;
    exportOperation.current = null;
    setModal((current) => (current === "account" ? current : null));
    setSearch("");
    setCollectionSearch("");
    setSelectedTags([]);
    setTagFilterOpen(false);
    setSelected([]);
    setNoteSearchTarget(undefined);
    setReadingConflictPlanSnapshot(null);
    setExportIssues(null);
    setExportProgress(null);
    setToast("");
    setBusy(false);
    setExporting(false);
  }, [accountDeletionState, accountAccessVerificationFailed, store.token]);
  useLayoutEffect(() => {
    const previous = sourcePurgeContext.current;
    const current = {
      token: store.token,
      userId: user?.id ?? null,
      localCacheMode,
      modal,
      sourceId: sourceToPurgeId,
    };
    if (
      previous &&
      (previous.token !== current.token ||
        previous.userId !== current.userId ||
        previous.localCacheMode !== current.localCacheMode ||
        previous.modal !== current.modal ||
        previous.sourceId !== current.sourceId)
    )
      sourcePurgeOperation.current = null;
    sourcePurgeContext.current = current;
  }, [store.token, user?.id, localCacheMode, modal, sourceToPurgeId]);
  useLayoutEffect(
    () => () => {
      sourcePurgeContext.current = null;
      sourcePurgeOperation.current = null;
    },
    [],
  );
  useLayoutEffect(() => {
    const previous = exportContext.current;
    const userId = user?.id ?? null;
    const contextChanged =
      previous &&
      (previous.token !== store.token ||
        previous.userId !== userId ||
        previous.localCacheMode !== localCacheMode ||
        previous.ready !== ready);
    exportContext.current = { token: store.token, userId, localCacheMode, ready, data };
    if (contextChanged) {
      // Invalidate the old account's external download transaction before paint.
      setModal((current) => (current === "export" || current === "export-result" ? null : current));
      if (exportOperation.current) {
        exportOperation.current = null;
        setBusy(false);
        setExporting(false);
        setExportProgress(null);
      }
      setExportIssues(null);
    }
  }, [store.token, user?.id, localCacheMode, ready, data]);
  useLayoutEffect(
    () => () => {
      exportContext.current = null;
      exportOperation.current = null;
    },
    [],
  );
  useEffect(() => {
    latestSources.current = data.sources;
  }, [data.sources]);
  useEffect(() => {
    if (section === "library" && !sourceId)
      latestLibraryViewRoute.current = currentLibraryViewRoute;
  }, [currentLibraryViewRoute, section, sourceId]);
  useEffect(() => {
    readerReturnTargetRef.current = readerReturnTarget;
  }, [readerReturnTarget]);
  useEffect(() => {
    if (!ready || !sourceId || currentSource) {
      if (!sourceId || currentSource) handledInvalidSourceRoute.current = null;
      return;
    }

    const [path] = location.hash.slice(1).split("?");
    const [type, routeSourceId] = path.split("/");
    if (type !== "source" || routeSourceId !== sourceId) return;
    if (handledInvalidSourceRoute.current === location.hash) return;
    recoverUnavailableSourceRoute(location.hash);
  }, [currentSource, ready, recoverUnavailableSourceRoute, sourceId]);
  useEffect(() => {
    latestReadingProgressSyncPlan.current = store.readingProgressSyncPlan;
  }, [store.readingProgressSyncPlan]);
  useEffect(() => {
    if (knowledgeUpdateDraftOwnerRef.current === knowledgeUpdateDraftOwner) return;
    knowledgeUpdateDraftOwnerRef.current = knowledgeUpdateDraftOwner;
    setReaderReturnTarget(null);
  }, [knowledgeUpdateDraftOwner]);
  const openAllSourcesSearch = useCallback(() => {
    if (modal) return;
    pendingSearchFocus.current = true;
    setSearchFocusRequest((request) => request + 1);
    setComparisonRoute(null);
    setComparisonTargetId("");
    setLibraryFiles(true);
    setCrossLibraryAsk(null);
    setFilter("all");
    setTimeFilter("all");
    setSort(defaultLibrarySort);
    setSelectedTags([]);
    setSection("library");
    clearConversationRouteState();
    setSourceId(null);
    setNoteId(null);
    setSelected([]);
    setNoteLibraryReturn(null);
    setSearch("");
    setCollectionSearch("");
    setSidebar(false);
    window.history.pushState(
      null,
      "",
      formatLibraryRoute({
        spaceId,
        files: true,
        filter: "all",
        time: "all",
        sort: defaultLibrarySort,
        layout,
        query: "",
      }),
    );
  }, [
    clearConversationRouteState,
    layout,
    modal,
    setComparisonTargetId,
    setSearch,
    setSelected,
    spaceId,
  ]);

  useEffect(() => {
    if (!ready || modal || !pendingSearchFocus.current || !searchRef.current) return;
    searchRef.current.focus();
    pendingSearchFocus.current = false;
  }, [searchFocusRequest, ready, modal]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!tagFilterOpen) return;
    const closeOnOutsidePress = (event: MouseEvent) => {
      if (!tagFilterRef.current?.contains(event.target as Node)) setTagFilterOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTagFilterOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsidePress);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsidePress);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [tagFilterOpen]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openAllSourcesSearch();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [openAllSourcesSearch]);
  useEffect(() => {
    const route = () => {
      const [path] = location.hash.slice(1).split("?");
      const [type, id, view, version] = path.split("/");
      const libraryRoute = parseLibraryRoute(location.hash);
      const workspaceSectionRoute = parseWorkspaceSectionRoute(location.hash);
      const nextComparisonRoute = parseComparisonRoute(location.hash);
      const nextConversationRoute = parseConversationRoute(location.hash);
      if (type !== "source") {
        const returnTarget = readerReturnTargetRef.current;
        if (returnTarget?.kind === "recognized-content" && libraryRoute)
          restoreRecognizedContentTarget(returnTarget, latestSources.current);
        readerReturnTargetRef.current = null;
        setReaderReturnTarget(null);
      }
      setCrossLibraryAsk(null);
      setCrossLibrarySearchDraft(null);
      setPendingNoteCitation(undefined);
      setKnowledgeUpdateOpen(type === "note" && view === "update");
      setConceptRelationsOpen(type === "note" && view === "relations");
      setKnowledgeEvidenceAskOpen(false);
      if (nextConversationRoute) {
        setQuestionHistoryFilter("all");
        setConversationRouteId(nextConversationRoute.conversationId);
        setConversationRouteIssue("");
        setPendingConversationId(null);
        setPendingComparisonConversationId(null);
        setComparisonRoute(null);
        setComparisonTargetId("");
        setSourceId(null);
        setSourceVersionId(null);
        setNoteId(null);
        setSection("questions");
        setSidebar(false);
      } else if (type === "conversation") {
        setQuestionHistoryFilter("all");
        clearConversationRouteState();
        setComparisonRoute(null);
        setComparisonTargetId("");
        setSourceId(null);
        setSourceVersionId(null);
        setNoteId(null);
        setSection("questions");
        setSidebar(false);
        setConversationRouteIssue("这条问答记录不可用或不属于当前账号。");
      } else if (nextComparisonRoute) {
        clearConversationRouteState();
        setComparisonRoute(nextComparisonRoute);
        setSourceId(null);
        setSourceVersionId(null);
        setNoteId(null);
        setSection("library");
        setSpaceId(nextComparisonRoute.spaceId);
        setSidebar(false);
      } else if (type === "source" && id) {
        clearConversationRouteState();
        setModal((current) => (current === "recognized-content" ? null : current));
        setComparisonRoute(null);
        setSourceId(id);
        setSourceVersionId(view === "version" ? (version ?? "") : null);
        setNoteId(null);
      } else if (type === "source") {
        recoverUnavailableSourceRoute(location.hash);
      } else if (type === "note" && id) {
        clearConversationRouteState();
        setComparisonRoute(null);
        setNoteId(id);
        setSourceId(null);
      } else if (Object.hasOwn(labels, type)) {
        clearConversationRouteState();
        setComparisonRoute(null);
        setSection(type as Section);
        setSourceId(null);
        setNoteId(null);
        if (type === "library" && libraryRoute) {
          const parsedTags = normalizeLibraryTags(libraryRoute.tags);
          // A direct library link is handled before the workspace finishes
          // hydrating. Keep its parsed tags until source data is ready; an
          // empty bootstrap snapshot must not rewrite a valid deep link.
          const scopedTags = ready
            ? new Set(
                latestSources.current
                  .filter(
                    (source) =>
                      !source.deletedAt &&
                      (libraryRoute.spaceId === "all" || libraryRoute.spaceId === "inbox"
                        ? libraryRoute.spaceId !== "inbox" || !source.spaceIds.length
                        : source.spaceIds.includes(libraryRoute.spaceId)),
                  )
                  .flatMap((source) => source.tags.map(normalizedTag)),
              )
            : undefined;
          const routeTags = scopedTags
            ? parsedTags.filter((tag) => scopedTags.has(normalizedTag(tag)))
            : parsedTags;
          setSpaceId(libraryRoute.spaceId);
          setLibraryFiles(libraryRoute.files);
          setFilter(libraryRoute.filter);
          if (libraryRoute.filter === "note" || libraryRoute.filter === "knowledge")
            setSearchIntent("keyword");
          setTimeFilter(libraryRoute.time);
          setSort(libraryRoute.sort);
          setLayout(libraryRoute.layout);
          setSelectedTags(routeTags);
          setSearch(libraryRoute.files ? libraryRoute.query : "");
          setCollectionSearch(libraryRoute.files ? "" : libraryRoute.query);
          setCrossLibraryAsk(libraryRoute.crossLibraryAsk ?? null);
          setCrossLibrarySearchDraft(null);
          setSelected([]);
          setSidebar(false);
          if (ready && routeTags.length !== parsedTags.length)
            window.history.replaceState(
              null,
              "",
              formatLibraryRoute({ ...libraryRoute, tags: routeTags }),
            );
        } else if (workspaceSectionRoute) {
          setSpaceId(workspaceSectionRoute.spaceId);
          if (workspaceSectionRoute.section === "questions") {
            setQuestionHistoryFilter(parseQuestionHistoryFilter(location.hash));
            setSearch("");
            setKnowledgeFilter("all");
          } else if (workspaceSectionRoute.section === "knowledge") {
            setSearch(workspaceSectionRoute.query ?? "");
            setKnowledgeFilter(workspaceSectionRoute.knowledgeFilter ?? "all");
          } else {
            setSearch("");
            setKnowledgeFilter("all");
          }
        }
      } else if (type === "compare") {
        clearConversationRouteState();
        setComparisonRoute(null);
        setSourceId(null);
        setSourceVersionId(null);
        setNoteId(null);
        setSection("library");
        setToast("这个对照链接无效，已回到资料库。");
      }
    };
    route();
    window.addEventListener("hashchange", route);
    window.addEventListener("popstate", route);
    return () => {
      window.removeEventListener("hashchange", route);
      window.removeEventListener("popstate", route);
    };
  }, [
    clearConversationRouteState,
    ready,
    recoverUnavailableSourceRoute,
    restoreRecognizedContentTarget,
  ]);
  function navigate(
    next: Section,
    libraryTarget?: Pick<LibraryRoute, "spaceId" | "files" | "crossLibraryAsk">,
    nextSpaceId = spaceId,
  ) {
    const currentLibraryQuery = libraryFiles ? search : collectionSearch;
    const currentLibraryTags = selectedTags;
    const currentLibraryTime = timeFilter;
    const currentLibrarySort = sort;
    setKnowledgeUpdateOpen(false);
    setReaderReturnTarget(null);
    setConceptRelationsOpen(false);
    setKnowledgeEvidenceAskOpen(false);
    setComparisonRoute(null);
    setComparisonTargetId("");
    clearConversationRouteState();
    setSection(next);
    setSourceId(null);
    setNoteId(null);
    setNoteLibraryReturn(null);
    setSelected([]);
    setSearch("");
    setKnowledgeFilter("all");
    setCollectionSearch("");
    setSidebar(false);
    if (next === "library") {
      const target = libraryTarget || {
        spaceId,
        files: libraryFiles,
        ...(crossLibraryAsk ? { crossLibraryAsk } : {}),
      };
      const nextFilter = libraryTarget ? "all" : filter;
      const nextTimeFilter = libraryTarget ? "all" : currentLibraryTime;
      const nextSort = libraryTarget ? defaultLibrarySort : currentLibrarySort;
      const nextTags = libraryTarget ? [] : currentLibraryTags;
      const nextQuery = libraryTarget ? "" : currentLibraryQuery;
      setSpaceId(target.spaceId);
      setLibraryFiles(target.files);
      setCrossLibraryAsk(target.crossLibraryAsk ?? null);
      setFilter(nextFilter);
      setTimeFilter(nextTimeFilter);
      setSort(nextSort);
      setSelectedTags(nextTags);
      if (target.files) {
        setSearch(nextQuery);
        setCollectionSearch("");
      } else {
        setSearch("");
        setCollectionSearch(nextQuery);
      }
      window.history.pushState(
        null,
        "",
        formatLibraryRoute({
          spaceId: target.spaceId,
          files: target.files,
          filter: nextFilter,
          time: nextTimeFilter,
          sort: nextSort,
          layout,
          query: nextQuery,
          ...(nextTags.length ? { tags: nextTags } : {}),
          ...(target.crossLibraryAsk ? { crossLibraryAsk: target.crossLibraryAsk } : {}),
        }),
      );
    } else {
      setCrossLibraryAsk(null);
      if (isScopedWorkspaceSection(next)) {
        setSpaceId(nextSpaceId);
        if (next === "questions") {
          setQuestionHistoryFilter("all");
          window.history.pushState(null, "", formatQuestionHistoryRoute(nextSpaceId, "all"));
        } else {
          window.history.pushState(null, "", formatWorkspaceSectionRoute(next, nextSpaceId));
        }
      } else {
        window.history.pushState(null, "", `#${next}`);
      }
    }
  }
  function changeQuestionHistoryFilter(next: QuestionHistoryFilter) {
    const route = formatQuestionHistoryRoute(spaceId, next);
    if (next === questionHistoryFilter && location.hash === route) return;
    setConversationRouteIssue("");
    setQuestionHistoryFilter(next);
    window.history.pushState(null, "", route);
  }
  function replaceKnowledgeView(next: { query?: string; filter?: KnowledgeLibraryFilter }) {
    const nextQuery = next.query ?? search;
    const nextFilter = next.filter ?? knowledgeFilter;
    setSearch(nextQuery);
    setKnowledgeFilter(nextFilter);
    window.history.replaceState(
      null,
      "",
      formatWorkspaceSectionRoute("knowledge", spaceId, {
        query: nextQuery,
        knowledgeFilter: nextFilter,
      }),
    );
  }
  function openSource(
    id: string,
    versionId?: string,
    citation?: Citation,
    conversationId?: string,
    returnTarget?: ReaderReturnTarget,
  ) {
    if (section === "library" && !sourceId)
      latestLibraryViewRoute.current = currentLibraryViewRoute;
    const nextReturnTarget = returnTarget ?? (sourceId ? readerReturnTarget : null);
    setKnowledgeUpdateOpen(false);
    setConceptRelationsOpen(false);
    setKnowledgeEvidenceAskOpen(false);
    setComparisonRoute(null);
    setComparisonTargetId("");
    setCrossLibraryAsk(null);
    setConversationRouteId(null);
    setConversationRouteIssue("");
    setConversationToInspectId(null);
    setPendingConversationId(conversationId ?? null);
    setPendingComparisonConversationId(null);
    readerReturnTargetRef.current = nextReturnTarget;
    setReaderReturnTarget(nextReturnTarget);
    setSourceId(id);
    setSourceVersionId(versionId ?? null);
    setPendingNoteCitation(citation);
    setNoteId(null);
    setSidebar(false);
    const route = `#source/${id}${versionId ? `/version/${versionId}` : ""}`;
    if (nextReturnTarget && !returnTarget) window.history.replaceState(null, "", route);
    else window.history.pushState(null, "", route);
  }
  function openComparisonPicker() {
    if (!readingSource || !currentSource || !comparisonPickerSpace) {
      setToast("请先在一个未归档知识库中打开资料，再开始对照阅读。");
      return;
    }
    if (!comparisonCandidates.length) {
      setToast("当前知识库还没有另一份可对照的资料。");
      return;
    }
    setComparisonTargetId(comparisonCandidates[0]!.id);
    setModal("compare-source");
  }
  function startComparison() {
    if (!readingSource || !currentSource || !comparisonPickerSpace) {
      setToast("当前资料或知识库已变化，请重新打开后再选择对照资料。");
      setModal(null);
      return;
    }
    const target = comparisonCandidates.find((source) => source.id === comparisonTargetId);
    if (!target) {
      setToast("所选对照资料已不可用，请重新选择。");
      setComparisonTargetId("");
      return;
    }
    const route: ComparisonRoute = {
      leftSourceId: currentSource.id,
      leftVersionId: readingSource.versionId,
      rightSourceId: target.id,
      rightVersionId: target.versionId,
      spaceId: comparisonPickerSpace.id,
    };
    if (!openComparisonRoute(route)) {
      setComparisonTargetId("");
      return;
    }
    setModal(null);
    setComparisonTargetId("");
  }
  function openComparisonRoute(route: ComparisonRoute) {
    const resolution = resolveComparisonSources(data, route);
    if (!resolution.ok) {
      setToast(comparisonUnavailableCopy[resolution.reason]);
      return false;
    }
    setComparisonRoute(route);
    setReaderReturnTarget(null);
    setKnowledgeEvidenceAskOpen(false);
    setCrossLibraryAsk(null);
    setSourceId(null);
    setSourceVersionId(null);
    setNoteId(null);
    setSection("library");
    setSpaceId(resolution.space.id);
    setLibraryFiles(true);
    setPendingNoteCitation(undefined);
    clearConversationRouteState();
    setSidebar(false);
    window.history.pushState(null, "", formatComparisonRoute(route));
    return true;
  }
  function openNote(
    id: string,
    target?: typeof noteSearchTarget,
    libraryReturnRoute?: LibraryRoute,
  ) {
    setNoteLibraryReturn(
      libraryReturnRoute
        ? { noteId: id, token: store.token, userId: user?.id ?? null, route: libraryReturnRoute }
        : null,
    );
    setNoteSearchTarget(target);
    setKnowledgeUpdateOpen(false);
    setReaderReturnTarget(null);
    setConceptRelationsOpen(false);
    setKnowledgeEvidenceAskOpen(false);
    setComparisonRoute(null);
    setComparisonTargetId("");
    setCrossLibraryAsk(null);
    clearConversationRouteState();
    setNoteId(id);
    setSourceId(null);
    setEditorKey((k) => k + 1);
    window.history.pushState(null, "", `#note/${id}`);
  }
  function closeNote(note: Note) {
    if (
      noteLibraryReturn?.noteId === note.id &&
      noteLibraryReturn.token === store.token &&
      noteLibraryReturn.userId === (user?.id ?? null)
    ) {
      const route = noteLibraryReturn.route;
      setKnowledgeUpdateOpen(false);
      setConceptRelationsOpen(false);
      setKnowledgeEvidenceAskOpen(false);
      setNoteSearchTarget(undefined);
      applyLibraryRouteState(route);
      window.history.pushState(null, "", formatLibraryRoute(route));
      return;
    }
    if (note.kind === "knowledge" && section === "knowledge") {
      setKnowledgeUpdateOpen(false);
      setConceptRelationsOpen(false);
      setKnowledgeEvidenceAskOpen(false);
      setNoteId(null);
      setNoteSearchTarget(undefined);
      window.history.pushState(
        null,
        "",
        formatWorkspaceSectionRoute("knowledge", spaceId, {
          query: search,
          knowledgeFilter,
        }),
      );
      return;
    }
    navigate(note.kind === "knowledge" ? "knowledge" : "notes");
  }

  const showConversation = useCallback(
    (conversation: Conversation, writeRoute: boolean) => {
      const resolution = resolveConversationRoute(data, { conversationId: conversation.id });
      const write = () => {
        if (writeRoute) {
          window.history.pushState(
            null,
            "",
            formatConversationRoute({ conversationId: conversation.id }),
          );
        }
      };

      setKnowledgeUpdateOpen(false);
      setConceptRelationsOpen(false);
      setKnowledgeEvidenceAskOpen(false);
      setComparisonTargetId("");
      setPendingNoteCitation(undefined);
      setNoteId(null);
      setSidebar(false);
      setConversationRouteId(conversation.id);
      setConversationRouteIssue("");
      setCrossLibraryAsk(null);

      if (resolution.kind === "cross-library") {
        setComparisonRoute(null);
        setComparisonTargetId("");
        setConversationToInspectId(null);
        setModal(null);
        setSection("library");
        setSpaceId("all");
        setLibraryFiles(true);
        setSourceId(null);
        setSourceVersionId(null);
        setPendingConversationId(null);
        setPendingComparisonConversationId(null);
        setCrossLibraryAsk({ conversationId: conversation.id });
        if (writeRoute) {
          // This is now a canonical library route, not a pending #conversation
          // deep link. Keeping its route id would let a later data update apply
          // the old direct-link effect over the active cross-library panel.
          setConversationRouteId(null);
          window.history.pushState(
            null,
            "",
            formatLibraryRoute({
              spaceId: "all",
              files: true,
              filter: "all",
              time: "all",
              sort: defaultLibrarySort,
              layout: "list",
              query: "",
              crossLibraryAsk: { conversationId: conversation.id },
            }),
          );
        }
        return;
      }

      if (resolution.kind === "comparison") {
        setComparisonRoute(resolution.route);
        setComparisonTargetId("");
        setConversationToInspectId(null);
        setModal(null);
        setSection("library");
        setSpaceId(resolution.route.spaceId);
        setLibraryFiles(true);
        setSourceId(null);
        setSourceVersionId(null);
        setPendingConversationId(null);
        setPendingComparisonConversationId(conversation.id);
        write();
        return;
      }

      if (resolution.kind === "source") {
        setComparisonRoute(null);
        setConversationToInspectId(null);
        setModal(null);
        setSection("library");
        setSpaceId(conversation.spaceId);
        setLibraryFiles(true);
        setSourceId(resolution.source.id);
        setSourceVersionId(null);
        setPendingConversationId(conversation.id);
        setPendingComparisonConversationId(null);
        write();
        return;
      }

      if (resolution.kind === "history") {
        setComparisonRoute(null);
        setPendingConversationId(null);
        setPendingComparisonConversationId(null);
        setSourceId(null);
        setSourceVersionId(null);
        setSection("questions");
        setSpaceId(
          conversation.spaceId === "inbox" ||
            data.spaces.some((space) => space.id === conversation.spaceId)
            ? conversation.spaceId
            : "all",
        );
        setConversationToInspectId(conversation.id);
        setModal("conversation-history");
        write();
        return;
      }

      setComparisonRoute(null);
      setPendingConversationId(null);
      setPendingComparisonConversationId(null);
      setSourceId(null);
      setSourceVersionId(null);
      setSection("questions");
      setModal(null);
      setConversationRouteIssue("这条问答记录不可用或不属于当前账号。");
      write();
    },
    [
      data,
      setComparisonTargetId,
      setConversationToInspectId,
      setKnowledgeEvidenceAskOpen,
      setModal,
      setPendingNoteCitation,
      setSpaceId,
    ],
  );

  function openConversation(conversation: Conversation) {
    showConversation(conversation, true);
  }

  const showUnavailableConversationRoute = useCallback(() => {
    setComparisonRoute(null);
    setCrossLibraryAsk(null);
    setPendingConversationId(null);
    setPendingComparisonConversationId(null);
    setConversationToInspectId(null);
    setSourceId(null);
    setSourceVersionId(null);
    setNoteId(null);
    setSection("questions");
    setModal(null);
    setConversationRouteIssue("这条问答记录不可用或不属于当前账号。");
  }, [setConversationToInspectId, setModal]);

  useEffect(() => {
    if (!conversationRouteId) {
      appliedConversationRoute.current = null;
      return;
    }
    if (!ready) return;

    const resolution = resolveConversationRoute(data, { conversationId: conversationRouteId });
    const key =
      resolution.kind === "source"
        ? `${store.token}:${conversationRouteId}:source:${resolution.source.id}:${resolution.source.versionId}`
        : resolution.kind === "comparison"
          ? `${store.token}:${conversationRouteId}:comparison:${resolution.route.spaceId}:${resolution.route.leftSourceId}:${resolution.route.leftVersionId}:${resolution.route.rightSourceId}:${resolution.route.rightVersionId}`
          : resolution.kind === "cross-library"
            ? `${store.token}:${conversationRouteId}:cross-library:${resolution.conversation.id}`
            : resolution.kind === "history"
              ? `${store.token}:${conversationRouteId}:history:${resolution.reason}`
              : `${store.token}:${conversationRouteId}:unavailable`;
    if (appliedConversationRoute.current === key) return;
    appliedConversationRoute.current = key;

    const apply = window.setTimeout(() => {
      if (resolution.kind === "unavailable") {
        showUnavailableConversationRoute();
        return;
      }
      showConversation(resolution.conversation, false);
    }, 0);
    return () => window.clearTimeout(apply);
  }, [
    conversationRouteId,
    data,
    ready,
    showConversation,
    showUnavailableConversationRoute,
    store.token,
  ]);
  function openSearchHit(hit: SearchHit) {
    if (hit.kind === "source") {
      const source = data.sources.find(
        (item) => item.id === hit.objectId && item.versionId === hit.versionId && !item.deletedAt,
      );
      if (!source) {
        setToast("资料版本已改变，请重新搜索。");
        return;
      }
      const chunk = source.chunks.find(
        (item) =>
          item.id === hit.blockId &&
          item.versionId === source.versionId &&
          item.sourceId === source.id,
      );
      if (hit.blockId && !chunk) {
        setToast("资料片段已改变，请重新搜索。");
        return;
      }
      openSource(
        source.id,
        source.versionId,
        chunk
          ? {
              sourceId: source.id,
              versionId: source.versionId,
              chunkId: chunk.id,
              title: source.title,
              quote: chunk.text,
              page: chunk.page,
              section: chunk.section,
            }
          : undefined,
      );
    } else {
      const note = data.notes.find(
        (item) =>
          item.id === hit.objectId &&
          item.kind === hit.kind &&
          !item.deletedAt &&
          (item.contentRevision ?? 0) === hit.revision &&
          item.updatedAt === hit.updatedAt,
      );
      if (!note) {
        setToast("笔记内容已改变，请重新搜索。");
        return;
      }
      const block = hit.blockId
        ? knowledgeBlocks(note.content).find((item) => item.id === hit.blockId)
        : undefined;
      openNote(
        note.id,
        block
          ? { noteId: note.id, revision: hit.revision, updatedAt: hit.updatedAt, text: block.text }
          : undefined,
        section === "library" && libraryFiles ? currentLibraryViewRoute : undefined,
      );
    }
  }
  function openKnowledgeUpdate(id: string) {
    setConceptRelationsOpen(false);
    setReaderReturnTarget(null);
    setNoteId(id);
    setSourceId(null);
    setKnowledgeUpdateOpen(true);
    setSidebar(false);
    window.history.pushState(null, "", `#note/${id}/update`);
  }
  function returnFromReader() {
    const target = readerReturnTarget;
    if (target?.kind === "recognized-content") {
      readerReturnTargetRef.current = null;
      setReaderReturnTarget(null);
      setPendingNoteCitation(undefined);
      setPendingConversationId(null);
      setSourceId(null);
      setSourceVersionId(null);
      if (!restoreRecognizedContentTarget(target, data.sources)) {
        setDetailId(null);
        applyLibraryRouteState(target.libraryRoute);
        replaceWithLibraryRoute(target.libraryRoute);
        return;
      }
      window.history.back();
      return;
    }
    if (target?.kind === "knowledge-update") {
      const note = data.notes.find(
        (item) => item.id === target.noteId && item.kind === "knowledge" && !item.deletedAt,
      );
      if (note) {
        setReaderReturnTarget(null);
        setPendingNoteCitation(undefined);
        setPendingConversationId(null);
        setSourceId(null);
        setSourceVersionId(null);
        setNoteId(note.id);
        setKnowledgeUpdateOpen(true);
        window.history.back();
        return;
      }
    }
    setReaderReturnTarget(null);
    navigate("library");
  }
  function openConceptRelations(id: string) {
    setKnowledgeUpdateOpen(false);
    setConceptRelationsOpen(true);
    setNoteId(id);
    setSourceId(null);
    setSidebar(false);
    window.history.pushState(null, "", `#note/${id}/relations`);
  }
  function changeRelations(change: (workspace: WorkspaceData) => WorkspaceData, message: string) {
    let saved = false;
    update((workspace) => {
      const next = change(workspace);
      saved = true;
      return next;
    });
    if (!saved) throw new Error("工作区状态已变化，请重新打开关系面板后操作。");
    setToast(message);
  }
  function patchSource(source: Source, patch: Partial<Source>) {
    if (
      readingConflictResolving.current &&
      ("readPage" in patch ||
        "readOffset" in patch ||
        "lastReadAt" in patch ||
        "readingPositionAlternatives" in patch)
    )
      return;
    update((d) => ({
      ...d,
      sources: d.sources.map((s) =>
        s.id === source.id && s.versionId === source.versionId ? { ...s, ...patch } : s,
      ),
    }));
  }
  function patchNote(id: string, patch: Partial<Note>, record = true) {
    update((d) => ({
      ...d,
      notes: d.notes.map((n) =>
        n.id === id ? reviseNote(n, patch, record ? "debounced" : "none") : n,
      ),
    }));
  }
  function newNote(
    kind: "note" | "knowledge",
    content = "",
    citations: Citation[] = [],
    aiGenerated = false,
  ) {
    const now = new Date().toISOString();
    const note: Note = {
      id: crypto.randomUUID(),
      spaceId: activeSpace?.id || sourceSpace.id,
      title: kind === "knowledge" ? "未命名知识页" : "未命名笔记",
      content: content ? markdownToEditorHtml(content) : "",
      kind,
      aiGenerated,
      status: kind === "knowledge" ? "draft" : "accepted",
      citations,
      versions: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    update((d) => ({ ...d, notes: [note, ...d.notes] }));
    openNote(note.id);
  }
  async function restoreRecycledSource(source: Source) {
    if (!source.deletedAt) {
      setToast("这份资料已经恢复，请刷新回收站后重试。");
      return;
    }
    try {
      const restoredAt = new Date().toISOString();
      const applied = await updateDurably((workspace) =>
        restoreSourceAndResolveDrafts(workspace, source.id, source.deletedAt!, restoredAt),
      );
      if (!applied) throw new Error("工作区状态已变化，请稍后重试。");
      setToast(
        storageMode === "cloud"
          ? "资料及其可恢复批注已保存到云端。"
          : "资料及其可恢复批注已保存到此浏览器。",
      );
    } catch (cause) {
      setToast(cause instanceof Error ? cause.message : "恢复资料未完成，请稍后重试。");
    }
  }
  async function restoreRecoverableDraft(item: RecoverableDraftItem) {
    try {
      const applied = await updateDurably((workspace) =>
        restoreSourceFromRecoverableDraft(workspace, item.id, new Date().toISOString()),
      );
      if (!applied) throw new Error("工作区状态已变化，请稍后重试。");
      setToast(
        storageMode === "cloud"
          ? "资料及其可恢复批注已保存到云端。"
          : "资料及其可恢复批注已保存到此浏览器。",
      );
    } catch (cause) {
      const failure = cause instanceof Error ? cause : new Error("恢复资料未完成，请稍后重试。");
      // The optimistic workspace update can remove the panel before its local
      // write settles, so keep failures visible in the workspace-level toast.
      setToast(failure.message);
      throw failure;
    }
  }
  async function saveRecoveredDraft(item: RecoverableDraftItem) {
    const noteId = crypto.randomUUID();
    let savedNoteId = "";
    try {
      const applied = await updateDurably((workspace) => {
        const result = saveRecoverableDraftAsNote(
          workspace,
          item.id,
          noteId,
          new Date().toISOString(),
        );
        savedNoteId = result.note.id;
        return result.data;
      });
      if (!applied || !savedNoteId) throw new Error("工作区状态已变化，请稍后重试。");
      setToast(
        storageMode === "cloud"
          ? "已有文字已保存为云端可编辑笔记，原资料仍在回收站。"
          : "离线文字已保存为此浏览器中的可编辑笔记，原资料仍在回收站。",
      );
      openNote(savedNoteId);
    } catch (cause) {
      const failure =
        cause instanceof Error ? cause : new Error("保存离线文字未完成，请稍后重试。");
      setToast(failure.message);
      throw failure;
    }
  }
  async function discardRecoveredDraft(item: RecoverableDraftItem) {
    try {
      const applied = await updateDurably((workspace) =>
        discardRecoverableDraft(workspace, item.id),
      );
      if (!applied) throw new Error("工作区状态已变化，请稍后重试。");
      setToast(
        storageMode === "cloud"
          ? "草稿丢弃结果已保存到云端，原资料仍在回收站。"
          : "草稿丢弃结果已保存到此浏览器，原资料仍在回收站。",
      );
    } catch (cause) {
      const failure = cause instanceof Error ? cause : new Error("丢弃草稿未完成，请稍后重试。");
      setToast(failure.message);
      throw failure;
    }
  }
  function openOrganization(ids: string[] = [], targetSpaceId?: string) {
    let resolvedSpaceId = targetSpaceId || spaceId;
    if (!targetSpaceId && ids.length && spaceId === "all") {
      const shared = data.spaces.find(
        (space) =>
          !space.archived &&
          ids.every((id) =>
            data.sources.find((source) => source.id === id)?.spaceIds.includes(space.id),
          ),
      );
      if (shared) resolvedSpaceId = shared.id;
      else if (ids.every((id) => !data.sources.find((source) => source.id === id)?.spaceIds.length))
        resolvedSpaceId = "inbox";
    }
    navigate("organize", undefined, resolvedSpaceId);
    setSelected(ids);
    setModal(null);
  }
  function openOrganizationTask(taskSpaceId: string) {
    const targetSpaceId =
      taskSpaceId === "inbox" ||
      data.spaces.some((space) => space.id === taskSpaceId && !space.archived)
        ? taskSpaceId
        : "all";
    navigate("organize", undefined, targetSpaceId);
  }
  function reviewOrganization(
    change: (workspace: WorkspaceData) => WorkspaceData,
    message: string,
  ): boolean {
    let applied = false;
    try {
      update((workspace) => {
        const next = change(workspace);
        applied = true;
        return next;
      });
      if (applied) setToast(message);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "整理建议未能保存，请重试。");
    }
    return applied;
  }
  function openBulkRecycle(ids = selected) {
    setSelected([...new Set(ids)]);
    setModal("bulk-recycle");
  }
  function openBulkSpaceAssociation() {
    setModal("bulk-spaces");
  }
  async function persistBulkWorkspace(
    updater: (workspace: WorkspaceData) => WorkspaceData,
    expectedModal: "bulk-tags" | "bulk-spaces" | "bulk-recycle",
  ): Promise<WorkspaceData> {
    const assertCurrent = () => {
      if (
        bulkWriteContext.current !== bulkWriteIdentity ||
        !bulkWriteIdentity.ready ||
        bulkWriteIdentity.modal !== expectedModal
      )
        throw new Error("当前账号、缓存模式或所选资料已改变，请重新打开批量操作。");
    };
    assertCurrent();
    let saved: boolean;
    try {
      saved = await updateDurably((workspace) => {
        assertCurrent();
        const next = updater(workspace);
        return next === workspace ? { ...workspace } : next;
      });
    } catch (cause) {
      assertCurrent();
      throw cause;
    }
    assertCurrent();
    if (!saved) throw new Error("批量操作未提交，请检查工作区保存状态后重试。");
    return store.getCurrentWorkspaceData();
  }
  function openSourcePurge(source: Source) {
    if (!user) {
      setToast("请先登录云端账号，再彻底删除资料及其全部版本。");
      return;
    }
    if (!source.deletedAt) {
      setToast("请先将资料移入回收站，再执行彻底删除。");
      return;
    }
    setSourceToPurgeId(source.id);
    setModal("purge-source");
  }
  async function permanentlyPurgeSource(source: Source, preview: SourcePurgePreview) {
    if (sourcePurgeOperation.current) return;
    const operation = {};
    const owner = { token: store.token, userId: user?.id ?? null, localCacheMode };
    sourcePurgeOperation.current = operation;
    try {
      await store.purgeSource(source.id, preview);
      const context = sourcePurgeContext.current;
      if (
        sourcePurgeOperation.current !== operation ||
        !context ||
        context.token !== owner.token ||
        context.userId !== owner.userId ||
        context.localCacheMode !== owner.localCacheMode ||
        context.modal !== "purge-source" ||
        context.sourceId !== source.id
      )
        return;
      setModal(null);
      setSourceToPurgeId(null);
      setToast("资料元数据已彻底删除。云端原件会由后台任务清理；本机副本仅会在确认无引用后清理。");
    } finally {
      if (sourcePurgeOperation.current === operation) sourcePurgeOperation.current = null;
    }
  }
  function removeLearningSpace(
    spaceIdToRemove: string,
    recycleExclusiveSources: boolean,
    expectedFingerprint: string,
  ) {
    const outcome: { impact: SpaceDeletionImpact | null; failure: string } = {
      impact: null,
      failure: "",
    };
    const applied = update((workspace) => {
      try {
        const nextImpact = previewLearningSpaceDeletion(workspace, spaceIdToRemove);
        if (learningSpaceDeletionFingerprint(workspace, spaceIdToRemove) !== expectedFingerprint) {
          outcome.failure = "资料范围已变化，请核对最新影响后再删除。";
          return workspace;
        }
        outcome.impact = nextImpact;
        return deleteLearningSpace(workspace, spaceIdToRemove, { recycleExclusiveSources });
      } catch (cause) {
        outcome.failure = cause instanceof Error ? cause.message : "删除学习空间失败，请重试。";
        return workspace;
      }
    });
    if (!applied) {
      setToast("学习空间中的资料正在解析。请先取消解析，或等待完成后再删除学习空间。");
      return;
    }
    if (!outcome.impact) {
      setToast(outcome.failure || "删除学习空间失败，请重试。");
      return;
    }
    const impact = outcome.impact;
    setModal(null);
    setSpaceToDeleteId(null);
    if (spaceId === spaceIdToRemove) setSpaceId("all");
    const sourceResult = impact.exclusiveSources
      ? recycleExclusiveSources
        ? `${impact.exclusiveSources} 份专属资料已移入回收站。`
        : `${impact.exclusiveSources} 份专属资料已保留在收件箱。`
      : "没有专属资料需要转移。";
    setToast(
      `已删除「${impact.space.name}」。${sourceResult}${
        impact.organizationJobs || impact.conceptRelations
          ? ` 已移除 ${impact.organizationJobs} 条整理记录和 ${impact.conceptRelations} 条关系。`
          : ""
      }`,
    );
  }
  function openExport(scope: WorkspaceExportScope = { kind: "workspace" }) {
    if (exportOperation.current) return;
    setExportScope(scope);
    setModal("export");
  }
  async function doExport(
    state: WorkspaceData = data,
    options?: { scope: WorkspaceExportScope; expectedFingerprint: string },
  ): Promise<boolean> {
    if (exportOperation.current) return false;
    const operation = {};
    const owner = { token: store.token, userId: user?.id ?? null, localCacheMode };
    exportOperation.current = operation;
    function isCurrent() {
      const context = exportContext.current;
      return (
        exportOperation.current === operation &&
        context?.ready === true &&
        context.token === owner.token &&
        context.userId === owner.userId &&
        context.localCacheMode === owner.localCacheMode
      );
    }
    function assertCanContinue() {
      if (!isCurrent()) throw new Error("账号或工作区状态已变化，已停止导出，请重新核对范围。");
    }
    try {
      assertCanContinue();
      if (
        options &&
        workspaceExportFingerprint(exportContext.current!.data, options.scope) !==
          options.expectedFingerprint
      ) {
        throw new Error("导出范围已变化，请刷新预览后再下载。");
      }
      setBusy(true);
      setExporting(true);
      setExportProgress(null);
      setExportIssues(null);
      const result = await exportWorkspace(state, store.sourceBlob, {
        ...(options ? { scope: options.scope } : {}),
        assertCanContinue,
        onProgress: (progress) => {
          assertCanContinue();
          setExportProgress(progress);
        },
      });
      assertCanContinue();
      if (result.issues.length) {
        setExportIssues(result.issues);
        setModal("export-result");
        setToast("备份已下载；" + result.issues.length + " 个原文件版本未包含。");
      } else {
        setModal((current) => (current === "export" ? null : current));
        setToast("导出文件已准备好。");
      }
      return storageMode !== "cloud" || result.issues.length === 0;
    } catch (e) {
      if (isCurrent()) setToast(e instanceof Error ? e.message : "导出失败。");
      return false;
    } finally {
      if (exportOperation.current === operation) {
        exportOperation.current = null;
        setBusy(false);
        setExporting(false);
        setExportProgress(null);
      }
    }
  }
  async function downloadOriginal(source: Source) {
    try {
      const blob = await store.sourceBlob(source);
      if (!blob) {
        setToast("此资料没有可下载的原文件。");
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = source.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "下载失败。");
    }
  }
  function chooseSpace(id: string) {
    navigate("library", { spaceId: id, files: id !== "all" });
  }
  function openSpaceTab(tab: SpaceTab) {
    if (!activeSpace) return;
    if (tab === "library") {
      navigate("library", { spaceId: activeSpace.id, files: true });
      return;
    }
    navigate(tab, undefined, activeSpace.id);
  }
  function openSpaceCreation(intent: "browse" | "import" = "browse") {
    setSpaceCreationIntent(intent);
    setModal("space");
  }
  function openImport() {
    if (isUntouchedStarterWorkspace(data)) {
      openSpaceCreation("import");
      return;
    }
    setModal("import");
  }
  function closeSpaceCreation() {
    setSpaceCreationIntent("browse");
    setModal(null);
  }
  function openCollectionHome() {
    navigate("library", { spaceId: "all", files: false });
  }

  return (
    <div
      className={`app-shell${isLibraryWorkspace ? " library-workspace" : ""}${isReadingWorkspace ? " reader-shell" : ""}${comparisonRoute ? " comparison-shell" : ""}${isCollectionHome ? " collection-home" : ""}`}
    >
      <WorkspaceSidebar
        data={data}
        user={user}
        status={status}
        cloudConfigured={cloudConfigured}
        sidebar={sidebar}
        setSidebar={setSidebar}
        section={section}
        spaceId={spaceId}
        sourceId={sourceId}
        currentSource={currentSource}
        currentNote={currentNote}
        pinnedSources={pinnedSources}
        activeTaskCount={activeTaskCount}
        navigate={navigate}
        openCollectionHome={openCollectionHome}
        chooseSpace={chooseSpace}
        openSource={openSource}
        openSpaceCreation={openSpaceCreation}
        setModal={setModal}
      />
      <main className="app-main">
        {!isReadingWorkspace && (
          <WorkspaceTopbar
            user={user}
            status={status}
            cloudConfigured={cloudConfigured}
            cloudReadOnly={cloudReadOnly}
            saveLabel={saveLabel}
            section={section}
            isLibraryWorkspace={isLibraryWorkspace}
            isCollectionHome={isCollectionHome}
            libraryTitle={libraryTitle}
            activeSpace={activeSpace}
            currentSource={currentSource}
            currentNote={currentNote}
            setSidebar={setSidebar}
            openCollectionHome={openCollectionHome}
            openAllSourcesSearch={openAllSourcesSearch}
            setModal={setModal}
          />
        )}
        {storageMode !== "cloud" && (
          <AnonymousWorkspaceMigrationNotice
            key={anonymousMigration?.kind ?? "none"}
            migration={anonymousMigration}
            compact={isReadingWorkspace && !migrationChoicePending}
            onMigrate={() => {
              void Promise.resolve()
                .then(() => store.migrateAnonymousWorkspace())
                .catch((cause) =>
                  setToast(cause instanceof Error ? cause.message : "资料迁移未完成，请重试。"),
                );
            }}
            onSkip={() => {
              void Promise.resolve()
                .then(() => store.skipAnonymousWorkspaceMigration())
                .catch((cause) =>
                  setToast(cause instanceof Error ? cause.message : "暂不迁移设置未完成，请重试。"),
                );
            }}
          />
        )}
        {store.localUpdateRevision != null && (
          <section
            className="notice notice-warning"
            aria-label="其他标签页有更新"
            aria-live="polite"
            role="status"
          >
            <History size={17} aria-hidden="true" />
            <span>
              <strong>其他标签页保存了更新</strong>
              <small>
                载入前会等待本页正在进行的保存；若仍有未保存修改，会先下载一份可恢复备份，再显示最新数据。
              </small>
            </span>
            <button
              className="text-button"
              disabled={store.loadingLocalUpdate || busy}
              onClick={loadLatestWorkspace}
            >
              {store.loadingLocalUpdate ? "正在载入…" : "载入最新数据"}
            </button>
          </section>
        )}
        {cloudReadOnly && (
          <section
            className="notice notice-warning cloud-readonly-notice"
            aria-label="云端资料只读恢复"
            aria-live="polite"
            role="status"
          >
            <Cloud size={17} aria-hidden="true" />
            <span>
              <strong>正在以只读方式查看云端资料</strong>
              <small>
                此浏览器的本机副本暂时无法读取。你仍可查看和下载已确认的云端资料；编辑、导入、问答与整理会在重新连接成功后恢复。
              </small>
            </span>
            <button className="text-button" onClick={retryWorkspace}>
              重新连接
            </button>
          </section>
        )}
        {isSpaceWorkspace && activeSpace && (
          <nav className="space-context-bar" aria-label={`${activeSpace.name} 的空间导航`}>
            <div className="space-context-title">
              <span className="space-dot" style={{ background: activeSpace.color }} />
              <span className="space-context-name" title={activeSpace.name}>
                {activeSpace.name}
              </span>
              {activeSpace.goal && (
                <small className="space-context-goal" title={activeSpace.goal}>
                  {activeSpace.goal}
                </small>
              )}
            </div>
            <div className="space-context-tabs" aria-label="当前空间内容">
              {spaceTabs.map(([tab, label]) => {
                const active = section === tab;
                return (
                  <button
                    key={tab}
                    className={active ? "active" : ""}
                    aria-current={active ? "page" : undefined}
                    onClick={() => openSpaceTab(tab)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </nav>
        )}
        {store.error &&
          !cloudReadOnly &&
          !accountDeletionState &&
          !accountAccessVerificationFailed && (
            <div className="notice notice-warning">
              <span>{store.error}</span>
              {!migrationChoicePending && store.localUpdateRevision == null && (
                <button className="text-button" onClick={retryWorkspace}>
                  重新连接
                </button>
              )}
              {status === "conflict" && (
                <button className="text-button" onClick={() => void doExport()}>
                  导出当前副本
                </button>
              )}
              {status === "conflict" && store.readingProgressSyncPlan && (
                <button
                  className="text-button"
                  onClick={() => {
                    setReadingConflictPlanSnapshot(structuredClone(store.readingProgressSyncPlan!));
                    setModal("sync-conflict");
                  }}
                >
                  选择阅读位置
                </button>
              )}
              {status === "conflict" && !store.readingProgressSyncPlan && store.noteSyncPlan && (
                <button
                  className="text-button"
                  onClick={() => {
                    setReadingConflictPlanSnapshot(null);
                    setModal("sync-conflict");
                  }}
                >
                  {store.noteSyncPlan.conflicts.length ? "处理笔记冲突" : "合并独立笔记"}
                </button>
              )}
              {store.recovery && (
                <button
                  className="text-button"
                  onClick={() =>
                    void store
                      .useRemote(
                        storageMode === "cloud" ? (snapshot) => doExport(snapshot) : undefined,
                      )
                      .catch((cause: unknown) =>
                        setToast(
                          cause instanceof Error ? cause.message : "云端副本未载入，请重试。",
                        ),
                      )
                  }
                >
                  备份当前副本并加载云端
                </button>
              )}
            </div>
          )}
        {knowledgeUpdateDrafts.status.kind === "error" &&
          !(
            ready &&
            !comparisonRoute &&
            !currentSource &&
            currentNote?.kind === "knowledge" &&
            !conceptRelationsOpen &&
            knowledgeUpdateOpen
          ) && (
            <div className="notice notice-warning" role="alert" aria-label="本机审核草稿保存提示">
              <span>{knowledgeUpdateDrafts.status.message}</span>
              <button className="text-button" onClick={knowledgeUpdateDrafts.retry}>
                重试本机操作
              </button>
            </div>
          )}
        {ready && user && (
          <CloudUpdateNotice
            revision={store.cloudUpdateRevision ?? null}
            checking={store.checkingCloudUpdate ?? false}
            loading={store.loadingCloudUpdate ?? false}
            error={store.cloudUpdateError ?? ""}
            onLoad={() => {
              void store
                .loadCloudUpdate()
                .catch((cause: unknown) =>
                  setToast(
                    cause instanceof Error ? cause.message : "云端更新未载入，当前内容仍保留。",
                  ),
                );
            }}
            onCheck={() => {
              void store
                .checkCloudUpdates()
                .catch((cause: unknown) =>
                  setToast(
                    cause instanceof Error ? cause.message : "云端更新检查失败，请稍后重试。",
                  ),
                );
            }}
          />
        )}
        {accountDeletionState || accountAccessVerificationFailed ? (
          <AccountAccessStopped
            state={accountDeletionState ?? "verification-failed"}
            onOpenAccount={() => setModal("account")}
            onRetryCleanup={store.retryAccountLocalDeletion}
            onRetryVerification={() => store.retry()}
          />
        ) : !ready ? (
          <div className="page-loading">
            <Loader2 size={24} className="spin" />
            {store.purging ? "正在安全删除资料…" : "正在打开学习空间…"}
          </div>
        ) : comparisonRoute && comparisonResolution?.ok ? (
          <ComparisonReader
            key={`${user?.id || "local"}:${comparisonRoute.spaceId}:${comparisonRoute.leftSourceId}:${comparisonRoute.leftVersionId}:${comparisonRoute.rightSourceId}:${comparisonRoute.rightVersionId}:${pendingComparisonConversationId ?? "latest"}`}
            leftSource={comparisonResolution.left.source}
            rightSource={comparisonResolution.right.source}
            space={comparisonResolution.space}
            getSourceBlob={store.sourceBlob}
            onBack={() =>
              navigate("library", { spaceId: comparisonResolution.space.id, files: true })
            }
            onOpenSource={openSource}
            readingProgress={{
              isCurrentVersion: ({ id, versionId }) =>
                data.sources.some(
                  (source) =>
                    source.id === id && source.versionId === versionId && !source.deletedAt,
                ),
              onChange: (candidate, patch) => {
                const current = data.sources.find(
                  (source) =>
                    source.id === candidate.id &&
                    source.versionId === candidate.versionId &&
                    !source.deletedAt,
                );
                if (current) patchSource(current, patch);
              },
              onPendingChange: (candidate, pending) => {
                const side = candidate.id === comparisonRoute.leftSourceId ? "left" : "right";
                store.setPendingReadingPosition?.(
                  `comparison:${side}:${candidate.id}:${candidate.versionId}`,
                  pending,
                );
              },
            }}
            readingPositionRevision={
              readingPositionResolutionEpoch + (store.cloudAdoptionSequence ?? 0)
            }
            ask={{
              conversations: data.conversations,
              initialConversationId: pendingComparisonConversationId ?? undefined,
              unavailableReason: comparisonAskUnavailableReason,
              onConversationChange: (conversation) =>
                update((workspace) => persistConversation(workspace, conversation)),
              onAsk: (input, signal, onProgress) => {
                const latest = comparisonRoute
                  ? resolveComparisonSources(data, comparisonRoute)
                  : null;
                if (!latest?.ok)
                  return Promise.reject(new Error("对照资料已变化，请重新打开后再提问。"));
                if (!data.aiEnabled)
                  return Promise.reject(new Error("资料问答已关闭，请先在设置中开启。"));
                try {
                  const base = createComparisonAnswerRequest({
                    ...latest,
                    question: input.question,
                    requestId: input.requestId,
                  });
                  const request = validateComparisonAnswerRequest(latest, {
                    ...base,
                    ...(input.userContext?.length ? { userContext: input.userContext } : {}),
                  });
                  return store.ask(request, signal, onProgress);
                } catch (cause) {
                  return Promise.reject(
                    cause instanceof Error
                      ? cause
                      : new Error("对照问答请求无效，请重新打开资料后再试。"),
                  );
                }
              },
            }}
          />
        ) : comparisonRoute ? (
          <div className="content-scroll">
            <div className="notice notice-warning comparison-unavailable" role="status">
              <span>
                {comparisonResolution && !comparisonResolution.ok
                  ? comparisonUnavailableCopy[comparisonResolution.reason]
                  : "这个对照链接暂时无法打开。"}
              </span>
              <button
                className="text-button"
                onClick={() => navigate("library", { spaceId: "all", files: true })}
              >
                返回资料库
              </button>
            </div>
          </div>
        ) : currentSource && !readingSource ? (
          <div className="content-scroll">
            <div className="notice notice-warning" role="status">
              <span>这个历史版本未保留或当前不可用，不能用新正文替代原始依据。</span>
              <button className="text-button" onClick={() => openSource(currentSource.id)}>
                打开当前版本
              </button>
              <button className="text-button" onClick={() => navigate("library")}>
                返回资料库
              </button>
            </div>
          </div>
        ) : currentSource && readingSource ? (
          <Reader
            key={`${user?.id || "local"}:${readingSource.id}:${readingSource.versionId}`}
            source={readingSource}
            onPendingReadingChange={(pending) =>
              store.setPendingReadingPosition?.(
                `reader:${readingSource.id}:${readingSource.versionId}`,
                pending,
              )
            }
            readingPositionRevision={
              readingPositionResolutionEpoch + (store.cloudAdoptionSequence ?? 0)
            }
            currentSource={currentSource}
            sources={data.sources}
            notes={data.notes}
            space={sourceSpace}
            conversations={data.conversations}
            annotations={data.annotations}
            aiEnabled={data.aiEnabled}
            cloudUserId={user?.id}
            saveState={status}
            saveLabel={saveLabel}
            onSourceChange={(patch) => {
              if (readingSource.versionId === currentSource.versionId)
                patchSource(readingSource, patch);
            }}
            onConversationChange={(conversation) =>
              update((workspace) => persistConversation(workspace, conversation))
            }
            onAnnotationAdd={(annotation) => {
              let failure = "";
              update((d) => {
                const source = d.sources.find(
                  (item) =>
                    item.id === annotation.sourceId &&
                    item.versionId === annotation.versionId &&
                    !item.deletedAt,
                );
                if (!source || d.annotations.some((item) => item.id === annotation.id)) {
                  failure = "资料版本或批注记录已改变，请重新选择原文。";
                  return d;
                }
                try {
                  return {
                    ...d,
                    annotations: [...d.annotations, createAnnotation(annotation, source)],
                  };
                } catch (cause) {
                  failure = cause instanceof Error ? cause.message : "批注未保存，请重试。";
                  return d;
                }
              });
              if (failure) setToast(failure);
            }}
            onAnnotationUpdate={(annotation) => {
              let failure = "";
              update((d) => {
                const previous = d.annotations.find((item) => item.id === annotation.id);
                const source =
                  previous &&
                  d.sources.find(
                    (item) =>
                      item.id === previous.sourceId &&
                      item.versionId === previous.versionId &&
                      !item.deletedAt,
                  );
                if (
                  !previous ||
                  !source ||
                  previous.sourceId !== annotation.sourceId ||
                  previous.versionId !== annotation.versionId ||
                  previous.quote !== annotation.quote ||
                  !sameAnnotationTextAnchor(previous.textAnchor, annotation.textAnchor)
                ) {
                  failure = "批注或资料版本已改变，请重新打开后再编辑。";
                  return d;
                }
                try {
                  const saved = updateAnnotation(previous, annotation.note, source);
                  return {
                    ...d,
                    annotations: d.annotations.map((item) => (item.id === saved.id ? saved : item)),
                  };
                } catch (cause) {
                  failure = cause instanceof Error ? cause.message : "批注未更新，请重试。";
                  return d;
                }
              });
              if (failure) setToast(failure);
            }}
            onAnnotationDelete={(annotation) => {
              let failure = "";
              update((d) => {
                const source = d.sources.find(
                  (item) =>
                    item.id === annotation.sourceId &&
                    item.versionId === annotation.versionId &&
                    !item.deletedAt,
                );
                if (!source) {
                  failure = "资料版本已改变，批注未删除。";
                  return d;
                }
                try {
                  return { ...d, annotations: removeAnnotation(d.annotations, annotation, source) };
                } catch (cause) {
                  failure = cause instanceof Error ? cause.message : "批注未删除，请重试。";
                  return d;
                }
              });
              if (failure) setToast(failure);
            }}
            onSaveNote={(content, citations, kind, generated) =>
              newNote(kind, content, citations, generated)
            }
            onAppendToKnowledgePage={({ noteId, content, citations, mode }) => {
              let saved = false;
              let title = "";
              update((workspace) => {
                const next = appendAnswerToKnowledgePage(workspace, {
                  noteId,
                  spaceId: sourceSpace.id,
                  content,
                  citations,
                  mode,
                });
                const note = next.notes.find((item) => item.id === noteId)!;
                title = note.title;
                saved = true;
                return next;
              });
              if (!saved) throw new Error("当前工作区已变化，请重新打开资料后再保存。");
              return title;
            }}
            onSaveExcerptToKnowledgePage={({
              noteId,
              spaceId,
              sourceId,
              versionId,
              quote,
              anchorChunkId,
              anchorPage,
            }) => {
              let saved = false;
              let title = "";
              update((workspace) => {
                const result = noteId
                  ? appendExcerptToKnowledgePage(workspace, {
                      noteId,
                      spaceId,
                      sourceId,
                      versionId,
                      selection: quote,
                      ...(anchorChunkId ? { anchorChunkId } : {}),
                      ...(anchorPage !== undefined ? { anchorPage } : {}),
                    })
                  : createKnowledgePageFromExcerpt(workspace, {
                      spaceId,
                      sourceId,
                      versionId,
                      selection: quote,
                      ...(anchorChunkId ? { anchorChunkId } : {}),
                      ...(anchorPage !== undefined ? { anchorPage } : {}),
                    });
                if (!result.ok) throw new Error(result.message);
                title = result.note.title;
                saved = true;
                return result.data;
              });
              if (!saved) throw new Error("当前工作区已变化，请重新打开资料后再保存。");
              return title;
            }}
            onAsk={(request, signal, onProgress) => {
              if (readingSource.versionId !== currentSource.versionId)
                return Promise.reject(new Error("正在查看历史版本，请切回当前版本后提问。"));
              return store.ask(request, signal, onProgress);
            }}
            onStartComparison={
              comparisonPickerSpace && comparisonCandidates.length
                ? openComparisonPicker
                : undefined
            }
            onReplaceFile={async (candidate, blob, expectedVersionId) => {
              const route = window.location.hash;
              await store.replaceFile(currentSource.id, expectedVersionId, candidate, blob);
              if (activeSessionToken.current !== store.token || window.location.hash !== route)
                return;
              openSource(currentSource.id);
              setToast("已创建新版本，旧原件及引用已保留。请留意工作台保存状态。");
            }}
            onRefreshWeb={(candidate, expectedVersionId) => {
              const applied = update((workspace) =>
                refreshWebSource(workspace, currentSource.id, expectedVersionId, candidate),
              );
              if (!applied) throw new Error("工作区状态已变化，请重新打开网页后刷新。");
              openSource(currentSource.id);
              setToast("已创建新快照，旧版本及引用已保留。请留意工作台保存状态。");
            }}
            onRestoreVersion={(versionId, expectedCurrentVersionId) => {
              const applied = update((workspace) =>
                restoreArchivedSourceVersion(
                  workspace,
                  currentSource.id,
                  expectedCurrentVersionId,
                  versionId,
                ),
              );
              if (!applied) throw new Error("工作区状态已变化，请重新打开版本记录后恢复。");
              setToast("历史版本已恢复为当前版本，刚才的当前版本已归档。请留意保存状态。");
            }}
            onPreviewRemoveVersion={
              user
                ? (versionId) => store.previewSourceVersionPurge(currentSource.id, versionId)
                : undefined
            }
            onRemoveVersion={
              user
                ? async (versionId, preview) => {
                    await store.purgeSourceVersion(currentSource.id, versionId, preview);
                    setToast(
                      "历史版本元数据已清理；云端原件会由后台任务清理，本机副本仅会在确认无引用后清理。",
                    );
                  }
                : undefined
            }
            onOpenSource={openSource}
            backLabel={
              readerReturnTarget?.kind === "knowledge-update"
                ? "返回更新审核"
                : readerReturnTarget?.kind === "recognized-content"
                  ? "返回已识别内容"
                  : undefined
            }
            onBack={returnFromReader}
            onOpenSettings={() => navigate("settings")}
            getSourceBlob={store.sourceBlob}
            initialCitation={pendingNoteCitation}
            onCitationConsumed={() => setPendingNoteCitation(undefined)}
            initialConversationId={pendingConversationId ?? undefined}
          />
        ) : currentNote && currentNote.kind === "knowledge" && conceptRelationsOpen ? (
          <div className="content-scroll">
            <ConceptRelationsPanel
              key={`${user?.id || "local"}:${currentNote.id}`}
              data={data}
              noteId={currentNote.id}
              status={store.organizationStatus}
              onRefreshStatus={store.refreshOrganizationStatus}
              onGenerate={store.organize}
              onAccept={(jobId, proposalId, patch) =>
                changeRelations(
                  (workspace) => acceptRelationProposal(workspace, jobId, proposalId, patch),
                  "已保存知识关系，AI 来源标记与原文依据保留。",
                )
              }
              onIgnore={(jobId, proposalId) =>
                changeRelations(
                  (workspace) => ignoreRelationProposal(workspace, jobId, proposalId),
                  "已忽略关系建议。",
                )
              }
              onSave={(input, existing) =>
                changeRelations(
                  (workspace) => saveConceptRelation(workspace, input, existing),
                  "知识关系已保存。",
                )
              }
              onDelete={(id, revision) =>
                changeRelations(
                  (workspace) => deleteConceptRelation(workspace, id, revision),
                  "关系已删除，可在关系面板恢复。",
                )
              }
              onRestore={(id, revision) =>
                changeRelations(
                  (workspace) => restoreConceptRelation(workspace, id, revision),
                  "关系记录已恢复；请核对当前页面与来源状态。",
                )
              }
              onRetry={store.retryOrganization}
              onCheck={store.checkOrganization}
              onStop={store.stopOrganization}
              onDismiss={(jobId) =>
                changeRelations(
                  (workspace) => dismissOrganizationJob(workspace, jobId),
                  "已收起关系建议，已保存关系保留。",
                )
              }
              onOpenNote={openNote}
              onOpenCitation={(citation) => {
                openSource(citation.sourceId, citation.versionId, citation);
              }}
              onBack={() => openNote(currentNote.id)}
            />
          </div>
        ) : currentNote && currentNote.kind === "knowledge" && knowledgeUpdateOpen ? (
          <div className="content-scroll">
            <KnowledgeUpdatePanel
              key={`${user?.id || "local"}:${store.token}:${localCacheMode}:${currentNote.id}`}
              withdrawalContextKey={`${user?.id || "local"}:${store.token}:${localCacheMode}`}
              data={data}
              noteId={currentNote.id}
              status={store.organizationStatus}
              onRefreshStatus={store.refreshOrganizationStatus}
              onGenerate={store.organize}
              onApply={(jobId, changes) => {
                if (
                  !reviewOrganization(
                    (workspace) => applyKnowledgeUpdate(workspace, jobId, changes),
                    "已应用所选修改，并保留应用前的正文与引用版本。",
                  )
                )
                  throw new Error("修改未应用，请检查当前页面或来源是否已经变化。");
                knowledgeUpdateDrafts.removeChanges(
                  currentNote.id,
                  jobId,
                  changes.map((change) => change.changeId),
                );
              }}
              onIgnore={(jobId, changeId) => {
                if (
                  !reviewOrganization(
                    (workspace) => ignoreKnowledgeChange(workspace, jobId, changeId),
                    "已忽略这项修改，正文保持不变。",
                  )
                )
                  throw new Error("建议未能忽略，请刷新当前状态。");
                knowledgeUpdateDrafts.removeChanges(currentNote.id, jobId, [changeId]);
              }}
              onWithdraw={async (jobId, fingerprint, selections) => {
                const expectedContext = {
                  token: store.token,
                  userId: user?.id ?? null,
                  localCacheMode,
                  noteId: currentNote.id,
                };
                const belongsHere = () => {
                  const current = knowledgeWithdrawalContext.current;
                  return Boolean(
                    current?.ready &&
                    current.token === expectedContext.token &&
                    current.userId === expectedContext.userId &&
                    current.localCacheMode === expectedContext.localCacheMode &&
                    current.noteId === expectedContext.noteId,
                  );
                };
                try {
                  await persistKnowledgeUpdateWithdrawal({
                    getContext: () => knowledgeWithdrawalContext.current,
                    expectedContext,
                    jobId,
                    fingerprint,
                    selections,
                    updateDurably,
                  });
                  if (!belongsHere()) return;
                  knowledgeUpdateDrafts.change(currentNote.id, jobId, null);
                  setToast(
                    storageMode === "cloud"
                      ? "撤回已保存到云端，并保留恢复前的完整版本。"
                      : "撤回已保存到此浏览器，并保留恢复前的完整版本。云端同步状态请查看顶部提示。",
                  );
                } catch (cause) {
                  if (belongsHere())
                    setToast(
                      cause instanceof Error
                        ? cause.message
                        : "撤回尚未保存，请检查顶部提示后重试。",
                    );
                  throw cause;
                }
              }}
              onRetry={store.retryOrganization}
              onCheck={store.checkOrganization}
              onStop={store.stopOrganization}
              onDismiss={(jobId) => {
                if (
                  !reviewOrganization(
                    (workspace) => dismissOrganizationJob(workspace, jobId),
                    "已收起这次更新建议，已接受的内容保留。",
                  )
                )
                  throw new Error("更新建议未能收起，请刷新当前状态。");
                knowledgeUpdateDrafts.change(currentNote.id, jobId, null);
              }}
              reviewDrafts={knowledgeUpdateDrafts.draftsFor(currentNote.id)}
              reviewDraftSaveStatus={knowledgeUpdateDrafts.status}
              onRetryReviewDraftSave={knowledgeUpdateDrafts.retry}
              onReviewDraftChange={(jobId, draft) =>
                knowledgeUpdateDrafts.change(currentNote.id, jobId, draft)
              }
              onBack={() => openNote(currentNote.id)}
              onOpenCitation={(citation) => {
                openSource(citation.sourceId, citation.versionId, citation, undefined, {
                  kind: "knowledge-update",
                  noteId: currentNote.id,
                });
              }}
            />
          </div>
        ) : currentNote && currentNote.kind === "knowledge" && knowledgeEvidenceAskOpen ? (
          <div className="content-scroll">
            <KnowledgeEvidenceAskPanel
              key={`${user?.id || "local"}:${currentNote.id}`}
              data={data}
              note={currentNote}
              onAsk={(request, signal) => store.ask(request, signal)}
              onConversationChange={(conversation) =>
                update((workspace) => persistConversation(workspace, conversation))
              }
              onOpenSource={openSource}
              onBack={() => setKnowledgeEvidenceAskOpen(false)}
            />
          </div>
        ) : currentNote ? (
          <NotePage
            data={data}
            currentNote={currentNote}
            status={status}
            cloudReadOnly={cloudReadOnly}
            saveLabel={saveLabel}
            editorKey={editorKey}
            noteSearchTarget={noteSearchTarget}
            knowledgeEvidence={knowledgeEvidence}
            acceptanceReason={acceptanceReason}
            closeNote={closeNote}
            patchNote={patchNote}
            reviewOrganization={reviewOrganization}
            openConceptRelations={openConceptRelations}
            openKnowledgeUpdate={openKnowledgeUpdate}
            setKnowledgeEvidenceAskOpen={setKnowledgeEvidenceAskOpen}
            setModal={setModal}
            openSource={openSource}
          />
        ) : (
          <div className="content-scroll">
            {section === "home" && (
              <HomeSection
                data={data}
                activeSpace={activeSpace}
                visibleSources={visibleSources}
                scopedNotes={scopedNotes}
                primaryContinuation={primaryContinuation}
                secondaryContinuedSources={secondaryContinuedSources}
                pendingQuestions={pendingQuestions}
                update={update}
                setToast={setToast}
                navigate={navigate}
                openImport={openImport}
                openSpaceCreation={openSpaceCreation}
                chooseSpace={chooseSpace}
                openSource={openSource}
                openNote={openNote}
                openConversation={openConversation}
                newNote={newNote}
              />
            )}
            {section === "library" && spaceId === "all" && !libraryFiles && (
              <CollectionLibrary
                spaces={data.spaces}
                sources={data.sources}
                notes={data.notes}
                title="资料库"
                onOpenSpace={chooseSpace}
                onNewSpace={() => openSpaceCreation()}
                onImport={openImport}
                onNewNote={() => newNote("note")}
                onOpenAll={() => navigate("library", { spaceId: "all", files: true })}
                query={collectionSearch}
                onQueryChange={(query) => replaceLibraryView({ query })}
              />
            )}
            {section === "library" && (spaceId !== "all" || libraryFiles) && (
              <LibrarySection
                data={data}
                store={store}
                user={user}
                update={update}
                status={status}
                spaceId={spaceId}
                libraryFiles={libraryFiles}
                activeSpace={activeSpace}
                visibleSources={visibleSources}
                filteredSources={filteredSources}
                availableTags={availableTags}
                derivedLibraryFilter={derivedLibraryFilter}
                busy={busy}
                search={search}
                searchRef={searchRef}
                searchIntent={searchIntent}
                setSearchIntent={setSearchIntent}
                filter={filter}
                timeFilter={timeFilter}
                sort={sort}
                layout={layout}
                selectedTags={selectedTags}
                tagFilterRef={tagFilterRef}
                tagFilterOpen={tagFilterOpen}
                setTagFilterOpen={setTagFilterOpen}
                replaceLibraryView={replaceLibraryView}
                searchExternalFilters={searchExternalFilters}
                selected={selected}
                setSelected={setSelected}
                crossLibraryAsk={crossLibraryAsk}
                crossLibraryAskPanelKey={crossLibraryAskPanelKey}
                setCrossLibraryAskPanelKey={setCrossLibraryAskPanelKey}
                crossLibraryAskBusy={crossLibraryAskBusy}
                setCrossLibraryAskBusy={setCrossLibraryAskBusy}
                crossLibrarySearchDraft={crossLibrarySearchDraft}
                setCrossLibrarySearchDraft={setCrossLibrarySearchDraft}
                setActiveCrossLibraryConversation={setActiveCrossLibraryConversation}
                clearConversationRouteState={clearConversationRouteState}
                setModal={setModal}
                setDetailId={setDetailId}
                setToast={setToast}
                openImport={openImport}
                newNote={newNote}
                openSpaceCreation={openSpaceCreation}
                openExport={openExport}
                openSource={openSource}
                openSearchHit={openSearchHit}
                openQuestionSearchDraft={openQuestionSearchDraft}
                openBulkSpaceAssociation={openBulkSpaceAssociation}
                openBulkRecycle={openBulkRecycle}
                openOrganization={openOrganization}
                patchSource={patchSource}
              />
            )}
            {section === "organize" && (
              <OrganizationPanel
                key={`${user?.id || "local"}:${spaceId}`}
                data={data}
                spaceId={spaceId}
                initialSourceIds={selected}
                status={store.organizationStatus}
                durableProcessorState={durableProcessorState}
                onRefreshStatus={store.refreshOrganizationStatus}
                onSpaceChange={(id) => {
                  setSpaceId(id);
                  setSelected([]);
                }}
                onAutoChange={(enabled) =>
                  update((workspace) => ({ ...workspace, autoOrganize: enabled }))
                }
                onGenerate={store.organize}
                onStop={store.stopOrganization}
                onRetry={store.retryOrganization}
                onCheck={store.checkOrganization}
                onApplyTags={(id, tags) => {
                  reviewOrganization(
                    (workspace) => applyOrganizationTags(workspace, id, tags),
                    "已追加所选标签，原有标签保留。",
                  );
                }}
                onUndoTags={(id) => {
                  reviewOrganization(
                    (workspace) => undoOrganizationTags(workspace, id),
                    "本次追加的标签已撤回。",
                  );
                }}
                onSavePage={(jobId, index, accepted) => {
                  const id = crypto.randomUUID();
                  const saved = reviewOrganization(
                    (workspace) => saveOrganizationPage(workspace, jobId, index, accepted, id),
                    accepted === "draft"
                      ? "已保存为待审核草稿。"
                      : "已接受并保存知识页，可继续编辑和核对引用。",
                  );
                  if (saved && accepted === "draft") openNote(id);
                }}
                onIgnorePage={(jobId, index) => {
                  reviewOrganization(
                    (workspace) => ignoreOrganizationPage(workspace, jobId, index),
                    "已忽略该主题，其他建议保留。",
                  );
                }}
                onDismiss={(id) => {
                  reviewOrganization(
                    (workspace) => dismissOrganizationJob(workspace, id),
                    "建议已忽略，另行保存的知识页保留。",
                  );
                }}
                onOpenNote={openNote}
                onOpenCitation={(citation) => {
                  openSource(citation.sourceId, citation.versionId, citation);
                }}
                onLockTags={(id, locked) =>
                  update((workspace) => ({
                    ...workspace,
                    sources: workspace.sources.map((source) =>
                      source.id === id ? { ...source, tagsLocked: locked } : source,
                    ),
                  }))
                }
              />
            )}
            {section === "tasks" && (
              <TaskCenterPanel
                data={data}
                sync={{
                  storageMode,
                  status,
                  error,
                  cloudConfigured,
                  signedIn: Boolean(user),
                  cloudReadOnly,
                  hasRecovery: Boolean(store.recovery),
                  migrationPending: migrationChoicePending,
                  purging: store.purging,
                }}
                organizationStatus={store.organizationStatus}
                durableProcessorState={durableProcessorState}
                onRetrySync={retryWorkspace}
                onResolveSync={openSyncConflict}
                onUseRecovery={() =>
                  store.useRemote(
                    storageMode === "cloud" ? (snapshot) => doExport(snapshot) : undefined,
                  )
                }
                onRefreshOrganizationStatus={store.refreshOrganizationStatus}
                onRetryImport={store.retryImport}
                onCancelImport={store.cancelImport}
                onRetryOrganization={store.retryOrganization}
                onCheckOrganization={store.checkOrganization}
                onStopOrganization={store.stopOrganization}
                onOpenSource={openSource}
                onOpenOrganization={openOrganizationTask}
              />
            )}
            {section === "knowledge" && (
              <KnowledgeSection
                data={data}
                spaceId={spaceId}
                activeSpace={activeSpace}
                knowledgePageCount={knowledgePageCount}
                search={search}
                knowledgeFilter={knowledgeFilter}
                busy={busy}
                openOrganization={openOrganization}
                openExport={openExport}
                newNote={newNote}
                openNote={openNote}
                replaceKnowledgeView={replaceKnowledgeView}
              />
            )}
            {section === "notes" && (
              <NotesSection
                spaceId={spaceId}
                notes={notes}
                search={search}
                searchRef={searchRef}
                setSearch={setSearch}
                newNote={newNote}
                openNote={openNote}
              />
            )}
            {section === "questions" && (
              <QuestionsSection
                data={data}
                spaceId={spaceId}
                questionHistoryFilter={questionHistoryFilter}
                conversationRouteIssue={conversationRouteIssue}
                update={update}
                navigate={navigate}
                changeQuestionHistoryFilter={changeQuestionHistoryFilter}
                openConversation={openConversation}
                openSource={openSource}
              />
            )}
            {section === "trash" && (
              <TrashSection
                data={data}
                ready={ready}
                cloudReadOnly={cloudReadOnly}
                recoverableDraftItems={recoverableDraftItems}
                restoreRecoverableDraft={restoreRecoverableDraft}
                saveRecoveredDraft={saveRecoveredDraft}
                discardRecoveredDraft={discardRecoveredDraft}
                restoreRecycledSource={restoreRecycledSource}
                openSourcePurge={openSourcePurge}
                patchNote={patchNote}
              />
            )}
            {section === "settings" && (
              <SettingsSection
                data={data}
                store={store}
                user={user}
                update={update}
                ready={ready}
                status={status}
                storageMode={storageMode}
                cloudConfigured={cloudConfigured}
                durableProcessorEnabled={durableProcessorEnabled}
                settingsSyncPresentation={settingsSyncPresentation}
                busy={busy}
                exporting={exporting}
                exportProgress={exportProgress}
                navigate={navigate}
                setModal={setModal}
                setToast={setToast}
                setSpaceToDeleteId={setSpaceToDeleteId}
                openExport={openExport}
                openOrganization={openOrganization}
                openSpaceCreation={openSpaceCreation}
              />
            )}
          </div>
        )}
      </main>
      {modal === "restore" && (
        <BackupRestorePanel
          storageMode={storageMode}
          key={store.token}
          data={data}
          accountEmail={user?.email}
          onRestore={store.restoreBackup}
          onClose={() => setModal(null)}
          onOpenRestored={(plan) => {
            setModal(null);
            const firstSpace = plan.data.spaces.find((space) => !space.archived);
            navigate("library", { spaceId: firstSpace?.id || "all", files: Boolean(firstSpace) });
          }}
        />
      )}
      {modal === "legacy-recovery" && user && storageMode === "cloud" && (
        <LegacyBrowserRecoveryPanel
          key={store.token}
          data={data}
          accountEmail={user.email}
          onRestore={store.restoreBackup}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "export" && (
        <Modal
          title="导出备份"
          className="export-backup-modal"
          wide
          onClose={() => setModal(null)}
          dismissible={!exporting}
        >
          <ExportBackupPanel
            key={store.token}
            data={data}
            initialScope={exportScope}
            busy={exporting}
            progress={exportProgress}
            onClose={() => setModal(null)}
            onExport={(snapshot, scope, expectedFingerprint) =>
              doExport(snapshot, { scope, expectedFingerprint })
            }
          />
        </Modal>
      )}
      {modal === "export-result" && exportIssues && (
        <ExportResultModal
          exportIssues={exportIssues}
          setModal={setModal}
          setExportIssues={setExportIssues}
        />
      )}
      {modal === "sync-conflict" &&
        (readingConflictPlanSnapshot || store.readingProgressSyncPlan ? (
          <ReadingProgressConflictModal
            storageMode={storageMode}
            plan={readingConflictPlanSnapshot || store.readingProgressSyncPlan!}
            onResolve={async (selections) => {
              readingConflictResolving.current = true;
              try {
                await store.resolveReadingProgressConflicts(selections);
              } finally {
                // The selected position is persisted locally before the cloud
                // CAS. Apply whichever durable local state remains even when
                // the cloud confirmation fails, then release delayed readers.
                setReadingPositionResolutionEpoch((current) => current + 1);
                // Keep stale throttled callbacks fenced until the mounted
                // readers have consumed the chosen position and cleared them.
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                // A failed preflight or CAS may publish a newer conflict while
                // this reviewed snapshot stays mounted. Refresh its candidates
                // after React has observed that coordinator publication.
                if (latestReadingProgressSyncPlan.current)
                  setReadingConflictPlanSnapshot(
                    structuredClone(latestReadingProgressSyncPlan.current),
                  );
                readingConflictResolving.current = false;
              }
            }}
            onClose={() => {
              setReadingConflictPlanSnapshot(null);
              setModal(null);
            }}
          />
        ) : store.noteSyncPlan ? (
          <SyncConflictModal
            storageMode={storageMode}
            key={`${store.token}:${store.recoveryRevision}`}
            plan={store.noteSyncPlan}
            onResolve={store.resolveNoteConflicts}
            onClose={() => setModal(null)}
          />
        ) : (
          <Modal title="同步冲突" onClose={() => setModal(null)}>
            <div className="modal-body">
              <p className="muted">
                待处理内容已变化，或同时涉及资料、空间或删除记录。为了避免覆盖未检查的内容，请先导出当前副本，再选择云端恢复。
              </p>
              <div className="modal-actions">
                <button className="btn btn-primary" onClick={() => setModal(null)}>
                  知道了
                </button>
              </div>
            </div>
          </Modal>
        ))}
      {modal === "space" && (
        <SpaceCreationModal
          spaceCreationIntent={spaceCreationIntent}
          update={update}
          setToast={setToast}
          setSpaceCreationIntent={setSpaceCreationIntent}
          setImportTargetSpaceId={setImportTargetSpaceId}
          setModal={setModal}
          chooseSpace={chooseSpace}
          closeSpaceCreation={closeSpaceCreation}
        />
      )}
      {modal === "delete-space" && spaceToDelete && (
        <DeleteSpaceModal
          data={data}
          space={spaceToDelete}
          onClose={() => {
            setModal(null);
            setSpaceToDeleteId(null);
          }}
          onDelete={(recycleExclusiveSources, expectedFingerprint) =>
            removeLearningSpace(spaceToDelete.id, recycleExclusiveSources, expectedFingerprint)
          }
        />
      )}
      {modal === "purge-source" && sourceToPurge && (
        <SourcePurgeModal
          key={`${user?.id}:${store.token}:${store.localCacheMode}:${sourceToPurge.id}`}
          contextKey={`${user?.id}:${store.token}:${store.localCacheMode}:${sourceToPurge.id}`}
          reviewKey={sourcePurgeReviewKey}
          source={sourceToPurge}
          onClose={() => {
            if (store.purging) return;
            setModal(null);
            setSourceToPurgeId(null);
          }}
          onPreview={(selection, signal) =>
            store.previewSourcePurge(sourceToPurge.id, selection, signal)
          }
          onPurge={(preview) => permanentlyPurgeSource(sourceToPurge, preview)}
        />
      )}
      {modal === "conversation-history" && conversationToInspect && (
        <ConversationHistoryModal
          conversation={conversationToInspect}
          onClose={() => {
            setModal(null);
            setConversationToInspectId(null);
          }}
        />
      )}
      {modal === "import" && (
        <ImportModal
          storageMode={storageMode}
          spaceId={importTargetSpaceId || activeSpace?.id || ""}
          spaces={data.spaces.filter((s) => !s.archived)}
          sources={data.sources}
          jobs={data.importJobs ?? []}
          cloudUserId={store.user?.id}
          saveState={status}
          saveError={error}
          onClose={() => {
            setImportTargetSpaceId(null);
            setModal(null);
          }}
          onWebImport={(source) => {
            const applied = update((d) => {
              const next =
                source.kind === "web"
                  ? addWebSource(d, source)
                  : {
                      ...d,
                      sources: d.sources.some((s) => s.id === source.id)
                        ? d.sources.map((s) => (s.id === source.id ? source : s))
                        : [source, ...d.sources],
                    };
              return next;
            });
            if (!applied) throw new Error("工作区已改变，请重新打开导入窗口。");
          }}
          onImportFile={store.importFile}
          onRetryImport={store.retryImport}
          onCancelImport={store.cancelImport}
          onOpen={(id) => {
            setImportTargetSpaceId(null);
            setModal(null);
            openSource(id);
          }}
        />
      )}
      {modal === "account" && (
        <Modal
          title={cloudConfigured ? "账号与云端保存" : "本机工作区"}
          onClose={() => setModal(null)}
        >
          <div className="modal-body">
            <AccountPanel
              storageMode={storageMode}
              onSessionChange={() => {}}
              onAccountDeletion={store.discardAccount}
              signOutControl={accountDeletionState ? undefined : signOutControl}
              onClose={() => setModal(null)}
            />
          </div>
        </Modal>
      )}
      {modal === "details" && detail && (
        <SourceDetailsModal
          detail={detail}
          data={data}
          setModal={setModal}
          patchSource={patchSource}
          reviewOrganization={reviewOrganization}
          openOrganization={openOrganization}
          openBulkRecycle={openBulkRecycle}
          downloadOriginal={downloadOriginal}
        />
      )}
      {modal === "recognized-content" && detail && (
        <Modal title="已识别内容" wide onClose={() => setModal("details")}>
          <RecognizedContentPanel
            source={detail}
            onBack={() => setModal("details")}
            onOpenSource={(citation) => {
              setModal(null);
              openSource(detail.id, detail.versionId, citation, undefined, {
                kind: "recognized-content",
                sourceId: detail.id,
                versionId: detail.versionId,
                libraryRoute: currentLibraryReturnRoute(location.hash),
              });
            }}
          />
        </Modal>
      )}
      {modal === "bulk-tags" && (
        <Modal
          title={`为 ${new Set(selected).size} 份资料添加标签`}
          onClose={() => {
            setModal(null);
            setSelected([]);
          }}
        >
          <BulkSourceTagsPanel
            data={data}
            sourceIds={selected}
            contextKey={JSON.stringify([store.token, user?.id ?? null, localCacheMode])}
            onClose={() => {
              setModal(null);
              setSelected([]);
            }}
            onApply={async (updater) => {
              const assertCurrent = () => {
                if (
                  bulkWriteContext.current !== bulkWriteIdentity ||
                  !bulkWriteIdentity.ready ||
                  bulkWriteIdentity.modal !== "bulk-tags"
                )
                  throw new Error("当前账号、缓存模式或所选资料已改变，请重新打开批量标签。");
              };
              assertCurrent();
              let saved: boolean;
              try {
                saved = await updateDurably((workspace) => {
                  assertCurrent();
                  const next = updater(workspace);
                  // All-noop, all-failed and retry after a failed disk write still
                  // need a real snapshot acknowledgement, not a fake success.
                  return next === workspace ? { ...workspace } : next;
                });
              } catch (cause) {
                assertCurrent();
                throw cause;
              }
              assertCurrent();
              if (!saved) throw new Error("批量标签未提交，请检查工作区保存状态后重试。");
            }}
          />
        </Modal>
      )}
      {modal === "compare-source" && (
        <ComparisonSourceModal
          readingSource={readingSource}
          comparisonPickerSpace={comparisonPickerSpace}
          comparisonCandidates={comparisonCandidates}
          comparisonTargetId={comparisonTargetId}
          setComparisonTargetId={setComparisonTargetId}
          setModal={setModal}
          startComparison={startComparison}
        />
      )}
      {(modal === "bulk-spaces" || modal === "bulk-recycle") && (
        <BulkSourceActionsPanel
          kind={modal === "bulk-spaces" ? "associate" : "recycle"}
          data={data}
          sourceIds={selected}
          contextKey={JSON.stringify([store.token, user?.id ?? null, localCacheMode])}
          onApply={(updater) => persistBulkWorkspace(updater, modal)}
          onClose={(completed) => {
            setModal(null);
            if (completed) setSelected([]);
          }}
          onContinue={(sourceIds, targetSpaceId) => {
            const issue = "目标空间或本次成功资料已变化，请重新核对后再继续审核。";
            if (
              bulkWriteContext.current !== bulkWriteIdentity ||
              !ready ||
              modal !== "bulk-spaces" ||
              !sourceIds.length ||
              sourceIds.some((id) => !selected.includes(id))
            )
              throw new Error(issue);
            // A coordinator publish can precede this render's commit. Recheck
            // the entire confirmed scope against the live actor before navigating.
            const latest = store.getCurrentWorkspaceData();
            const currentSources = new Map(latest.sources.map((source) => [source.id, source]));
            const expectedVersions = new Map(
              data.sources.map((source) => [source.id, source.versionId]),
            );
            if (
              !latest.spaces.some((space) => space.id === targetSpaceId && !space.archived) ||
              sourceIds.some((id) => {
                const source = currentSources.get(id);
                return (
                  !source ||
                  Boolean(source.deletedAt) ||
                  source.versionId !== expectedVersions.get(id) ||
                  !source.spaceIds.includes(targetSpaceId)
                );
              })
            )
              throw new Error(issue);
            openOrganization(sourceIds, targetSpaceId);
          }}
        />
      )}
      {modal === "history" && currentNote && (
        <NoteHistoryModal
          currentNote={currentNote}
          update={update}
          setEditorKey={setEditorKey}
          setModal={setModal}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
          <button className="icon-btn" aria-label="关闭提示" onClick={() => setToast("")}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
