"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { newReviewCard } from "@/lib/learning/fsrs";
import type { LearningItem } from "@/lib/learning/types";
import type { GradeResult, HintResult } from "@/lib/ai/grading";
import type { Source, WorkspaceData } from "@/lib/types";
import type { WorkspaceUser } from "../types";
import { useMembershipFeature } from "@/lib/use-membership-features";

type Draft = Omit<LearningItem, "itemId" | "status" | "card" | "dueAt" | "createdAt" | "updatedAt">;
export type PracticeSectionProps = {
  data: WorkspaceData;
  spaceId: string;
  user: NonNullable<WorkspaceUser>;
  target?: { focus: string; itemIds: string[] };
};

function sourceFor(data: WorkspaceData, spaceId: string): Source | undefined {
  return data.sources.find(
    (source) =>
      !source.deletedAt &&
      source.aiAllowed &&
      (spaceId === "inbox" ? source.spaceIds.length === 0 : source.spaceIds.includes(spaceId)),
  );
}

export default function PracticeSection({ data, spaceId, user, target }: PracticeSectionProps) {
  const [items, setItems] = useState<LearningItem[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [grades, setGrades] = useState<Record<string, GradeResult>>({});
  const [hints, setHints] = useState<Record<string, HintResult>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const source = useMemo(() => sourceFor(data, spaceId), [data, spaceId]);
  const learningFeature = useMembershipFeature(user.id, "learning_ai");
  const learningAiReason = learningFeature.reason || "当前会员等级未开放学习 AI。";
  const headers = useCallback(
    () => ({ "Content-Type": "application/json", "X-Conuo-User": user.id }),
    [user.id],
  );
  const fetchItems = useCallback(async () => {
    const response = await fetch(`/api/v1/learning/items?spaceId=${encodeURIComponent(spaceId)}`, {
      headers: headers(),
    });
    if (!response.ok) throw new Error("练习题暂时无法读取。");
    const body = (await response.json()) as { items?: LearningItem[] };
    return body.items ?? [];
  }, [headers, spaceId]);
  const load = useCallback(async () => setItems(await fetchItems()), [fetchItems]);
  useEffect(() => {
    let active = true;
    void fetchItems()
      .then((next) => {
        if (active) setItems(next);
      })
      .catch((error) => {
        if (active) setMessage(error instanceof Error ? error.message : "练习题暂时无法读取。");
      });
    return () => {
      active = false;
    };
  }, [fetchItems]);
  async function generate() {
    if (!learningFeature.allowed) {
      setMessage(learningAiReason);
      return;
    }
    if (!source) {
      setMessage("当前空间还没有允许 AI 使用的资料。");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/v1/learning/generate", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          requestId: crypto.randomUUID().replaceAll("-", ""),
          source: {
            scope: "document",
            sourceId: source.id,
            sourceIds: [],
            sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
            spaceId,
          },
          count: 3,
          ...(target?.focus ? { focus: target.focus } : {}),
          ...(target?.itemIds.length ? { learningItemIds: target.itemIds } : {}),
        }),
      });
      const body = (await response.json()) as { items?: Draft[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "出题失败，请稍后重试。");
      setDrafts(body.items ?? []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "出题失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }
  async function save(draft: Draft) {
    const card = newReviewCard();
    const item: LearningItem = {
      ...draft,
      itemId: crypto.randomUUID().replaceAll("-", ""),
      spaceId,
      origin: "ai",
      originRef: { requestId: crypto.randomUUID().replaceAll("-", "") },
      status: "active",
      card: card.card,
      dueAt: card.dueAt,
    };
    const response = await fetch("/api/v1/learning/items", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ items: [item] }),
    });
    if (!response.ok) {
      setMessage("保存练习题失败，请稍后重试。");
      return;
    }
    setDrafts((current) => current.filter((value) => value !== draft));
    await load();
  }
  function updateDraft(index: number, prompt: string) {
    setDrafts((current) =>
      current.map((draft, position) => (position === index ? { ...draft, prompt } : draft)),
    );
  }
  async function grade(item: LearningItem) {
    if (!learningFeature.allowed) {
      setMessage(learningAiReason);
      return;
    }
    const answer = answers[item.itemId]?.trim();
    if (!answer) return;
    const response = await fetch("/api/v1/learning/grade", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        requestId: crypto.randomUUID().replaceAll("-", ""),
        itemId: item.itemId,
        answer,
      }),
    });
    const body = (await response.json()) as GradeResult & { error?: string; code?: string };
    if (!response.ok) {
      setMessage(
        body.code === "LEARNING_SOURCE_UNAVAILABLE"
          ? "题目依据的资料已变化，请对照参考答案自评。"
          : (body.error ?? "批改失败，请稍后重试。"),
      );
      return;
    }
    setGrades((current) => ({ ...current, [item.itemId]: body }));
  }
  async function hint(item: LearningItem) {
    if (!learningFeature.allowed) {
      setMessage(learningAiReason);
      return;
    }
    const response = await fetch("/api/v1/learning/hint", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        requestId: crypto.randomUUID().replaceAll("-", ""),
        itemId: item.itemId,
        level: 1,
      }),
    });
    const body = (await response.json()) as HintResult & { error?: string };
    if (response.ok) setHints((current) => ({ ...current, [item.itemId]: body }));
    else setMessage(body.error ?? "提示暂时不可用。");
  }
  async function setStatus(item: LearningItem, status: LearningItem["status"]) {
    await fetch(`/api/v1/learning/items/${encodeURIComponent(item.itemId)}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ status }),
    });
    await load();
  }
  return (
    <div className="content-scroll learning-practice-section">
      <div className="page-heading">
        <div>
          <p className="eyebrow">用自己的话检验理解</p>
          <h1>练习</h1>
          <p>
            {target?.focus
              ? `围绕“${target.focus}”生成题目。`
              : "题目先作为草稿展示，确认后才会加入复习。"}
          </p>
        </div>
        <button
          className="btn btn-primary"
          title={learningFeature.allowed ? undefined : learningAiReason}
          disabled={busy || !data.aiEnabled || !learningFeature.allowed}
          onClick={() => void generate()}
        >
          {busy ? "正在出题…" : "为当前资料出题"}
        </button>
      </div>
      {!learningFeature.allowed && (
        <div className="notice notice-warning" role="status">
          {learningAiReason}
        </div>
      )}
      {message && (
        <div className="notice notice-warning" role="status">
          {message}
        </div>
      )}
      {drafts.length > 0 && (
        <section aria-label="练习草稿">
          <h2>待确认草稿</h2>
          {drafts.map((draft, index) => (
            <article className="learning-practice-card" key={`${draft.prompt}-${index}`}>
              <textarea
                aria-label={`编辑练习草稿 ${index + 1}`}
                value={draft.prompt}
                onChange={(event) => updateDraft(index, event.target.value)}
              />
              <p>{draft.explanation}</p>
              <button className="btn" onClick={() => void save(draft)}>
                加入复习
              </button>
            </article>
          ))}
        </section>
      )}
      <section aria-label="已保存练习">
        <h2>已保存题目</h2>
        {items.length === 0 ? (
          <p className="muted">还没有练习题。</p>
        ) : (
          items.map((item) => (
            <article className="learning-practice-card" key={item.itemId}>
              <strong>{item.prompt}</strong>
              <textarea
                aria-label={`回答练习 ${item.prompt}`}
                value={answers[item.itemId] ?? ""}
                onChange={(event) =>
                  setAnswers((current) => ({ ...current, [item.itemId]: event.target.value }))
                }
                placeholder="写下你的答案，再请求批改"
              />
              <button
                className="btn"
                title={learningFeature.allowed ? undefined : learningAiReason}
                disabled={!answers[item.itemId]?.trim() || !learningFeature.allowed}
                onClick={() => void grade(item)}
              >
                AI 批改
              </button>
              <button
                className="text-button"
                title={learningFeature.allowed ? undefined : learningAiReason}
                disabled={!learningFeature.allowed}
                onClick={() => void hint(item)}
              >
                给我提示
              </button>
              {hints[item.itemId] && <p role="status">提示：{hints[item.itemId].hint}</p>}
              {grades[item.itemId] && <p role="status">{grades[item.itemId].feedback}</p>}
              <button
                className="text-button"
                onClick={() =>
                  setRevealed((current) => ({ ...current, [item.itemId]: !current[item.itemId] }))
                }
              >
                {revealed[item.itemId] ? "收起答案" : "查看答案"}
              </button>
              {revealed[item.itemId] && (
                <p>
                  参考答案：
                  {typeof item.answer.text === "string" ? item.answer.text : "请根据题目依据自评。"}
                </p>
              )}
              <p>
                {item.kind} · {item.status}
              </p>
              <button
                className="text-button"
                onClick={() =>
                  void setStatus(item, item.status === "suspended" ? "active" : "suspended")
                }
              >
                {item.status === "suspended" ? "恢复" : "暂停"}
              </button>
              <button className="text-button" onClick={() => void setStatus(item, "archived")}>
                归档
              </button>
            </article>
          ))
        )}
      </section>
    </div>
  );
}
