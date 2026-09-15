"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AlertCircle, FileUp, History, Info, LoaderCircle, Save } from "lucide-react";
import { prepareFile } from "@/lib/import";
import type { Source } from "@/lib/types";
import { isParserCoverageIncomplete } from "@/lib/source-coverage";
import "./file-replacement-form.css";

export interface FileReplacementFormProps {
  source: Source;
  targetSpaceId: string;
  cloudUserId?: string;
  onReplace: (candidate: Source, blob: Blob, expectedVersionId: string) => Promise<void>;
  onSaved: (source: Source) => void;
  onCancel: () => void;
  onViewHistory: () => void;
}

const kindLabels: Record<Source["kind"], string> = {
  pdf: "PDF",
  docx: "DOCX",
  markdown: "Markdown",
  text: "TXT",
  web: "网页",
};
const statusLabels: Record<Source["status"], string> = {
  saved: "待解析",
  parsing: "正在解析",
  ready: "正文解析完成",
  partial: "仅部分正文解析完成",
  failed: "没有可用的解析正文",
  "link-only": "仅链接",
};
function formatSize(size: number) {
  return size >= 1024 * 1024
    ? `${(size / (1024 * 1024)).toFixed(2)} MB`
    : size >= 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${size} B`;
}

/** A changed account, version or library invalidates all memory-only preview work. */
export function FileReplacementForm(props: FileReplacementFormProps) {
  return (
    <FileReplacementSession
      key={JSON.stringify([
        props.cloudUserId ?? null,
        props.targetSpaceId,
        props.source.id,
        props.source.versionId,
        [...props.source.spaceIds].sort(),
        props.source.title,
        props.source.deletedAt,
      ])}
      {...props}
    />
  );
}

function FileReplacementSession({
  source,
  targetSpaceId,
  onReplace,
  onSaved,
  onCancel,
  onViewHistory,
}: FileReplacementFormProps) {
  const formId = useId();
  const [preview, setPreview] = useState<{ candidate: Source; file: File } | null>(null);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [coverageConfirmed, setCoverageConfirmed] = useState(false);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const mounted = useRef(false);
  const parseSequence = useRef(0);
  const savePending = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      parseSequence.current += 1;
    };
  }, []);

  function discard(clearInput = true) {
    parseSequence.current += 1;
    setPreview(null);
    setParsing(false);
    setError("");
    setCoverageConfirmed(false);
    setRestoreConfirmed(false);
    if (clearInput && fileInput.current) fileInput.current.value = "";
  }

  async function selectFile(file: File) {
    if (savePending.current) return;
    discard(false);
    const attempt = ++parseSequence.current;
    setParsing(true);
    try {
      const candidate = await prepareFile(file, targetSpaceId === "inbox" ? "" : targetSpaceId);
      if (!mounted.current || attempt !== parseSequence.current) return;
      // The displayed library name is independent from the new original filename.
      setPreview({ candidate: { ...candidate, title: source.title }, file });
    } catch (cause) {
      if (!mounted.current || attempt !== parseSequence.current) return;
      setError(cause instanceof Error ? cause.message : "文件预览失败，请重新选择文件。");
    } finally {
      if (mounted.current && attempt === parseSequence.current) setParsing(false);
    }
  }

  const candidate = preview?.candidate;
  const duplicate = Boolean(
    candidate?.hash && candidate.hash === source.hash && !source.originalMissing,
  );
  const previous = candidate?.hash
    ? source.versions?.find((version) => version.hash === candidate.hash)
    : undefined;
  const coverageLimited = Boolean(
    candidate &&
    (isParserCoverageIncomplete(candidate) || !candidate.text || !candidate.chunks.length),
  );
  const usable = Boolean(
    candidate &&
    ["ready", "partial", "failed"].includes(candidate.status) &&
    candidate.kind !== "web",
  );
  const canSave = Boolean(
    preview &&
    usable &&
    !duplicate &&
    (!previous || restoreConfirmed) &&
    (!coverageLimited || coverageConfirmed) &&
    !source.deletedAt &&
    !parsing &&
    !saving,
  );

  async function save() {
    if (!canSave || !preview || savePending.current || !mounted.current) return;
    savePending.current = true;
    setSaving(true);
    setError("");
    try {
      await onReplace(preview.candidate, preview.file, source.versionId);
      if (mounted.current) {
        discard();
        onSaved(preview.candidate);
      }
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "新版本保存失败，旧版仍保留。请重试。");
    } finally {
      savePending.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <form
      className="file-replacement-form"
      aria-label="文件替换预览"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="file-replacement-hint">
        <Info size={15} />
        <span>
          资料名称“{source.title}”、标签和归属保持不变。可在 PDF、DOCX、Markdown、TXT
          之间替换；确认后保留旧原件、正文和引用，新文件成为当前版本。
        </span>
      </p>
      <label className="file-replacement-picker" htmlFor={`${formId}-file`}>
        <span>
          <FileUp size={15} />
          选择一个新文件
        </span>
        <input
          ref={fileInput}
          id={`${formId}-file`}
          type="file"
          accept=".pdf,.docx,.md,.markdown,.txt"
          disabled={saving || Boolean(source.deletedAt)}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) void selectFile(file);
          }}
        />
        <small>每个文件不超过 30 MB。选择后仅解析预览，点击下方确认按钮才保存原件和新版本。</small>
      </label>
      {parsing && (
        <p className="file-replacement-progress" role="status">
          <LoaderCircle size={15} className="spin" />
          正在解析文件，可取消或选择另一个文件…
        </p>
      )}
      {candidate && (
        <section className="file-replacement-preview" aria-label="新文件预览">
          <h3>{candidate.filename}</h3>
          <dl>
            <div>
              <dt>格式</dt>
              <dd>{kindLabels[candidate.kind]}</dd>
            </div>
            <div>
              <dt>大小</dt>
              <dd>{formatSize(candidate.size)}</dd>
            </div>
            <div>
              <dt>解析状态</dt>
              <dd>{statusLabels[candidate.status]}</dd>
            </div>
            {candidate.pageCount !== undefined && (
              <div>
                <dt>页面</dt>
                <dd>
                  {candidate.parsedPages ?? 0} / {candidate.pageCount} 页已解析
                </dd>
              </div>
            )}
          </dl>
          {candidate.error && <p className="file-replacement-warning">{candidate.error}</p>}
          {candidate.text ? (
            <>
              <label htmlFor={`${formId}-text`}>正文片段</label>
              <textarea id={`${formId}-text`} readOnly value={candidate.text.slice(0, 4000)} />
              <small>
                共 {candidate.text.length.toLocaleString()} 字符，预览最多显示前 4,000 字符。
              </small>
            </>
          ) : (
            <p className="file-replacement-warning">
              未提取到正文。确认后可保留原件，新问答无法使用这份新版本的正文。
            </p>
          )}
          {duplicate ? (
            <p className="file-replacement-warning" role="status">
              内容与当前文件相同，无需创建新版本。可以取消、选择另一个文件，或查看版本历史。
            </p>
          ) : (
            <>
              {previous && (
                <label className="file-replacement-confirm">
                  <input
                    type="checkbox"
                    checked={restoreConfirmed}
                    disabled={saving}
                    onChange={(event) => setRestoreConfirmed(event.target.checked)}
                  />
                  <span>
                    内容与历史版本（{previous.filename}，
                    {new Date(previous.createdAt).toLocaleString("zh-CN")}
                    ）相同。我确认将这份历史内容重新保存为当前新版本，其他版本仍保留。
                  </span>
                </label>
              )}
              {coverageLimited && (
                <label className="file-replacement-confirm">
                  <input
                    type="checkbox"
                    checked={coverageConfirmed}
                    disabled={saving}
                    onChange={(event) => setCoverageConfirmed(event.target.checked)}
                  />
                  <span>
                    我已了解正文解析
                    {candidate.text && candidate.chunks.length
                      ? "不完整，新问答只使用已解析内容"
                      : "失败，新问答无法使用这份新版本的正文"}
                    ，仍要保存原件作为新版本。旧版和旧引用保留。
                  </span>
                </label>
              )}
            </>
          )}
        </section>
      )}
      {error && (
        <p className="file-replacement-error" role="alert">
          <AlertCircle size={15} />
          {error}
        </p>
      )}
      {source.deletedAt && (
        <p className="file-replacement-error" role="alert">
          资料已移入回收站，不能替换文件。
        </p>
      )}
      <div className="file-replacement-actions">
        <button
          type="button"
          className="btn"
          disabled={saving}
          onClick={() => {
            discard();
            onCancel();
          }}
        >
          取消
        </button>
        <button
          type="button"
          className="btn"
          disabled={saving}
          onClick={() => {
            discard();
            onViewHistory();
          }}
        >
          <History size={13} />
          查看版本历史
        </button>
        <button type="submit" className="btn btn-primary" disabled={!canSave}>
          {saving ? <LoaderCircle size={13} className="spin" /> : <Save size={13} />}
          {saving ? "正在保存新版本…" : "保存为新版本"}
        </button>
      </div>
    </form>
  );
}

export default FileReplacementForm;
