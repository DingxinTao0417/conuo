"use client";

import { useState } from "react";
import { ArchiveRestore, FileUp, History, Info, RotateCcw, Trash2, X } from "lucide-react";
import type { SourceVersionPurgePreview } from "@/lib/cloud";
import type { Source, SourceVersion } from "@/lib/types";
import { sourceCoverageLabel } from "@/lib/source-coverage";
import WebImportForm from "./web-import-form";
import FileReplacementForm from "./file-replacement-form";
import Modal from "./modal";
import "./web-version-panel.css";

export interface WebVersionPanelProps {
  source: Source;
  displayedVersionId: string;
  spaceId: string;
  cloudUserId?: string;
  initialMode?: "history" | "refresh" | "replace";
  onOpenSource: (id: string, versionId?: string) => void;
  onRefreshWeb?: (candidate: Source, expectedVersionId: string) => void | Promise<void>;
  onReplaceFile?: (candidate: Source, blob: Blob, expectedVersionId: string) => Promise<void>;
  onRestoreVersion?: (versionId: string, expectedCurrentVersionId: string) => void | Promise<void>;
  onPreviewRemoveVersion?: (versionId: string) => Promise<SourceVersionPurgePreview>;
  onRemoveVersion?: (versionId: string, preview: SourceVersionPurgePreview) => Promise<void>;
  onClose: () => void;
}

const formatDate = (value: string) => new Date(value).toLocaleString("zh-CN");
const formatLabels: Record<Source["kind"], string> = {
  web: "网页快照",
  pdf: "PDF",
  docx: "DOCX",
  markdown: "Markdown",
  text: "TXT",
};
function contentLabel(version: Source | SourceVersion) {
  const text = version.text
    ? `${version.text.length.toLocaleString()} 字符`
    : version.kind === "web"
      ? "仅链接"
      : "无解析正文 · 原件保留";
  const coverage = sourceCoverageLabel(version);
  return `${formatLabels[version.kind]} · ${text}${version.pageCount ? ` · ${version.pageCount} 页` : ""}${coverage ? ` · ${coverage}` : ""}`;
}

export default function WebVersionPanel({
  source,
  displayedVersionId,
  spaceId,
  cloudUserId,
  initialMode = "history",
  onOpenSource,
  onRefreshWeb,
  onReplaceFile,
  onRestoreVersion,
  onPreviewRemoveVersion,
  onRemoveVersion,
  onClose,
}: WebVersionPanelProps) {
  const [tab, setTab] = useState(initialMode);
  const [restoreTarget, setRestoreTarget] = useState<SourceVersion | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState("");
  const [removeTarget, setRemoveTarget] = useState<SourceVersion | null>(null);
  const [removePreview, setRemovePreview] = useState<SourceVersionPurgePreview | null>(null);
  const [removeConfirmation, setRemoveConfirmation] = useState("");
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const historical = source.versionId !== displayedVersionId;
  const web = source.kind === "web";
  const title = web ? "网页版本" : "资料版本";
  const replaceable = !historical && !source.deletedAt && !web && Boolean(onReplaceFile);
  const refreshable =
    !historical &&
    !source.deletedAt &&
    source.kind === "web" &&
    Boolean(source.webSnapshot?.originalUrl || source.url) &&
    Boolean(onRefreshWeb);
  const removable = Boolean(onPreviewRemoveVersion && onRemoveVersion && !source.deletedAt);
  function openRemoveVersion(version: SourceVersion) {
    if (!onPreviewRemoveVersion) return;
    setRemoveTarget(version);
    setRemovePreview(null);
    setRemoveConfirmation("");
    setRemoveError("");
    void onPreviewRemoveVersion(version.versionId)
      .then((preview) => {
        if (preview.impact.version.versionId !== version.versionId)
          throw new Error("云端版本已变化，请重新打开版本记录后再试。");
        setRemovePreview(preview);
      })
      .catch((error) => {
        setRemoveError(
          error instanceof Error ? error.message : "无法读取历史版本清理影响，请稍后重试。",
        );
      });
  }
  return (
    <section className="web-version-panel" aria-label={`${title}管理`}>
      <header className="web-version-heading">
        <History size={16} />
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-btn"
          aria-label={`关闭${title}面板`}
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </header>
      <div className="web-version-tabs" aria-label={`${title}功能`}>
        <button type="button" aria-pressed={tab === "history"} onClick={() => setTab("history")}>
          版本记录
        </button>
        <button
          type="button"
          aria-pressed={tab === (web ? "refresh" : "replace")}
          disabled={web ? !refreshable : !replaceable}
          onClick={() => setTab(web ? "refresh" : "replace")}
        >
          {web ? <RotateCcw size={12} /> : <FileUp size={12} />}
          {web ? "刷新网页" : "替换文件"}
        </button>
      </div>
      {tab === "refresh" && refreshable ? (
        <WebImportForm
          refreshSource={source}
          targetSpaceId={spaceId === "inbox" ? "" : spaceId}
          cloudUserId={cloudUserId}
          onImport={(candidate) => onRefreshWeb!(candidate, source.versionId)}
          onSaved={() => {
            onClose();
            onOpenSource(source.id);
          }}
        />
      ) : tab === "replace" && replaceable ? (
        <FileReplacementForm
          source={source}
          targetSpaceId={spaceId}
          cloudUserId={cloudUserId}
          onReplace={onReplaceFile!}
          onSaved={() => {
            onClose();
            onOpenSource(source.id);
          }}
          onCancel={onClose}
          onViewHistory={() => setTab("history")}
        />
      ) : (
        <>
          <p className="web-version-hint">
            <Info size={14} />
            <span>
              旧版保留当时的原件、正文与引用位置，仅供阅读和摘录。
              {web ? "刷新入口" : "替换文件入口"}在当前版本，预览后由你决定是否保存新版本。
            </span>
          </p>
          <ol className="web-version-list">
            <li className={!historical ? "web-version-selected" : ""}>
              <div>
                <strong>当前版本</strong>
                <small>
                  {formatDate(
                    source.versionCreatedAt || source.webSnapshot?.capturedAt || source.createdAt,
                  )}
                </small>
                <code>{source.versionId}</code>
                <span className="web-version-filename">{source.filename}</span>
                <span>{contentLabel(source)}</span>
              </div>
              <button
                type="button"
                className="btn"
                disabled={!historical}
                onClick={() => onOpenSource(source.id)}
              >
                {historical ? "查看当前版本" : "正在阅读"}
              </button>
            </li>
            {(source.versions || []).map((version, index) => (
              <li
                className={version.versionId === displayedVersionId ? "web-version-selected" : ""}
                key={version.versionId}
              >
                <div>
                  <strong>历史版本 {source.versions!.length - index}</strong>
                  <small>
                    创建于 {formatDate(version.createdAt)} · 归档于 {formatDate(version.archivedAt)}
                  </small>
                  <code>{version.versionId}</code>
                  <span className="web-version-filename">{version.filename}</span>
                  <span>{contentLabel(version)}</span>
                </div>
                <div className="web-version-actions">
                  <button
                    type="button"
                    className="btn"
                    aria-label={`打开历史版本 ${version.versionId}`}
                    disabled={version.versionId === displayedVersionId}
                    onClick={() => onOpenSource(source.id, version.versionId)}
                  >
                    {version.versionId === displayedVersionId ? "正在阅读" : "查看此版本"}
                  </button>
                  {onRestoreVersion && !source.deletedAt && (
                    <button
                      type="button"
                      className="btn"
                      aria-label={`恢复历史版本 ${version.versionId} 为当前版本`}
                      onClick={() => {
                        setRestoreError("");
                        setRestoreTarget(version);
                      }}
                    >
                      <ArchiveRestore size={13} />
                      恢复为当前
                    </button>
                  )}
                  {removable && (
                    <button
                      type="button"
                      className="btn btn-danger"
                      aria-label={`清理历史版本 ${version.versionId}`}
                      onClick={() => openRemoveVersion(version)}
                    >
                      <Trash2 size={13} />
                      清理此版本
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
          {!source.versions?.length && (
            <p className="web-version-empty">
              还没有历史版本。{web ? "保存一次网页刷新" : "确认替换文件"}
              后，原来的内容会显示在这里。
            </p>
          )}
        </>
      )}
      {restoreTarget && (
        <Modal
          title="恢复这个历史版本？"
          dismissible={!restoring}
          onClose={() => {
            setRestoreError("");
            setRestoreTarget(null);
          }}
        >
          <div className="modal-body version-restore-modal">
            <p>
              {`所选的“${restoreTarget.filename}”会重新成为当前版本；现在的“${source.filename}”会归档到版本记录中，其他历史版本继续保留。`}
            </p>
            <dl>
              <div>
                <dt>恢复版本</dt>
                <dd>{formatDate(restoreTarget.createdAt)}</dd>
              </div>
              <div>
                <dt>版本标识</dt>
                <dd>
                  <code>{restoreTarget.versionId}</code>
                </dd>
              </div>
              <div>
                <dt>恢复内容</dt>
                <dd>{contentLabel(restoreTarget)}</dd>
              </div>
            </dl>
            <p className="muted">
              资料名称、标签、知识库归属、收藏和 AI 权限不会改变。保存完成后，搜索与新 AI
              问答会使用恢复后的正文；已有引用仍绑定各自的准确版本。
            </p>
            {restoreError && (
              <p className="file-replacement-error" role="alert">
                {restoreError}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                disabled={restoring}
                onClick={() => setRestoreTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={restoring}
                onClick={async () => {
                  setRestoring(true);
                  setRestoreError("");
                  try {
                    await onRestoreVersion!(restoreTarget.versionId, source.versionId);
                    setRestoreTarget(null);
                    onClose();
                    onOpenSource(source.id);
                  } catch (error) {
                    setRestoreError(
                      error instanceof Error ? error.message : "历史版本未恢复，请稍后重试。",
                    );
                  } finally {
                    setRestoring(false);
                  }
                }}
              >
                <ArchiveRestore size={14} />
                {restoring ? "正在恢复…" : "恢复为当前版本"}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {removeTarget && (
        <Modal
          title={`清理「${removeTarget.filename}」这个历史版本？`}
          wide
          dismissible={!removing}
          onClose={() => {
            setRemoveTarget(null);
            setRemovePreview(null);
            setRemoveError("");
          }}
        >
          <div className="modal-body version-remove-modal">
            <p>
              此操作不可撤销。系统会删除此历史版本的原件、正文、片段和检索索引；当前版本及其他版本不会改变。
            </p>
            {!removePreview && !removeError && <p className="muted">正在读取清理影响范围…</p>}
            {removeError && (
              <p className="file-replacement-error" role="alert">
                {removeError}
              </p>
            )}
            {removePreview && (
              <>
                <section className="version-remove-impact" aria-label="历史版本清理影响预览">
                  <h3>将清理</h3>
                  <ul>
                    <li>1 个历史版本及其解析内容和检索索引</li>
                    {removePreview.impact.annotations > 0 && (
                      <li>{removePreview.impact.annotations} 条未写备注的高亮</li>
                    )}
                    {removePreview.impact.organizationJobs > 0 && (
                      <li>{removePreview.impact.organizationJobs} 条已结束的 AI 整理记录</li>
                    )}
                    {removePreview.impact.conceptRelations > 0 && (
                      <li>{removePreview.impact.conceptRelations} 条 AI 生成的知识关系</li>
                    )}
                    {removePreview.impact.importJobs > 0 && (
                      <li>{removePreview.impact.importJobs} 条已结束的导入记录</li>
                    )}
                    {removePreview.impact.cloudOriginals > 0 && <li>云端原件将由后台任务清理</li>}
                  </ul>
                </section>
                {(removePreview.impact.retainedNotes > 0 ||
                  removePreview.impact.retainedConversations > 0) && (
                  <p className="muted">
                    {removePreview.impact.retainedNotes > 0
                      ? `${removePreview.impact.retainedNotes} 条笔记`
                      : ""}
                    {removePreview.impact.retainedNotes > 0 &&
                    removePreview.impact.retainedConversations > 0
                      ? "和"
                      : ""}
                    {removePreview.impact.retainedConversations > 0
                      ? `${removePreview.impact.retainedConversations} 段问答`
                      : ""}
                    仍会保留原有引用和引文，但会标为历史版本不可用，不能被新 AI 问答替代引用。
                  </p>
                )}
                {(removePreview.blockers.annotations.length > 0 ||
                  removePreview.blockers.conceptRelations.length > 0 ||
                  removePreview.blockers.organizationJobs.length > 0 ||
                  removePreview.blockers.importJobs.length > 0) && (
                  <p className="file-replacement-error" role="alert">
                    此版本仍有已保存批注、手工知识关系或进行中的任务。请先处理这些内容，再重新查看清理影响。
                  </p>
                )}
                <label className="version-remove-confirmation">
                  输入“清理”以确认
                  <input
                    value={removeConfirmation}
                    onChange={(event) => setRemoveConfirmation(event.target.value)}
                    autoComplete="off"
                    disabled={removing}
                  />
                </label>
              </>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                disabled={removing}
                onClick={() => setRemoveTarget(null)}
              >
                取消
              </button>
              {removePreview && (
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={
                    removing ||
                    removeConfirmation.trim() !== "清理" ||
                    Object.values(removePreview.blockers).some((ids) => ids.length > 0)
                  }
                  onClick={async () => {
                    setRemoving(true);
                    setRemoveError("");
                    try {
                      await onRemoveVersion!(removeTarget.versionId, removePreview);
                      setRemoveTarget(null);
                      setRemovePreview(null);
                      onClose();
                      onOpenSource(source.id);
                    } catch (error) {
                      setRemoveError(
                        error instanceof Error ? error.message : "历史版本未清理，请稍后重试。",
                      );
                    } finally {
                      setRemoving(false);
                    }
                  }}
                >
                  <Trash2 size={14} />
                  {removing ? "正在清理…" : "清理历史版本"}
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
