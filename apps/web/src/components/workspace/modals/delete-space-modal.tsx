"use client";
import { useState } from "react";
import type { Space, WorkspaceData } from "@/lib/types";
import {
  learningSpaceDeletionFingerprint,
  previewLearningSpaceDeletion,
  type SpaceDeletionImpact,
} from "@/lib/space-lifecycle";
import Modal from "../../modal";

export default function DeleteSpaceModal({
  data,
  space,
  onClose,
  onDelete,
}: {
  data: WorkspaceData;
  space: Space;
  onClose: () => void;
  onDelete: (recycleExclusiveSources: boolean, expectedFingerprint: string) => void;
}) {
  const [recycleExclusiveSources, setRecycleExclusiveSources] = useState(false);
  const impact: SpaceDeletionImpact = previewLearningSpaceDeletion(data, space.id);
  const fingerprint = learningSpaceDeletionFingerprint(data, space.id);
  return (
    <Modal title={`删除「${space.name}」？`} onClose={onClose}>
      <div className="modal-body space-delete-modal">
        <p className="space-delete-intro">
          此操作会删除知识库及其空间级整理记录。原始资料默认不会被删除；它们会保留在资料库中。
        </p>
        <div className="space-delete-impact" aria-label="删除影响预览">
          <p>{recycleExclusiveSources ? "将转到收件箱或回收站" : "将保留并转到收件箱"}</p>
          <ul>
            {impact.exclusiveSources > 0 && <li>{impact.exclusiveSources} 份仅属于此空间的资料</li>}
            {impact.notes > 0 && <li>{impact.notes} 篇笔记或知识页</li>}
            {impact.conversations > 0 && <li>{impact.conversations} 个问答记录</li>}
            {!impact.exclusiveSources && !impact.notes && !impact.conversations && (
              <li>没有需要转移的当前内容</li>
            )}
          </ul>
          {impact.sharedSources > 0 && (
            <p>{impact.sharedSources} 份资料会保留在其他知识库，并从此知识库移除。</p>
          )}
          {(impact.recycleBinSources > 0 || impact.recycleBinNotes > 0) && (
            <p className="space-delete-recycle-info">
              回收站内的 {impact.recycleBinSources} 份资料和 {impact.recycleBinNotes}{" "}
              篇笔记也会改为收件箱归属；恢复后不会回到这个知识库。
            </p>
          )}
          {(impact.organizationJobs > 0 || impact.conceptRelations > 0) && (
            <p className="space-delete-derived">
              将移除 {impact.organizationJobs} 条本空间整理记录和 {impact.conceptRelations} 条关系
              {impact.pendingOrganizationJobs > 0
                ? `，其中 ${impact.pendingOrganizationJobs} 条整理任务会停止`
                : ""}
              。
            </p>
          )}
        </div>
        {impact.exclusiveSources > 0 && (
          <label className="checkbox-row space-delete-option">
            <input
              type="checkbox"
              checked={recycleExclusiveSources}
              onChange={(event) => setRecycleExclusiveSources(event.target.checked)}
            />
            同时将仅属于此空间的 {impact.exclusiveSources} 份资料移入回收站
          </label>
        )}
        <p className="muted space-delete-note">
          移入回收站的资料可恢复；恢复后会保留在收件箱。这个空间本身和它的整理记录无法恢复。
        </p>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-danger"
            onClick={() => onDelete(recycleExclusiveSources, fingerprint)}
          >
            {recycleExclusiveSources ? "删除并移入回收站" : "删除空间并保留资料"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
