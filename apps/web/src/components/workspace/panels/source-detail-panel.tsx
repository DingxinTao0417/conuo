"use client";
import { useCallback, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpRight,
  MoreHorizontal,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { setSourceTags } from "@/lib/organization-review";
import {
  sourceAiStatus,
  sourceKindLabel,
  sourceOriginLabel,
  sourceReadingStatus,
  sourceTimestampLabel,
} from "@/lib/source-metadata";
import type { Citation, Source, WorkspaceData } from "@/lib/types";
import { useMenuDismissal } from "../hooks/use-menu-dismissal";
import { sizeLabel, sourceStatusLabel } from "../shared";
import RecognizedContentPanel from "./recognized-content-panel";
import "./source-detail-panel.css";

/** The three sections of a source's details; the shell keeps this in its state
 * so returning from the reader can reopen the exact section that was open. */
export type SourceDetailTab = "basic" | "recognized" | "versions";

const tabs: { id: SourceDetailTab; label: string }[] = [
  { id: "basic", label: "基本" },
  { id: "recognized", label: "已识别内容" },
  { id: "versions", label: "版本" },
];

export type SourceDetailPanelProps = {
  detail: Source;
  data: WorkspaceData;
  tab: SourceDetailTab;
  onTabChange: (tab: SourceDetailTab) => void;
  onClose: () => void;
  patchSource: (source: Source, patch: Partial<Source>) => void;
  reviewOrganization: (
    change: (workspace: WorkspaceData) => WorkspaceData,
    message: string,
  ) => boolean;
  openOrganization: (ids: string[]) => void;
  openBulkRecycle: (ids: string[]) => void;
  downloadOriginal: (source: Source) => Promise<void>;
  onOpenSource: (citation?: Citation) => void;
};

/**
 * A source's details as a docked side panel rather than two stacked modals.
 *
 * The library list stays on screen and keeps its scroll position, so a learner
 * can work through several sources in a row. On a phone the same panel covers
 * the screen as its own detail page (see source-detail-panel.css).
 */
export default function SourceDetailPanel({
  detail,
  data,
  tab,
  onTabChange,
  onClose,
  patchSource,
  reviewOrganization,
  openOrganization,
  openBulkRecycle,
  downloadOriginal,
  onOpenSource,
}: SourceDetailPanelProps) {
  const [moreInfoOpen, setMoreInfoOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsMenu = useRef<HTMLDivElement>(null);
  const closeActions = useCallback(() => setActionsOpen(false), []);
  useMenuDismissal(actionsOpen, actionsMenu, closeActions);
  const versions = detail.versions ?? [];

  return (
    <aside className="source-detail-panel" aria-label="资料详情">
      <header className="source-detail-header">
        <button
          type="button"
          className="icon-btn source-detail-dismiss"
          aria-label="关闭资料详情"
          onClick={onClose}
        >
          <ArrowLeft className="source-detail-back-icon" size={18} aria-hidden="true" />
          <X className="source-detail-close-icon" size={18} aria-hidden="true" />
        </button>
        <div>
          <span>资料详情</span>
          <strong title={detail.title}>{detail.title}</strong>
        </div>
      </header>
      <div className="source-detail-tabs" role="tablist" aria-label="资料详情分区">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`source-detail-tab-${item.id}`}
            aria-controls="source-detail-panel-body"
            aria-selected={tab === item.id}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => onTabChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        className="source-detail-body"
        id="source-detail-panel-body"
        role="tabpanel"
        aria-labelledby={`source-detail-tab-${tab}`}
        tabIndex={-1}
      >
        {tab === "basic" && (
          <>
            <label>
              资料名称
              <input
                className="field"
                value={detail.title}
                onChange={(event) =>
                  patchSource(detail, {
                    title: event.target.value,
                    updatedAt: new Date().toISOString(),
                  })
                }
              />
              <small>资料名称由你维护，AI 整理不会自动改名。</small>
            </label>
            <label>
              标签（用逗号分隔）
              <input
                className="field"
                defaultValue={detail.tags.join(", ")}
                onBlur={(event) => {
                  const labels = event.target.value.split(/[,，]/);
                  reviewOrganization(
                    (workspace) => setSourceTags(workspace, detail.id, labels),
                    "标签已保存。",
                  );
                }}
              />
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={detail.tagsLocked === true}
                onChange={(event) => patchSource(detail, { tagsLocked: event.target.checked })}
              />
              固定标签，AI 建议不能修改
            </label>
            <fieldset className="space-checkboxes">
              <legend>所属学习空间</legend>
              {data.spaces
                .filter((space) => !space.archived)
                .map((space) => (
                  <label key={space.id}>
                    <input
                      type="checkbox"
                      checked={detail.spaceIds.includes(space.id)}
                      onChange={(event) =>
                        patchSource(detail, {
                          spaceIds: event.target.checked
                            ? [...detail.spaceIds, space.id]
                            : detail.spaceIds.filter((id) => id !== space.id),
                        })
                      }
                    />
                    {space.name}
                  </label>
                ))}
              {!data.spaces.length && (
                <small className="muted">还没有学习空间，资料暂存收件箱。</small>
              )}
            </fieldset>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={detail.aiAllowed}
                onChange={(event) => patchSource(detail, { aiAllowed: event.target.checked })}
              />
              允许 AI 使用这份资料
            </label>
            <dl className="source-meta-list" aria-label="资料元数据">
              <div>
                <dt>资料类型</dt>
                <dd>{sourceKindLabel(detail)}</dd>
              </div>
              <div>
                <dt>导入时间</dt>
                <dd>{sourceTimestampLabel(detail.createdAt)}</dd>
              </div>
              <div>
                <dt>阅读状态</dt>
                <dd>{sourceReadingStatus(detail)}</dd>
              </div>
              <div>
                <dt>AI 状态</dt>
                <dd>{sourceAiStatus(detail)}</dd>
              </div>
            </dl>
            <button
              type="button"
              className="text-button source-detail-more-info-toggle"
              aria-expanded={moreInfoOpen}
              aria-controls="source-detail-more-info"
              onClick={() => setMoreInfoOpen((open) => !open)}
            >
              {moreInfoOpen ? "收起更多信息" : "更多信息"}
            </button>
            <div id="source-detail-more-info" hidden={!moreInfoOpen}>
              <dl className="source-meta-list" aria-label="更多资料信息">
                <div>
                  <dt>导入来源</dt>
                  <dd>{sourceOriginLabel(detail)}</dd>
                </div>
                <div>
                  <dt>原文件</dt>
                  <dd>{detail.filename}</dd>
                </div>
                {detail.lastReadAt && (
                  <div>
                    <dt>最近阅读</dt>
                    <dd>{sourceTimestampLabel(detail.lastReadAt)}</dd>
                  </div>
                )}
                <div>
                  <dt>处理状态</dt>
                  <dd>
                    {sourceStatusLabel(detail)} · {detail.chunks.length} 个内容块
                  </dd>
                </div>
                <div>
                  <dt>文件大小</dt>
                  <dd>{sizeLabel(detail.size)}</dd>
                </div>
                {detail.parsedPages !== undefined && (
                  <div>
                    <dt>识别范围</dt>
                    <dd>
                      已提取 {detail.parsedPages} / {detail.pageCount} 页
                    </dd>
                  </div>
                )}
                {detail.url && (
                  <div>
                    <dt>原网页</dt>
                    <dd>
                      <a
                        href={detail.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-button"
                      >
                        打开原网页
                        <ArrowUpRight size={14} />
                      </a>
                    </dd>
                  </div>
                )}
              </dl>
              {detail.error && <p className="error-text">{detail.error}</p>}
            </div>
          </>
        )}
        {tab === "recognized" && (
          <RecognizedContentPanel source={detail} onOpenSource={onOpenSource} />
        )}
        {tab === "versions" && (
          <section className="source-detail-versions" aria-label="资料版本记录">
            <p className="source-detail-versions-summary">
              共保留 {versions.length + 1} 个版本
              {detail.kind === "web" ? "（网页快照）" : "（文件）"}。
            </p>
            <ol>
              <li>
                <strong>当前版本</strong>
                <span>
                  {sourceTimestampLabel(
                    detail.versionCreatedAt ?? detail.webSnapshot?.capturedAt ?? detail.createdAt,
                  )}
                </span>
                <small>
                  {sourceStatusLabel(detail)} · {sizeLabel(detail.size)} · {detail.filename}
                </small>
              </li>
              {versions.map((version) => (
                <li key={version.versionId}>
                  <strong>历史版本</strong>
                  <span>{sourceTimestampLabel(version.createdAt)}</span>
                  <small>
                    {sourceStatusLabel(version)} · {sizeLabel(version.size)} · {version.filename}
                  </small>
                  <small>归档于 {sourceTimestampLabel(version.archivedAt)}</small>
                </li>
              ))}
            </ol>
            <p className="source-detail-versions-hint">
              {detail.kind === "web" ? "刷新网页快照" : "替换文件"}
              与恢复历史版本都会改变当前正文和引用，需要在阅读器的「更多资料操作 ·{" "}
              {detail.kind === "web" ? "网页版本记录" : "资料版本记录"}」中确认。
            </p>
          </section>
        )}
      </div>
      <footer className="source-detail-actions">
        <button type="button" className="btn btn-primary" onClick={() => onOpenSource()}>
          打开阅读
        </button>
        <div className="library-menu" ref={actionsMenu}>
          <button
            type="button"
            className="icon-btn library-menu-trigger"
            aria-haspopup="menu"
            aria-expanded={actionsOpen}
            aria-label="更多资料操作"
            onClick={() => setActionsOpen((open) => !open)}
          >
            <MoreHorizontal size={18} />
          </button>
          {actionsOpen && (
            <div
              className="library-menu-popover library-menu-list"
              role="group"
              aria-label="更多资料操作"
            >
              <button
                type="button"
                className="library-menu-item"
                onClick={() => {
                  closeActions();
                  void downloadOriginal(detail);
                }}
              >
                <ArrowDownToLine size={15} aria-hidden="true" />
                下载原件
              </button>
              <button
                type="button"
                className="library-menu-item"
                onClick={() => {
                  closeActions();
                  openOrganization([detail.id]);
                }}
              >
                <Sparkles size={15} aria-hidden="true" />
                AI 建议
              </button>
              <button
                type="button"
                className="library-menu-item library-menu-item-danger"
                onClick={() => {
                  closeActions();
                  openBulkRecycle([detail.id]);
                }}
              >
                <Trash2 size={15} aria-hidden="true" />
                移入回收站
              </button>
            </div>
          )}
        </div>
      </footer>
    </aside>
  );
}
