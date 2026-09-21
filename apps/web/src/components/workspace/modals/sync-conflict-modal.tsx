"use client";
import { useEffect, useMemo, useState } from "react";
import type { NoteSyncConflictSelection } from "@/lib/use-workspace";
import type { NoteSyncPlan } from "@/lib/sync-conflicts";
import { renderNoteForExport } from "@/lib/note-markdown";
import Modal from "../../modal";
import { NoteEditor } from "../lazy-panels";
import { date } from "../shared";

function ConflictNotePreview({ content, label }: { content: string; label: string }) {
  const html = useMemo(() => renderNoteForExport("", content).htmlBody, [content]);
  return (
    <div
      className="note-content sync-conflict-preview"
      role="region"
      aria-label={label}
      tabIndex={0}
      dangerouslySetInnerHTML={{ __html: html || "<p>正文为空</p>" }}
    />
  );
}

function ConflictMergeEditor({
  content,
  onChange,
}: {
  content: string;
  onChange: (html: string) => void;
}) {
  // This is display/input preparation only. The untouched original stays in
  // drafts; opening the editor must never normalize the submitted payload.
  const [html, setHtml] = useState(() => renderNoteForExport("", content).htmlBody);
  return (
    <NoteEditor
      content={html}
      onChange={(next) => {
        setHtml(next);
        onChange(next);
      }}
    />
  );
}

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
  type Draft = { choice?: NoteSyncConflictSelection["choice"]; content?: string; edited?: boolean };
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmExit, setConfirmExit] = useState(false);
  const hasEditedDraft = Object.values(drafts).some((draft) => draft.edited);
  useEffect(() => {
    if (!hasEditedDraft && !busy) return;
    const protectDraft = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectDraft);
    return () => window.removeEventListener("beforeunload", protectDraft);
  }, [hasEditedDraft, busy]);
  const requestClose = () => {
    if (busy) return;
    if (hasEditedDraft) setConfirmExit(true);
    else onClose();
  };
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
        content: current[conflictId]?.content ?? (choice === "manual" ? localContent : undefined),
        edited: current[conflictId]?.edited,
      },
    }));
  };
  const submit = async () => {
    if (busy) return;
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
    <>
      <Modal title="处理笔记同步冲突" onClose={requestClose} wide dismissible={!busy}>
        <div className="modal-body sync-conflict-modal">
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
                  <section className="sync-conflict-side local">
                    <span>{storageMode === "cloud" ? "当前页面修改" : "本机副本"}</span>
                    <small>修改于 {date(local.updatedAt)}</small>
                    <ConflictNotePreview content={local.content} label="当前页面正文" />
                  </section>
                  <section className="sync-conflict-side remote">
                    <span>云端副本</span>
                    <small>修改于 {date(remote.updatedAt)}</small>
                    <ConflictNotePreview content={remote.content} label="云端正文" />
                  </section>
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
                      disabled={busy}
                      onChange={() => choose(conflict.id, "local", local.content)}
                    />
                    {storageMode === "cloud" ? "保留当前页面版本" : "保留本机版本"}
                  </label>
                  <label>
                    <input
                      type="radio"
                      name={conflict.id}
                      checked={draft?.choice === "remote"}
                      disabled={busy}
                      onChange={() => choose(conflict.id, "remote", local.content)}
                    />
                    保留云端版本
                  </label>
                  <label>
                    <input
                      type="radio"
                      name={conflict.id}
                      checked={draft?.choice === "manual"}
                      disabled={busy}
                      onChange={() => choose(conflict.id, "manual", local.content)}
                    />
                    手动合并
                  </label>
                </div>
                {draft?.choice === "manual" && (
                  <section
                    className="sync-conflict-manual"
                    aria-label="合并后的正文"
                    aria-busy={busy}
                  >
                    <strong>合并后的正文</strong>
                    <small>
                      以当前页面版本为起点，直接编辑文字与格式；保存时会保留双方原始正文为历史。
                    </small>
                    <div inert={busy}>
                      <ConflictMergeEditor
                        content={draft.content ?? ""}
                        onChange={(content) =>
                          setDrafts((current) => ({
                            ...current,
                            [conflict.id]: { choice: "manual", content, edited: true },
                          }))
                        }
                      />
                    </div>
                  </section>
                )}
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
                ? "合并结果需得到云端确认，完成前请保持页面打开。"
                : "云端会在本机合并结果确认保存后再更新。"}
            </span>
            <button type="button" className="btn" onClick={requestClose} disabled={busy}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || incomplete}
              onClick={() => void submit()}
            >
              {busy
                ? "正在保存…"
                : plan.conflicts.length
                  ? "保存合并结果"
                  : storageMode === "cloud"
                    ? "合并当前页面独立笔记"
                    : "合并本机独立笔记"}
            </button>
          </div>
        </div>
      </Modal>
      {confirmExit && (
        <Modal title="放弃手动合并草稿？" onClose={() => setConfirmExit(false)} dismissible={!busy}>
          <div className="modal-body">
            <p>你编辑的合并正文尚未确认保存。离开将丢弃本次输入，两份原有笔记仍会保留。</p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setConfirmExit(false)}
              >
                继续编辑
              </button>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={onClose}>
                放弃草稿并离开
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
