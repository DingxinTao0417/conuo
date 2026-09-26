"use client";
import type { WorkspaceData } from "@/lib/types";
import { cleanupOrganizationHistory } from "@/lib/organization-history";
import AiUsagePanel from "../../../ai-usage-panel";
import IndexingPanel from "../../../indexing-panel";
import MembershipPanel from "../../../membership-panel";
import ModelStatus from "../../../model-status";
import { OrganizationHistoryControl } from "../../lazy-panels";
import type { WorkspaceStore, WorkspaceUser } from "../../types";
import { useMembershipFeature } from "@/lib/use-membership-features";

export type AiPaneProps = {
  data: WorkspaceData;
  store: WorkspaceStore;
  user: WorkspaceUser;
  update: WorkspaceStore["update"];
  durableProcessorEnabled: boolean;
  setToast: (message: string) => void;
};

export default function AiPane({
  data,
  store,
  user,
  update,
  durableProcessorEnabled,
  setToast,
}: AiPaneProps) {
  const organizationFeature = useMembershipFeature(user?.id, "organization");
  const organizationReason = organizationFeature.reason || "当前会员等级未开放资料整理。";
  return (
    <>
      <div className="settings-card">
        <h2>资料与 AI</h2>
        <p>你提交的反馈只包含评分和原因；只有勾选后才会附上问题和回答。</p>
        <p>
          如已启用重排服务，服务端会把检索到的原文片段发送给重排服务重新排序；请先确认服务方的数据处理边界。
        </p>
        <div className="setting-row">
          <div>
            <b>允许 AI 使用我的资料</b>
            <p>用于所选范围内的问答和摘要。关闭后停止资料问答，也可在资料详情中逐份设置。</p>
          </div>
          <input
            aria-label="允许 AI 使用我的资料"
            type="checkbox"
            className="switch"
            role="switch"
            checked={data.aiEnabled}
            onChange={(e) => update((d) => ({ ...d, aiEnabled: e.target.checked }))}
          />
        </div>
        <MembershipPanel
          userId={user?.id}
          contextKey={`${store.token}:${store.localCacheMode}`}
          enabled={store.ready}
        />
        <ModelStatus key={user?.id || "local"} userId={user?.id} />
        <AiUsagePanel
          userId={user?.id}
          contextKey={`${store.token}:${store.localCacheMode}`}
          enabled={store.ready}
        />
        <IndexingPanel
          key={`${store.token}`}
          data={data}
          userId={user?.id}
          onToggle={(semanticSearch) => update((workspace) => ({ ...workspace, semanticSearch }))}
        />
      </div>
      <div className="settings-card">
        <h2>自动整理</h2>
        <div className="setting-row">
          <div>
            <b>自动整理资料</b>
            <p>
              {durableProcessorEnabled
                ? "开启后，在页面打开期间分析整个工作区已有及新导入的可用资料，生成摘要、标签和主题建议。与问答共用模型次数；不会自动应用标签或改写知识页。"
                : "后台自动整理等待部署。当前构建不会创建新任务；已有整理记录仍可刷新、查看或停止。"}
            </p>
            {!organizationFeature.allowed && <p>{organizationReason}</p>}
          </div>
          <input
            aria-label="自动整理资料"
            type="checkbox"
            className="switch"
            role="switch"
            checked={data.autoOrganize === true}
            disabled={
              !organizationFeature.allowed ||
              (!data.autoOrganize &&
                (!durableProcessorEnabled ||
                  !user ||
                  !data.aiEnabled ||
                  !store.organizationStatus.ready))
            }
            onChange={(e) =>
              update((workspace) => ({ ...workspace, autoOrganize: e.target.checked }))
            }
          />
        </div>
        <details className="settings-advanced">
          <summary>高级：整理记录</summary>
          <OrganizationHistoryControl
            jobs={data.organizationJobs}
            onCleanup={() => {
              let removed = 0;
              try {
                const applied = update((workspace) => {
                  const result = cleanupOrganizationHistory(workspace);
                  removed = result.impact.removable;
                  return result.data;
                });
                if (!applied || !removed) {
                  setToast("没有可清理的终态整理记录，工作区未修改。");
                  return false;
                }
                setToast(`已清理 ${removed} 条整理记录，已保存的学习内容保持不变。`);
                return true;
              } catch (error) {
                setToast(error instanceof Error ? error.message : "整理记录未能清理，请稍后重试。");
                return false;
              }
            }}
          />
        </details>
      </div>
    </>
  );
}
