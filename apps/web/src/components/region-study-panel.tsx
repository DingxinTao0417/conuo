"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpenCheck,
  Check,
  Clipboard,
  Crop,
  HelpCircle,
  Lightbulb,
  LoaderCircle,
  RefreshCw,
  Send,
  X,
} from "lucide-react";
import type { PdfCaptureResult } from "./pdf-capture";
import { newReviewCard } from "@/lib/learning/fsrs";
import {
  getVisionRegionAvailability,
  requestVisionRegionStudy,
  VisionRegionClientError,
  type VisionRegionAvailability,
} from "@/lib/vision-region-client";
import type { VisionStudyResult } from "@/lib/vision-region-contract";
import RegionStudyMarkdown from "./region-study-markdown";
import "katex/dist/katex.min.css";
import "./region-study-panel.css";

type StudyTask = "explain" | "ask" | "quiz";
type WebVisionStudyResult = Exclude<VisionStudyResult, { task: "grade_work" }>;

const tasks: { id: StudyTask; label: string; description: string; icon: typeof Lightbulb }[] = [
  { id: "explain", label: "解读", description: "梳理图中内容与关键点", icon: Lightbulb },
  { id: "ask", label: "提问", description: "围绕这一区域问一个问题", icon: HelpCircle },
  { id: "quiz", label: "出题", description: "生成练习并核对答案", icon: BookOpenCheck },
];

export interface RegionStudyPanelProps {
  capture: PdfCaptureResult;
  sourceTitle: string;
  spaceId: string;
  expectedUserId: string;
  onClose: () => void;
  onRecapture: () => void;
}

function taskAction(task: StudyTask) {
  if (task === "ask") return "发送问题";
  if (task === "quiz") return "生成练习";
  return "开始解读";
}

function resultTitle(result: WebVisionStudyResult) {
  if (result.task === "ask") return "区域回答";
  if (result.task === "quiz") return "区域练习";
  return "区域解读";
}

function resultForClipboard(result: WebVisionStudyResult) {
  if (result.task !== "quiz") return result.content;
  return result.questions
    .map(
      (item, index) =>
        `${index + 1}. ${item.question}\n\n答案：${item.answer}\n\n解析：${item.explanation}`,
    )
    .join("\n\n");
}

const sectionLabels = {
  observation: "图中观察",
  reasoning: "分析推导",
  takeaway: "学习要点",
} as const;

export default function RegionStudyPanel({
  capture,
  sourceTitle,
  spaceId,
  expectedUserId,
  onClose,
  onRecapture,
}: RegionStudyPanelProps) {
  const [task, setTask] = useState<StudyTask>("explain");
  const [question, setQuestion] = useState("");
  const [availability, setAvailability] = useState<
    | { state: "checking" }
    | { state: "ready"; value: VisionRegionAvailability }
    | { state: "error"; message: string }
  >({ state: "checking" });
  const [result, setResult] = useState<WebVisionStudyResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [history, setHistory] = useState<Array<{ question: string; answer: string }>>([]);
  const [savedQuestions, setSavedQuestions] = useState<Set<number>>(new Set());
  const [previewUrl, setPreviewUrl] = useState("");
  const requestController = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const captureKey = `${capture.identity.sourceId}:${capture.identity.versionId}:${capture.identity.page}:${capture.region.x}:${capture.region.y}:${capture.region.width}:${capture.region.height}`;
  const provenanceLabel = useMemo(
    () =>
      `${sourceTitle} · 第 ${capture.identity.page} 页 · ${capture.width} × ${capture.height}px · ${Math.max(1, Math.ceil(capture.bytes / 1024))} KB`,
    [capture, sourceTitle],
  );

  useEffect(() => {
    const url = URL.createObjectURL(capture.blob);
    // The URL belongs to this exact capture and is never persisted.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [capture.blob]);

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      requestController.current?.abort();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function checkAvailability() {
    const controller = new AbortController();
    requestController.current?.abort();
    requestController.current = controller;
    setAvailability({ state: "checking" });
    setError("");
    try {
      const value = await getVisionRegionAvailability(expectedUserId, controller.signal);
      if (!controller.signal.aborted) setAvailability({ state: "ready", value });
    } catch (cause) {
      if (controller.signal.aborted) return;
      setAvailability({
        state: "error",
        message: cause instanceof Error ? cause.message : "无法检查区域视觉学习服务。",
      });
    } finally {
      if (requestController.current === controller) requestController.current = null;
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    requestController.current?.abort();
    requestController.current = controller;
    void getVisionRegionAvailability(expectedUserId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setAvailability({ state: "ready", value });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setAvailability({
          state: "error",
          message: cause instanceof Error ? cause.message : "无法检查区域视觉学习服务。",
        });
      })
      .finally(() => {
        if (requestController.current === controller) requestController.current = null;
      });
    return () => controller.abort();
  }, [captureKey, expectedUserId]);

  function chooseTask(next: StudyTask) {
    if (busy || task === next) return;
    setTask(next);
    setResult(null);
    setError("");
    setCopied(false);
    setRevealed(new Set());
  }

  async function run() {
    if (busy) return;
    if (availability.state !== "ready" || !availability.value.available) {
      setError(
        availability.state === "ready"
          ? availability.value.message
          : "正在确认多模态模型状态，请稍候。",
      );
      return;
    }
    if (task === "ask" && !question.trim()) {
      setError("请先写下你想问这一区域的问题。");
      return;
    }
    const controller = new AbortController();
    requestController.current = controller;
    setBusy(true);
    setResult(null);
    setError("");
    setCopied(false);
    setRevealed(new Set());
    try {
      const next = await requestVisionRegionStudy(
        {
          capture,
          task,
          requestId: crypto.randomUUID(),
          ...(task === "ask" ? { question } : {}),
          ...(task === "ask" && history.length ? { history } : {}),
        },
        expectedUserId,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        if (next.task === "grade_work") {
          setError("手写批改仅支持 iPad 区域学习。请在 iPad 上发送包含笔迹的截图。");
          return;
        }
        setResult(next);
        if (task === "ask" && next.task === "ask")
          setHistory((current) =>
            [...current, { question: question.trim(), answer: next.content }].slice(-3),
          );
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(
        cause instanceof VisionRegionClientError || cause instanceof Error
          ? cause.message
          : "区域视觉学习没有完成，请重试。",
      );
    } finally {
      if (requestController.current === controller) requestController.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function copyResult() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(resultForClipboard(result));
      setCopied(true);
    } catch {
      setError("复制失败，请手动选择结果文字。");
    }
  }

  async function saveQuizQuestion(
    question: { question: string; answer: string; explanation: string },
    index: number,
  ) {
    if (savedQuestions.has(index)) return;
    const card = newReviewCard();
    const response = await fetch("/api/v1/learning/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Conuo-User": expectedUserId },
      body: JSON.stringify({
        items: [
          {
            itemId: crypto.randomUUID().replaceAll("-", ""),
            spaceId,
            kind: "short",
            prompt: question.question,
            answer: { text: question.answer },
            explanation: question.explanation,
            citations: [],
            origin: "region",
            originRef: {
              sourceId: capture.identity.sourceId,
              versionId: capture.identity.versionId,
              page: capture.identity.page,
              rect: capture.region,
            },
            status: "active",
            card: card.card,
            dueAt: card.dueAt,
          },
        ],
      }),
    });
    if (!response.ok) {
      setError("加入复习失败，请稍后重试。");
      return;
    }
    setSavedQuestions((current) => new Set(current).add(index));
  }

  const available = availability.state === "ready" && availability.value.available;
  return (
    <div className="region-study-layer">
      <button
        type="button"
        className="region-study-backdrop"
        aria-label="关闭区域视觉学习"
        onClick={() => {
          requestController.current?.abort();
          onClose();
        }}
      />
      <section
        className="region-study-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="region-study-title"
      >
        <header className="region-study-header">
          <div>
            <span>区域视觉学习</span>
            <h2 id="region-study-title" ref={heading} tabIndex={-1}>
              用 AI 看懂这一区域
            </h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭区域视觉学习"
            onClick={() => {
              requestController.current?.abort();
              onClose();
            }}
          >
            <X size={18} />
          </button>
        </header>

        <div className="region-study-layout">
          <aside className="region-study-preview" aria-label="已截取的 PDF 区域">
            <div className="region-study-image-wrap">
              {previewUrl && (
                // This is a short-lived local Blob URL; Next Image cannot optimize it.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previewUrl}
                  alt={`来自${sourceTitle}第${capture.identity.page}页的框选区域`}
                />
              )}
            </div>
            <p>{provenanceLabel}</p>
            <button
              type="button"
              className="btn region-study-recapture"
              disabled={busy}
              onClick={() => {
                requestController.current?.abort();
                onRecapture();
              }}
            >
              <Crop size={15} />
              重新框选
            </button>
          </aside>

          <main className="region-study-main">
            <div className="region-study-task-tabs" role="tablist" aria-label="区域视觉学习方式">
              {tasks.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={task === item.id}
                    disabled={busy}
                    onClick={() => chooseTask(item.id)}
                  >
                    <Icon size={16} aria-hidden="true" />
                    <span>
                      <strong>{item.label}</strong>
                      <small>{item.description}</small>
                    </span>
                  </button>
                );
              })}
            </div>

            {task === "ask" && (
              <label className="region-study-question">
                <span>你想问什么？</span>
                <textarea
                  value={question}
                  maxLength={2_000}
                  rows={3}
                  disabled={busy}
                  placeholder="例如：图里的公式为什么要这样变形？"
                  onChange={(event) => setQuestion(event.target.value)}
                />
              </label>
            )}

            <div className="region-study-privacy">
              <Check size={15} aria-hidden="true" />
              <span>点击发送后只临时上传当前截图；页面其他内容与截图本身不会保存到资料库。</span>
            </div>

            <div className="region-study-readiness" aria-live="polite">
              {availability.state === "checking" ? (
                <span>
                  <LoaderCircle size={14} className="reader-spin" /> 正在检查多模态模型…
                </span>
              ) : availability.state === "error" ? (
                <span className="region-study-unavailable">
                  {availability.message}
                  <button type="button" onClick={() => void checkAvailability()}>
                    <RefreshCw size={13} /> 重新检查
                  </button>
                </span>
              ) : (
                <span className={availability.value.available ? "" : "region-study-unavailable"}>
                  {availability.value.message}
                </span>
              )}
            </div>

            {error && (
              <p className="region-study-error" role="alert">
                {error}
              </p>
            )}

            <button
              type="button"
              className="btn btn-primary region-study-run"
              disabled={busy || !available || (task === "ask" && !question.trim())}
              onClick={() => void run()}
            >
              {busy ? (
                <>
                  <LoaderCircle size={16} className="reader-spin" /> AI 正在查看区域…
                </>
              ) : (
                <>
                  <Send size={16} /> {taskAction(task)}
                </>
              )}
            </button>

            {result && (
              <section className="region-study-result" aria-live="polite">
                <header>
                  <div>
                    <span>基于第 {result.provenance.page} 页框选区域</span>
                    <h3>{resultTitle(result)}</h3>
                  </div>
                  <button type="button" className="btn" onClick={() => void copyResult()}>
                    {copied ? <Check size={14} /> : <Clipboard size={14} />}
                    {copied ? "已复制" : "复制"}
                  </button>
                </header>

                {result.task === "quiz" ? (
                  <ol className="region-study-quiz">
                    {result.questions.map((item, index) => {
                      const open = revealed.has(index);
                      return (
                        <li key={`${index}:${item.question}`}>
                          <div className="region-study-quiz-question">
                            <RegionStudyMarkdown content={item.question} />
                          </div>
                          <button
                            type="button"
                            onClick={() => void saveQuizQuestion(item, index)}
                            disabled={savedQuestions.has(index)}
                          >
                            {savedQuestions.has(index) ? "已加入复习" : "加入复习"}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setRevealed((current) => {
                                const next = new Set(current);
                                if (next.has(index)) next.delete(index);
                                else next.add(index);
                                return next;
                              })
                            }
                          >
                            {open ? "收起答案" : "查看答案"}
                          </button>
                          {open && (
                            <div className="region-study-quiz-answer">
                              <div>
                                <b>答案：</b>
                                <RegionStudyMarkdown content={item.answer} />
                              </div>
                              <div>
                                <b>解析：</b>
                                <RegionStudyMarkdown content={item.explanation} />
                              </div>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                ) : result.task === "explain" && result.summary && result.sections ? (
                  <div className="region-study-explanation">
                    <section className="region-study-summary" aria-label="内容概览">
                      <h4>内容概览</h4>
                      <RegionStudyMarkdown content={result.summary} />
                    </section>
                    {result.sections.map((section, index) => (
                      <section
                        key={`${index}:${section.kind}`}
                        className={`region-study-section region-study-section-${section.kind}`}
                      >
                        <header>
                          <span>{sectionLabels[section.kind]}</span>
                          <h4>{section.title}</h4>
                        </header>
                        <RegionStudyMarkdown content={section.content} />
                      </section>
                    ))}
                  </div>
                ) : (
                  <RegionStudyMarkdown content={result.content} />
                )}

                {result.visibleText?.trim() && (
                  <details className="region-study-visible-text">
                    <summary>模型看到的区域文字（可选转写）</summary>
                    <pre>{result.visibleText}</pre>
                  </details>
                )}
                <p className="region-study-result-note">
                  结果由多模态模型根据截图生成，请结合原图核对。
                </p>
              </section>
            )}
          </main>
        </div>
      </section>
    </div>
  );
}
