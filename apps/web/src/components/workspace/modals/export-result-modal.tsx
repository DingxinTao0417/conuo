"use client";
import type { ExportIssue } from "@/lib/export";
import Modal from "../../modal";

export type ExportResultModalProps = {
  exportIssues: ExportIssue[];
  setModal: (modal: null) => void;
  setExportIssues: (issues: null) => void;
};

export default function ExportResultModal({
  exportIssues,
  setModal,
  setExportIssues,
}: ExportResultModalProps) {
  return (
    <Modal
      title="备份已下载，但有原件未包含"
      onClose={() => {
        setModal(null);
        setExportIssues(null);
      }}
    >
      <div className="modal-body export-result-modal">
        <p className="export-result-intro">
          资料文字、笔记、批注、引用和其他可用原件已经写入 ZIP。以下版本的原文件未能取得，
          不会以当前版本或其他文件代替。
        </p>
        <ul className="export-issue-list">
          {exportIssues.map((issue) => (
            <li key={issue.sourceId + ":" + issue.versionId + ":" + issue.code}>
              <strong>
                {issue.title}
                {issue.versionState === "historical" ? " · 历史版本" : ""}
              </strong>
              <span>{issue.message}</span>
            </li>
          ))}
        </ul>
        <p className="muted">
          ZIP 根目录的 <code>export-issues.json</code> 和每个资料版本的{" "}
          <code>original-status.txt</code> 保留相同的逐项说明。
        </p>
        <div className="modal-actions">
          <button
            className="btn btn-primary"
            onClick={() => {
              setModal(null);
              setExportIssues(null);
            }}
          >
            知道了
          </button>
        </div>
      </div>
    </Modal>
  );
}
