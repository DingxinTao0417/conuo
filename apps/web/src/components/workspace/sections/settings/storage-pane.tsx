"use client";
import { ArrowDownToLine, Upload } from "lucide-react";
import type { ExportProgress } from "@/lib/export";
import type { WorkspaceData } from "@/lib/types";
import StorageUsagePanel from "../../../storage-usage-panel";
import type { WorkspaceStorageMode, WorkspaceStore } from "../../types";

export type StoragePaneProps = {
  data: WorkspaceData;
  ready: boolean;
  status: WorkspaceStore["status"];
  storageMode: WorkspaceStorageMode;
  busy: boolean;
  exporting: boolean;
  exportProgress: ExportProgress | null;
  navigate: (section: "trash") => void;
  setModal: (modal: "restore" | "legacy-recovery") => void;
  openExport: () => void;
};

export default function StoragePane({
  data,
  ready,
  status,
  storageMode,
  busy,
  exporting,
  exportProgress,
  navigate,
  setModal,
  openExport,
}: StoragePaneProps) {
  return (
    <>
      <div className="settings-card">
        <h2>资料与存储</h2>
        <StorageUsagePanel sources={data.sources} onOpenRecycleBin={() => navigate("trash")} />
      </div>
      <div className="settings-card">
        <h2>备份</h2>
        <div className="setting-row">
          <div>
            <b>导出学习资料</b>
            <p>导出原文件、笔记和引用关系，保留一份自己的备份。</p>
            {exporting && (
              <p className="export-progress" role="status" aria-live="polite">
                {exportProgress?.phase === "originals"
                  ? "正在处理原件 " +
                    exportProgress.completed +
                    "/" +
                    exportProgress.total +
                    "：" +
                    exportProgress.title
                  : exportProgress?.phase === "archive"
                    ? "正在生成压缩包…"
                    : "正在准备导出…"}
              </p>
            )}
          </div>
          <button className="btn" disabled={busy} onClick={() => openExport()}>
            <ArrowDownToLine size={15} />
            {busy ? "正在导出…" : "导出备份"}
          </button>
        </div>
        <details className="settings-advanced">
          <summary>高级：恢复与旧版资料</summary>
          <div className="setting-row">
            <div>
              <b>从备份恢复</b>
              <p>读取 Conuo 备份 ZIP，预览后恢复资料、笔记与历史记录。</p>
            </div>
            <button className="btn" disabled={busy} onClick={() => setModal("restore")}>
              <Upload size={15} />
              恢复备份
            </button>
          </div>
          {storageMode === "cloud" && (
            <div className="setting-row">
              <div>
                <b>将旧版资料导入云端</b>
                <p>把旧版留在此浏览器中的资料导入当前账号，保留已有内容。</p>
              </div>
              <button
                className="btn"
                disabled={busy || !ready || status !== "cloud"}
                onClick={() => setModal("legacy-recovery")}
              >
                导入旧版资料
              </button>
            </div>
          )}
        </details>
      </div>
    </>
  );
}
