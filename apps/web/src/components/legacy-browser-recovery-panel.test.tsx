// @vitest-environment jsdom

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyWorkspace } from "@/lib/seed";
import type { RestorePlan } from "@/lib/backup-types";
import type { LegacyBrowserRecovery } from "@/lib/legacy-browser-recovery";
import LegacyBrowserRecoveryPanel, {
  type LegacyBrowserRecoveryPanelProps,
} from "./legacy-browser-recovery-panel";

const mock = vi.hoisted(() => ({
  prepare: vi.fn(),
  merge: vi.fn(),
  objectUrl: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock("@/lib/legacy-browser-recovery", () => ({ prepareLegacyBrowserRecovery: mock.prepare }));
vi.mock("@/lib/backup-restore", () => ({ mergeBackupRestore: mock.merge }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("LegacyBrowserRecoveryPanel one-time cloud import confirmation", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: LegacyBrowserRecoveryPanelProps;
  let recovery: LegacyBrowserRecovery;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    vi.clearAllMocks();
    mock.prepare.mockReset();
    mock.merge.mockReset();
    mock.objectUrl.mockImplementation(() => `blob:legacy-${mock.objectUrl.mock.calls.length}`);
    vi.stubGlobal("URL", { createObjectURL: mock.objectUrl, revokeObjectURL: mock.revoke });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const data = createEmptyWorkspace();
    const plan: RestorePlan = {
      id: "stable-plan",
      fingerprint: "a".repeat(64),
      data,
      blobs: [],
      missingOriginals: [],
      warnings: [],
      counts: {
        spaces: 2,
        sources: 7,
        sourceVersions: 3,
        notes: 1,
        noteVersions: 2,
        conversations: 1,
        messages: 2,
        annotations: 4,
        recoverableDrafts: 0,
        organizationJobs: 0,
        conceptRelations: 0,
      },
    };
    recovery = { plan, archive: new Blob(["one prepared ZIP"], { type: "application/zip" }) };
    mock.prepare.mockResolvedValue(recovery);
    mock.merge.mockImplementation((current) => current);
    props = {
      data: createEmptyWorkspace(),
      accountEmail: "target@example.test",
      onRestore: vi.fn(async () => {}),
      onClose: vi.fn(),
    };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function render(next: Partial<LegacyBrowserRecoveryPanelProps> = {}, strict = false) {
    props = { ...props, ...next };
    await act(async () =>
      root.render(
        strict
          ? createElement(StrictMode, null, createElement(LegacyBrowserRecoveryPanel, props))
          : createElement(LegacyBrowserRecoveryPanel, props),
      ),
    );
  }
  function button(label: string) {
    const found = [...host.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === label,
    );
    expect(found, label).toBeDefined();
    return found!;
  }
  async function click(label: string) {
    await act(async () => button(label).click());
  }

  it("reads legacy only after mounting the explicit recovery dialog and shows real counts/target/AI defaults", async () => {
    expect(mock.prepare).not.toHaveBeenCalled();
    await render();
    expect(mock.prepare).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("7 份资料、1 篇笔记");
    expect(host.textContent).toContain("target@example.test");
    expect(host.textContent).toContain("新增副本");
    expect(host.textContent).toContain("默认关闭 AI 使用");
    expect(mock.merge).toHaveBeenCalledWith(props.data, recovery.plan);
    expect(props.onRestore).not.toHaveBeenCalled();
    expect(button("导入到当前云端账号").disabled).toBe(false);
  });

  it("Strict Mode starts the explicit legacy read once", async () => {
    await render({}, true);
    expect(mock.prepare).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("7 份资料、1 篇笔记");
  });

  it("a partial backup requires explicit acknowledgment before importing missing-original metadata", async () => {
    recovery.plan.missingOriginals = [
      {
        sourceId: "missing-source",
        versionId: "missing-version",
        title: "缺失资料",
        reason: "旧版原件不在此浏览器",
      },
    ];
    await render();
    expect(host.textContent).toContain("缺少 1 个版本的原件");
    expect(host.textContent).toContain("missing-version");
    expect(button("导入到当前云端账号").disabled).toBe(true);
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(button("导入到当前云端账号").disabled).toBe(false);
    await click("导入到当前云端账号");
    expect(props.onRestore).toHaveBeenCalledExactlyOnceWith(recovery.plan);
  });

  it("does not claim cloud success before the parent confirms all originals and metadata are saved", async () => {
    const commit = deferred<void>();
    await render({ onRestore: vi.fn(() => commit.promise) });
    await click("导入到当前云端账号");
    expect(host.textContent).toContain("正在上传原件并确认云端保存");
    expect(host.textContent).not.toContain("旧版资料已保存至云端");
    expect(button("取消").disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.disabled).toBe(true);
    await act(async () =>
      host.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })),
    );
    expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => commit.resolve());
    expect(host.textContent).toContain("旧版资料已保存至云端");
    expect(host.textContent).toContain("旧版浏览器副本仍保留");
  });

  it("retries a failed cloud save using the same stable plan and bytes, without re-reading or re-preparing", async () => {
    const restore = vi
      .fn()
      .mockRejectedValueOnce(new Error("云端暂不可用"))
      .mockResolvedValueOnce(undefined);
    await render({ onRestore: restore });
    await click("导入到当前云端账号");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("云端暂不可用");
    expect(host.textContent).not.toContain("旧版资料已保存至云端");
    await click("导入到当前云端账号");
    expect(restore.mock.calls.map(([plan]) => plan)).toEqual([recovery.plan, recovery.plan]);
    expect(mock.prepare).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("旧版资料已保存至云端");
  });

  it("capacity validation disables import while keeping the prepared ZIP available", async () => {
    mock.merge.mockImplementation(() => {
      throw new Error("并入完整备份后会超过工作区 3 MiB 容量");
    });
    await render();
    expect(button("导入到当前云端账号").disabled).toBe(true);
    expect(button("下载旧版备份 ZIP").disabled).toBe(false);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("3 MiB");
    expect(props.onRestore).not.toHaveBeenCalled();
  });

  it("downloads the prepared archive repeatedly without any new recovery read or import", async () => {
    await render();
    await click("下载旧版备份 ZIP");
    await click("下载旧版备份 ZIP");
    expect(mock.objectUrl).toHaveBeenNthCalledWith(1, recovery.archive);
    expect(mock.objectUrl).toHaveBeenNthCalledWith(2, recovery.archive);
    expect(mock.prepare).toHaveBeenCalledOnce();
    expect(props.onRestore).not.toHaveBeenCalled();
    expect(document.querySelector('a[download="conuo-legacy-browser-backup.zip"]')).toBeNull();
    await act(async () => root.unmount());
    expect(mock.revoke).toHaveBeenCalledWith("blob:legacy-1");
    expect(mock.revoke).toHaveBeenCalledWith("blob:legacy-2");
    root = createRoot(host);
  });

  it("an empty legacy workspace cannot trigger a spurious import or success", async () => {
    mock.prepare.mockResolvedValue(null);
    await render();
    expect(host.textContent).toContain("没有可导入的旧版匿名资料");
    expect(button("导入到当前云端账号").disabled).toBe(true);
    expect(props.onRestore).not.toHaveBeenCalled();
  });

  it("a note-only preview remains importable without source originals", async () => {
    recovery.plan.counts.sources = 0;
    await render();
    expect(host.textContent).toContain("0 份资料、1 篇笔记");
    expect(button("导入到当前云端账号").disabled).toBe(false);
  });

  it("a read error never becomes a saved or empty-workspace success", async () => {
    mock.prepare.mockRejectedValue(new Error("旧版资料格式无效"));
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("旧版资料格式无效");
    expect(host.textContent).not.toContain("已保存至云端");
    expect(button("导入到当前云端账号").disabled).toBe(true);
  });

  it("cancel aborts a pending readonly recovery and ignores a late prepared plan", async () => {
    const pending = deferred<LegacyBrowserRecovery>();
    mock.prepare.mockReturnValue(pending.promise);
    await render();
    const signal = mock.prepare.mock.calls[0][0] as AbortSignal;
    await click("取消");
    expect(signal.aborted).toBe(true);
    expect(props.onClose).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(recovery));
    expect(host.querySelector('[aria-label="旧版资料预览"]')).toBeNull();
    expect(props.onRestore).not.toHaveBeenCalled();
  });

  it("unmount aborts reading and ignores late success without triggering a restore", async () => {
    const pending = deferred<LegacyBrowserRecovery>();
    mock.prepare.mockReturnValue(pending.promise);
    await render();
    const signal = mock.prepare.mock.calls[0][0] as AbortSignal;
    await act(async () => root.unmount());
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(recovery));
    expect(host.innerHTML).toBe("");
    expect(props.onRestore).not.toHaveBeenCalled();
    root = createRoot(host);
  });

  it("account changes abort recovery and invalidate the reviewed destination", async () => {
    await render();
    const signal = mock.prepare.mock.calls[0][0] as AbortSignal;
    await render({ accountEmail: "different@example.test" });
    expect(signal.aborted).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("当前账号已改变");
    expect(host.textContent).not.toContain("导入到当前云端账号");
    expect(mock.prepare).toHaveBeenCalledOnce();
    expect(props.onRestore).not.toHaveBeenCalled();
  });

  it("an old-account commit completion cannot report success into the new account", async () => {
    const pending = deferred<void>();
    await render({ onRestore: vi.fn(() => pending.promise) });
    await click("导入到当前云端账号");
    await render({ accountEmail: "different@example.test" });
    await act(async () => pending.resolve());
    expect(host.textContent).toContain("当前账号已改变");
    expect(host.textContent).not.toContain("旧版资料已保存至云端");
  });
});
