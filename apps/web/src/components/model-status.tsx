"use client";

import { useEffect, useState } from "react";
import { getModelStatus } from "@/lib/cloud";

/** Remount with the account key so a previous account's status is never displayed. */
export default function ModelStatus({
  userId,
  compact = false,
}: {
  userId?: string;
  compact?: boolean;
}) {
  const [state, setState] = useState({
    title: userId ? "正在读取模型配置…" : "本机模式 · 原文检索",
    message: userId ? "" : "登录并配置模型服务后，可基于所选资料生成回答。",
    failed: false,
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    getModelStatus(userId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted)
          setState({
            title: result.mode === "model" ? "生成模型已配置" : "原文检索模式",
            message: result.message,
            failed: false,
          });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            title: "模型配置需要处理",
            message: error instanceof Error ? error.message : "无法读取模型状态。",
            failed: true,
          });
      });
    return () => controller.abort();
  }, [userId, attempt]);
  return (
    <div className={compact ? "model-status-compact" : "setting-row"}>
      <div>
        <b>{state.title}</b>
        {(!compact || state.failed) && <p>{state.message}</p>}
      </div>
      {state.failed && (
        <button
          type="button"
          className="text-button"
          onClick={() => setAttempt((value) => value + 1)}
        >
          重新检查
        </button>
      )}
    </div>
  );
}
