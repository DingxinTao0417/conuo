"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fsrs, generatorParameters, Rating, type CardInput } from "ts-fsrs";
import {
  CloudError,
  gradeLearningAnswer,
  getLearningQueue,
  getLearningSettings,
  recordLearningReview,
  type LearningGradeResult,
  type LearningSettings,
} from "@/lib/cloud";
import { citationSchema } from "@/lib/citation-schema";
import { resolveSavedCitation } from "@/lib/retrieval";
import type { Citation, WorkspaceData } from "@/lib/types";
import type { LearningItem, ReviewRating } from "@/lib/learning/types";
import type { PdfCaptureRegion } from "@/components/pdf-capture";
import type { WorkspaceUser } from "../types";
import { useMembershipFeature } from "@/lib/use-membership-features";

export type ReviewSectionProps = {
  data: WorkspaceData;
  spaceId: string;
  user: NonNullable<WorkspaceUser>;
  openSource: (sourceId: string, versionId: string, citation?: Citation) => void;
  openRegion?: (sourceId: string, versionId: string, page: number, rect: PdfCaptureRegion) => void;
};

const ratingLabels: Record<ReviewRating, string> = {
  1: "忘了",
  2: "困难",
  3: "记得",
  4: "轻松",
};

function answerText(item: LearningItem) {
  const text = item.answer.text;
  return typeof text === "string" && text.trim() ? text : "请根据参考要点自评。";
}

function answerKeyPoints(item: LearningItem) {
  return Array.isArray(item.answer.keyPoints)
    ? item.answer.keyPoints.filter((value): value is string => typeof value === "string")
    : [];
}

function formatInterval(dueAt: Date) {
  const minutes = Math.max(1, Math.round((dueAt.getTime() - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时后`;
  return `${Math.max(1, Math.round(hours / 24))} 天后`;
}

function recommendation(verdict: LearningGradeResult["verdict"]): ReviewRating | undefined {
  if (verdict === "correct") return 3;
  if (verdict === "partial") return 2;
  if (verdict === "incorrect") return 1;
  return undefined;
}

function citationList(item: LearningItem): Citation[] {
  return item.citations.flatMap((value) => {
    const parsed = citationSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

function regionOrigin(item: LearningItem) {
  if (item.origin !== "region" || !item.originRef || typeof item.originRef !== "object")
    return null;
  const value = item.originRef as Record<string, unknown>;
  const sourceId = typeof value.sourceId === "string" ? value.sourceId : "";
  const versionId = typeof value.versionId === "string" ? value.versionId : "";
  const page = typeof value.page === "number" && Number.isSafeInteger(value.page) ? value.page : 0;
  const rect = value.rect;
  if (!sourceId || !versionId || page < 1 || !rect || typeof rect !== "object") return null;
  const candidate = rect as Record<string, unknown>;
  const values = [candidate.x, candidate.y, candidate.width, candidate.height];
  if (values.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) return null;
  const normalized = candidate as unknown as PdfCaptureRegion;
  if (
    normalized.x < 0 ||
    normalized.y < 0 ||
    normalized.width <= 0 ||
    normalized.height <= 0 ||
    normalized.x + normalized.width > 1 ||
    normalized.y + normalized.height > 1
  )
    return null;
  return { sourceId, versionId, page, rect: normalized };
}

function mergeLearningQueue(batches: LearningItem[][]): LearningItem[] {
  const seen = new Set<string>();
  return batches
    .flat()
    .filter((candidate) => {
      if (seen.has(candidate.itemId)) return false;
      seen.add(candidate.itemId);
      return true;
    })
    .sort((left, right) => (left.dueAt ?? "").localeCompare(right.dueAt ?? ""));
}

export default function ReviewSection({
  data,
  spaceId,
  user,
  openSource,
  openRegion,
}: ReviewSectionProps) {
  const targetSpaceIds = useMemo(
    () =>
      spaceId === "all"
        ? data.spaces.filter((space) => !space.archived).map((space) => space.id)
        : [spaceId],
    [data.spaces, spaceId],
  );
  const [queue, setQueue] = useState<LearningItem[]>([]);
  const [settings, setSettings] = useState<LearningSettings>({
    dailyNewLimit: 20,
    desiredRetention: 0.9,
    paused: false,
  });
  const [reviewing, setReviewing] = useState(false);
  const [answer, setAnswer] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const learningFeature = useMembershipFeature(user.id, "learning_ai");
  const learningAiReason = learningFeature.reason || "当前会员等级未开放学习 AI。";
  const [grade, setGrade] = useState<LearningGradeResult | null>(null);
  const item = queue[0];

  const load = useCallback(async () => {
    if (!targetSpaceIds.length) {
      setQueue([]);
      return;
    }
    const batches = await Promise.all(
      targetSpaceIds.map((id) => getLearningQueue(id, user.id, 100)),
    );
    setQueue(mergeLearningQueue(batches));
  }, [targetSpaceIds, user.id]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      Promise.all(targetSpaceIds.map((id) => getLearningQueue(id, user.id, 100))),
      getLearningSettings(user.id),
    ])
      .then(([batches, nextSettings]) => {
        if (active) {
          setQueue(mergeLearningQueue(batches));
          setSettings(nextSettings);
        }
      })
      .catch((error: unknown) => {
        if (active) setMessage(error instanceof Error ? error.message : "复习队列暂时无法读取。");
      });
    return () => {
      active = false;
    };
  }, [targetSpaceIds, user.id]);

  const previews = useMemo(() => {
    if (!item?.card) return new Map<ReviewRating, string>();
    try {
      const scheduler = fsrs(
        generatorParameters({
          request_retention: settings.desiredRetention,
          enable_fuzz: true,
        }),
      );
      const result = scheduler.repeat(item.card as unknown as CardInput, new Date());
      return new Map<ReviewRating, string>(
        ([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as ReviewRating[]).map((rating) => [
          rating,
          formatInterval(result[rating].card.due),
        ]),
      );
    } catch {
      return new Map<ReviewRating, string>();
    }
  }, [item, settings.desiredRetention]);

  function begin() {
    if (!item) return;
    setReviewing(true);
    setAnswer("");
    setRevealed(false);
    setGrade(null);
    setMessage("");
  }

  async function gradeAnswer() {
    if (!item || !answer.trim()) return;
    if (!learningFeature.allowed) {
      setMessage(learningAiReason);
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result = await gradeLearningAnswer(user.id, {
        requestId: crypto.randomUUID().replaceAll("-", ""),
        itemId: item.itemId,
        answer: answer.trim(),
      });
      setGrade(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "批改失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  const rate = useCallback(
    async (rating: ReviewRating) => {
      if (!item || !revealed || busy) return;
      setBusy(true);
      setMessage("");
      try {
        await recordLearningReview(user.id, {
          itemId: item.itemId,
          rating,
          answerText: answer.trim() || undefined,
          grade: grade ?? undefined,
          expectedVersion: item.version ?? 0,
        });
        const remaining = queue.filter((candidate) => candidate.itemId !== item.itemId);
        setQueue(remaining);
        setAnswer("");
        setRevealed(false);
        setGrade(null);
        if (!remaining.length) setReviewing(false);
      } catch (error) {
        if (
          error instanceof CloudError &&
          (error.status === 409 || error.code === "LEARNING_REVIEW_CONFLICT")
        ) {
          setMessage("这道题已在其他设备复习过");
          setReviewing(false);
          await load();
        } else {
          setMessage(error instanceof Error ? error.message : "复习记录未能保存，请稍后重试。");
        }
      } finally {
        setBusy(false);
      }
    },
    [answer, busy, grade, item, load, queue, revealed, user.id],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!reviewing || !item) return;
      const target = event.target as HTMLElement | null;
      const editing =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if (event.code === "Space" && !editing && !revealed) {
        event.preventDefault();
        setRevealed(true);
      }
      if (!editing && revealed && /^[1-4]$/u.test(event.key)) {
        event.preventDefault();
        void rate(Number(event.key) as ReviewRating);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [item, rate, revealed, reviewing]);

  const citations = item ? citationList(item) : [];
  const region = item ? regionOrigin(item) : null;
  const newCount = queue.filter((candidate) => (candidate.reps ?? 0) === 0).length;

  return (
    <div className="content-scroll learning-review-section">
      <div className="page-heading">
        <div>
          <p className="eyebrow">按间隔回顾已保存的题目</p>
          <h1>复习</h1>
          <p>
            今日到期 {queue.length} · 新题 {newCount}
          </p>
        </div>
        {!reviewing && (
          <button
            className="btn btn-primary"
            type="button"
            disabled={settings.paused || !item}
            onClick={begin}
          >
            开始复习
          </button>
        )}
      </div>
      {settings.paused && (
        <div className="notice notice-warning" role="status">
          复习已暂停，可在设置的“学习”分组中恢复。
        </div>
      )}
      {message && (
        <div className="notice notice-warning" role="status">
          {message}
        </div>
      )}
      {!reviewing && !settings.paused && !item && <p className="muted">今天没有待复习题目。</p>}
      {reviewing && item && (
        <article className="learning-review-card" aria-label="复习卡片">
          <p className="eyebrow">回顾题目</p>
          <h2>{item.prompt}</h2>
          {item.kind === "choice" && item.choices && (
            <div className="learning-review-choices" aria-label="选择答案">
              {item.choices.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className={answer === choice ? "selected" : ""}
                  aria-pressed={answer === choice}
                  onClick={() => setAnswer(choice)}
                >
                  {choice}
                </button>
              ))}
            </div>
          )}
          {item.kind === "recall" ? (
            <button type="button" className="btn" onClick={() => setAnswer("我想好了")}>
              我想好了
            </button>
          ) : item.kind !== "choice" ? (
            <textarea
              aria-label="复习作答"
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder="写下你的答案"
            />
          ) : null}
          {!revealed && (
            <button
              type="button"
              className="btn btn-primary"
              aria-label="查看答案"
              disabled={!answer.trim()}
              onClick={() => setRevealed(true)}
            >
              查看答案
            </button>
          )}
          {revealed && (
            <div className="learning-review-answer">
              <h3>参考答案</h3>
              <p>{answerText(item)}</p>
              {answerKeyPoints(item).length > 0 && (
                <ul>
                  {answerKeyPoints(item).map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              )}
              {item.explanation && <p>{item.explanation}</p>}
              {citations.length > 0 && (
                <div aria-label="参考引用">
                  {citations.map((citation, index) => {
                    const resolved = resolveSavedCitation(data, citation);
                    return resolved ? (
                      <button
                        type="button"
                        className="text-button"
                        key={`${citation.sourceId}:${citation.versionId}:${citation.chunkId}`}
                        onClick={() => openSource(citation.sourceId, citation.versionId, citation)}
                      >
                        打开原文位置 {index + 1}
                      </button>
                    ) : (
                      <span key={`${citation.sourceId}:${citation.versionId}:${citation.chunkId}`}>
                        来源已删除
                      </span>
                    );
                  })}
                </div>
              )}
              {item.origin === "region" && (
                <div aria-label="区域来源">
                  {region && openRegion ? (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        openRegion(region.sourceId, region.versionId, region.page, region.rect)
                      }
                    >
                      打开原页区域
                    </button>
                  ) : (
                    <span className="muted">原页区域已不可用</span>
                  )}
                </div>
              )}
              {answer.trim() && item.kind !== "recall" && (
                <div>
                  <button
                    type="button"
                    className="text-button"
                    title={learningFeature.allowed ? undefined : learningAiReason}
                    disabled={busy || !learningFeature.allowed}
                    onClick={() => void gradeAnswer()}
                  >
                    {busy ? "正在批改…" : "AI 批改（可选）"}
                  </button>
                  {!learningFeature.allowed && <small>{learningAiReason}</small>}
                  {grade && (
                    <p role="status">
                      {grade.feedback}
                      {recommendation(grade.verdict)
                        ? ` 建议：${ratingLabels[recommendation(grade.verdict)!]}。`
                        : ""}
                    </p>
                  )}
                </div>
              )}
              <div className="learning-review-ratings" aria-label="复习评分">
                {([1, 2, 3, 4] as ReviewRating[]).map((rating) => (
                  <button
                    key={rating}
                    type="button"
                    aria-label={`评分：${ratingLabels[rating]}`}
                    disabled={busy}
                    onClick={() => void rate(rating)}
                  >
                    <span>{ratingLabels[rating]}</span>
                    <small>{previews.get(rating) ?? "下次复习"}</small>
                  </button>
                ))}
              </div>
              <p className="muted">快捷键：空格查看答案，数字 1–4 评分。</p>
            </div>
          )}
        </article>
      )}
    </div>
  );
}
