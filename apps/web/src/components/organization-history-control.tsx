"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { OrganizationJob } from "@/lib/organization-types";
import {
  ORGANIZATION_HISTORY_LIMIT,
  organizationHistoryCleanupImpact,
} from "@/lib/organization-history";
import Modal from "./modal";

export interface OrganizationHistoryControlProps {
  jobs?: OrganizationJob[];
  onCleanup: () => boolean;
}

const statusLabels = {
  dismissed: "已收起",
  failed: "未完成",
  cancelled: "已停止",
} as const;

const kindLabels = {
  source: "资料分析",
  knowledge: "主题草稿",
  update: "知识页更新",
  relations: "关系建议",
} as const;

export default function OrganizationHistoryControl({
  jobs = [],
  onCleanup,
}: OrganizationHistoryControlProps) {
  const [open, setOpen] = useState(false);
  const impact = organizationHistoryCleanupImpact(jobs);
  const percent = Math.min(100, Math.round((impact.total / ORGANIZATION_HISTORY_LIMIT) * 100));

  return (
    <>
      <div className="setting-row organization-history-setting">
        <div>
          <b>AI 整理记录</b>
          <p>
            已保存 {impact.total} / {ORGANIZATION_HISTORY_LIMIT} 条，占用约 {percent}%。
            可清理已收起、未完成和已停止的记录；待审核结果与执行中的任务会保留。
          </p>
        </div>
        <button
          type="button"
          className="btn"
          disabled={!impact.removable}
          onClick={() => setOpen(true)}
        >
          <Trash2 size={14} />
          {impact.removable ? `清理 ${impact.removable} 条记录` : "暂无可清理记录"}
        </button>
      </div>

      {open && (
        <Modal title="清理 AI 整理记录" onClose={() => setOpen(false)}>
          <div className="modal-body organization-history-modal">
            <p className="organization-history-intro">
              将从当前工作区移除 {impact.removable}{" "}
              条终态记录。已保存的标签、知识页和知识关系会保留；被清理的建议内容、失败原因和重试入口将不再显示。
            </p>
            <div className="organization-history-impact" aria-label="整理记录清理影响">
              <p>
                清理后保留 <strong>{impact.retained}</strong> 条记录
              </p>
              <dl>
                {Object.entries(impact.byStatus).map(([status, count]) =>
                  count ? (
                    <div key={status}>
                      <dt>{statusLabels[status as keyof typeof statusLabels]}</dt>
                      <dd>{count} 条</dd>
                    </div>
                  ) : null,
                )}
              </dl>
              <p className="organization-history-kinds">
                {Object.entries(impact.byKind)
                  .filter(([, count]) => count > 0)
                  .map(
                    ([kind, count]) => `${kindLabels[kind as keyof typeof kindLabels]} ${count} 条`,
                  )
                  .join(" · ")}
              </p>
            </div>
            <p className="muted">
              如需保留完整历史，请先在“账号与保存”中导出备份。此操作不会停止运行中的任务，也不会删除原始资料。
            </p>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  if (onCleanup()) setOpen(false);
                }}
              >
                清理 {impact.removable} 条记录
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
