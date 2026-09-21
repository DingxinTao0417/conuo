"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  ExternalLink,
  FileText,
  Globe2,
  Info,
  Link2,
  LoaderCircle,
  MousePointer2,
  Pencil,
  RotateCcw,
  Save,
  Square,
} from "lucide-react";
import type { Source } from "@/lib/types";
import { makeWebSource } from "@/lib/import";
import { makeCapturedWebSource, webPreviewSchema, type WebPreview } from "@/lib/web-import";
import { MAX_WEB_TEXT, normalizeWebUrl } from "@/lib/web-types";
import "./web-import-form.css";

export interface WebImportFormProps {
  targetSpaceId: string;
  cloudUserId?: string;
  refreshSource?: Source;
  /** New imports require an explicit opt-in. Refreshes retain the current source setting. */
  aiAllowed?: boolean;
  onImport: (source: Source) => void | Promise<void>;
  onSaved: (source: Source) => void;
  onBusyChange?: (busy: boolean) => void;
  onDraftStateChange?: (state: { dirty: boolean; saving: boolean }) => void;
}

type Capability = { state: "loading" | "available" | "unavailable"; reason: string };
type Scope = "article" | "selection" | "link";

function responseError(payload: unknown, fallback: string) {
  return payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string"
    ? payload.error.slice(0, 2000)
    : fallback;
}
function urlReason(value: string) {
  try {
    normalizeWebUrl(value);
    return "";
  } catch (cause) {
    return cause instanceof Error ? cause.message : "请输入有效的网页地址。";
  }
}
function normalizedWebUrl(value: string) {
  try {
    return normalizeWebUrl(value);
  } catch {
    return null;
  }
}

/** Textarea offsets use LF newlines; preserve the corresponding exact original substring. */
function selectedOriginalText(text: string, start: number, end: number) {
  const offset = (position: number) => {
    let raw = 0;
    for (let visible = 0; visible < position && raw < text.length; visible++) {
      raw += text[raw] === "\r" && text[raw + 1] === "\n" ? 2 : 1;
    }
    return raw;
  };
  return text.slice(offset(start), offset(end));
}

/** Only identity/version changes destroy drafts. A destination is a save-time choice. */
export function WebImportForm(props: WebImportFormProps) {
  return (
    <WebImportSession
      key={JSON.stringify([
        props.cloudUserId ?? null,
        props.refreshSource?.id ?? null,
        props.refreshSource?.versionId ?? null,
        props.refreshSource?.webSnapshot?.originalUrl ?? props.refreshSource?.url ?? null,
        props.refreshSource?.title ?? null,
      ])}
      {...props}
    />
  );
}

function WebImportSession({
  targetSpaceId,
  cloudUserId,
  refreshSource,
  aiAllowed = false,
  onImport,
  onSaved,
  onBusyChange,
  onDraftStateChange,
}: WebImportFormProps) {
  const formId = useId();
  const [mode, setMode] = useState<"capture" | "manual">("capture");
  const refreshUrl = refreshSource?.webSnapshot?.originalUrl ?? refreshSource?.url ?? "";
  const effectiveAiAllowed = refreshSource?.aiAllowed ?? aiAllowed;
  const [url, setUrl] = useState(refreshUrl);
  const [title, setTitle] = useState(refreshSource?.title ?? "");
  const [manualText, setManualText] = useState("");
  const [preview, setPreview] = useState<WebPreview | null>(null);
  const [scope, setScope] = useState<Scope>("article");
  const [selection, setSelection] = useState("");
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [capability, setCapability] = useState<Capability>({
    state: "loading",
    reason: "正在读取网页提取能力…",
  });
  const [capabilityAttempt, setCapabilityAttempt] = useState(0);
  const mounted = useRef(false);
  const requestRef = useRef<{
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const savePending = useRef(false);
  const busyCallback = useRef(onBusyChange);
  const dirty = Boolean(
    url !== refreshUrl ||
    title !== (refreshSource?.title ?? "") ||
    manualText ||
    preview ||
    selection,
  );

  useEffect(() => {
    onDraftStateChange?.({ dirty, saving });
  }, [dirty, saving, onDraftStateChange]);
  useEffect(() => {
    if (!dirty && !saving) return;
    const protectDraft = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectDraft);
    return () => window.removeEventListener("beforeunload", protectDraft);
  }, [dirty, saving]);

  useEffect(() => {
    busyCallback.current = onBusyChange;
  }, [onBusyChange]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const request = requestRef.current;
      requestRef.current = null;
      if (request) {
        clearTimeout(request.timer);
        request.controller.abort();
        busyCallback.current?.(false);
      }
    };
  }, []);

  // This checks our own endpoint only; visiting the external URL requires the user's button click.
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => controller.abort(), 10_000);
    void (async () => {
      try {
        const response = await fetch("/api/v1/web/preview", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
          headers: cloudUserId ? { "X-Conuo-User": cloudUserId } : {},
        });
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error(responseError(payload, "暂时无法读取网页提取能力。"));
        if (
          !payload ||
          typeof payload !== "object" ||
          !("available" in payload) ||
          typeof payload.available !== "boolean" ||
          ("reason" in payload &&
            payload.reason !== undefined &&
            typeof payload.reason !== "string")
        )
          throw new Error("网页提取能力返回异常，请刷新状态。");
        if (!active) return;
        if (controller.signal.aborted) throw new Error("读取网页提取能力超时。");
        setCapability({
          state: payload.available ? "available" : "unavailable",
          reason:
            "reason" in payload && typeof payload.reason === "string"
              ? payload.reason
              : payload.available
                ? "可以提取网页，点击按钮后才会访问该网址。"
                : "网页提取暂不可用，可手动粘贴正文或保存链接。",
        });
      } catch (cause) {
        if (!active) return;
        setCapability({
          state: "unavailable",
          reason: controller.signal.aborted
            ? "读取网页提取能力超时，可刷新状态或手动保存。"
            : cause instanceof Error
              ? cause.message
              : "暂时无法读取网页提取能力。",
        });
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [cloudUserId, capabilityAttempt]);

  function cancelPreview(message?: string) {
    const request = requestRef.current;
    requestRef.current = null;
    if (request) {
      clearTimeout(request.timer);
      request.controller.abort();
      setFetching(false);
      busyCallback.current?.(false);
    }
    if (message) setNotice(message);
  }
  function changeUrl(value: string) {
    if (refreshSource) return;
    cancelPreview();
    setUrl(value);
    setTitle("");
    setPreview(null);
    setSelection("");
    setScope("article");
    setError("");
    setNotice("");
  }
  function changeMode(value: "capture" | "manual") {
    if (value !== mode) cancelPreview();
    setMode(value);
    setError("");
    setNotice("");
  }
  async function extractPreview() {
    if (requestRef.current || fetching || saving || capability.state !== "available") return;
    let requestedUrl: string;
    try {
      requestedUrl = normalizeWebUrl(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "网址无效。");
      return;
    }
    cancelPreview();
    const controller = new AbortController();
    const request = { controller, timer: setTimeout(() => controller.abort(), 30_000) };
    requestRef.current = request;
    setFetching(true);
    busyCallback.current?.(true);
    setPreview(null);
    setSelection("");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/v1/web/preview", {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(cloudUserId ? { "X-Conuo-User": cloudUserId } : {}),
        },
        body: JSON.stringify({ url: requestedUrl }),
      });
      const payload: unknown = await response.json();
      if (!mounted.current || requestRef.current !== request) return;
      if (controller.signal.aborted) throw new Error("网页提取超时。");
      if (!response.ok)
        throw new Error(responseError(payload, "提取未完成，可重试或手动粘贴正文。"));
      let result: WebPreview;
      try {
        result = webPreviewSchema.parse(payload);
      } catch {
        throw new Error("返回的网页预览格式无效，请重新提取或手动粘贴。");
      }
      if (result.originalUrl !== requestedUrl)
        throw new Error("预览来源与本次输入的网址不一致，请重新提取。");
      setPreview(result);
      setTitle(refreshSource?.title ?? result.title);
      setScope(result.kind === "article" ? "article" : "link");
    } catch (cause) {
      if (!mounted.current || requestRef.current !== request) return;
      setError(
        controller.signal.aborted
          ? "网页提取超时，可重新尝试或手动粘贴正文。"
          : cause instanceof Error
            ? cause.message
            : "提取未完成，可重试或手动粘贴正文。",
      );
    } finally {
      clearTimeout(request.timer);
      if (mounted.current && requestRef.current === request) {
        requestRef.current = null;
        setFetching(false);
        busyCallback.current?.(false);
      }
    }
  }

  async function saveSource(makeSource: () => Source) {
    if (savePending.current) return;
    savePending.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    let imported = false;
    try {
      const source = makeSource();
      await onImport(source);
      imported = true;
      if (!mounted.current) return;
      setPreview(null);
      setSelection("");
      setManualText("");
      setTitle(refreshSource?.title ?? "");
      setUrl(refreshUrl);
      setNotice(
        refreshSource
          ? "新版本已加入工作台，旧版与原有引用保留。请留意工作台保存状态。"
          : source.webSnapshot?.scope === "selection"
            ? "已将所选原文片段与网页来源加入资料库，请留意工作台保存状态。"
            : source.status === "link-only"
              ? "已加入链接收藏；没有正文，暂不可用于内容检索。请留意工作台保存状态。"
              : "已将正文与网页来源加入资料库，请留意工作台保存状态。",
      );
      onSaved(source);
    } catch (cause) {
      if (!mounted.current) return;
      setError(
        imported
          ? "资料已加入工作台，但操作提示未能更新。请在资料库查看，并留意保存状态。"
          : cause instanceof Error
            ? cause.message
            : "保存未完成，请检查内容后重试。",
      );
    } finally {
      savePending.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  function saveLink() {
    cancelPreview();
    void saveSource(() =>
      preview
        ? makeCapturedWebSource({
            preview,
            title,
            scope: "link",
            spaceId: targetSpaceId,
            aiAllowed: effectiveAiAllowed,
          })
        : makeWebSource({
            url,
            title,
            text: "",
            spaceId: targetSpaceId,
            aiAllowed: effectiveAiAllowed,
          }),
    );
  }

  const originUrl = normalizedWebUrl(url);
  const invalidUrl = originUrl ? "" : urlReason(url);
  const selectionValid = Boolean(preview && selection.trim() && preview.text.includes(selection));
  const captureReason = !preview
    ? "请先提取并核对网页预览。"
    : scope === "selection" && !selectionValid
      ? "请选择预览原文中连续的一段文字；改写内容请用手动粘贴保存。"
      : scope !== "link" && preview.kind !== "article"
        ? "没有提取到正文，可仅保存链接或手动粘贴。"
        : "";
  return (
    <fieldset
      className="web-import-form"
      disabled={saving}
      style={{ margin: 0, padding: 0, border: 0 }}
    >
      {refreshSource && (
        <div className="web-import-refresh-note" role="status">
          <Info size={15} />
          <div>
            <strong>为“{refreshSource.title}”创建新版本</strong>
            <p>
              网址与资料名称保持不变。仅预览不会修改资料；明确保存后，旧正文与引用会保留在历史版本中。
            </p>
            <p>选段、仅链接或手动粘贴也会成为新的当前版本，请核对保存范围。</p>
          </div>
        </div>
      )}
      <div className="web-import-modes" aria-label="网页保存方式">
        <button
          type="button"
          aria-pressed={mode === "capture"}
          onClick={() => changeMode("capture")}
        >
          <Globe2 size={13} />
          提取网页
        </button>
        <button type="button" aria-pressed={mode === "manual"} onClick={() => changeMode("manual")}>
          <Pencil size={13} />
          手动粘贴
        </button>
      </div>
      <label className="web-import-label">
        <span>网页地址</span>
        <input
          className="field"
          type="url"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          maxLength={8192}
          placeholder="https://"
          value={url}
          readOnly={Boolean(refreshSource)}
          onChange={(event) => changeUrl(event.target.value)}
          aria-describedby={`${formId}-url-hint`}
        />
        <small id={`${formId}-url-hint`}>
          {refreshSource
            ? "使用这份资料的原始网址刷新，预览不会覆盖正文。"
            : "修改网址会取消当前提取，并清除旧预览。"}
        </small>
      </label>
      {originUrl && (
        <a
          className="web-import-open-origin"
          href={originUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="打开原站（新标签页）"
        >
          <ExternalLink size={13} />
          打开原站（新标签页）
        </a>
      )}
      {error && (
        <div className="web-import-error" role="alert">
          <Info size={14} />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="web-import-notice" role="status">
          <Check size={14} />
          <span>{notice}</span>
        </div>
      )}
      {mode === "manual" ? (
        <form
          className="web-import-manual"
          onSubmit={(event) => {
            event.preventDefault();
            void saveSource(() =>
              makeWebSource({
                url,
                title,
                text: manualText,
                spaceId: targetSpaceId,
                aiAllowed: effectiveAiAllowed,
              }),
            );
          }}
        >
          <label className="web-import-label">
            <span>
              标题<small>选填</small>
            </span>
            <input
              className="field"
              value={title}
              readOnly={Boolean(refreshSource)}
              maxLength={512}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="为这篇文章起个名字"
            />
          </label>
          <label className="web-import-label">
            <span>
              手动粘贴的正文<small>选填</small>
            </span>
            <textarea
              className="field"
              value={manualText}
              maxLength={MAX_WEB_TEXT}
              rows={7}
              onChange={(event) => setManualText(event.target.value)}
              placeholder="粘贴需要保存的正文；留空时仅保存链接。"
            />
          </label>
          <p className="web-import-hint">
            手动保存不会访问外部网页，也不调用 AI。内容会标记为手动粘贴；留空时标记为仅链接。
          </p>
          <div className="web-import-save-actions">
            <span>
              {manualText.length.toLocaleString()} / {MAX_WEB_TEXT.toLocaleString()} 字符
            </span>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={saving || Boolean(invalidUrl)}
            >
              <Save size={14} />
              {refreshSource ? "保存为新版本" : manualText.trim() ? "保存粘贴正文" : "仅保存链接"}
            </button>
          </div>
        </form>
      ) : (
        <>
          <div
            className={`web-import-capability${capability.state === "available" ? " web-import-capability-ready" : ""}`}
            role="status"
          >
            <Info size={14} />
            <span>{capability.reason}</span>
            <button
              type="button"
              className="web-import-text-button"
              disabled={capability.state === "loading"}
              onClick={() => {
                setCapability({ state: "loading", reason: "正在读取网页提取能力…" });
                setCapabilityAttempt((value) => value + 1);
              }}
            >
              <RotateCcw size={12} />
              刷新状态
            </button>
          </div>
          <div className="web-import-extract-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                fetching || saving || Boolean(invalidUrl) || capability.state !== "available"
              }
              onClick={() => void extractPreview()}
            >
              {fetching ? (
                <LoaderCircle size={14} className="web-import-spinner" />
              ) : (
                <Globe2 size={14} />
              )}
              {fetching ? "正在提取…" : "提取预览"}
            </button>
            {fetching && (
              <button
                type="button"
                className="btn"
                onClick={() =>
                  cancelPreview("已取消提取，本次未加入资料库。可重新提取或手动保存。")
                }
              >
                <Square size={12} />
                取消提取
              </button>
            )}
            <span>先预览，再选择保存范围。</span>
          </div>
          {preview ? (
            <section className="web-import-preview" aria-label="应用内学习阅读版（只读纯文本）">
              <div className="web-import-preview-heading">
                <span>
                  <FileText size={15} />
                  {preview.kind === "article"
                    ? "应用内学习阅读版（只读纯文本）"
                    : "应用内学习阅读版（未提取到正文）"}
                </span>
                <small>{preview.text.length.toLocaleString()} 字符</small>
              </div>
              <label className="web-import-label">
                <span>
                  保存标题<small>{refreshSource ? "保留原名称" : "可编辑"}</small>
                </span>
                <input
                  className="field"
                  value={title}
                  readOnly={Boolean(refreshSource)}
                  maxLength={512}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <dl className="web-import-metadata">
                <div>
                  <dt>原始网址</dt>
                  <dd>
                    <a href={preview.originalUrl} target="_blank" rel="noopener noreferrer">
                      {preview.originalUrl}
                    </a>
                  </dd>
                </div>
                <div>
                  <dt>最终网址</dt>
                  <dd>
                    <a href={preview.finalUrl} target="_blank" rel="noopener noreferrer">
                      {preview.finalUrl}
                    </a>
                  </dd>
                </div>
                <div>
                  <dt>采集时间</dt>
                  <dd>{new Date(preview.capturedAt).toLocaleString("zh-CN")}</dd>
                </div>
                {preview.siteName && (
                  <div>
                    <dt>网站</dt>
                    <dd>{preview.siteName}</dd>
                  </div>
                )}
                {preview.byline && (
                  <div>
                    <dt>署名</dt>
                    <dd>{preview.byline}</dd>
                  </div>
                )}
                <div>
                  <dt>提取范围</dt>
                  <dd>
                    {preview.kind === "article"
                      ? "本次提取到的文章正文"
                      : "网页链接与标题，没有正文"}
                  </dd>
                </div>
              </dl>
              {preview.warnings.length > 0 && (
                <div className="web-import-warnings" role="status">
                  <Info size={14} />
                  <div>
                    <strong>提取说明</strong>
                    <ul>
                      {preview.warnings.map((warning, index) => (
                        <li key={index}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
              {preview.kind === "article" ? (
                <>
                  <label className="web-import-label web-import-fulltext">
                    <span>
                      应用内学习阅读版全文<small>只读纯文本；可用鼠标或键盘划选原文</small>
                    </span>
                    <textarea
                      className="field"
                      readOnly
                      value={preview.text}
                      rows={11}
                      aria-label="应用内学习阅读版全文（只读纯文本）"
                      onSelect={(event) => {
                        const field = event.currentTarget;
                        if (field.selectionEnd > field.selectionStart) {
                          const text = selectedOriginalText(
                            preview.text,
                            field.selectionStart,
                            field.selectionEnd,
                          );
                          if (text.trim()) {
                            setSelection(text);
                            setScope("selection");
                          }
                        }
                      }}
                    />
                  </label>
                  <p className="web-import-hint">
                    这是本次获取的文字快照。阅读版只显示提取的纯文本，不加载原站脚本、图片或
                    Cookie； 页面中的后续更新、登录后内容或未提取部分不会自动补入。
                  </p>
                </>
              ) : (
                <p className="web-import-hint">可以仅保存网页链接，或切换到手动粘贴来补充正文。</p>
              )}
              <fieldset className="web-import-scopes">
                <legend>保存范围</legend>
                <label>
                  <input
                    type="radio"
                    name={`${formId}-capture-scope`}
                    value="article"
                    checked={scope === "article"}
                    disabled={preview.kind !== "article"}
                    onChange={() => setScope("article")}
                  />
                  <span>
                    <strong>提取正文</strong>
                    <small>保存本次预览的全部正文</small>
                  </span>
                </label>
                <label>
                  <input
                    type="radio"
                    name={`${formId}-capture-scope`}
                    value="selection"
                    checked={scope === "selection"}
                    disabled={preview.kind !== "article"}
                    onChange={() => setScope("selection")}
                  />
                  <span>
                    <strong>仅保存选段</strong>
                    <small>AI 仅依据所选文字回答</small>
                  </span>
                </label>
                <label>
                  <input
                    type="radio"
                    name={`${formId}-capture-scope`}
                    value="link"
                    checked={scope === "link"}
                    onChange={() => setScope("link")}
                  />
                  <span>
                    <strong>仅保存链接</strong>
                    <small>不保存正文，暂不可内容检索</small>
                  </span>
                </label>
              </fieldset>
              {scope === "selection" && (
                <div className="web-import-selection">
                  <label className="web-import-label">
                    <span>
                      <MousePointer2 size={13} />
                      要保存的原文选段
                    </span>
                    <textarea
                      className="field"
                      rows={5}
                      maxLength={MAX_WEB_TEXT}
                      value={selection}
                      onChange={(event) => setSelection(event.target.value)}
                      placeholder="先在上方划选，或把连续的一段预览原文放到这里。"
                    />
                  </label>
                  <p className={selectionValid ? "web-import-selection-valid" : "web-import-hint"}>
                    {selectionValid
                      ? `已核对为预览中的连续原文，共 ${selection.length.toLocaleString()} 字符；不会保存未选中的内容。`
                      : "选段必须与预览原文连续一致，不能拼接或改写。改写内容请切换到手动粘贴。"}
                  </p>
                </div>
              )}
              <div className="web-import-save-actions">
                <span>
                  {captureReason ||
                    (scope === "link"
                      ? "将仅保存链接与本次采集信息。"
                      : scope === "selection"
                        ? "只保存选段，检索与问答不覆盖整篇网页。"
                        : "将保存当前正文快照与采集信息。")}
                </span>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={saving || Boolean(captureReason)}
                  onClick={() =>
                    void saveSource(() =>
                      makeCapturedWebSource({
                        preview,
                        title,
                        scope,
                        ...(scope === "selection" ? { text: selection } : {}),
                        spaceId: targetSpaceId,
                        aiAllowed: effectiveAiAllowed,
                      }),
                    )
                  }
                >
                  <Save size={14} />
                  {refreshSource
                    ? "保存为新版本"
                    : scope === "article"
                      ? "保存提取正文"
                      : scope === "selection"
                        ? "保存所选片段"
                        : "仅保存链接"}
                </button>
              </div>
            </section>
          ) : (
            !fetching && (
              <div className="web-import-fallback">
                <p>也可以直接保存链接，或手动粘贴正文。</p>
                <div>
                  <button
                    type="button"
                    className="btn"
                    disabled={saving || Boolean(invalidUrl)}
                    onClick={saveLink}
                  >
                    <Link2 size={13} />
                    {refreshSource ? "仅链接保存为新版本" : "仅保存链接"}
                  </button>
                  <button
                    type="button"
                    className="web-import-text-button"
                    onClick={() => changeMode("manual")}
                  >
                    <Pencil size={12} />
                    手动粘贴正文
                  </button>
                </div>
              </div>
            )
          )}
        </>
      )}
    </fieldset>
  );
}

export default WebImportForm;
