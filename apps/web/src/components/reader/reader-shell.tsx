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
  ChevronLeft,
  ChevronRight,
  Copy,
  Crop,
  ExternalLink,
  FileText,
  FolderOpen,
  Highlighter,
  History,
  List,
  MessageSquare,
  Minus,
  MapPin,
  Plus,
  Sparkles,
  StickyNote,
  UserRound,
  X,
} from "lucide-react";
import { convertDocxToStructure, type DocxBlock } from "@/lib/docx-structure";
import type {
  AnswerAttempt,
  Annotation,
  AnswerScopeSnapshot,
  Citation,
  Conversation,
  GlossaryTerm,
  Message,
  Source,
} from "@/lib/types";
import PdfReader from "../pdf-reader";
import OcrPageFlow from "../ocr-page-flow";
import type { PdfReadingMode } from "../pdf-reader";
import RegionStudyPanel from "../region-study-panel";
import DocxContent from "../docx-content";
import WebVersionPanel from "../web-version-panel";
import Modal from "../modal";
import { assertAnnotationSource, createAnnotation, updateAnnotation } from "@/lib/annotations";
import { priorUserQuestions } from "@/lib/answer-context";
import { answerRequestFromSnapshot } from "@/lib/answer-request";
import { citationProblem, findQuoteRange, quoteOffsets } from "../reader-utils";
import {
  annotationRangeResolver,
  readNativePdfSelectionPage,
  readPlainAnnotationSelection,
  locateUniqueTextAnchor,
} from "../annotation-selection";
import { markdownQuoteText, readMarkdownSelection } from "../markdown-selection";
import {
  deriveReaderOutline,
  normalizeReaderOutlineTitle,
  type ReaderOutlineItem,
} from "../reader-outline";
import { findReaderSearchRanges, readerSearchRoot } from "../reader-search";
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
import { documentAskScopeOf, readerAskScopes, type DocumentAskScope } from "@/lib/ask-scopes";
import AskPanel from "../ai/ask-panel";
import { useAskConversation } from "../ai/use-ask-conversation";
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
import { Markdown, noteEvidenceProblem } from "./answer-markdown";
import { useReaderPanels } from "./hooks/use-reader-panels";
import {
  EMPTY_NOTES,
  FOLLOW_UP_PROMPTS,
  READER_EMPTY_PROMPTS,
  READING_ACTIVITY_THROTTLE_MS,
  READING_OPEN_SETTLE_MS,
  highlightStyles,
  readingPositionMetrics,
  readingPositionOriginLabels,
  readingPositionSummary,
  readingPositionTime,
  scopeLabels,
  sourceStatusLabel,
} from "./reader-constants";
import AnnotationsPanel from "./panels/annotations-panel";
import CitationPreviewPanel from "./panels/citation-preview-panel";
import FindPanel from "./panels/find-panel";
import MobileCitationPage from "./panels/mobile-citation-page";
import OutlinePanel from "./panels/outline-panel";
import ReaderTopbar from "./reader-topbar";
import ReaderPageInput from "./reader-page-input";
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
  ReaderRegionTarget,
  RegionCaptureStart,
  SelectionToolbarPosition,
} from "./reader-types";
import { sourceOutlineCache, type OutlineItem } from "@/lib/source-outline";
import { useMembershipFeature } from "@/lib/use-membership-features";

function highlightGlossaryTerms(container: HTMLElement, terms: readonly GlossaryTerm[]) {
  container.querySelectorAll("mark[data-glossary-term]").forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    mark.remove();
  });
  for (const term of terms.filter((item) => item.status === "accepted")) {
    const variants = [term.term, ...term.aliases]
      .map((value) => ({ value, normalized: value.normalize("NFKC").toLocaleLowerCase("zh-CN") }))
      .filter((variant) => variant.normalized)
      .sort((left, right) => right.normalized.length - left.normalized.length);
    if (!variants.length) continue;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node: Text | null = null;
    let offset = -1;
    let matchLength = 0;
    while (walker.nextNode()) {
      const current = walker.currentNode as Text;
      const parent = current.parentElement;
      if (
        !parent ||
        parent.closest("mark,code,pre,a,button,.reader-image-placeholder") ||
        !current.data.trim()
      )
        continue;
      const normalizedText = current.data.normalize("NFKC").toLocaleLowerCase("zh-CN");
      const match = variants
        .map((variant) => ({ ...variant, index: normalizedText.indexOf(variant.normalized) }))
        .filter((variant) => variant.index >= 0)
        .sort(
          (left, right) =>
            left.index - right.index || right.normalized.length - left.normalized.length,
        )[0];
      if (match) {
        node = current;
        offset = match.index;
        matchLength = match.value.length;
        break;
      }
    }
    if (!node || offset < 0) continue;
    const mark = document.createElement("mark");
    mark.className = "reader-glossary-term";
    mark.dataset.glossaryTerm = term.termId;
    mark.title = term.definition.text;
    mark.setAttribute("role", "button");
    mark.tabIndex = 0;
    mark.setAttribute("aria-label", "术语：" + term.term + "。点击查看定义。");
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, Math.min(node.data.length, offset + matchLength));
    mark.appendChild(range.extractContents());
    range.insertNode(mark);
  }
  return () => {
    container.querySelectorAll("mark[data-glossary-term]").forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      mark.remove();
    });
  };
}

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
    initialRegion,
    onRegionConsumed,
  } = props;
  const liveSource = props.currentSource ?? sources.find((item) => item.id === source.id) ?? source;
  const historical = liveSource.versionId !== source.versionId;
  const visionRegionFeature = useMembershipFeature(props.cloudUserId, "vision_region");
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
  const [regionHighlight, setRegionHighlight] = useState<ReaderRegionTarget | null>(null);
  const pageRef = useRef(source.readPage || 1);
  const [pages, setPages] = useState(source.pageCount || 1);
  const [pdfReadingMode] = useState<PdfReadingMode>("continuous");
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
  const [scope, setScope] = useState<DocumentAskScope>("document-notes");
  const [selectedIds, setSelectedIds] = useState<string[]>([source.id]);
  const askConversation = useAskConversation();
  const {
    input,
    setInput,
    busy,
    answerDraft,
    setError,
    setHistoryOpen,
    selectedConversationId: selectedConversation,
    setSelectedConversationId: setSelectedConversation,
    newConversation,
    setNewConversation,
    setSaveTargetMessageId,
    knowledgePageTargetId,
    setKnowledgePageTargetId,
    questionInput,
    chatEnd,
    focusInput: focusAiInput,
    beginNewConversation,
    running: askRunning,
    abort: abortAsk,
    reset: resetAskConversation,
    run: runAsk,
  } = askConversation;
  const [notice, setNotice] = useState("");
  const panels = useReaderPanels();
  const {
    active: activePanel,
    versionsMode,
    citation: focusedCitation,
    citationError,
    setCitationError,
    open: openPanel,
    toggle: togglePanel,
    close: closePanel,
    focusCitation,
    clearCitation,
    reset: resetPanels,
  } = panels;
  const [annotationDraft, setAnnotationDraft] = useState<Pick<
    Annotation,
    "quote" | "page" | "textAnchor"
  > | null>(null);
  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string | null>(null);
  const [annotationFocusEpoch, setAnnotationFocusEpoch] = useState(0);
  const [annotationNote, setAnnotationNote] = useState("");
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [editingAnnotationNote, setEditingAnnotationNote] = useState("");
  const [search, setSearch] = useState("");
  const [searchResult, setSearchResult] = useState<ReaderSearchResult | null>(null);
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
  const [glossaryTerms, setGlossaryTerms] = useState<GlossaryTerm[]>([]);
  const [activeGlossaryTerm, setActiveGlossaryTerm] = useState<GlossaryTerm | null>(null);
  const [pdfOutlineItems, setPdfOutlineItems] = useState<OutlineItem[]>([]);
  const textContainer = useRef<HTMLDivElement>(null);
  const citationReturnButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchToggle = useRef<HTMLButtonElement>(null);
  const outlineToggle = useRef<HTMLButtonElement>(null);
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
  const outlineItems = useMemo(
    () => deriveReaderOutline(source, docxBlocks, pdfOutlineItems),
    [source, docxBlocks, pdfOutlineItems],
  );
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

  useEffect(() => () => abortAsk(), [abortAsk]);
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
  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => {
      if (disposed) return;
      setGlossaryTerms([]);
      setActiveGlossaryTerm(null);
    });
    if (historical || !props.cloudUserId || props.saveState !== "cloud" || !space.id)
      return () => {
        disposed = true;
      };
    const controller = new AbortController();
    void fetch("/api/v1/glossary?spaceId=" + encodeURIComponent(space.id), {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
      headers: { "X-Conuo-User": props.cloudUserId },
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((value: unknown) => {
        if (
          !value ||
          typeof value !== "object" ||
          !Array.isArray((value as { terms?: unknown }).terms)
        )
          return;
        setGlossaryTerms(
          (value as { terms: unknown[] }).terms.filter(
            (term): term is GlossaryTerm =>
              !!term &&
              typeof term === "object" &&
              (term as { status?: unknown }).status === "accepted",
          ),
        );
      })
      .catch(() => {
        // Glossary navigation is optional and never blocks source reading.
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [historical, props.cloudUserId, props.saveState, space.id]);
  useEffect(() => {
    const prose = textContainer.current?.querySelector<HTMLElement>("[data-reader-text]");
    if (!prose || !glossaryTerms.length) return;
    return highlightGlossaryTerms(prose, glossaryTerms);
  }, [glossaryTerms, source.id, source.versionId, docxBlocks, showText, renderRevision]);
  useEffect(() => {
    const currentSource = sourceRef.current;
    if (
      historical ||
      !props.cloudUserId ||
      props.saveState !== "cloud" ||
      (currentSource.kind !== "markdown" && currentSource.kind !== "docx")
    )
      return;
    const cached = sourceOutlineCache.get(currentSource);
    if (!cached) return;
    void fetch(
      `/api/v1/sources/${encodeURIComponent(currentSource.id)}/versions/${encodeURIComponent(currentSource.versionId)}/outline`,
      {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-Conuo-User": props.cloudUserId },
        body: JSON.stringify(cached),
      },
    ).catch(() => {
      // Outline persistence is derived navigation and must not block reading.
    });
  }, [historical, props.cloudUserId, props.saveState, source.id, source.kind, source.versionId]);
  useEffect(
    () => () => {
      if (readingPositionApplyFrame.current !== null)
        cancelAnimationFrame(readingPositionApplyFrame.current);
    },
    [],
  );
  useEffect(() => () => clearReaderSearchHighlights(), []);
  useEffect(() => {
    if (activePanel === "find") searchInput.current?.focus();
  }, [activePanel]);
  useEffect(() => {
    if (excerptKnowledgeTarget) excerptSaveDialog.current?.focus();
  }, [excerptKnowledgeTarget]);
  useEffect(() => {
    if (!historical) return;
    abortAsk();
    if (progressTimer.current) clearTimeout(progressTimer.current);
    progressTimer.current = null;
    if (readingSyncTimer.current) clearTimeout(readingSyncTimer.current);
    readingSyncTimer.current = null;
    pendingReadOffset.current = null;
    pendingReadPage.current = null;
    reportPendingReading(false);
  }, [abortAsk, historical]);
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
    clearCitation();
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
    activeSourceId.current = `${source.id}:${source.versionId}`;
    consumedInitialConversationId.current = null;
    // Drops the in-flight request, the composer draft and the open thread so a
    // late answer from the previous document can never land in this one.
    resetAskConversation();
    setSelection("");
    setPage(source.readPage || 1);
    pageRef.current = source.readPage || 1;
    pendingReadPage.current = null;
    savedReadPage.current = source.readPage || 1;
    setPdfNavigationRequest(0);
    setNativeSelectionPage(undefined);
    locatedReaderTarget.current = null;
    setPages(source.pageCount || 1);
    setPdfOutlineItems([]);
    setZoom(100);
    setShowText(false);
    regionCaptureStartRef.current = null;
    setRegionCaptureStart(null);
    setRegionCapture(null);
    setSelectedIds([source.id]);
    setScope("document-notes");
    setAnnotationDraft(null);
    setAnnotationNote("");
    setEditingAnnotationId(null);
    setEditingAnnotationNote("");
    setSearch("");
    setSearchResult(null);
    clearReaderSearchHighlights();
    resetPanels();
    setFocusedAnnotationId(null);
    setPlainSelectionAnchor(null);
    setExcerptKnowledgeTarget(null);
    setExcerptKnowledgePageTargetId("");
  }, [
    resetPanels,
    resetAskConversation,
    source.id,
    source.versionId,
    source.pageCount,
    source.readPage,
  ]);

  useEffect(() => {
    if (activePanel !== "source-actions") return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!sourceActions.current?.contains(event.target as Node)) closePanel();
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [activePanel, closePanel]);

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
    setScope(documentAskScopeOf(initialConversation.scope));
    setSelectedIds([...initialConversation.sourceIds]);
    setAiOpen(true);
    setMobileTab("ai");
  }, [history, props.initialConversationId, setNewConversation, setSelectedConversation]);

  useEffect(() => {
    const citation = initialCitation || pendingCitation.current;
    if (citation?.sourceId !== source.id || citation.versionId !== source.versionId) return;
    pendingCitation.current = null;
    const problem = citationProblem(citation, sources);
    // Apply an explicit navigation request after the parent has loaded its exact source.
    focusCitation(citation, problem || "");
    setMobileTab(isPhoneReaderLayout() ? "citation" : "reading");
    if (!problem && citation.page) {
      pageRef.current = citation.page;
      setPage(citation.page);
      setPdfNavigationRequest((value) => value + 1);
    }
    if (initialCitation) onCitationConsumed?.();
  }, [focusCitation, source.id, source.versionId, sources, initialCitation, onCitationConsumed]);

  useEffect(() => {
    if (
      !initialRegion ||
      initialRegion.sourceId !== source.id ||
      initialRegion.versionId !== source.versionId
    )
      return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRegionHighlight(initialRegion);
    pageRef.current = initialRegion.page;
    setPage(initialRegion.page);
    setPdfNavigationRequest((value) => value + 1);
    setMobileTab("reading");
    onRegionConsumed?.();
  }, [initialRegion, onRegionConsumed, source.id, source.versionId]);

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
  }, [chatEnd, messages.length, busy, answerDraft?.content]);

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
    if (!Number.isSafeInteger(value) || value < 1) return;
    setFocusedAnnotationId(null);
    if (!preserveCitation) clearCitation();
    locatedReaderTarget.current = null;
    const next = Math.max(1, Math.min(value, pages));
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
    closePanel();
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
    clearCitation();
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
    closePanel();
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
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 1024px)").matches
    );
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
    focusCitation(citation, problem || "");
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
    const presented = currentSelectionPresentation
      ? {
          quote: source.text.slice(
            currentSelectionPresentation.rawStart,
            currentSelectionPresentation.rawEnd,
          ),
          textAnchor: {
            start: currentSelectionPresentation.rawStart,
            end: currentSelectionPresentation.rawEnd,
          },
        }
      : plainSelectionAnchor?.sourceId === source.id &&
          plainSelectionAnchor.versionId === source.versionId &&
          plainSelectionAnchor.quote === selection
        ? { quote: selection, textAnchor: plainSelectionAnchor.textAnchor }
        : locateUniqueTextAnchor(source, selection);
    if (!presented) {
      setNotice(
        "无法唯一定位这段原文（可能跨片段、正文中有重复，或 PDF 文字层与提取文本不一致）。请改选一句完整原文，或切换到「解析文本」后再标注。",
      );
      return;
    }
    setAnnotationDraft({
      quote: presented.quote,
      page: source.kind === "pdf" && !showText ? (nativeSelectionPage ?? page) : undefined,
      textAnchor: { ...presented.textAnchor },
    });
    setAnnotationNote("");
    openPanel("annotations");
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
    if (!question || busy || askRunning()) return;
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
    setAiOpen(true);
    setMobileTab("ai");
    const attempt: AnswerAttempt = {
      id: crypto.randomUUID(),
      questionMessageId: questionMessage.id,
      scopeSnapshot: requestSnapshot,
      status: "completed",
    };
    const readerIdentity = `${source.id}:${source.versionId}`;
    await runAsk({
      accepts: () => activeSourceId.current === readerIdentity,
      dispatch: (signal, onProgress, depth, mode) =>
        onAsk(
          answerRequestFromSnapshot(requestSnapshot, {
            question,
            requestId: attempt.id,
            depth,
            mode,
            conversationId: next.id,
          }),
          signal,
          onProgress,
        ),
      onAnswer: (answer) => {
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
      },
      onFailure: ({ message, stoppedByUser, partial }) => {
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
      },
    });
  }

  function clearSearchResults() {
    clearReaderSearchHighlights();
    setSearchResult(null);
  }

  /**
   * Where focus belongs after a panel closes. A phone can have collapsed the
   * tool strip while the panel was open, in which case the control that
   * reopens that half is the nearest thing the learner can still see.
   */
  function visibleReaderTool(selector: string, fallback: HTMLButtonElement | null) {
    const workspace = readerWorkspace.current;
    const candidates = workspace?.querySelectorAll<HTMLButtonElement>(selector) || [];
    const visible = [...candidates].find((button) => button.getClientRects().length > 0);
    return visible || fallback;
  }

  function closeDocumentSearch() {
    clearSearchResults();
    closePanel();
    visibleReaderTool("[data-reader-search-trigger]", searchToggle.current)?.focus();
  }

  function toggleDocumentSearch(trigger: HTMLButtonElement) {
    searchToggle.current = trigger;
    if (activePanel === "find") closeDocumentSearch();
    else openPanel("find");
  }

  function toggleOutline(trigger: HTMLButtonElement) {
    outlineToggle.current = trigger;
    togglePanel("outline");
  }

  function closeOutline() {
    closePanel();
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
    if (item.kind === "pdf-outline" && item.page) {
      changePage(item.page);
      closePanel();
      return;
    }
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
      closePanel();
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
    closePanel();
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
          : !visionRegionFeature.ready || !visionRegionFeature.allowed
            ? visionRegionFeature.reason || "当前会员等级未开放区域截图学习。"
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

  function toggleRegionCapture() {
    if (!regionCaptureActive) {
      startRegionCapture();
      return;
    }
    cancelRegionCapture();
    setNotice("");
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

  function startRegionCapture() {
    if (regionStudyBlockedMessage || !props.cloudUserId) {
      setNotice(regionStudyBlockedMessage);
      return;
    }
    clearSearchResults();
    // Framing takes over pointer handling inside the page, so no drawer may
    // stay on top of the area the learner is about to select.
    closePanel();
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
        searchOpen={activePanel === "find"}
        sourceActionsOpen={activePanel === "source-actions"}
        sourceActions={sourceActions}
        sourceActionsToggle={sourceActionsToggle}
        onBack={onBack}
        sidebarCollapsed={props.sidebarCollapsed}
        onToggleSidebar={props.onToggleSidebar}
        onStartComparison={props.onStartComparison}
        onRefreshWeb={props.onRefreshWeb}
        onReplaceFile={props.onReplaceFile}
        download={download}
        openAiPanel={openAiPanel}
        closeAiPanel={closeAiPanel}
        isCompactReaderLayout={isCompactReaderLayout}
        toggleDocumentSearch={toggleDocumentSearch}
        panels={panels}
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
          {versionsMode && (
            <WebVersionPanel
              key={`${source.id}:${source.versionId}:${versionsMode}`}
              source={liveSource}
              displayedVersionId={source.versionId}
              spaceId={space.id}
              cloudUserId={props.cloudUserId}
              initialMode={versionsMode}
              onOpenSource={onOpenSource}
              onRefreshWeb={props.onRefreshWeb}
              onReplaceFile={props.onReplaceFile}
              onRestoreVersion={props.onRestoreVersion}
              onPreviewRemoveVersion={props.onPreviewRemoveVersion}
              onRemoveVersion={props.onRemoveVersion}
              onClose={closePanel}
            />
          )}
          {activePanel === "outline" && outlineItems.length > 0 && (
            <OutlinePanel
              outlineItems={outlineItems}
              closeOutline={closeOutline}
              jumpToOutlineItem={jumpToOutlineItem}
            />
          )}
          {activePanel === "find" && (
            <FindPanel
              search={search}
              searchResult={searchResult}
              searchInput={searchInput}
              showText={showText}
              source={source}
              setSearch={setSearch}
              clearSearchResults={clearSearchResults}
              closeDocumentSearch={closeDocumentSearch}
              findInDocument={findInDocument}
            />
          )}
          {activePanel === "citation" && focusedCitation && (
            <CitationPreviewPanel
              focusedCitation={focusedCitation}
              citationError={citationError}
              onClose={clearCitation}
            />
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
          {activePanel === "annotations" && (
            <AnnotationsPanel
              sourceAnnotations={sourceAnnotations}
              source={source}
              historical={historical}
              editingAnnotationId={editingAnnotationId}
              editingAnnotationNote={editingAnnotationNote}
              onAnnotationUpdate={onAnnotationUpdate}
              onAnnotationDelete={onAnnotationDelete}
              isWideReaderLayout={isWideReaderLayout}
              changePage={changePage}
              beginAnnotationEdit={beginAnnotationEdit}
              saveAnnotationEdit={saveAnnotationEdit}
              deleteAnnotation={deleteAnnotation}
              setEditingAnnotationId={setEditingAnnotationId}
              setEditingAnnotationNote={setEditingAnnotationNote}
              setFocusedAnnotationId={setFocusedAnnotationId}
              setAnnotationFocusEpoch={setAnnotationFocusEpoch}
              clearCitation={clearCitation}
              setAiOpen={setAiOpen}
              setMobileTab={setMobileTab}
              onClose={() => {
                closePanel();
                visibleReaderTool("[data-reader-annotation-trigger]", null)?.focus();
              }}
            />
          )}
          {source.originalMissing && (
            <div className="reader-warning" role="status">
              恢复备份时缺少此版本的原件。已有文字和引用记录仍保留；可切换到文字阅读，或重新选择文件保存为新版本。
            </div>
          )}
          <div
            className="reader-document-scroll"
            ref={textContainer}
            onScroll={saveReadingPosition}
          >
            {source.kind === "pdf" && !showText ? (
              <>
                {!historical && props.onReplaceFile && (
                  <OcrPageFlow
                    source={source}
                    getSourceBlob={props.getSourceBlob}
                    onReplaceFile={props.onReplaceFile}
                  />
                )}
                <PdfReader
                  key={`${source.id}:${source.versionId}`}
                  source={source}
                  cloudUserId={props.cloudUserId}
                  cloudSaveConfirmed={props.saveState === "cloud" && !historical}
                  onOutline={setPdfOutlineItems}
                  page={page}
                  highlightRegion={
                    regionHighlight?.sourceId === source.id &&
                    regionHighlight.versionId === source.versionId &&
                    regionHighlight.page === page
                      ? regionHighlight.rect
                      : undefined
                  }
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
              </>
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
                    onClick={(event) => {
                      const target = (event.target as HTMLElement).closest<HTMLElement>(
                        "mark[data-glossary-term]",
                      );
                      if (!target) return;
                      const term = glossaryTerms.find(
                        (item) => item.termId === target.dataset.glossaryTerm,
                      );
                      if (term) setActiveGlossaryTerm(term);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      const target = (event.target as HTMLElement).closest<HTMLElement>(
                        "mark[data-glossary-term]",
                      );
                      if (!target) return;
                      event.preventDefault();
                      const term = glossaryTerms.find(
                        (item) => item.termId === target.dataset.glossaryTerm,
                      );
                      if (term) setActiveGlossaryTerm(term);
                    }}
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
                {activeGlossaryTerm && (
                  <aside className="reader-glossary-card" role="dialog" aria-label="术语定义">
                    <div className="reader-glossary-card-heading">
                      <div>
                        <span>术语</span>
                        <h2>{activeGlossaryTerm.term}</h2>
                      </div>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label="关闭术语定义"
                        onClick={() => setActiveGlossaryTerm(null)}
                      >
                        <X size={16} />
                      </button>
                    </div>
                    <p>{activeGlossaryTerm.definition.text}</p>
                    <div className="reader-glossary-card-actions">
                      {activeGlossaryTerm.definition.chunkRefs.map((ref) => {
                        const targetSource = sources.find(
                          (item) => item.id === ref.sourceId && !item.deletedAt,
                        );
                        const chunk = targetSource?.chunks.find(
                          (item) =>
                            item.id === ref.chunkId &&
                            item.versionId === ref.versionId &&
                            item.sourceId === ref.sourceId,
                        );
                        if (!targetSource || targetSource.versionId !== ref.versionId || !chunk)
                          return (
                            <span
                              className="reader-glossary-stale"
                              key={ref.sourceId + ":" + ref.versionId + ":" + ref.chunkId}
                            >
                              原文版本已变化
                            </span>
                          );
                        return (
                          <button
                            type="button"
                            className="text-button"
                            key={ref.sourceId + ":" + ref.versionId + ":" + ref.chunkId}
                            onClick={() =>
                              onOpenSource(targetSource.id, targetSource.versionId, {
                                sourceId: targetSource.id,
                                versionId: targetSource.versionId,
                                chunkId: chunk.id,
                                title: targetSource.title,
                                quote: chunk.text,
                                section: chunk.section,
                                page: chunk.page,
                              })
                            }
                          >
                            查看原文 · {targetSource.title}
                          </button>
                        );
                      })}
                    </div>
                  </aside>
                )}
              </article>
            )}
          </div>
          <div
            className="reader-desktop-bottom-controls"
            data-reader-desktop-bottom-controls
            role="group"
            aria-label="页码与缩放"
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
                  <ReaderPageInput
                    sourceKey={`${source.id}:${source.versionId}`}
                    page={page}
                    pages={pages}
                    disabled={showText}
                    onCommit={changePage}
                  />
                </label>
                <span className="reader-tool-divider" aria-hidden="true" />
              </>
            )}
            {source.kind === "pdf" && (
              <button
                type="button"
                className="reader-tool-text"
                aria-pressed={showText}
                onClick={togglePdfText}
              >
                <FileText size={15} aria-hidden="true" />
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
                onClick={toggleRegionCapture}
              >
                <Crop size={14} aria-hidden="true" />
                <span>{regionCaptureActive ? "取消框选" : "区域学习"}</span>
              </button>
            )}
            {outlineItems.length > 0 && (
              <button
                type="button"
                className="reader-tool-text reader-outline-trigger"
                data-reader-outline-trigger
                aria-label={`打开资料目录（${outlineItems.length} 项）`}
                aria-controls="reader-outline-panel"
                aria-expanded={activePanel === "outline"}
                onClick={(event) => toggleOutline(event.currentTarget)}
              >
                <List size={15} aria-hidden="true" />
                目录
              </button>
            )}
            <button
              type="button"
              className="reader-tool-text reader-annotation-trigger"
              data-reader-annotation-trigger
              aria-label={`我的标注（${sourceAnnotations.length}）`}
              aria-controls="reader-annotations-panel"
              aria-expanded={activePanel === "annotations"}
              onClick={() => togglePanel("annotations")}
            >
              <Highlighter size={15} aria-hidden="true" />
              标注
              {sourceAnnotations.length > 0 && (
                <span className="reader-tool-count">{sourceAnnotations.length}</span>
              )}
            </button>
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
          <MobileCitationPage
            focusedCitation={focusedCitation}
            citationError={citationError}
            source={source}
            citationReturnButton={citationReturnButton}
            setMobileTab={setMobileTab}
            openCitationSource={openCitationSource}
            focusAiInput={focusAiInput}
          />
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
            <AskPanel
              ask={askConversation}
              feedbackUserId={props.cloudUserId}
              membershipUserId={props.cloudUserId}
              surface={{
                id: "reader-ai-panel",
                eligibilityId: "reader-ask-eligibility",
                label: "资料问答",
                title: historical ? "已有问答" : "问 AI",
                description: "",
                placeholder: "输入问题…",
                footnote: "Enter 发送 · Shift+Enter 换行",
                historyTitle: "对话",
                historyEmpty: "暂无对话",
                empty: {
                  title: "",
                  text: "",
                  prompts: READER_EMPTY_PROMPTS,
                },
                hidden: mobileTab === "citation",
              }}
              scope={{
                active: scope,
                options: readerAskScopes,
                locked: busy || historical,
                onChange: (next) => setScope(next as DocumentAskScope),
                blockedMessage:
                  !historical && askEligibilityMessage ? askEligibilityMessage : undefined,
                notice: !!ineligibleCount && (
                  <p className="reader-scope-warning" role="status">
                    范围中有 {ineligibleCount} 份资料尚未就绪或未允许 AI，不会作为回答依据。
                  </p>
                ),
                detail: (
                  <>
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
                    {scope === "document-notes" && documentNoteCount > 0 && (
                      <p className="reader-note-scope" role="status">
                        含 {documentNoteCount} 条关联笔记
                      </p>
                    )}
                  </>
                ),
                footer: !historical && !source.aiAllowed && (
                  <button
                    className="reader-enable"
                    disabled={busy}
                    onClick={() => onSourceChange({ aiAllowed: true })}
                  >
                    允许此资料用于 AI
                  </button>
                ),
              }}
              conversation={{
                current: conversation,
                history,
                onNew: () => {
                  beginNewConversation();
                  questionInput.current?.focus();
                },
                onSelect: (item) => {
                  setSelectedConversation(item.id);
                  setNewConversation(false);
                  setScope(documentAskScopeOf(item.scope));
                  setSelectedIds(item.sourceIds);
                  setHistoryOpen(false);
                  setError("");
                },
                onToggleResolved: (item) =>
                  onConversationChange({
                    ...item,
                    resolved: !item.resolved,
                    updatedAt: new Date().toISOString(),
                  }),
              }}
              messages={messages}
              evidence={{
                citationIssue: (citation) => citationProblem(citation, sources),
                noteEvidenceIssue: (item) => noteEvidenceProblem(item, notes, sources),
                onOpenCitation: openCitation,
              }}
              composer={{
                readOnly: historical,
                readOnlyMessage: "历史版本仅供阅读与摘录，请回到当前版本提问。",
                disabledMessage: aiEnabled ? undefined : "资料问答已关闭，可在设置中开启。",
                followUps: FOLLOW_UP_PROMPTS,
                onFollowUp: prepareFollowUp,
                onSubmit: () => void ask(),
                onRetry: (message) => void ask({ retryAttempt: message.attempt }),
                onEditQuestion: (content) => {
                  setInput(content);
                  questionInput.current?.focus();
                },
                scopeSummary: scopeLabels[scope],
              }}
              answerActions={{
                knowledgePages,
                blockedReason: (message) =>
                  message.noteEvidence?.length
                    ? "此回答引用了个人笔记；为避免丢失这类依据，暂不能直接保存。"
                    : undefined,
                onSaveNote: (message) => {
                  onSaveNote(message.content, message.citations, "note", message.mode === "model");
                  setNotice("回答已保存为笔记，来源引用一并保留。");
                },
                ...(onAppendToKnowledgePage
                  ? {
                      onAppendToKnowledgePage: appendAnswerToKnowledgePage,
                      onCreateKnowledgeDraft: (message: Message) => {
                        onSaveNote(
                          message.content,
                          message.citations,
                          "knowledge",
                          message.mode === "model",
                        );
                        setSaveTargetMessageId(null);
                        setNotice("已新建知识页草稿，来源引用一并保留。");
                      },
                    }
                  : {}),
              }}
              onClose={closeAiPanel}
            />
          </>
        )}
      </div>
      {currentRegionCapture && props.cloudUserId && (
        <RegionStudyPanel
          capture={currentRegionCapture}
          sourceTitle={source.title}
          spaceId={props.space.id}
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
          <span>{historical ? "已有问答" : "问 AI"}</span>
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
              {historical ? "已有问答" : "问 AI"}
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
      {activePanel === "positions" && (source.readingPositionAlternatives?.length ?? 0) > 0 && (
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
