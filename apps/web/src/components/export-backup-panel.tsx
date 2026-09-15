"use client";

import { useMemo, useState } from "react";
import { ArrowDownToLine, FolderOpen, Loader2, RefreshCw } from "lucide-react";
import {
  prepareWorkspaceExport,
  workspaceExportFingerprint,
  type WorkspaceExportScope,
} from "@/lib/export-scope";
import type { ExportProgress } from "@/lib/export";
import type { WorkspaceData } from "@/lib/types";
import "./export-backup-panel.css";

interface Review {
  snapshot: WorkspaceData;
  prepared: ReturnType<typeof prepareWorkspaceExport>;
  fingerprint: string;
}

function prepareReview(data: WorkspaceData, scope: WorkspaceExportScope): Review {
  const snapshot = structuredClone(data);
  return {
    snapshot,
    prepared: prepareWorkspaceExport(snapshot, scope),
    fingerprint: workspaceExportFingerprint(snapshot, scope),
  };
}

function reviewState(data: WorkspaceData, scope: WorkspaceExportScope) {
  try {
    return { review: prepareReview(data, scope), error: "" };
  } catch (cause) {
    return {
      review: null,
      error: cause instanceof Error ? cause.message : "无法确认导出范围，请重新选择。",
    };
  }
}

export interface ExportBackupPanelProps {
  data: WorkspaceData;
  initialScope?: WorkspaceExportScope;
  busy: boolean;
  progress: ExportProgress | null;
  onClose: () => void;
  onExport: (
    snapshot: WorkspaceData,
    scope: WorkspaceExportScope,
    fingerprint: string,
  ) => Promise<boolean>;
}

export default function ExportBackupPanel({
  data,
  initialScope = { kind: "workspace" },
  busy,
  progress,
  onClose,
  onExport,
}: ExportBackupPanelProps) {
  const [scope, setScope] = useState(initialScope);
  const [reviewed, setReviewed] = useState(() => reviewState(data, initialScope));
  const [actionError, setActionError] = useState("");
  const currentFingerprint = useMemo(() => {
    try {
      return workspaceExportFingerprint(data, scope);
    } catch {
      return null;
    }
  }, [data, scope]);
  const stale = Boolean(reviewed.review && currentFingerprint !== reviewed.review.fingerprint);
  const preview = reviewed.review?.prepared.preview;
  const selectedValue = scope.kind === "workspace" ? "workspace" : `space:${scope.spaceId}`;
  const missingSpace =
    scope.kind === "space" && !data.spaces.some((item) => item.id === scope.spaceId);

  function refreshReview(nextScope = scope) {
    setScope(nextScope);
    setReviewed(reviewState(data, nextScope));
    setActionError("");
  }

  async function download() {
    const review = reviewed.review;
    if (!review || busy || stale) return;
    setActionError("");
    try {
      if (!(await onExport(review.snapshot, scope, review.fingerprint))) {
        setActionError("导出未完成，请根据提示处理后重试。");
      }
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "导出失败，请重试。");
    }
  }

  return (
    <div className="export-backup-panel">
      <p>选择全部工作区或一个知识库，保留原文件、笔记、知识页和来源记录。</p>
      <label className="export-backup-picker">
        <span>
          <FolderOpen size={15} aria-hidden="true" />
          导出范围
        </span>
        <select
          aria-label="导出范围"
          value={selectedValue}
          disabled={busy}
          onChange={(event) => {
            const value = event.currentTarget.value;
            refreshReview(
              value === "workspace"
                ? { kind: "workspace" }
                : {
                    kind: "space",
                    spaceId: value.slice("space:".length),
                  },
            );
          }}
        >
          <option value="workspace">全部工作区</option>
          {data.spaces.map((space) => (
            <option value={`space:${space.id}`} key={space.id}>
              {space.name}
              {space.archived ? "（已归档）" : ""}
            </option>
          ))}
          {missingSpace && <option value={selectedValue}>知识库已不可用</option>}
        </select>
      </label>

      {reviewed.error && (
        <p className="export-backup-error" role="alert">
          {reviewed.error}
        </p>
      )}
      {stale && (
        <div className="export-backup-warning" role="status">
          <p>导出范围已变化，请刷新预览后再下载。</p>
          <button type="button" className="btn" disabled={busy} onClick={() => refreshReview()}>
            <RefreshCw size={14} aria-hidden="true" />
            刷新导出范围
          </button>
        </div>
      )}

      {preview && (
        <section className="export-backup-preview" aria-label="导出范围预览">
          <h3>{scope.kind === "workspace" ? "全部工作区" : preview.spaceName}</h3>
          <dl>
            {[
              ["资料", preview.counts.sources],
              ["资料版本", preview.counts.sourceVersions],
              ["笔记", preview.counts.notes - preview.counts.knowledgePages],
              ["知识页", preview.counts.knowledgePages],
              ["对话", preview.counts.conversations],
              ["批注", preview.counts.annotations],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p className="export-backup-records">
            另含 {preview.counts.organizationJobs} 条整理记录、{preview.counts.conceptRelations}{" "}
            条知识关系、
            {preview.counts.importJobs} 项导入任务和 {preview.counts.recoverableDrafts} 份恢复草稿。
          </p>
          <p className="export-backup-records">
            其中 {preview.counts.recycledSources} 份资料、{preview.counts.recycledNotes}{" "}
            份笔记或知识页在回收站。 资料版本数包含当前版与全部保留历史版本。
          </p>
        </section>
      )}

      {!!preview?.additionalSources.length && (
        <details className="export-backup-details" open>
          <summary>同时包含引用到的库外资料（{preview.additionalSources.length} 份）</summary>
          <p>
            为保留来源映射，这些资料的当前版、全部保留历史版本、全部批注和可恢复草稿也会导出。恢复备份后，这些库外资料保留在收件箱。
          </p>
          <ul>
            {preview.additionalSources.map((source) => (
              <li key={source.sourceId}>
                <strong>{source.title}</strong>
                <span>
                  {source.versions.length} 个版本{source.deletedAt ? " · 回收站" : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {preview?.historicalEvidenceWarnings?.map((warning) => (
        <p className="export-backup-warning" key={warning}>
          {warning}
        </p>
      ))}
      {!!preview?.missingReferences.length && (
        <details className="export-backup-details">
          <summary>有 {preview.missingReferences.length} 项来源身份无法完整关联</summary>
          <p>已有引用原话仍会保留，缺失资料或版本不会用其他内容代替。</p>
          <ul>
            {preview.missingReferences.map((reference, index) => (
              <li key={index}>
                <span>{reference.from}</span>
                <span>
                  {reference.sourceId}
                  {reference.versionId ? ` · ${reference.versionId}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {!!preview?.knownMissingOriginals.length && (
        <p className="export-backup-warning">
          已有 {preview.knownMissingOriginals.length} 个资料版本标记原件缺失，文字和引用仍可导出。
        </p>
      )}
      <p className="export-backup-note">
        下载时逐版读取原件。部分原件无法取得时仍保留其他内容，并在结果和 ZIP 中逐项说明。
        备份中的回收站状态会保留；未应用的本机审核改写不包含在 ZIP 中。
      </p>
      {busy && (
        <p className="export-backup-progress" role="status" aria-live="polite">
          <Loader2 size={15} className="spin" aria-hidden="true" />
          {progress?.phase === "originals"
            ? `正在读取原件 ${progress.completed} / ${progress.total}：${progress.title}`
            : progress?.phase === "archive"
              ? "正在生成 ZIP…"
              : "正在准备导出…"}
        </p>
      )}
      {actionError && (
        <p className="export-backup-error" role="alert">
          {actionError}
        </p>
      )}
      <div className="export-backup-actions">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || stale || !reviewed.review}
          onClick={() => void download()}
        >
          <ArrowDownToLine size={15} aria-hidden="true" />
          {busy ? "正在导出…" : "下载 ZIP"}
        </button>
      </div>
    </div>
  );
}
