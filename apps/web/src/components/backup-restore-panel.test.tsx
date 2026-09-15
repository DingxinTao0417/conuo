// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import BackupRestorePanel, { type BackupRestorePanelProps } from "./backup-restore-panel";
import { readWorkspaceBackup } from "@/lib/backup-archive";
import { mergeBackupRestore, prepareBackupRestore } from "@/lib/backup-restore";
import { createEmptyWorkspace } from "@/lib/seed";
import type { PreparedBackup, RestorePlan } from "@/lib/backup-types";

vi.mock("@/lib/backup-archive", () => ({ readWorkspaceBackup: vi.fn() }));
vi.mock("@/lib/backup-restore", () => ({
  mergeBackupRestore: vi.fn(),
  prepareBackupRestore: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("backup restore preview and commit boundaries", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: BackupRestorePanelProps;
  let plan: RestorePlan;
  let backup: PreparedBackup;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const data = createEmptyWorkspace();
    backup = { data, originals: [], missingOriginals: [], fingerprint: "a".repeat(64) };
    plan = {
      id: "plan-one",
      fingerprint: backup.fingerprint,
      data,
      blobs: [],
      missingOriginals: [],
      warnings: [],
      counts: {
        spaces: 1,
        sources: 0,
        sourceVersions: 0,
        notes: 0,
        noteVersions: 0,
        conversations: 0,
        messages: 0,
        annotations: 0,
        recoverableDrafts: 0,
        organizationJobs: 0,
        conceptRelations: 0,
      },
    };
    props = {
      data: createEmptyWorkspace(),
      onRestore: vi.fn(async () => {}),
      onClose: vi.fn(),
      onOpenRestored: vi.fn(),
    };
    vi.mocked(readWorkspaceBackup).mockResolvedValue(backup);
    vi.mocked(prepareBackupRestore).mockImplementation(() => plan);
    vi.mocked(mergeBackupRestore).mockImplementation((current) => current);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  async function render(next: Partial<BackupRestorePanelProps> = {}, key = "local") {
    props = { ...props, ...next };
    await act(async () => root.render(createElement(BackupRestorePanel, { ...props, key })));
  }
  async function select() {
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["test"], "backup.zip")],
    });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  }
  function button(text: string) {
    const found = [...host.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === text,
    );
    expect(found, text).toBeTruthy();
    return found!;
  }
  async function click(text: string) {
    await act(async () => button(text).click());
  }

  it("does not write while previewing and requires explicit acceptance of missing originals", async () => {
    plan.missingOriginals = [{ sourceId: "source", versionId: "v1", title: "缺失资料" }];
    await render({ accountEmail: "reader@example.test" });
    await select();
    expect(host.textContent).toContain("reader@example.test");
    expect(host.textContent).toContain("上传原件并同步");
    expect(props.onRestore).not.toHaveBeenCalled();
    expect(button("确认恢复为新增副本").disabled).toBe(true);
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await click("确认恢复为新增副本");
    expect(props.onRestore).toHaveBeenCalledExactlyOnceWith(plan);
    expect(host.textContent).toContain("恢复副本已保存在此浏览器");
    expect(host.textContent).toContain("云端同步进度请查看页面保存状态");
    expect(host.textContent).toContain("原件仍然缺失");
  });

  it("previews and reports recoverable drafts retained by the backup", async () => {
    plan.counts.recoverableDrafts = 2;
    await render();
    await select();

    const label = [...host.querySelectorAll("dt")].find(
      (item) => item.textContent === "可恢复草稿",
    );
    expect(label?.nextElementSibling?.textContent).toBe("2");
    await click("确认恢复为新增副本");
    expect(host.textContent).toContain("同时保留 2 份可恢复草稿");
  });

  it("prevents duplicate commits and dialog dismissal until local persistence settles", async () => {
    const commit = deferred<void>();
    await render({ onRestore: vi.fn(() => commit.promise) });
    await select();
    const submit = button("确认恢复为新增副本");
    await act(async () => {
      submit.click();
      submit.click();
    });
    expect(props.onRestore).toHaveBeenCalledTimes(1);
    expect(button("取消").disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.disabled).toBe(true);
    const cancel = new Event("cancel", { bubbles: true, cancelable: true });
    await act(async () => host.querySelector("dialog")!.dispatchEvent(cancel));
    expect(cancel.defaultPrevented).toBe(true);
    expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => commit.resolve());
    await click("查看恢复资料");
    expect(props.onOpenRestored).toHaveBeenCalledExactlyOnceWith(plan);
  });

  it("aborts a cancelled read and ignores its late success", async () => {
    const reading = deferred<PreparedBackup>();
    vi.mocked(readWorkspaceBackup).mockReturnValue(reading.promise);
    await render();
    await select();
    const signal = vi.mocked(readWorkspaceBackup).mock.calls[0][1]?.signal;
    await click("停止读取");
    expect(signal?.aborted).toBe(true);
    await act(async () => reading.resolve(backup));
    expect(prepareBackupRestore).not.toHaveBeenCalled();
    expect(button("确认恢复为新增副本").disabled).toBe(true);
  });

  it("an account remount discards a pending archive read", async () => {
    const reading = deferred<PreparedBackup>();
    vi.mocked(readWorkspaceBackup).mockReturnValue(reading.promise);
    await render();
    await select();
    const signal = vi.mocked(readWorkspaceBackup).mock.calls[0][1]?.signal;
    await render({ accountEmail: "second@example.test" }, "second-account");
    await act(async () => reading.resolve(backup));
    expect(signal?.aborted).toBe(true);
    expect(prepareBackupRestore).not.toHaveBeenCalled();
    expect(props.onRestore).not.toHaveBeenCalled();
  });

  it("rechecks the latest workspace capacity before enabling confirmation", async () => {
    await render();
    await select();
    expect(button("确认恢复为新增副本").disabled).toBe(false);
    vi.mocked(mergeBackupRestore).mockImplementation(() => {
      throw new Error("超过工作区容量");
    });
    await render({ data: { ...props.data } });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("超过工作区容量");
    expect(button("确认恢复为新增副本").disabled).toBe(true);
    expect(props.onRestore).not.toHaveBeenCalled();
  });

  it("keeps the same plan for a retry after failed persistence", async () => {
    const restore = vi
      .fn()
      .mockRejectedValueOnce(new Error("本机保存未确认，请重试"))
      .mockResolvedValueOnce(undefined);
    await render({ onRestore: restore });
    await select();
    await click("确认恢复为新增副本");
    expect(host.textContent).toContain("本机保存未确认");
    expect(host.textContent).not.toContain("恢复副本已保存在此浏览器");
    await click("确认恢复为新增副本");
    expect(restore.mock.calls).toEqual([[plan], [plan]]);
    expect(host.textContent).toContain("恢复副本已保存在此浏览器");
  });

  it("shows archive errors without allowing a commit", async () => {
    vi.mocked(readWorkspaceBackup).mockRejectedValue(new Error("原件校验失败"));
    await render();
    await select();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("原件校验失败");
    expect(button("确认恢复为新增副本").disabled).toBe(true);
    expect(props.onRestore).not.toHaveBeenCalled();
  });
});
