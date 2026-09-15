"use client";

import { CloudDownload, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import "./cloud-update-notice.css";

export interface CloudUpdateNoticeProps {
  revision: number | null;
  checking: boolean;
  loading: boolean;
  error: string;
  onLoad: () => void;
  onCheck: () => void;
}

export default function CloudUpdateNotice({
  revision,
  checking,
  loading,
  error,
  onLoad,
  onCheck,
}: CloudUpdateNoticeProps) {
  const hasUpdate = revision !== null;
  if (!hasUpdate && !error) return null;
  const busy = checking || loading;

  return (
    <section
      className={`notice cloud-update-notice${error ? " cloud-update-notice-error" : ""}`}
      role={error ? "alert" : "status"}
      aria-label="云端工作区更新"
      aria-busy={busy}
    >
      {error ? <TriangleAlert size={16} aria-hidden /> : <CloudDownload size={16} aria-hidden />}
      <div className="cloud-update-notice-content">
        <strong>{hasUpdate ? "云端有新的工作区版本" : "暂时无法检查云端更新"}</strong>
        {hasUpdate && <p>当前页面内容已保留。载入前会复核未同步修改，必要时进入冲突处理。</p>}
        {error && <p>{error}</p>}
      </div>
      <div className="cloud-update-notice-actions">
        {hasUpdate ? (
          <button className="text-button" disabled={busy} onClick={onLoad}>
            {loading ? (
              <Loader2 size={14} className="spin" aria-hidden />
            ) : (
              <CloudDownload size={14} aria-hidden />
            )}
            {loading ? "正在载入更新…" : "检查并载入更新"}
          </button>
        ) : (
          <button className="text-button" disabled={busy} onClick={onCheck}>
            {checking ? (
              <Loader2 size={14} className="spin" aria-hidden />
            ) : (
              <RefreshCw size={14} aria-hidden />
            )}
            {checking ? "正在检查…" : "重新检查"}
          </button>
        )}
      </div>
    </section>
  );
}
