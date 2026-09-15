"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { Check, Info, LoaderCircle, Tag, RotateCcw } from "lucide-react";
import type { WorkspaceData } from "@/lib/types";
import {
  applyBulkSourceTags,
  normalizeBulkSourceTags,
  retryBulkSourceTags,
  type BulkSourceTagsApplication,
  type BulkSourceTagsResult,
} from "@/lib/bulk-source-tags";
import "./bulk-source-tags-panel.css";

export interface BulkSourceTagsPanelProps {
  data: WorkspaceData;
  sourceIds: readonly string[];
  contextKey: string;
  onApply: (updater: (current: WorkspaceData) => WorkspaceData) => Promise<void>;
  onClose: () => void;
  onResult?: (result: BulkSourceTagsResult) => void;
}
function targetKey(data: WorkspaceData, ids: readonly string[]): string {
  const sources = new Map(data.sources.map((source) => [source.id, source]));
  return JSON.stringify(
    ids.map((id) => {
      const source = sources.get(id);
      return source ? [id, source.versionId, source.deletedAt] : [id, null];
    }),
  );
}
function Review({ data, sourceIds, onApply, onClose, onResult }: BulkSourceTagsPanelProps) {
  const [result, setResult] = useState<BulkSourceTagsResult | null>(null);
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const operation = useRef<object | null>(null),
    mounted = useRef(false);
  const expectedTarget = targetKey(data, sourceIds);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current = null;
    };
  }, []);
  async function run(tags: string[], previous?: BulkSourceTagsResult) {
    if (operation.current || !mounted.current) return;
    const marker = {};
    operation.current = marker;
    setPending(true);
    setError("");
    const current = () => mounted.current && operation.current === marker;
    let applied: BulkSourceTagsApplication | undefined;
    try {
      await onApply((workspace) => {
        if (!current() || targetKey(workspace, sourceIds) !== expectedTarget)
          throw new Error("所选资料或操作上下文已变化，请重新打开批量标签。");
        applied = previous
          ? retryBulkSourceTags(workspace, previous)
          : applyBulkSourceTags(workspace, sourceIds, tags);
        return applied.data;
      });
      if (!current()) return;
      if (!applied) throw new Error("本机保存尚未执行，请重新选择后重试。");
      setResult(applied.result);
      onResult?.(applied.result);
    } catch (cause) {
      if (current()) {
        const reason = cause instanceof Error ? cause.message : "请检查保存状态后重试。";
        setError(
          applied ? `尚未确认本机保存。${reason} 当前标签可能已保留在内存，请重试保存。` : reason,
        );
      }
    } finally {
      if (current()) {
        operation.current = null;
        setPending(false);
      }
    }
  }
  return (
    <div className="modal-body bulk-source-tags-panel">
      <p className="bulk-source-tags-intro">
        选中 {sourceIds.length} 份资料。将为每份资料保留现有标签并添加新标签；固定标签也可人工调整。
      </p>
      {error && (
        <div className="bulk-source-tags-error" role="alert">
          <Info size={16} />
          <span>{error}</span>
        </div>
      )}
      {!result ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (operation.current) return;
            try {
              const tags = normalizeBulkSourceTags(
                String(new FormData(event.currentTarget).get("tags") ?? ""),
              );
              void run(tags);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "请输入有效标签。");
            }
          }}
        >
          <label className="bulk-source-tags-field">
            <span>新增标签</span>
            <input
              className="field"
              name="tags"
              maxLength={20_000}
              disabled={pending}
              autoFocus
              placeholder="学习方法, 待读"
              aria-describedby="bulk-source-tags-input-hint"
              onInput={() => {
                if (!pending) setError("");
              }}
            />
          </label>
          <p className="bulk-source-tags-hint" id="bulk-source-tags-input-hint">
            用逗号分隔。每份资料最多 100 个标签，每个标签最多 100 字符。
          </p>
          <div className="modal-actions bulk-source-tags-actions">
            <button type="button" className="btn" disabled={pending} onClick={onClose}>
              取消
            </button>
            <button className="btn btn-primary" disabled={pending || !sourceIds.length}>
              {pending ? (
                <LoaderCircle size={16} className="bulk-source-tags-spinner" />
              ) : (
                <Tag size={16} />
              )}{" "}
              {pending
                ? "正在保存到本机"
                : error.includes("尚未确认本机保存")
                  ? "重试本机保存"
                  : "添加标签"}
            </button>
          </div>
        </form>
      ) : (
        <>
          <section className="bulk-source-tags-result" aria-label="批量标签结果">
            <div className="bulk-source-tags-summary" role="status">
              <Check size={18} />
              <div>
                <b>本机保存已确认</b>
                <p>
                  已修改 {result.acceptedSourceIds.length} · 无需修改 {result.noopSourceIds.length}{" "}
                  · 失败 {result.failedSourceIds.length}
                </p>
              </div>
            </div>
            <div className="bulk-source-tags-labels" aria-label="本次添加的标签">
              {result.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
            <p className="bulk-source-tags-hint">
              以下为逐份处理结果。重试只处理失败资料，已处理项和无需修改项保持原结果；云端同步状态以工作区提示为准。
            </p>
            <ul className="bulk-source-tags-items">
              {result.items.map((item) => (
                <li
                  className={`bulk-source-tags-item bulk-source-tags-item-${item.status}`}
                  key={item.sourceId}
                >
                  <div className="bulk-source-tags-item-heading">
                    <b>{item.title}</b>
                    <span>
                      {item.status === "accepted"
                        ? "已修改"
                        : item.status === "noop"
                          ? "无需修改"
                          : "失败"}
                    </span>
                  </div>
                  <p>{item.reason}</p>
                </li>
              ))}
            </ul>
          </section>
          <div className="modal-actions bulk-source-tags-actions">
            <button type="button" className="btn" disabled={pending} onClick={onClose}>
              完成
            </button>
            {result.failedSourceIds.length > 0 && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={pending}
                onClick={() => void run(result.tags, result)}
              >
                {pending ? (
                  <LoaderCircle size={16} className="bulk-source-tags-spinner" />
                ) : (
                  <RotateCcw size={16} />
                )}{" "}
                {pending ? "正在保存到本机" : `仅重试失败 ${result.failedSourceIds.length} 份`}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
export default function BulkSourceTagsPanel(props: BulkSourceTagsPanelProps) {
  const ids = [...new Set(props.sourceIds)];
  return (
    <Review
      key={`${props.contextKey}:${JSON.stringify(ids)}:${targetKey(props.data, ids)}`}
      {...props}
      sourceIds={ids}
    />
  );
}
