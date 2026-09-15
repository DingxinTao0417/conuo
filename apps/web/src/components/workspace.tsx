"use client";
import dynamic from "next/dynamic";
import Image from "next/image";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  Cloud,
  FileText,
  FolderOpen,
  FolderPlus,
  History,
  Inbox,
  GitBranch,
  LayoutGrid,
  Library,
  Loader2,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Star,
  StickyNote,
  Tag,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  useWorkspace,
  type AnonymousWorkspaceMigrationState,
  type NoteSyncConflictSelection,
  type ReadingProgressSyncSelection,
} from "@/lib/use-workspace";
import { addWebSource } from "@/lib/web-import";
import {
  getSourceVersion,
  refreshWebSource,
  restoreArchivedSourceVersion,
} from "@/lib/source-versions";
import { citationProblem } from "./reader-utils";
import LearningContinuationCard from "./learning-continuation-card";
import LearningSpaceNameInput from "./learning-space-name-input";
import CloudUpdateNotice from "./cloud-update-notice";
import WebImportForm from "./web-import-form";
import { createDemoWorkspace } from "@/lib/seed";
import { exportWorkspace, type ExportIssue, type ExportProgress } from "@/lib/export";
import { workspaceExportFingerprint, type WorkspaceExportScope } from "@/lib/export-scope";
import ExportBackupPanel from "./export-backup-panel";
import SourcePurgeModal from "./source-purge-modal";
import BulkSourceTagsPanel from "./bulk-source-tags-panel";
import BulkSourceActionsPanel from "./bulk-source-actions-panel";
import AccountAccessStopped from "./account-access-stopped";
import {
  permanentSourceDeletionFingerprint,
  previewPermanentSourceDeletionContent,
} from "@/lib/permanent-deletion";
import { isCloudConfigured, type SourcePurgePreview } from "@/lib/cloud";
import { createClient } from "@/lib/supabase/client";
import {
  LOCAL_IMPORT_QUOTA_POLICY,
  assessImportQuota,
  formatImportQuotaBytes,
} from "@/lib/import-quota";
import {
  primaryLearningContinuation,
  recentlyReadSources,
  unresolvedConversations,
} from "@/lib/learning-continue";
import { pinnedLibrarySources } from "@/lib/library-navigation";
import {
  formatLibraryRoute,
  isLibraryFilter,
  normalizeLibraryTags,
  parseLibraryRoute,
  type LibraryFilter,
  type LibraryRoute,
} from "@/lib/library-route";
import {
  isCreatedWithinLibraryRange,
  isLibraryTimeFilter,
  libraryCreatedRange,
  type LibraryTimeFilter,
} from "@/lib/library-time-filter";
import {
  defaultLibrarySort,
  isLibrarySort,
  sortLibrarySources,
  type LibrarySort,
} from "@/lib/library-sort";
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
import {
  CROSS_LIBRARY_MAX_SOURCES,
  crossLibrarySourceEligibility,
  isCrossLibraryConversation,
} from "@/lib/cross-library-ask";
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
  renameLearningSpace,
  type SpaceDeletionImpact,
} from "@/lib/space-lifecycle";
import type {
  Citation,
  Chunk,
  Conversation,
  Note,
  SaveState,
  Source,
  Space,
  WorkspaceData,
} from "@/lib/types";
import {
  sourceCaptureScopeNotice,
  sourceCoverageLabel,
  sourceParserCoverageNotice,
  sourcePresentationStatus,
} from "@/lib/source-coverage";
import {
  sourceAiStatus,
  sourceKindLabel,
  sourceOriginLabel,
  sourceReadingStatus,
  sourceTimestampLabel,
} from "@/lib/source-metadata";
import type { ImportJob } from "@/lib/import-queue";
import type { NoteSyncPlan, ReadingProgressSyncPlan } from "@/lib/sync-conflicts";
import { workspaceSyncPresentation } from "@/lib/workspace-sync-presentation";
import Modal from "./modal";
import { markdownToEditorHtml } from "@/lib/markdown";
import { appendAnswerToKnowledgePage } from "@/lib/answer-to-knowledge";
import {
  appendExcerptToKnowledgePage,
  createKnowledgePageFromExcerpt,
} from "@/lib/excerpt-to-knowledge";
import CollectionLibrary, { CollectionActions } from "./collection-library";
import "./library-workspace.css";
import ModelStatus from "./model-status";
import AiUsagePanel from "./ai-usage-panel";
import WorkspaceSearch, {
  type WorkspaceSearchAskDraft,
  type WorkspaceSearchIntent,
} from "./workspace-search";
import IndexingPanel from "./indexing-panel";
import InstallAppPanel from "./install-app-panel";
import StorageUsagePanel from "./storage-usage-panel";
import QuestionHistoryList from "./question-history-list";
import KnowledgeLibrary from "./knowledge-library";
import RecoverableDraftsPanel, { type RecoverableDraftItem } from "./recoverable-drafts-panel";
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
  setSourceTags,
  acceptKnowledgePage,
} from "@/lib/organization-review";
import { knowledgeAcceptanceReason } from "@/lib/organization";
import { cleanupOrganizationHistory } from "@/lib/organization-history";
import {
  isOrganizationProcessorEnabled,
  organizationProcessorStateFromEnvironment,
} from "@/lib/organization-processor-capability";
import { applyKnowledgeUpdate, ignoreKnowledgeChange } from "@/lib/knowledge-update";
import {
  persistKnowledgeUpdateWithdrawal,
  type KnowledgeUpdateWithdrawalOperationContext,
} from "@/lib/knowledge-update-withdrawal-operation";
import { reviseNote, restoreNoteVersion } from "@/lib/note-versions";
import {
  acceptRelationProposal,
  ignoreRelationProposal,
  saveConceptRelation,
  deleteConceptRelation,
  restoreConceptRelation,
} from "@/lib/concept-relations";
const ConceptRelationsPanel = dynamic(() => import("./concept-relations-panel"), { ssr: false });
const KnowledgeUpdatePanel = dynamic(() => import("./knowledge-update-panel"), { ssr: false });
const OrganizationPanel = dynamic(() => import("./organization-panel"), { ssr: false });
const TaskCenterPanel = dynamic(() => import("./task-center-panel"), { ssr: false });
const OrganizationHistoryControl = dynamic(() => import("./organization-history-control"), {
  ssr: false,
});
const Reader = dynamic(() => import("./reader"), {
  ssr: false,
  loading: () => (
    <div className="page-loading">
      <Loader2 className="spin" size={20} />
      正在打开阅读器…
    </div>
  ),
});
const ComparisonReader = dynamic(() => import("./comparison-reader"), {
  ssr: false,
  loading: () => (
    <div className="page-loading">
      <Loader2 className="spin" size={20} />
      正在打开对照阅读…
    </div>
  ),
});
const NoteEditor = dynamic(() => import("./note-editor"), { ssr: false });
const AccountPanel = dynamic(() => import("./account-panel"), { ssr: false });
const BackupRestorePanel = dynamic(() => import("./backup-restore-panel"), { ssr: false });
const LegacyBrowserRecoveryPanel = dynamic(() => import("./legacy-browser-recovery-panel"), {
  ssr: false,
});
const CrossLibraryAskPanel = dynamic(() => import("./cross-library-ask-panel"), { ssr: false });
const KnowledgeEvidenceAskPanel = dynamic(() => import("./knowledge-evidence-ask-panel"), {
  ssr: false,
});
type Section =
  | "home"
  | "library"
  | "notes"
  | "knowledge"
  | "organize"
  | "questions"
  | "tasks"
  | "trash"
  | "settings";
const spaceTabs = [
  ["home", "概览"],
  ["library", "资料"],
  ["knowledge", "知识"],
  ["questions", "问答"],
] as const;
type SpaceTab = (typeof spaceTabs)[number][0];
const sections = [
  ["home", "学习概览", LayoutGrid],
  ["library", "资料库", Library],
  ["questions", "我的问答", Sparkles],
  ["notes", "我的笔记", StickyNote],
  ["knowledge", "知识页", BookOpen],
  ["organize", "AI 整理", Tag],
  ["tasks", "任务中心", History],
] as const;
const labels: Record<Section, string> = {
  home: "学习概览",
  library: "资料库",
  notes: "我的笔记",
  knowledge: "知识页",
  organize: "AI 整理",
  questions: "我的问答",
  tasks: "任务中心",
  trash: "回收站",
  settings: "设置",
};
const statusLabel = {
  saved: "已保存",
  parsing: "解析中",
  ready: "可检索",
  partial: "部分可检索",
  failed: "解析失败",
  "link-only": "仅链接",
};
const sourceStatusLabel = (source: Source) =>
  sourceCoverageLabel(source) || statusLabel[source.status];

type RecognizedContentState = {
  tone: "ready" | "partial" | "pending" | "unavailable";
  title: string;
  description: string;
};

type CrossLibrarySearchDraft = WorkspaceSearchAskDraft & { id: string };
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

/**
 * Keeps source processing language consistent with the actual retrieval
 * contract. Saving bytes, extracting text, and permitting AI are deliberately
 * different states for a learner.
 */
function recognizedContentState(source: Source): RecognizedContentState {
  switch (sourcePresentationStatus(source)) {
    case "link-only":
      return {
        tone: "unavailable",
        title: "仅保存了链接",
        description: "没有保存可检索正文，因此暂时没有可打开的已识别片段。",
      };
    case "failed":
      return {
        tone: "unavailable",
        title: "未提取到可检索正文",
        description: "原文件仍可打开或下载，但暂时不能依据正文搜索、问答或整理。",
      };
    case "saved":
      return {
        tone: "pending",
        title: "原文件已保存，等待提取正文",
        description: "原件已经保留；完成文本提取和准备检索后，已识别片段会显示在这里。",
      };
    case "parsing":
      return {
        tone: "pending",
        title: "正在提取正文",
        description: "处理完成前不能保证正文覆盖范围，也不会把资料显示为已可用于 AI。",
      };
    case "partial":
      return {
        tone: "partial",
        title: "部分原文已识别",
        description: source.aiAllowed
          ? "下方只列出当前可用于搜索、问答和整理的原文片段。"
          : "下方只列出当前可用于阅读和关键词搜索的原文片段。",
      };
    default:
      return {
        tone: "ready",
        title: source.aiAllowed ? "原文已识别，可用于 AI" : "原文已识别",
        description: source.aiAllowed
          ? "可从下方片段进入原文，也可用于关键词搜索、问答和整理。"
          : "可从下方片段进入原文并进行关键词搜索。",
      };
  }
}

function recognizedChunkLocation(chunk: Chunk, index: number) {
  const section = chunk.section.replace(/\s+/g, " ").trim();
  if (chunk.page) return section ? `第 ${chunk.page} 页 · ${section}` : `第 ${chunk.page} 页`;
  return section || `已识别片段 ${index + 1}`;
}

function recognizedChunkPreview(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 220 ? `${normalized.slice(0, 220)}…` : normalized;
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
const plain = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
const normalizedTag = (value: string) =>
  value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
const date = (value: string) =>
  new Date(value).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
const sizeLabel = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;
const inboxSpace: Space = {
  id: "inbox",
  name: "收件箱",
  goal: "",
  color: "#4B3FE3",
  archived: false,
  createdAt: "",
};

/** A fresh workspace starts with one editable library so first import has a home. */
function isUntouchedStarterWorkspace(data: WorkspaceData) {
  const [starter] = data.spaces;
  return Boolean(
    starter &&
    data.spaces.length === 1 &&
    starter.name === "我的学习空间" &&
    !starter.archived &&
    data.sources.length === 0 &&
    data.notes.length === 0 &&
    data.annotations.length === 0 &&
    data.conversations.length === 0 &&
    (data.importJobs?.length ?? 0) === 0,
  );
}
function SourceIcon({ source }: { source: Source }) {
  return (
    <span className={`file-icon file-${source.kind}`}>
      <FileText size={21} />
      <small>{source.kind === "markdown" ? "MD" : source.kind.toUpperCase()}</small>
    </span>
  );
}

function RecognizedContentPanel({
  source,
  onBack,
  onOpenSource,
}: {
  source: Source;
  onBack: () => void;
  onOpenSource: (citation?: Citation) => void;
}) {
  const state = recognizedContentState(source);
  const presentationStatus = sourcePresentationStatus(source);
  const supportsKeywordSearch = presentationStatus === "ready" || presentationStatus === "partial";
  const chunks = source.chunks
    .filter(
      (chunk) =>
        chunk.sourceId === source.id &&
        chunk.versionId === source.versionId &&
        Boolean(chunk.text.trim()),
    )
    .sort((left, right) => left.order - right.order);
  const notices = [sourceCaptureScopeNotice(source), sourceParserCoverageNotice(source)].filter(
    Boolean,
  );

  return (
    <div className="recognized-content-panel">
      <section className={`recognized-content-status recognized-content-status-${state.tone}`}>
        <div>
          <span className="recognized-content-eyebrow">资料可用范围</span>
          <h3>{state.title}</h3>
          <p>{state.description}</p>
        </div>
        <span className="recognized-content-status-label">{sourceStatusLabel(source)}</span>
      </section>

      {!source.aiAllowed && (
        <p className="recognized-content-ai-off" role="status">
          <ShieldCheck size={15} aria-hidden="true" />
          <span>
            <strong>AI 使用已关闭。</strong>
            {supportsKeywordSearch
              ? "原文仍可阅读和关键词搜索，不会用于问答或整理。"
              : "当前没有可用于关键词搜索的正文，也不会用于问答或整理。"}
          </span>
        </p>
      )}

      {notices.length > 0 && (
        <div className="recognized-content-notices" role="status">
          {notices.map((notice) => (
            <p key={notice}>{notice}</p>
          ))}
        </div>
      )}

      <section className="recognized-content-list" aria-labelledby="recognized-content-title">
        <header>
          <div>
            <h3 id="recognized-content-title">已识别内容</h3>
            <p>
              {chunks.length
                ? `当前显示 ${chunks.length} 段可定位的原文。`
                : "当前没有可定位的已识别原文。"}
            </p>
          </div>
          {source.parsedPages !== undefined && source.pageCount !== undefined && (
            <span className="recognized-content-page-count">
              已提取 {source.parsedPages} / {source.pageCount} 页
            </span>
          )}
        </header>

        {chunks.length ? (
          <ol>
            {chunks.map((chunk, index) => {
              const location = recognizedChunkLocation(chunk, index);
              return (
                <li key={chunk.id}>
                  <button
                    type="button"
                    className="recognized-content-chunk"
                    onClick={() =>
                      onOpenSource({
                        sourceId: source.id,
                        versionId: source.versionId,
                        chunkId: chunk.id,
                        title: source.title,
                        quote: chunk.text,
                        page: chunk.page,
                        section: chunk.section.trim() || location,
                      })
                    }
                  >
                    <span>{location}</span>
                    <p>{recognizedChunkPreview(chunk.text)}</p>
                    <small>打开原文</small>
                  </button>
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="recognized-content-empty">
            <FileText size={18} aria-hidden="true" />
            <p>{state.description}</p>
          </div>
        )}
      </section>

      <div className="modal-actions recognized-content-actions">
        <button type="button" className="btn" onClick={onBack}>
          <ArrowLeft size={14} />
          返回资料详情
        </button>
        <button type="button" className="btn btn-primary" onClick={() => onOpenSource()}>
          打开资料
        </button>
      </div>
    </div>
  );
}

function AnonymousWorkspaceMigrationNotice({
  migration,
  onMigrate,
  onSkip,
  compact = false,
}: {
  migration: AnonymousWorkspaceMigrationState | undefined;
  onMigrate: () => void;
  onSkip: () => void;
  /** Keep non-decision guidance unobtrusive in reading and comparison workspaces. */
  compact?: boolean;
}) {
  migration ??= { kind: "none", canMigrate: false };
  const [detailsOpen, setDetailsOpen] = useState(false);
  if (migration.kind === "none" || migration.kind === "dismissed") return null;
  const counts = [
    migration.sourceCount ? `${migration.sourceCount} 份资料` : "",
    migration.noteCount ? `${migration.noteCount} 篇笔记` : "",
  ].filter(Boolean);
  const isDecision = migration.kind === "pending" || migration.kind === "migrating";
  const expanded = isDecision || detailsOpen;
  // A migration that needs an explicit choice must remain fully visible. Other
  // guidance stays one line in immersive workspaces until the learner opens it.
  const compactEntry = compact && !expanded;
  const detailsId = "anonymous-workspace-migration-details";
  const title =
    migration.kind === "migrated"
      ? "本机资料已复制到当前账号"
      : migration.kind === "requires-export"
        ? "资料副本存在差异"
        : migration.kind === "unavailable"
          ? "暂时无法检查本机资料"
          : "发现此浏览器中的本机资料";
  const confirmation =
    migration.kind === "migrated"
      ? migration.pendingCloudConfirmation
        ? "本机副本已经确认，正在上传原件并确认云端资料库。"
        : "当前账号已确认云端资料库；原匿名副本仍保留在此浏览器。"
      : "";

  return (
    <section
      className={`notice anonymous-workspace-migration anonymous-workspace-migration-${migration.kind} ${expanded ? "is-expanded" : "is-collapsed"}${compactEntry ? " is-compact" : ""}`}
      aria-label="本机资料迁移"
      aria-busy={migration.kind === "migrating" || undefined}
      aria-live="polite"
      role="status"
    >
      <FolderOpen size={17} aria-hidden="true" />
      <div className="anonymous-workspace-copy">
        <div className="anonymous-workspace-heading">
          <strong>{title}</strong>
          {!expanded && counts.length > 0 && <small>{counts.join(" · ")}</small>}
        </div>
        <div id={detailsId} className="anonymous-workspace-details" hidden={!expanded}>
          <p>
            {migration.message}
            {counts.length ? ` 当前副本包含${counts.join("、")}。` : ""}
          </p>
          {confirmation && <p className="anonymous-workspace-confirmation">{confirmation}</p>}
          {migration.kind === "requires-export" && (
            <p className="anonymous-workspace-followup">
              为保护两份内容，系统没有自动合并。若要整合，请先退出账号，在本机工作区导出备份，再通过恢复功能导入。
            </p>
          )}
        </div>
      </div>
      {!isDecision && (
        <button
          type="button"
          className="anonymous-workspace-toggle"
          aria-controls={detailsId}
          aria-expanded={expanded}
          onClick={() => setDetailsOpen((current) => !current)}
        >
          {expanded ? "收起" : migration.kind === "requires-export" ? "查看处理方法" : "查看详情"}
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
      {isDecision && (
        <div className="anonymous-workspace-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!migration.canMigrate}
            onClick={onMigrate}
          >
            {migration.kind === "migrating" ? "正在迁移…" : "迁移到当前账号"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={migration.kind === "migrating"}
            onClick={onSkip}
          >
            暂不迁移
          </button>
        </div>
      )}
    </section>
  );
}

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
  const [noteSearchTarget, setNoteSearchTarget] = useState<{
    noteId: string;
    revision: number;
    updatedAt: string;
    text: string;
  }>();
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
    [setModal, setToast],
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
  }, [setModal]);

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
    [clearConversationRouteState, setSelected],
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
    [applyLibraryRouteState, setModal, setToast],
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
  }, [clearConversationRouteState, layout, modal, setSelected, spaceId]);

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
    [data, setModal],
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
  }, [setModal]);

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
      {sidebar && (
        <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setSidebar(false)} />
      )}
      <aside className={`sidebar ${sidebar ? "sidebar-open" : ""}`}>
        <button className="brand" onClick={() => navigate("home")} aria-label="Conuo 学习概览">
          <Image src="/conuo-logo.png" alt="" width={34} height={34} priority />
          <span>
            Conuo <small>可诺</small>
          </span>
        </button>
        <nav aria-label="主导航">
          {sections.map(([key, label, Icon]) => (
            <button
              key={key}
              className={`nav-item ${section === key && !currentSource && !currentNote ? "active" : ""}`}
              aria-label={label}
              title={label}
              onClick={() => {
                if (key === "library") {
                  openCollectionHome();
                } else {
                  navigate(key);
                }
              }}
            >
              <Icon size={17} />
              <span className="nav-item-label">{label}</span>
              {key === "library" && (
                <span className="nav-count">{data.sources.filter((s) => !s.deletedAt).length}</span>
              )}
              {key === "tasks" && <span className="nav-count">{activeTaskCount || ""}</span>}
            </button>
          ))}
        </nav>
        <section className="pinned-source-section" aria-labelledby="pinned-source-title">
          <div className="nav-heading">
            <span id="pinned-source-title">置顶资料</span>
          </div>
          {pinnedSources.length > 0 && (
            <div className="pinned-source-list">
              {pinnedSources.map((source) => (
                <button
                  key={source.id}
                  className={`nav-item ${sourceId === source.id ? "active" : ""}`}
                  aria-label={`打开置顶资料 ${source.title}`}
                  title={source.title}
                  onClick={() => openSource(source.id)}
                >
                  <FileText size={16} />
                  <span className="nav-item-label">{source.title}</span>
                </button>
              ))}
            </div>
          )}
        </section>
        <div className="nav-heading">
          <span>我的知识库</span>
          <button className="icon-btn" aria-label="新建知识库" onClick={() => openSpaceCreation()}>
            <Plus size={15} />
          </button>
        </div>
        <div className="space-list">
          {data.spaces
            .filter((s) => !s.archived)
            .map((s) => (
              <button
                key={s.id}
                className={`nav-item ${spaceId === s.id ? "space-active" : ""}`}
                aria-label={s.name}
                title={s.name}
                onClick={() => chooseSpace(s.id)}
              >
                <span className="space-dot" style={{ background: s.color }} />
                <span className="nav-item-label">{s.name}</span>
              </button>
            ))}
          <button
            className="nav-item"
            onClick={() => chooseSpace("inbox")}
            aria-label="收件箱"
            title="收件箱"
          >
            <Inbox size={16} />
            <span className="nav-item-label">收件箱</span>
            <span className="nav-count">
              {data.sources.filter((s) => !s.deletedAt && !s.spaceIds.length).length || ""}
            </span>
          </button>
        </div>
        <div className="sidebar-bottom">
          <div className="local-hint">
            <ShieldCheck size={15} />
            <span>
              {user ? "私有学习空间" : "本机工作区"}
              <small>
                {user
                  ? "仅你可以访问"
                  : cloudConfigured
                    ? "资料保存在当前浏览器"
                    : "云端同步暂不可用"}
              </small>
            </span>
          </div>
          <button
            className={`nav-item ${section === "trash" ? "active" : ""}`}
            onClick={() => navigate("trash")}
            aria-label="回收站"
            title="回收站"
          >
            <Trash2 size={16} />
            <span className="nav-item-label">回收站</span>
          </button>
          <button
            className={`nav-item ${section === "settings" ? "active" : ""}`}
            onClick={() => navigate("settings")}
            aria-label="设置"
            title="设置"
          >
            <Settings2 size={16} />
            <span className="nav-item-label">设置</span>
          </button>
          <button
            className="user-button"
            onClick={() => setModal("account")}
            disabled={status === "saving"}
            aria-label={
              user && cloudConfigured
                ? `账号与云端保存：${user.email}`
                : cloudConfigured
                  ? "登录以连接云端"
                  : "本机工作区"
            }
            title={
              user && cloudConfigured
                ? "账号与云端保存"
                : cloudConfigured
                  ? "登录以连接云端"
                  : "本机工作区"
            }
          >
            <span className="avatar">{user?.email.slice(0, 1).toUpperCase() || "C"}</span>
            <span>
              <b>
                {user && cloudConfigured
                  ? user.email
                  : cloudConfigured
                    ? "开始你的学习之旅"
                    : "本机工作区"}
              </b>
              <small>
                {user && cloudConfigured
                  ? "账号与云端保存"
                  : cloudConfigured
                    ? "登录以连接云端"
                    : "云端同步暂不可用"}
              </small>
            </span>
            <ChevronRight size={15} />
          </button>
        </div>
      </aside>
      <main className="app-main">
        {!isReadingWorkspace && (
          <header className="topbar">
            <button
              className="icon-btn mobile-menu"
              aria-label="打开导航"
              onClick={() => setSidebar(true)}
            >
              <Menu size={19} />
            </button>
            {isLibraryWorkspace ? (
              <>
                {section === "library" && !isCollectionHome && (
                  <button
                    className="icon-btn library-back"
                    aria-label="返回全部知识库"
                    title="返回全部知识库"
                    onClick={openCollectionHome}
                  >
                    <ArrowLeft size={18} />
                  </button>
                )}
                <h1
                  className="collection-home-title"
                  title={section === "library" ? libraryTitle : labels[section]}
                >
                  {section === "library" ? libraryTitle : labels[section]}
                </h1>
              </>
            ) : (
              <div className="breadcrumbs">
                <span>{activeSpace?.name || "我的知识库"}</span>
                <ChevronRight size={13} />
                <b>{currentSource?.title || currentNote?.title || labels[section]}</b>
              </div>
            )}
            <div className="topbar-end">
              <button
                className="topbar-search-trigger"
                onClick={openAllSourcesSearch}
                aria-label={activeSpace ? `搜索当前空间：${activeSpace.name}` : "搜索资料"}
                title={activeSpace ? `搜索当前空间：${activeSpace.name}` : "搜索资料"}
              >
                <Search size={16} />
                <span>{activeSpace ? "搜索当前空间" : "搜索资料"}</span>
                <kbd>Ctrl K</kbd>
              </button>
              <span
                className={`save-status save-${cloudReadOnly ? "readonly" : status}`}
                role="status"
              >
                {status === "saving" || status === "loading" ? (
                  <Loader2 size={14} className="spin" />
                ) : status === "cloud" || cloudReadOnly ? (
                  <Cloud size={14} />
                ) : status === "local" ? (
                  <Check size={14} />
                ) : (
                  <History size={14} />
                )}
                <span>{saveLabel}</span>
              </span>
              <button
                className="topbar-account"
                onClick={() => setModal("account")}
                disabled={status === "saving"}
                aria-label={
                  user && cloudConfigured
                    ? `账号与云端保存：${user.email}`
                    : cloudConfigured
                      ? "登录以连接云端"
                      : "本机工作区"
                }
                title={
                  user && cloudConfigured
                    ? "账号与云端保存"
                    : cloudConfigured
                      ? "登录以连接云端"
                      : "本机工作区"
                }
              >
                <span className="topbar-avatar">
                  {user?.email.slice(0, 1).toUpperCase() || "C"}
                </span>
                <span className="topbar-account-label">
                  {user && cloudConfigured ? user.email : cloudConfigured ? "登录" : "本机"}
                </span>
              </button>
            </div>
          </header>
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
          <div className="note-page">
            <div className="content-toolbar">
              <button className="btn" onClick={() => closeNote(currentNote)}>
                <ArrowLeft size={15} />
                返回
              </button>
              <span className={`badge ${currentNote.status === "draft" ? "badge-warning" : ""}`}>
                {currentNote.status === "draft"
                  ? "待审核草稿"
                  : currentNote.kind === "knowledge"
                    ? "已接受"
                    : "个人笔记"}
              </span>
              <div className="grow" />
              {currentNote.kind === "knowledge" && (
                <button className="btn" onClick={() => openConceptRelations(currentNote.id)}>
                  <GitBranch size={15} />
                  知识关系
                </button>
              )}
              {currentNote.kind === "knowledge" && (
                <button className="btn" onClick={() => openKnowledgeUpdate(currentNote.id)}>
                  <Sparkles size={15} />
                  更新建议
                </button>
              )}
              {currentNote.kind === "knowledge" && currentNote.status === "accepted" && (
                <button
                  className="btn"
                  disabled={!knowledgeEvidence?.ok}
                  title={
                    knowledgeEvidence?.ok
                      ? "只使用本页引用的原始资料提问"
                      : knowledgeEvidence?.message
                  }
                  onClick={() => setKnowledgeEvidenceAskOpen(true)}
                >
                  <Sparkles size={15} />
                  基于原始依据提问
                </button>
              )}
              <button className="btn" onClick={() => setModal("history")}>
                <History size={15} />
                历史版本
              </button>
              {currentNote.kind === "knowledge" && currentNote.status === "draft" && (
                <button
                  className="btn btn-primary"
                  disabled={!!acceptanceReason}
                  onClick={() => {
                    reviewOrganization(
                      (workspace) => acceptKnowledgePage(workspace, currentNote.id),
                      "知识页已接受。当前问答仍只参考导入的原始资料。",
                    );
                  }}
                >
                  <Check size={15} />
                  接受知识页
                </button>
              )}
              <button
                className="icon-btn"
                aria-label="删除笔记"
                onClick={() => {
                  patchNote(currentNote.id, { deletedAt: new Date().toISOString() }, false);
                  closeNote(currentNote);
                }}
              >
                <Trash2 size={16} />
              </button>
            </div>
            <article className="note-paper">
              <input
                className="note-title"
                aria-label="笔记标题"
                placeholder="未命名笔记"
                value={currentNote.title}
                onChange={(e) => patchNote(currentNote.id, { title: e.target.value })}
              />
              <p className="note-meta">
                <span>
                  {currentNote.kind === "knowledge" ? "知识页" : "笔记"} ·{" "}
                  {date(currentNote.createdAt)}
                  {currentNote.aiGenerated && " · 包含 AI 生成内容，可编辑与核对"}
                  {currentNote.status === "draft" && " · 草稿不会进入检索"}
                </span>
                <span
                  className={`note-save-status save-${cloudReadOnly ? "readonly" : status}`}
                  role="status"
                  aria-live="polite"
                >
                  自动保存：{saveLabel}
                </span>
              </p>
              {acceptanceReason && (
                <p className="notice" role="status">
                  {acceptanceReason}
                </p>
              )}
              {currentNote.kind === "knowledge" &&
                currentNote.status === "accepted" &&
                knowledgeEvidence &&
                !knowledgeEvidence.ok && (
                  <p className="notice notice-warning" role="status">
                    {knowledgeEvidence.message}
                  </p>
                )}
              <NoteEditor
                key={`${currentNote.id}-${editorKey}`}
                content={currentNote.content}
                searchText={
                  noteSearchTarget?.noteId === currentNote.id &&
                  noteSearchTarget.revision === (currentNote.contentRevision ?? 0) &&
                  noteSearchTarget.updatedAt === currentNote.updatedAt
                    ? noteSearchTarget.text
                    : undefined
                }
                onChange={(content) => patchNote(currentNote.id, { content })}
              />
              {currentNote.citations.length > 0 && (
                <div className="note-sources">
                  <h3>原文依据</h3>
                  {currentNote.citations.map((c, i) => {
                    const problem = citationProblem(c, data.sources);
                    const available = !problem;
                    const historical = data.sources.some(
                      (s) => s.id === c.sourceId && s.versionId !== c.versionId,
                    );
                    return (
                      <button
                        key={`${c.chunkId}-${i}`}
                        className="citation-card"
                        disabled={!available}
                        onClick={() => {
                          openSource(c.sourceId, c.versionId, c);
                        }}
                      >
                        <span>
                          {i + 1}. {c.title} · {c.page ? `第 ${c.page} 页` : c.section}
                        </span>
                        <p>{c.quote}</p>
                        {!available && <small>{problem}</small>}
                        {available && historical && <small>引用历史版本 · 打开当时的原文</small>}
                      </button>
                    );
                  })}
                </div>
              )}
            </article>
          </div>
        ) : (
          <div className="content-scroll">
            {section === "home" && (
              <>
                <div className="page-heading">
                  <div>
                    <p className="eyebrow">你的学习，从这里继续</p>
                    <h1>{activeSpace?.name || "让知识，慢慢成为你的。"}</h1>
                    <p>
                      {activeSpace?.goal || "收集值得读的资料，把问题留给思考，把理解留在这里。"}
                    </p>
                  </div>
                  <button className="btn btn-primary" onClick={openImport}>
                    <Plus size={16} />
                    导入资料
                  </button>
                </div>
                <div className="overview-strip">
                  <div>
                    <Library size={18} />
                    <b>{visibleSources.length}</b>
                    <span>份学习资料</span>
                  </div>
                  <div>
                    <StickyNote size={18} />
                    <b>{scopedNotes.filter((n) => n.kind === "note").length}</b>
                    <span>篇自己的理解</span>
                  </div>
                  <div>
                    <BookOpen size={18} />
                    <b>{scopedNotes.filter((n) => n.kind === "knowledge").length}</b>
                    <span>个知识页</span>
                  </div>
                </div>
                <div className="section-heading">
                  <h2>继续学习</h2>
                  <button className="text-button" onClick={() => navigate("library")}>
                    全部资料
                    <ChevronRight size={14} />
                  </button>
                </div>
                {primaryContinuation ? (
                  <>
                    <LearningContinuationCard
                      continuation={primaryContinuation}
                      icon={<SourceIcon source={primaryContinuation.source} />}
                      onContinue={() =>
                        primaryContinuation.conversation
                          ? openConversation(primaryContinuation.conversation)
                          : openSource(primaryContinuation.source.id)
                      }
                    />
                    {secondaryContinuedSources.length > 0 && (
                      <div className="continue-grid" aria-label="其他最近阅读">
                        {secondaryContinuedSources.map((s) => (
                          <button
                            key={s.id}
                            className="continue-card"
                            onClick={() => openSource(s.id)}
                          >
                            <SourceIcon source={s} />
                            <h3>{s.title}</h3>
                            <p>{s.text ? plain(s.text).slice(0, 95) : "打开资料，开始阅读"}</p>
                            <div>
                              <span>
                                {s.pageCount
                                  ? `第 ${s.readPage || 1} / ${s.pageCount} 页`
                                  : s.readOffset
                                    ? "上次读到正文"
                                    : "已保存阅读位置"}
                              </span>
                              <ArrowUpRight size={16} />
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                ) : visibleSources.length ? (
                  <div className="empty-small continue-empty">
                    还没有阅读记录。打开一份资料后，这里会按你最后停留的位置继续。
                    <button className="text-button" onClick={() => navigate("library")}>
                      打开资料库
                      <ChevronRight size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="welcome-card">
                    <div className="welcome-icon">
                      <BookOpen size={31} />
                    </div>
                    <h2>每一份资料，都是一个新的开始</h2>
                    <p>
                      导入一本书、一篇文章或课堂笔记。
                      <br />
                      在原文旁找到依据，记下自己的理解。
                    </p>
                    <div className="button-row">
                      <button
                        className="btn btn-primary"
                        onClick={() => openSpaceCreation("import")}
                      >
                        <Upload size={16} />
                        添加第一份资料
                      </button>
                      <button
                        className="btn"
                        onClick={() => {
                          const demo = createDemoWorkspace();
                          update((d) => ({
                            ...d,
                            spaces: [...d.spaces, ...demo.spaces],
                            sources: [...d.sources, ...demo.sources],
                            notes: [...d.notes, ...demo.notes],
                          }));
                          setToast("已加入标有「示例」的资料，可随时移入回收站。");
                        }}
                      >
                        先看看示例
                      </button>
                    </div>
                    <small>支持 PDF、DOCX、Markdown、TXT 和网页链接</small>
                  </div>
                )}
                <div className="section-heading pending-question-heading">
                  <h2>待解决问题</h2>
                  <button className="text-button" onClick={() => navigate("questions")}>
                    全部问答
                    <ChevronRight size={14} />
                  </button>
                </div>
                {pendingQuestions.length ? (
                  <div className="pending-question-list">
                    {pendingQuestions.map((conversation) => {
                      const crossLibrary = isCrossLibraryConversation(conversation);
                      const source = conversation.sourceId
                        ? data.sources.find(
                            (item) => item.id === conversation.sourceId && !item.deletedAt,
                          )
                        : undefined;
                      return (
                        <button
                          className="pending-question-card"
                          key={conversation.id}
                          onClick={() => openConversation(conversation)}
                        >
                          <Sparkles size={17} />
                          <div>
                            <b>{conversation.title}</b>
                            <p>
                              {crossLibrary
                                ? `跨库 · ${conversation.sourceIds.length} 份固定资料`
                                : source
                                  ? source.title
                                  : "原资料不可用或未绑定资料"}{" "}
                              · {date(conversation.updatedAt)}
                            </p>
                          </div>
                          <ChevronRight size={15} />
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="empty-small continue-empty">
                    暂时没有待解决的问题。阅读时提出一个问题，它会保留在这里。
                  </div>
                )}
                <div className="home-columns">
                  <div>
                    <div className="section-heading">
                      <h2>学习空间</h2>
                      <button className="text-button" onClick={() => openSpaceCreation()}>
                        <Plus size={14} />
                        新建
                      </button>
                    </div>
                    {data.spaces.filter((s) => !s.archived).length ? (
                      <div className="space-cards">
                        {data.spaces
                          .filter((s) => !s.archived)
                          .map((s) => (
                            <button
                              key={s.id}
                              className="space-card"
                              onClick={() => chooseSpace(s.id)}
                            >
                              <span className="space-folder" style={{ color: s.color }}>
                                <FolderOpen size={22} />
                              </span>
                              <div>
                                <b>{s.name}</b>
                                <p>
                                  {s.goal ||
                                    `${data.sources.filter((x) => !x.deletedAt && x.spaceIds.includes(s.id)).length} 份资料`}
                                </p>
                              </div>
                              <ChevronRight size={15} />
                            </button>
                          ))}
                      </div>
                    ) : (
                      <div className="empty-small">按主题创建一个空间，让相关资料聚在一起。</div>
                    )}
                  </div>
                  <div>
                    <div className="section-heading">
                      <h2>最近的笔记</h2>
                      <button className="text-button" onClick={() => newNote("note")}>
                        <Plus size={14} />
                        写笔记
                      </button>
                    </div>
                    {scopedNotes.length ? (
                      <div className="space-cards">
                        {scopedNotes.slice(0, 3).map((n) => (
                          <button className="space-card" key={n.id} onClick={() => openNote(n.id)}>
                            <StickyNote size={20} />
                            <div>
                              <b>{n.title}</b>
                              <p>{plain(n.content).slice(0, 55) || "写下你的第一个想法"}</p>
                            </div>
                            <ChevronRight size={15} />
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="empty-small">读到有启发的地方，就把自己的理解写下来。</div>
                    )}
                  </div>
                </div>
              </>
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
              <>
                <CollectionActions
                  onNewNote={() => newNote("note")}
                  onImport={openImport}
                  onNewSpace={() => openSpaceCreation()}
                />
                <div className="library-directory-heading">
                  <div>
                    <h2>
                      {spaceId === "all" ? "全部资料" : "库内资料"}
                      <span className="count-badge">{visibleSources.length}</span>
                    </h2>
                    {activeSpace?.goal && <p>{activeSpace.goal}</p>}
                  </div>
                  {activeSpace && (
                    <button
                      className="btn export-library-action"
                      disabled={busy}
                      onClick={() => openExport({ kind: "space", spaceId: activeSpace.id })}
                    >
                      <ArrowDownToLine size={15} aria-hidden="true" />
                      导出此知识库
                    </button>
                  )}
                  {spaceId === "all" && libraryFiles && (
                    <button
                      className="btn"
                      disabled={crossLibraryAskBusy}
                      onClick={() => {
                        setCrossLibraryAskPanelKey(crypto.randomUUID());
                        setCrossLibrarySearchDraft(null);
                        replaceLibraryView({ crossLibraryAsk: {} });
                      }}
                    >
                      <Sparkles size={15} />
                      跨库问 AI
                    </button>
                  )}
                </div>
                {spaceId === "all" && libraryFiles && crossLibraryAsk && (
                  <CrossLibraryAskPanel
                    key={crossLibraryAskPanelKey}
                    data={data}
                    initialConversationId={crossLibraryAsk.conversationId}
                    initialQuestion={crossLibrarySearchDraft?.question}
                    initialSourceIds={crossLibrarySearchDraft?.sourceIds}
                    onAsk={(request, signal) => store.ask(request, signal)}
                    onConversationChange={(conversation) =>
                      update((workspace) => persistConversation(workspace, conversation))
                    }
                    onActiveConversationChange={setActiveCrossLibraryConversation}
                    onBusyChange={setCrossLibraryAskBusy}
                    onOpenSource={openSource}
                    onInvalidInitialConversation={() => {
                      setToast("这条跨库问答记录不可用，已切换为新问题。");
                      replaceLibraryView({ crossLibraryAsk: {} });
                    }}
                    onClose={() => {
                      clearConversationRouteState();
                      setCrossLibrarySearchDraft(null);
                      replaceLibraryView({ crossLibraryAsk: undefined });
                    }}
                  />
                )}
                <div className="library-tools">
                  <div className="library-search-mode" role="group" aria-label="资料搜索方式">
                    <button
                      type="button"
                      aria-pressed={searchIntent === "keyword"}
                      onClick={() => {
                        setSearchIntent("keyword");
                        setSelected([]);
                      }}
                    >
                      关键词
                    </button>
                    <button
                      type="button"
                      aria-pressed={searchIntent === "question"}
                      onClick={() => {
                        if (derivedLibraryFilter) replaceLibraryView({ filter: "all" });
                        setSearchIntent("question");
                        setSelected([]);
                      }}
                    >
                      用问题找资料
                    </button>
                  </div>
                  <div className="search-field">
                    <Search size={16} />
                    <input
                      ref={searchRef}
                      placeholder={
                        searchIntent === "question"
                          ? "例如：哪份资料讲过学习率过高？"
                          : "搜索资料、笔记与知识页…"
                      }
                      aria-label={searchIntent === "question" ? "输入问题找资料" : "搜索资料"}
                      value={search}
                      onChange={(e) => {
                        replaceLibraryView({ query: e.target.value });
                        setSelected([]);
                      }}
                    />
                    {search && (
                      <button
                        className="icon-btn"
                        onClick={() => replaceLibraryView({ query: "" })}
                        aria-label="清空搜索"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                  <span className="library-search-break" aria-hidden="true" />
                  <select
                    className="field filter-select"
                    aria-label="筛选资料类型"
                    value={filter}
                    onChange={(e) => {
                      if (isLibraryFilter(e.target.value)) {
                        replaceLibraryView({ filter: e.target.value });
                        setSelected([]);
                      }
                    }}
                  >
                    <option value="all">全部类型</option>
                    <option value="starred">已收藏</option>
                    <option value="pdf">PDF</option>
                    <option value="docx">DOCX</option>
                    <option value="markdown">Markdown</option>
                    <option value="text">TXT</option>
                    <option value="web">网页</option>
                    {searchIntent === "keyword" && <option value="note">笔记</option>}
                    {searchIntent === "keyword" && <option value="knowledge">知识页</option>}
                  </select>
                  <select
                    className="field filter-select time-filter-select"
                    aria-label="按添加时间筛选资料"
                    value={timeFilter}
                    onChange={(e) => {
                      if (isLibraryTimeFilter(e.target.value)) {
                        replaceLibraryView({ time: e.target.value });
                        setSelected([]);
                      }
                    }}
                  >
                    <option value="all">全部时间</option>
                    <option value="7d">最近 7 天</option>
                    <option value="30d">最近 30 天</option>
                    <option value="365d">最近一年</option>
                  </select>
                  {searchIntent === "keyword" && !derivedLibraryFilter && (
                    <select
                      className="field filter-select sort-filter-select"
                      aria-label="资料排序方式"
                      value={sort}
                      onChange={(event) => {
                        if (isLibrarySort(event.target.value))
                          replaceLibraryView({ sort: event.target.value });
                      }}
                    >
                      <option value="updated">最近更新</option>
                      <option value="created">最近添加</option>
                      <option value="name">名称</option>
                    </select>
                  )}
                  <div className="tag-filter" ref={tagFilterRef}>
                    <button
                      type="button"
                      className={`btn tag-filter-trigger${selectedTags.length ? " is-active" : ""}`}
                      aria-haspopup="dialog"
                      aria-expanded={tagFilterOpen}
                      aria-label={
                        selectedTags.length
                          ? `筛选资料标签，已选 ${selectedTags.length} 项`
                          : "筛选资料标签"
                      }
                      onClick={() => setTagFilterOpen((open) => !open)}
                    >
                      <Tag size={14} aria-hidden="true" />
                      标签{selectedTags.length ? ` ${selectedTags.length}` : ""}
                    </button>
                    {tagFilterOpen && (
                      <section
                        className="tag-filter-popover"
                        role="dialog"
                        aria-label="按标签筛选资料"
                      >
                        <div className="tag-filter-popover-heading">
                          <div>
                            <strong>筛选标签</strong>
                            <p>仅显示同时具有所选标签的资料。</p>
                          </div>
                          {selectedTags.length > 0 && (
                            <button
                              type="button"
                              className="text-button"
                              aria-label="清除已选标签"
                              onClick={() => {
                                replaceLibraryView({ tags: [] });
                                setSelected([]);
                              }}
                            >
                              清除
                            </button>
                          )}
                        </div>
                        {availableTags.length ? (
                          <div
                            className="tag-filter-options"
                            role="group"
                            aria-label="当前范围可用标签"
                          >
                            {availableTags.map((tag) => {
                              const checked = selectedTags.some(
                                (selectedTag) => normalizedTag(selectedTag) === normalizedTag(tag),
                              );
                              return (
                                <label className="tag-filter-option" key={normalizedTag(tag)}>
                                  <input
                                    type="checkbox"
                                    aria-label={`标签 ${tag}`}
                                    checked={checked}
                                    onChange={(event) => {
                                      const nextTags = event.currentTarget.checked
                                        ? [...selectedTags, tag]
                                        : selectedTags.filter(
                                            (selectedTag) =>
                                              normalizedTag(selectedTag) !== normalizedTag(tag),
                                          );
                                      replaceLibraryView({ tags: nextTags });
                                      setSelected([]);
                                    }}
                                  />
                                  <span>{tag}</span>
                                </label>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="tag-filter-empty">当前范围还没有可用标签。</p>
                        )}
                      </section>
                    )}
                  </div>
                  {searchIntent === "keyword" && !derivedLibraryFilter && (
                    <div className="view-switch">
                      <button
                        aria-label="列表视图"
                        aria-pressed={layout === "list"}
                        className="icon-btn"
                        onClick={() => replaceLibraryView({ layout: "list" })}
                      >
                        <Library size={16} />
                      </button>
                      <button
                        aria-label="卡片视图"
                        aria-pressed={layout === "grid"}
                        className="icon-btn"
                        onClick={() => replaceLibraryView({ layout: "grid" })}
                      >
                        <LayoutGrid size={16} />
                      </button>
                    </div>
                  )}
                </div>
                {(search.trim() || derivedLibraryFilter) && (
                  <WorkspaceSearch
                    key={`${store.token}:${spaceId}`}
                    data={data}
                    query={search}
                    scope={
                      spaceId === "all"
                        ? { kind: "all" }
                        : spaceId === "inbox"
                          ? { kind: "inbox" }
                          : { kind: "space", spaceId }
                    }
                    userId={user?.id}
                    cloudSaved={status === "cloud"}
                    intent={searchIntent}
                    externalFilters={searchExternalFilters}
                    onOpen={openSearchHit}
                    askDisabled={crossLibraryAskBusy}
                    onAskSources={openQuestionSearchDraft}
                  />
                )}
                {!derivedLibraryFilter && selected.length > 0 && (
                  <div className="bulk-bar">
                    <span>已选 {selected.length} 份</span>
                    <button className="btn" onClick={() => setModal("bulk-tags")}>
                      <Tag size={14} />
                      添加标签
                    </button>
                    <button className="btn" onClick={openBulkSpaceAssociation}>
                      <FolderPlus size={14} />
                      关联空间
                    </button>
                    <button className="btn" onClick={() => openOrganization(selected)}>
                      <Sparkles size={14} />
                      整理为知识页
                    </button>
                    <button className="btn" onClick={() => openBulkRecycle()}>
                      <Trash2 size={14} />
                      移入回收站
                    </button>
                    <button className="text-button" onClick={() => setSelected([])}>
                      取消选择
                    </button>
                  </div>
                )}
                {!search.trim() &&
                  !derivedLibraryFilter &&
                  (filteredSources.length ? (
                    <div className={`source-list ${layout === "grid" ? "source-grid" : ""}`}>
                      {layout === "list" && (
                        <div className="source-list-heading">
                          <span>资料名称</span>
                          <span>状态</span>
                          <span>更新时间</span>
                          <span />
                        </div>
                      )}
                      {filteredSources.map((s) => (
                        <div className="source-row" key={s.id}>
                          <input
                            className="source-check"
                            type="checkbox"
                            aria-label={`选择 ${s.title}`}
                            checked={selected.includes(s.id)}
                            onChange={(e) =>
                              setSelected(
                                e.target.checked
                                  ? [...selected, s.id]
                                  : selected.filter((id) => id !== s.id),
                              )
                            }
                          />
                          <button className="source-open" onClick={() => openSource(s.id)}>
                            <SourceIcon source={s} />
                            <div>
                              <b>{s.title}</b>
                              <p>
                                {sizeLabel(s.size)}
                                {s.tags.map((tag) => (
                                  <span className="tag" key={tag}>
                                    {tag}
                                  </span>
                                ))}
                              </p>
                            </div>
                          </button>
                          <span className={`badge badge-${sourcePresentationStatus(s)}`}>
                            {sourceStatusLabel(s)}
                          </span>
                          <span className="source-date">{date(s.updatedAt)}</span>
                          <button
                            className={`icon-btn star-btn ${s.starred ? "is-starred" : ""}`}
                            aria-label={s.starred ? `取消收藏 ${s.title}` : `收藏 ${s.title}`}
                            onClick={() => patchSource(s, { starred: !s.starred })}
                          >
                            <Star size={16} fill={s.starred ? "currentColor" : "none"} />
                          </button>
                          <button
                            className="icon-btn"
                            aria-label={`管理 ${s.title}`}
                            onClick={() => {
                              setDetailId(s.id);
                              setModal("details");
                            }}
                          >
                            <MoreHorizontal size={18} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Empty
                      icon={<Library size={32} />}
                      title={
                        search || filter !== "all" || timeFilter !== "all" || selectedTags.length
                          ? "没有找到匹配的资料"
                          : "这里等待着你的第一份资料"
                      }
                      text={
                        search
                          ? "换一个关键词，或在其他学习空间中查找。"
                          : filter !== "all" || timeFilter !== "all" || selectedTags.length
                            ? "调整资料类型、添加时间或标签筛选，看看其他资料。"
                            : "把文件和网页收集在一起，再慢慢读懂。"
                      }
                      action={
                        filter !== "all" || timeFilter !== "all" || selectedTags.length ? (
                          <button
                            className="btn"
                            onClick={() => {
                              replaceLibraryView({ filter: "all", time: "all", tags: [] });
                              setSelected([]);
                            }}
                          >
                            清除筛选
                          </button>
                        ) : !search ? (
                          <button className="btn" onClick={openImport}>
                            导入资料
                          </button>
                        ) : undefined
                      }
                    />
                  ))}
              </>
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
              <>
                <div className="document-library-heading">
                  <div>
                    <h2>
                      {spaceId === "all" ? "全部" : "库内"}
                      知识页
                      <span className="count-badge">{knowledgePageCount}</span>
                    </h2>
                    <p>从原文依据出发，按知识库整理、审核并保存你的知识页。</p>
                  </div>
                  <div className="knowledge-actions">
                    <button className="btn" onClick={() => openOrganization()}>
                      <Sparkles size={16} />
                      从资料生成
                    </button>
                    {activeSpace && (
                      <button
                        className="btn export-library-action"
                        disabled={busy}
                        onClick={() => openExport({ kind: "space", spaceId: activeSpace.id })}
                      >
                        <ArrowDownToLine size={15} aria-hidden="true" />
                        导出此知识库
                      </button>
                    )}
                    <button className="btn btn-primary" onClick={() => newNote("knowledge")}>
                      <Plus size={16} />
                      新建知识页
                    </button>
                  </div>
                </div>
                <KnowledgeLibrary
                  data={data}
                  spaceId={spaceId}
                  query={search}
                  filter={knowledgeFilter}
                  onQueryChange={(query) => replaceKnowledgeView({ query })}
                  onFilterChange={(nextFilter) => replaceKnowledgeView({ filter: nextFilter })}
                  onOpen={openNote}
                />
              </>
            )}
            {section === "notes" && (
              <>
                <div className="document-library-heading">
                  <div>
                    <h2>
                      {spaceId === "all" ? "全部" : "库内"}笔记
                      <span className="count-badge">{notes.length}</span>
                    </h2>
                    <p>摘录是起点，自己的思考更值得保存。</p>
                  </div>
                  <div className="knowledge-actions">
                    <button className="btn btn-primary" onClick={() => newNote("note")}>
                      <Plus size={16} />
                      新建笔记
                    </button>
                  </div>
                </div>
                <div className="search-field note-search">
                  <Search size={16} />
                  <input
                    ref={searchRef}
                    placeholder="搜索标题或正文…"
                    aria-label="搜索笔记"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                {notes.length ? (
                  <div className="note-grid">
                    {notes.map((n) => (
                      <button className="note-card" key={n.id} onClick={() => openNote(n.id)}>
                        <div>
                          <StickyNote size={18} />
                          {n.status === "draft" && (
                            <span className="badge badge-warning">待审核</span>
                          )}
                        </div>
                        <h3>{n.title}</h3>
                        <p>{plain(n.content).slice(0, 160) || "还没有正文，开始记录你的思考。"}</p>
                        <footer>
                          {date(n.updatedAt)} 更新{" "}
                          <span>
                            {n.citations.length ? `${n.citations.length} 处依据` : "自由笔记"}
                          </span>
                        </footer>
                      </button>
                    ))}
                  </div>
                ) : (
                  <Empty
                    icon={<StickyNote size={32} />}
                    title={search ? "没有找到匹配的笔记" : "留下此刻的理解"}
                    text="可以从空白笔记开始，也可以在阅读时保存选段。"
                  />
                )}
              </>
            )}
            {section === "questions" && (
              <>
                <div className="page-heading">
                  <div>
                    <p className="eyebrow">带着问题，继续学习</p>
                    <h1>我的问答</h1>
                    <p>每次讨论都保留资料范围与原文依据。</p>
                  </div>
                </div>
                <div className="notice">
                  基于所选资料提问并核对引用；本机或未配置模型时使用原文检索。
                </div>
                {conversationRouteIssue && (
                  <div className="notice notice-warning" role="status">
                    <span>{conversationRouteIssue}</span>
                    <button className="text-button" onClick={() => navigate("questions")}>
                      返回我的问答
                    </button>
                  </div>
                )}
                <QuestionHistoryList
                  data={data}
                  spaceId={spaceId}
                  filter={questionHistoryFilter}
                  onFilterChange={changeQuestionHistoryFilter}
                  onContinue={openConversation}
                  onOpenOriginal={(source) => openSource(source.id)}
                  onToggleResolved={(conversation) =>
                    update((workspace) => ({
                      ...workspace,
                      conversations: workspace.conversations.map((item) =>
                        item.id === conversation.id ? { ...item, resolved: !item.resolved } : item,
                      ),
                    }))
                  }
                  onOpenLibrary={() => navigate("library")}
                />
              </>
            )}
            {section === "trash" && (
              <>
                <div className="page-heading">
                  <div>
                    <p className="eyebrow">为误删留一个回头的机会</p>
                    <h1>回收站</h1>
                    <p>此处资料不会参与新的检索；跨设备冲突保留的文字可单独取回。</p>
                  </div>
                </div>
                {recoverableDraftItems.length > 0 && (
                  <RecoverableDraftsPanel
                    drafts={recoverableDraftItems}
                    disabled={!ready}
                    readOnly={cloudReadOnly}
                    onRestoreSource={restoreRecoverableDraft}
                    onSaveAsNote={saveRecoveredDraft}
                    onDiscard={discardRecoveredDraft}
                  />
                )}
                {!data.sources.some((s) => s.deletedAt) && !data.notes.some((n) => n.deletedAt) ? (
                  <Empty
                    icon={<Trash2 size={32} />}
                    title="回收站是空的"
                    text="删除的资料与笔记会出现在这里。"
                  />
                ) : (
                  <div className="trash-list">
                    {data.sources
                      .filter((s) => s.deletedAt)
                      .map((s) => (
                        <div key={s.id} className="trash-row">
                          <SourceIcon source={s} />
                          <div className="grow">
                            <b>{s.title}</b>
                            <p>
                              {date(s.deletedAt!)} 移入回收站
                              {(data.recoverableDrafts ?? []).some(
                                (draft) => draft.sourceId === s.id,
                              ) && " · 含可恢复的离线文字"}
                            </p>
                          </div>
                          <button className="btn" onClick={() => void restoreRecycledSource(s)}>
                            恢复资料
                          </button>
                          <button className="btn btn-danger" onClick={() => openSourcePurge(s)}>
                            彻底删除
                          </button>
                        </div>
                      ))}
                    {data.notes
                      .filter((n) => n.deletedAt)
                      .map((n) => (
                        <div key={n.id} className="trash-row">
                          <StickyNote size={20} />
                          <div className="grow">
                            <b>{n.title}</b>
                            <p>已删除的笔记</p>
                          </div>
                          <button
                            className="btn"
                            onClick={() => patchNote(n.id, { deletedAt: null }, false)}
                          >
                            恢复笔记
                          </button>
                        </div>
                      ))}
                  </div>
                )}
              </>
            )}
            {section === "settings" && (
              <>
                <div className="page-heading">
                  <div>
                    <p className="eyebrow">按你的方式学习</p>
                    <h1>设置</h1>
                    <p>控制资料的保存位置与检索权限。</p>
                  </div>
                </div>
                <div className="settings-card">
                  <h2>安装与设备</h2>
                  <InstallAppPanel />
                </div>
                <div className="settings-card">
                  <h2>账号与保存</h2>
                  <div className="setting-row">
                    <div>
                      <b>{user && cloudConfigured ? user.email : "本机工作区"}</b>
                      <p>
                        {user && cloudConfigured
                          ? "已连接账号；当前工作区是否已保存，以服务确认状态为准。"
                          : cloudConfigured
                            ? "资料保存在此浏览器；登录后可同步到你的私有空间。"
                            : "云端同步暂不可用。资料仅保存在此浏览器；清除网站数据会删除本机副本，请及时导出。"}
                      </p>
                    </div>
                    <button className="btn" onClick={() => setModal("account")}>
                      {user && cloudConfigured
                        ? "管理账号"
                        : cloudConfigured
                          ? "登录账号"
                          : "查看本机工作区"}
                    </button>
                  </div>
                  <div className="setting-row">
                    <div role="status" aria-live="polite" aria-label="当前工作区保存状态">
                      <b>当前工作区保存状态：{settingsSyncPresentation.label}</b>
                      <p>{settingsSyncPresentation.description}</p>
                    </div>
                    <button className="btn" onClick={() => navigate("tasks")}>
                      查看同步与任务
                    </button>
                  </div>
                  <div className="setting-row">
                    <div>
                      <b>导出学习资料</b>
                      <p>导出原文件、笔记和引用关系，保留一份自己的备份。</p>
                      {exporting && (
                        <p className="export-progress" role="status" aria-live="polite">
                          {exportProgress?.phase === "originals"
                            ? "正在处理原件 " +
                              exportProgress.completed +
                              "/" +
                              exportProgress.total +
                              "：" +
                              exportProgress.title
                            : exportProgress?.phase === "archive"
                              ? "正在生成压缩包…"
                              : "正在准备导出…"}
                        </p>
                      )}
                    </div>
                    <button className="btn" disabled={busy} onClick={() => openExport()}>
                      <ArrowDownToLine size={15} />
                      {busy ? "正在导出…" : "导出备份"}
                    </button>
                  </div>
                  <div className="setting-row">
                    <div>
                      <b>从备份恢复</b>
                      <p>读取 Conuo 备份 ZIP，预览后恢复资料、笔记与历史记录。</p>
                    </div>
                    <button className="btn" disabled={busy} onClick={() => setModal("restore")}>
                      <Upload size={15} />
                      恢复备份
                    </button>
                  </div>
                </div>
                {storageMode === "cloud" && (
                  <div className="settings-card">
                    <h2>旧版浏览器资料</h2>
                    <div className="setting-row">
                      <div>
                        <b>将旧版资料导入云端</b>
                        <p>把旧版留在此浏览器中的资料导入当前账号，保留已有内容。</p>
                      </div>
                      <button
                        className="btn"
                        disabled={busy || !ready || status !== "cloud"}
                        onClick={() => setModal("legacy-recovery")}
                      >
                        导入旧版资料
                      </button>
                    </div>
                  </div>
                )}
                <div className="settings-card">
                  <h2>资料与存储</h2>
                  <StorageUsagePanel
                    sources={data.sources}
                    onOpenRecycleBin={() => navigate("trash")}
                  />
                </div>
                <div className="settings-card">
                  <h2>资料与 AI</h2>
                  <div className="setting-row">
                    <div>
                      <b>允许 AI 使用我的资料</b>
                      <p>
                        用于所选范围内的问答和摘要。关闭后停止资料问答，也可在资料详情中逐份设置。
                      </p>
                    </div>
                    <input
                      aria-label="允许 AI 使用我的资料"
                      type="checkbox"
                      className="switch"
                      role="switch"
                      checked={data.aiEnabled}
                      onChange={(e) => update((d) => ({ ...d, aiEnabled: e.target.checked }))}
                    />
                  </div>
                  <ModelStatus key={user?.id || "local"} userId={user?.id} />
                  <AiUsagePanel
                    userId={user?.id}
                    contextKey={`${store.token}:${store.localCacheMode}`}
                    enabled={store.ready}
                  />
                  <IndexingPanel
                    key={`${store.token}`}
                    data={data}
                    userId={user?.id}
                    onToggle={(semanticSearch) =>
                      update((workspace) => ({ ...workspace, semanticSearch }))
                    }
                  />
                  <div className="setting-row">
                    <div>
                      <b>自动整理资料</b>
                      <p>
                        {durableProcessorEnabled
                          ? "开启后，在页面打开期间分析整个工作区已有及新导入的可用资料，生成摘要、标签和主题建议。与问答共用模型次数；不会自动应用标签或改写知识页。"
                          : "后台自动整理等待部署。当前构建不会创建新任务；已有整理记录仍可刷新、查看或停止。"}
                      </p>
                      <button className="text-button" onClick={() => openOrganization()}>
                        查看整理任务与建议
                      </button>
                    </div>
                    <input
                      aria-label="自动整理资料"
                      type="checkbox"
                      className="switch"
                      role="switch"
                      checked={data.autoOrganize === true}
                      disabled={
                        !data.autoOrganize &&
                        (!durableProcessorEnabled ||
                          !user ||
                          !data.aiEnabled ||
                          !store.organizationStatus.ready)
                      }
                      onChange={(e) =>
                        update((workspace) => ({ ...workspace, autoOrganize: e.target.checked }))
                      }
                    />
                  </div>
                  <OrganizationHistoryControl
                    jobs={data.organizationJobs}
                    onCleanup={() => {
                      let removed = 0;
                      try {
                        const applied = update((workspace) => {
                          const result = cleanupOrganizationHistory(workspace);
                          removed = result.impact.removable;
                          return result.data;
                        });
                        if (!applied || !removed) {
                          setToast("没有可清理的终态整理记录，工作区未修改。");
                          return false;
                        }
                        setToast(`已清理 ${removed} 条整理记录，已保存的学习内容保持不变。`);
                        return true;
                      } catch (error) {
                        setToast(
                          error instanceof Error ? error.message : "整理记录未能清理，请稍后重试。",
                        );
                        return false;
                      }
                    }}
                  />
                </div>
                <div className="settings-card">
                  <h2>学习空间</h2>
                  {data.spaces.map((s) => (
                    <div className="setting-row" key={s.id}>
                      <div>
                        <LearningSpaceNameInput
                          key={`${user?.id || "local"}:${s.id}`}
                          space={s}
                          onRename={(name, expectedName) => {
                            let renamed = false;
                            try {
                              update((d) => {
                                if (
                                  d.spaces.find((item) => item.id === s.id)?.name !== expectedName
                                )
                                  return d;
                                const next = renameLearningSpace(d, s.id, name);
                                renamed = true;
                                return next;
                              });
                              if (!renamed) setToast("空间名称又有变化，输入仍保留，请重新确认。");
                            } catch (cause) {
                              renamed = false;
                              setToast(
                                cause instanceof Error
                                  ? cause.message
                                  : "空间名称未保存，输入仍保留。",
                              );
                            }
                            return renamed;
                          }}
                          onInvalid={() => setToast("学习空间名称不能为空，已保留原名称。")}
                        />
                        <input
                          aria-label={`学习目标 ${s.name}`}
                          className="field space-goal-input"
                          placeholder="添加学习目标（可选）"
                          value={s.goal}
                          onChange={(e) =>
                            update((d) => ({
                              ...d,
                              spaces: d.spaces.map((x) =>
                                x.id === s.id ? { ...x, goal: e.target.value } : x,
                              ),
                            }))
                          }
                        />
                      </div>
                      <div className="setting-actions">
                        <button
                          className="btn"
                          onClick={() =>
                            update((d) => ({
                              ...d,
                              spaces: d.spaces.map((x) =>
                                x.id === s.id ? { ...x, archived: !x.archived } : x,
                              ),
                            }))
                          }
                        >
                          {s.archived ? "恢复空间" : "归档空间"}
                        </button>
                        <button
                          className="btn btn-danger"
                          onClick={() => {
                            setSpaceToDeleteId(s.id);
                            setModal("delete-space");
                          }}
                        >
                          删除空间
                        </button>
                      </div>
                    </div>
                  ))}
                  <button className="btn" onClick={() => openSpaceCreation()}>
                    <Plus size={14} />
                    新建学习空间
                  </button>
                </div>
              </>
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
        <Modal
          title="备份已下载，但有原件未包含"
          onClose={() => {
            setModal(null);
            setExportIssues(null);
          }}
        >
          <div className="modal-body export-result-modal">
            <p className="export-result-intro">
              资料文字、笔记、批注、引用和其他可用原件已经写入 ZIP。以下版本的原文件未能取得，
              不会以当前版本或其他文件代替。
            </p>
            <ul className="export-issue-list">
              {exportIssues.map((issue) => (
                <li key={issue.sourceId + ":" + issue.versionId + ":" + issue.code}>
                  <strong>
                    {issue.title}
                    {issue.versionState === "historical" ? " · 历史版本" : ""}
                  </strong>
                  <span>{issue.message}</span>
                </li>
              ))}
            </ul>
            <p className="muted">
              ZIP 根目录的 <code>export-issues.json</code> 和每个资料版本的{" "}
              <code>original-status.txt</code> 保留相同的逐项说明。
            </p>
            <div className="modal-actions">
              <button
                className="btn btn-primary"
                onClick={() => {
                  setModal(null);
                  setExportIssues(null);
                }}
              >
                知道了
              </button>
            </div>
          </div>
        </Modal>
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
        <Modal
          title={spaceCreationIntent === "import" ? "创建知识库并导入资料" : "新建知识库"}
          onClose={closeSpaceCreation}
        >
          <form
            className="modal-body"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const name = String(f.get("name") || "").trim();
              if (!name) {
                setToast("请填写知识库名称。");
                const nameInput = e.currentTarget.elements.namedItem("name");
                if (nameInput instanceof HTMLInputElement) nameInput.focus();
                return;
              }
              const id = crypto.randomUUID();
              const created = {
                id,
                name,
                goal: String(f.get("goal") || "").trim(),
                color: "#4B3FE3",
                archived: false,
                createdAt: new Date().toISOString(),
              };
              const continueToImport = spaceCreationIntent === "import";
              update((d) => ({
                ...d,
                spaces:
                  continueToImport && isUntouchedStarterWorkspace(d)
                    ? [created]
                    : [...d.spaces, created],
              }));
              setSpaceCreationIntent("browse");
              chooseSpace(id);
              if (continueToImport) {
                setImportTargetSpaceId(id);
                setModal("import");
              } else setModal(null);
            }}
          >
            <label>
              知识库名称
              <input
                className="field"
                name="name"
                maxLength={60}
                required
                placeholder="例如：机器学习入门"
                autoFocus
                onInvalid={(e) => {
                  e.preventDefault();
                  setToast("请填写知识库名称。");
                  e.currentTarget.focus();
                }}
              />
            </label>
            <label>
              学习目标 <small>可选</small>
              <textarea
                className="field"
                name="goal"
                rows={3}
                maxLength={300}
                placeholder="你希望在这个主题中弄懂什么？"
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={closeSpaceCreation}>
                取消
              </button>
              <button className="btn btn-primary">
                {spaceCreationIntent === "import" ? "创建并导入" : "创建知识库"}
              </button>
            </div>
          </form>
        </Modal>
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
        <Modal title="资料详情" onClose={() => setModal(null)}>
          <div className="modal-body">
            <label>
              资料名称
              <input
                className="field"
                value={detail.title}
                onChange={(e) =>
                  patchSource(detail, {
                    title: e.target.value,
                    updatedAt: new Date().toISOString(),
                  })
                }
              />
              <small>资料名称由你维护，AI 整理不会自动改名。</small>
            </label>
            <label>
              标签（用逗号分隔）
              <input
                className="field"
                defaultValue={detail.tags.join(", ")}
                onBlur={(e) => {
                  const labels = e.target.value.split(/[,，]/);
                  reviewOrganization(
                    (workspace) => setSourceTags(workspace, detail.id, labels),
                    "标签已保存。",
                  );
                }}
              />
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={detail.tagsLocked === true}
                onChange={(e) => patchSource(detail, { tagsLocked: e.target.checked })}
              />
              固定标签，AI 建议不能修改
            </label>
            <fieldset className="space-checkboxes">
              <legend>所属学习空间</legend>
              {data.spaces
                .filter((s) => !s.archived)
                .map((s) => (
                  <label key={s.id}>
                    <input
                      type="checkbox"
                      checked={detail.spaceIds.includes(s.id)}
                      onChange={(e) =>
                        patchSource(detail, {
                          spaceIds: e.target.checked
                            ? [...detail.spaceIds, s.id]
                            : detail.spaceIds.filter((id) => id !== s.id),
                        })
                      }
                    />
                    {s.name}
                  </label>
                ))}
              {!data.spaces.length && (
                <small className="muted">还没有学习空间，资料暂存收件箱。</small>
              )}
            </fieldset>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={detail.aiAllowed}
                onChange={(e) => patchSource(detail, { aiAllowed: e.target.checked })}
              />
              允许 AI 使用这份资料
            </label>
            <button className="btn" onClick={() => openOrganization([detail.id])}>
              <Sparkles size={15} />
              查看摘要与标签建议
            </button>
            <button className="btn" onClick={() => setModal("recognized-content")}>
              <FileText size={15} />
              查看已识别内容
            </button>
            <div className="detail-meta">
              <dl className="source-meta-list" aria-label="资料元数据">
                <div>
                  <dt>资料类型</dt>
                  <dd>{sourceKindLabel(detail)}</dd>
                </div>
                <div>
                  <dt>导入来源</dt>
                  <dd>{sourceOriginLabel(detail)}</dd>
                </div>
                <div>
                  <dt>原文件</dt>
                  <dd>{detail.filename}</dd>
                </div>
                <div>
                  <dt>导入时间</dt>
                  <dd>{sourceTimestampLabel(detail.createdAt)}</dd>
                </div>
                <div>
                  <dt>阅读状态</dt>
                  <dd>{sourceReadingStatus(detail)}</dd>
                </div>
                {detail.lastReadAt && (
                  <div>
                    <dt>最近阅读</dt>
                    <dd>{sourceTimestampLabel(detail.lastReadAt)}</dd>
                  </div>
                )}
                <div>
                  <dt>处理状态</dt>
                  <dd>
                    {sourceStatusLabel(detail)} · {detail.chunks.length} 个内容块
                  </dd>
                </div>
                <div>
                  <dt>AI 状态</dt>
                  <dd>{sourceAiStatus(detail)}</dd>
                </div>
                <div>
                  <dt>文件大小</dt>
                  <dd>{sizeLabel(detail.size)}</dd>
                </div>
                <div>
                  <dt>版本记录</dt>
                  <dd>{detail.versions?.length || 0} 个历史版本</dd>
                </div>
                {detail.parsedPages !== undefined && (
                  <div>
                    <dt>识别范围</dt>
                    <dd>
                      已提取 {detail.parsedPages} / {detail.pageCount} 页
                    </dd>
                  </div>
                )}
                {detail.url && (
                  <div>
                    <dt>原网页</dt>
                    <dd>
                      <a
                        href={detail.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-button"
                      >
                        打开原网页
                        <ArrowUpRight size={14} />
                      </a>
                    </dd>
                  </div>
                )}
              </dl>
              {detail.error && <p className="error-text">{detail.error}</p>}
            </div>
            <div className="modal-actions">
              <button className="btn btn-danger" onClick={() => openBulkRecycle([detail.id])}>
                移入回收站
              </button>
              <button className="btn" onClick={() => void downloadOriginal(detail)}>
                <ArrowDownToLine size={14} />
                下载原件
              </button>
              <button className="btn btn-primary" onClick={() => setModal(null)}>
                完成
              </button>
            </div>
          </div>
        </Modal>
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
        <Modal
          title="选择要对照的资料"
          onClose={() => {
            setModal(null);
            setComparisonTargetId("");
          }}
        >
          <div className="modal-body comparison-source-picker">
            <p className="bulk-space-intro">
              将与“{readingSource?.title || "当前资料"}”在“
              {comparisonPickerSpace?.name || "当前知识库"}
              ”中并排打开。进入后会固定两份资料的当前阅读版本；
              若资料或版本已变化，系统不会替换为其他内容。
            </p>
            {comparisonCandidates.length ? (
              <fieldset className="comparison-source-fieldset">
                <legend>选择另一份资料</legend>
                <div className="comparison-source-list" role="radiogroup" aria-label="对照资料">
                  {comparisonCandidates.map((source) => (
                    <label
                      className={`comparison-source-option ${
                        comparisonTargetId === source.id ? "selected" : ""
                      }`}
                      key={source.id}
                    >
                      <input
                        type="radio"
                        name="comparison-source"
                        checked={comparisonTargetId === source.id}
                        onChange={() => setComparisonTargetId(source.id)}
                      />
                      <SourceIcon source={source} />
                      <span>
                        <b>{source.title}</b>
                        <small>
                          {sourceStatusLabel(source)} · {source.filename}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : (
              <p className="muted">当前知识库没有可选的另一份资料。</p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setModal(null);
                  setComparisonTargetId("");
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!comparisonTargetId || !comparisonCandidates.length}
                onClick={startComparison}
              >
                开始对照阅读
              </button>
            </div>
          </div>
        </Modal>
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
        <Modal title="笔记历史版本" onClose={() => setModal(null)}>
          <div className="modal-body">
            <p className="muted">
              编辑期间每分钟保留一个历史快照；接受更新时立即保存旧版本，最多保留 30
              个。恢复前保留当前内容。旧记录若无引用快照，恢复时会清空引用并将知识页设为待审核。
            </p>
            {currentNote.versions.length ? (
              [...currentNote.versions].reverse().map((v) => (
                <div className="version-row" key={v.id}>
                  <div>
                    <b>{v.title}</b>
                    <p>{new Date(v.savedAt).toLocaleString("zh-CN")}</p>
                    <p>{plain(v.content).slice(0, 100)}</p>
                  </div>
                  <button
                    className="btn"
                    onClick={() => {
                      update((d) => ({
                        ...d,
                        notes: d.notes.map((n) =>
                          n.id === currentNote.id ? restoreNoteVersion(n, v.id) : n,
                        ),
                      }));
                      setEditorKey((k) => k + 1);
                      setModal(null);
                    }}
                  >
                    恢复
                  </button>
                </div>
              ))
            ) : (
              <p>还没有历史版本。</p>
            )}
          </div>
        </Modal>
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

function Empty({
  icon,
  title,
  text,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <span>{icon}</span>
      <h2>{title}</h2>
      <p>{text}</p>
      {action}
    </div>
  );
}

function readingPositionLabel(
  progress: { readPage?: number; readOffset?: number },
  sourceKind: Source["kind"],
  pageCount?: number,
) {
  if (sourceKind === "pdf" && progress.readPage !== undefined) {
    const page = Math.max(1, Math.round(progress.readPage));
    return pageCount ? `第 ${page} / ${pageCount} 页` : `第 ${page} 页`;
  }
  if (progress.readOffset !== undefined && progress.readOffset > 0)
    return `正文位置 · 距顶部 ${Math.round(progress.readOffset)} 像素`;
  if (progress.readPage !== undefined) return `第 ${Math.max(1, Math.round(progress.readPage))} 页`;
  return "资料开头";
}

export function ReadingProgressConflictModal({
  storageMode = "hybrid",
  plan,
  onResolve,
  onClose,
}: {
  storageMode?: "hybrid" | "cloud";
  plan: ReadingProgressSyncPlan;
  onResolve: (selections: readonly ReadingProgressSyncSelection[]) => Promise<void>;
  onClose: () => void;
}) {
  const planKey = JSON.stringify(plan);
  const defaultChoices = Object.fromEntries(
    plan.conflicts.map((conflict) => [conflict.id, "remote"]),
  ) as Record<string, ReadingProgressSyncSelection["choice"]>;
  const [choiceState, setChoiceState] = useState<{
    planKey: string;
    choices: Record<string, ReadingProgressSyncSelection["choice"]>;
  }>(() => ({ planKey, choices: defaultChoices }));
  const choices = choiceState.planKey === planKey ? choiceState.choices : defaultChoices;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onResolve(
        plan.conflicts.map((conflict) => ({
          conflictId: conflict.id,
          choice: choices[conflict.id] || "remote",
        })),
      );
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "暂时无法保存阅读位置，请重试。 ");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="选择继续阅读位置" onClose={onClose} wide dismissible={!busy}>
      <form className="modal-body sync-conflict-modal" onSubmit={(event) => void submit(event)}>
        <p className="sync-conflict-intro">
          {storageMode === "cloud"
            ? "当前页面与云端都移动了同一资料的阅读位置。默认选中云端已确认位置，也可继续当前页面的位置；记录时间不用于自动覆盖。"
            : "本机和云端都移动了同一资料的阅读位置。云端已确认位置会被默认选中，你也可以继续本机位置；设备记录时间只供辨认，不用于自动覆盖。"}
          未选中的位置会保留在资料中，之后仍可切换。
        </p>
        {plan.conflicts.map((conflict) => {
          const choice = choices[conflict.id] || "remote";
          return (
            <section className="sync-conflict-card reading-conflict-card" key={conflict.id}>
              <div className="sync-conflict-heading">
                <div>
                  <b>{conflict.sourceTitle || "未命名资料"}</b>
                  <small>两个位置都来自同一资料版本</small>
                </div>
                <span className="sync-conflict-selected">
                  {choice === "remote"
                    ? "默认云端"
                    : storageMode === "cloud"
                      ? "已选当前页面"
                      : "已选本机"}
                </span>
              </div>
              <div
                className="reading-conflict-choices"
                role="radiogroup"
                aria-label={`${conflict.sourceTitle || "资料"}的继续阅读位置`}
              >
                {(
                  [
                    ["remote", "云端已确认（默认）", conflict.remote],
                    [
                      "local",
                      storageMode === "cloud" ? "当前页面待保存" : "本机待同步",
                      conflict.local,
                    ],
                  ] as const
                ).map(([side, label, progress]) => (
                  <label
                    className={`reading-conflict-choice ${side} ${choice === side ? "selected" : ""}`}
                    key={side}
                  >
                    <input
                      type="radio"
                      name={conflict.id}
                      value={side}
                      checked={choice === side}
                      disabled={busy}
                      onChange={() =>
                        setChoiceState((current) => ({
                          planKey,
                          choices: {
                            ...(current.planKey === planKey ? current.choices : defaultChoices),
                            [conflict.id]: side,
                          },
                        }))
                      }
                    />
                    <span>
                      <strong>{label}</strong>
                      <b>
                        {readingPositionLabel(progress, conflict.sourceKind, conflict.pageCount)}
                      </b>
                      <small>
                        {progress.lastReadAt
                          ? `设备记录时间 ${date(progress.lastReadAt)}`
                          : "没有设备记录时间"}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
            </section>
          );
        })}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <span className="muted">
            {storageMode === "cloud"
              ? "所选位置按已核对的云端版本保存，完成前请保持页面打开。"
              : "所选位置先保存到本机，再按已核对的云端版本同步。"}
          </span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? "正在保存…" : "保存所选位置"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SyncConflictModal({
  storageMode = "hybrid",
  plan,
  onResolve,
  onClose,
}: {
  storageMode?: "hybrid" | "cloud";
  plan: NoteSyncPlan;
  onResolve: (selections: readonly NoteSyncConflictSelection[]) => Promise<void>;
  onClose: () => void;
}) {
  type Draft = { choice?: NoteSyncConflictSelection["choice"]; content?: string };
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const localSafe = plan.safe.filter((change) => change.side === "local");
  const incomplete = plan.conflicts.some((conflict) => !drafts[conflict.id]?.choice);
  const choose = (
    conflictId: string,
    choice: NoteSyncConflictSelection["choice"],
    localContent: string,
  ) => {
    setDrafts((current) => ({
      ...current,
      [conflictId]: {
        choice,
        content: choice === "manual" ? (current[conflictId]?.content ?? localContent) : undefined,
      },
    }));
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (incomplete) {
      setError("请为每篇笔记选择保留版本或手动合并。 ");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const selections = plan.conflicts.map((conflict) => {
        const draft = drafts[conflict.id];
        if (!draft?.choice) throw new Error("冲突列表已改变，请重新检查。 ");
        return {
          conflictId: conflict.id,
          choice: draft.choice,
          content: draft.choice === "manual" ? (draft.content ?? "") : undefined,
        };
      });
      await onResolve(selections);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "暂时无法保存合并结果，请重试。 ");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="处理笔记同步冲突" onClose={onClose} wide dismissible={!busy}>
      <form className="modal-body sync-conflict-modal" onSubmit={(event) => void submit(event)}>
        <p className="sync-conflict-intro">
          {storageMode === "cloud"
            ? "当前页面与云端都修改了同一篇笔记。不会按时间自动覆盖；选择一侧时，另一侧正文保留为历史，手动合并保留双方原正文。"
            : "本机和云端都修改了同一篇笔记。系统不会按编辑时间自动覆盖；选择一侧时，另一侧正文会保留为笔记历史，手动合并会保留双方原正文。"}
        </p>
        {localSafe.length > 0 && (
          <div className="sync-conflict-safe" role="status">
            还会一并带入 {localSafe.length} 篇仅在本机变更的笔记
            {localSafe
              .slice(0, 3)
              .map((change) => `「${change.note?.title || change.noteId}」`)
              .join("、")}
            {localSafe.length > 3 ? "等" : ""}。
          </div>
        )}
        {plan.conflicts.map((conflict) => {
          const local = conflict.local!;
          const remote = conflict.remote!;
          const draft = drafts[conflict.id];
          return (
            <section className="sync-conflict-card" key={conflict.id}>
              <div className="sync-conflict-heading">
                <div>
                  <b>{local.title || remote.title || "未命名笔记"}</b>
                  <small>笔记 ID：{conflict.noteId}</small>
                </div>
                {draft?.choice && <span className="sync-conflict-selected">已选择</span>}
              </div>
              <div className="sync-conflict-sides">
                <label className="sync-conflict-side local">
                  <span>{storageMode === "cloud" ? "当前页面修改" : "本机副本"}</span>
                  <small>修改于 {date(local.updatedAt)}</small>
                  <textarea className="field" value={local.content} readOnly rows={7} />
                </label>
                <label className="sync-conflict-side remote">
                  <span>云端副本</span>
                  <small>修改于 {date(remote.updatedAt)}</small>
                  <textarea className="field" value={remote.content} readOnly rows={7} />
                </label>
              </div>
              <div
                className="sync-conflict-choices"
                role="radiogroup"
                aria-label={`${local.title} 的解决方式`}
              >
                <label>
                  <input
                    type="radio"
                    name={conflict.id}
                    checked={draft?.choice === "local"}
                    onChange={() => choose(conflict.id, "local", local.content)}
                  />
                  {storageMode === "cloud" ? "保留当前页面版本" : "保留本机版本"}
                </label>
                <label>
                  <input
                    type="radio"
                    name={conflict.id}
                    checked={draft?.choice === "remote"}
                    onChange={() => choose(conflict.id, "remote", local.content)}
                  />
                  保留云端版本
                </label>
                <label>
                  <input
                    type="radio"
                    name={conflict.id}
                    checked={draft?.choice === "manual"}
                    onChange={() => choose(conflict.id, "manual", local.content)}
                  />
                  手动合并
                </label>
              </div>
              {draft?.choice === "manual" && (
                <label className="sync-conflict-manual">
                  合并后的正文
                  <textarea
                    className="field"
                    value={draft.content ?? ""}
                    rows={8}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [conflict.id]: { choice: "manual", content: event.target.value },
                      }))
                    }
                  />
                  <small>这里保留原始正文格式；可编辑为空正文。</small>
                </label>
              )}
            </section>
          );
        })}
        {error && <p className="error-text">{error}</p>}
        <div className="modal-actions">
          <span className="muted">
            {storageMode === "cloud"
              ? "合并结果需得到云端确认，完成前请保持页面打开。"
              : "云端会在本机合并结果确认保存后再更新。"}
          </span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy || incomplete}>
            {busy
              ? "正在保存…"
              : plan.conflicts.length
                ? "保存合并结果"
                : storageMode === "cloud"
                  ? "合并当前页面独立笔记"
                  : "合并本机独立笔记"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConversationHistoryModal({
  conversation,
  onClose,
}: {
  conversation: Conversation;
  onClose: () => void;
}) {
  const crossLibrary = isCrossLibraryConversation(conversation);
  return (
    <Modal title={conversation.title} onClose={onClose}>
      <div className="modal-body conversation-history-modal">
        <p className="muted">
          {crossLibrary
            ? `这条跨库问答的 ${conversation.sourceIds.length} 份固定资料或版本已不能安全恢复。记录保留为只读内容，不会参与新的 AI 问答或检索。`
            : "原资料当前不可用。这份问答记录保留为只读内容，不会参与新的 AI 问答或检索。"}
        </p>
        <div className="conversation-transcript" aria-label="已保存的问答记录">
          {conversation.messages.length ? (
            conversation.messages.map((message) => (
              <article
                className={`conversation-transcript-message ${message.role}`}
                key={message.id}
              >
                <b>{message.role === "user" ? "你的问题" : "已保存的回答"}</b>
                <p>{message.content || (message.error ? "这次回答没有完成。" : "暂无正文")}</p>
                {message.error && <small>失败原因：{message.error}</small>}
                {message.citations.length > 0 && (
                  <details>
                    <summary>当时引用的 {message.citations.length} 处原文</summary>
                    <ul>
                      {message.citations.map((citation, index) => (
                        <li
                          key={`${citation.sourceId}:${citation.versionId}:${citation.chunkId}:${index}`}
                        >
                          {citation.title}：{citation.quote}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {!!message.noteEvidence?.length && (
                  <details>
                    <summary>当时参考的 {message.noteEvidence.length} 段我的笔记</summary>
                    <ul>
                      {message.noteEvidence.map((evidence, index) => (
                        <li key={`${evidence.noteId}:${evidence.blockId}:${index}`}>
                          {evidence.title}：{evidence.quote}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </article>
            ))
          ) : (
            <p className="muted">这条记录没有保留消息正文。</p>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </Modal>
  );
}

function DeleteSpaceModal({
  data,
  space,
  onClose,
  onDelete,
}: {
  data: WorkspaceData;
  space: Space;
  onClose: () => void;
  onDelete: (recycleExclusiveSources: boolean, expectedFingerprint: string) => void;
}) {
  const [recycleExclusiveSources, setRecycleExclusiveSources] = useState(false);
  const impact: SpaceDeletionImpact = previewLearningSpaceDeletion(data, space.id);
  const fingerprint = learningSpaceDeletionFingerprint(data, space.id);
  return (
    <Modal title={`删除「${space.name}」？`} onClose={onClose}>
      <div className="modal-body space-delete-modal">
        <p className="space-delete-intro">
          此操作会删除知识库及其空间级整理记录。原始资料默认不会被删除；它们会保留在资料库中。
        </p>
        <div className="space-delete-impact" aria-label="删除影响预览">
          <p>{recycleExclusiveSources ? "将转到收件箱或回收站" : "将保留并转到收件箱"}</p>
          <ul>
            {impact.exclusiveSources > 0 && <li>{impact.exclusiveSources} 份仅属于此空间的资料</li>}
            {impact.notes > 0 && <li>{impact.notes} 篇笔记或知识页</li>}
            {impact.conversations > 0 && <li>{impact.conversations} 个问答记录</li>}
            {!impact.exclusiveSources && !impact.notes && !impact.conversations && (
              <li>没有需要转移的当前内容</li>
            )}
          </ul>
          {impact.sharedSources > 0 && (
            <p>{impact.sharedSources} 份资料会保留在其他知识库，并从此知识库移除。</p>
          )}
          {(impact.recycleBinSources > 0 || impact.recycleBinNotes > 0) && (
            <p className="space-delete-recycle-info">
              回收站内的 {impact.recycleBinSources} 份资料和 {impact.recycleBinNotes}{" "}
              篇笔记也会改为收件箱归属；恢复后不会回到这个知识库。
            </p>
          )}
          {(impact.organizationJobs > 0 || impact.conceptRelations > 0) && (
            <p className="space-delete-derived">
              将移除 {impact.organizationJobs} 条本空间整理记录和 {impact.conceptRelations} 条关系
              {impact.pendingOrganizationJobs > 0
                ? `，其中 ${impact.pendingOrganizationJobs} 条整理任务会停止`
                : ""}
              。
            </p>
          )}
        </div>
        {impact.exclusiveSources > 0 && (
          <label className="checkbox-row space-delete-option">
            <input
              type="checkbox"
              checked={recycleExclusiveSources}
              onChange={(event) => setRecycleExclusiveSources(event.target.checked)}
            />
            同时将仅属于此空间的 {impact.exclusiveSources} 份资料移入回收站
          </label>
        )}
        <p className="muted space-delete-note">
          移入回收站的资料可恢复；恢复后会保留在收件箱。这个空间本身和它的整理记录无法恢复。
        </p>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-danger"
            onClick={() => onDelete(recycleExclusiveSources, fingerprint)}
          >
            {recycleExclusiveSources ? "删除并移入回收站" : "删除空间并保留资料"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function ImportModal({
  storageMode = "hybrid",
  spaceId,
  spaces,
  sources,
  jobs,
  cloudUserId,
  saveState,
  saveError,
  onWebImport,
  onImportFile,
  onRetryImport,
  onCancelImport,
  onClose,
  onOpen,
}: {
  storageMode?: "hybrid" | "cloud";
  spaceId: string;
  spaces: Space[];
  sources: Source[];
  jobs: ImportJob[];
  cloudUserId?: string;
  saveState: SaveState;
  saveError?: string;
  onWebImport: (source: Source) => void;
  onImportFile: (
    file: File,
    targetSpaceId: string,
    keepDuplicate?: boolean,
    aiAllowed?: boolean,
  ) => Promise<{ kind: "duplicate"; source: Source } | { kind: "queued"; job: ImportJob }>;
  onRetryImport: (jobId: string) => Promise<void>;
  onCancelImport: (jobId: string) => void;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const [tab, setTab] = useState("file");
  const [target, setTarget] = useState(spaceId);
  const [aiAllowed, setAiAllowed] = useState(false);
  const [starting, setStarting] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [logs, setLogs] = useState<
    {
      title: string;
      detail: string;
      id?: string;
      jobId?: string;
      duplicate?: { source: Source; file: File; target: string; aiAllowed: boolean };
    }[]
  >([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const importQueue = useRef<Promise<void>>(Promise.resolve());
  const loggedJobIds = useMemo(
    () => new Set(logs.flatMap((log) => (log.jobId ? [log.jobId] : []))),
    [logs],
  );
  const visibleJobs = useMemo(
    () => jobs.filter((job) => job.status !== "completed" || loggedJobIds.has(job.id)),
    [jobs, loggedJobIds],
  );
  const currentJobIds = useMemo(() => new Set(jobs.map((job) => job.id)), [jobs]);
  const visibleLogs = useMemo(
    () =>
      logs.flatMap((log, index) =>
        log.jobId && currentJobIds.has(log.jobId) ? [] : [{ log, index }],
      ),
    [currentJobIds, logs],
  );
  const quotaUsage = useMemo(() => assessImportQuota({ sources }, []).usage, [sources]);
  const sourceForJob = (job: ImportJob) =>
    sources.find((source) => source.id === job.sourceId && source.versionId === job.versionId);
  const cloudConfirmation = useMemo(() => {
    const trackedSourceIds = new Set([
      ...visibleJobs.map((job) => job.sourceId),
      ...logs.flatMap((log) => (log.id ? [log.id] : [])),
    ]);
    const originalUploaded = sources.some(
      (source) =>
        trackedSourceIds.has(source.id) &&
        [source, ...(source.versions ?? [])].some((version) => Boolean(version.storagePath)),
    );
    if (!cloudUserId)
      return {
        tone: "local",
        detail: "仅保存在此浏览器；登录后才会上传原文件并确认资料库。",
      };
    if (saveState === "loading" || saveState === "saving")
      return {
        tone: "pending",
        detail: originalUploaded
          ? "原文件已上传，正在确认资料库…"
          : storageMode === "cloud"
            ? "正在上传原件并保存资料库；完成前请保持页面打开。"
            : "本机已保存，正在上传并确认资料库…",
      };
    if (saveState === "cloud") return { tone: "confirmed", detail: "当前工作区已确认云端。" };
    if (saveState === "error" || saveState === "conflict")
      return {
        tone: "blocked",
        detail: `${
          originalUploaded
            ? "原文件已上传，但资料库云端未确认。"
            : storageMode === "cloud"
              ? "当前页面暂存修改，云端未确认。"
              : "本机已保留，云端未确认。"
        }${saveError ? ` ${saveError}` : " 请处理保存问题后重新连接。"}`,
      };
    return {
      tone: "local",
      detail:
        storageMode === "cloud" ? "当前页面暂存修改；尚未确认云端。" : "本机已保存；尚未确认云端。",
    };
  }, [storageMode, cloudUserId, logs, saveError, saveState, sources, visibleJobs]);
  const jobDetail = (job: ImportJob, source?: Source) => {
    if (source?.deletedAt) return "资料已移入回收站；恢复后可在这里重新解析。";
    if (!source) return "对应资料的当前版本已不可用，无法继续解析。";
    if (job.status === "queued")
      return storageMode === "cloud"
        ? saveState === "cloud"
          ? "任务已保存到云端，等待解析。"
          : "等待解析与云端保存确认；完成前请保持页面打开。"
        : "等待解析；关闭窗口后会继续保留这条任务。";
    if (job.status === "running")
      return job.stage === "indexing" ? "正在整理检索内容…" : "正在解析原文件…";
    if (job.status === "cancelled") return "解析已取消，原文件仍已保存。";
    if (job.status === "completed")
      return source?.status === "partial"
        ? source.error || "解析已完成，但只有部分正文可检索。"
        : "解析完成，正文已可检索。";
    return job.error || "导入未完成，可使用原文件重新解析。";
  };
  async function startFile(
    file: File,
    targetSpaceId: string,
    keepDuplicate = false,
    sourceAiAllowed = aiAllowed,
  ) {
    setStarting((count) => count + 1);
    try {
      const result = await onImportFile(file, targetSpaceId, keepDuplicate, sourceAiAllowed);
      if (result.kind === "duplicate") {
        setLogs((current) => [
          ...current,
          {
            title: file.name,
            detail: "检测到相同内容，已关联已有资料。该资料的 AI 使用设置保持不变。",
            id: result.source.id,
            duplicate: {
              source: result.source,
              file,
              target: targetSpaceId,
              aiAllowed: sourceAiAllowed,
            },
          },
        ]);
      } else {
        setLogs((current) => [
          ...current,
          {
            title: file.name,
            detail:
              storageMode === "cloud"
                ? "已进入云端导入流程；原件与资料库是否保存完成，以云端确认状态为准。"
                : "原文件已保存，正在后台解析；可关闭此窗口继续使用资料库。",
            id: result.job.sourceId,
            jobId: result.job.id,
          },
        ]);
      }
    } catch (cause) {
      setLogs((current) => [
        ...current,
        { title: file.name, detail: cause instanceof Error ? cause.message : "导入失败，请重试。" },
      ]);
    } finally {
      setStarting((count) => Math.max(0, count - 1));
    }
  }
  function queueImportFiles(
    files: FileList | File[],
    targetSpaceId: string,
    keepDuplicate = false,
    sourceAiAllowed = aiAllowed,
  ) {
    const selected = Array.from(files);
    // A normal pick might reuse an existing original. Keep structural limits in
    // the modal, but let the coordinator make the account-capacity decision
    // after SHA-256 duplicate detection. An explicitly requested copy always
    // consumes another original-file allowance, so it keeps the strict preview.
    const assessment = assessImportQuota({ sources }, selected, undefined, {
      deferAccountStorageLimit: !keepDuplicate,
    });
    const strictAccountPreview = keepDuplicate ? null : assessImportQuota({ sources }, selected);
    const deferredAccountIndexes = new Set<number>();
    for (const item of strictAccountPreview?.items || []) {
      if (
        !item.accepted &&
        item.rejections.some((rejection) => rejection.code === "account-storage-limit")
      )
        deferredAccountIndexes.add(item.index);
    }
    const rejected = assessment.items.flatMap((item) => {
      if (item.accepted) return [];
      return [
        {
          title: item.file.name || "未命名文件",
          detail: item.rejections.map((rejection) => rejection.message).join(" "),
        },
      ];
    });
    const deferred = assessment.items.flatMap((item) => {
      if (!item.accepted || !deferredAccountIndexes.has(item.index)) return [];
      return [
        {
          title: item.file.name || "未命名文件",
          detail:
            "账户空间不足，会先核对内容是否已保存；是否可继续将由导入时判定。相同内容会关联已有资料，新增内容将被拒绝。",
        },
      ];
    });
    if (rejected.length || deferred.length)
      setLogs((current) => [...current, ...rejected, ...deferred]);

    const accepted = assessment.items.flatMap((item) => {
      if (!item.accepted) return [];
      const file = selected[item.index];
      return file ? [file] : [];
    });
    if (!accepted.length) return false;

    // Keep every UI-triggered import in one queue. In particular, selecting a
    // batch cannot make several originals race through persistence at once.
    const run = async () => {
      for (const file of accepted)
        await startFile(file, targetSpaceId, keepDuplicate, sourceAiAllowed);
    };
    const queued = importQueue.current.then(run, run);
    importQueue.current = queued.catch(() => {});
    return true;
  }
  function importFiles(files: FileList | File[]) {
    return queueImportFiles(files, target);
  }
  return (
    <Modal title="导入学习资料" onClose={onClose} wide>
      <div className="modal-body">
        <div className="tabs">
          <button className={tab === "file" ? "active" : ""} onClick={() => setTab("file")}>
            上传文件
          </button>
          <button className={tab === "web" ? "active" : ""} onClick={() => setTab("web")}>
            保存网页
          </button>
        </div>
        <label>
          保存到
          <select className="field" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">收件箱</option>
            {spaces.map((s) => (
              <option value={s.id} key={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox-row import-ai-consent">
          <input
            type="checkbox"
            aria-label="允许 AI 使用本次导入的资料"
            checked={aiAllowed}
            onChange={(event) => setAiAllowed(event.target.checked)}
          />
          <span>
            <strong>允许 AI 使用本次导入的资料</strong>
            <small>
              用于带出处的问答、摘要和整理；未勾选仍可解析、阅读与普通搜索，可在资料详情随时更改。
            </small>
          </span>
        </label>
        {tab === "file" ? (
          <>
            <input
              type="file"
              multiple
              accept=".pdf,.docx,.md,.markdown,.txt"
              ref={fileRef}
              className="visually-hidden"
              aria-label="选择要导入的文件"
              onChange={(e) => {
                if (e.target.files) void importFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              className={`dropzone ${dragging ? "dragging" : ""}`}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void importFiles(e.dataTransfer.files);
              }}
            >
              {starting ? <Loader2 size={30} className="spin" /> : <Upload size={30} />}
              <b>{starting ? "正在保留原文件…" : "点击选择，或把文件拖到这里"}</b>
              <span>
                PDF、DOCX、Markdown、TXT · 单个文件不超过{" "}
                {formatImportQuotaBytes(LOCAL_IMPORT_QUOTA_POLICY.maxFileBytes)}
              </span>
              <small>原文件保存后，解析可在后台继续、取消或重新开始。</small>
            </button>
            <div
              className="notice import-quota"
              aria-label={storageMode === "cloud" ? "导入保护额度" : "本机导入额度"}
              role="status"
            >
              <span>
                <b>账户已用</b> {formatImportQuotaBytes(quotaUsage.bytes)} /{" "}
                {formatImportQuotaBytes(quotaUsage.accountLimitBytes)}
              </span>
              <small>剩余 {formatImportQuotaBytes(quotaUsage.accountRemainingBytes)}</small>
              <small>
                每批最多 {quotaUsage.batchFileLimit} 个文件，合计{" "}
                {formatImportQuotaBytes(quotaUsage.batchByteLimit)}
              </small>
              {quotaUsage.accountRemainingBytes === 0 ? (
                <small>额度已满时会先判重；是否可继续将由导入时判定。</small>
              ) : null}
            </div>
          </>
        ) : (
          <WebImportForm
            targetSpaceId={target}
            cloudUserId={cloudUserId}
            aiAllowed={aiAllowed}
            onImport={onWebImport}
            onSaved={(source) =>
              setLogs((current) => [
                ...current,
                {
                  title: source.title,
                  detail:
                    source.status === "link-only"
                      ? "已加入链接收藏；没有正文，不参与正文检索。"
                      : `已加入资料库 · ${source.chunks.length} 个内容块，请留意工作台保存状态。`,
                  id: source.id,
                },
              ])
            }
          />
        )}
        {(visibleJobs.length > 0 || visibleLogs.length > 0) && (
          <div className="import-results" aria-live="polite">
            <div
              className={`import-cloud-confirmation ${cloudConfirmation.tone}`}
              aria-label="云端确认"
              role="status"
            >
              <Cloud size={16} />
              <div className="grow">
                <b>云端确认</b>
                <p>{cloudConfirmation.detail}</p>
              </div>
            </div>
            {visibleJobs.map((job) => {
              const source = sourceForJob(job);
              return (
                <div key={job.id}>
                  <FileText size={16} />
                  <div className="grow">
                    <b>{source?.title || job.filename}</b>
                    <p>{jobDetail(job, source)}</p>
                  </div>
                  {source && !source.deletedAt && (
                    <button className="text-button" onClick={() => onOpen(source.id)}>
                      查看
                    </button>
                  )}
                  {(job.status === "queued" || job.status === "running") && (
                    <button className="text-button" onClick={() => onCancelImport(job.id)}>
                      取消
                    </button>
                  )}
                  {(job.status === "failed" || job.status === "cancelled") && (
                    <button
                      className="text-button"
                      disabled={!source || !!source.deletedAt || !job.originalSaved}
                      title={
                        source?.deletedAt
                          ? "请先在回收站恢复资料，再重新解析。"
                          : !source
                            ? "对应资料的当前版本已不可用，无法重新解析。"
                            : !job.originalSaved
                              ? "原文件尚未保存，请重新选择文件。"
                              : undefined
                      }
                      onClick={() => {
                        void onRetryImport(job.id).catch((cause) =>
                          setLogs((current) => [
                            ...current,
                            {
                              title: source?.title || job.filename,
                              detail:
                                cause instanceof Error ? cause.message : "重新解析失败，请重试。",
                            },
                          ]),
                        );
                      }}
                    >
                      重新解析
                    </button>
                  )}
                </div>
              );
            })}
            {visibleLogs.map(({ log, index: logIndex }) => (
              <div key={logIndex}>
                <FileText size={16} />
                <div className="grow">
                  <b>{log.title}</b>
                  <p>{log.detail}</p>
                </div>
                {log.id && (
                  <button className="text-button" onClick={() => onOpen(log.id!)}>
                    阅读
                  </button>
                )}
                {log.duplicate && (
                  <button
                    className="text-button"
                    onClick={() => {
                      const duplicate = log.duplicate!;
                      if (
                        queueImportFiles(
                          [duplicate.file],
                          duplicate.target,
                          true,
                          duplicate.aiAllowed,
                        )
                      )
                        setLogs((current) =>
                          current.map((item, index) =>
                            index === logIndex
                              ? {
                                  ...item,
                                  detail: "正在保留独立副本…",
                                  duplicate: undefined,
                                }
                              : item,
                          ),
                        );
                    }}
                  >
                    保留副本
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <span className="muted">资料默认仅你可见；后台任务会保存在当前工作区。</span>
          <button className="btn" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </Modal>
  );
}
