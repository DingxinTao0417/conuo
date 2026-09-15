import { describe, expect, it } from "vitest";
import type { SaveState } from "./types";
import { workspaceSyncPresentation } from "./workspace-sync-presentation";

describe("workspaceSyncPresentation", () => {
  it("maps every workspace save state without claiming cloud confirmation early", () => {
    const cases: Array<{
      status: SaveState;
      label: string;
      description?: string;
      error?: string;
    }> = [
      { status: "loading", label: "正在读取工作区" },
      { status: "saving", label: "正在同步工作区" },
      { status: "local", label: "本机副本已保存", description: "正在等待云端保存确认。" },
      { status: "cloud", label: "工作区已保存到云端" },
      {
        status: "error",
        label: "保存需要处理",
        description: "云端写入失败，已保留本机副本。",
        error: "云端写入失败，已保留本机副本。",
      },
      { status: "conflict", label: "同步冲突等待处理" },
    ];

    for (const current of cases) {
      const presentation = workspaceSyncPresentation({
        status: current.status,
        error: current.error,
        cloudConfigured: true,
        signedIn: true,
      });
      expect(presentation.label).toBe(current.label);
      if (current.description) expect(presentation.description).toBe(current.description);
      expect(presentation.label.includes("已保存到云端")).toBe(current.status === "cloud");
    }
  });

  it("gives recovery and account boundaries precedence over the aggregate state", () => {
    expect(
      workspaceSyncPresentation({
        status: "error",
        error: "本机缓存不可读",
        cloudConfigured: true,
        signedIn: true,
        cloudReadOnly: true,
      }),
    ).toMatchObject({ label: "云端资料只读恢复中", tone: "warning" });
    expect(
      workspaceSyncPresentation({
        status: "saving",
        cloudConfigured: true,
        signedIn: true,
        migrationPending: true,
      }),
    ).toMatchObject({ label: "本机资料等待迁移决定", tone: "warning" });
    expect(
      workspaceSyncPresentation({
        status: "cloud",
        cloudConfigured: true,
        signedIn: true,
        purging: true,
      }),
    ).toMatchObject({ label: "正在安全清理资料", tone: "progress" });
    expect(
      workspaceSyncPresentation({
        status: "local",
        cloudConfigured: false,
        signedIn: false,
      }),
    ).toMatchObject({ label: "仅在此浏览器保存", tone: "neutral" });
    expect(
      workspaceSyncPresentation({
        status: "local",
        cloudConfigured: true,
        signedIn: false,
      }),
    ).toMatchObject({ label: "本机工作区未登录", tone: "neutral" });
  });
});
