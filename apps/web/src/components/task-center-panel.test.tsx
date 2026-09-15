// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportJob } from "@/lib/import-queue";
import type { OrganizationJob } from "@/lib/organization-types";
import type { Source, WorkspaceData } from "@/lib/types";
import TaskCenterPanel, { type TaskCenterPanelProps } from "./task-center-panel";

const now = "2026-09-14T09:30:00.000Z";

function source(): Source {
  return {
    id: "source-a",
    versionId: "version-a",
    title: "微积分导论",
    filename: "calculus.pdf",
    kind: "pdf",
    mime: "application/pdf",
    size: 10,
    hash: "hash-a",
    spaceIds: ["space-a"],
    tags: [],
    status: "parsing",
    text: "",
    chunks: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    aiAllowed: true,
    starred: false,
  };
}

function workspace(patch: Partial<WorkspaceData> = {}): WorkspaceData {
  return {
    schemaVersion: 1,
    spaces: [
      {
        id: "space-a",
        name: "高等数学",
        goal: "",
        color: "#4B3FE3",
        archived: false,
        createdAt: now,
      },
    ],
    sources: [source()],
    notes: [],
    annotations: [],
    conversations: [],
    aiEnabled: true,
    ...patch,
  };
}

function importJob(patch: Partial<ImportJob> = {}): ImportJob {
  return {
    id: "import-8-source-a-version-a",
    sourceId: "source-a",
    versionId: "version-a",
    filename: "calculus.pdf",
    spaceId: "space-a",
    stage: "parsing",
    status: "queued",
    originalSaved: true,
    attempt: 1,
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

function organizationJob(patch: Partial<OrganizationJob> = {}): OrganizationJob {
  return {
    id: "organization-a",
    durable: true,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    request: {
      requestId: "organization-a",
      kind: "source",
      trigger: "manual",
      spaceId: "space-a",
      sourceIds: ["source-a"],
      sourceVersions: [{ sourceId: "source-a", versionId: "version-a" }],
    },
    ...patch,
  };
}

function props(patch: Partial<TaskCenterPanelProps> = {}): TaskCenterPanelProps {
  return {
    data: workspace(),
    sync: {
      status: "cloud",
      cloudConfigured: true,
      signedIn: true,
    },
    organizationStatus: {
      ready: true,
      running: false,
      message: "自动整理已关闭，可手动分析资料或生成知识草稿。",
    },
    onRetryImport: vi.fn(),
    onCancelImport: vi.fn(),
    onRetryOrganization: vi.fn(),
    onCheckOrganization: vi.fn(),
    onStopOrganization: vi.fn(),
    onOpenSource: vi.fn(),
    onOpenOrganization: vi.fn(),
    ...patch,
  };
}

function buttonIn(container: Element, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.replace(/\s+/g, "") === text.replace(/\s+/g, ""),
  );
  expect(button, `button ${text}`).toBeInstanceOf(HTMLButtonElement);
  return button!;
}

describe("TaskCenterPanel", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function render(next: Partial<TaskCenterPanelProps> = {}) {
    await act(async () => {
      root.render(createElement(TaskCenterPanel, props(next)));
    });
  }

  it("keeps local import work distinct from a submitted durable task without a declared processor", async () => {
    const onCancelImport = vi.fn();
    const onCheckOrganization = vi.fn();
    const onStopOrganization = vi.fn();
    const onOpenSource = vi.fn();
    await render({
      data: workspace({
        importJobs: [importJob()],
        organizationJobs: [organizationJob()],
      }),
      durableProcessorState: "not-deployed",
      onCancelImport,
      onCheckOrganization,
      onStopOrganization,
      onOpenSource,
    });

    expect(host.textContent).toContain("此浏览器处理");
    expect(host.textContent).toContain("原件已保留");
    expect(host.textContent).toContain("后台整理等待部署");
    expect(host.textContent).toContain("等待后台部署");
    expect(host.textContent).toContain("不能承诺关闭页面后继续");
    expect(host.textContent).not.toContain("云端后台任务");

    const importCard = host.querySelector<HTMLElement>('[data-task-kind="import"]')!;
    await act(async () => buttonIn(importCard, "停止").click());
    expect(onCancelImport).toHaveBeenCalledExactlyOnceWith("import-8-source-a-version-a");

    const organizationCard = host.querySelector<HTMLElement>('[data-task-kind="organization"]')!;
    await act(async () => buttonIn(organizationCard, "刷新状态").click());
    expect(onCheckOrganization).toHaveBeenCalledExactlyOnceWith("organization-a");

    await act(async () => buttonIn(organizationCard, "停止").click());
    expect(onStopOrganization).toHaveBeenCalledExactlyOnceWith("organization-a");
    expect(
      [...organizationCard.querySelectorAll<HTMLButtonElement>("button")].some(
        (button) => button.textContent?.replace(/\s+/g, "") === "重新生成",
      ),
    ).toBe(false);

    await act(async () => buttonIn(importCard, "定位资料").click());
    expect(onOpenSource).toHaveBeenCalledExactlyOnceWith("source-a");
  });

  it("exposes safe existing retry and sync-resolution handlers for attention states", async () => {
    const onRetryImport = vi.fn();
    const onRetryOrganization = vi.fn();
    const onResolveSync = vi.fn();
    const onOpenOrganization = vi.fn();
    await render({
      data: workspace({
        importJobs: [importJob({ status: "failed", error: "正文提取失败" })],
        organizationJobs: [organizationJob({ status: "cancelled", error: "请求已停止" })],
      }),
      sync: {
        status: "conflict",
        cloudConfigured: true,
        signedIn: true,
        error: "资料库版本需要处理",
      },
      onRetryImport,
      onRetryOrganization,
      onResolveSync,
      onOpenOrganization,
      durableProcessorState: "declared",
    });

    expect(host.textContent).toContain("同步冲突等待处理");
    expect(host.textContent).toContain("正文提取失败");
    expect(host.textContent).toContain("请求已停止");

    await act(async () => buttonIn(host, "处理同步问题").click());
    expect(onResolveSync).toHaveBeenCalledExactlyOnceWith();

    const importCard = host.querySelector<HTMLElement>('[data-task-kind="import"]')!;
    await act(async () => buttonIn(importCard, "重新处理").click());
    expect(onRetryImport).toHaveBeenCalledExactlyOnceWith("import-8-source-a-version-a");

    const organizationCard = host.querySelector<HTMLElement>('[data-task-kind="organization"]')!;
    await act(async () => buttonIn(organizationCard, "重新生成").click());
    expect(onRetryOrganization).toHaveBeenCalledExactlyOnceWith("organization-a");

    await act(async () => buttonIn(organizationCard, "前往 AI 整理").click());
    expect(onOpenOrganization).toHaveBeenCalledExactlyOnceWith("space-a");
  });

  it("keeps interactive knowledge work tied to the current page and uses the existing continue handler", async () => {
    const onCheckOrganization = vi.fn();
    await render({
      data: workspace({
        organizationJobs: [
          organizationJob({
            id: "update-a",
            durable: undefined,
            status: "running",
            request: {
              requestId: "update-a",
              kind: "update",
              trigger: "manual",
              spaceId: "space-a",
              sourceIds: ["source-a"],
              sourceVersions: [{ sourceId: "source-a", versionId: "version-a" }],
              targetNote: { id: "knowledge-a", revision: 1, updatedAt: now },
            },
          }),
        ],
      }),
      onCheckOrganization,
    });

    expect(host.textContent).toContain("页面内任务");
    expect(host.textContent).toContain("关闭页面会停止当前请求");
    const organizationCard = host.querySelector<HTMLElement>('[data-task-kind="organization"]')!;
    await act(async () => buttonIn(organizationCard, "继续原请求").click());
    expect(onCheckOrganization).toHaveBeenCalledExactlyOnceWith("update-a");
  });

  it("shows the explicit development page runner instead of a background deployment wait", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_CONUO_LOCAL_ORGANIZATION_RUNNER_ENABLED", "true");
    await render({
      data: workspace({
        organizationJobs: [
          organizationJob({
            durable: undefined,
            status: "running",
            request: {
              requestId: "development-page-source",
              kind: "source",
              trigger: "manual",
              spaceId: "space-a",
              sourceIds: ["source-a"],
              sourceVersions: [{ sourceId: "source-a", versionId: "version-a" }],
            },
          }),
        ],
      }),
      durableProcessorState: "not-deployed",
    });

    expect(host.textContent).toContain("手动页面内整理可用");
    expect(host.textContent).toContain("自动分析不会入队");
    expect(host.textContent).toContain("离开页面会中止请求");
    expect(host.textContent).not.toContain("后台整理等待部署；当前不会创建新的资料分析");
    expect(host.querySelector(".task-center-status-spin")).not.toBeNull();
  });

  it("keeps a production build fail-closed even when the public local flag is true", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_CONUO_LOCAL_ORGANIZATION_RUNNER_ENABLED", "true");
    await render({ durableProcessorState: "not-deployed" });

    expect(host.textContent).toContain(
      "后台整理等待部署；当前不会创建新的资料分析、主题草稿或自动任务",
    );
    expect(host.textContent).not.toContain("手动页面内整理可用");
  });

  it("keeps recovery actions explicit and reports a failed task action inline", async () => {
    const onRetrySync = vi.fn().mockRejectedValue(new Error("网络暂时不可用"));
    const onUseRecovery = vi.fn();
    await render({
      sync: {
        status: "error",
        cloudConfigured: true,
        signedIn: true,
        error: "云端保存尚未确认",
        hasRecovery: true,
      },
      onRetrySync,
      onUseRecovery,
    });

    await act(async () => buttonIn(host, "重新连接").click());
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("网络暂时不可用"),
    );
    expect(onRetrySync).toHaveBeenCalledOnce();

    await act(async () => buttonIn(host, "备份当前副本并加载云端").click());
    expect(onUseRecovery).toHaveBeenCalledOnce();
  });
});
