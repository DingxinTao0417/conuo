"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { PDFDocumentProxy, RenderTask, TextLayer } from "pdfjs-dist";
import type { Source } from "@/lib/types";
import { AlertCircle, LoaderCircle } from "lucide-react";
import PdfRegionSelector from "./pdf-region-selector";
import type { PdfCaptureLimits, PdfCaptureResult, PdfCaptureSelection } from "./pdf-capture";
import { startForegroundCloudUpdateChecks } from "@/lib/foreground-cloud-updates";
import {
  mergeInkPreviewPages,
  parseInkPreviewPages,
  type InkPreviewEntry,
} from "@/lib/ink-preview";

export type PdfReadingMode = "single" | "continuous";

export interface PdfReaderCaptureControl {
  active: boolean;
  busy?: boolean;
  limits?: Partial<PdfCaptureLimits>;
  onCapture: (capture: PdfCaptureResult) => void | Promise<void>;
  onCancel: () => void;
  onSelectionChange?: (selection: PdfCaptureSelection | null) => void;
}

interface Props {
  source: Source;
  cloudUserId?: string;
  page: number;
  zoom: number;
  getSourceBlob: (source: Source) => Promise<Blob | undefined>;
  onPages: (pages: number) => void;
  onRendered: () => void;
  capture?: PdfReaderCaptureControl;
  readingMode?: PdfReadingMode;
  navigationRequest?: number;
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  onVisiblePageChange?: (page: number) => void;
}

interface PdfReaderFrame {
  document: PDFDocumentProxy;
  sourceId: string;
  versionId: string;
  page: number;
  zoom: number;
  layoutWidth: number;
}

function PdfPage({
  source,
  page,
  zoom,
  onRendered,
  capture,
  pdf,
  pdfjs,
  width,
  active,
  readingMode,
  navigationRequest,
  onRetry,
  onPageNode,
  onSize,
  inkPreviewUrl,
}: {
  source: Source;
  page: number;
  zoom: number;
  onRendered: () => void;
  capture?: PdfReaderCaptureControl;
  pdf: PDFDocumentProxy;
  pdfjs: typeof import("pdfjs-dist");
  width: number;
  active: boolean;
  readingMode: PdfReadingMode;
  navigationRequest: number;
  onRetry: () => void;
  onPageNode: (page: number, node: HTMLDivElement | null) => void;
  onSize: (page: number, size: { width: number; height: number }) => void;
  inkPreviewUrl?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onRendered, onSize });
  useEffect(() => {
    callbacks.current = { onRendered, onSize };
  });
  const [naturalSize, setNaturalSize] = useState({ width: 600, height: 900 });
  const scale = (Math.min(width, 850) / naturalSize.width) * (zoom / 100);
  const size = { width: naturalSize.width * scale, height: naturalSize.height * scale };
  const [error, setError] = useState("");
  const [rendering, setRendering] = useState(false);
  const [renderedFrame, setRenderedFrame] = useState<PdfReaderFrame | null>(null);
  const [textLayerFrame, setTextLayerFrame] = useState<PdfReaderFrame | null>(null);
  const [textUnavailable, setTextUnavailable] = useState(false);

  const registerNode = useCallback(
    (node: HTMLDivElement | null) => onPageNode(page, node),
    [onPageNode, page],
  );
  const scope = `${source.id}\u0000${source.versionId}\u0000${page}\u0000${readingMode}\u0000${navigationRequest}\u0000${zoom}\u0000${width}`;
  const captureScope = useRef<string | null>(scope);
  useEffect(() => {
    captureScope.current = active && capture?.active ? scope : null;
    return () => {
      captureScope.current = null;
    };
  }, [scope, active, capture?.active]);
  const handleCapture = useCallback(
    async (result: PdfCaptureResult) => {
      if (captureScope.current === scope) await capture?.onCapture(result);
    },
    [capture, scope],
  );

  useEffect(() => {
    if (!active || !canvas.current || !textLayer.current) return;
    let disposed = false;
    let render: RenderTask | undefined;
    let layer: TextLayer | undefined;
    const renderedCanvas = canvas.current;
    const renderedTextLayer = textLayer.current;
    // Rendering external page pixels invalidates previous capture/text proofs.
    setRendering(true);
    setError("");
    setRenderedFrame(null);
    setTextLayerFrame(null);
    setTextUnavailable(false);
    void (async () => {
      try {
        const renderedPage = Math.max(1, Math.min(page, pdf.numPages));
        const pdfPage = await pdf.getPage(renderedPage);
        if (disposed || !canvas.current || !textLayer.current) return;
        const natural = pdfPage.getViewport({ scale: 1 });
        const scale = (Math.min(width, 850) / natural.width) * (zoom / 100);
        const viewport = pdfPage.getViewport({ scale });
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const node = canvas.current;
        const context = node.getContext("2d");
        if (!context) throw new Error("当前浏览器无法绘制 PDF，请下载原文件查看。");
        node.width = Math.floor(viewport.width * pixelRatio);
        node.height = Math.floor(viewport.height * pixelRatio);
        node.style.width = `${viewport.width}px`;
        node.style.height = `${viewport.height}px`;
        setNaturalSize({ width: natural.width, height: natural.height });
        callbacks.current.onSize(page, { width: viewport.width, height: viewport.height });
        const layerNode = textLayer.current;
        layerNode.replaceChildren();
        layerNode.style.setProperty(
          "--total-scale-factor",
          String(viewport.scale * viewport.userUnit),
        );
        layerNode.style.setProperty("--scale-round-x", "1px");
        layerNode.style.setProperty("--scale-round-y", "1px");
        render = pdfPage.render({
          canvas: node,
          canvasContext: context,
          viewport,
          transform: [pixelRatio, 0, 0, pixelRatio, 0, 0],
        });
        await render.promise;
        if (disposed) return;
        const frame: PdfReaderFrame = {
          document: pdf,
          sourceId: source.id,
          versionId: source.versionId,
          page: renderedPage,
          zoom,
          layoutWidth: width,
        };
        // Pixel capture does not depend on native PDF text extraction or selection.
        setRenderedFrame(frame);
        setRendering(false);
        callbacks.current.onRendered();

        try {
          const textContent = await pdfPage.getTextContent();
          // A late result must not construct a layer in a page/account's reused DOM.
          if (disposed) return;
          layer = new pdfjs.TextLayer({
            textContentSource: textContent,
            container: layerNode,
            viewport,
          });
          await layer.render();
          if (!disposed) {
            setTextLayerFrame(frame);
            callbacks.current.onRendered();
          }
        } catch {
          if (!disposed) {
            layer?.cancel();
            layerNode.replaceChildren();
            setTextLayerFrame(null);
            setTextUnavailable(true);
          }
        }
      } catch (cause) {
        if (!disposed && !(cause instanceof Error && cause.name === "RenderingCancelledException"))
          setError(cause instanceof Error ? cause.message : "这一页暂时无法显示。");
      } finally {
        if (!disposed) setRendering(false);
      }
    })();
    return () => {
      disposed = true;
      render?.cancel();
      layer?.cancel();
      renderedCanvas.width = 0;
      renderedCanvas.height = 0;
      renderedTextLayer.replaceChildren();
    };
  }, [active, pdf, pdfjs, page, source.id, source.versionId, width, zoom]);

  const visiblePage = pdf ? Math.max(1, Math.min(page, pdf.numPages)) : page;
  const captureReady =
    active &&
    !error &&
    !rendering &&
    renderedFrame?.document === pdf &&
    renderedFrame?.sourceId === source.id &&
    renderedFrame.versionId === source.versionId &&
    renderedFrame.page === visiblePage &&
    renderedFrame.zoom === zoom &&
    renderedFrame.layoutWidth === width;
  const textLayerReady = captureReady && textLayerFrame === renderedFrame;

  return (
    <div className="reader-pdf-overflow" aria-busy={active && rendering}>
      {readingMode === "continuous" && (
        <span className="reader-pdf-page-label">
          第 {page} 页 / {pdf.numPages} 页
        </span>
      )}
      {error && active && (
        <div className="reader-warning" role="alert">
          <AlertCircle size={18} />
          <div>
            <strong>PDF 预览暂不可用</strong>
            <p>{error}</p>
            <button className="btn" onClick={onRetry}>
              重试打开
            </button>
          </div>
        </div>
      )}
      {textUnavailable && captureReady && (
        <div className="reader-warning" role="status">
          <AlertCircle size={18} />
          <div>
            <strong>本页文字选取暂不可用</strong>
            <p>仍可阅读页面图像，或框选区域交给 AI 解读、问答和出题。</p>
          </div>
        </div>
      )}
      <div
        ref={registerNode}
        className="reader-pdf-page"
        style={size}
        data-reader-page={visiblePage}
      >
        {active ? (
          <>
            <canvas ref={canvas} aria-label={`原始 PDF 第 ${visiblePage} 页`} />
            {inkPreviewUrl && (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className="reader-pdf-ink-preview"
                  src={inkPreviewUrl}
                  alt={`第 ${visiblePage} 页的 Pencil 笔迹预览`}
                  draggable={false}
                />
              </>
            )}
            <div
              ref={textLayer}
              className="reader-pdf-text textLayer"
              data-reader-text={textLayerReady ? "true" : undefined}
              data-reader-source-id={textLayerReady ? textLayerFrame?.sourceId : undefined}
              data-reader-source-version={textLayerReady ? textLayerFrame?.versionId : undefined}
              data-reader-page={textLayerReady ? textLayerFrame?.page : undefined}
            />
            {capture?.active && (
              <PdfRegionSelector
                key={scope}
                canvasRef={canvas}
                identity={{
                  sourceId: source.id,
                  versionId: source.versionId,
                  page: visiblePage,
                }}
                ready={captureReady}
                busy={capture.busy}
                limits={capture.limits}
                onCapture={handleCapture}
                onCancel={capture.onCancel}
                onSelectionChange={capture.onSelectionChange}
              />
            )}
          </>
        ) : (
          <div
            className="reader-pdf-placeholder"
            aria-label={`PDF 第 ${page} 页，滚动到附近时加载`}
          />
        )}
      </div>
      {active && rendering && (
        <span className="reader-pdf-status" role="status">
          正在呈现第 {page} 页…
        </span>
      )}
    </div>
  );
}

const MAX_RENDERED_PAGES = 5;
const PRELOAD_DISTANCE = 500;

function boundedPage(page: number, pages: number) {
  return Math.max(1, Math.min(page, pages));
}

function nearbyPages(page: number, pages: number) {
  const numbers: number[] = [];
  for (let number = Math.max(1, page - 1); number <= Math.min(pages, page + 1); number++)
    numbers.push(number);
  return numbers;
}

function readingViewport(container: HTMLDivElement) {
  const bounds = container.getBoundingClientRect();
  const height = container.clientHeight || bounds.height;
  const bottom = bounds.top + height;
  let top = bounds.top;
  const toolbar = container.querySelector<HTMLElement>(".reader-document-tools");
  if (toolbar) {
    const style = window.getComputedStyle(toolbar);
    if (
      style.position === "sticky" &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse"
    ) {
      const toolbarBounds = toolbar.getBoundingClientRect();
      if (toolbarBounds.height > 0 && toolbarBounds.top < bottom && toolbarBounds.bottom > top)
        top = Math.min(bottom, Math.max(top, toolbarBounds.bottom));
    }
  }
  return { top, height: Math.max(0, bottom - top), bottom };
}

export default function PdfReader({
  source,
  cloudUserId,
  page,
  zoom,
  getSourceBlob,
  onPages,
  onRendered,
  capture,
  readingMode = "single",
  navigationRequest = 0,
  scrollContainerRef,
  onVisiblePageChange,
}: Props) {
  const wrapper = useRef<HTMLDivElement>(null);
  const pageNodes = useRef(new Map<number, HTMLDivElement>());
  const callbacks = useRef({ getSourceBlob, onPages, onRendered, onVisiblePageChange });
  const requestedPage = useRef(page);
  useLayoutEffect(() => {
    callbacks.current = { getSourceBlob, onPages, onRendered, onVisiblePageChange };
    requestedPage.current = page;
  });
  const [loaded, setLoaded] = useState<{
    document: PDFDocumentProxy;
    engine: typeof import("pdfjs-dist");
    sourceId: string;
    versionId: string;
  } | null>(null);
  const pdf =
    loaded?.sourceId === source.id && loaded.versionId === source.versionId
      ? loaded.document
      : null;
  const [width, setWidth] = useState(600);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [viewportPage, setViewportPage] = useState(page);
  const [activePages, setActivePages] = useState<number[]>([page]);
  const [inkPreviewState, setInkPreviewState] = useState<{
    key: string;
    pages: Record<number, InkPreviewEntry>;
  }>({ key: "", pages: {} });
  const inkPreviewKey = `${cloudUserId ?? ""}:${source.id}:${source.versionId}`;
  const inkPreviewPages =
    inkPreviewState.key === inkPreviewKey ? inkPreviewState.pages : {};
  const [layoutRevision, setLayoutRevision] = useState(0);
  const sizes = useRef(new Map<number, string>());
  const position = useRef({ page, fraction: 0 });
  const lastReportedPage = useRef(page);
  const navigationTarget = useRef<number | null>(null);
  const lastNavigation = useRef<{
    pdf: PDFDocumentProxy;
    mode: PdfReadingMode;
    request: number;
    width: number;
    zoom: number;
  } | null>(null);
  const registerPageNode = useCallback((number: number, node: HTMLDivElement | null) => {
    if (node) pageNodes.current.set(number, node);
    else pageNodes.current.delete(number);
  }, []);
  const handleSize = useCallback((number: number, size: { width: number; height: number }) => {
    const value = `${size.width}:${size.height}`;
    if (sizes.current.get(number) === value) return;
    sizes.current.set(number, value);
    setLayoutRevision((revision) => revision + 1);
  }, []);
  const handleRendered = useCallback(() => callbacks.current.onRendered(), []);
  const handleRetry = useCallback(() => setRetry((value) => value + 1), []);

  useEffect(() => {
    if (!cloudUserId || source.kind !== "pdf") return;
    let disposed = false;
    let lastUrlRefresh = 0;
    const stop = startForegroundCloudUpdateChecks(async (signal) => {
      const response = await fetch(
        `/api/v1/sources/${encodeURIComponent(source.id)}/versions/${encodeURIComponent(source.versionId)}/ink`,
        {
          credentials: "include",
          headers: {
            Accept: "application/json",
            "X-Conuo-User": cloudUserId,
          },
          signal,
        },
      );
      if (disposed || !response.ok) return;
      const payload: unknown = await response.json().catch(() => null);
      if (disposed) return;
      const next = parseInkPreviewPages(payload);
      const refreshUrls = Date.now() - lastUrlRefresh > 8 * 60_000;
      if (refreshUrls) lastUrlRefresh = Date.now();
      setInkPreviewState((prev) => {
        if (prev.key !== inkPreviewKey)
          return { key: inkPreviewKey, pages: next };
        const pages = mergeInkPreviewPages(prev.pages, next, { refreshUrls });
        if (pages === prev.pages) return prev;
        return { key: inkPreviewKey, pages };
      });
    });
    return () => {
      disposed = true;
      stop();
    };
  }, [cloudUserId, inkPreviewKey, source.id, source.kind, source.versionId]);

  useEffect(() => {
    if (!wrapper.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(220, entry.contentRect.width)),
    );
    observer.observe(wrapper.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    let task: ReturnType<(typeof import("pdfjs-dist"))["getDocument"]> | undefined;
    // Source identity alone owns the loading task; mode and progress reuse it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError("");
    setLoaded(null);
    sizes.current.clear();
    void (async () => {
      try {
        const blob = await callbacks.current.getSourceBlob(source);
        if (!blob) throw new Error("原文件在当前设备不可用，请检查云端连接或重新导入原文件。");
        const pdfjs = await import("pdfjs-dist");
        if (disposed) return;
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const data = new Uint8Array(await blob.arrayBuffer());
        if (disposed) return;
        task = pdfjs.getDocument({ data });
        const document = await task.promise;
        if (disposed) {
          await task.destroy();
          return;
        }
        setLoaded({ document, engine: pdfjs, sourceId: source.id, versionId: source.versionId });
        const current = boundedPage(requestedPage.current, document.numPages);
        setViewportPage(current);
        setActivePages(nearbyPages(current, document.numPages));
        callbacks.current.onPages(document.numPages);
      } catch (cause) {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : "PDF 打开失败，请下载原文件查看。");
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
      void task?.destroy();
    };
    // Reading progress updates must not reload or detach the underlying PDF.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id, source.versionId, retry]);

  const measureViewport = useCallback(() => {
    if (!pdf) return;
    const container =
      scrollContainerRef?.current ??
      wrapper.current?.closest<HTMLDivElement>(".reader-document-scroll");
    if (!container) return;
    const viewport = readingViewport(container);
    const height = viewport.height;
    const firstNode =
      pageNodes.current.get(1) ??
      pageNodes.current.get(boundedPage(requestedPage.current, pdf.numPages));
    if (!firstNode || height <= 0 || firstNode.getBoundingClientRect().height <= 0) return;
    const reference = viewport.top + Math.min(height * 0.25, 180);
    let current = boundedPage(requestedPage.current, pdf.numPages);
    if (readingMode === "continuous") {
      const target = navigationTarget.current;
      if (target !== null) {
        // An explicit jump is positioned once. A late viewport sample may include
        // the next page near the end of a page, so it must never hold scroll locked.
        navigationTarget.current = null;
        const targetBounds = pageNodes.current.get(target)?.getBoundingClientRect();
        const expectedTop = viewport.top - position.current.fraction * (targetBounds?.height ?? 0);
        if (targetBounds && Math.abs(targetBounds.top - expectedTop) > 2) {
          container.scrollTo({
            top:
              container.scrollTop +
              targetBounds.top -
              viewport.top +
              position.current.fraction * targetBounds.height,
            behavior: "instant",
          });
          return;
        }
      }
      // Page offsets are monotonic: long PDFs cost log(n) layout reads per scroll.
      let low = 1;
      let high = pdf.numPages;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const bounds = pageNodes.current.get(middle)?.getBoundingClientRect();
        if (bounds && bounds.bottom < reference) low = middle + 1;
        else high = middle;
      }
      current = low;
      const near: number[] = [];
      for (
        let number = Math.max(1, current - 2);
        number <= Math.min(pdf.numPages, current + 2);
        number++
      ) {
        const bounds = pageNodes.current.get(number)?.getBoundingClientRect();
        if (
          bounds &&
          bounds.bottom >= viewport.top - PRELOAD_DISTANCE &&
          bounds.top <= viewport.top + height + PRELOAD_DISTANCE
        )
          near.push(number);
      }
      if (!near.includes(current)) near.push(current);
      near.sort((left, right) => left - right);
      const next = near.slice(0, MAX_RENDERED_PAGES);
      setActivePages((previous) => (previous.join(",") === next.join(",") ? previous : next));
      setViewportPage(current);
      if (lastReportedPage.current !== current) {
        lastReportedPage.current = current;
        callbacks.current.onVisiblePageChange?.(current);
      }
    }
    const bounds = pageNodes.current.get(current)?.getBoundingClientRect();
    if (bounds && bounds.height > 0)
      position.current = {
        page: current,
        fraction: Math.max(0, Math.min(0.99, (viewport.top - bounds.top) / bounds.height)),
      };
  }, [pdf, readingMode, scrollContainerRef]);

  useLayoutEffect(() => {
    if (!pdf) return;
    const previous = lastNavigation.current;
    const changed =
      !previous ||
      previous.pdf !== pdf ||
      previous.mode !== readingMode ||
      previous.request !== navigationRequest ||
      previous.width !== width ||
      previous.zoom !== zoom;
    if (!changed) return;
    lastNavigation.current = { pdf, mode: readingMode, request: navigationRequest, width, zoom };
    const current = boundedPage(requestedPage.current, pdf.numPages);
    const explicit = !previous || previous.pdf !== pdf || previous.request !== navigationRequest;
    const fraction = !explicit && position.current.page === current ? position.current.fraction : 0;
    // Explicit navigation/mode transitions position the viewport; page feedback never does.
    setViewportPage(current);
    setActivePages(nearbyPages(current, pdf.numPages));
    lastReportedPage.current = current;
    navigationTarget.current = readingMode === "continuous" ? current : null;
    position.current = { page: current, fraction };
    const container =
      scrollContainerRef?.current ??
      wrapper.current?.closest<HTMLDivElement>(".reader-document-scroll");
    const node = pageNodes.current.get(current);
    if (container && node) {
      const viewport = readingViewport(container);
      const bounds = node.getBoundingClientRect();
      container.scrollTo({
        top: container.scrollTop + bounds.top - viewport.top + fraction * bounds.height,
        behavior: "instant",
      });
    }
  }, [pdf, readingMode, navigationRequest, scrollContainerRef, width, zoom]);

  useEffect(() => {
    const container =
      scrollContainerRef?.current ??
      wrapper.current?.closest<HTMLDivElement>(".reader-document-scroll");
    if (!container || !pdf) return;
    let pending = 0;
    const schedule = () => {
      if (pending) return;
      pending = window.requestAnimationFrame(() => {
        pending = 0;
        measureViewport();
      });
    };
    measureViewport();
    container.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      container.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (pending) window.cancelAnimationFrame(pending);
    };
  }, [pdf, measureViewport, scrollContainerRef, layoutRevision, navigationRequest]);

  const currentPage = pdf
    ? boundedPage(readingMode === "continuous" ? viewportPage : page, pdf.numPages)
    : page;
  const numbers = pdf
    ? readingMode === "continuous"
      ? Array.from({ length: pdf.numPages }, (_, index) => index + 1)
      : [boundedPage(page, pdf.numPages)]
    : [];
  return (
    <div
      ref={wrapper}
      className={`reader-pdf-wrap${readingMode === "continuous" ? " reader-pdf-continuous" : ""}`}
    >
      {loading && (
        <div className="reader-load" role="status">
          <LoaderCircle size={20} className="reader-spin" /> 正在打开原始 PDF…
        </div>
      )}
      {error && (
        <div className="reader-warning" role="alert">
          <AlertCircle size={18} />
          <div>
            <strong>PDF 预览暂不可用</strong>
            <p>{error}</p>
            <button className="btn" onClick={handleRetry}>
              重试打开
            </button>
          </div>
        </div>
      )}
      {pdf &&
        loaded &&
        numbers.map((number) => (
          <PdfPage
            key={`${source.id}:${source.versionId}:${number}`}
            pdf={pdf}
            pdfjs={loaded.engine}
            source={source}
            page={number}
            zoom={zoom}
            width={width}
            active={readingMode === "single" || activePages.includes(number)}
            readingMode={readingMode}
            navigationRequest={navigationRequest}
            capture={number === currentPage ? capture : undefined}
            onRendered={handleRendered}
            onRetry={handleRetry}
            onPageNode={registerPageNode}
            onSize={handleSize}
            inkPreviewUrl={inkPreviewPages[number]?.url}
          />
        ))}
      {!loading && pdf && (
        <p className="reader-pdf-tip">
          {capture?.active
            ? "区域截图仅在当前浏览器生成，确认前不会发送给 AI。"
            : "原始 PDF · 可选中文字进行高亮或提问，也可框选图像区域交给多模态 AI。"}
        </p>
      )}
    </div>
  );
}
