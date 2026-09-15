import type { SaveState } from "./types";

export interface WorkspaceSyncPresentationInput {
  storageMode?: "hybrid" | "cloud";
  status: SaveState;
  error?: string;
  cloudConfigured: boolean;
  signedIn: boolean;
  cloudReadOnly?: boolean;
  migrationPending?: boolean;
  purging?: boolean;
}

export interface WorkspaceSyncPresentation {
  label: string;
  description: string;
  tone: "neutral" | "progress" | "warning" | "danger" | "success";
}

/**
 * Describes the durability of the whole workspace snapshot. It deliberately
 * does not infer per-object sync states from the aggregate save result.
 */
export function workspaceSyncPresentation(
  sync: WorkspaceSyncPresentationInput,
): WorkspaceSyncPresentation {
  if (sync.purging)
    return {
      label: "正在安全清理资料",
      description: "删除操作正在完成，任务修改会在安全检查结束后恢复。",
      tone: "progress",
    };
  if (sync.cloudReadOnly)
    return {
      label: "云端资料只读恢复中",
      description: "当前仅显示已确认的云端资料；导入、整理和编辑会等待本机副本重新连接。",
      tone: "warning",
    };
  if (sync.migrationPending)
    return {
      label: "本机资料等待迁移决定",
      description: "为避免覆盖既有资料，新的云端写入会先等待迁移或保留本机副本的选择。",
      tone: "warning",
    };
  if (sync.status === "conflict")
    return {
      label: "同步冲突等待处理",
      description: "资料或版本同时被修改。处理前，解析和 AI 整理不会覆盖未检查的内容。",
      tone: "danger",
    };
  if (sync.status === "error")
    return {
      label: "保存需要处理",
      description:
        sync.error ||
        (sync.storageMode === "cloud"
          ? "尚未保存的修改仅暂存在当前页面，请重新连接并完成云端保存。"
          : "本机副本已保留，请重新连接后核对云端保存状态。"),
      tone: "danger",
    };
  if (sync.status === "loading" || sync.status === "saving")
    return {
      label: sync.status === "loading" ? "正在读取工作区" : "正在同步工作区",
      description: "任务会保留当前状态，等待本次读取或保存完成。",
      tone: "progress",
    };
  if (sync.status === "cloud")
    return {
      label: "工作区已保存到云端",
      description: "当前任务记录与资料库状态已确认保存。",
      tone: "success",
    };
  if (sync.storageMode === "cloud")
    return {
      label: "等待云端保存确认",
      description: "当前页面的修改尚未确认保存到云端，请等待保存完成。",
      tone: "warning",
    };
  if (!sync.cloudConfigured)
    return {
      label: "仅在此浏览器保存",
      description: "云端服务尚未配置，导入和整理记录只保留在当前浏览器。",
      tone: "neutral",
    };
  if (!sync.signedIn)
    return {
      label: "本机工作区未登录",
      description: "导入任务可在此浏览器恢复；登录后才能确认到私有云端空间。",
      tone: "neutral",
    };
  return {
    label: "本机副本已保存",
    description: "正在等待云端保存确认。",
    tone: "neutral",
  };
}
