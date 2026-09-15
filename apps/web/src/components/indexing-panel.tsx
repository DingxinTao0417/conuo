"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { indexingRequest } from "@/lib/cloud";
import type { WorkspaceData } from "@/lib/types";

const schema = z.object({
  configured: z.boolean(),
  jobs: z
    .array(
      z.object({
        jobId: z.uuid(),
        sourceId: z.string(),
        versionId: z.string(),
        state: z.enum(["queued", "running", "retry", "failed", "cancelled", "succeeded"]),
        cursor: z.number().int().min(0),
        totalChunks: z.number().int().min(0),
        attempt: z.number().int().min(0),
        errorCode: z.string().nullable().optional(),
      }),
    )
    .max(5000),
});
const labels = {
  queued: "等待处理器领取",
  running: "正在索引",
  retry: "等待重试",
  failed: "索引失败",
  cancelled: "已取消",
  succeeded: "索引完成",
};
export default function IndexingPanel({
  data,
  userId,
  onToggle,
}: {
  data: WorkspaceData;
  userId?: string;
  onToggle: (enabled: boolean) => void;
}) {
  const [status, setStatus] = useState<z.infer<typeof schema>>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(false);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!userId) return;
      try {
        const result = schema.safeParse(await indexingRequest(userId, undefined, signal));
        if (!result.success) throw new Error("索引任务状态格式异常，请稍后刷新。");
        if (alive.current && !signal?.aborted) {
          setStatus(result.data);
          setError("");
        }
      } catch (caught) {
        if (alive.current && !signal?.aborted)
          setError(caught instanceof Error ? caught.message : "无法读取索引状态。");
      }
    },
    [userId],
  );
  useEffect(() => {
    alive.current = true;
    const abort = new AbortController();
    if (userId)
      indexingRequest(userId, undefined, abort.signal)
        .then((value) => {
          const parsed = schema.safeParse(value);
          if (!parsed.success) throw new Error("索引任务状态格式异常，请稍后刷新。");
          if (!abort.signal.aborted) setStatus(parsed.data);
        })
        .catch((caught: unknown) => {
          if (!abort.signal.aborted)
            setError(caught instanceof Error ? caught.message : "无法读取索引状态。");
        });
    return () => {
      alive.current = false;
      abort.abort();
    };
  }, [userId]);
  async function control(jobId: string, action: "cancel" | "retry") {
    if (!userId) return;
    setBusy(true);
    try {
      await indexingRequest(userId, { jobId, action });
      if (alive.current) await refresh();
    } catch (caught) {
      if (alive.current) setError(caught instanceof Error ? caught.message : "操作失败，请刷新。");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const jobs =
    status?.jobs.filter((job) =>
      data.sources.some(
        (source) =>
          !source.deletedAt && source.id === job.sourceId && source.versionId === job.versionId,
      ),
    ) || [];
  return (
    <>
      <div className="setting-row">
        <div>
          <b>语义索引与搜索</b>
          <p>
            开启后，将整个工作区中允许 AI
            使用的已有及新资料正文交给配置的嵌入模型建立索引；以后可按意思查找资料。关闭后停止新处理和语义检索，普通关键词搜索仍可使用。
          </p>
          <p>
            {!userId
              ? "登录云端账号后可开启。"
              : !status?.configured
                ? "尚未配置语义检索模型。"
                : "模型已配置；后台处理器需要单独运行，状态以任务结果为准。"}
          </p>
        </div>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          aria-label="语义索引与搜索"
          checked={data.semanticSearch === true}
          disabled={!data.semanticSearch && (!userId || !data.aiEnabled || !status?.configured)}
          onChange={(event) => onToggle(event.target.checked)}
        />
      </div>
      {userId && (
        <details className="indexing-tasks">
          <summary>语义索引任务（{jobs.length}）</summary>
          <button className="btn" disabled={busy} onClick={() => void refresh()}>
            刷新任务
          </button>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {jobs.length ? (
            jobs.map((job) => (
              <div className="setting-row" key={job.jobId}>
                <div>
                  <b>{data.sources.find((source) => source.id === job.sourceId)?.title}</b>
                  <p>
                    {labels[job.state]} · {job.cursor}/{job.totalChunks} 个片段
                    {job.errorCode ? ` · ${job.errorCode}` : ""}
                  </p>
                </div>
                {["queued", "running", "retry"].includes(job.state) ? (
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => void control(job.jobId, "cancel")}
                  >
                    取消
                  </button>
                ) : ["failed", "cancelled"].includes(job.state) ? (
                  <button
                    className="btn"
                    disabled={busy || !data.semanticSearch || !data.aiEnabled}
                    onClick={() => void control(job.jobId, "retry")}
                  >
                    重新索引
                  </button>
                ) : null}
              </div>
            ))
          ) : (
            <p className="muted">暂无当前版本的索引任务。开启并保存到云端后会创建任务。</p>
          )}
        </details>
      )}
    </>
  );
}
