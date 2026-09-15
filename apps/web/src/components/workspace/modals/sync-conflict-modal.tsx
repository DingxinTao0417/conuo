"use client";
import { useState } from "react";
import type { NoteSyncConflictSelection } from "@/lib/use-workspace";
import type { NoteSyncPlan } from "@/lib/sync-conflicts";
import Modal from "../../modal";
import { date } from "../shared";

export default function SyncConflictModal({
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
