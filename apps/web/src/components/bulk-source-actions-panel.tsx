"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { Loader2, RotateCcw, Sparkles } from "lucide-react";
import {
  applyBulkSourceAction,
  confirmBulkSourceAction,
  retryBulkSourceAction,
  snapshotRetryBulkSourceAction,
  type BulkSourceActionRequest,
  type BulkSourceActionResult,
} from "@/lib/bulk-source-actions";
import type { WorkspaceData } from "@/lib/types";
import Modal from "./modal";
import "./bulk-source-actions-panel.css";

export interface BulkSourceActionsPanelProps {
  kind: "associate" | "recycle";
  data: WorkspaceData;
  sourceIds: readonly string[];
  contextKey: string;
  onApply: (updater: (current: WorkspaceData) => WorkspaceData) => Promise<WorkspaceData>;
  onClose: (completed: boolean) => void;
  onContinue: (sourceIds: string[], spaceId: string) => void;
}

function targetKey(data: WorkspaceData, ids: readonly string[]) {
  const sources = new Map(data.sources.map((source) => [source.id, source]));
  return JSON.stringify(
    ids.map((id) => {
      const source = sources.get(id);
      return source ? [id, source.versionId, source.deletedAt] : [id, null];
    }),
  );
}

function Review({
  kind,
  data,
  sourceIds,
  onApply,
  onClose,
  onContinue,
}: BulkSourceActionsPanelProps) {
  const [spaceIds, setSpaceIds] = useState<string[]>([]);
  const [reviewSpaceId, setReviewSpaceId] = useState("");
  const [result, setResult] = useState<BulkSourceActionResult | null>(null);
  const [provisional, setProvisional] = useState<BulkSourceActionResult | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const mounted = useRef(false),
    operation = useRef<object | null>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current = null;
    };
  }, []);
  const activeSpaces = data.spaces.filter((space) => !space.archived);
  const liveSources = data.sources.filter(
    (source) => sourceIds.includes(source.id) && !source.deletedAt,
  );
  const associate = kind === "associate";
  const close = (completed: boolean) => {
    operation.current = null;
    onClose(completed);
  };

  async function run(mode: "apply" | "snapshot" | "failed") {
    if (operation.current || !mounted.current) return;
    const marker = {};
    operation.current = marker;
    setPending(true);
    setError("");
    const current = () => mounted.current && operation.current === marker;
    const expectedTarget = targetKey(data, sourceIds);
    const request: BulkSourceActionRequest = associate
      ? { kind: "associate", sourceIds: [...sourceIds], spaceIds: [...spaceIds] }
      : { kind: "recycle", sourceIds: [...sourceIds] };
    let application: ReturnType<typeof applyBulkSourceAction> | undefined;
    try {
      const latest = await onApply((workspace) => {
        if (!current() || targetKey(workspace, sourceIds) !== expectedTarget)
          throw new Error("所选资料版本或状态已变化，请重新核对资料。");
        application =
          mode === "snapshot" && provisional
            ? snapshotRetryBulkSourceAction(workspace, provisional)
            : mode === "failed" && result
              ? retryBulkSourceAction(workspace, result)
              : applyBulkSourceAction(workspace, request);
        return application.data;
      });
      if (!current()) return;
      if (!application) throw new Error("本机保存尚未执行，请检查工作区状态后重试。");
      // Recheck the coordinator's live actor snapshot: an independent edit
      // may have reversed the operation while its disk write was pending.
      const confirmed = confirmBulkSourceAction(latest, application.result);
      setResult(confirmed);
      setProvisional(null);
      if (associate && confirmed.addedSourceIds.length)
        setReviewSpaceId((previous) => previous || spaceIds[0] || "");
    } catch (cause) {
      if (!current()) return;
      if (application) setProvisional(application.result);
      const reason = cause instanceof Error ? cause.message : "请检查保存状态后重试。";
      setError(
        application || provisional
          ? `尚未确认本机保存。${reason} 修改可能已保留在当前内存；重试本机保存不会重复处理资料。`
          : reason,
      );
    } finally {
      if (current()) {
        operation.current = null;
        setPending(false);
      }
    }
  }

  const continuationAvailable = Boolean(
    result &&
    !provisional &&
    !pending &&
    reviewSpaceId &&
    activeSpaces.some((space) => space.id === reviewSpaceId) &&
    result.request.spaceIds?.includes(reviewSpaceId) &&
    result.addedSourceIds.length &&
    result.addedSourceIds.every((id) => {
      const source = data.sources.find((item) => item.id === id);
      const receipt = result.items.find((item) => item.sourceId === id);
      return (
        source &&
        !source.deletedAt &&
        source.versionId === receipt?.versionId &&
        source.spaceIds.includes(reviewSpaceId)
      );
    }),
  );

  return (
    <Modal
      title={
        associate
          ? `为 ${sourceIds.length} 份资料关联学习空间`
          : `将 ${sourceIds.length} 份资料移入回收站？`
      }
      onClose={() => close(Boolean(result && !provisional))}
    >
      <div
        className={`modal-body ${associate ? "bulk-space-modal" : "bulk-recycle-modal"} bulk-source-actions-panel`}
        aria-busy={pending}
      >
        <p className="bulk-space-intro">
          当前选中 {sourceIds.length} 份资料，其中 {liveSources.length} 份未在回收站。
          {associate
            ? "关联不会复制原文件，也不会移出已有学习空间。解析中的资料会单独提示失败。"
            : "移入回收站后可恢复，并退出新的搜索和问答范围；原文件保留。解析中的资料会单独提示失败。"}
        </p>
        {error && (
          <p className="form-error bulk-source-actions-error" role="alert">
            {error}
          </p>
        )}
        {associate &&
          (activeSpaces.length ? (
            <fieldset className="bulk-space-fieldset" disabled={pending || Boolean(provisional)}>
              <legend>选择要新增的学习空间</legend>
              <div className="bulk-space-list">
                {activeSpaces.map((space) => (
                  <label className="checkbox-row" key={space.id}>
                    <input
                      type="checkbox"
                      checked={spaceIds.includes(space.id)}
                      onChange={(event) => {
                        setSpaceIds((previous) =>
                          event.target.checked
                            ? [...new Set([...previous, space.id])]
                            : previous.filter((id) => id !== space.id),
                        );
                        setReviewSpaceId("");
                        setResult(null);
                        setError("");
                      }}
                    />
                    <span className="space-dot" style={{ background: space.color }} />
                    <span>
                      <b>{space.name}</b>
                      {space.goal && <small>{space.goal}</small>}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : (
            <p className="muted">还没有可用学习空间。请先新建知识库后再关联资料。</p>
          ))}
        {!associate && !result && !provisional && liveSources.length > 0 && (
          <ul className="bulk-recycle-list" aria-label="将移入回收站的资料">
            {liveSources.map((source) => (
              <li key={source.id}>
                <b>{source.title}</b>
                <span>{source.status === "parsing" ? "解析中" : "保留原文件"}</span>
              </li>
            ))}
          </ul>
        )}
        {result && !provisional && (
          <section
            className={associate ? "bulk-space-result" : "bulk-recycle-result"}
            role="status"
            aria-label={associate ? "关联结果" : "移入回收站结果"}
          >
            <b>本机保存已确认</b>
            <p>
              {associate
                ? result.addedSourceIds.length
                  ? `已关联 ${result.addedSourceIds.length} 份资料，新增 ${result.addedAssociations} 个关联。`
                  : "没有资料新增关联。"
                : result.recycledSourceIds.length
                  ? `已移入 ${result.recycledSourceIds.length} 份资料。`
                  : "没有资料被移入回收站。"}
            </p>
            <p className="bulk-source-actions-hint">
              本次处理结果 · 无需修改 {result.noopSourceIds.length} · 失败{" "}
              {result.failedSourceIds.length}。云端同步以工作区保存提示为准。
            </p>
            <ul className="bulk-source-actions-items">
              {result.items.map((item) => (
                <li key={item.sourceId} className={`bulk-source-actions-item-${item.status}`}>
                  <div>
                    <b>{item.title}</b>
                    <span>
                      {item.status === "accepted"
                        ? "已处理"
                        : item.status === "noop"
                          ? "无需修改"
                          : "失败"}
                    </span>
                  </div>
                  <p>{item.reason}</p>
                </li>
              ))}
            </ul>
            {associate && result.addedSourceIds.length > 0 && (
              <label className="bulk-space-next">
                <span>
                  <b>下一步：审核标签建议</b>
                  <small>只保留本次成功新增关联的资料；进入后仍需明确提交分析。</small>
                </span>
                <select
                  aria-label="选择继续审核的学习空间"
                  value={reviewSpaceId}
                  disabled={pending}
                  onChange={(event) => setReviewSpaceId(event.target.value)}
                >
                  {activeSpaces
                    .filter((space) => result.request.spaceIds?.includes(space.id))
                    .map((space) => (
                      <option key={space.id} value={space.id}>
                        {space.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {associate &&
              result.addedSourceIds.length > 0 &&
              !continuationAvailable &&
              !pending && (
                <p className="form-error">
                  目标空间或部分成功资料状态已改变，继续审核不可用；请重新核对资料。
                </p>
              )}
          </section>
        )}
        <div className="modal-actions bulk-source-actions-actions">
          <button
            className="btn"
            disabled={pending}
            onClick={() => close(Boolean(result && !provisional))}
          >
            {result && !provisional ? "完成" : "取消"}
          </button>
          {provisional ? (
            <>
              <button
                className="btn"
                disabled={pending}
                onClick={() => {
                  setProvisional(null);
                  setResult(null);
                  setError("");
                  setReviewSpaceId("");
                }}
              >
                重新核对资料
              </button>
              <button
                className="btn btn-primary"
                disabled={pending}
                onClick={() => void run("snapshot")}
              >
                {pending ? <Loader2 size={15} className="spin" /> : <RotateCcw size={15} />}{" "}
                {pending ? "正在保存到本机" : "重试本机保存"}
              </button>
            </>
          ) : result ? (
            <>
              {result.failedSourceIds.length > 0 && (
                <button
                  className="btn btn-primary"
                  disabled={pending}
                  onClick={() => void run("failed")}
                >
                  {pending ? "正在保存到本机" : `仅重试失败 ${result.failedSourceIds.length} 份`}
                </button>
              )}
              {associate && result.addedSourceIds.length > 0 && (
                <button
                  className="btn btn-primary"
                  disabled={!continuationAvailable}
                  onClick={() => {
                    if (!continuationAvailable || !result) return;
                    try {
                      onContinue([...result.addedSourceIds], reviewSpaceId);
                    } catch (cause) {
                      setError(
                        cause instanceof Error ? cause.message : "继续审核不可用，请重新核对资料。",
                      );
                    }
                  }}
                >
                  <Sparkles size={14} />
                  审核标签建议
                </button>
              )}
            </>
          ) : (
            <button
              className={`btn ${associate ? "btn-primary" : "btn-danger"}`}
              disabled={pending || !sourceIds.length || (associate && !spaceIds.length)}
              onClick={() => void run("apply")}
            >
              {pending ? (
                <>
                  <Loader2 size={15} className="spin" /> 正在保存到本机
                </>
              ) : associate ? (
                `关联到所选空间${spaceIds.length ? `（${spaceIds.length}）` : ""}`
              ) : (
                `移入回收站（${sourceIds.length}）`
              )}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default function BulkSourceActionsPanel(props: BulkSourceActionsPanelProps) {
  const ids = [...new Set(props.sourceIds)];
  return (
    <Review
      key={`${props.contextKey}:${props.kind}:${JSON.stringify(ids)}`}
      {...props}
      sourceIds={ids}
    />
  );
}
