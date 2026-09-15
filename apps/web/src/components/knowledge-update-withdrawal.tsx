"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Info, LoaderCircle, RotateCcw, ShieldCheck } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { WorkspaceData } from "@/lib/types";
import type { OrganizationJob } from "@/lib/organization-types";
import {
  previewKnowledgeUpdateWithdrawal,
  type KnowledgeUpdateWithdrawalPlan,
  type KnowledgeUpdateWithdrawalSelection,
} from "@/lib/knowledge-update-withdrawal";
import { renderNoteForExport } from "@/lib/note-markdown";
import "./knowledge-update-withdrawal.css";

export interface KnowledgeUpdateWithdrawalProps {
  data: WorkspaceData;
  job: OrganizationJob;
  contextKey: string;
  onWithdraw: (
    jobId: string,
    fingerprint: string,
    selections: KnowledgeUpdateWithdrawalSelection[],
  ) => Promise<void>;
  onEditCurrent?: () => void;
}

function HtmlPreview({ html }: { html: string }) {
  const markdown = useMemo(
    () => renderNoteForExport("段落", html).markdown.replace(/^#[^\n]*\n+/, ""),
    [html],
  );
  return markdown.trim() ? (
    <div className="organization-markdown knowledge-withdrawal-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ alt }) => <span>[图片{alt ? `：${alt}` : ""}]</span>,
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  ) : (
    <p className="knowledge-withdrawal-empty-text">此处没有正文</p>
  );
}

type Choice = {
  action: "restore" | "keep" | "merge" | "choose";
  candidateId?: string;
  text?: string;
};

function WithdrawalReview({
  data,
  job,
  onWithdraw,
  onEditCurrent,
}: KnowledgeUpdateWithdrawalProps) {
  const [plan, setPlan] = useState<KnowledgeUpdateWithdrawalPlan | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [pending, setPending] = useState<"preview" | "saving" | null>(null);
  const [error, setError] = useState("");
  const operation = useRef<object | null>(null);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current = null;
    };
  }, []);
  const receipt = job.updateReview?.withdrawal;
  const appliedCount = job.updateReview?.applied.length ?? 0;
  if (!appliedCount) return null;
  const run = async (
    kind: "preview" | "saving",
    action: (isCurrent: () => boolean) => Promise<void>,
  ) => {
    if (operation.current || !mounted.current) return;
    const marker = {};
    operation.current = marker;
    setPending(kind);
    setError("");
    const isCurrent = () => mounted.current && operation.current === marker;
    try {
      await action(isCurrent);
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : "撤回未完成，请重试。");
    } finally {
      if (isCurrent()) {
        operation.current = null;
        setPending(null);
      }
    }
  };
  const open = () =>
    void run("preview", async (isCurrent) => {
      const next = await previewKnowledgeUpdateWithdrawal(data, job.id);
      if (!isCurrent()) return;
      const defaults: Record<string, Choice> = {};
      for (const change of next.changes) {
        if (
          change.kind === "safe" &&
          change.candidates.length === 1 &&
          change.candidates[0].canRestore
        )
          defaults[change.id] = { action: "restore", candidateId: change.candidates[0].id };
      }
      setChoices(defaults);
      setPlan(next);
    });
  const selections: KnowledgeUpdateWithdrawalSelection[] = [];
  let unresolved = 0;
  for (const change of plan?.changes ?? []) {
    const choice = choices[change.id];
    const candidate = change.candidates.find((item) => item.id === choice?.candidateId);
    if (
      !choice ||
      choice.action === "choose" ||
      (choice.action !== "keep" &&
        (!candidate ||
          (choice.action === "restore" && !candidate.canRestore) ||
          (choice.action === "merge" && (!choice.text?.trim() || choice.text.length > 6000))))
    ) {
      unresolved += 1;
      continue;
    }
    selections.push(
      choice.action === "keep"
        ? { changeId: change.id, action: "keep" }
        : {
            changeId: change.id,
            action: "restore",
            candidateId: choice.candidateId,
            ...(choice.action === "merge" ? { text: choice.text } : {}),
          },
    );
  }
  const setChoice = (id: string, next: Choice) => setChoices((old) => ({ ...old, [id]: next }));
  return (
    <section className="knowledge-withdrawal" aria-label="撤回这次 AI 更新">
      <div className="knowledge-withdrawal-heading">
        <span className="knowledge-withdrawal-icon">
          <RotateCcw size={16} />
        </span>
        <div>
          <h4>{receipt ? "这次更新已封存" : "撤回这次 AI 更新"}</h4>
          <p>
            {receipt
              ? "撤回记录已写入当前页面，保存状态以顶部提示为准。此任务的建议不会再次应用。"
              : `已应用 ${appliedCount} 项。对照更新前后与当前内容，保留之后的独立编辑。`}
          </p>
        </div>
        {!receipt && !plan && (
          <button type="button" className="btn" disabled={Boolean(pending)} onClick={open}>
            {pending === "preview" ? (
              <LoaderCircle size={14} className="organization-spinner" />
            ) : (
              <RotateCcw size={14} />
            )}
            {pending === "preview" ? "正在对照" : "预览撤回"}
          </button>
        )}
      </div>
      {error && (
        <div className="knowledge-withdrawal-notice knowledge-withdrawal-error" role="alert">
          <Info size={15} />
          <span>{error}</span>
        </div>
      )}
      {plan && !receipt && (
        <>
          <div className="knowledge-withdrawal-notice" role="status">
            <ShieldCheck size={16} />
            <span>
              {plan.safeCount} 项可安全恢复，{plan.conflictCount}{" "}
              项需要选择。确认前不会修改正文；本次操作会留下恢复版本。
              {plan.reason ? ` ${plan.reason}` : ""}
            </span>
          </div>
          <div className="knowledge-withdrawal-changes">
            {plan.changes.map((change, index) => {
              const choice = choices[change.id];
              const selectedCandidate = change.candidates.find(
                (candidate) => candidate.id === choice?.candidateId,
              );
              const candidate =
                selectedCandidate ??
                (change.candidates.length === 1 ? change.candidates[0] : undefined);
              const pick = (action: Choice["action"]) =>
                setChoice(change.id, {
                  action,
                  ...(candidate ? { candidateId: candidate.id } : {}),
                  ...(action === "merge"
                    ? { text: choice?.text ?? candidate?.currentText ?? "" }
                    : {}),
                });
              return (
                <article className="knowledge-withdrawal-change" key={change.id}>
                  <div className="knowledge-withdrawal-change-title">
                    <strong>修改 {index + 1}</strong>
                    <span
                      className={`knowledge-withdrawal-badge${change.kind === "conflict" ? " knowledge-withdrawal-badge-conflict" : ""}`}
                    >
                      {change.kind === "safe" ? "可安全恢复" : "需要选择"}
                    </span>
                  </div>
                  {change.reason && <p className="knowledge-withdrawal-reason">{change.reason}</p>}
                  <div className="knowledge-withdrawal-comparison">
                    <div>
                      <h5>更新前</h5>
                      <HtmlPreview html={change.beforeHtml} />
                    </div>
                    <div>
                      <h5>AI 更新后</h5>
                      <HtmlPreview html={change.appliedHtml} />
                    </div>
                    <div>
                      <h5>当前内容</h5>
                      <HtmlPreview html={candidate?.currentHtml ?? change.currentHtml} />
                    </div>
                  </div>
                  {change.candidates.length > 1 && (
                    <label className="knowledge-withdrawal-position">
                      选择当前页面中的位置
                      <select
                        aria-label={`修改 ${index + 1} 的当前位置`}
                        value={choice?.candidateId ?? ""}
                        disabled={Boolean(pending)}
                        onChange={(event) => {
                          const found = change.candidates.find(
                            (item) => item.id === event.currentTarget.value,
                          );
                          setChoice(change.id, {
                            action:
                              choice?.action === "restore" && !found?.canRestore
                                ? "choose"
                                : (choice?.action ?? "choose"),
                            candidateId: found?.id,
                            ...(choice?.action === "merge"
                              ? { text: found?.currentText ?? "" }
                              : {}),
                          });
                        }}
                      >
                        <option value="">请选择位置</option>
                        {change.candidates.map((item, position) => (
                          <option key={item.id} value={item.id}>
                            位置 {position + 1} · {item.currentText.slice(0, 80) || "空白位置"}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <fieldset className="knowledge-withdrawal-choices" disabled={Boolean(pending)}>
                    <legend>修改 {index + 1} 的处理方式</legend>
                    <label>
                      <input
                        type="radio"
                        name={`withdraw-${job.id}-${change.id}`}
                        value="restore"
                        checked={choice?.action === "restore"}
                        disabled={!candidate?.canRestore}
                        onChange={() => pick("restore")}
                      />
                      <span>
                        恢复更新前的内容<span>保留能确认的后续独立编辑</span>
                      </span>
                    </label>
                    <label>
                      <input
                        type="radio"
                        name={`withdraw-${job.id}-${change.id}`}
                        value="keep"
                        checked={choice?.action === "keep"}
                        onChange={() => pick("keep")}
                      />
                      <span>
                        保留当前内容<span>封存这项更新，不再改动正文</span>
                      </span>
                    </label>
                    <label>
                      <input
                        type="radio"
                        name={`withdraw-${job.id}-${change.id}`}
                        value="merge"
                        checked={choice?.action === "merge"}
                        disabled={!candidate}
                        onChange={() => pick("merge")}
                      />
                      <span>
                        手工合并<span>仅修改选定位置，按纯文本保存</span>
                      </span>
                    </label>
                  </fieldset>
                  {candidate?.reason && (
                    <p className="knowledge-withdrawal-reason">{candidate.reason}</p>
                  )}
                  {choice?.action === "merge" && (
                    <label className="knowledge-withdrawal-merge">
                      合并后的内容
                      <textarea
                        aria-label={`修改 ${index + 1} 的手工合并内容`}
                        value={choice.text ?? ""}
                        maxLength={6000}
                        disabled={Boolean(pending)}
                        onChange={(event) =>
                          setChoice(change.id, { ...choice, text: event.currentTarget.value })
                        }
                      />
                      <span>
                        请保留你需要的人工编辑。引用标记会作为正文保留，引用是否有效可在知识页核对。
                      </span>
                    </label>
                  )}
                  {choice?.action === "restore" && candidate?.canRestore && (
                    <div className="knowledge-withdrawal-outcome">
                      <h5>恢复后的这处内容</h5>
                      <HtmlPreview html={candidate.restoreHtml} />
                    </div>
                  )}
                </article>
              );
            })}
          </div>
          <div className="knowledge-withdrawal-footer">
            <div>
              <strong>{unresolved ? `还有 ${unresolved} 项需要选择` : "处理方式已选好"}</strong>
              <p>撤回会封存本次任务。后续同步状态仍以顶部提示为准。</p>
              {plan.conflictCount > 0 && onEditCurrent && (
                <button
                  type="button"
                  className="organization-text-button knowledge-withdrawal-edit"
                  disabled={Boolean(pending)}
                  onClick={onEditCurrent}
                >
                  <ArrowLeft size={13} />
                  返回知识页手工编辑
                </button>
              )}
            </div>
            <div>
              <button
                type="button"
                className="btn"
                disabled={Boolean(pending)}
                onClick={() => {
                  setPlan(null);
                  setChoices({});
                  setError("");
                }}
              >
                <ArrowLeft size={14} />
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  Boolean(pending) ||
                  Boolean(unresolved) ||
                  !plan.changes.length ||
                  Boolean(plan.reason)
                }
                onClick={() =>
                  void run("saving", async (isCurrent) => {
                    await onWithdraw(job.id, plan.fingerprint, selections);
                    if (isCurrent()) {
                      setPlan(null);
                      setChoices({});
                    }
                  })
                }
              >
                {pending === "saving" ? (
                  <LoaderCircle size={14} className="organization-spinner" />
                ) : (
                  <Check size={14} />
                )}
                {pending === "saving" ? "正在保存撤回" : "确认撤回"}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

export default function KnowledgeUpdateWithdrawal(props: KnowledgeUpdateWithdrawalProps) {
  const note = props.data.notes.find((item) => item.id === props.job.request.targetNote?.id);
  // A new owner/session, page, history or task invalidates the complete preview,
  // including any pending completion. Returning to A cannot revive A's old UI.
  const boundary = JSON.stringify([props.contextKey, note ?? null, props.job]);
  return <WithdrawalReview key={boundary} {...props} />;
}
