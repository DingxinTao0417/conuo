"use client";
import { ArrowDownToLine, ArrowUpRight, FileText, Sparkles } from "lucide-react";
import { setSourceTags } from "@/lib/organization-review";
import {
  sourceAiStatus,
  sourceKindLabel,
  sourceOriginLabel,
  sourceReadingStatus,
  sourceTimestampLabel,
} from "@/lib/source-metadata";
import type { Source, WorkspaceData } from "@/lib/types";
import Modal from "../../modal";
import { sizeLabel, sourceStatusLabel } from "../shared";

export type SourceDetailsModalProps = {
  detail: Source;
  data: WorkspaceData;
  setModal: (modal: "recognized-content" | null) => void;
  patchSource: (source: Source, patch: Partial<Source>) => void;
  reviewOrganization: (
    change: (workspace: WorkspaceData) => WorkspaceData,
    message: string,
  ) => boolean;
  openOrganization: (ids: string[]) => void;
  openBulkRecycle: (ids: string[]) => void;
  downloadOriginal: (source: Source) => Promise<void>;
};

export default function SourceDetailsModal({
  detail,
  data,
  setModal,
  patchSource,
  reviewOrganization,
  openOrganization,
  openBulkRecycle,
  downloadOriginal,
}: SourceDetailsModalProps) {
  return (
    <Modal title="资料详情" onClose={() => setModal(null)}>
      <div className="modal-body">
        <label>
          资料名称
          <input
            className="field"
            value={detail.title}
            onChange={(e) =>
              patchSource(detail, {
                title: e.target.value,
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
            onBlur={(e) => {
              const labels = e.target.value.split(/[,，]/);
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
            onChange={(e) => patchSource(detail, { tagsLocked: e.target.checked })}
          />
          固定标签，AI 建议不能修改
        </label>
        <fieldset className="space-checkboxes">
          <legend>所属学习空间</legend>
          {data.spaces
            .filter((s) => !s.archived)
            .map((s) => (
              <label key={s.id}>
                <input
                  type="checkbox"
                  checked={detail.spaceIds.includes(s.id)}
                  onChange={(e) =>
                    patchSource(detail, {
                      spaceIds: e.target.checked
                        ? [...detail.spaceIds, s.id]
                        : detail.spaceIds.filter((id) => id !== s.id),
                    })
                  }
                />
                {s.name}
              </label>
            ))}
          {!data.spaces.length && <small className="muted">还没有学习空间，资料暂存收件箱。</small>}
        </fieldset>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={detail.aiAllowed}
            onChange={(e) => patchSource(detail, { aiAllowed: e.target.checked })}
          />
          允许 AI 使用这份资料
        </label>
        <button className="btn" onClick={() => openOrganization([detail.id])}>
          <Sparkles size={15} />
          查看摘要与标签建议
        </button>
        <button className="btn" onClick={() => setModal("recognized-content")}>
          <FileText size={15} />
          查看已识别内容
        </button>
        <div className="detail-meta">
          <dl className="source-meta-list" aria-label="资料元数据">
            <div>
              <dt>资料类型</dt>
              <dd>{sourceKindLabel(detail)}</dd>
            </div>
            <div>
              <dt>导入来源</dt>
              <dd>{sourceOriginLabel(detail)}</dd>
            </div>
            <div>
              <dt>原文件</dt>
              <dd>{detail.filename}</dd>
            </div>
            <div>
              <dt>导入时间</dt>
              <dd>{sourceTimestampLabel(detail.createdAt)}</dd>
            </div>
            <div>
              <dt>阅读状态</dt>
              <dd>{sourceReadingStatus(detail)}</dd>
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
              <dt>AI 状态</dt>
              <dd>{sourceAiStatus(detail)}</dd>
            </div>
            <div>
              <dt>文件大小</dt>
              <dd>{sizeLabel(detail.size)}</dd>
            </div>
            <div>
              <dt>版本记录</dt>
              <dd>{detail.versions?.length || 0} 个历史版本</dd>
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
        <div className="modal-actions">
          <button className="btn btn-danger" onClick={() => openBulkRecycle([detail.id])}>
            移入回收站
          </button>
          <button className="btn" onClick={() => void downloadOriginal(detail)}>
            <ArrowDownToLine size={14} />
            下载原件
          </button>
          <button className="btn btn-primary" onClick={() => setModal(null)}>
            完成
          </button>
        </div>
      </div>
    </Modal>
  );
}
