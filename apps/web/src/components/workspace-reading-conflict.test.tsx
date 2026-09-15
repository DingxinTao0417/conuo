// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadingProgressSyncPlan } from "@/lib/sync-conflicts";
import { ReadingProgressConflictModal } from "./workspace";

const plan: ReadingProgressSyncPlan = {
  baseKnown: true,
  safeLocal: [],
  conflicts: [
    {
      id: "reading-progress-conflict:source-a",
      sourceId: "source-a",
      sourceTitle: "算法导论",
      sourceKind: "pdf",
      pageCount: 20,
      base: {
        readPage: 1,
        readOffset: 10,
        lastReadAt: "2026-09-13T08:00:00.000Z",
      },
      local: {
        readPage: 9,
        readOffset: 900,
        lastReadAt: "2026-09-13T11:00:00.000Z",
      },
      remote: {
        readPage: 4,
        readOffset: 400,
        lastReadAt: "2026-09-13T10:00:00.000Z",
      },
    },
  ],
};

describe("ReadingProgressConflictModal", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
      }),
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute("open");
      }),
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("defaults to the confirmed cloud position and submits an explicit local choice", async () => {
    const onResolve = vi.fn(async () => {});
    const onClose = vi.fn();
    await act(async () => {
      root.render(createElement(ReadingProgressConflictModal, { plan, onResolve, onClose }));
    });

    expect(host.textContent).toContain("云端已确认（默认）");
    expect(host.textContent).toContain("本机待同步");
    expect(host.textContent).toContain("第 4 / 20 页");
    expect(host.textContent).toContain("第 9 / 20 页");
    expect(host.textContent).toContain("设备记录时间只供辨认，不用于自动覆盖");
    const remote = host.querySelector<HTMLInputElement>('input[value="remote"]')!;
    const local = host.querySelector<HTMLInputElement>('input[value="local"]')!;
    expect(remote.checked).toBe(true);
    expect(local.checked).toBe(false);

    await act(async () => local.click());
    expect(local.checked).toBe(true);
    await act(async () => {
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(onResolve).toHaveBeenCalledWith([
      { conflictId: "reading-progress-conflict:source-a", choice: "local" },
    ]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("submits the visible cloud default when the learner changes nothing", async () => {
    const onResolve = vi.fn(async () => {});
    await act(async () => {
      root.render(
        createElement(ReadingProgressConflictModal, {
          plan,
          onResolve,
          onClose: vi.fn(),
        }),
      );
    });

    await act(async () => {
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(onResolve).toHaveBeenCalledWith([
      { conflictId: "reading-progress-conflict:source-a", choice: "remote" },
    ]);
  });

  it("resets to the confirmed cloud choice when a later CAS conflict refreshes the plan", async () => {
    const onResolve = vi.fn(async () => {});
    await act(async () => {
      root.render(
        createElement(ReadingProgressConflictModal, {
          plan,
          onResolve,
          onClose: vi.fn(),
        }),
      );
    });
    await act(async () => host.querySelector<HTMLInputElement>('input[value="local"]')!.click());

    const refreshed: ReadingProgressSyncPlan = {
      ...plan,
      conflicts: [
        {
          ...plan.conflicts[0],
          id: "reading-progress-conflict:source-b",
          sourceId: "source-b",
          sourceTitle: "操作系统",
          remote: { readPage: 7, lastReadAt: "2026-09-13T12:00:00.000Z" },
        },
      ],
    };
    await act(async () => {
      root.render(
        createElement(ReadingProgressConflictModal, {
          plan: refreshed,
          onResolve,
          onClose: vi.fn(),
        }),
      );
    });

    expect(host.textContent).toContain("操作系统");
    expect(host.querySelector<HTMLInputElement>('input[value="remote"]')!.checked).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[value="local"]')!.checked).toBe(false);
    await act(async () => {
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onResolve).toHaveBeenLastCalledWith([
      { conflictId: "reading-progress-conflict:source-b", choice: "remote" },
    ]);
  });
});
