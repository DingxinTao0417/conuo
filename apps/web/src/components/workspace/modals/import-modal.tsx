"use client";
import { useMemo, useRef, useState } from "react";
import { Cloud, FileText, Loader2, Upload } from "lucide-react";
import type { SaveState, Source, Space } from "@/lib/types";
import type { ImportJob } from "@/lib/import-queue";
import {
  LOCAL_IMPORT_QUOTA_POLICY,
  assessImportQuota,
  formatImportQuotaBytes,
} from "@/lib/import-quota";
import Modal from "../../modal";
import WebImportForm from "../../web-import-form";

export function ImportModal({
  storageMode = "hybrid",
  spaceId,
  spaces,
  sources,
  jobs,
  cloudUserId,
  saveState,
  saveError,
  onWebImport,
  onImportFile,
  onRetryImport,
  onCancelImport,
  onClose,
  onOpen,
}: {
  storageMode?: "hybrid" | "cloud";
  spaceId: string;
  spaces: Space[];
  sources: Source[];
  jobs: ImportJob[];
  cloudUserId?: string;
  saveState: SaveState;
  saveError?: string;
  onWebImport: (source: Source) => void;
  onImportFile: (
    file: File,
    targetSpaceId: string,
    keepDuplicate?: boolean,
    aiAllowed?: boolean,
  ) => Promise<{ kind: "duplicate"; source: Source } | { kind: "queued"; job: ImportJob }>;
  onRetryImport: (jobId: string) => Promise<void>;
  onCancelImport: (jobId: string) => void;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const [tab, setTab] = useState("file");
  const [webOpened, setWebOpened] = useState(false);
  const [webDraft, setWebDraft] = useState({ dirty: false, saving: false });
  const [exitAction, setExitAction] = useState<(() => void) | null>(null);
  const [target, setTarget] = useState(spaceId);
  const [aiAllowed, setAiAllowed] = useState(false);
  const [starting, setStarting] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [logs, setLogs] = useState<
    {
      title: string;
      detail: string;
      id?: string;
      jobId?: string;
      duplicate?: { source: Source; file: File; target: string; aiAllowed: boolean };
    }[]
  >([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const importQueue = useRef<Promise<void>>(Promise.resolve());
  const loggedJobIds = useMemo(
    () => new Set(logs.flatMap((log) => (log.jobId ? [log.jobId] : []))),
    [logs],
  );
  const visibleJobs = useMemo(
    () => jobs.filter((job) => job.status !== "completed" || loggedJobIds.has(job.id)),
    [jobs, loggedJobIds],
  );
  const currentJobIds = useMemo(() => new Set(jobs.map((job) => job.id)), [jobs]);
  const visibleLogs = useMemo(
    () =>
      logs.flatMap((log, index) =>
        log.jobId && currentJobIds.has(log.jobId) ? [] : [{ log, index }],
      ),
    [currentJobIds, logs],
  );
  const quotaUsage = useMemo(() => assessImportQuota({ sources }, []).usage, [sources]);
  const sourceForJob = (job: ImportJob) =>
    sources.find((source) => source.id === job.sourceId && source.versionId === job.versionId);
  const cloudConfirmation = useMemo(() => {
    const trackedSourceIds = new Set([
      ...visibleJobs.map((job) => job.sourceId),
      ...logs.flatMap((log) => (log.id ? [log.id] : [])),
    ]);
    const originalUploaded = sources.some(
      (source) =>
        trackedSourceIds.has(source.id) &&
        [source, ...(source.versions ?? [])].some((version) => Boolean(version.storagePath)),
    );
    if (!cloudUserId)
      return {
        tone: "local",
        detail: "仅保存在此浏览器；登录后才会上传原文件并确认资料库。",
      };
    if (saveState === "loading" || saveState === "saving")
      return {
        tone: "pending",
        detail: originalUploaded
          ? "原文件已上传，正在确认资料库…"
          : storageMode === "cloud"
            ? "正在上传原件并保存资料库；完成前请保持页面打开。"
            : "本机已保存，正在上传并确认资料库…",
      };
    if (saveState === "cloud") return { tone: "confirmed", detail: "当前工作区已确认云端。" };
    if (saveState === "error" || saveState === "conflict")
      return {
        tone: "blocked",
        detail: `${
          originalUploaded
            ? "原文件已上传，但资料库云端未确认。"
            : storageMode === "cloud"
              ? "当前页面暂存修改，云端未确认。"
              : "本机已保留，云端未确认。"
        }${saveError ? ` ${saveError}` : " 请处理保存问题后重新连接。"}`,
      };
    return {
      tone: "local",
      detail:
        storageMode === "cloud" ? "当前页面暂存修改；尚未确认云端。" : "本机已保存；尚未确认云端。",
    };
  }, [storageMode, cloudUserId, logs, saveError, saveState, sources, visibleJobs]);
  const jobDetail = (job: ImportJob, source?: Source) => {
    if (source?.deletedAt) return "资料已移入回收站；恢复后可在这里重新解析。";
    if (!source) return "对应资料的当前版本已不可用，无法继续解析。";
    if (job.status === "queued")
      return storageMode === "cloud"
        ? saveState === "cloud"
          ? "任务已保存到云端，等待解析。"
          : "等待解析与云端保存确认；完成前请保持页面打开。"
        : "等待解析；关闭窗口后会继续保留这条任务。";
    if (job.status === "running")
      return job.stage === "indexing" ? "正在整理检索内容…" : "正在解析原文件…";
    if (job.status === "cancelled") return "解析已取消，原文件仍已保存。";
    if (job.status === "completed")
      return source?.status === "partial"
        ? source.error || "解析已完成，但只有部分正文可检索。"
        : "解析完成，正文已可检索。";
    return job.error || "导入未完成，可使用原文件重新解析。";
  };
  async function startFile(
    file: File,
    targetSpaceId: string,
    keepDuplicate = false,
    sourceAiAllowed = aiAllowed,
  ) {
    setStarting((count) => count + 1);
    try {
      const result = await onImportFile(file, targetSpaceId, keepDuplicate, sourceAiAllowed);
      if (result.kind === "duplicate") {
        setLogs((current) => [
          ...current,
          {
            title: file.name,
            detail: "检测到相同内容，已关联已有资料。该资料的 AI 使用设置保持不变。",
            id: result.source.id,
            duplicate: {
              source: result.source,
              file,
              target: targetSpaceId,
              aiAllowed: sourceAiAllowed,
            },
          },
        ]);
      } else {
        setLogs((current) => [
          ...current,
          {
            title: file.name,
            detail:
              storageMode === "cloud"
                ? "已进入云端导入流程；原件与资料库是否保存完成，以云端确认状态为准。"
                : "原文件已保存，正在后台解析；可关闭此窗口继续使用资料库。",
            id: result.job.sourceId,
            jobId: result.job.id,
          },
        ]);
      }
    } catch (cause) {
      setLogs((current) => [
        ...current,
        { title: file.name, detail: cause instanceof Error ? cause.message : "导入失败，请重试。" },
      ]);
    } finally {
      setStarting((count) => Math.max(0, count - 1));
    }
  }
  function queueImportFiles(
    files: FileList | File[],
    targetSpaceId: string,
    keepDuplicate = false,
    sourceAiAllowed = aiAllowed,
  ) {
    const selected = Array.from(files);
    // A normal pick might reuse an existing original. Keep structural limits in
    // the modal, but let the coordinator make the account-capacity decision
    // after SHA-256 duplicate detection. An explicitly requested copy always
    // consumes another original-file allowance, so it keeps the strict preview.
    const assessment = assessImportQuota({ sources }, selected, undefined, {
      deferAccountStorageLimit: !keepDuplicate,
    });
    const strictAccountPreview = keepDuplicate ? null : assessImportQuota({ sources }, selected);
    const deferredAccountIndexes = new Set<number>();
    for (const item of strictAccountPreview?.items || []) {
      if (
        !item.accepted &&
        item.rejections.some((rejection) => rejection.code === "account-storage-limit")
      )
        deferredAccountIndexes.add(item.index);
    }
    const rejected = assessment.items.flatMap((item) => {
      if (item.accepted) return [];
      return [
        {
          title: item.file.name || "未命名文件",
          detail: item.rejections.map((rejection) => rejection.message).join(" "),
        },
      ];
    });
    const deferred = assessment.items.flatMap((item) => {
      if (!item.accepted || !deferredAccountIndexes.has(item.index)) return [];
      return [
        {
          title: item.file.name || "未命名文件",
          detail:
            "账户空间不足，会先核对内容是否已保存；是否可继续将由导入时判定。相同内容会关联已有资料，新增内容将被拒绝。",
        },
      ];
    });
    if (rejected.length || deferred.length)
      setLogs((current) => [...current, ...rejected, ...deferred]);

    const accepted = assessment.items.flatMap((item) => {
      if (!item.accepted) return [];
      const file = selected[item.index];
      return file ? [file] : [];
    });
    if (!accepted.length) return false;

    // Keep every UI-triggered import in one queue. In particular, selecting a
    // batch cannot make several originals race through persistence at once.
    const run = async () => {
      for (const file of accepted)
        await startFile(file, targetSpaceId, keepDuplicate, sourceAiAllowed);
    };
    const queued = importQueue.current.then(run, run);
    importQueue.current = queued.catch(() => {});
    return true;
  }
  function importFiles(files: FileList | File[]) {
    return queueImportFiles(files, target);
  }
  function requestExit(action: () => void) {
    if (webDraft.saving) return;
    if (webDraft.dirty) setExitAction(() => action);
    else action();
  }
  return (
    <>
      <Modal
        title="导入学习资料"
        onClose={() => requestExit(onClose)}
        wide
        dismissible={!webDraft.saving}
      >
        <div className="modal-body">
          <div className="tabs">
            <button
              className={tab === "file" ? "active" : ""}
              disabled={webDraft.saving}
              onClick={() => setTab("file")}
            >
              上传文件
            </button>
            <button
              className={tab === "web" ? "active" : ""}
              disabled={webDraft.saving}
              onClick={() => {
                setWebOpened(true);
                setTab("web");
              }}
            >
              保存网页
            </button>
          </div>
          <label>
            保存到
            <select
              className="field"
              value={target}
              disabled={webDraft.saving}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">收件箱</option>
              {spaces.map((s) => (
                <option value={s.id} key={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox-row import-ai-consent">
            <input
              type="checkbox"
              aria-label="允许 AI 使用本次导入的资料"
              checked={aiAllowed}
              disabled={webDraft.saving}
              onChange={(event) => setAiAllowed(event.target.checked)}
            />
            <span>
              <strong>允许 AI 使用本次导入的资料</strong>
              <small>
                用于带出处的问答、摘要和整理；未勾选仍可解析、阅读与普通搜索，可在资料详情随时更改。
              </small>
            </span>
          </label>
          {tab === "file" && (
            <>
              <input
                type="file"
                multiple
                accept=".pdf,.docx,.md,.markdown,.txt"
                ref={fileRef}
                className="visually-hidden"
                aria-label="选择要导入的文件"
                onChange={(e) => {
                  if (e.target.files) void importFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                className={`dropzone ${dragging ? "dragging" : ""}`}
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  void importFiles(e.dataTransfer.files);
                }}
              >
                {starting ? <Loader2 size={30} className="spin" /> : <Upload size={30} />}
                <b>{starting ? "正在保留原文件…" : "点击选择，或把文件拖到这里"}</b>
                <span>
                  PDF、DOCX、Markdown、TXT · 单个文件不超过{" "}
                  {formatImportQuotaBytes(LOCAL_IMPORT_QUOTA_POLICY.maxFileBytes)}
                </span>
                <small>原文件保存后，解析可在后台继续、取消或重新开始。</small>
              </button>
              <div
                className="notice import-quota"
                aria-label={storageMode === "cloud" ? "导入保护额度" : "本机导入额度"}
                role="status"
              >
                <span>
                  <b>账户已用</b> {formatImportQuotaBytes(quotaUsage.bytes)} /{" "}
                  {formatImportQuotaBytes(quotaUsage.accountLimitBytes)}
                </span>
                <small>剩余 {formatImportQuotaBytes(quotaUsage.accountRemainingBytes)}</small>
                <small>
                  每批最多 {quotaUsage.batchFileLimit} 个文件，合计{" "}
                  {formatImportQuotaBytes(quotaUsage.batchByteLimit)}
                </small>
                {quotaUsage.accountRemainingBytes === 0 ? (
                  <small>额度已满时会先判重；是否可继续将由导入时判定。</small>
                ) : null}
              </div>
            </>
          )}
          <div hidden={tab !== "web"}>
            {webOpened && (
              <WebImportForm
                targetSpaceId={target}
                cloudUserId={cloudUserId}
                aiAllowed={aiAllowed}
                onDraftStateChange={setWebDraft}
                onImport={onWebImport}
                onSaved={(source) =>
                  setLogs((current) => [
                    ...current,
                    {
                      title: source.title,
                      detail:
                        source.status === "link-only"
                          ? "已加入链接收藏；没有正文，不参与正文检索。"
                          : `已加入资料库 · ${source.chunks.length} 个内容块，请留意工作台保存状态。`,
                      id: source.id,
                    },
                  ])
                }
              />
            )}
          </div>
          {(visibleJobs.length > 0 || visibleLogs.length > 0) && (
            <div className="import-results" aria-live="polite">
              <div
                className={`import-cloud-confirmation ${cloudConfirmation.tone}`}
                aria-label="云端确认"
                role="status"
              >
                <Cloud size={16} />
                <div className="grow">
                  <b>云端确认</b>
                  <p>{cloudConfirmation.detail}</p>
                </div>
              </div>
              {visibleJobs.map((job) => {
                const source = sourceForJob(job);
                return (
                  <div key={job.id}>
                    <FileText size={16} />
                    <div className="grow">
                      <b>{source?.title || job.filename}</b>
                      <p>{jobDetail(job, source)}</p>
                    </div>
                    {source && !source.deletedAt && (
                      <button
                        className="text-button"
                        disabled={webDraft.saving}
                        onClick={() => requestExit(() => onOpen(source.id))}
                      >
                        查看
                      </button>
                    )}
                    {(job.status === "queued" || job.status === "running") && (
                      <button className="text-button" onClick={() => onCancelImport(job.id)}>
                        取消
                      </button>
                    )}
                    {(job.status === "failed" || job.status === "cancelled") && (
                      <button
                        className="text-button"
                        disabled={!source || !!source.deletedAt || !job.originalSaved}
                        title={
                          source?.deletedAt
                            ? "请先在回收站恢复资料，再重新解析。"
                            : !source
                              ? "对应资料的当前版本已不可用，无法重新解析。"
                              : !job.originalSaved
                                ? "原文件尚未保存，请重新选择文件。"
                                : undefined
                        }
                        onClick={() => {
                          void onRetryImport(job.id).catch((cause) =>
                            setLogs((current) => [
                              ...current,
                              {
                                title: source?.title || job.filename,
                                detail:
                                  cause instanceof Error ? cause.message : "重新解析失败，请重试。",
                              },
                            ]),
                          );
                        }}
                      >
                        重新解析
                      </button>
                    )}
                  </div>
                );
              })}
              {visibleLogs.map(({ log, index: logIndex }) => (
                <div key={logIndex}>
                  <FileText size={16} />
                  <div className="grow">
                    <b>{log.title}</b>
                    <p>{log.detail}</p>
                  </div>
                  {log.id && (
                    <button
                      className="text-button"
                      disabled={webDraft.saving}
                      onClick={() => requestExit(() => onOpen(log.id!))}
                    >
                      阅读
                    </button>
                  )}
                  {log.duplicate && (
                    <button
                      className="text-button"
                      onClick={() => {
                        const duplicate = log.duplicate!;
                        if (
                          queueImportFiles(
                            [duplicate.file],
                            duplicate.target,
                            true,
                            duplicate.aiAllowed,
                          )
                        )
                          setLogs((current) =>
                            current.map((item, index) =>
                              index === logIndex
                                ? {
                                    ...item,
                                    detail: "正在保留独立副本…",
                                    duplicate: undefined,
                                  }
                                : item,
                            ),
                          );
                      }}
                    >
                      保留副本
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="modal-actions">
            <span className="muted">资料默认仅你可见；后台任务会保存在当前工作区。</span>
            <button className="btn" disabled={webDraft.saving} onClick={() => requestExit(onClose)}>
              {webDraft.saving ? "正在确认保存…" : "完成"}
            </button>
          </div>
        </div>
      </Modal>
      {exitAction && (
        <Modal title="放弃未保存的网页草稿？" onClose={() => setExitAction(null)}>
          <div className="modal-body">
            <p>网址、标题和正文还没有加入资料库，仅保留在当前页面。放弃后无法恢复。</p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setExitAction(null)}>
                继续编辑
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  setExitAction(null);
                  exitAction();
                }}
              >
                放弃草稿并离开
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
