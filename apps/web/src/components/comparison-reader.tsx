"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  FileText,
  History,
  Minus,
  PanelTop,
  Plus,
  Sparkles,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Citation, Source, Space } from "@/lib/types";
import { sourceCoverageLabel, sourcePresentationStatus } from "@/lib/source-coverage";
import ComparisonAskPanel, { type ComparisonAskPanelProps } from "./comparison-ai-panel";
import PdfReader from "./pdf-reader";
import "./comparison-reader.css";

export type ComparisonAskConfig = Pick<
  ComparisonAskPanelProps,
  "conversations" | "unavailableReason" | "onAsk" | "onConversationChange" | "initialConversationId"
>;

export type ComparisonReadingPatch = Partial<
  Pick<Source, "readPage" | "readOffset" | "lastReadAt">
>;

/**
 * The workspace owns the final version check. A comparison route can keep a
 * retained source readable, but only its live current version may update the
 * learner's reading continuation state.
 */
export interface ComparisonReadingProgress {
  isCurrentVersion: (source: Source) => boolean;
  onChange: (source: Source, patch: ComparisonReadingPatch) => void;
  /** Keeps delayed scroll intent separate from already committed workspace data. */
  onPendingChange?: (source: Source, pending: boolean) => void;
}

export interface ComparisonReaderProps {
  /** The exact, frozen source version shown in the left pane. */
  leftSource: Source;
  /** The exact, frozen source version shown in the right pane. */
  rightSource: Source;
  /** Both source versions have already been checked to belong to this space. */
  space: Space;
  /** Resolves bytes only for a source version the parent has already authorized. */
  getSourceBlob: (source: Source) => Promise<Blob | undefined>;
  onBack: () => void;
  /** Opens one source at the exact version currently shown in its pane. */
  onOpenSource: (sourceId: string, versionId?: string, citation?: Citation) => void;
  /** Optional because retained comparison routes remain fully readable offline. */
  readingProgress?: ComparisonReadingProgress;
  /** Monotonic signal for applying explicitly resolved positions to both panes in place. */
  readingPositionRevision?: number;
  /** The parent owns and revalidates the fixed two-source question boundary. */
  ask?: ComparisonAskConfig;
}

const READING_ACTIVITY_THROTTLE_MS = 15_000;
const READING_OPEN_SETTLE_MS = 1_500;
const READING_SCROLL_SETTLE_MS = 400;

const kindLabels: Record<Source["kind"], string> = {
  pdf: "PDF",
  docx: "DOCX",
  markdown: "Markdown",
  text: "TXT",
  web: "网页快照",
};

const statusLabels: Record<Source["status"], string> = {
  saved: "已保存，等待解析",
  parsing: "正在解析",
  ready: "可用于检索",
  partial: "部分内容可用",
  failed: "解析未完成",
  "link-only": "仅保存链接",
};

function sourceStatusLabel(source: Source) {
  return sourceCoverageLabel(source) || statusLabels[source.status];
}

function subscribeToCompactLayout(callback: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia("(max-width: 1024px)");
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

function compactLayoutSnapshot() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 1024px)").matches
  );
}

function useCompactComparisonLayout() {
  return useSyncExternalStore(subscribeToCompactLayout, compactLayoutSnapshot, () => false);
}

function formatVersionDate(source: Source) {
  const value = source.versionCreatedAt || source.webSnapshot?.capturedAt || source.createdAt;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "保存时间不可用" : date.toLocaleString("zh-CN");
}

/**
 * Markdown is rendered through ReactMarkdown without rehypeRaw. This small
 * allow-list prevents an imported URL from turning into an executable link.
 */
function safeMarkdownHref(href?: string) {
  if (!href) return undefined;
  const value = href.trim();
  return /^(?:https?:|mailto:|\/|#)/iu.test(value) ? value : undefined;
}

function ComparisonMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => {
          const safeHref = safeMarkdownHref(href);
          return safeHref ? (
            <a href={safeHref} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ) : (
            <span className="comparison-reader-unsafe-link">{children}</span>
          );
        },
        img: ({ alt }) => (
          <span className="comparison-reader-image-placeholder">[图片{alt ? `：${alt}` : ""}]</span>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function sameSourceVersion(left: Source, right: Source) {
  return left.id === right.id && left.versionId === right.versionId;
}

/**
 * Keeps each comparison pane's continuation state independent. The latest
 * workspace is asked whether a source is still current immediately before
 * every write, including delayed scroll and visibility callbacks.
 */
function useComparisonReadingProgress(
  source: Source,
  readingProgress?: ComparisonReadingProgress,
  readingPositionRevision?: number,
) {
  const sourceRef = useRef(source);
  const readingProgressRef = useRef(readingProgress);
  const lastReadReportedAt = useRef(0);
  const savedReadingActivityAt = useRef(0);
  const pendingReadOffset = useRef<number | null>(null);
  const savedReadOffset = useRef(source.readOffset || 0);
  const pendingNotice = useRef<{
    source: Source;
    notify: NonNullable<ComparisonReadingProgress["onPendingChange"]>;
  } | null>(null);
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readingSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appliedReadingPositionRevision = useRef(readingPositionRevision);

  useEffect(() => {
    sourceRef.current = source;
    readingProgressRef.current = readingProgress;
    if (!canSave(source)) clearPendingReading();
  });

  function canSave(candidate: Source) {
    return Boolean(readingProgressRef.current?.isCurrentVersion(candidate));
  }

  function clearPendingNotice() {
    const owner = pendingNotice.current;
    pendingNotice.current = null;
    // Release the callback that opened this notice, even if the parent has
    // since supplied another account, source or callback to this pane.
    owner?.notify(owner.source, false);
  }

  function clearPendingReading() {
    pendingReadOffset.current = null;
    if (progressTimer.current) clearTimeout(progressTimer.current);
    progressTimer.current = null;
    if (readingSyncTimer.current) clearTimeout(readingSyncTimer.current);
    readingSyncTimer.current = null;
    clearPendingNotice();
  }

  function markPendingReading(candidate: Source) {
    const notify = readingProgressRef.current?.onPendingChange;
    if (pendingNotice.current || !notify) return;
    pendingNotice.current = { source: candidate, notify };
    notify(candidate, true);
  }

  function reportReading(
    patch: Pick<ComparisonReadingPatch, "readPage" | "readOffset">,
    forceTimestamp = false,
  ) {
    const candidate = sourceRef.current;
    const progress = readingProgressRef.current;
    if (!progress || !canSave(candidate)) {
      clearPendingReading();
      return;
    }

    const current = Date.now();
    if (!forceTimestamp && current - lastReadReportedAt.current < READING_ACTIVITY_THROTTLE_MS)
      return;

    const storedActivityAt = Math.max(current, savedReadingActivityAt.current);
    lastReadReportedAt.current = current;
    savedReadingActivityAt.current = storedActivityAt;
    progress.onChange(candidate, {
      ...patch,
      lastReadAt: new Date(storedActivityAt).toISOString(),
    });
    if (patch.readOffset !== undefined) {
      savedReadOffset.current = patch.readOffset;
      clearPendingReading();
    }
  }

  function syncPendingReading() {
    if (pendingReadOffset.current === null || !canSave(sourceRef.current)) {
      clearPendingReading();
      return;
    }
    const wait = Math.max(
      0,
      lastReadReportedAt.current + READING_ACTIVITY_THROTTLE_MS - Date.now(),
    );
    if (wait > 0) {
      if (!readingSyncTimer.current) {
        readingSyncTimer.current = setTimeout(() => {
          readingSyncTimer.current = null;
          const offset = pendingReadOffset.current;
          if (
            offset !== null &&
            canSave(sourceRef.current) &&
            Math.abs(savedReadOffset.current - offset) > 8
          )
            syncPendingReading();
          else clearPendingReading();
        }, wait);
      }
      return;
    }

    const offset = pendingReadOffset.current;
    if (offset !== null && Math.abs(savedReadOffset.current - offset) > 8)
      reportReading({ readOffset: offset });
    else clearPendingReading();
  }

  function flushPendingReading() {
    const offset = pendingReadOffset.current;
    if (offset === null || !canSave(sourceRef.current)) {
      clearPendingReading();
      return;
    }
    if (Math.abs(savedReadOffset.current - offset) > 8) reportReading({ readOffset: offset }, true);
    else clearPendingReading();
  }

  function saveTextOffset(offset: number) {
    if (progressTimer.current) clearTimeout(progressTimer.current);
    const candidate = sourceRef.current;
    if (!canSave(candidate) || offset === savedReadOffset.current) {
      clearPendingReading();
      return;
    }
    pendingReadOffset.current = offset;
    markPendingReading(candidate);
    progressTimer.current = setTimeout(() => {
      progressTimer.current = null;
      if (
        sameSourceVersion(sourceRef.current, candidate) &&
        canSave(candidate) &&
        pendingReadOffset.current === offset &&
        Math.abs(savedReadOffset.current - offset) > 8
      ) {
        syncPendingReading();
      } else if (pendingReadOffset.current === offset) clearPendingReading();
    }, READING_SCROLL_SETTLE_MS);
  }

  useEffect(() => {
    const saved = Date.parse(source.lastReadAt || "");
    const now = Date.now();
    savedReadingActivityAt.current = Number.isFinite(saved) ? saved : 0;
    lastReadReportedAt.current = Number.isFinite(saved) && saved <= now ? saved : 0;
  }, [source.id, source.versionId, source.lastReadAt]);

  useEffect(() => {
    savedReadOffset.current = source.readOffset || 0;
    if (pendingReadOffset.current === savedReadOffset.current) clearPendingReading();
    // A save can update the baseline without discarding a later scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id, source.versionId, source.readOffset]);

  useEffect(() => {
    clearPendingReading();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id, source.versionId]);

  useEffect(() => {
    const previous = appliedReadingPositionRevision.current;
    appliedReadingPositionRevision.current = readingPositionRevision;
    if (
      previous === undefined ||
      readingPositionRevision === undefined ||
      readingPositionRevision <= previous
    )
      return;
    clearPendingReading();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readingPositionRevision]);

  useEffect(() => {
    const id = source.id;
    const versionId = source.versionId;
    const timer = setTimeout(() => {
      if (
        sourceRef.current.id === id &&
        sourceRef.current.versionId === versionId &&
        canSave(sourceRef.current)
      )
        reportReading({});
    }, READING_OPEN_SETTLE_MS);
    return () => clearTimeout(timer);
    // A visible comparison has two active reading surfaces, so each current
    // source receives its own activity signal after the same settle period as Reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id, source.versionId]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushPendingReading();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (progressTimer.current) clearTimeout(progressTimer.current);
      progressTimer.current = null;
      flushPendingReading();
      if (readingSyncTimer.current) clearTimeout(readingSyncTimer.current);
      readingSyncTimer.current = null;
      clearPendingNotice();
    };
    // The listener deliberately uses refs so a later source/version cannot be written by a stale closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { saveTextOffset, reportReading };
}

function ComparisonDocumentPane({
  source,
  side,
  getSourceBlob,
  onOpenSource,
  readingProgress,
  readingPositionRevision,
}: {
  source: Source;
  side: "left" | "right";
  getSourceBlob: (source: Source) => Promise<Blob | undefined>;
  onOpenSource: (sourceId: string, versionId?: string) => void;
  readingProgress?: ComparisonReadingProgress;
  readingPositionRevision?: number;
}) {
  const titleId = useId();
  const textContainer = useRef<HTMLDivElement>(null);
  const { reportReading, saveTextOffset } = useComparisonReadingProgress(
    source,
    readingProgress,
    readingPositionRevision,
  );
  const richText = source.kind === "markdown" || source.kind === "web";
  const pdfContent =
    source.kind === "pdf" ? (
      <ComparisonPdfPane
        source={source}
        getSourceBlob={getSourceBlob}
        onReadingProgress={(patch) => reportReading(patch, true)}
        readingPositionRevision={readingPositionRevision}
      />
    ) : null;

  useEffect(() => {
    if (source.kind === "pdf") return;
    const frame = requestAnimationFrame(() => {
      if (textContainer.current) textContainer.current.scrollTop = source.readOffset || 0;
    });
    return () => cancelAnimationFrame(frame);
    // Positions are restored only when this exact source changes. A save rerender must not pull an active reader back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id, source.versionId, source.kind, readingPositionRevision]);

  return (
    <section
      className="comparison-document-pane"
      data-comparison-side={side}
      aria-labelledby={titleId}
    >
      <header className="comparison-document-heading">
        <div className="comparison-document-heading-copy">
          <span className="comparison-document-side">
            {side === "left" ? "左侧资料" : "右侧资料"}
          </span>
          <h2 id={titleId} title={source.title}>
            {source.title}
          </h2>
          <div className="comparison-document-meta">
            <span>{kindLabels[source.kind]}</span>
            <span
              className={`comparison-document-status comparison-status-${sourcePresentationStatus(source)}`}
            >
              {sourceStatusLabel(source)}
            </span>
          </div>
          <p className="comparison-document-version" title={source.versionId}>
            <History size={12} aria-hidden="true" />
            固定版本 · {formatVersionDate(source)}
          </p>
        </div>
        <button
          type="button"
          className="btn comparison-open-source"
          onClick={() => onOpenSource(source.id, source.versionId)}
        >
          单独打开
        </button>
      </header>
      <div
        className="comparison-document-scroll"
        ref={textContainer}
        tabIndex={0}
        aria-label={`${source.title} 正文`}
        onScroll={
          source.kind === "pdf"
            ? undefined
            : () => saveTextOffset(textContainer.current?.scrollTop || 0)
        }
      >
        {pdfContent || <ComparisonTextContent source={source} richText={richText} />}
      </div>
    </section>
  );
}

function ComparisonPdfPane({
  source,
  getSourceBlob,
  onReadingProgress,
  readingPositionRevision,
}: {
  source: Source;
  getSourceBlob: (source: Source) => Promise<Blob | undefined>;
  onReadingProgress: (patch: Pick<ComparisonReadingPatch, "readPage">) => void;
  readingPositionRevision?: number;
}) {
  const [page, setPage] = useState(Math.max(1, source.readPage || 1));
  const [pages, setPages] = useState(Math.max(1, source.pageCount || 1));
  const [zoom, setZoom] = useState(100);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setPage(Math.max(1, Math.min(source.readPage || 1, Math.max(1, source.pageCount || pages))));
    });
    return () => cancelAnimationFrame(frame);
    // The source can receive ordinary progress updates without pulling an active pane back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readingPositionRevision]);

  function changePage(value: number) {
    const next = Math.max(1, Math.min(value || 1, pages));
    setPage(next);
    onReadingProgress({ readPage: next });
  }

  if (source.originalMissing) {
    return (
      <div className="comparison-document-fallback" role="status">
        <FileText size={19} aria-hidden="true" />
        <div>
          <strong>原始 PDF 不可用</strong>
          <p>这个固定版本缺少原始文件，无法在这里预览。可单独打开资料查看保留的解析内容。</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="comparison-pdf-controls" aria-label={`${source.title} PDF 阅读控制`}>
        <div className="comparison-pdf-page-control">
          <button
            type="button"
            className="icon-btn"
            aria-label={`${source.title} 上一页`}
            disabled={page <= 1}
            onClick={() => changePage(page - 1)}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <label>
            <span className="visually-hidden">{source.title} 跳转页码</span>
            <input
              aria-label={`${source.title} 跳转页码`}
              type="number"
              min={1}
              max={pages}
              value={page}
              onChange={(event) => changePage(Number(event.target.value))}
            />
          </label>
          <span>/ {pages}</span>
          <button
            type="button"
            className="icon-btn"
            aria-label={`${source.title} 下一页`}
            disabled={page >= pages}
            onClick={() => changePage(page + 1)}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="comparison-pdf-zoom-control">
          <button
            type="button"
            className="icon-btn"
            aria-label={`${source.title} 缩小`}
            disabled={zoom <= 60}
            onClick={() => setZoom((value) => Math.max(60, value - 10))}
          >
            <Minus size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="comparison-zoom-value"
            aria-label={`${source.title} 恢复默认缩放`}
            onClick={() => setZoom(100)}
          >
            {zoom}%
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={`${source.title} 放大`}
            disabled={zoom >= 200}
            onClick={() => setZoom((value) => Math.min(200, value + 10))}
          >
            <Plus size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
      <PdfReader
        source={source}
        page={page}
        zoom={zoom}
        getSourceBlob={getSourceBlob}
        onPages={(value) => {
          const nextPages = Math.max(1, value);
          setPages(nextPages);
          setPage((current) => Math.min(Math.max(1, current), nextPages));
        }}
        onRendered={() => {}}
      />
    </>
  );
}

function ComparisonTextContent({ source, richText }: { source: Source; richText: boolean }) {
  if (!source.text) {
    return (
      <div className="comparison-document-empty">
        <FileText size={28} aria-hidden="true" />
        <h3>
          {source.status === "link-only" ? "这个收藏仅保存了链接" : "暂时没有可阅读的解析文本"}
        </h3>
        <p>{source.error || "原文件仍然保留。可单独打开资料后下载查看，或等待解析完成。"}</p>
      </div>
    );
  }

  return (
    <article className="comparison-paper" style={{ fontSize: "16px" }}>
      <div className="comparison-prose" data-comparison-text="true">
        {richText ? (
          <ComparisonMarkdown content={source.text} />
        ) : (
          source.text.split(/\n\s*\n/gu).map((paragraph, index) => (
            <p className="comparison-plain-paragraph" key={index}>
              {paragraph}
            </p>
          ))
        )}
      </div>
    </article>
  );
}

function CompactFallback({
  sources,
  onOpenSource,
}: {
  sources: Source[];
  onOpenSource: (sourceId: string, versionId?: string) => void;
}) {
  return (
    <main className="comparison-reader-compact" aria-label="窄屏对照阅读提示">
      <section className="comparison-compact-notice" role="status">
        <PanelTop size={20} aria-hidden="true" />
        <div>
          <strong>当前屏幕不支持并排对照</strong>
          <p>请分别打开两份固定版本阅读；内容和版本不会在这里被修改。</p>
        </div>
      </section>
      <div className="comparison-compact-source-list">
        {sources.map((source, index) => (
          <article className="comparison-compact-source" key={`${source.id}:${source.versionId}`}>
            <div>
              <span>{index === 0 ? "第一份资料" : "第二份资料"}</span>
              <h2>{source.title}</h2>
              <p>
                {kindLabels[source.kind]} · {sourceStatusLabel(source)}
              </p>
              <small title={source.versionId}>固定版本 · {formatVersionDate(source)}</small>
            </div>
            <button
              type="button"
              className="btn comparison-open-source"
              onClick={() => onOpenSource(source.id, source.versionId)}
            >
              单独打开
            </button>
          </article>
        ))}
      </div>
    </main>
  );
}

export default function ComparisonReader({
  leftSource,
  rightSource,
  space,
  getSourceBlob,
  onBack,
  onOpenSource,
  readingProgress,
  readingPositionRevision,
  ask,
}: ComparisonReaderProps) {
  const compact = useCompactComparisonLayout();
  const [askOpen, setAskOpen] = useState(() => Boolean(ask?.initialConversationId));

  useEffect(() => {
    if (!ask?.initialConversationId) return;
    // A route can target a thread after this reader has mounted. Defer the
    // state sync one microtask so React does not report a cascading effect
    // update while still opening the exact requested thread.
    let active = true;
    queueMicrotask(() => {
      if (active) setAskOpen(true);
    });
    return () => {
      active = false;
    };
  }, [ask?.initialConversationId]);

  return (
    <section className="comparison-reader" aria-label="两份资料对照阅读">
      <header className="comparison-reader-topbar">
        <button type="button" className="icon-btn" aria-label="返回资料库" onClick={onBack}>
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
        <div className="comparison-reader-title">
          <h1>对照阅读</h1>
          <p>
            同一知识库 · <strong>{space.name}</strong>
          </p>
        </div>
        {ask && !compact && (
          <button
            type="button"
            className="btn comparison-reader-ask-toggle"
            aria-expanded={askOpen && !compact}
            onClick={() => setAskOpen((value) => !value)}
          >
            <Sparkles size={15} aria-hidden="true" />
            比较问 AI
          </button>
        )}
        <span className="comparison-reader-read-only">
          <History size={14} aria-hidden="true" />
          固定版本 · 只读
        </span>
      </header>
      {compact ? (
        <CompactFallback sources={[leftSource, rightSource]} onOpenSource={onOpenSource} />
      ) : (
        <main className="comparison-reader-body" aria-label="并排资料阅读区">
          <ComparisonDocumentPane
            key={`${leftSource.id}:${leftSource.versionId}`}
            side="left"
            source={leftSource}
            getSourceBlob={getSourceBlob}
            onOpenSource={onOpenSource}
            readingProgress={readingProgress}
            readingPositionRevision={readingPositionRevision}
          />
          <ComparisonDocumentPane
            key={`${rightSource.id}:${rightSource.versionId}`}
            side="right"
            source={rightSource}
            getSourceBlob={getSourceBlob}
            onOpenSource={onOpenSource}
            readingProgress={readingProgress}
            readingPositionRevision={readingPositionRevision}
          />
        </main>
      )}
      {!compact && ask && askOpen && (
        <>
          <button
            type="button"
            className="comparison-ai-backdrop"
            aria-label="关闭比较问答"
            onClick={() => setAskOpen(false)}
          />
          <ComparisonAskPanel
            key={ask.initialConversationId ?? "latest"}
            leftSource={leftSource}
            rightSource={rightSource}
            space={space}
            {...ask}
            onOpenSource={onOpenSource}
            onClose={() => setAskOpen(false)}
          />
        </>
      )}
    </section>
  );
}
