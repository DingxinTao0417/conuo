"use client";
import { ArrowDownToLine, Plus, Upload } from "lucide-react";
import type { ExportProgress } from "@/lib/export";
import type { WorkspaceData } from "@/lib/types";
import { cleanupOrganizationHistory } from "@/lib/organization-history";
import { renameLearningSpace } from "@/lib/space-lifecycle";
import AiUsagePanel from "../../ai-usage-panel";
import IndexingPanel from "../../indexing-panel";
import InstallAppPanel from "../../install-app-panel";
import LearningSpaceNameInput from "../../learning-space-name-input";
import ModelStatus from "../../model-status";
import StorageUsagePanel from "../../storage-usage-panel";
import { OrganizationHistoryControl } from "../lazy-panels";
import type { WorkspaceStorageMode, WorkspaceStore, WorkspaceUser } from "../types";

export type SettingsSectionProps = {
  data: WorkspaceData;
  store: WorkspaceStore;
  user: WorkspaceUser;
  update: WorkspaceStore["update"];
  ready: boolean;
  status: WorkspaceStore["status"];
  storageMode: WorkspaceStorageMode;
  cloudConfigured: boolean;
  durableProcessorEnabled: boolean;
  settingsSyncPresentation: { label: string; description: string };
  busy: boolean;
  exporting: boolean;
  exportProgress: ExportProgress | null;
  navigate: (section: "tasks" | "trash") => void;
  setModal: (modal: "account" | "restore" | "legacy-recovery" | "delete-space") => void;
  setToast: (message: string) => void;
  setSpaceToDeleteId: (spaceId: string) => void;
  openExport: () => void;
  openOrganization: () => void;
  openSpaceCreation: () => void;
};

export default function SettingsSection({
  data,
  store,
  user,
  update,
  ready,
  status,
  storageMode,
  cloudConfigured,
  durableProcessorEnabled,
  settingsSyncPresentation,
  busy,
  exporting,
  exportProgress,
  navigate,
  setModal,
  setToast,
  setSpaceToDeleteId,
  openExport,
  openOrganization,
  openSpaceCreation,
}: SettingsSectionProps) {
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">按你的方式学习</p>
          <h1>设置</h1>
          <p>控制资料的保存位置与检索权限。</p>
        </div>
      </div>
      <div className="settings-card">
        <h2>安装与设备</h2>
        <InstallAppPanel />
      </div>
      <div className="settings-card">
        <h2>账号与保存</h2>
        <div className="setting-row">
          <div>
            <b>{user && cloudConfigured ? user.email : "本机工作区"}</b>
            <p>
              {user && cloudConfigured
                ? "已连接账号；当前工作区是否已保存，以服务确认状态为准。"
                : cloudConfigured
                  ? "资料保存在此浏览器；登录后可同步到你的私有空间。"
                  : "云端同步暂不可用。资料仅保存在此浏览器；清除网站数据会删除本机副本，请及时导出。"}
            </p>
          </div>
          <button className="btn" onClick={() => setModal("account")}>
            {user && cloudConfigured ? "管理账号" : cloudConfigured ? "登录账号" : "查看本机工作区"}
          </button>
        </div>
        <div className="setting-row">
          <div role="status" aria-live="polite" aria-label="当前工作区保存状态">
            <b>当前工作区保存状态：{settingsSyncPresentation.label}</b>
            <p>{settingsSyncPresentation.description}</p>
          </div>
          <button className="btn" onClick={() => navigate("tasks")}>
            查看同步与任务
          </button>
        </div>
        <div className="setting-row">
          <div>
            <b>导出学习资料</b>
            <p>导出原文件、笔记和引用关系，保留一份自己的备份。</p>
            {exporting && (
              <p className="export-progress" role="status" aria-live="polite">
                {exportProgress?.phase === "originals"
                  ? "正在处理原件 " +
                    exportProgress.completed +
                    "/" +
                    exportProgress.total +
                    "：" +
                    exportProgress.title
                  : exportProgress?.phase === "archive"
                    ? "正在生成压缩包…"
                    : "正在准备导出…"}
              </p>
            )}
          </div>
          <button className="btn" disabled={busy} onClick={() => openExport()}>
            <ArrowDownToLine size={15} />
            {busy ? "正在导出…" : "导出备份"}
          </button>
        </div>
        <div className="setting-row">
          <div>
            <b>从备份恢复</b>
            <p>读取 Conuo 备份 ZIP，预览后恢复资料、笔记与历史记录。</p>
          </div>
          <button className="btn" disabled={busy} onClick={() => setModal("restore")}>
            <Upload size={15} />
            恢复备份
          </button>
        </div>
      </div>
      {storageMode === "cloud" && (
        <div className="settings-card">
          <h2>旧版浏览器资料</h2>
          <div className="setting-row">
            <div>
              <b>将旧版资料导入云端</b>
              <p>把旧版留在此浏览器中的资料导入当前账号，保留已有内容。</p>
            </div>
            <button
              className="btn"
              disabled={busy || !ready || status !== "cloud"}
              onClick={() => setModal("legacy-recovery")}
            >
              导入旧版资料
            </button>
          </div>
        </div>
      )}
      <div className="settings-card">
        <h2>资料与存储</h2>
        <StorageUsagePanel sources={data.sources} onOpenRecycleBin={() => navigate("trash")} />
      </div>
      <div className="settings-card">
        <h2>资料与 AI</h2>
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
        <div className="setting-row">
          <div>
            <b>自动整理资料</b>
            <p>
              {durableProcessorEnabled
                ? "开启后，在页面打开期间分析整个工作区已有及新导入的可用资料，生成摘要、标签和主题建议。与问答共用模型次数；不会自动应用标签或改写知识页。"
                : "后台自动整理等待部署。当前构建不会创建新任务；已有整理记录仍可刷新、查看或停止。"}
            </p>
            <button className="text-button" onClick={() => openOrganization()}>
              查看整理任务与建议
            </button>
          </div>
          <input
            aria-label="自动整理资料"
            type="checkbox"
            className="switch"
            role="switch"
            checked={data.autoOrganize === true}
            disabled={
              !data.autoOrganize &&
              (!durableProcessorEnabled ||
                !user ||
                !data.aiEnabled ||
                !store.organizationStatus.ready)
            }
            onChange={(e) =>
              update((workspace) => ({ ...workspace, autoOrganize: e.target.checked }))
            }
          />
        </div>
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
      </div>
      <div className="settings-card">
        <h2>学习空间</h2>
        {data.spaces.map((s) => (
          <div className="setting-row" key={s.id}>
            <div>
              <LearningSpaceNameInput
                key={`${user?.id || "local"}:${s.id}`}
                space={s}
                onRename={(name, expectedName) => {
                  let renamed = false;
                  try {
                    update((d) => {
                      if (d.spaces.find((item) => item.id === s.id)?.name !== expectedName)
                        return d;
                      const next = renameLearningSpace(d, s.id, name);
                      renamed = true;
                      return next;
                    });
                    if (!renamed) setToast("空间名称又有变化，输入仍保留，请重新确认。");
                  } catch (cause) {
                    renamed = false;
                    setToast(
                      cause instanceof Error ? cause.message : "空间名称未保存，输入仍保留。",
                    );
                  }
                  return renamed;
                }}
                onInvalid={() => setToast("学习空间名称不能为空，已保留原名称。")}
              />
              <input
                aria-label={`学习目标 ${s.name}`}
                className="field space-goal-input"
                placeholder="添加学习目标（可选）"
                value={s.goal}
                onChange={(e) =>
                  update((d) => ({
                    ...d,
                    spaces: d.spaces.map((x) =>
                      x.id === s.id ? { ...x, goal: e.target.value } : x,
                    ),
                  }))
                }
              />
            </div>
            <div className="setting-actions">
              <button
                className="btn"
                onClick={() =>
                  update((d) => ({
                    ...d,
                    spaces: d.spaces.map((x) =>
                      x.id === s.id ? { ...x, archived: !x.archived } : x,
                    ),
                  }))
                }
              >
                {s.archived ? "恢复空间" : "归档空间"}
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  setSpaceToDeleteId(s.id);
                  setModal("delete-space");
                }}
              >
                删除空间
              </button>
            </div>
          </div>
        ))}
        <button className="btn" onClick={() => openSpaceCreation()}>
          <Plus size={14} />
          新建学习空间
        </button>
      </div>
    </>
  );
}
