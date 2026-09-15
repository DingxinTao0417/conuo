"use client";

import { useRef } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import "./account-access-stopped.css";

type Props = {
  state: "clearing" | "blocked" | "cleanup-failed" | "verification-failed";
  onOpenAccount: () => void;
  onRetryCleanup: () => Promise<void>;
  onRetryVerification?: () => Promise<void>;
};

export default function AccountAccessStopped({
  state,
  onOpenAccount,
  onRetryCleanup,
  onRetryVerification,
}: Props) {
  const retrying = useRef(false);
  const clearing = state === "clearing";
  const verificationFailed = state === "verification-failed";
  async function retry() {
    if (retrying.current) return;
    retrying.current = true;
    try {
      if (verificationFailed) await onRetryVerification?.();
      else await onRetryCleanup();
    } catch {
      // The coordinator retains the blocked view and reports cleanup failure.
    } finally {
      retrying.current = false;
    }
  }

  return (
    <section className="account-access-stopped" aria-labelledby="account-access-stopped-title">
      <div className="account-access-stopped-icon" aria-hidden="true">
        {clearing ? <Loader2 size={24} className="spin" /> : <ShieldCheck size={24} />}
      </div>
      <div role="status" aria-live="polite">
        <h2 id="account-access-stopped-title">
          {verificationFailed
            ? "暂时无法核验账号状态"
            : clearing
              ? "正在清理本机资料"
              : "该账号的资料访问已停止"}
        </h2>
        <p>
          {verificationFailed
            ? "本机账号状态暂时无法读取，资料已暂停展示和编辑。请检查浏览器的网站存储权限后重试。"
            : "账号注销已开始，这台浏览器已停止读取、保存和同步该账号的学习资料。"}
        </p>
        <p>
          {verificationFailed
            ? "核验成功后会重新打开可访问的学习资料。"
            : clearing
              ? "正在结束本机任务并清理缓存，请稍候。"
              : "云端资料和原件清理完成后将移除账号。你可以查看账号状态或退出此浏览器。"}
        </p>
      </div>
      {state === "cleanup-failed" && (
        <p className="account-access-stopped-warning" role="alert">
          本机缓存未能完全清理。请重试；若仍失败，请在浏览器设置中清除本站数据。
        </p>
      )}
      <div className="account-access-stopped-actions">
        {verificationFailed && (
          <button className="btn primary" type="button" onClick={() => void retry()}>
            重新核验账号状态
          </button>
        )}
        {state === "cleanup-failed" && (
          <button className="btn primary" type="button" onClick={() => void retry()}>
            重试清理本机资料
          </button>
        )}
        <button className="btn" type="button" onClick={onOpenAccount}>
          查看账号状态
        </button>
      </div>
    </section>
  );
}
