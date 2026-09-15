"use client";
import { useState } from "react";
import { ChevronRight, FolderOpen } from "lucide-react";
import type { AnonymousWorkspaceMigrationState } from "@/lib/use-workspace";

export default function AnonymousWorkspaceMigrationNotice({
  migration,
  onMigrate,
  onSkip,
  compact = false,
}: {
  migration: AnonymousWorkspaceMigrationState | undefined;
  onMigrate: () => void;
  onSkip: () => void;
  /** Keep non-decision guidance unobtrusive in reading and comparison workspaces. */
  compact?: boolean;
}) {
  migration ??= { kind: "none", canMigrate: false };
  const [detailsOpen, setDetailsOpen] = useState(false);
  if (migration.kind === "none" || migration.kind === "dismissed") return null;
  const counts = [
    migration.sourceCount ? `${migration.sourceCount} 份资料` : "",
    migration.noteCount ? `${migration.noteCount} 篇笔记` : "",
  ].filter(Boolean);
  const isDecision = migration.kind === "pending" || migration.kind === "migrating";
  const expanded = isDecision || detailsOpen;
  // A migration that needs an explicit choice must remain fully visible. Other
  // guidance stays one line in immersive workspaces until the learner opens it.
  const compactEntry = compact && !expanded;
  const detailsId = "anonymous-workspace-migration-details";
  const title =
    migration.kind === "migrated"
      ? "本机资料已复制到当前账号"
      : migration.kind === "requires-export"
        ? "资料副本存在差异"
        : migration.kind === "unavailable"
          ? "暂时无法检查本机资料"
          : "发现此浏览器中的本机资料";
  const confirmation =
    migration.kind === "migrated"
      ? migration.pendingCloudConfirmation
        ? "本机副本已经确认，正在上传原件并确认云端资料库。"
        : "当前账号已确认云端资料库；原匿名副本仍保留在此浏览器。"
      : "";

  return (
    <section
      className={`notice anonymous-workspace-migration anonymous-workspace-migration-${migration.kind} ${expanded ? "is-expanded" : "is-collapsed"}${compactEntry ? " is-compact" : ""}`}
      aria-label="本机资料迁移"
      aria-busy={migration.kind === "migrating" || undefined}
      aria-live="polite"
      role="status"
    >
      <FolderOpen size={17} aria-hidden="true" />
      <div className="anonymous-workspace-copy">
        <div className="anonymous-workspace-heading">
          <strong>{title}</strong>
          {!expanded && counts.length > 0 && <small>{counts.join(" · ")}</small>}
        </div>
        <div id={detailsId} className="anonymous-workspace-details" hidden={!expanded}>
          <p>
            {migration.message}
            {counts.length ? ` 当前副本包含${counts.join("、")}。` : ""}
          </p>
          {confirmation && <p className="anonymous-workspace-confirmation">{confirmation}</p>}
          {migration.kind === "requires-export" && (
            <p className="anonymous-workspace-followup">
              为保护两份内容，系统没有自动合并。若要整合，请先退出账号，在本机工作区导出备份，再通过恢复功能导入。
            </p>
          )}
        </div>
      </div>
      {!isDecision && (
        <button
          type="button"
          className="anonymous-workspace-toggle"
          aria-controls={detailsId}
          aria-expanded={expanded}
          onClick={() => setDetailsOpen((current) => !current)}
        >
          {expanded ? "收起" : migration.kind === "requires-export" ? "查看处理方法" : "查看详情"}
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
      {isDecision && (
        <div className="anonymous-workspace-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!migration.canMigrate}
            onClick={onMigrate}
          >
            {migration.kind === "migrating" ? "正在迁移…" : "迁移到当前账号"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={migration.kind === "migrating"}
            onClick={onSkip}
          >
            暂不迁移
          </button>
        </div>
      )}
    </section>
  );
}
