"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Download, LoaderCircle } from "lucide-react";
import { mergeBackupRestore } from "@/lib/backup-restore";
import type { RestorePlan } from "@/lib/backup-types";
import {
  prepareLegacyBrowserRecovery,
  type LegacyBrowserRecovery,
} from "@/lib/legacy-browser-recovery";
import type { WorkspaceData } from "@/lib/types";
import Modal from "./modal";
import "./legacy-browser-recovery-panel.css";

export interface LegacyBrowserRecoveryPanelProps {
  data: WorkspaceData;
  accountEmail: string;
  onRestore: (plan: RestorePlan) => Promise<void>;
  onClose: () => void;
}

export default function LegacyBrowserRecoveryPanel({
  data,
  accountEmail,
  onRestore,
  onClose,
}: LegacyBrowserRecoveryPanelProps) {
  const [initialAccount] = useState(accountEmail);
  const [recovery, setRecovery] = useState<LegacyBrowserRecovery | null>();
  const [reading, setReading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [acceptedMissing, setAcceptedMissing] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(false);
  const owner = useRef(accountEmail);
  const controller = useRef<AbortController | null>(null);
  const committing = useRef(false);
  const downloads = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const changedAccount = accountEmail !== initialAccount;

  useLayoutEffect(() => {
    owner.current = accountEmail;
    if (accountEmail !== initialAccount) controller.current?.abort();
  }, [accountEmail, initialAccount]);

  useEffect(() => {
    alive.current = true;
    const attempt = new AbortController();
    controller.current = attempt;
    // Strict Mode's discarded setup must not read legacy storage a second time.
    queueMicrotask(() => {
      if (attempt.signal.aborted) return;
      void prepareLegacyBrowserRecovery(attempt.signal)
        .then((result) => {
          if (alive.current && !attempt.signal.aborted) setRecovery(result);
        })
        .catch((cause: unknown) => {
          if (alive.current && !attempt.signal.aborted)
            setError(
              cause instanceof Error ? cause.message : "无法读取旧版资料，请保留浏览器数据后重试。",
            );
        })
        .finally(() => {
          if (alive.current && !attempt.signal.aborted) setReading(false);
        });
    });
    const urls = downloads.current;
    return () => {
      alive.current = false;
      attempt.abort();
      for (const [url, timer] of urls) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      urls.clear();
    };
  }, []);

  const mergeError = useMemo(() => {
    if (!recovery || saved || changedAccount) return "";
    try {
      mergeBackupRestore(data, recovery.plan);
      return "";
    } catch (cause) {
      return cause instanceof Error ? cause.message : "当前云端工作区无法容纳这些资料。";
    }
  }, [data, recovery, saved, changedAccount]);
  const canRestore = Boolean(
    recovery &&
    !reading &&
    !saving &&
    !saved &&
    !changedAccount &&
    !mergeError &&
    (!recovery.plan.missingOriginals.length || acceptedMissing),
  );

  function close() {
    if (committing.current) return;
    controller.current?.abort();
    onClose();
  }
  async function restore() {
    if (!canRestore || !recovery || committing.current) return;
    committing.current = true;
    setSaving(true);
    setError("");
    try {
      // Keep this plan stable after failure: preparing again creates duplicate copies.
      await onRestore(recovery.plan);
      if (alive.current && owner.current === initialAccount) setSaved(true);
    } catch (cause) {
      if (alive.current && owner.current === initialAccount)
        setError(
          cause instanceof Error ? cause.message : "云端保存尚未完成，请重试同一份导入计划。",
        );
    } finally {
      committing.current = false;
      if (alive.current) setSaving(false);
    }
  }
  function download() {
    if (!recovery || saving || changedAccount) return;
    let url: string | undefined;
    let link: HTMLAnchorElement | undefined;
    try {
      url = URL.createObjectURL(recovery.archive);
      link = document.createElement("a");
      link.href = url;
      link.download = "conuo-legacy-browser-backup.zip";
      document.body.append(link);
      link.click();
      const objectUrl = url;
      downloads.current.set(
        objectUrl,
        setTimeout(() => {
          URL.revokeObjectURL(objectUrl);
          downloads.current.delete(objectUrl);
        }, 30_000),
      );
    } catch {
      if (url) URL.revokeObjectURL(url);
      setError("备份下载未完成，请检查浏览器下载权限后重试。");
    } finally {
      link?.remove();
    }
  }

  return (
    <Modal title="导入旧版浏览器资料" onClose={close} dismissible={!saving}>
      <div className="legacy-browser-recovery-panel">
        {changedAccount ? (
          <p role="alert" className="legacy-browser-recovery-warning">
            当前账号已改变，旧版资料导入已停止。请关闭此窗口后，在目标账号重新打开。
          </p>
        ) : saved && recovery ? (
          <>
            <div role="status" className="legacy-browser-recovery-success">
              <CheckCircle2 size={22} />
              <div>
                <h3>旧版资料已保存至云端</h3>
                <p>
                  已为 {accountEmail} 新增 {recovery.plan.counts.sources} 份资料、
                  {recovery.plan.counts.notes} 篇笔记与知识页。旧版浏览器副本仍保留。
                </p>
              </div>
            </div>
            {!!recovery.plan.missingOriginals.length && (
              <p className="legacy-browser-recovery-warning">
                仍有 {recovery.plan.missingOriginals.length}{" "}
                个版本缺少原件，已保留文字、历史与缺失状态。
              </p>
            )}
            <button className="btn" onClick={close}>
              完成
            </button>
          </>
        ) : (
          <>
            <div className="legacy-browser-recovery-destination">
              <b>导入到：{accountEmail}</b>
              <p>
                作为新增副本加入当前云端账号，保留已有内容、历史版本和引用关系。新增资料默认关闭 AI
                使用。
              </p>
              <p>旧版浏览器资料不会被删除。再次打开并导入会另建副本，请勿重复导入已完成的内容。</p>
            </div>
            {reading ? (
              <p role="status" className="legacy-browser-recovery-progress">
                <LoaderCircle size={18} className="spin" />
                正在读取旧版资料并核对备份…
              </p>
            ) : recovery === null ? (
              <p role="status">此浏览器没有可导入的旧版匿名资料。</p>
            ) : null}
            {recovery && (
              <section className="legacy-browser-recovery-preview" aria-label="旧版资料预览">
                <h3>
                  旧版副本包含 {recovery.plan.counts.sources} 份资料、{recovery.plan.counts.notes}{" "}
                  篇笔记
                </h3>
                <dl>
                  {[
                    ["资料库", recovery.plan.counts.spaces],
                    ["资料", recovery.plan.counts.sources],
                    ["资料历史版本", recovery.plan.counts.sourceVersions],
                    ["笔记与知识页", recovery.plan.counts.notes],
                    ["笔记历史版本", recovery.plan.counts.noteVersions],
                    ["对话", recovery.plan.counts.conversations],
                    ["批注", recovery.plan.counts.annotations],
                    ["可导入原件", recovery.plan.blobs.length],
                  ].map(([label, count]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{count}</dd>
                    </div>
                  ))}
                </dl>
                {!!recovery.plan.warnings.length && (
                  <details>
                    <summary>导入说明（{recovery.plan.warnings.length}）</summary>
                    <ul>
                      {recovery.plan.warnings.map((warning, i) => (
                        <li key={i}>{warning}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {!!recovery.plan.missingOriginals.length && (
                  <div className="legacy-browser-recovery-warning">
                    <details open>
                      <summary>缺少 {recovery.plan.missingOriginals.length} 个版本的原件</summary>
                      <ul>
                        {recovery.plan.missingOriginals.map((item, i) => (
                          <li key={i}>
                            {item.title} · 版本 {item.versionId}
                            {item.reason ? `：${item.reason}` : ""}
                          </li>
                        ))}
                      </ul>
                    </details>
                    <label>
                      <input
                        type="checkbox"
                        checked={acceptedMissing}
                        disabled={saving}
                        onChange={(event) => setAcceptedMissing(event.target.checked)}
                      />
                      我了解这些原件缺失，仍导入已有文字、历史与引用记录。
                    </label>
                  </div>
                )}
              </section>
            )}
            {(error || mergeError) && (
              <p role="alert" className="legacy-browser-recovery-error">
                {error || mergeError}
              </p>
            )}
            {saving && (
              <p role="status" className="legacy-browser-recovery-progress">
                <LoaderCircle size={18} className="spin" />
                正在上传原件并确认云端保存，请保持页面打开…
              </p>
            )}
            <div className="legacy-browser-recovery-actions">
              <button className="btn" disabled={saving} onClick={close}>
                取消
              </button>
              {recovery && (
                <button className="btn" disabled={saving || changedAccount} onClick={download}>
                  <Download size={16} />
                  下载旧版备份 ZIP
                </button>
              )}
              <button className="btn primary" disabled={!canRestore} onClick={() => void restore()}>
                {saving ? "正在保存至云端…" : "导入到当前云端账号"}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
