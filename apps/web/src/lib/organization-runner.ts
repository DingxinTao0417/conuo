import type { OrganizationRequest } from "./organization-types";
import type { Source, WorkspaceData } from "./types";

export interface OrganizationStatus {
  ready: boolean;
  message: string;
  running: boolean;
}
export interface OrganizationInput {
  kind: "source" | "knowledge" | "update" | "relations";
  spaceId: string;
  sourceIds: string[];
  topic?: string;
  targetNoteId?: string;
  compareNoteId?: string;
}
interface RunnerSnapshot {
  token: number;
  ready: boolean;
  user: { id: string } | null;
  data: WorkspaceData;
}
export interface OrganizationHost {
  getSnapshot(): RunnerSnapshot;
  subscribe(listener: () => void): () => void;
  setOrganizationStatus(status: OrganizationStatus, token: number): void;
  organizationModelStatus(
    signal: AbortSignal,
    token: number,
  ): Promise<{ mode: string; message: string }>;
  canOrganize(request: OrganizationRequest, token: number): boolean;
  organizationBusy(token: number): boolean;
  aiBusy(token: number): boolean;
  runAutomaticOrganization(
    request: OrganizationRequest,
    signal: AbortSignal,
    token: number,
  ): Promise<void>;
}

export function automaticSourceSpace(data: WorkspaceData, source: Source): string | null {
  if (!source.spaceIds.length) return "inbox";
  return (
    [...source.spaceIds]
      .sort()
      .find((id) => data.spaces.some((space) => space.id === id && !space.archived)) ?? null
  );
}
export function automaticCandidates(data: WorkspaceData): Source[] {
  if (!data.autoOrganize || !data.aiEnabled || (data.organizationJobs?.length ?? 0) >= 1000)
    return [];
  return data.sources.filter(
    (source) =>
      !source.deletedAt &&
      source.aiAllowed &&
      source.text.trim() &&
      ["ready", "partial"].includes(source.status) &&
      source.chunks.some(
        (chunk) =>
          chunk.sourceId === source.id && chunk.versionId === source.versionId && chunk.text.trim(),
      ) &&
      automaticSourceSpace(data, source) !== null &&
      !data.organizationJobs?.some(
        (job) =>
          (job.request.trigger === "automatic" ||
            (job.request.kind === "source" &&
              ["ready", "dismissed"].includes(job.status) &&
              job.result?.kind === "source")) &&
          job.request.sourceVersions.some(
            (version) => version.sourceId === source.id && version.versionId === source.versionId,
          ),
      ),
  );
}
export async function automaticOrganizationRequest(
  data: WorkspaceData,
  source: Source,
): Promise<OrganizationRequest> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([source.id, source.versionId])),
  );
  const id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  const spaceId = automaticSourceSpace(data, source);
  if (!spaceId) throw new Error("资料没有可用的学习空间。");
  return {
    requestId: "auto-" + id,
    kind: "source",
    trigger: "automatic",
    spaceId,
    sourceIds: [source.id],
    sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
  };
}

/**
 * Browser-lifetime dispatcher for automatic source tasks. It only submits a
 * durable request after the current build declares its background processor.
 * A declaration is not a health check; the server-owned queue owns any work
 * that is successfully submitted.
 */
export class OrganizationRunner {
  private active = false;
  private scheduled = false;
  private unsubscribe?: () => void;
  private token = -1;
  private model: { mode: string; message: string } | null = null;
  private checking = false;
  private dispatching = false;
  private paused = "";
  private wasEnabled = false;
  private generation = 0;
  private controller = new AbortController();
  constructor(
    private host: OrganizationHost,
    private automaticDurableSubmissionEnabled = true,
  ) {}

  start() {
    if (this.active) return;
    this.active = true;
    this.unsubscribe = this.host.subscribe(this.schedule);
    this.refresh();
  }
  stop() {
    this.active = false;
    this.generation++;
    this.controller.abort();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
  refresh() {
    this.controller.abort();
    this.controller = new AbortController();
    this.generation++;
    this.model = null;
    this.checking = false;
    this.dispatching = false;
    this.paused = "";
    this.schedule();
  }
  private schedule = () => {
    if (!this.active || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.active) void this.tick();
    });
  };
  private status(ready: boolean, message: string, running = false) {
    this.host.setOrganizationStatus({ ready, message, running }, this.token);
  }
  private async tick() {
    const snapshot = this.host.getSnapshot();
    if (snapshot.token !== this.token) {
      this.token = snapshot.token;
      this.refresh();
      this.wasEnabled = !!snapshot.data.autoOrganize;
    }
    if (!snapshot.ready || !snapshot.user) {
      this.status(false, snapshot.ready ? "登录并配置生成模型后可整理资料。" : "正在读取资料…");
      return;
    }
    if (!snapshot.data.autoOrganize) {
      if (this.wasEnabled) {
        this.controller.abort();
        this.controller = new AbortController();
        this.generation++;
        this.checking = false;
        this.dispatching = false;
      }
      this.wasEnabled = false;
    } else if (!this.wasEnabled) {
      this.wasEnabled = true;
      this.paused = "";
      this.model = null;
    }
    if (!this.model) {
      if (this.checking) return;
      this.checking = true;
      const generation = this.generation;
      this.status(false, "正在检查整理模型配置…");
      try {
        const model = await this.host.organizationModelStatus(this.controller.signal, this.token);
        if (!this.active || generation !== this.generation) return;
        this.model = model;
      } catch (cause) {
        if (!this.active || generation !== this.generation) return;
        this.model = {
          mode: "unavailable",
          message: cause instanceof Error ? cause.message : "无法检查模型配置。",
        };
      } finally {
        if (generation === this.generation) {
          this.checking = false;
          this.schedule();
        }
      }
      return;
    }
    if (this.model.mode !== "model") {
      this.status(false, this.model.message);
      return;
    }
    if (!snapshot.data.aiEnabled) {
      this.status(false, "AI 已关闭，整理暂停。资料仍可阅读和管理。");
      return;
    }
    if (!this.automaticDurableSubmissionEnabled) {
      this.status(
        true,
        "后台自动整理等待部署。当前构建不会创建新的资料分析或主题草稿任务；已有任务记录仍可刷新、查看或停止。",
      );
      return;
    }
    if (this.host.organizationBusy(this.token)) {
      this.status(true, "正在提交整理请求…", true);
      return;
    }
    if (!snapshot.data.autoOrganize) {
      this.status(true, "自动整理已关闭，可手动分析资料或生成知识草稿。");
      return;
    }
    if (this.paused) {
      this.status(true, this.paused);
      return;
    }
    if ((snapshot.data.organizationJobs?.length ?? 0) >= 1000) {
      this.status(true, "整理记录已达当前上限，暂不能新增任务。已保存建议仍可查看和导出。");
      return;
    }
    const candidates = automaticCandidates(snapshot.data);
    if (!candidates.length) {
      this.status(true, "没有待自动分析的新资料版本；失败或中断的任务需手动继续或重新生成。");
      return;
    }
    if (this.dispatching || this.host.aiBusy(this.token)) {
      this.status(true, `还有 ${candidates.length} 份资料待分析，正在等待当前 AI 请求结束。`);
      return;
    }
    this.dispatching = true;
    const generation = this.generation;
    const token = this.token;
    try {
      const request = await automaticOrganizationRequest(snapshot.data, candidates[0]);
      if (!this.active || generation !== this.generation) return;
      if (this.host.aiBusy(token)) {
        this.status(true, `还有 ${candidates.length} 份资料待分析，正在等待当前 AI 请求结束。`);
        return;
      }
      if (!this.host.canOrganize(request, token)) {
        this.status(true, `还有 ${candidates.length} 份资料待分析，等待资料和 AI 设置同步。`);
        return;
      }
      await this.host.runAutomaticOrganization(request, this.controller.signal, token);
    } catch (cause) {
      if (!this.active || generation !== this.generation) return;
      this.paused =
        "自动整理已暂停：" +
        (cause instanceof Error ? cause.message : "处理未完成。") +
        " 请检查任务后手动继续或重新生成。";
    } finally {
      if (generation === this.generation) {
        this.dispatching = false;
        // A pending sync will itself publish when acknowledged. Repeatedly
        // scheduling unchanged, unsynced evidence would create a busy loop.
        if (this.host.getSnapshot().data !== snapshot.data || this.paused) this.schedule();
      }
    }
  }
}
