"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, FileUp, Loader2 } from "lucide-react";
import { readWorkspaceBackup } from "@/lib/backup-archive";
import { mergeBackupRestore, prepareBackupRestore } from "@/lib/backup-restore";
import type { RestorePlan } from "@/lib/backup-types";
import type { WorkspaceData } from "@/lib/types";
import Modal from "./modal";
import "./backup-restore-panel.css";

const phaseLabels: Record<string, string> = {
  directory: "正在检查备份目录",
  verify: "正在核对备份文件",
  originals: "正在核对原件",
  ready: "备份检查完成",
};

export interface BackupRestorePanelProps {
  storageMode?: "hybrid" | "cloud";
  data: WorkspaceData;
  accountEmail?: string;
  onRestore: (plan: RestorePlan) => Promise<void>;
  onClose: () => void;
  onOpenRestored: (plan: RestorePlan) => void;
}

export default function BackupRestorePanel({
  storageMode = "hybrid",
  data,
  accountEmail,
  onRestore,
  onClose,
  onOpenRestored,
}: BackupRestorePanelProps) {
  const [plan, setPlan] = useState<RestorePlan>();
  const [filename, setFilename] = useState("");
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [acceptedMissing, setAcceptedMissing] = useState(false);
  const [progress, setProgress] = useState({ phase: "正在检查备份", completed: 0, total: 0 });
  const alive = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const committing = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);

  const mergeError = useMemo(() => {
    if (!plan || saved) return "";
    try {
      mergeBackupRestore(data, plan);
      return "";
    } catch (cause) {
      return cause instanceof Error ? cause.message : "当前工作区无法容纳这份备份。";
    }
  }, [data, plan, saved]);

  async function selectFile(file: File) {
    if (committing.current) return;
    controller.current?.abort();
    const attempt = new AbortController();
    controller.current = attempt;
    setFilename(file.name);
    setPlan(undefined);
    setSaved(false);
    setAcceptedMissing(false);
    setError("");
    setReading(true);
    setProgress({ phase: "正在检查备份", completed: 0, total: 0 });
    try {
      const backup = await readWorkspaceBackup(file, {
        signal: attempt.signal,
        onProgress: (value) => {
          if (alive.current && !attempt.signal.aborted) setProgress(value);
        },
      });
      if (!alive.current || attempt.signal.aborted) return;
      setPlan(prepareBackupRestore(backup));
    } catch (cause) {
      if (alive.current && !attempt.signal.aborted)
        setError(cause instanceof Error ? cause.message : "无法读取这份备份，请检查文件。");
    } finally {
      if (alive.current && !attempt.signal.aborted) setReading(false);
    }
  }

  function stopReading() {
    controller.current?.abort();
    setReading(false);
    setError("");
    setPlan(undefined);
    if (input.current) input.current.value = "";
  }

  const canRestore = Boolean(
    plan &&
    !reading &&
    !saving &&
    !saved &&
    !mergeError &&
    (!plan.missingOriginals.length || acceptedMissing),
  );

  async function restore() {
    if (!canRestore || !plan || committing.current) return;
    committing.current = true;
    setSaving(true);
    setError("");
    try {
      await onRestore(plan);
      if (alive.current) setSaved(true);
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : "恢复尚未完成，请重试保存。");
    } finally {
      committing.current = false;
      if (alive.current) setSaving(false);
    }
  }

  return (
    <Modal title="从备份恢复" onClose={onClose} dismissible={!saving}>
      <div className="backup-restore-panel">
        {saved && plan ? (
          <>
            <div className="backup-restore-success" role="status">
              <CheckCircle2 size={21} />
              <div>
                <h3>
                  {storageMode === "cloud" ? "恢复副本已保存到云端" : "恢复副本已保存在此浏览器"}
                </h3>
                <p>
                  已新增 {plan.counts.sources} 份资料、{plan.counts.notes} 份笔记与知识页。
                  {plan.counts.recoverableDrafts
                    ? `同时保留 ${plan.counts.recoverableDrafts} 份可恢复草稿。`
                    : ""}
                  {plan.archivedSpaceCount
                    ? `其中 ${plan.archivedSpaceCount} 个超出额度的学习空间已转为归档。`
                    : ""}
                  {storageMode === "cloud"
                    ? "原件与资料库已得到云端确认。"
                    : accountEmail
                      ? "云端同步进度请查看页面保存状态。"
                      : "可随时重新导出备份。"}
                </p>
              </div>
            </div>
            {plan.missingOriginals.length > 0 && (
              <p className="backup-restore-warning">
                {plan.missingOriginals.length} 个版本的原件仍然缺失，已保留备份中的文字和缺失状态。
              </p>
            )}
            <div className="backup-restore-actions">
              <button className="btn" onClick={onClose}>
                关闭
              </button>
              <button className="btn btn-primary" onClick={() => onOpenRestored(plan)}>
                查看恢复资料
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              将 Conuo 导出的 ZIP 恢复为当前工作区中的新增副本，保留历史版本、回收站状态和引用关系。
              再次恢复同一份备份会另建一套副本。
            </p>
            <div className="backup-restore-destination">
              <b>恢复到：{accountEmail || "本地工作空间"}</b>
              <p>
                {accountEmail
                  ? "确认后会按当前账号的保存流程上传原件并同步资料。"
                  : "资料与原件保存在当前浏览器。"}
                新增资料默认关闭 AI 使用，可在资料详情中逐份开启。
              </p>
            </div>
            <label className="backup-restore-picker">
              <span>
                <FileUp size={17} />
                选择 Conuo 备份 ZIP
              </span>
              <input
                ref={input}
                type="file"
                accept=".zip,application/zip"
                aria-label="选择 Conuo 备份 ZIP"
                disabled={saving}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void selectFile(file);
                }}
              />
              <small>文件上限 128 MiB；读取和预览不会写入资料或连接备份中的地址。</small>
            </label>
            {reading && (
              <div className="backup-restore-progress" role="status">
                <Loader2 size={17} className="spin" />
                <span>
                  {phaseLabels[progress.phase] || progress.phase}
                  {progress.total > 0 ? `（${progress.completed} / ${progress.total}）` : "…"}
                </span>
                <button className="text-button" onClick={stopReading}>
                  停止读取
                </button>
              </div>
            )}
            {plan && (
              <div className="backup-restore-preview">
                <h3>{filename}</h3>
                <dl>
                  {[
                    ["知识库", plan.counts.spaces],
                    ["资料", plan.counts.sources],
                    ["资料历史", plan.counts.sourceVersions],
                    ["笔记与知识页", plan.counts.notes],
                    ["笔记历史", plan.counts.noteVersions],
                    ["对话", plan.counts.conversations],
                    ["批注", plan.counts.annotations],
                    ["可恢复草稿", plan.counts.recoverableDrafts],
                    ["知识关系", plan.counts.conceptRelations],
                    ["可恢复原件", plan.blobs.length],
                  ].map(([label, count]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{count}</dd>
                    </div>
                  ))}
                </dl>
                {plan.warnings.length > 0 && (
                  <details>
                    <summary>恢复说明（{plan.warnings.length}）</summary>
                    <ul>
                      {plan.warnings.map((warning, index) => (
                        <li key={index}>{warning}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {plan.missingOriginals.length > 0 && (
                  <div className="backup-restore-warning">
                    <details>
                      <summary>缺少 {plan.missingOriginals.length} 个版本的原件</summary>
                      <ul>
                        {plan.missingOriginals.map((item, index) => (
                          <li key={index}>
                            {item.title} · 版本 {item.versionId}
                          </li>
                        ))}
                      </ul>
                    </details>
                    <label className="backup-restore-confirm">
                      <input
                        type="checkbox"
                        checked={acceptedMissing}
                        disabled={saving}
                        onChange={(event) => setAcceptedMissing(event.target.checked)}
                      />
                      我了解这些原件无法恢复，仍恢复已有文字、历史和引用记录。
                    </label>
                  </div>
                )}
              </div>
            )}
            {(error || mergeError) && (
              <p className="backup-restore-error" role="alert">
                {error || mergeError}
              </p>
            )}
            <div className="backup-restore-actions">
              <button className="btn" onClick={onClose} disabled={saving}>
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={!canRestore}
                onClick={() => void restore()}
              >
                {saving && <Loader2 size={15} className="spin" />}
                {saving ? "正在保存恢复副本…" : "确认恢复为新增副本"}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
