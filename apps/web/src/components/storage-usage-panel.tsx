"use client";

import { FileText, History, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import {
  LOCAL_IMPORT_QUOTA_POLICY,
  MEBIBYTE,
  formatImportQuotaBytes,
  workspaceImportStorageBreakdown,
  type WorkspaceImportStorageUsage,
} from "@/lib/import-quota";
import type { Source } from "@/lib/types";
import "./storage-usage-panel.css";

interface StorageUsagePanelProps {
  sources: Source[];
  onOpenRecycleBin: () => void;
}

interface StorageMetricProps {
  icon: ReactNode;
  label: string;
  usage: WorkspaceImportStorageUsage;
}

function originalsLabel(originals: number) {
  return `${originals} 份原件`;
}

function remainingLabel(bytes: number, limit: number) {
  if (bytes > 0 && bytes < limit && limit - bytes < MEBIBYTE / 20)
    return `< ${formatImportQuotaBytes(limit)}`;
  return formatImportQuotaBytes(bytes);
}

function StorageMetric({ icon, label, usage }: StorageMetricProps) {
  return (
    <div className="storage-usage-metric">
      <span className="storage-usage-metric-icon" aria-hidden="true">
        {icon}
      </span>
      <span>
        <b>{label}</b>
        <small>{originalsLabel(usage.originals)}</small>
      </span>
      <strong>{formatImportQuotaBytes(usage.bytes)}</strong>
    </div>
  );
}

/**
 * Shows the Web client's retained-original admission budget. This is derived
 * from workspace metadata and deliberately does not claim to be a cloud-plan
 * or browser-vendor quota meter.
 */
export default function StorageUsagePanel({ sources, onOpenRecycleBin }: StorageUsagePanelProps) {
  const breakdown = workspaceImportStorageBreakdown({ sources });
  const limit = LOCAL_IMPORT_QUOTA_POLICY.maxAccountBytes;
  const clampedBytes = Math.min(breakdown.total.bytes, limit);
  const usedPercent = limit > 0 ? (clampedBytes / limit) * 100 : 0;
  const remaining = Math.max(0, limit - breakdown.total.bytes);
  const overage = Math.max(0, breakdown.total.bytes - limit);
  const formattedRemaining = remainingLabel(remaining, limit);

  return (
    <div className="storage-usage-panel" aria-label="资料与存储使用情况">
      <div className="storage-usage-summary">
        <div>
          <b>已保留原件</b>
          <p>按资料记录统计，包含当前版本、历史版本和回收站。</p>
        </div>
        <div className="storage-usage-total">
          <strong>{formatImportQuotaBytes(breakdown.total.bytes)}</strong>
          <span>/ {formatImportQuotaBytes(limit)}</span>
        </div>
      </div>
      <div
        className="storage-usage-progress"
        role="progressbar"
        aria-label="原件占用"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={clampedBytes}
        aria-valuetext={
          overage > 0
            ? `已超过 Web 导入保护线 ${formatImportQuotaBytes(overage)}`
            : `还可导入 ${formattedRemaining} 原件`
        }
      >
        <span
          style={{
            width: `${usedPercent}%`,
            minWidth: breakdown.total.bytes > 0 ? 2 : 0,
          }}
        />
      </div>
      <div className="storage-usage-status">
        <span>{originalsLabel(breakdown.total.originals)}</span>
        <span>
          {overage > 0
            ? `超过保护线 ${formatImportQuotaBytes(overage)}`
            : `剩余 ${formattedRemaining}`}
        </span>
      </div>
      <div className="storage-usage-grid">
        <StorageMetric icon={<FileText size={16} />} label="当前资料" usage={breakdown.current} />
        <StorageMetric icon={<History size={16} />} label="历史版本" usage={breakdown.history} />
        <StorageMetric icon={<Trash2 size={16} />} label="回收站" usage={breakdown.recycleBin} />
      </div>
      <div className="storage-usage-footnote">
        <p>
          这是 Conuo Web 的原件导入保护线，不代表浏览器、Supabase
          或未来套餐的实际容量；正文、笔记和索引不计入此数字。
        </p>
        {breakdown.recycleBin.originals > 0 && (
          <button className="text-button" type="button" onClick={onOpenRecycleBin}>
            查看回收站
          </button>
        )}
      </div>
    </div>
  );
}
