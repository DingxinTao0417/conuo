"use client";

import { useMemo, useRef, useState } from "react";
import type { PDFPageProxy } from "pdfjs-dist";
import type { Source } from "@/lib/types";
import { assembleDerivedPdfSource, ocrTargetPages } from "@/lib/ocr-assembly";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_LONG_EDGE = 1600;

type Props = {
  source: Source;
  getSourceBlob: (source: Source) => Promise<Blob | undefined>;
  onReplaceFile: (candidate: Source, blob: Blob, expectedVersionId: string) => Promise<void>;
};

type Progress = { done: number; total: number; page?: number };

function blobBase64(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((buffer) => {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < bytes.length; index += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary);
  });
}

async function renderPage(
  page: PDFPageProxy,
  scale: number,
): Promise<{ blob: Blob; width: number; height: number }> {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法绘制 PDF 页面。");
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error("PDF 页面图片生成失败。"))),
      "image/png",
    ),
  );
  return { blob, width: canvas.width, height: canvas.height };
}

async function pageImage(page: PDFPageProxy) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(1, MAX_LONG_EDGE / Math.max(base.width, base.height));
  let rendered = await renderPage(page, scale);
  if (rendered.blob.size > MAX_IMAGE_BYTES) rendered = await renderPage(page, scale * 0.75);
  if (rendered.blob.size > MAX_IMAGE_BYTES)
    throw new Error("页面图片超过 2 MiB，请降低 PDF 页面复杂度后重试。");
  return { ...rendered, base64: await blobBase64(rendered.blob), mimeType: "image/png" as const };
}

export default function OcrPageFlow({ source, getSourceBlob, onReplaceFile }: Props) {
  const unavailable = useMemo(() => ocrTargetPages(source), [source]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<number[]>(unavailable);
  const [manualPage, setManualPage] = useState("");
  const [results, setResults] = useState<Record<number, string>>({});
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const original = useRef<Blob | null>(null);
  const abort = useRef<AbortController | null>(null);

  if (
    source.kind !== "pdf" ||
    !source.coverage ||
    !["failed", "partial"].includes(source.coverage.parseState) ||
    source.originalMissing
  )
    return null;

  const togglePage = (page: number) =>
    setSelected((current) =>
      current.includes(page)
        ? current.filter((item) => item !== page)
        : [...current, page].sort((a, b) => a - b),
    );

  const addManualPage = () => {
    const page = Number(manualPage);
    if (!Number.isInteger(page) || page < 1 || (source.pageCount && page > source.pageCount))
      return;
    setSelected((current) =>
      current.includes(page) ? current : [...current, page].sort((a, b) => a - b),
    );
    setManualPage("");
  };

  const stop = () => {
    abort.current?.abort();
    abort.current = null;
    setProgress(null);
  };

  const transcribe = async () => {
    if (!selected.length || !source.pageCount) return;
    setError("");
    const controller = new AbortController();
    abort.current = controller;
    try {
      const blob = await getSourceBlob(source);
      if (!blob) throw new Error("原文件在当前设备不可用，请先恢复原件后重试。");
      original.current = blob;
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
      const pdf = await task.promise;
      const next: Record<number, string> = {};
      for (const [index, pageNumber] of selected.entries()) {
        if (controller.signal.aborted) break;
        setProgress({ done: index, total: selected.length, page: pageNumber });
        const page = await pdf.getPage(pageNumber);
        const image = await pageImage(page);
        const response = await fetch("/api/v1/vision/transcribe-page", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            sourceId: source.id,
            versionId: source.versionId,
            page: pageNumber,
            image: {
              mimeType: image.mimeType,
              base64: image.base64,
              width: image.width,
              height: image.height,
            },
          }),
          signal: controller.signal,
        });
        const payload: unknown = await response.json().catch(() => null);
        if (
          !response.ok ||
          !payload ||
          typeof payload !== "object" ||
          typeof (payload as { markdown?: unknown }).markdown !== "string"
        )
          throw new Error(
            (payload as { message?: string } | null)?.message || "页面识别未完成，请重试。",
          );
        next[pageNumber] = (payload as { markdown: string }).markdown;
        setResults({ ...next });
        page.cleanup();
        setProgress({ done: index + 1, total: selected.length });
      }
      await task.destroy();
      setProgress(null);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError"))
        setError(cause instanceof Error ? cause.message : "页面识别未完成，请重试。");
      setProgress(null);
    } finally {
      abort.current = null;
    }
  };

  const confirm = async () => {
    if (!original.current || !Object.keys(results).length) return;
    setSaving(true);
    setError("");
    try {
      const candidate = assembleDerivedPdfSource(source, results);
      await onReplaceFile(candidate, original.current, source.versionId);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存 OCR 新版本失败，请重试。");
    } finally {
      setSaving(false);
    }
  };

  if (!open)
    return (
      <section className="ocr-page-flow ocr-page-flow-collapsed" aria-label="扫描件识别">
        <strong>扫描件没有可检索文字</strong>
        <p>可在浏览器中逐页识别，确认后保存为新版本，原版本会保留。</p>
        <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
          识别缺失页面
        </button>
      </section>
    );

  return (
    <section className="ocr-page-flow" aria-label="扫描件识别">
      <header>
        <strong>扫描件 OCR</strong>
        <span>图片只在本次识别请求中发送，不会保存为服务器文件。</span>
      </header>
      <div className="ocr-page-flow-pages">
        {unavailable.map((page) => (
          <label key={page}>
            <input
              type="checkbox"
              checked={selected.includes(page)}
              onChange={() => togglePage(page)}
            />
            第 {page} 页
          </label>
        ))}
      </div>
      <div className="ocr-page-flow-manual">
        <input
          aria-label="手动加入页码"
          inputMode="numeric"
          value={manualPage}
          onChange={(event) => setManualPage(event.target.value)}
          placeholder="页码"
        />
        <button type="button" className="btn" onClick={addManualPage}>
          加入页面
        </button>
      </div>
      {progress && (
        <div role="status">
          正在识别第 {progress.page ?? ""} 页（{progress.done}/{progress.total}）…{" "}
          <button type="button" className="text-button" onClick={stop}>
            停止
          </button>
        </div>
      )}
      {Object.entries(results).map(([page, markdown]) => (
        <label key={page} className="ocr-page-flow-preview">
          第 {page} 页识别结果
          <textarea
            value={markdown}
            onChange={(event) =>
              setResults((current) => ({ ...current, [page]: event.target.value }))
            }
          />
        </label>
      ))}
      {error && <p className="error-text">{error}</p>}
      <footer>
        <button
          type="button"
          className="btn"
          onClick={() => {
            stop();
            setOpen(false);
          }}
        >
          取消
        </button>
        <button
          type="button"
          className="btn"
          disabled={!selected.length || !!progress}
          onClick={() => void transcribe()}
        >
          开始识别
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!Object.keys(results).length || saving || !!progress}
          onClick={() => void confirm()}
        >
          {saving ? "正在保存…" : "确认并保存新版本"}
        </button>
      </footer>
    </section>
  );
}
