"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  FolderOpen,
  Highlighter,
  History,
  LoaderCircle,
  MessageSquare,
  Minus,
  MapPin,
  PanelRightClose,
  Plus,
  Crop,
  Search,
  Sparkles,
  Square,
  StickyNote,
  UserRound,
  X,
} from "lucide-react";
import { convertDocxToStructure, type DocxBlock } from "@/lib/docx-structure";
import type {
  AnswerAttempt,
  Annotation,
  AnswerResult,
  AnswerScopeSnapshot,
  Citation,
  Conversation,
  Message,
  Scope,
  Source,
} from "@/lib/types";
import PdfReader from "../pdf-reader";
import type { PdfReadingMode } from "../pdf-reader";
import RegionStudyPanel from "../region-study-panel";
import DocxContent from "../docx-content";
import ModelStatus from "../model-status";
import WebVersionPanel from "../web-version-panel";
import Modal from "../modal";
import { assertAnnotationSource, createAnnotation, updateAnnotation } from "@/lib/annotations";
import { priorUserQuestions } from "@/lib/answer-context";
import { citationProblem, findQuoteRange, quoteOffsets } from "../reader-utils";
import {
  annotationRangeResolver,
  readNativePdfSelectionPage,
  readPlainAnnotationSelection,
} from "../annotation-selection";
import { markdownQuoteText, readMarkdownSelection } from "../markdown-selection";
import {
  deriveReaderOutline,
  normalizeReaderOutlineTitle,
  type ReaderOutlineItem,
} from "../reader-outline";
import { findReaderSearchRanges, readerSearchRoot } from "../reader-search";
import type { AnswerProgress } from "@/lib/answer-stream-types";
import {
  answerScopeAvailability,
  isSourceAnswerEligible,
  selectedDocumentNotes,
} from "@/lib/retrieval";
import {
  isParserCoverageIncomplete,
  sourceCaptureScopeNotice,
  sourceParserCoverageNotice,
} from "@/lib/source-coverage";
import { selectReadingPositionAlternative } from "@/lib/reading-position-alternatives";
import "../reader.css";
import {
  AI_PANEL_DEFAULT_WIDTH,
  AI_PANEL_KEYBOARD_STEP,
  AI_PANEL_MAX_WIDTH,
  AI_PANEL_MIN_WIDTH,
  clampAiPanelWidth,
  defaultAiPanelWidthForViewport,
  maxAiPanelWidthForWorkspace,
} from "./ai-panel-width";
import {
  AnswerMarkdown,
  CitationCard,
  CitationChip,
  Markdown,
  NoteEvidenceCard,
  NoteEvidenceChip,
  noteEvidenceProblem,
} from "./answer-markdown";
import {
  citationCardId,
  citationKey,
  citationMarkerIndexes,
  noteEvidenceCardId,
  noteEvidenceKey,
} from "./citation-markdown";
import {
  EMPTY_NOTES,
  EMPTY_NOTE_EVIDENCE,
  FOLLOW_UP_PROMPTS,
  READING_ACTIVITY_THROTTLE_MS,
  READING_OPEN_SETTLE_MS,
  answerPhases,
  highlightStyles,
  readerScopeOptions,
  readingPositionMetrics,
  readingPositionOriginLabels,
  readingPositionSummary,
  readingPositionTime,
  scopeLabels,
  sourceStatusLabel,
} from "./reader-constants";
import ReaderTopbar from "./reader-topbar";
import {
  clearReaderSearchHighlights,
  getAndroidUserAgent,
  getServerAndroidUserAgent,
  selectionToolbarPosition,
  subscribeToStaticUserAgent,
} from "./reader-dom";
import type {
  BoundPdfCaptureResult,
  ExcerptKnowledgeTarget,
  ReaderProps,
  ReaderSearchResult,
  RegionCaptureStart,
  SelectionToolbarPosition,
} from "./reader-types";

export default function Reader(props: ReaderProps) {
  const {
    source,
    sources,
    notes = EMPTY_NOTES,
    space,
    conversations,
    annotations,
    aiEnabled,
    onSourceChange,
    onConversationChange,
    onAnnotationAdd,
    onAnnotationUpdate,
    onAnnotationDelete,
    onSaveNote,
    onAppendToKnowledgePage,
    onSaveExcerptToKnowledgePage,
    onAsk,
    onOpenSource,
    onBack,
    getSourceBlob,
    initialCitation,
    onCitationConsumed,
  } = props;
  const liveSource = props.currentSource ?? sources.find((item) => item.id === source.id) ?? source;
  const historical = liveSource.versionId !== source.versionId;
  const contextualBackLabel = props.backLabel?.trim();
  const backLabel = contextualBackLabel || "返回资料库";
  const mobileBackLabel = contextualBackLabel?.replace(/^返回/u, "").trim() || "资料";
  const [aiOpen, setAiOpen] = useState(true);
  const androidUserAgent = useSyncExternalStore(
    subscribeToStaticUserAgent,
    getAndroidUserAgent,
    getServerAndroidUserAgent,
  );
  const [aiPanelWidth, setAiPanelWidth] = useState(AI_PANEL_DEFAULT_WIDTH);
  const [aiPanelWidthLimit, setAiPanelWidthLimit] = useState(AI_PANEL_MAX_WIDTH);
  const [aiPanelResizing, setAiPanelResizing] = useState(false);
  // On phones, citations form their own temporary page so a learner can check
  // an excerpt and return to the same conversation without losing its draft or
  // scroll position. Tablets still use the reader-plus-slide-over pattern.
  const [mobileTab, setMobileTab] = useState<"reading" | "ai" | "citation">("reading");
  const [page, setPage] = useState(source.readPage || 1);
  const pageRef = useRef(source.readPage || 1);
  const [pages, setPages] = useState(source.pageCount || 1);
  const [pdfReadingMode, setPdfReadingMode] = useState<PdfReadingMode>("single");
  const [pdfNavigationRequest, setPdfNavigationRequest] = useState(0);
  const [nativeSelectionPage, setNativeSelectionPage] = useState<number | undefined>();
  const [zoom, setZoom] = useState(100);
  const [showText, setShowText] = useState(false);
  const [regionCaptureStart, setRegionCaptureStart] = useState<RegionCaptureStart | null>(null);
  const regionCaptureStartRef = useRef<RegionCaptureStart | null>(null);
  const [regionCapture, setRegionCapture] = useState<BoundPdfCaptureResult | null>(null);
  const [selection, setSelection] = useState("");
  const [selectionPresentation, setSelectionPresentation] = useState<{
    sourceId: string;
    versionId: string;
    rawQuote: string;
    visibleQuote: string;
    chunkIds: string[];
    rawStart: number;
    rawEnd: number;
  } | null>(null);
  const [plainSelectionAnchor, setPlainSelectionAnchor] = useState<{
    sourceId: string;
    versionId: string;
    quote: string;
    textAnchor: { start: number; end: number };
  } | null>(null);
  const currentSelectionPresentation =
    selectionPresentation?.sourceId === source.id &&
    selectionPresentation.versionId === source.versionId &&
    selectionPresentation.rawQuote === selection
      ? selectionPresentation
      : null;
  const selectionDisplay =
    currentSelectionPresentation?.visibleQuote ?? markdownQuoteText(source, selection);
  const [selectionToolbar, setSelectionToolbar] = useState<SelectionToolbarPosition | null>(null);
  const [scope, setScope] = useState<Scope>("document-notes");
  const [selectedIds, setSelectedIds] = useState<string[]>([source.id]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [answerDraft, setAnswerDraft] = useState<AnswerResult | null>(null);
  const [stoppingAnswer, setStoppingAnswer] = useState(false);
  const [answerPhase, setAnswerPhase] =
    useState<Extract<AnswerProgress, { type: "progress" }>["phase"]>("retrieving");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [newConversation, setNewConversation] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [webPanel, setWebPanel] = useState<"history" | "refresh" | "replace" | null>(null);
  const [sourceActionsOpen, setSourceActionsOpen] = useState(false);
  const [retainedPositionsOpen, setRetainedPositionsOpen] = useState(false);
  const [annotationOpen, setAnnotationOpen] = useState(false);
  const [annotationDraft, setAnnotationDraft] = useState<Pick<
    Annotation,
    "quote" | "page" | "textAnchor"
  > | null>(null);
  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string | null>(null);
  const [annotationFocusEpoch, setAnnotationFocusEpoch] = useState(0);
  const [annotationNote, setAnnotationNote] = useState("");
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [editingAnnotationNote, setEditingAnnotationNote] = useState("");
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchResult, setSearchResult] = useState<ReaderSearchResult | null>(null);
  const [focusedCitation, setFocusedCitation] = useState<Citation | null>(null);
  const [citationError, setCitationError] = useState("");
  const [expandedCitationKey, setExpandedCitationKey] = useState<string | null>(null);
  const [saveTargetMessageId, setSaveTargetMessageId] = useState<string | null>(null);
  const [knowledgePageTargetId, setKnowledgePageTargetId] = useState("");
  const [excerptKnowledgeTarget, setExcerptKnowledgeTarget] =
    useState<ExcerptKnowledgeTarget | null>(null);
  const [excerptKnowledgePageTargetId, setExcerptKnowledgePageTargetId] = useState("");
  const [renderRevision, setRenderRevision] = useState(0);
  const [docxStructure, setDocxStructure] = useState<{
    key: string;
    blocks: DocxBlock[];
  } | null>(null);
  const docxStructureKey = `${source.id}:${source.versionId}`;
  const docxBlocks = docxStructure?.key === docxStructureKey ? docxStructure.blocks : null;
  const textContainer = useRef<HTMLDivElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const questionInput = useRef<HTMLTextAreaElement>(null);
  const citationReturnButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchToggle = useRef<HTMLButtonElement>(null);
  const outlineToggle = useRef<HTMLButtonElement>(null);
  const controller = useRef<AbortController | null>(null);
  const answerDraftRef = useRef<AnswerResult | null>(null);
  const manuallyStoppedController = useRef<AbortController | null>(null);
  const pendingCitation = useRef<Citation | null>(null);
  const activeSourceId = useRef(`${source.id}:${source.versionId}`);
  const consumedInitialConversationId = useRef<string | null>(null);
  const sourceRef = useRef(source);
  const locatedReaderTarget = useRef<string | null>(null);
  const getSourceBlobRef = useRef(getSourceBlob);
  const historicalRef = useRef(historical);
  const lastReadReportedAt = useRef(0);
  const savedReadingActivityAt = useRef(0);
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readingSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingReadOffset = useRef<number | null>(null);
  const savedReadOffset = useRef(source.readOffset || 0);
  const savedReadPage = useRef(source.readPage || 1);
  const pendingReadPage = useRef<number | null>(null);
  const pendingReadingReported = useRef(false);
  const pendingReadingCallback = useRef(props.onPendingReadingChange);
  const readingPositionRevision = useRef(props.readingPositionRevision);
  const readingPositionApplyFrame = useRef<number | null>(null);
  const sourceActions = useRef<HTMLDivElement>(null);
  const sourceActionsToggle = useRef<HTMLButtonElement>(null);
  const excerptSaveTrigger = useRef<HTMLButtonElement>(null);
  const excerptSaveDialog = useRef<HTMLElement>(null);
  const aiPanelWidthRef = useRef(AI_PANEL_DEFAULT_WIDTH);
  const aiPanelPreferredWidthRef = useRef(AI_PANEL_DEFAULT_WIDTH);
  const aiPanelWidthLimitRef = useRef(AI_PANEL_MAX_WIDTH);
  const aiPanelWidthCustomizedRef = useRef(false);
  const readerWorkspace = useRef<HTMLElement>(null);
  const aiPanelResizePointer = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);

  const androidMobileVariant =
    props.mobilePlatform === "android" || (props.mobilePlatform !== "default" && androidUserAgent);

  function replaceAnswerDraft(next: AnswerResult | null) {
    answerDraftRef.current = next;
    setAnswerDraft(next);
  }
  useEffect(() => {
    sourceRef.current = source;
    getSourceBlobRef.current = getSourceBlob;
    historicalRef.current = historical;
    pendingReadingCallback.current = props.onPendingReadingChange;
  });
  useEffect(() => {
    const callback = props.onPendingReadingChange;
    return () => {
      callback?.(false);
      pendingReadingReported.current = false;
    };
    // Capture the callback for this owner so cleanup cannot clear a newer reader's intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id, source.versionId, props.cloudUserId]);
  useEffect(() => {
    const saved = Date.parse(source.lastReadAt || "");
    const now = new Date().getTime();
    savedReadingActivityAt.current = Number.isFinite(saved) ? saved : 0;
    // A clock-skewed future timestamp must not suppress activity on this device
    // for minutes or hours. Preserve it in storage while throttling locally.
    lastReadReportedAt.current = Number.isFinite(saved) && saved <= now ? saved : 0;
  }, [source.id, source.versionId, source.lastReadAt]);
  useEffect(() => {
    savedReadOffset.current = source.readOffset || 0;
  }, [source.id, source.versionId, source.readOffset]);
  useEffect(() => {
    savedReadPage.current = source.readPage || 1;
  }, [source.id, source.versionId, source.readPage]);

  const availableSources = useMemo(
    () =>
      sources.filter(
        (item) =>
          !item.deletedAt &&
          (space.id === "inbox" ? item.spaceIds.length === 0 : item.spaceIds.includes(space.id)),
      ),
    [sources, space.id],
  );
  const knowledgePages = useMemo(
    () =>
      notes
        .filter((note) => note.kind === "knowledge" && !note.deletedAt && note.spaceId === space.id)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [notes, space.id],
  );
  const documentNoteCount = useMemo(
    () =>
      selectedDocumentNotes(
        {
          schemaVersion: 1,
          spaces: [space],
          sources,
          notes,
          annotations: [],
          conversations: [],
          aiEnabled,
        },
        {
          question: "总结当前资料",
          scope: "document-notes",
          sourceId: source.id,
          sourceIds: [],
          spaceId: space.id,
        },
      ).length,
    [aiEnabled, notes, sources, space, source.id],
  );
  const history = useMemo(
    () =>
      conversations
        .filter(
          (item) =>
            !item.comparison &&
            item.scope !== "cross-library-sources" &&
            (item.spaceId === space.id || item.id === props.initialConversationId) &&
            (!item.sourceId || item.sourceId === source.id),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [conversations, space.id, source.id, props.initialConversationId],
  );
  const conversation = newConversation
    ? undefined
    : history.find((item) => item.id === selectedConversation) || history[0];
  const sourceAnnotations = annotations.filter(
    (item) => item.sourceId === source.id && item.versionId === source.versionId,
  );
  const outlineItems = useMemo(() => deriveReaderOutline(source, docxBlocks), [source, docxBlocks]);
  const messages = conversation?.messages || [];
  const scopedSources =
    scope === "space"
      ? availableSources
      : scope === "sources"
        ? availableSources.filter((item) => selectedIds.includes(item.id))
        : [source];
  const scopeAvailability = answerScopeAvailability(scopedSources);
  const ineligibleCount = scopeAvailability.excludedCount;
  const askEligibilityMessage = scopeAvailability.blockedMessage;

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    let disposed = false;
    if (source.kind !== "docx" || !source.text) return;
    const docxSource = sourceRef.current;
    void (async () => {
      try {
        const blob = await getSourceBlobRef.current(docxSource);
        if (!blob || disposed) return;
        const structure = await convertDocxToStructure(await blob.arrayBuffer());
        if (disposed || !structure.blocks.length) return;
        setDocxStructure({ key: docxStructureKey, blocks: structure.blocks });
        setRenderRevision((value) => value + 1);
      } catch {
        // A retained raw-text reading remains available when an original is
        // offline or the optional structure pass cannot parse it.
      }
    })();
    return () => {
      disposed = true;
    };
  }, [docxStructureKey, source.blobKey, source.kind, source.text]);
  useEffect(
    () => () => {
      if (readingPositionApplyFrame.current !== null)
        cancelAnimationFrame(readingPositionApplyFrame.current);
    },
    [],
  );
  useEffect(() => () => clearReaderSearchHighlights(), []);
  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);
  useEffect(() => {
    if (excerptKnowledgeTarget) excerptSaveDialog.current?.focus();
  }, [excerptKnowledgeTarget]);
  useEffect(() => {
    if (!historical) return;
    controller.current?.abort();
    if (progressTimer.current) clearTimeout(progressTimer.current);
    progressTimer.current = null;
    if (readingSyncTimer.current) clearTimeout(readingSyncTimer.current);
    readingSyncTimer.current = null;
    pendingReadOffset.current = null;
    pendingReadPage.current = null;
    reportPendingReading(false);
  }, [historical]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (textContainer.current && (source.kind !== "pdf" || showText))
        textContainer.current.scrollTop = source.readOffset || 0;
    });
    return () => {
      cancelAnimationFrame(frame);
      if (progressTimer.current) clearTimeout(progressTimer.current);
      progressTimer.current = null;
      flushPendingReading();
      if (readingSyncTimer.current) clearTimeout(readingSyncTimer.current);
      readingSyncTimer.current = null;
    };
    // Saved position is read once for a newly opened document, not on every progress save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id, source.versionId, showText]);
  useEffect(() => {
    const previous = readingPositionRevision.current;
    readingPositionRevision.current = props.readingPositionRevision;
    if (
      previous === undefined ||
      props.readingPositionRevision === undefined ||
      props.readingPositionRevision <= previous
    )
      return;

    if (progressTimer.current) clearTimeout(progressTimer.current);
    progressTimer.current = null;
    if (readingSyncTimer.current) clearTimeout(readingSyncTimer.current);
    readingSyncTimer.current = null;
    pendingReadOffset.current = null;
    pendingReadPage.current = null;
    savedReadOffset.current = source.readOffset || 0;
    savedReadPage.current = source.readPage || 1;
    setFocusedCitation(null);
    setFocusedAnnotationId(null);
    locatedReaderTarget.current = null;

    reportPendingReading(false);

    const frame = requestAnimationFrame(() => {
      if (source.kind === "pdf") {
        const next = Math.max(
          1,
          Math.min(source.readPage || 1, Math.max(1, source.pageCount || pages)),
        );
        pageRef.current = next;
        setPage(next);
        setPdfNavigationRequest((value) => value + 1);
      }
      if (textContainer.current && (source.kind !== "pdf" || showText))
        textContainer.current.scrollTop = source.readOffset || 0;
    });
    return () => cancelAnimationFrame(frame);
    // Reading progress is intentionally re-applied only when the parent advances this signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.readingPositionRevision]);
  useEffect(() => {
    if (activeSourceId.current === `${source.id}:${source.versionId}`) return;
    controller.current?.abort();
    activeSourceId.current = `${source.id}:${source.versionId}`;
    consumedInitialConversationId.current = null;
    setBusy(false);
    replaceAnswerDraft(null);
    setStoppingAnswer(false);
    manuallyStoppedController.current = null;
    setSelection("");
    setSelectedConversation(null);
    setNewConversation(false);
    setPage(source.readPage || 1);
    pageRef.current = source.readPage || 1;
    pendingReadPage.current = null;
    savedReadPage.current = source.readPage || 1;
    setPdfNavigationRequest(0);
    setNativeSelectionPage(undefined);
    locatedReaderTarget.current = null;
    setPages(source.pageCount || 1);
    setZoom(100);
    setShowText(false);
    regionCaptureStartRef.current = null;
    setRegionCaptureStart(null);
    setRegionCapture(null);
    setSelectedIds([source.id]);
    setScope("document-notes");
    setInput("");
    setError("");
    setAnnotationDraft(null);
    setAnnotationNote("");
    setEditingAnnotationId(null);
    setEditingAnnotationNote("");
    setOutlineOpen(false);
    setSearchOpen(false);
    setSearch("");
    setSearchResult(null);
    clearReaderSearchHighlights();
    setFocusedCitation(null);
    setFocusedAnnotationId(null);
    setPlainSelectionAnchor(null);
    setCitationError("");
    setExpandedCitationKey(null);
    setSaveTargetMessageId(null);
    setKnowledgePageTargetId("");
    setExcerptKnowledgeTarget(null);
    setExcerptKnowledgePageTargetId("");
    setSourceActionsOpen(false);
    setRetainedPositionsOpen(false);
  }, [source.id, source.versionId, source.pageCount, source.readPage]);

  useEffect(() => {
    if (!sourceActionsOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!sourceActions.current?.contains(event.target as Node)) setSourceActionsOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [sourceActionsOpen]);

  useEffect(() => {
    if (historical) return;
    const id = source.id;
    const versionId = source.versionId;
    const timer = setTimeout(() => {
      if (
        document.visibilityState !== "hidden" &&
        !historicalRef.current &&
        sourceRef.current.id === id &&
        sourceRef.current.versionId === versionId
      )
        reportReading({});
    }, READING_OPEN_SETTLE_MS);
    return () => clearTimeout(timer);
    // Record an actually visible reading session once; refs keep stale source
    // instances from writing after navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id, source.versionId, historical]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushPendingReading();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      flushPendingReading();
    };
    // The handler intentionally reads current source/timer refs rather than
    // restarting whenever an unrelated reader prop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (
      !props.initialConversationId ||
      props.initialConversationId === consumedInitialConversationId.current ||
      !history.some((item) => item.id === props.initialConversationId)
    )
      return;
    consumedInitialConversationId.current = props.initialConversationId;
    setSelectedConversation(props.initialConversationId);
    setNewConversation(false);
    const initialConversation = history.find((item) => item.id === props.initialConversationId)!;
    // A route must reopen the saved range, just like choosing the same item
    // from the visible history. In particular, never silently widen a saved
    // selection into the default document-and-notes range.
    setScope(initialConversation.scope);
    setSelectedIds([...initialConversation.sourceIds]);
    setAiOpen(true);
    setMobileTab("ai");
  }, [history, props.initialConversationId]);

  useEffect(() => {
    const citation = initialCitation || pendingCitation.current;
    if (citation?.sourceId !== source.id || citation.versionId !== source.versionId) return;
    pendingCitation.current = null;
    const problem = citationProblem(citation, sources);
    // Apply an explicit navigation request after the parent has loaded its exact source.
    setFocusedCitation(citation);
    setCitationError(problem || "");
    setMobileTab(isPhoneReaderLayout() ? "citation" : "reading");
    if (!problem && citation.page) {
      pageRef.current = citation.page;
      setPage(citation.page);
      setPdfNavigationRequest((value) => value + 1);
    }
    if (initialCitation) onCitationConsumed?.();
  }, [source.id, source.versionId, sources, initialCitation, onCitationConsumed]);

  useEffect(() => {
    if (mobileTab !== "citation") return;
    // The citation page replaces the phone AI view. Move focus with it so a
    // keyboard user never remains on a control that has just been hidden.
    citationReturnButton.current?.focus();
  }, [mobileTab, focusedCitation]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const phone = window.matchMedia("(max-width: 620px)");
    const leavePhoneCitation = () => {
      if (!phone.matches) {
        setMobileTab((current) => (current === "citation" ? "reading" : current));
      }
    };
    phone.addEventListener?.("change", leavePhoneCitation);
    return () => phone.removeEventListener?.("change", leavePhoneCitation);
  }, []);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [messages.length, busy, answerDraft?.content]);

  useEffect(() => {
    const capture = () => {
      const browserSelection = window.getSelection();
      if (
        !browserSelection ||
        browserSelection.isCollapsed ||
        !textContainer.current ||
        !browserSelection.anchorNode ||
        !browserSelection.focusNode
      ) {
        setSelectionToolbar(null);
        return;
      }
      if (
        textContainer.current.contains(browserSelection.anchorNode) &&
        textContainer.current.contains(browserSelection.focusNode)
      ) {
        const text = browserSelection.toString().trim();
        if (!text) {
          setSelectionToolbar(null);
          return;
        }
        const selectedSource = sourceRef.current;
        const range = browserSelection.getRangeAt(0);
        const selectionElement =
          range.startContainer.nodeType === Node.ELEMENT_NODE
            ? (range.startContainer as Element)
            : range.startContainer.parentElement;
        const nativePdfSelection =
          selectedSource.kind === "pdf" && Boolean(selectionElement?.closest(".reader-pdf-text"));
        const selectedPhysicalPage = nativePdfSelection
          ? readNativePdfSelectionPage(selectedSource, range)
          : undefined;
        if (nativePdfSelection && selectedPhysicalPage === undefined) {
          setSelection("");
          setSelectionPresentation(null);
          setPlainSelectionAnchor(null);
          setNativeSelectionPage(undefined);
          setSelectionToolbar(null);
          setNotice("请在同一页已呈现的 PDF 文字中选择原文；跨页选段请分开保存。");
          return;
        }
        setNativeSelectionPage(selectedPhysicalPage);
        if (selectedSource.kind === "markdown" || selectedSource.kind === "web") {
          const mapped = readMarkdownSelection(selectedSource, browserSelection.getRangeAt(0));
          if (!mapped.ok || Array.from(mapped.rawQuote).length > 6000) {
            setSelection("");
            setSelectionPresentation(null);
            setSelectionToolbar(null);
            setNotice(mapped.ok ? "原文选段最多 6,000 个字符，请缩小选择范围。" : mapped.message);
            return;
          }
          setSelection(mapped.rawQuote);
          setSelectionPresentation({
            sourceId: selectedSource.id,
            versionId: selectedSource.versionId,
            rawQuote: mapped.rawQuote,
            visibleQuote: mapped.visibleQuote,
            chunkIds: mapped.chunkIds,
            rawStart: mapped.rawStart,
            rawEnd: mapped.rawEnd,
          });
          setPlainSelectionAnchor(null);
        } else {
          setSelectionPresentation(null);
          const mapped = readPlainAnnotationSelection(
            selectedSource,
            browserSelection.getRangeAt(0),
          );
          if (mapped && Array.from(mapped.quote).length <= 6000) {
            setSelection(mapped.quote);
            setPlainSelectionAnchor({
              sourceId: selectedSource.id,
              versionId: selectedSource.versionId,
              ...mapped,
            });
          } else {
            setPlainSelectionAnchor(null);
            setSelection(text.slice(0, 6000));
          }
        }
        setSelectionToolbar(selectionToolbarPosition(browserSelection.getRangeAt(0)));
      } else setSelectionToolbar(null);
    };
    document.addEventListener("selectionchange", capture);
    return () => document.removeEventListener("selectionchange", capture);
  }, []);

  useEffect(() => {
    const container = textContainer.current;
    if (!container) return;
    const highlightApi =
      typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
    const resolveAnnotation = annotationRangeResolver(container, source);
    const ranges = sourceAnnotations
      .filter(
        (item) => !item.page || item.page === page || showText || pdfReadingMode === "continuous",
      )
      .map(resolveAnnotation)
      .filter((item): item is Range => !!item);
    if (highlightApi) CSS.highlights.set("reader-annotation", new Highlight(...ranges));
    const focusedAnnotation = sourceAnnotations.find((item) => item.id === focusedAnnotationId);
    if (focusedAnnotation) {
      const range = resolveAnnotation(focusedAnnotation);
      if (range) {
        if (highlightApi) CSS.highlights.set("reader-citation", new Highlight(range));
        const target = `annotation:${focusedAnnotation.id}:${annotationFocusEpoch}:${pdfNavigationRequest}`;
        if (locatedReaderTarget.current !== target) {
          locatedReaderTarget.current = target;
          range.startContainer.parentElement?.scrollIntoView({
            block: "center",
            behavior: "smooth",
          });
        }
      } else if (source.kind !== "pdf" || showText || renderRevision > 0) {
        // PDF text is an external rendering result that only becomes verifiable after commit.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setNotice(
          "这条批注暂时无法准确定位原文；旧批注未记录位置或当前排版无法核对，请保留文字并对照原文。",
        );
      }
    }
    if (
      focusedCitation &&
      focusedCitation.sourceId === source.id &&
      focusedCitation.versionId === source.versionId &&
      !citationProblem(focusedCitation, sources)
    ) {
      const citationPage =
        focusedCitation.page ||
        source.chunks.find((chunk) => chunk.id === focusedCitation.chunkId)?.page ||
        page;
      const citationContainer =
        source.kind === "pdf" && !showText
          ? Array.from(
              container.querySelectorAll<HTMLElement>(".reader-pdf-text[data-reader-text='true']"),
            ).find(
              (body) =>
                body.dataset.readerSourceId === source.id &&
                body.dataset.readerSourceVersion === source.versionId &&
                Number(body.dataset.readerPage) === citationPage,
            )
          : container;
      const range = citationContainer
        ? findQuoteRange(citationContainer, markdownQuoteText(source, focusedCitation.quote))
        : null;
      if (range) {
        if (highlightApi) CSS.highlights.set("reader-citation", new Highlight(range));
        const target = `citation:${JSON.stringify(focusedCitation)}:${pdfNavigationRequest}`;
        if (locatedReaderTarget.current !== target) {
          locatedReaderTarget.current = target;
          range.startContainer.parentElement?.scrollIntoView({
            block: "center",
            behavior: "smooth",
          });
        }
        // The message reflects whether the external PDF/DOM rendering exposed the quote.
        setCitationError("");
      } else if (source.kind !== "pdf" || showText || renderRevision > 0) {
        setCitationError(
          "已打开引用所属资料。页面排版与解析文字不同，暂未精确定位，请对照下方原文摘录。",
        );
      }
    }
    return () => {
      if (highlightApi) {
        CSS.highlights.delete("reader-annotation");
        CSS.highlights.delete("reader-citation");
      }
    };
    // DOM ranges are refreshed after PDF.js renders and whenever a saved annotation changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    source.id,
    source.versionId,
    source.kind,
    source.text,
    source.chunks,
    docxBlocks,
    focusedCitation,
    focusedAnnotationId,
    annotationFocusEpoch,
    page,
    pdfReadingMode,
    pdfNavigationRequest,
    showText,
    renderRevision,
    annotations,
  ]);

  function changePage(value: number, preserveCitation = false) {
    setFocusedAnnotationId(null);
    if (!preserveCitation) {
      setFocusedCitation(null);
      setCitationError("");
    }
    locatedReaderTarget.current = null;
    const next = Math.max(1, Math.min(value || 1, pages));
    clearSearchResults();
    pageRef.current = next;
    setPage(next);
    setPdfNavigationRequest((current) => current + 1);
    setSelection("");
    setNativeSelectionPage(undefined);
    setSelectionToolbar(null);
    cancelRegionCapture();
    reportReading(
      {
        ...(pendingReadOffset.current === null ? {} : { readOffset: pendingReadOffset.current }),
        readPage: next,
      },
      true,
    );
  }

  /** Save actual reading activity separately from metadata changes. */
  function reportPendingReading(pending: boolean) {
    if (pendingReadingReported.current === pending) return;
    pendingReadingReported.current = pending;
    pendingReadingCallback.current?.(pending);
  }

  function reportReading(
    patch: Pick<Partial<Source>, "readPage" | "readOffset">,
    forceTimestamp = false,
  ) {
    if (historicalRef.current) return;
    const now = new Date();
    const current = now.getTime();
    if (!forceTimestamp && current - lastReadReportedAt.current < READING_ACTIVITY_THROTTLE_MS)
      return;
    const storedActivityAt = Math.max(current, savedReadingActivityAt.current);
    lastReadReportedAt.current = current;
    savedReadingActivityAt.current = storedActivityAt;
    if (patch.readOffset !== undefined) {
      savedReadOffset.current = patch.readOffset;
      pendingReadOffset.current = null;
      if (readingSyncTimer.current) clearTimeout(readingSyncTimer.current);
      readingSyncTimer.current = null;
    }
    if (patch.readPage !== undefined) {
      savedReadPage.current = patch.readPage;
      pendingReadPage.current = null;
      if (readingSyncTimer.current) clearTimeout(readingSyncTimer.current);
      readingSyncTimer.current = null;
    }
    onSourceChange({ ...patch, lastReadAt: new Date(storedActivityAt).toISOString() });
    if (
      pendingReadOffset.current === null &&
      pendingReadPage.current === null &&
      progressTimer.current === null
    )
      reportPendingReading(false);
  }

  function syncPendingReading() {
    if (
      historicalRef.current ||
      (pendingReadOffset.current === null && pendingReadPage.current === null)
    )
      return;
    const current = new Date().getTime();
    const wait = Math.max(0, lastReadReportedAt.current + READING_ACTIVITY_THROTTLE_MS - current);
    if (wait > 0) {
      if (!readingSyncTimer.current) {
        readingSyncTimer.current = setTimeout(() => {
          readingSyncTimer.current = null;
          if (
            !historicalRef.current &&
            ((pendingReadOffset.current !== null &&
              Math.abs(savedReadOffset.current - pendingReadOffset.current) > 8) ||
              (pendingReadPage.current !== null &&
                savedReadPage.current !== pendingReadPage.current))
          )
            syncPendingReading();
          else {
            pendingReadOffset.current = null;
            pendingReadPage.current = null;
            reportPendingReading(false);
          }
        }, wait);
      }
      return;
    }
    const patch = pendingReadingPatch();
    if (Object.keys(patch).length) reportReading(patch);
    else {
      pendingReadOffset.current = null;
      pendingReadPage.current = null;
      reportPendingReading(false);
    }
  }

  function flushPendingReading() {
    if (historicalRef.current) return;
    const patch = pendingReadingPatch();
    if (Object.keys(patch).length) reportReading(patch, true);
    else {
      pendingReadOffset.current = null;
      pendingReadPage.current = null;
      reportPendingReading(false);
    }
  }

  function pendingReadingPatch(): Pick<Partial<Source>, "readPage" | "readOffset"> {
    const offset = pendingReadOffset.current;
    const nextPage = pendingReadPage.current;
    return {
      ...(offset !== null && Math.abs(savedReadOffset.current - offset) > 8
        ? { readOffset: offset }
        : {}),
      ...(nextPage !== null && savedReadPage.current !== nextPage ? { readPage: nextPage } : {}),
    };
  }

  function trackVisiblePdfPage(value: number) {
    if (source.kind !== "pdf" || showText || pdfReadingMode !== "continuous") return;
    if (!Number.isFinite(value)) return;
    if (sourceRef.current.id !== source.id || sourceRef.current.versionId !== source.versionId)
      return;
    const next = Math.max(1, Math.min(Math.round(value) || 1, pages));
    if (next === pageRef.current) return;
    pageRef.current = next;
    setPage(next);
    clearSearchResults();
    cancelRegionCapture();
    if (historicalRef.current) return;
    pendingReadPage.current = next === savedReadPage.current ? null : next;
    if (progressTimer.current) clearTimeout(progressTimer.current);
    progressTimer.current = null;
    if (pendingReadPage.current === null) {
      if (readingSyncTimer.current) clearTimeout(readingSyncTimer.current);
      readingSyncTimer.current = null;
      reportPendingReading(false);
      return;
    }
    reportPendingReading(true);
    progressTimer.current = setTimeout(() => {
      progressTimer.current = null;
      if (sourceRef.current.id === source.id && sourceRef.current.versionId === source.versionId)
        syncPendingReading();
    }, 400);
  }

  function closeRetainedPositions() {
    setRetainedPositionsOpen(false);
    requestAnimationFrame(() => sourceActionsToggle.current?.focus());
  }

  function chooseRetainedPosition(selectedIndex: number) {
    if (historicalRef.current) return;
    const patch = selectReadingPositionAlternative(sourceRef.current, selectedIndex);

    if (progressTimer.current) clearTimeout(progressTimer.current);
    progressTimer.current = null;
    if (readingSyncTimer.current) clearTimeout(readingSyncTimer.current);
    readingSyncTimer.current = null;
    pendingReadOffset.current = null;
    pendingReadPage.current = null;
    if (readingPositionApplyFrame.current !== null)
      cancelAnimationFrame(readingPositionApplyFrame.current);

    sourceRef.current = { ...sourceRef.current, ...patch };
    savedReadOffset.current = patch.readOffset || 0;
    savedReadPage.current = patch.readPage || 1;
    const saved = Date.parse(patch.lastReadAt || "");
    const now = new Date().getTime();
    savedReadingActivityAt.current = Number.isFinite(saved) ? saved : 0;
    lastReadReportedAt.current = Number.isFinite(saved) && saved <= now ? saved : 0;
    clearSearchResults();
    setSelection("");
    setSelectionToolbar(null);
    setFocusedCitation(null);
    setFocusedAnnotationId(null);
    locatedReaderTarget.current = null;
    if (source.kind === "pdf") {
      const next = Math.max(
        1,
        Math.min(patch.readPage || 1, Math.max(1, source.pageCount || pages)),
      );
      pageRef.current = next;
      setPage(next);
      setPdfNavigationRequest((value) => value + 1);
    }
    setRetainedPositionsOpen(false);
    onSourceChange(patch);
    reportPendingReading(false);

    readingPositionApplyFrame.current = requestAnimationFrame(() => {
      readingPositionApplyFrame.current = null;
      if (textContainer.current && (source.kind !== "pdf" || showText))
        textContainer.current.scrollTop = patch.readOffset || 0;
      sourceActionsToggle.current?.focus();
    });
  }

  function saveReadingPosition() {
    setSelectionToolbar(null);
    if (historical || (source.kind === "pdf" && !showText) || !textContainer.current) return;
    if (progressTimer.current) clearTimeout(progressTimer.current);
    progressTimer.current = null;
    const offset = Math.round(textContainer.current.scrollTop);
    if (readingSyncTimer.current) clearTimeout(readingSyncTimer.current);
    readingSyncTimer.current = null;
    if (Math.abs(savedReadOffset.current - offset) <= 8) {
      pendingReadOffset.current = null;
      reportPendingReading(false);
      return;
    }
    pendingReadOffset.current = offset;
    reportPendingReading(true);
    const id = source.id;
    const versionId = source.versionId;
    progressTimer.current = setTimeout(() => {
      progressTimer.current = null;
      if (
        !historicalRef.current &&
        sourceRef.current.id === id &&
        sourceRef.current.versionId === versionId &&
        Math.abs(savedReadOffset.current - offset) > 8
      ) {
        pendingReadOffset.current = offset;
        syncPendingReading();
      } else {
        pendingReadOffset.current = null;
        reportPendingReading(false);
      }
    }, 400);
  }

  function isCompactReaderLayout() {
    return typeof window !== "undefined" && window.matchMedia("(max-width: 1024px)").matches;
  }

  function isWideReaderLayout() {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(min-width: 1025px)").matches
    );
  }

  const syncAiPanelWidthLimit = useCallback(() => {
    const wide =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(min-width: 1025px)").matches;
    const maximum = wide
      ? maxAiPanelWidthForWorkspace(readerWorkspace.current?.clientWidth)
      : AI_PANEL_MAX_WIDTH;
    const preferred = defaultAiPanelWidthForViewport(
      typeof window === "undefined" ? null : window.innerWidth,
    );
    const requestedWidth = aiPanelWidthCustomizedRef.current
      ? aiPanelPreferredWidthRef.current
      : preferred;
    const nextWidth = clampAiPanelWidth(requestedWidth, maximum);
    aiPanelWidthLimitRef.current = maximum;
    setAiPanelWidthLimit((current) => (current === maximum ? current : maximum));
    if (aiPanelWidthRef.current !== nextWidth) {
      aiPanelWidthRef.current = nextWidth;
      setAiPanelWidth((current) => (current === nextWidth ? current : nextWidth));
    }
  }, []);

  useEffect(() => {
    syncAiPanelWidthLimit();
    const workspace = readerWorkspace.current;
    const observer =
      workspace && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(syncAiPanelWidthLimit)
        : null;
    if (workspace && observer) observer.observe(workspace);
    window.addEventListener("resize", syncAiPanelWidthLimit);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", syncAiPanelWidthLimit);
    };
  }, [syncAiPanelWidthLimit]);

  function updateAiPanelWidth(nextWidth: number, customized = true) {
    const preferred = clampAiPanelWidth(nextWidth, AI_PANEL_MAX_WIDTH);
    const clamped = clampAiPanelWidth(preferred, aiPanelWidthLimitRef.current);
    aiPanelWidthCustomizedRef.current = customized;
    aiPanelPreferredWidthRef.current = preferred;
    aiPanelWidthRef.current = clamped;
    setAiPanelWidth((current) => (current === clamped ? current : clamped));
  }

  function resetAiPanelWidth() {
    updateAiPanelWidth(
      defaultAiPanelWidthForViewport(typeof window === "undefined" ? null : window.innerWidth),
      false,
    );
  }

  function startAiPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!isWideReaderLayout() || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    aiPanelResizePointer.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: aiPanelWidthRef.current,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setAiPanelResizing(true);
  }

  function moveAiPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    const activeResize = aiPanelResizePointer.current;
    if (!activeResize || activeResize.pointerId !== event.pointerId) return;
    event.preventDefault();
    // The AI panel is anchored to the right edge: pulling the separator left
    // makes the panel wider, while pulling it right returns room to the document.
    updateAiPanelWidth(activeResize.startWidth - (event.clientX - activeResize.startX));
  }

  function finishAiPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    const activeResize = aiPanelResizePointer.current;
    if (!activeResize || activeResize.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    aiPanelResizePointer.current = null;
    setAiPanelResizing(false);
  }

  function handleAiPanelResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!isWideReaderLayout()) return;
    const step = event.shiftKey ? AI_PANEL_KEYBOARD_STEP * 2 : AI_PANEL_KEYBOARD_STEP;
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = aiPanelWidthRef.current + step;
    if (event.key === "ArrowRight") nextWidth = aiPanelWidthRef.current - step;
    if (event.key === "Home") nextWidth = AI_PANEL_MIN_WIDTH;
    if (event.key === "End") nextWidth = aiPanelWidthLimitRef.current;
    if (nextWidth === null) return;
    event.preventDefault();
    updateAiPanelWidth(nextWidth);
  }

  function isPhoneReaderLayout() {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 620px)").matches
    );
  }

  function openAiPanel() {
    setAiOpen(true);
    setMobileTab("ai");
  }

  function focusAiInput() {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => questionInput.current?.focus());
      return;
    }
    questionInput.current?.focus();
  }

  function prepareFollowUp(question: string) {
    setInput(question);
    openAiPanel();
    focusAiInput();
  }

  function closeAiPanel() {
    setMobileTab("reading");
    // Compact layouts keep the panel mounted behind the reader. This preserves
    // the current draft and scroll position when a learner returns to it.
    if (!isCompactReaderLayout()) setAiOpen(false);
  }

  function openCitation(citation: Citation) {
    setFocusedAnnotationId(null);
    const problem = citationProblem(citation, sources);
    const phoneLayout = isPhoneReaderLayout();
    setFocusedCitation(citation);
    setCitationError(problem || "");
    if (problem) {
      if (phoneLayout) setMobileTab("citation");
      return;
    }
    // A phone citation is a temporary page over the current reader. Keeping
    // the original source mounted is what makes "返回回答" return to the exact
    // answer, draft and scope that opened the citation — including when the
    // evidence itself belongs to another source.
    if (phoneLayout) {
      if (
        citation.sourceId === source.id &&
        citation.versionId === source.versionId &&
        citation.page
      )
        changePage(citation.page, true);
      setMobileTab("citation");
      return;
    }
    // On tablet layouts the AI panel is a temporary overlay. Moving to a
    // citation returns the visible reader to the cited passage.
    if (citation.sourceId !== source.id || citation.versionId !== source.versionId) {
      pendingCitation.current = citation;
      onOpenSource(citation.sourceId, citation.versionId, citation);
      return;
    }
    if (citation.page) changePage(citation.page, true);
    setMobileTab(phoneLayout ? "citation" : "reading");
  }

  function openCitationSource() {
    if (!focusedCitation) return;
    if (focusedCitation.sourceId !== source.id || focusedCitation.versionId !== source.versionId) {
      onOpenSource(focusedCitation.sourceId, focusedCitation.versionId, focusedCitation);
      return;
    }
    if (focusedCitation.page) changePage(focusedCitation.page, true);
    setMobileTab("reading");
  }

  function selectionCitations(): Citation[] {
    const selectedPage =
      source.kind === "pdf" && !showText ? (nativeSelectionPage ?? page) : undefined;
    const chunks = currentSelectionPresentation
      ? currentSelectionPresentation.chunkIds.flatMap((id) => {
          const chunk = source.chunks.find(
            (item) =>
              item.id === id && item.sourceId === source.id && item.versionId === source.versionId,
          );
          return chunk && source.text.includes(chunk.text) ? [chunk] : [];
        })
      : [
          source.chunks.find(
            (item) =>
              (selectedPage === undefined || item.page === selectedPage) &&
              quoteOffsets(item.text, selection.slice(0, 60)),
          ) || (selectedPage === undefined ? source.chunks[0] : undefined),
        ].filter((chunk): chunk is Source["chunks"][number] => !!chunk);
    return chunks.map((chunk) => ({
      sourceId: source.id,
      versionId: source.versionId,
      chunkId: chunk.id,
      title: source.title,
      quote: chunk.text,
      page: selectedPage ?? chunk.page,
      section: chunk.section,
    }));
  }

  /**
   * Pin a manual excerpt to the exact visible chunk whenever the reader can
   * identify one. PDF selections also carry their current page as an
   * independent constraint, so repeated sentences never silently cite a
   * different page.
   */
  function excerptAnchor(
    quote: string,
  ): Pick<ExcerptKnowledgeTarget, "anchorChunkId" | "anchorPage"> {
    if (
      currentSelectionPresentation?.rawQuote === quote &&
      currentSelectionPresentation.chunkIds.length === 1
    )
      return { anchorChunkId: currentSelectionPresentation.chunkIds[0] };
    const compact = quote.replace(/\s/gu, "");
    const nativePdfPage = source.kind === "pdf" && !showText;
    const selectedPage = nativeSelectionPage ?? page;
    const matches = source.chunks.filter(
      (chunk) =>
        chunk.sourceId === source.id &&
        chunk.versionId === source.versionId &&
        source.text.includes(chunk.text) &&
        chunk.text.replace(/\s/gu, "").includes(compact) &&
        (!nativePdfPage || chunk.page === selectedPage),
    );
    if (matches.length === 1)
      return {
        anchorChunkId: matches[0]!.id,
        ...(nativePdfPage ? { anchorPage: selectedPage } : {}),
      };
    return nativePdfPage ? { anchorPage: selectedPage } : {};
  }

  function saveSelection(kind: "note" | "knowledge") {
    const citations = selectionCitations();
    if (!selection || !citations.length) {
      setNotice("请先从已解析的原文中选择一段文字。");
      return;
    }
    onSaveNote(`> ${selection.replace(/\n/g, "\n> ")}\n\n`, citations, kind);
    setNotice(kind === "knowledge" ? "已保存为知识页草稿，待你审阅。" : "已保存为笔记。");
  }

  function closeExcerptKnowledgeTarget() {
    setExcerptKnowledgeTarget(null);
    setExcerptKnowledgePageTargetId("");
    requestAnimationFrame(() => excerptSaveTrigger.current?.focus());
  }

  function openExcerptKnowledgeTarget() {
    if (historical) {
      setNotice("历史版本可保存独立笔记，不能追加到当前知识页。");
      return;
    }
    if (!onSaveExcerptToKnowledgePage) {
      setNotice("当前页面无法保存原文摘录到知识页，请刷新后重试。");
      return;
    }
    const quote = selection.trim();
    if (!quote) {
      setNotice("请先从已解析的原文中选择一段文字。");
      return;
    }
    setExcerptKnowledgeTarget({
      quote,
      sourceId: source.id,
      versionId: source.versionId,
      ...excerptAnchor(quote),
    });
    setExcerptKnowledgePageTargetId("");
  }

  function saveExcerptToKnowledgePage(noteId?: string) {
    if (!excerptKnowledgeTarget || !onSaveExcerptToKnowledgePage) return;
    try {
      const title = onSaveExcerptToKnowledgePage({
        noteId,
        spaceId: space.id,
        sourceId: excerptKnowledgeTarget.sourceId,
        versionId: excerptKnowledgeTarget.versionId,
        quote: excerptKnowledgeTarget.quote,
        ...(excerptKnowledgeTarget.anchorChunkId
          ? { anchorChunkId: excerptKnowledgeTarget.anchorChunkId }
          : {}),
        ...(excerptKnowledgeTarget.anchorPage !== undefined
          ? { anchorPage: excerptKnowledgeTarget.anchorPage }
          : {}),
      });
      const action = noteId ? "已追加到" : "已新建";
      setNotice(`${action}“${title || "未命名知识页"}”，原文摘录与版本依据已保留，待你审阅。`);
      setExcerptKnowledgeTarget(null);
      setExcerptKnowledgePageTargetId("");
      setSelection("");
      setSelectionToolbar(null);
      window.getSelection()?.removeAllRanges();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "暂时无法保存原文摘录，请稍后重试。");
    }
  }

  function openKnowledgeSaveTarget(messageId: string) {
    setSaveTargetMessageId((current) => {
      const next = current === messageId ? null : messageId;
      if (next) setKnowledgePageTargetId("");
      return next;
    });
  }

  function appendAnswerToKnowledgePage(message: Message) {
    if (!onAppendToKnowledgePage) {
      setNotice("当前页面无法保存到既有知识页，请刷新后重试。");
      return;
    }
    if (!knowledgePageTargetId) {
      setNotice("请先选择一个知识页。");
      return;
    }
    try {
      const title = onAppendToKnowledgePage({
        noteId: knowledgePageTargetId,
        content: message.content,
        citations: message.citations,
        mode: message.mode ?? "model",
      });
      setSaveTargetMessageId(null);
      setKnowledgePageTargetId("");
      setNotice(`已追加到“${title || "未命名知识页"}”，原文依据和历史版本已保留，待你审阅。`);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "暂时无法保存到知识页，请稍后重试。");
    }
  }

  function highlightSelection() {
    if (historical || !selection) return;
    const textAnchor = currentSelectionPresentation
      ? { start: currentSelectionPresentation.rawStart, end: currentSelectionPresentation.rawEnd }
      : plainSelectionAnchor?.sourceId === source.id &&
          plainSelectionAnchor.versionId === source.versionId &&
          plainSelectionAnchor.quote === selection
        ? plainSelectionAnchor.textAnchor
        : undefined;
    if (!textAnchor) {
      setNotice("当前选段暂时无法准确保存原文位置，请重新选段，或切换到解析文本后重试。");
      return;
    }
    setAnnotationDraft({
      quote: selection,
      page: source.kind === "pdf" && !showText ? (nativeSelectionPage ?? page) : undefined,
      textAnchor: { ...textAnchor },
    });
    setAnnotationNote("");
    setAnnotationOpen(true);
  }

  async function copySelection() {
    if (!selection) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("当前浏览器不支持自动复制。");
      await navigator.clipboard.writeText(selectionDisplay);
      setNotice("已复制选段。");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "复制失败，请手动复制选段。");
    }
  }

  function saveAnnotation() {
    if (historical || !annotationDraft) return;
    try {
      const annotation = createAnnotation(
        {
          id: crypto.randomUUID(),
          sourceId: source.id,
          versionId: source.versionId,
          quote: annotationDraft.quote,
          note: annotationNote,
          page: annotationDraft.page,
          textAnchor: annotationDraft.textAnchor,
          createdAt: new Date().toISOString(),
        },
        source,
      );
      onAnnotationAdd(annotation);
      setAnnotationDraft(null);
      setAnnotationNote("");
      setNotice(annotation.note ? "批注已保存。" : "高亮已保存，可在“我的标注”中回看。");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "保存批注失败，请稍后重试。");
    }
  }

  function beginAnnotationEdit(annotation: Annotation) {
    if (historical || !onAnnotationUpdate) return;
    setEditingAnnotationId(annotation.id);
    setEditingAnnotationNote(annotation.note);
  }

  function saveAnnotationEdit(annotation: Annotation) {
    if (historical || !onAnnotationUpdate) return;
    try {
      onAnnotationUpdate(updateAnnotation(annotation, editingAnnotationNote, source));
      setEditingAnnotationId(null);
      setEditingAnnotationNote("");
      setNotice("批注已更新。");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "更新批注失败，请稍后重试。");
    }
  }

  function deleteAnnotation(annotation: Annotation) {
    if (historical || !onAnnotationDelete) return;
    try {
      assertAnnotationSource(annotation, source);
      onAnnotationDelete(annotation);
      if (editingAnnotationId === annotation.id) {
        setEditingAnnotationId(null);
        setEditingAnnotationNote("");
      }
      setNotice("批注已删除。");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "删除批注失败，请稍后重试。");
    }
  }

  async function download() {
    try {
      const blob = await getSourceBlob(source);
      if (!blob) {
        setNotice("原文件在当前设备不可用，请检查连接后重试。");
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = source.filename || `${source.title}.txt`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "下载失败，请稍后重试。");
    }
  }

  async function ask(options: { question?: string; retryAttempt?: AnswerAttempt } = {}) {
    if (historical) {
      setError("历史版本仅供阅读与摘录，请回到当前版本发起新问题。");
      return;
    }
    const retryAttempt = options.retryAttempt;
    const retryQuestion = retryAttempt
      ? messages.find(
          (message) => message.id === retryAttempt.questionMessageId && message.role === "user",
        )
      : undefined;
    if (retryAttempt && !retryQuestion) {
      setError("原问题已不可用，无法安全重试。你可以重新编辑问题后再试。");
      return;
    }
    const question = (retryQuestion?.content ?? options.question ?? input).trim();
    if (!question || busy || controller.current) return;
    const scopeSnapshot = retryAttempt
      ? {
          ...retryAttempt.scopeSnapshot,
          sourceIds: [...retryAttempt.scopeSnapshot.sourceIds],
          ...(retryAttempt.scopeSnapshot.sourceVersions
            ? {
                sourceVersions: retryAttempt.scopeSnapshot.sourceVersions.map((reference) => ({
                  ...reference,
                })),
              }
            : {}),
          ...(retryAttempt.scopeSnapshot.comparison
            ? { comparison: { ...retryAttempt.scopeSnapshot.comparison } }
            : {}),
          ...(retryAttempt.scopeSnapshot.userContext
            ? { userContext: [...retryAttempt.scopeSnapshot.userContext] }
            : {}),
        }
      : null;
    const requestedScope = scopeSnapshot?.scope ?? scope;
    const requestedSpaceId = scopeSnapshot?.spaceId ?? space.id;
    const requestedSourceId = scopeSnapshot?.sourceId;
    const requestedSelection = scopeSnapshot?.selection ?? selection;
    const singleSourceScope =
      requestedScope === "selection" ||
      requestedScope === "document" ||
      requestedScope === "document-notes";
    if (requestedSpaceId !== space.id) {
      setError("原问题所在的学习空间已变化，无法在新的范围中自动重试。请重新编辑问题。");
      return;
    }
    if (!aiEnabled) {
      setError("资料问答已关闭，请先在设置中开启。");
      return;
    }
    if (singleSourceScope && scopeSnapshot && requestedSourceId !== source.id) {
      setError("原问题对应的资料已变化，无法在当前阅读页自动重试。请重新编辑问题。");
      return;
    }
    if (singleSourceScope && !source.aiAllowed) {
      setError("这份资料未允许用于 AI，请先开启资料的使用权限。");
      return;
    }
    if (requestedScope === "selection" && !requestedSelection) {
      setError("请先在阅读区选择要讨论的段落。");
      return;
    }
    if (
      requestedScope === "sources" &&
      !(scopeSnapshot?.sourceIds ?? selectedIds).some((id) =>
        availableSources.some((item) => item.id === id),
      )
    ) {
      setError("请至少选择一份当前空间的资料。");
      return;
    }
    if (requestedScope === "sources" && (scopeSnapshot?.sourceIds ?? selectedIds).length > 100) {
      setError("单次最多指定 100 份资料；如需在整个知识库中提问，请选择当前学习空间。");
      return;
    }
    const now = new Date().toISOString();
    const ids =
      scopeSnapshot?.sourceIds ??
      (requestedScope === "space"
        ? availableSources.map((item) => item.id)
        : requestedScope === "sources"
          ? selectedIds.filter((id) => availableSources.some((item) => item.id === id))
          : [source.id]);
    const requestedSources =
      requestedScope === "space"
        ? availableSources
        : requestedScope === "sources"
          ? availableSources.filter((item) => ids.includes(item.id))
          : [source];
    if (singleSourceScope && !availableSources.some((item) => item.id === source.id)) {
      setError("这份资料已不在当前学习空间，请重新打开资料后再提问。");
      return;
    }
    const requestedAvailability = answerScopeAvailability(requestedSources);
    if (requestedAvailability.blockedMessage) {
      setError(
        requestedAvailability.blockedMessage === askEligibilityMessage
          ? ""
          : requestedAvailability.blockedMessage,
      );
      return;
    }
    let actualSourceIds = ids;
    let currentSourceVersions: AnswerScopeSnapshot["sourceVersions"];
    if (singleSourceScope) {
      if (scopeSnapshot) {
        const frozen = scopeSnapshot.sourceVersions;
        const frozenReference = frozen?.[0];
        const invalidFrozenSource =
          !frozen ||
          frozen.length !== 1 ||
          scopeSnapshot.sourceIds.length !== 1 ||
          scopeSnapshot.sourceIds[0] !== source.id ||
          frozenReference?.sourceId !== source.id ||
          frozenReference?.versionId !== source.versionId ||
          !isSourceAnswerEligible(source);
        if (invalidFrozenSource) {
          setError(
            "原问题的资料版本、归属或 AI 使用状态已经变化，无法按原范围自动重试。请重新编辑问题并确认资料。",
          );
          return;
        }
        actualSourceIds = [source.id];
        currentSourceVersions = [
          { sourceId: frozenReference!.sourceId, versionId: frozenReference!.versionId },
        ];
      } else {
        actualSourceIds = [source.id];
        currentSourceVersions = [{ sourceId: source.id, versionId: source.versionId }];
      }
    } else if (requestedScope === "sources") {
      if (scopeSnapshot) {
        const frozen = scopeSnapshot.sourceVersions;
        const frozenIds = scopeSnapshot.sourceIds;
        const versions = new Map(frozen?.map((item) => [item.sourceId, item.versionId]));
        const invalidFrozenRange =
          !frozen ||
          new Set(frozenIds).size !== frozenIds.length ||
          versions.size !== frozenIds.length ||
          frozenIds.some((id) => {
            const current = requestedSources.find((item) => item.id === id);
            return (
              !current || !isSourceAnswerEligible(current) || versions.get(id) !== current.versionId
            );
          });
        if (invalidFrozenRange) {
          setError(
            "原问题的资料版本、归属或 AI 使用状态已经变化，无法按原范围自动重试。请重新编辑问题并确认资料。",
          );
          return;
        }
        actualSourceIds = [...frozenIds];
        currentSourceVersions = frozen.map((item) => ({ ...item }));
      } else {
        const answerReadySources = requestedSources.filter(isSourceAnswerEligible);
        actualSourceIds = answerReadySources.map((item) => item.id);
        currentSourceVersions = answerReadySources.map((item) => ({
          sourceId: item.id,
          versionId: item.versionId,
        }));
      }
    }
    // Assistant messages are deliberately excluded. They can contain stale,
    // revoked or incomplete material; only prior user questions help the next
    // query resolve what its follow-up refers to.
    const userContext =
      scopeSnapshot?.userContext ?? priorUserQuestions(conversation?.messages || []);
    const requestSnapshot: AnswerScopeSnapshot = scopeSnapshot ?? {
      scope: requestedScope,
      ...(requestedScope === "selection" ||
      requestedScope === "document" ||
      requestedScope === "document-notes"
        ? { sourceId: source.id }
        : {}),
      sourceIds: [...actualSourceIds],
      ...(currentSourceVersions ? { sourceVersions: currentSourceVersions } : {}),
      spaceId: requestedSpaceId,
      ...(requestedScope === "selection" ? { selection: requestedSelection } : {}),
      ...(userContext.length ? { userContext: [...userContext] } : {}),
    };
    const questionMessage: Message = retryQuestion ?? {
      id: crypto.randomUUID(),
      role: "user",
      content: question,
      citations: [],
      createdAt: now,
    };
    const next: Conversation = {
      ...(conversation || {
        id: crypto.randomUUID(),
        spaceId: space.id,
        sourceId: source.id,
        title: question.slice(0, 40),
        messages: [],
        resolved: false,
      }),
      scope: requestedScope,
      sourceIds: [...requestSnapshot.sourceIds],
      messages: retryQuestion
        ? [...(conversation?.messages || [])]
        : [...(conversation?.messages || []), questionMessage],
      updatedAt: now,
    };
    onConversationChange(next);
    setSelectedConversation(next.id);
    setNewConversation(false);
    if (!retryQuestion) setInput("");
    setError("");
    replaceAnswerDraft(null);
    setAnswerPhase("retrieving");
    setBusy(true);
    setStoppingAnswer(false);
    manuallyStoppedController.current = null;
    setAiOpen(true);
    setMobileTab("ai");
    const requestController = new AbortController();
    controller.current = requestController;
    const attempt: AnswerAttempt = {
      id: crypto.randomUUID(),
      questionMessageId: questionMessage.id,
      scopeSnapshot: requestSnapshot,
      status: "completed",
    };
    try {
      const answer = await onAsk(
        {
          requestId: attempt.id,
          question,
          ...(userContext.length ? { userContext } : {}),
          scope: requestSnapshot.scope,
          sourceId:
            requestSnapshot.scope === "selection" ||
            requestSnapshot.scope === "document" ||
            requestSnapshot.scope === "document-notes"
              ? requestSnapshot.sourceId
              : undefined,
          sourceIds: requestSnapshot.scope === "sources" ? requestSnapshot.sourceIds : [],
          ...(requestSnapshot.sourceVersions
            ? {
                sourceVersions: requestSnapshot.sourceVersions.map((reference) => ({
                  ...reference,
                })),
              }
            : {}),
          ...(requestSnapshot.comparison ? { comparison: { ...requestSnapshot.comparison } } : {}),
          spaceId: requestSnapshot.spaceId,
          selection: requestSnapshot.scope === "selection" ? requestSnapshot.selection : undefined,
        },
        requestController.signal,
        (event) => {
          if (
            requestController.signal.aborted ||
            controller.current !== requestController ||
            activeSourceId.current !== `${source.id}:${source.versionId}`
          )
            return;
          if (event.type === "draft") replaceAnswerDraft(event.answer);
          else setAnswerPhase(event.phase);
        },
      );
      if (requestController.signal.aborted) throw new DOMException("已停止", "AbortError");
      const response: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: answer.content,
        citations: answer.citations,
        ...(answer.noteEvidence?.length ? { noteEvidence: answer.noteEvidence } : {}),
        mode: answer.mode,
        attempt,
        createdAt: new Date().toISOString(),
      };
      onConversationChange({
        ...next,
        messages: [...next.messages, response],
        updatedAt: response.createdAt,
      });
    } catch (cause) {
      const stoppedByUser = manuallyStoppedController.current === requestController;
      const partial =
        stoppedByUser && answerDraftRef.current?.content.trim() ? answerDraftRef.current : null;
      const message = stoppedByUser
        ? partial
          ? "已停止生成，以上内容尚未完成或核验。"
          : "回答已停止，问题已保留。"
        : cause instanceof Error
          ? cause.message
          : "暂时无法回答，请稍后重试。";
      const response: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: partial?.content ?? "",
        citations: partial?.citations ?? [],
        ...(partial?.noteEvidence?.length ? { noteEvidence: partial.noteEvidence } : {}),
        ...(partial ? { mode: partial.mode } : {}),
        attempt: { ...attempt, status: stoppedByUser ? "stopped" : "failed" },
        error: message,
        createdAt: new Date().toISOString(),
      };
      onConversationChange({
        ...next,
        messages: [...next.messages, response],
        updatedAt: response.createdAt,
      });
      if (activeSourceId.current === `${source.id}:${source.versionId}`) setError(message);
    } finally {
      if (controller.current === requestController) {
        controller.current = null;
        setBusy(false);
        replaceAnswerDraft(null);
        setStoppingAnswer(false);
        if (manuallyStoppedController.current === requestController)
          manuallyStoppedController.current = null;
      }
    }
  }

  function clearSearchResults() {
    clearReaderSearchHighlights();
    setSearchResult(null);
  }

  function visibleReaderTool(selector: string, fallback: HTMLButtonElement | null) {
    const candidates = readerWorkspace.current?.querySelectorAll<HTMLButtonElement>(selector) || [];
    return [...candidates].find((button) => button.getClientRects().length > 0) || fallback;
  }

  function closeDocumentSearch() {
    clearSearchResults();
    setSearchOpen(false);
    visibleReaderTool("[data-reader-search-trigger]", searchToggle.current)?.focus();
  }

  function toggleDocumentSearch(trigger: HTMLButtonElement) {
    searchToggle.current = trigger;
    if (searchOpen) closeDocumentSearch();
    else setSearchOpen(true);
  }

  function toggleOutline(trigger: HTMLButtonElement) {
    outlineToggle.current = trigger;
    setOutlineOpen((current) => !current);
  }

  function closeOutline() {
    setOutlineOpen(false);
    visibleReaderTool("[data-reader-outline-trigger]", outlineToggle.current)?.focus();
  }

  function findInDocument(direction: 1 | -1 = 1) {
    const query = search.trim();
    const container = textContainer.current;
    if (!query || !container) return;
    const root =
      source.kind === "pdf" && !showText && pdfReadingMode === "continuous"
        ? Array.from(
            container.querySelectorAll<HTMLElement>(".reader-pdf-text[data-reader-text='true']"),
          ).find(
            (body) =>
              body.dataset.readerSourceId === source.id &&
              body.dataset.readerSourceVersion === source.versionId &&
              Number(body.dataset.readerPage) === page,
          )
        : readerSearchRoot(container);
    if (!root) {
      clearSearchResults();
      setNotice("当前页文字尚未呈现，请稍后再查找，或切换到解析文本搜索全文。");
      return;
    }
    const ranges = findReaderSearchRanges(root, query);
    if (!ranges.length) {
      clearReaderSearchHighlights();
      setSearchResult({ query, count: 0, index: -1 });
      setNotice(
        source.kind === "pdf" && !showText
          ? "当前页没有找到该文字。可切换至解析文本搜索全文。"
          : "原文中没有找到该文字。",
      );
      return;
    }
    const sameQuery = searchResult?.query.toLowerCase() === query.toLowerCase();
    const index = sameQuery
      ? (searchResult.index + direction + ranges.length) % ranges.length
      : direction === -1
        ? ranges.length - 1
        : 0;
    if (typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined") {
      CSS.highlights.set("reader-search", new Highlight(...ranges));
      CSS.highlights.set("reader-search-current", new Highlight(ranges[index]));
    }
    ranges[index].startContainer.parentElement?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
    setSearchResult({ query, count: ranges.length, index });
    setNotice("");
  }

  function jumpToOutlineItem(item: ReaderOutlineItem) {
    const container = textContainer.current;
    if (!container) return;
    let target: HTMLElement | null = null;
    if (item.kind === "markdown-heading") {
      const headings = [
        ...container.querySelectorAll<HTMLElement>(
          ".reader-prose h1, .reader-prose h2, .reader-prose h3, .reader-prose h4, .reader-prose h5, .reader-prose h6",
        ),
      ].filter((heading) => normalizeReaderOutlineTitle(heading.textContent || "") === item.title);
      target = headings[item.headingOccurrence || 0] || null;
    }
    if (item.kind === "docx-heading") {
      target =
        [...container.querySelectorAll<HTMLElement>("[data-docx-heading-id]")].find(
          (heading) => `docx:${heading.dataset.docxHeadingId}` === item.id,
        ) || null;
    }
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      setOutlineOpen(false);
      setSelection("");
      setSelectionToolbar(null);
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
      return;
    }
    // Chunk entries were admitted only after their locator was unique in the
    // saved source text. Restrict the DOM lookup to the rendered source body,
    // so a repeated title or metadata field cannot win the first match.
    const prose = container.querySelector<HTMLElement>("[data-reader-text]");
    const range = prose ? findQuoteRange(prose, item.locator) : null;
    if (!range) {
      setNotice("未能在当前阅读版定位该章节；目录仅显示已保存的原文结构。");
      return;
    }
    range.startContainer.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
    setOutlineOpen(false);
    setSelection("");
    setSelectionToolbar(null);
    const rangeTarget = range.startContainer.parentElement;
    if (rangeTarget) {
      rangeTarget.tabIndex = -1;
      rangeTarget.focus({ preventScroll: true });
    }
  }

  const regionStudyBlockedMessage = historical
    ? "历史版本暂不支持区域视觉学习，请回到当前版本。"
    : !props.cloudUserId
      ? "请先登录并将资料确认到云端。"
      : props.saveState && props.saveState !== "cloud"
        ? "请等待当前资料完成云端确认。"
        : !aiEnabled
          ? "资料问答已关闭，请先在设置中开启。"
          : !source.aiAllowed
            ? "这份资料尚未允许用于 AI。"
            : source.originalMissing
              ? "当前版本缺少原文件，无法截取区域。"
              : "";

  const currentRegionCaptureStart =
    regionCaptureStart &&
    regionCaptureStart.accountId === props.cloudUserId &&
    regionCaptureStart.sourceId === source.id &&
    regionCaptureStart.versionId === source.versionId &&
    !regionStudyBlockedMessage
      ? regionCaptureStart
      : null;
  const regionCaptureActive = currentRegionCaptureStart !== null;

  const currentRegionCapture =
    regionCapture &&
    regionCapture.accountId === props.cloudUserId &&
    regionCapture.identity.sourceId === source.id &&
    regionCapture.identity.versionId === source.versionId &&
    !regionStudyBlockedMessage
      ? regionCapture
      : null;

  useLayoutEffect(() => {
    const started = regionCaptureStartRef.current;
    if (
      started &&
      (started.accountId !== props.cloudUserId ||
        started.sourceId !== source.id ||
        started.versionId !== source.versionId ||
        regionStudyBlockedMessage)
    ) {
      // Invalidate the exact initiation object before a delayed encoding
      // callback can run under a newly committed account or permission state.
      regionCaptureStartRef.current = null;
      setRegionCaptureStart(null);
    }
    if (regionCapture && !currentRegionCapture) {
      // The render guard prevents a stale-frame flash; now release the Blob.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRegionCapture(null);
    }
  }, [
    props.cloudUserId,
    currentRegionCapture,
    regionCapture,
    regionCaptureStart,
    regionStudyBlockedMessage,
    source.id,
    source.versionId,
  ]);

  function cancelRegionCapture() {
    regionCaptureStartRef.current = null;
    setRegionCaptureStart(null);
  }

  function togglePdfText() {
    clearSearchResults();
    cancelRegionCapture();
    setRegionCapture(null);
    setSelection("");
    setNativeSelectionPage(undefined);
    setSelectionToolbar(null);
    setShowText(!showText);
  }

  function switchPdfReadingMode(next: PdfReadingMode) {
    if (next === pdfReadingMode) return;
    clearSearchResults();
    cancelRegionCapture();
    setRegionCapture(null);
    setSelection("");
    setSelectionPresentation(null);
    setPlainSelectionAnchor(null);
    setNativeSelectionPage(undefined);
    setSelectionToolbar(null);
    window.getSelection()?.removeAllRanges();
    setPdfReadingMode(next);
  }

  function pdfReadingModeControls() {
    return (
      <div className="reader-pdf-mode" role="group" aria-label="PDF 阅读模式">
        <button
          type="button"
          aria-pressed={pdfReadingMode === "single"}
          title="只显示当前一页"
          onClick={() => switchPdfReadingMode("single")}
        >
          单页
        </button>
        <button
          type="button"
          aria-pressed={pdfReadingMode === "continuous"}
          title="向下滚动阅读所有页面"
          onClick={() => switchPdfReadingMode("continuous")}
        >
          连续滚动
        </button>
      </div>
    );
  }

  function startRegionCapture() {
    if (regionStudyBlockedMessage || !props.cloudUserId) {
      setNotice(regionStudyBlockedMessage);
      return;
    }
    clearSearchResults();
    setOutlineOpen(false);
    setSearchOpen(false);
    setAnnotationOpen(false);
    setSelection("");
    setSelectionToolbar(null);
    setRegionCapture(null);
    const started = {
      accountId: props.cloudUserId,
      sourceId: source.id,
      versionId: source.versionId,
    };
    regionCaptureStartRef.current = started;
    setRegionCaptureStart(started);
    setNotice("拖动框选 PDF 中要交给多模态 AI 的区域。");
  }

  const article = source.kind === "markdown" || source.kind === "web";
  const mobileReadingStatus = historical
    ? "历史版本 · 只读"
    : source.kind === "pdf"
      ? `第 ${page} 页 · 共 ${Math.max(1, pages)} 页`
      : sourceStatusLabel(source);
  const androidPeekText = input.trim()
    ? input.trim()
    : historical
      ? "查看这个版本中已保存的问答与引用"
      : "从这份资料的任何位置开始提问";
  return (
    <section
      ref={readerWorkspace}
      className={`reader-workspace ${aiOpen ? "reader-with-ai" : ""} reader-mobile-${mobileTab} ${
        androidMobileVariant ? "reader-mobile-android" : ""
      } ${aiPanelResizing ? "reader-ai-resizing" : ""}`}
      aria-label="阅读与资料问答"
      data-mobile-variant={androidMobileVariant ? "android" : "default"}
      style={aiOpen ? ({ "--reader-ai-width": `${aiPanelWidth}px` } as CSSProperties) : undefined}
    >
      <style href="conuo-reader-highlights" precedence="default">
        {highlightStyles}
      </style>
      <ReaderTopbar
        source={source}
        space={space}
        backLabel={backLabel}
        contextualBackLabel={contextualBackLabel}
        historical={historical}
        saveState={props.saveState}
        saveLabel={props.saveLabel}
        mobileReadingStatus={mobileReadingStatus}
        mobileTab={mobileTab}
        aiOpen={aiOpen}
        showText={showText}
        outlineOpen={outlineOpen}
        outlineItems={outlineItems}
        searchOpen={searchOpen}
        annotationOpen={annotationOpen}
        sourceAnnotations={sourceAnnotations}
        sourceActionsOpen={sourceActionsOpen}
        sourceActions={sourceActions}
        sourceActionsToggle={sourceActionsToggle}
        regionCaptureActive={regionCaptureActive}
        regionStudyBlockedMessage={regionStudyBlockedMessage}
        onBack={onBack}
        onStartComparison={props.onStartComparison}
        onRefreshWeb={props.onRefreshWeb}
        onReplaceFile={props.onReplaceFile}
        download={download}
        openAiPanel={openAiPanel}
        closeAiPanel={closeAiPanel}
        isCompactReaderLayout={isCompactReaderLayout}
        pdfReadingModeControls={pdfReadingModeControls}
        toggleOutline={toggleOutline}
        togglePdfText={togglePdfText}
        toggleDocumentSearch={toggleDocumentSearch}
        startRegionCapture={startRegionCapture}
        cancelRegionCapture={cancelRegionCapture}
        setNotice={setNotice}
        setAnnotationOpen={setAnnotationOpen}
        setRetainedPositionsOpen={setRetainedPositionsOpen}
        setSourceActionsOpen={setSourceActionsOpen}
        setWebPanel={setWebPanel}
      />
      <div className="reader-mobile-tabs" role="tablist" aria-label="阅读工作区">
        <button
          role="tab"
          aria-selected={mobileTab === "reading"}
          onClick={() => setMobileTab("reading")}
        >
          <BookOpen size={16} />
          阅读
        </button>
        <button
          role="tab"
          aria-selected={mobileTab === "ai"}
          onClick={() => {
            openAiPanel();
          }}
        >
          <Sparkles size={16} />
          {historical ? "已有问答" : "问 AI"}
        </button>
      </div>
      {androidMobileVariant && mobileTab !== "citation" && (
        <div className="reader-android-mode" role="group" aria-label="Android 阅读模式切换">
          <button type="button" aria-pressed={mobileTab === "reading"} onClick={closeAiPanel}>
            原文
          </button>
          <button type="button" aria-pressed={mobileTab === "ai"} onClick={openAiPanel}>
            AI
          </button>
        </div>
      )}
      {historical && (
        <div className="reader-historical-banner" role="status">
          <History size={16} />
          <div>
            <strong>正在阅读历史版本 · 只读</strong>
            <span>
              {new Date(
                source.versionCreatedAt || source.webSnapshot?.capturedAt || source.createdAt,
              ).toLocaleString("zh-CN")}{" "}
              · <code>{source.versionId}</code>
            </span>
            <p>
              此处不会发起新的 AI
              问答、添加标注或更新当前版阅读进度。可以保存独立摘录笔记，并查看已有引用。
            </p>
          </div>
          <button type="button" className="btn" onClick={() => onOpenSource(source.id)}>
            回到当前版本
          </button>
        </div>
      )}
      {notice && (
        <div className="reader-notice" role="status">
          <span>{notice}</span>
          <button className="icon-btn" aria-label="关闭提示" onClick={() => setNotice("")}>
            <X size={14} />
          </button>
        </div>
      )}
      <div className="reader-body">
        <section id="reader-document-pane" className="reader-document" aria-label="资料阅读区">
          {webPanel && (
            <WebVersionPanel
              key={`${source.id}:${source.versionId}:${webPanel}`}
              source={liveSource}
              displayedVersionId={source.versionId}
              spaceId={space.id}
              cloudUserId={props.cloudUserId}
              initialMode={webPanel}
              onOpenSource={onOpenSource}
              onRefreshWeb={props.onRefreshWeb}
              onReplaceFile={props.onReplaceFile}
              onRestoreVersion={props.onRestoreVersion}
              onPreviewRemoveVersion={props.onPreviewRemoveVersion}
              onRemoveVersion={props.onRemoveVersion}
              onClose={() => setWebPanel(null)}
            />
          )}
          {outlineOpen && outlineItems.length > 0 && (
            <nav className="reader-outline" id="reader-outline-panel" aria-label="资料目录">
              <header className="reader-outline-header">
                <div>
                  <strong>目录</strong>
                  <span>{outlineItems.length} 个已解析章节</span>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="关闭资料目录"
                  onClick={closeOutline}
                >
                  <X size={15} />
                </button>
              </header>
              <div className="reader-outline-list">
                {outlineItems.map((item) => (
                  <button
                    type="button"
                    className={`reader-outline-item reader-outline-level-${item.level}`}
                    data-reader-outline-item={item.id}
                    key={item.id}
                    title={item.title}
                    aria-label={`跳转到章节：${item.title}`}
                    onClick={() => jumpToOutlineItem(item)}
                  >
                    {item.title}
                  </button>
                ))}
              </div>
            </nav>
          )}
          {searchOpen && (
            <form
              id="reader-find-panel"
              className="reader-find"
              onSubmit={(event) => {
                event.preventDefault();
                findInDocument();
              }}
            >
              <Search size={15} />
              <input
                ref={searchInput}
                aria-label="查找文字"
                placeholder={
                  source.kind === "pdf" && !showText ? "在当前 PDF 页查找" : "在原文中查找"
                }
                value={search}
                onChange={(event) => {
                  clearSearchResults();
                  setSearch(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  findInDocument(event.shiftKey ? -1 : 1);
                }}
              />
              <span
                className="reader-find-count"
                role="status"
                aria-live="polite"
                data-reader-search-count
              >
                {searchResult?.query.toLowerCase() === search.trim().toLowerCase()
                  ? `${searchResult.index + 1} / ${searchResult.count}`
                  : search.trim()
                    ? "按 Enter 查找"
                    : "输入文字"}
              </span>
              <button
                type="button"
                className="icon-btn"
                aria-label="上一处匹配"
                title="上一处匹配（Shift + Enter）"
                disabled={!search.trim()}
                onClick={() => findInDocument(-1)}
              >
                <ChevronLeft size={15} />
              </button>
              <button
                className="icon-btn"
                type="submit"
                aria-label="下一处匹配"
                title="下一处匹配（Enter）"
                disabled={!search.trim()}
              >
                <ChevronRight size={15} />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="关闭查找"
                onClick={closeDocumentSearch}
              >
                <X size={15} />
              </button>
            </form>
          )}
          {focusedCitation && (
            <div
              className={`reader-citation-target ${citationError ? "reader-citation-warning" : ""}`}
              role="status"
            >
              <div>
                <strong>
                  引用原文 · {focusedCitation.title}
                  {focusedCitation.page
                    ? ` · 第 ${focusedCitation.page} 页`
                    : ` · ${focusedCitation.section}`}
                </strong>
                <blockquote>{focusedCitation.quote}</blockquote>
                {citationError && <p>{citationError}</p>}
              </div>
              <button
                className="icon-btn"
                aria-label="关闭引用定位"
                onClick={() => {
                  setFocusedCitation(null);
                  setCitationError("");
                }}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {selection && selectionToolbar && (
            <div
              className={`reader-selection-actions reader-selection-actions-${selectionToolbar.placement}`}
              role="toolbar"
              aria-label={`已选中 ${selectionDisplay.length} 字，可进行选段操作`}
              style={{ left: `${selectionToolbar.left}px`, top: `${selectionToolbar.top}px` }}
              onMouseDown={(event) => event.preventDefault()}
            >
              <button
                className="reader-selection-ask"
                disabled={historical}
                onClick={() => {
                  setScope("selection");
                  openAiPanel();
                  focusAiInput();
                }}
              >
                <Sparkles size={14} />问 AI
              </button>
              <span className="reader-selection-divider" aria-hidden="true" />
              <button disabled={historical} onClick={highlightSelection}>
                <Highlighter size={14} />
                高亮
              </button>
              <button onClick={() => saveSelection("note")}>
                <StickyNote size={14} />
                存笔记
              </button>
              <button
                ref={excerptSaveTrigger}
                disabled={historical || !onSaveExcerptToKnowledgePage}
                title={
                  historical
                    ? "历史版本仅可保存独立笔记"
                    : !onSaveExcerptToKnowledgePage
                      ? "当前页面无法保存到知识页，请刷新后重试"
                      : "保存原文摘录到知识页"
                }
                onClick={openExcerptKnowledgeTarget}
              >
                <BookOpen size={14} />
                <span className="reader-selection-knowledge-label">存知识页</span>
              </button>
              <button
                className="icon-btn"
                aria-label="复制选段"
                onClick={() => void copySelection()}
              >
                <Copy size={14} />
              </button>
              <button
                className="icon-btn"
                aria-label="清除选段"
                onClick={() => {
                  setSelection("");
                  setSelectionToolbar(null);
                  window.getSelection()?.removeAllRanges();
                  if (scope === "selection") setScope("document-notes");
                }}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {annotationDraft && !historical && (
            <form
              className="reader-annotation-compose"
              aria-label="新增批注"
              onSubmit={(event) => {
                event.preventDefault();
                saveAnnotation();
              }}
            >
              <div>
                <strong>为选段添加批注</strong>
                <blockquote>{markdownQuoteText(source, annotationDraft.quote)}</blockquote>
              </div>
              <label>
                批注内容 <span>可选</span>
                <textarea
                  aria-label="批注内容"
                  value={annotationNote}
                  maxLength={4_000}
                  placeholder="写下你的理解、疑问或下一步行动"
                  onChange={(event) => setAnnotationNote(event.target.value)}
                />
              </label>
              <div className="reader-annotation-form-actions">
                <button
                  type="button"
                  onClick={() => {
                    setAnnotationDraft(null);
                    setAnnotationNote("");
                  }}
                >
                  取消
                </button>
                <button type="submit" className="btn btn-primary">
                  保存标注
                </button>
              </div>
            </form>
          )}
          {annotationOpen && (
            <aside
              id="reader-annotations-panel"
              className="reader-annotations"
              aria-label="我的标注"
            >
              <h3>
                我的标注 <span>{sourceAnnotations.length}</span>
              </h3>
              {!sourceAnnotations.length && (
                <p className="muted">
                  {historical
                    ? "这个历史版本没有已保存的标注；如需记录原文，可以保存独立笔记。"
                    : "选择原文后点击“高亮”，标注会保存在这里。"}
                </p>
              )}
              {sourceAnnotations.map((item) => {
                const editing = editingAnnotationId === item.id;
                return (
                  <article className="reader-annotation-card" key={item.id}>
                    <button
                      type="button"
                      className="reader-annotation-locate"
                      aria-label={`定位批注：${markdownQuoteText(source, item.quote).slice(0, 32)}`}
                      onClick={() => {
                        if (item.page) changePage(item.page);
                        setFocusedCitation(null);
                        setFocusedAnnotationId(item.id);
                        setAnnotationFocusEpoch((current) => current + 1);
                        setMobileTab("reading");
                        if (!isWideReaderLayout()) setAiOpen(false);
                      }}
                    >
                      <blockquote>{markdownQuoteText(source, item.quote)}</blockquote>
                      <span className="reader-annotation-meta">
                        {item.page ? `第 ${item.page} 页 · ` : ""}
                        {new Date(item.createdAt).toLocaleDateString("zh-CN")}
                      </span>
                    </button>
                    {editing ? (
                      <form
                        className="reader-annotation-editor"
                        aria-label="编辑批注"
                        onSubmit={(event) => {
                          event.preventDefault();
                          saveAnnotationEdit(item);
                        }}
                      >
                        <textarea
                          aria-label="编辑批注内容"
                          value={editingAnnotationNote}
                          maxLength={4_000}
                          placeholder="写下你的理解、疑问或下一步行动"
                          onChange={(event) => setEditingAnnotationNote(event.target.value)}
                        />
                        <div className="reader-annotation-form-actions">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingAnnotationId(null);
                              setEditingAnnotationNote("");
                            }}
                          >
                            取消
                          </button>
                          <button type="submit" className="btn btn-primary">
                            保存修改
                          </button>
                        </div>
                      </form>
                    ) : (
                      <p
                        className={
                          item.note ? "reader-annotation-note" : "reader-annotation-note muted"
                        }
                      >
                        {item.note || "未添加说明"}
                      </p>
                    )}
                    <div className="reader-annotation-actions">
                      <button
                        type="button"
                        aria-label="编辑批注"
                        disabled={historical || !onAnnotationUpdate}
                        onClick={() => beginAnnotationEdit(item)}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        aria-label="删除批注"
                        disabled={historical || !onAnnotationDelete}
                        onClick={() => deleteAnnotation(item)}
                      >
                        删除
                      </button>
                    </div>
                  </article>
                );
              })}
            </aside>
          )}
          {source.originalMissing && (
            <div className="reader-warning" role="status">
              恢复备份时缺少此版本的原件。已有文字和引用记录仍保留；可切换到文字阅读，或重新选择文件保存为新版本。
            </div>
          )}
          {source.kind === "pdf" && !showText && (
            <div className="reader-mobile-pdf-mode">
              <span>阅读方式</span>
              {pdfReadingModeControls()}
            </div>
          )}
          <div
            className="reader-document-scroll"
            ref={textContainer}
            onScroll={saveReadingPosition}
          >
            <div className="reader-document-tools" data-reader-document-tools>
              <div
                className={`reader-tool-group ${
                  source.kind === "pdf"
                    ? "reader-document-page-controls"
                    : "reader-document-structure-controls"
                }`}
              >
                {source.kind === "pdf" ? (
                  <>
                    <button
                      className="icon-btn"
                      aria-label="上一页"
                      disabled={page <= 1 || showText}
                      onClick={() => changePage(page - 1)}
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <label className="reader-page-control">
                      <input
                        aria-label="跳转页码"
                        type="number"
                        min={1}
                        max={pages}
                        value={page}
                        disabled={showText}
                        onChange={(event) => changePage(Number(event.target.value))}
                      />
                      <span>/ {pages}</span>
                    </label>
                    <button
                      className="icon-btn"
                      aria-label="下一页"
                      disabled={page >= pages || showText}
                      onClick={() => changePage(page + 1)}
                    >
                      <ChevronRight size={16} />
                    </button>
                  </>
                ) : (
                  <>
                    <span className="reader-format">
                      <FileText size={15} />
                      {source.kind === "web" ? "网页快照" : source.kind.toUpperCase()}
                    </span>
                    {outlineItems.length > 0 && (
                      <button
                        type="button"
                        className="reader-tool-text reader-outline-trigger"
                        data-reader-outline-trigger
                        aria-label={`打开资料目录（${outlineItems.length} 项）`}
                        aria-controls="reader-outline-panel"
                        aria-expanded={outlineOpen}
                        onClick={(event) => toggleOutline(event.currentTarget)}
                      >
                        目录
                      </button>
                    )}
                  </>
                )}
              </div>
              <span className="reader-tool-divider reader-document-zoom-divider" />
              <div className="reader-tool-group reader-document-zoom-controls">
                <button
                  className="icon-btn"
                  aria-label="缩小"
                  disabled={zoom <= 60}
                  onClick={() => setZoom(Math.max(60, zoom - 10))}
                >
                  <Minus size={15} />
                </button>
                <button className="reader-zoom" title="恢复默认缩放" onClick={() => setZoom(100)}>
                  {zoom}%
                </button>
                <button
                  className="icon-btn"
                  aria-label="放大"
                  disabled={zoom >= 200}
                  onClick={() => setZoom(Math.min(200, zoom + 10))}
                >
                  <Plus size={15} />
                </button>
              </div>
              <div className="reader-tool-spacer" />
              {source.kind === "pdf" && !showText && pdfReadingModeControls()}
              {source.kind === "pdf" && (
                <button
                  className="reader-tool-text"
                  aria-pressed={showText}
                  onClick={togglePdfText}
                >
                  {showText ? "原始 PDF" : "解析文本"}
                </button>
              )}
              {source.kind === "pdf" && !showText && (
                <button
                  type="button"
                  className="reader-tool-text reader-region-trigger"
                  data-reader-region-trigger
                  aria-label={regionCaptureActive ? "取消区域框选" : "框选区域交给 AI"}
                  aria-pressed={regionCaptureActive}
                  title={regionStudyBlockedMessage || "区域视觉学习"}
                  disabled={Boolean(regionStudyBlockedMessage)}
                  onClick={() => {
                    if (regionCaptureActive) {
                      cancelRegionCapture();
                      setNotice("");
                    } else startRegionCapture();
                  }}
                >
                  <Crop size={14} aria-hidden="true" />
                  <span>{regionCaptureActive ? "取消框选" : "区域学习"}</span>
                </button>
              )}
              <button
                className="icon-btn"
                data-reader-search-trigger
                aria-label="查找原文"
                aria-controls="reader-find-panel"
                aria-expanded={searchOpen}
                onClick={(event) => toggleDocumentSearch(event.currentTarget)}
              >
                <Search size={16} />
              </button>
              <button
                className="icon-btn"
                data-reader-annotation-trigger
                aria-label={`我的标注（${sourceAnnotations.length}）`}
                aria-controls="reader-annotations-panel"
                aria-expanded={annotationOpen}
                onClick={() => setAnnotationOpen(!annotationOpen)}
              >
                <Highlighter size={16} />
              </button>
            </div>
            {source.kind === "pdf" && !showText ? (
              <PdfReader
                key={`${source.id}:${source.versionId}`}
                source={source}
                page={page}
                readingMode={pdfReadingMode}
                navigationRequest={pdfNavigationRequest}
                scrollContainerRef={textContainer}
                onVisiblePageChange={trackVisiblePdfPage}
                zoom={zoom}
                getSourceBlob={getSourceBlob}
                onPages={setPages}
                onRendered={() => {
                  clearSearchResults();
                  setRenderRevision((value) => value + 1);
                }}
                capture={{
                  active: regionCaptureActive,
                  limits: {
                    maxOutputEdge: 2_048,
                    maxOutputPixels: 3_000_000,
                    maxBytes: 1_500_000,
                  },
                  onCapture: (next) => {
                    const started = currentRegionCaptureStart;
                    if (
                      !started ||
                      regionCaptureStartRef.current !== started ||
                      next.identity.sourceId !== started.sourceId ||
                      next.identity.versionId !== started.versionId
                    )
                      return;
                    cancelRegionCapture();
                    setRegionCapture({ ...next, accountId: started.accountId });
                    setNotice("");
                  },
                  onCancel: () => {
                    if (
                      !currentRegionCaptureStart ||
                      regionCaptureStartRef.current !== currentRegionCaptureStart
                    )
                      return;
                    cancelRegionCapture();
                    setNotice("");
                  },
                }}
              />
            ) : (
              <article className="reader-paper" style={{ fontSize: `${(18 * zoom) / 100}px` }}>
                <header className="reader-paper-header">
                  <span className="reader-eyebrow">
                    {source.kind === "web" ? "收藏的网页" : "学习资料"}
                  </span>
                  <h1>{source.title}</h1>
                  <div className="reader-paper-meta">
                    <span>{source.filename}</span>
                    <span>保存于 {new Date(source.createdAt).toLocaleDateString("zh-CN")}</span>
                  </div>
                  {source.webSnapshot && (
                    <div className="reader-web-snapshot">
                      <span>
                        {source.webSnapshot.method === "server" ? "采集" : "保存"}于{" "}
                        {new Date(source.webSnapshot.capturedAt).toLocaleString("zh-CN")}
                        {" · "}
                        {
                          {
                            article: "提取正文",
                            selection: "用户选段",
                            pasted: "手动粘贴",
                            link: "仅链接",
                          }[source.webSnapshot.scope]
                        }
                      </span>
                      {source.webSnapshot.siteName && <span>{source.webSnapshot.siteName}</span>}
                      {source.webSnapshot.byline && <span>{source.webSnapshot.byline}</span>}
                      {source.webSnapshot.finalUrl !== source.webSnapshot.originalUrl && (
                        <a
                          href={source.webSnapshot.finalUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          最终地址：{source.webSnapshot.finalUrl}
                        </a>
                      )}
                      {source.webSnapshot.warnings.map((warning, index) => (
                        <p key={index}>{warning}</p>
                      ))}
                    </div>
                  )}
                  {source.tags.length > 0 && (
                    <div className="reader-tags">
                      {source.tags.map((tag) => (
                        <span key={tag}>{tag}</span>
                      ))}
                    </div>
                  )}
                  {source.url && (
                    <a
                      className="reader-origin"
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      打开原网页
                      <ExternalLink size={13} />
                    </a>
                  )}
                </header>
                {sourceCaptureScopeNotice(source) && (
                  <div className="reader-warning" role="status">
                    {sourceCaptureScopeNotice(source)}
                  </div>
                )}
                {isParserCoverageIncomplete(source) && (
                  <div className="reader-warning">
                    {sourceParserCoverageNotice(source)}
                    {source.error ? ` ${source.error}` : ""}
                  </div>
                )}
                {source.text ? (
                  <div
                    className="reader-prose"
                    data-reader-text="true"
                    data-reader-source-id={source.id}
                    data-reader-source-version={source.versionId}
                    {...(article
                      ? { "data-markdown-start": 0, "data-markdown-end": source.text.length }
                      : {})}
                  >
                    {article ? (
                      <Markdown content={source.text} sourceAnchors />
                    ) : source.kind === "docx" && docxBlocks?.length ? (
                      <DocxContent blocks={docxBlocks} />
                    ) : (
                      source.text.split(/\n\s*\n/).map((paragraph, index) => (
                        <p className="reader-plain-paragraph" key={index}>
                          {paragraph}
                        </p>
                      ))
                    )}
                  </div>
                ) : (
                  <div className="reader-empty">
                    <FileText size={30} />
                    <h2>
                      {source.status === "link-only"
                        ? "这个收藏仅保存了链接"
                        : "暂时没有可阅读的解析文本"}
                    </h2>
                    <p>
                      {source.error ||
                        "原文件仍然保留。可以下载查看，解析完成后才能基于内容检索与问答。"}
                    </p>
                    {source.url && (
                      <a
                        className="btn"
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        打开原网页
                        <ExternalLink size={14} />
                      </a>
                    )}
                  </div>
                )}
              </article>
            )}
          </div>
          <div
            className="reader-desktop-bottom-controls"
            data-reader-desktop-bottom-controls
            role="group"
            aria-label="阅读工具条"
          >
            {source.kind === "pdf" && (
              <>
                <div
                  className="reader-tool-group reader-bottom-page-controls"
                  role="group"
                  aria-label="页码"
                >
                  <button
                    className="icon-btn"
                    aria-label="上一页"
                    disabled={page <= 1 || showText}
                    onClick={() => changePage(page - 1)}
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <span className="reader-bottom-page-status" aria-live="polite">
                    第 {page} / {pages} 页
                  </span>
                  <button
                    className="icon-btn"
                    aria-label="下一页"
                    disabled={page >= pages || showText}
                    onClick={() => changePage(page + 1)}
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
                <span className="reader-tool-divider" aria-hidden="true" />
                <label className="reader-bottom-page-jump">
                  <span>跳至</span>
                  <input
                    aria-label="跳转页码"
                    type="number"
                    min={1}
                    max={pages}
                    value={page}
                    disabled={showText}
                    onChange={(event) => changePage(Number(event.target.value))}
                  />
                </label>
                <span className="reader-tool-divider" aria-hidden="true" />
              </>
            )}
            <div
              className="reader-tool-group reader-bottom-zoom-controls"
              role="group"
              aria-label="缩放"
            >
              <button
                className="icon-btn"
                aria-label="缩小"
                disabled={zoom <= 60}
                onClick={() => setZoom(Math.max(60, zoom - 10))}
              >
                <Minus size={15} />
              </button>
              <button className="reader-zoom" title="恢复默认缩放" onClick={() => setZoom(100)}>
                {zoom}%
              </button>
              <button
                className="icon-btn"
                aria-label="放大"
                disabled={zoom >= 200}
                onClick={() => setZoom(Math.min(200, zoom + 10))}
              >
                <Plus size={15} />
              </button>
            </div>
          </div>
        </section>
        {mobileTab === "citation" && focusedCitation && (
          <section
            className="reader-mobile-citation-page"
            aria-label="引用原文"
            aria-labelledby="reader-mobile-citation-title"
          >
            <header className="reader-mobile-citation-header">
              <button
                type="button"
                className="icon-btn"
                aria-label="返回回答"
                ref={citationReturnButton}
                onClick={() => setMobileTab("ai")}
              >
                <ChevronLeft size={18} />
              </button>
              <div>
                <span>引用原文</span>
                <strong id="reader-mobile-citation-title">{focusedCitation.title}</strong>
              </div>
              <button
                type="button"
                className="reader-mobile-citation-open-source"
                aria-label="打开完整原文"
                onClick={openCitationSource}
              >
                打开原文
              </button>
            </header>
            <div className="reader-mobile-citation-scroll">
              <p className="reader-mobile-citation-location">
                <FileText size={15} />
                {focusedCitation.page
                  ? `第 ${focusedCitation.page} 页`
                  : focusedCitation.section || "当前阅读位置"}
              </p>
              <article
                className={`reader-mobile-citation-excerpt ${
                  citationError ? "reader-mobile-citation-excerpt-warning" : ""
                }`}
              >
                <span>原文摘录</span>
                <blockquote>{focusedCitation.quote}</blockquote>
                {citationError ? (
                  <p role="status">{citationError}</p>
                ) : focusedCitation.sourceId === source.id &&
                  focusedCitation.versionId === source.versionId ? (
                  <p>已在阅读区定位到该位置；可查看上下文或返回回答继续追问。</p>
                ) : (
                  <p>这段原文来自另一份资料；可打开原文，或返回回答继续追问。</p>
                )}
              </article>
            </div>
            <footer className="reader-mobile-citation-footer">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setMobileTab("ai");
                  focusAiInput();
                }}
              >
                继续追问
              </button>
              <button type="button" className="btn" onClick={() => setMobileTab("ai")}>
                <ChevronLeft size={15} />
                返回回答
              </button>
            </footer>
          </section>
        )}
        {aiOpen && (
          <>
            <div
              className="reader-ai-resizer"
              role="separator"
              aria-label="调整问 AI 面板宽度"
              aria-orientation="vertical"
              aria-controls="reader-ai-panel"
              aria-valuemin={AI_PANEL_MIN_WIDTH}
              aria-valuemax={aiPanelWidthLimit}
              aria-valuenow={aiPanelWidth}
              aria-valuetext={`${aiPanelWidth} 像素`}
              tabIndex={0}
              title="拖动或使用左右方向键调整问 AI 面板宽度"
              onDoubleClick={resetAiPanelWidth}
              onKeyDown={handleAiPanelResizeKeyDown}
              onPointerDown={startAiPanelResize}
              onPointerMove={moveAiPanelResize}
              onPointerUp={finishAiPanelResize}
              onPointerCancel={finishAiPanelResize}
            >
              <span aria-hidden="true" />
            </div>
            <button
              type="button"
              className="reader-ai-backdrop"
              aria-label="关闭问答面板"
              onClick={closeAiPanel}
            />
            <aside
              id="reader-ai-panel"
              className="reader-ai"
              aria-label="资料问答"
              aria-hidden={mobileTab === "citation" || undefined}
            >
              <div className="reader-ai-sheet-grab" aria-hidden="true" />
              <header className="reader-ai-header">
                <div className="reader-ai-heading">
                  <div className="reader-ai-icon">
                    <Sparkles size={17} />
                  </div>
                  <strong>{historical ? "已有问答" : "问 AI"}</strong>
                  <div className="reader-tool-spacer" />
                  <button
                    className="icon-btn"
                    aria-label="对话历史"
                    aria-expanded={historyOpen}
                    disabled={busy}
                    onClick={() => setHistoryOpen(!historyOpen)}
                  >
                    <History size={16} />
                  </button>
                  <button
                    className="icon-btn"
                    aria-label="新建对话"
                    disabled={busy || historical}
                    onClick={() => {
                      setNewConversation(true);
                      setSelectedConversation(null);
                      setError("");
                      setInput("");
                      questionInput.current?.focus();
                    }}
                  >
                    <Plus size={18} />
                  </button>
                  <button
                    className="icon-btn reader-close-ai"
                    aria-label="收起问答面板"
                    onClick={closeAiPanel}
                  >
                    <PanelRightClose size={17} />
                  </button>
                </div>
                <p>
                  {historical
                    ? "查看已有回答和确切版本的原文引用"
                    : "基于你收藏的资料，陪你读懂每一段"}
                </p>
                {!historical && (
                  <ModelStatus
                    key={props.cloudUserId || "local"}
                    userId={props.cloudUserId}
                    compact
                  />
                )}
                <label className="reader-scope">
                  <span>提问范围</span>
                  <select
                    value={scope}
                    disabled={busy || historical}
                    onChange={(event) => setScope(event.target.value as Scope)}
                  >
                    {readerScopeOptions.map((key) => (
                      <option value={key} key={key}>
                        {scopeLabels[key]}
                      </option>
                    ))}
                  </select>
                </label>
                {scope === "sources" && (
                  <fieldset className="reader-source-picker">
                    <legend>选择当前空间的资料</legend>
                    {availableSources.map((item) => (
                      <label key={item.id}>
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(item.id)}
                          disabled={busy || historical || !item.aiAllowed}
                          onChange={(event) =>
                            setSelectedIds(
                              event.target.checked
                                ? [...selectedIds, item.id]
                                : selectedIds.filter((id) => id !== item.id),
                            )
                          }
                        />
                        <span>
                          {item.title}
                          {!item.aiAllowed ? "（未允许 AI）" : ""}
                        </span>
                      </label>
                    ))}
                    {!availableSources.length && <p>当前空间没有可选资料。</p>}
                  </fieldset>
                )}
                {scope === "selection" && (
                  <div className="reader-selected-quote">
                    {selection ? (
                      <>
                        <blockquote>{selectionDisplay}</blockquote>
                        {selectionDisplay !== selection && (
                          <details className="reader-selection-source-format">
                            <summary>查看原文格式</summary>
                            <blockquote>{selection}</blockquote>
                          </details>
                        )}
                      </>
                    ) : (
                      <span>请在阅读区选择一段原文。</span>
                    )}
                  </div>
                )}
                {scope === "document-notes" && (
                  <p className="reader-note-scope" role="status">
                    {documentNoteCount
                      ? `会同时检索此资料，以及 ${documentNoteCount} 条已关联的人工笔记；回答会明确区分两类依据。`
                      : "会检索此资料。暂时没有已关联到当前资料、可安全纳入的人工笔记。"}
                  </p>
                )}
                {!historical && askEligibilityMessage ? (
                  <p id="reader-ask-eligibility" className="reader-scope-warning" role="status">
                    {askEligibilityMessage}
                  </p>
                ) : (
                  !!ineligibleCount && (
                    <p className="reader-scope-warning" role="status">
                      范围中有 {ineligibleCount} 份资料尚未就绪或未允许 AI，不会作为回答依据。
                    </p>
                  )
                )}
                {!historical && !source.aiAllowed && (
                  <button
                    className="reader-enable"
                    disabled={busy}
                    onClick={() => onSourceChange({ aiAllowed: true })}
                  >
                    允许此资料用于 AI
                  </button>
                )}
              </header>
              {historyOpen && (
                <div className="reader-history">
                  <h3>此资料的对话</h3>
                  {history.length ? (
                    history.map((item) => (
                      <button
                        className={conversation?.id === item.id ? "reader-active" : ""}
                        key={item.id}
                        onClick={() => {
                          setSelectedConversation(item.id);
                          setNewConversation(false);
                          setScope(item.scope);
                          setSelectedIds(item.sourceIds);
                          setHistoryOpen(false);
                          setError("");
                        }}
                      >
                        <MessageSquare size={15} />
                        <span>{item.title}</span>
                        {item.resolved && <Check size={14} />}
                      </button>
                    ))
                  ) : (
                    <p>发送第一个问题后，对话会保存在这里。</p>
                  )}
                </div>
              )}
              {conversation && (
                <div className="reader-conversation-state">
                  <span>{conversation.resolved ? "这个问题已解决" : "正在探索这个问题"}</span>
                  <button
                    disabled={busy || historical}
                    onClick={() =>
                      onConversationChange({
                        ...conversation,
                        resolved: !conversation.resolved,
                        updatedAt: new Date().toISOString(),
                      })
                    }
                  >
                    {conversation.resolved ? "重新打开" : "标记已解决"}
                  </button>
                </div>
              )}
              <div className="reader-messages" aria-live="polite" aria-relevant="additions text">
                {!messages.length && (
                  <div className="reader-ai-empty">
                    <div className="reader-ai-empty-icon">
                      <Sparkles size={24} />
                    </div>
                    <h2>{historical ? "保留当时的阅读依据" : "一起把这一段读懂"}</h2>
                    <p>
                      {historical
                        ? "这里可查看已有问答与引用。新的问题请回到当前版本发起。"
                        : "从不理解的地方开始提问。回答会显示依据，你可以随时回到原文核对。"}
                    </p>
                    <div>
                      {[
                        "这份资料的核心观点是什么？",
                        "请解释其中最重要的概念",
                        "有哪些值得进一步思考的问题？",
                      ].map((question) => (
                        <button
                          key={question}
                          disabled={historical}
                          onClick={() => {
                            setInput(question);
                            questionInput.current?.focus();
                          }}
                        >
                          {question}
                          <ArrowUp size={14} />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {messages.map((message, index) => {
                  const messageNoteEvidence = message.noteEvidence ?? EMPTY_NOTE_EVIDENCE;
                  const citationIssues = message.citations.map((citation) =>
                    citationProblem(citation, sources),
                  );
                  const noteEvidenceIssues = messageNoteEvidence.map((evidence) =>
                    noteEvidenceProblem(evidence, notes, sources),
                  );
                  const activeCitationIndex = message.citations.findIndex(
                    (_, citationIndex) =>
                      citationKey(message.id, citationIndex) === expandedCitationKey,
                  );
                  const expandedCitationIndex =
                    activeCitationIndex === -1 ? null : activeCitationIndex;
                  const activeNoteEvidenceIndex = messageNoteEvidence.findIndex(
                    (_, noteIndex) =>
                      noteEvidenceKey(message.id, noteIndex) === expandedCitationKey,
                  );
                  const expandedNoteEvidenceIndex =
                    activeNoteEvidenceIndex === -1 ? null : activeNoteEvidenceIndex;
                  const referencedEvidenceIndexes =
                    message.role === "assistant"
                      ? citationMarkerIndexes(
                          message.content,
                          message.citations,
                          messageNoteEvidence,
                          message.mode,
                        )
                      : { citations: new Set<number>(), notes: new Set<number>() };
                  const fallbackCitationIndexes =
                    message.role === "assistant"
                      ? message.citations.flatMap((_, citationIndex) =>
                          referencedEvidenceIndexes.citations.has(citationIndex)
                            ? []
                            : [citationIndex],
                        )
                      : [];
                  const fallbackNoteEvidenceIndexes =
                    message.role === "assistant"
                      ? messageNoteEvidence.flatMap((_, noteIndex) =>
                          referencedEvidenceIndexes.notes.has(noteIndex) ? [] : [noteIndex],
                        )
                      : [];
                  const includesNoteEvidence = messageNoteEvidence.length > 0;
                  const retryQuestion =
                    message.role === "assistant" && message.error && message.attempt
                      ? messages.find(
                          (item) =>
                            item.id === message.attempt?.questionMessageId && item.role === "user",
                        )
                      : undefined;
                  const attemptNumber = message.attempt
                    ? messages
                        .slice(0, index + 1)
                        .filter(
                          (item) =>
                            item.role === "assistant" &&
                            item.attempt?.questionMessageId === message.attempt?.questionMessageId,
                        ).length
                    : 0;
                  const showFollowUps =
                    message.role === "assistant" &&
                    !!message.content &&
                    !message.error &&
                    !message.attempt?.unavailableReason &&
                    !historical &&
                    !busy &&
                    index === messages.length - 1;

                  return (
                    <div
                      key={message.id}
                      className={`reader-message reader-message-${message.role}`}
                    >
                      <div className="reader-message-label">
                        {message.role === "user" ? (
                          "你"
                        ) : (
                          <>
                            <Sparkles size={14} />
                            Conuo{" "}
                            <span>
                              {attemptNumber > 1 ? `第 ${attemptNumber} 次尝试 · ` : ""}
                              {message.error
                                ? message.content
                                  ? "已停止 · 未完成、未核验"
                                  : "本次未完成"
                                : message.mode === "extractive"
                                  ? "原文检索 · 未调用生成模型"
                                  : message.mode === "model"
                                    ? "AI 回答"
                                    : ""}
                            </span>
                          </>
                        )}
                      </div>
                      {message.content && (
                        <div className="reader-message-content">
                          {message.role === "assistant" ? (
                            <AnswerMarkdown
                              content={message.content}
                              citations={message.citations}
                              noteEvidence={messageNoteEvidence}
                              mode={message.mode}
                              messageId={message.id}
                              expandedCitationIndex={expandedCitationIndex}
                              expandedNoteEvidenceIndex={expandedNoteEvidenceIndex}
                              citationIssues={citationIssues}
                              noteEvidenceIssues={noteEvidenceIssues}
                              onCitationToggle={(citationIndex) => {
                                const key = citationKey(message.id, citationIndex);
                                setExpandedCitationKey((current) => (current === key ? null : key));
                              }}
                              onNoteEvidenceToggle={(noteIndex) => {
                                const key = noteEvidenceKey(message.id, noteIndex);
                                setExpandedCitationKey((current) => (current === key ? null : key));
                              }}
                            />
                          ) : (
                            <Markdown content={message.content} />
                          )}
                        </div>
                      )}
                      {message.error && (
                        <div className="reader-message-error">
                          <p>{message.error}</p>
                          {message.content && (
                            <small>
                              这段内容保留供回顾和继续提问，不会作为已核验答案保存或另存。
                            </small>
                          )}
                          {message.attempt?.unavailableReason && (
                            <small>当时使用的资料已彻底删除，不能重试这次回答。</small>
                          )}
                          {retryQuestion &&
                            message.attempt &&
                            !message.attempt.unavailableReason && (
                              <button
                                className="btn"
                                disabled={busy || historical || !aiEnabled}
                                onClick={() => void ask({ retryAttempt: message.attempt })}
                              >
                                重试此回答
                              </button>
                            )}
                          <button
                            className="text-button"
                            disabled={busy || historical || !aiEnabled}
                            onClick={() => {
                              const previous = messages
                                .slice(0, index)
                                .reverse()
                                .find((item) => item.role === "user");
                              if (previous) {
                                setInput(previous.content);
                                questionInput.current?.focus();
                              }
                            }}
                          >
                            重新编辑问题
                          </button>
                        </div>
                      )}
                      {message.role === "assistant" &&
                        !message.error &&
                        message.attempt?.unavailableReason && (
                          <p className="reader-message-history-notice">
                            当时使用的资料已彻底删除；此回答仅保留为历史记录。
                          </p>
                        )}
                      {message.role === "assistant" &&
                        (message.citations.length > 0 || messageNoteEvidence.length > 0) && (
                          <div
                            className="reader-citations"
                            aria-label={messageNoteEvidence.length ? "回答依据" : "回答引用"}
                          >
                            {expandedCitationIndex !== null && (
                              <CitationCard
                                citation={message.citations[expandedCitationIndex]}
                                index={expandedCitationIndex}
                                id={citationCardId(message.id, expandedCitationIndex)}
                                issue={citationIssues[expandedCitationIndex] || null}
                                onOpen={() =>
                                  openCitation(message.citations[expandedCitationIndex])
                                }
                              />
                            )}
                            {expandedNoteEvidenceIndex !== null && (
                              <NoteEvidenceCard
                                evidence={messageNoteEvidence[expandedNoteEvidenceIndex]}
                                index={expandedNoteEvidenceIndex}
                                id={noteEvidenceCardId(message.id, expandedNoteEvidenceIndex)}
                                issue={noteEvidenceIssues[expandedNoteEvidenceIndex] || null}
                              />
                            )}
                            {fallbackCitationIndexes.length > 0 && (
                              <div className="reader-citation-fallback">
                                <span>引用</span>
                                {fallbackCitationIndexes.map((citationIndex) => {
                                  const citation = message.citations[citationIndex];
                                  return (
                                    <CitationChip
                                      key={`${citation.chunkId}-${citationIndex}`}
                                      citation={citation}
                                      index={citationIndex}
                                      cardId={citationCardId(message.id, citationIndex)}
                                      expanded={expandedCitationIndex === citationIndex}
                                      issue={citationIssues[citationIndex] || null}
                                      onToggle={() => {
                                        const key = citationKey(message.id, citationIndex);
                                        setExpandedCitationKey((current) =>
                                          current === key ? null : key,
                                        );
                                      }}
                                    />
                                  );
                                })}
                              </div>
                            )}
                            {fallbackNoteEvidenceIndexes.length > 0 && (
                              <div className="reader-citation-fallback reader-note-evidence-fallback">
                                <span>我的笔记</span>
                                {fallbackNoteEvidenceIndexes.map((noteIndex) => {
                                  const evidence = messageNoteEvidence[noteIndex];
                                  return (
                                    <NoteEvidenceChip
                                      key={`${evidence.noteId}-${evidence.blockId}-${noteIndex}`}
                                      evidence={evidence}
                                      index={noteIndex}
                                      cardId={noteEvidenceCardId(message.id, noteIndex)}
                                      expanded={expandedNoteEvidenceIndex === noteIndex}
                                      issue={noteEvidenceIssues[noteIndex] || null}
                                      onToggle={() => {
                                        const key = noteEvidenceKey(message.id, noteIndex);
                                        setExpandedCitationKey((current) =>
                                          current === key ? null : key,
                                        );
                                      }}
                                    />
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      {showFollowUps && (
                        <div className="reader-followups" role="group" aria-label="继续追问建议">
                          {FOLLOW_UP_PROMPTS.map((question) => (
                            <button
                              key={question}
                              type="button"
                              onClick={() => prepareFollowUp(question)}
                            >
                              {question}
                            </button>
                          ))}
                        </div>
                      )}
                      {message.role === "assistant" && message.content && !message.error && (
                        <div className="reader-message-actions">
                          <button
                            disabled={includesNoteEvidence}
                            title={
                              includesNoteEvidence
                                ? "此回答引用了个人笔记；为避免丢失这类依据，暂不能直接保存。"
                                : undefined
                            }
                            onClick={() => {
                              onSaveNote(
                                message.content,
                                message.citations,
                                "note",
                                message.mode === "model",
                              );
                              setNotice("回答已保存为笔记，来源引用一并保留。");
                            }}
                          >
                            <StickyNote size={13} />
                            保存笔记
                          </button>
                          <button
                            aria-expanded={saveTargetMessageId === message.id}
                            disabled={includesNoteEvidence || !onAppendToKnowledgePage}
                            title={
                              includesNoteEvidence
                                ? "此回答引用了个人笔记；为避免丢失这类依据，暂不能直接保存。"
                                : !onAppendToKnowledgePage
                                  ? "当前页面无法保存到既有知识页，请刷新后重试。"
                                  : undefined
                            }
                            onClick={() => openKnowledgeSaveTarget(message.id)}
                          >
                            <BookOpen size={13} />
                            保存到知识页
                          </button>
                        </div>
                      )}
                      {message.role === "assistant" &&
                        message.content &&
                        !message.error &&
                        saveTargetMessageId === message.id &&
                        !includesNoteEvidence && (
                          <div
                            className="reader-save-target"
                            role="group"
                            aria-label="保存回答到知识页"
                          >
                            <p>追加后会保留原文依据并新建一个历史版本，知识页将回到待审核状态。</p>
                            {knowledgePages.length ? (
                              <div className="reader-save-target-select">
                                <select
                                  aria-label="选择要追加的知识页"
                                  value={knowledgePageTargetId}
                                  onChange={(event) => setKnowledgePageTargetId(event.target.value)}
                                >
                                  <option value="">选择已有知识页</option>
                                  {knowledgePages.map((page) => (
                                    <option key={page.id} value={page.id}>
                                      {page.title || "未命名知识页"}
                                      {page.status === "draft" ? " · 待审核" : ""}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  className="btn btn-primary"
                                  disabled={!knowledgePageTargetId}
                                  onClick={() => appendAnswerToKnowledgePage(message)}
                                >
                                  追加到知识页
                                </button>
                              </div>
                            ) : (
                              <p className="reader-save-target-empty">
                                当前知识库还没有可追加的知识页。
                              </p>
                            )}
                            <div className="reader-save-target-actions">
                              <button
                                className="btn"
                                onClick={() => {
                                  onSaveNote(
                                    message.content,
                                    message.citations,
                                    "knowledge",
                                    message.mode === "model",
                                  );
                                  setSaveTargetMessageId(null);
                                  setNotice("已新建知识页草稿，来源引用一并保留。");
                                }}
                              >
                                <Plus size={13} />
                                新建知识页草稿
                              </button>
                              <button
                                className="btn"
                                onClick={() => {
                                  setSaveTargetMessageId(null);
                                  setKnowledgePageTargetId("");
                                }}
                              >
                                取消
                              </button>
                            </div>
                          </div>
                        )}
                    </div>
                  );
                })}
                {busy && answerDraft && (
                  <div
                    className="reader-message reader-message-assistant reader-message-draft"
                    role="group"
                    aria-label="正在生成的回答"
                    aria-busy="true"
                  >
                    <div className="reader-message-label">
                      <Sparkles size={14} />
                      Conuo{" "}
                      <span>
                        {stoppingAnswer ? "已停止 · 正在保留以上内容" : "生成中 · 尚未保存"}
                      </span>
                    </div>
                    <div className="reader-message-content">
                      <Markdown content={answerDraft.content} />
                    </div>
                    <details className="reader-draft-sources">
                      <summary>
                        本次段落依据 · {answerDraft.citations.length} 处原文
                        {answerDraft.noteEvidence?.length
                          ? ` + ${answerDraft.noteEvidence.length} 段我的笔记`
                          : ""}
                      </summary>
                      <ol>
                        {answerDraft.citations.map((citation, index) => (
                          <li key={`${citation.chunkId}-${index}`}>
                            <strong>
                              {citation.title} ·{" "}
                              {citation.page ? `第 ${citation.page} 页` : citation.section}
                            </strong>
                            <p>{citation.quote}</p>
                          </li>
                        ))}
                      </ol>
                      {!!answerDraft.noteEvidence?.length && (
                        <ul className="reader-draft-note-evidence">
                          {answerDraft.noteEvidence.map((evidence, index) => (
                            <li key={`${evidence.noteId}-${evidence.blockId}-${index}`}>
                              <strong>我的笔记 · {evidence.title}</strong>
                              <p>{evidence.quote}</p>
                            </li>
                          ))}
                        </ul>
                      )}
                    </details>
                    <p className="reader-draft-notice">
                      {answerDraft.noteEvidence?.length
                        ? "回答尚未完成；若最终引用个人笔记，会保留其快照而暂不支持直接另存。"
                        : "回答尚未完成，完成后可保存为笔记或知识页。"}
                    </p>
                  </div>
                )}
                {busy && (
                  <div className="reader-answer-progress" role="status">
                    <LoaderCircle size={17} className="reader-spin" />
                    {answerPhases[answerPhase]}
                  </div>
                )}
                <div ref={chatEnd} />
              </div>
              <form
                className="reader-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void ask();
                }}
              >
                {historical && (
                  <p className="reader-form-error">历史版本仅供阅读与摘录，请回到当前版本提问。</p>
                )}
                {!aiEnabled && (
                  <p className="reader-form-error">资料问答已关闭，可在设置中开启。</p>
                )}
                {error && (
                  <p className="reader-form-error" role="alert">
                    {error}
                  </p>
                )}
                <div className="reader-input-box">
                  <textarea
                    ref={questionInput}
                    aria-label="向资料提问"
                    aria-describedby={
                      !historical && askEligibilityMessage ? "reader-ask-eligibility" : undefined
                    }
                    value={input}
                    disabled={busy || historical || !aiEnabled}
                    rows={3}
                    maxLength={4000}
                    placeholder="从你不理解的地方开始提问…"
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        if (!askEligibilityMessage) void ask();
                      }
                    }}
                  />
                  <div className="reader-input-footer">
                    <span>
                      <FileText size={12} />
                      {scopeLabels[scope]}
                    </span>
                    {busy ? (
                      <button
                        type="button"
                        className="reader-send reader-stop"
                        aria-label="停止回答"
                        onClick={() => {
                          const active = controller.current;
                          if (!active) return;
                          manuallyStoppedController.current = active;
                          setStoppingAnswer(true);
                          active.abort();
                        }}
                      >
                        <Square size={14} fill="currentColor" />
                      </button>
                    ) : (
                      <button
                        type="submit"
                        className="reader-send"
                        aria-label="发送问题"
                        disabled={
                          historical || !input.trim() || !aiEnabled || !!askEligibilityMessage
                        }
                      >
                        <ArrowUp size={17} />
                      </button>
                    )}
                  </div>
                </div>
                <p className="reader-ai-footnote">
                  答案请结合原文判断 · Enter 发送，Shift + Enter 换行
                </p>
              </form>
            </aside>
          </>
        )}
      </div>
      {currentRegionCapture && props.cloudUserId && (
        <RegionStudyPanel
          capture={currentRegionCapture}
          sourceTitle={source.title}
          expectedUserId={props.cloudUserId}
          onClose={() => setRegionCapture(null)}
          onRecapture={() => {
            startRegionCapture();
          }}
        />
      )}
      <div className="reader-mobile-askbar">
        <button
          type="button"
          className="reader-mobile-ask-input"
          aria-label={historical ? "从底部查看已有问答" : "从底部打开问 AI"}
          onClick={() => {
            openAiPanel();
            focusAiInput();
          }}
        >
          <MessageSquare size={17} aria-hidden="true" />
          <span>{historical ? "查看这个版本的已有问答" : "问 AI：基于这篇资料提问"}</span>
        </button>
        <button
          type="button"
          className="reader-mobile-ask-send"
          aria-label={historical ? "打开已有问答" : "打开问 AI 输入"}
          onClick={() => {
            openAiPanel();
            focusAiInput();
          }}
        >
          <ArrowUp size={17} aria-hidden="true" />
        </button>
      </div>
      {androidMobileVariant && (
        <section className="reader-android-ai-peek" aria-label="问 AI 工作表">
          <button
            type="button"
            aria-label="展开问 AI 工作表"
            onClick={() => {
              openAiPanel();
              focusAiInput();
            }}
          >
            <span className="reader-android-ai-peek-grab" aria-hidden="true" />
            <span className="reader-android-ai-peek-title">
              {historical ? "已有问答 · 此资料" : "问 AI · 此资料 + 我的笔记"}
            </span>
            <span className="reader-android-ai-peek-hint">点击展开对话</span>
            <span className="reader-android-ai-peek-text">{androidPeekText}</span>
          </button>
        </section>
      )}
      {androidMobileVariant && (
        <button
          type="button"
          className="reader-android-ask-fab"
          aria-label="问 AI"
          title="问 AI"
          onClick={() => {
            openAiPanel();
            focusAiInput();
          }}
        >
          <Sparkles size={22} aria-hidden="true" />
        </button>
      )}
      <nav
        className={`reader-mobile-primary-nav${
          props.onOpenSettings ? "" : " reader-mobile-primary-nav-three"
        }`}
        aria-label="主导航"
      >
        <button type="button" aria-label={backLabel} onClick={onBack}>
          {contextualBackLabel ? (
            <ArrowLeft size={20} aria-hidden="true" />
          ) : (
            <FolderOpen size={20} aria-hidden="true" />
          )}
          <span>{mobileBackLabel}</span>
        </button>
        <button
          type="button"
          className="reader-mobile-primary-nav-active"
          aria-current="page"
          aria-label="返回阅读"
          onClick={closeAiPanel}
        >
          <BookOpen size={20} aria-hidden="true" />
          <span>阅读</span>
        </button>
        <button
          type="button"
          aria-label="打开问答"
          onClick={() => {
            openAiPanel();
            focusAiInput();
          }}
        >
          <MessageSquare size={20} aria-hidden="true" />
          <span>问答</span>
        </button>
        {props.onOpenSettings && (
          <button type="button" aria-label="打开我的" onClick={props.onOpenSettings}>
            <UserRound size={20} aria-hidden="true" />
            <span>我的</span>
          </button>
        )}
      </nav>
      {retainedPositionsOpen && (source.readingPositionAlternatives?.length ?? 0) > 0 && (
        <Modal title="已保留阅读位置" onClose={closeRetainedPositions} wide>
          <div className="modal-body sync-conflict-modal">
            <p className="sync-conflict-intro">
              这些位置来自你先前处理的多设备阅读冲突。切换后，当前进度也会保留，之后仍可从这里换回。
            </p>
            <section className="sync-conflict-card reading-conflict-card">
              <div className="sync-conflict-heading">
                <div>
                  <b>当前阅读位置</b>
                  <small>{readingPositionMetrics(source)}</small>
                  <small>{readingPositionTime(source.lastReadAt)}</small>
                </div>
                <span className="sync-conflict-selected">当前使用</span>
              </div>
              <strong>{readingPositionSummary(source, source.kind)}</strong>
            </section>
            <section className="sync-conflict-card reading-conflict-card">
              <div className="sync-conflict-heading">
                <div>
                  <b>可切换的位置</b>
                  <small>来源只用于帮助辨认，不参与自动排序。</small>
                </div>
                <span className="sync-conflict-selected">
                  {source.readingPositionAlternatives?.length} 个
                </span>
              </div>
              <div className="reading-conflict-choices" role="group" aria-label="可切换阅读位置">
                {source.readingPositionAlternatives?.map((alternative, index) => {
                  const origin = readingPositionOriginLabels[alternative.origin];
                  const summary = readingPositionSummary(alternative, source.kind);
                  return (
                    <button
                      key={`${alternative.readPage ?? ""}:${alternative.readOffset ?? ""}:${alternative.lastReadAt ?? ""}`}
                      type="button"
                      className={`reading-conflict-choice ${
                        alternative.origin === "remote" ? "remote" : "local"
                      }`}
                      aria-label={`切换到${origin}：${summary}`}
                      onClick={() => chooseRetainedPosition(index)}
                    >
                      <MapPin size={16} aria-hidden="true" />
                      <span>
                        <strong>{origin}</strong>
                        <b>{summary}</b>
                        <small>{readingPositionMetrics(alternative)}</small>
                        <small>{readingPositionTime(alternative.lastReadAt)}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
            <div className="modal-actions">
              <span className="muted">切换会同步为新的当前阅读位置。</span>
              <button type="button" className="btn" onClick={closeRetainedPositions}>
                关闭
              </button>
            </div>
          </div>
        </Modal>
      )}
      {excerptKnowledgeTarget && (
        <div className="reader-excerpt-dialog-layer" role="presentation">
          <button
            type="button"
            className="reader-excerpt-dialog-backdrop"
            aria-label="取消保存原文摘录"
            onClick={closeExcerptKnowledgeTarget}
          />
          <section
            ref={excerptSaveDialog}
            className="reader-excerpt-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reader-excerpt-dialog-title"
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeExcerptKnowledgeTarget();
              }
            }}
          >
            <div className="reader-excerpt-dialog-heading">
              <div>
                <span>原文摘录</span>
                <h2 id="reader-excerpt-dialog-title">保存到知识页</h2>
              </div>
              <button
                type="button"
                className="icon-btn"
                aria-label="关闭保存原文摘录"
                onClick={closeExcerptKnowledgeTarget}
              >
                <X size={16} />
              </button>
            </div>
            <p className="reader-excerpt-dialog-description">
              以下内容会作为人工摘录保存，始终指向当前资料版本，不会调用 AI。
            </p>
            <blockquote className="reader-excerpt-dialog-quote">
              {markdownQuoteText(source, excerptKnowledgeTarget.quote)}
            </blockquote>
            <p className="reader-excerpt-dialog-source">
              来源：{source.title}
              {source.kind === "pdf" && !showText
                ? ` · 第 ${excerptKnowledgeTarget.anchorPage ?? page} 页`
                : " · 当前阅读版"}
            </p>
            {knowledgePages.length > 0 && (
              <label className="reader-excerpt-dialog-select">
                追加到已有知识页
                <select
                  aria-label="选择要追加原文摘录的知识页"
                  value={excerptKnowledgePageTargetId}
                  onChange={(event) => setExcerptKnowledgePageTargetId(event.target.value)}
                >
                  <option value="">选择已有知识页</option>
                  {knowledgePages.map((knowledgePage) => (
                    <option key={knowledgePage.id} value={knowledgePage.id}>
                      {knowledgePage.title || "未命名知识页"}
                      {knowledgePage.status === "draft" ? " · 待审核" : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="reader-excerpt-dialog-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => saveExcerptToKnowledgePage()}
              >
                <Plus size={14} />
                新建知识页草稿
              </button>
              {knowledgePages.length > 0 && (
                <button
                  type="button"
                  className="btn"
                  disabled={!excerptKnowledgePageTargetId}
                  onClick={() => saveExcerptToKnowledgePage(excerptKnowledgePageTargetId)}
                >
                  追加到知识页
                </button>
              )}
              <button type="button" className="btn" onClick={closeExcerptKnowledgeTarget}>
                取消
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
