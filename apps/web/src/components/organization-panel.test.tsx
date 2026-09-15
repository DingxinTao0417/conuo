// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import type { OrganizationJob } from "@/lib/organization-types";
import type { WorkspaceData } from "@/lib/types";
import OrganizationPanel, { type OrganizationPanelProps } from "./organization-panel";

function panelProps(
  data: WorkspaceData,
  patch: Partial<OrganizationPanelProps> = {},
): OrganizationPanelProps {
  return {
    data,
    spaceId: data.spaces[0]!.id,
    status: { ready: true, message: "", running: false },
    onSpaceChange: vi.fn(),
    onGenerate: vi.fn(async () => {}),
    onStop: vi.fn(async () => {}),
    onRetry: vi.fn(async () => {}),
    onCheck: vi.fn(async () => {}),
    onApplyTags: vi.fn(),
    onUndoTags: vi.fn(),
    onSavePage: vi.fn(),
    onIgnorePage: vi.fn(),
    onDismiss: vi.fn(),
    onOpenNote: vi.fn(),
    onOpenCitation: vi.fn(),
    onLockTags: vi.fn(),
    ...patch,
  };
}

function durableJob(data: WorkspaceData): OrganizationJob {
  const source = data.sources[0]!;
  return {
    id: "organization-waiting",
    durable: true,
    status: "queued",
    createdAt: "2026-09-14T09:30:00.000Z",
    updatedAt: "2026-09-14T09:30:00.000Z",
    request: {
      requestId: "organization-waiting",
      kind: "source",
      trigger: "manual",
      spaceId: data.spaces[0]!.id,
      sourceIds: [source.id],
      sourceVersions: [{ sourceId: source.id, versionId: source.versionId }],
    },
  };
}

function setInputValue(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("OrganizationPanel source selection layout", () => {
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

  it("uses the full source-list row when filtering leaves one visible source", async () => {
    const data = createDemoWorkspace();
    await act(async () => {
      root.render(createElement(OrganizationPanel, panelProps(data)));
    });

    const sourceList = () => host.querySelector<HTMLDivElement>(".organization-source-list")!;
    expect(sourceList().classList).not.toContain("organization-source-list--single");

    const search = host.querySelector<HTMLInputElement>('input[aria-label="搜索待整理资料"]')!;
    await act(async () => setInputValue(search, "梯度下降"));

    expect(sourceList().classList).toContain("organization-source-list--single");
    expect(sourceList().querySelectorAll(".organization-source-row")).toHaveLength(1);
  });

  it("waits for a declared processor before creating durable tasks but preserves queued-record checks", async () => {
    const data = createDemoWorkspace();
    data.organizationJobs = [durableJob(data)];
    const onCheck = vi.fn(async () => {});
    const onStop = vi.fn(async () => {});
    await act(async () => {
      root.render(
        createElement(
          OrganizationPanel,
          panelProps(data, {
            onCheck,
            onStop,
          }),
        ),
      );
    });

    expect(host.textContent).toContain("后台整理等待部署");
    expect(host.textContent).toContain("不能承诺 source／knowledge 任务在关闭页面后继续");
    const analyze = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.replace(/\s+/g, "") === "分析这份资料",
    )!;
    expect(analyze.disabled).toBe(true);
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.replace(/\s+/g, "") === "重新生成",
    )!;
    expect(retry.disabled).toBe(true);

    const refresh = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.replace(/\s+/g, "") === "刷新任务状态",
    )!;
    await act(async () => refresh.click());
    expect(onCheck).toHaveBeenCalledExactlyOnceWith("organization-waiting");

    const stop = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.replace(/\s+/g, "") === "停止",
    )!;
    await act(async () => stop.click());
    expect(onStop).toHaveBeenCalledExactlyOnceWith("organization-waiting");
  });

  it("enables new durable analysis after the processor is declared", async () => {
    const data = createDemoWorkspace();
    await act(async () => {
      root.render(
        createElement(
          OrganizationPanel,
          panelProps(data, {
            durableProcessorState: "declared",
            initialSourceIds: [data.sources[0]!.id],
          }),
        ),
      );
    });

    const analyze = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.replace(/\s+/g, "") === "分析这份资料",
    )!;
    expect(analyze.disabled).toBe(false);
  });

  it("enables only explicit manual source/knowledge work in the local development page runner", async () => {
    const data = createDemoWorkspace();
    const onGenerate = vi.fn(async () => {});
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_CONUO_LOCAL_ORGANIZATION_RUNNER_ENABLED", "true");
    await act(async () => {
      root.render(
        createElement(
          OrganizationPanel,
          panelProps(data, {
            initialSourceIds: [data.sources[0]!.id],
            onGenerate,
          }),
        ),
      );
    });

    expect(host.textContent).toContain("本地开发页面运行已启用");
    // The same promise the removed in-panel toggle used to carry: this runner
    // never queues automatic work. Turning automatic organization on or off is
    // now only possible in 设置 · AI 与资料处理.
    expect(host.textContent).toContain("不会创建后台任务或自动任务");
    expect(host.textContent).not.toContain("自动分析资料");
    const analyze = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.replace(/\s+/g, "") === "分析这份资料",
    )!;
    expect(analyze.disabled).toBe(false);

    await act(async () => analyze.click());
    expect(onGenerate).toHaveBeenCalledExactlyOnceWith({
      kind: "source",
      spaceId: data.spaces[0]!.id,
      sourceIds: [data.sources[0]!.id],
    });
  });

  it("submits a multi-selection as isolated source analyses and reports every success", async () => {
    const data = createDemoWorkspace();
    const selected = data.sources.map((source) => source.id);
    const onGenerate = vi.fn(async () => {});
    await act(async () => {
      root.render(
        createElement(
          OrganizationPanel,
          panelProps(data, {
            durableProcessorState: "declared",
            initialSourceIds: selected,
            onGenerate,
          }),
        ),
      );
    });

    const analyze = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.replace(/\s+/g, "") === "分析所选资料（2）",
    );
    expect(analyze).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      analyze!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onGenerate.mock.calls).toEqual(
      selected.map((sourceId) => [
        { kind: "source", spaceId: data.spaces[0]!.id, sourceIds: [sourceId] },
      ]),
    );
    expect(host.querySelector('[aria-label="批量资料分析结果"]')?.textContent).toContain(
      "已提交 2 / 2 份资料",
    );
  });

  it("continues after a source analysis failure and can retain only failed items", async () => {
    const data = createDemoWorkspace();
    const selected = data.sources.map((source) => source.id);
    const onGenerate = vi.fn(async ({ sourceIds }: { sourceIds: string[] }) => {
      if (sourceIds[0] === selected[1]) throw new Error("模型暂时不可用");
    });
    await act(async () => {
      root.render(
        createElement(
          OrganizationPanel,
          panelProps(data, {
            durableProcessorState: "declared",
            initialSourceIds: selected,
            onGenerate,
          }),
        ),
      );
    });

    const analyze = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.replace(/\s+/g, "") === "分析所选资料（2）",
    )!;
    await act(async () => {
      analyze.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const result = host.querySelector('[aria-label="批量资料分析结果"]');
    expect(result?.textContent).toContain("已提交 1 / 2 份资料");
    expect(result?.textContent).toContain("模型暂时不可用");
    const retainFailed = [...result!.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "仅保留未提交项",
    );
    await act(async () => retainFailed!.click());

    const checks = [...host.querySelectorAll<HTMLInputElement>(".organization-source-row input")];
    expect(checks.map((input) => input.checked)).toEqual([false, true]);
    expect(host.querySelector('[aria-label="批量资料分析结果"]')).toBeNull();
  });
});
