"use client";
import { useState } from "react";
import type { ReadingProgressSyncSelection } from "@/lib/use-workspace";
import type { ReadingProgressSyncPlan } from "@/lib/sync-conflicts";
import type { Source } from "@/lib/types";
import Modal from "../../modal";
import { date } from "../shared";

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
