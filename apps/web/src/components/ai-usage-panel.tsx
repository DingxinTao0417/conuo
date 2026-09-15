"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { getAiRequestUsage } from "@/lib/cloud";
import { AI_USAGE_CHANGED_EVENT, type AiRequestUsage } from "@/lib/ai-request-usage";
import "./ai-usage-panel.css";

type UsageState =
  | { kind: "checking" }
  | { kind: "error"; message: string }
  | { kind: "ready"; usage: AiRequestUsage };

function localDateTime(timestamp: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function AccountUsage({ userId }: { userId: string }) {
  const [state, setState] = useState<UsageState>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    let sequence = 0;
    let controller: AbortController | undefined;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (initial = false) => {
      if (!active) return;
      const current = ++sequence;
      controller?.abort();
      clearTimeout(resetTimer);
      const request = new AbortController();
      controller = request;
      if (!initial) setState({ kind: "checking" });
      const startedAt = performance.now();
      try {
        const usage = await getAiRequestUsage(userId, request.signal);
        if (!active || current !== sequence || request.signal.aborted) return;
        // Use the server's sampled time plus a conservative monotonic request
        // duration. A wrong local wall clock cannot extend yesterday's balance.
        const untilReset =
          Date.parse(usage.resetsAt) -
          Date.parse(usage.checkedAt) -
          Math.max(0, performance.now() - startedAt);
        if (untilReset <= 0) {
          setState({ kind: "error", message: "返回的用量已过统计日期，请重新刷新。" });
          return;
        }
        setState({ kind: "ready", usage });
        resetTimer = setTimeout(() => {
          if (!active || current !== sequence) return;
          setState({ kind: "checking" });
          if (document.visibilityState !== "hidden") void refresh();
        }, untilReset + 50);
      } catch (error) {
        if (!active || current !== sequence || request.signal.aborted) return;
        setState({
          kind: "error",
          message:
            error instanceof Error && error.name === "CloudError"
              ? error.message
              : "暂时无法读取 AI 用量，请检查网络后刷新。",
        });
      }
    };
    const onRefresh = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    void refresh(true);
    window.addEventListener("focus", onRefresh);
    window.addEventListener(AI_USAGE_CHANGED_EVENT, onRefresh);
    document.addEventListener("visibilitychange", onRefresh);
    return () => {
      active = false;
      ++sequence;
      controller?.abort();
      clearTimeout(resetTimer);
      window.removeEventListener("focus", onRefresh);
      window.removeEventListener(AI_USAGE_CHANGED_EVENT, onRefresh);
      document.removeEventListener("visibilitychange", onRefresh);
    };
  }, [userId, attempt]);

  const usage = state.kind === "ready" ? state.usage : undefined;
  return (
    <section className="ai-usage-panel" aria-label="AI 每日请求用量">
      <header className="ai-usage-heading">
        <div>
          <h3>AI 请求用量</h3>
          <p>问答、区域截图学习和资料整理共用每日次数。</p>
        </div>
        <button
          type="button"
          className="btn ai-usage-refresh"
          disabled={state.kind === "checking"}
          onClick={() => {
            setState({ kind: "checking" });
            setAttempt((value) => value + 1);
          }}
        >
          <RefreshCw size={14} aria-hidden="true" />
          {state.kind === "checking" ? "正在读取" : "刷新用量"}
        </button>
      </header>
      <div aria-live="polite" className="ai-usage-content">
        {state.kind === "checking" ? (
          <p role="status">正在读取当前账号的用量…</p>
        ) : state.kind === "error" ? (
          <div className="ai-usage-unknown" role="status">
            <strong>用量暂不可用</strong>
            <p>{state.message}</p>
            <p>剩余次数尚未确认，不代表次数已用完。</p>
          </div>
        ) : usage ? (
          <>
            <dl className="ai-usage-metrics">
              <div>
                <dt>今日已用</dt>
                <dd>
                  {usage.usedCount}
                  <small> 次</small>
                </dd>
              </div>
              <div>
                <dt>剩余次数</dt>
                <dd>
                  {usage.remainingCount}
                  <small> 次</small>
                </dd>
              </div>
              <div>
                <dt>每日上限</dt>
                <dd>
                  {usage.dailyLimit}
                  <small> 次</small>
                </dd>
              </div>
            </dl>
            {usage.remainingCount === 0 && (
              <p className="ai-usage-exhausted" role="status">
                今日次数已用完，重置后可继续生成；阅读、普通搜索和导出仍可使用。
              </p>
            )}
            <div className="ai-usage-timing">
              <p>每天 UTC 00:00 重置</p>
              <p>
                下次重置：<time dateTime={usage.resetsAt}>{localDateTime(usage.resetsAt)}</time>
                （本机时间）
              </p>
              <p>
                统计于：<time dateTime={usage.checkedAt}>{localDateTime(usage.checkedAt)}</time>
                （本机时间）
              </p>
            </div>
          </>
        ) : null}
      </div>
      <p className="ai-usage-policy">
        按已预占的新请求计次，失败、取消和超时也计入；读取同一请求的缓存结果不新增次数。 这里显示
        Conuo 的请求限制，供应商费用另行计算。
      </p>
    </section>
  );
}

/** Account/context keys replace the subtree during render, before effect cleanup. */
export default function AiUsagePanel({
  userId,
  contextKey,
  enabled = true,
}: {
  userId?: string;
  contextKey: string;
  enabled?: boolean;
}) {
  if (!userId || !enabled)
    return (
      <section className="ai-usage-panel" aria-label="AI 每日请求用量">
        <h3>AI 请求用量</h3>
        <p>
          {userId
            ? "正在确认当前工作区，请稍后查看用量。"
            : "登录后可查看当前账号的每日请求次数与重置时间。"}
        </p>
      </section>
    );
  return <AccountUsage key={JSON.stringify([userId, contextKey])} userId={userId} />;
}
