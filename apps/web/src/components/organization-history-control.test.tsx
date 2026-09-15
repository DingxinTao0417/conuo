// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationJob } from "@/lib/organization-types";
import OrganizationHistoryControl from "./organization-history-control";

function job(id: string, status: OrganizationJob["status"]): OrganizationJob {
  return {
    id,
    status,
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    request: {
      requestId: id,
      kind: status === "failed" ? "update" : "source",
      trigger: "manual",
      spaceId: "space-one",
      sourceIds: ["source-one"],
      sourceVersions: [{ sourceId: "source-one", versionId: "version-one" }],
    },
  };
}

describe("OrganizationHistoryControl", () => {
  let host: HTMLDivElement;
  let root: Root;
  let previousShowModal: PropertyDescriptor | undefined;
  let previousClose: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    previousShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
    previousClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
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
    if (previousShowModal)
      Object.defineProperty(HTMLDialogElement.prototype, "showModal", previousShowModal);
    else delete (HTMLDialogElement.prototype as { showModal?: () => void }).showModal;
    if (previousClose) Object.defineProperty(HTMLDialogElement.prototype, "close", previousClose);
    else delete (HTMLDialogElement.prototype as { close?: () => void }).close;
    vi.unstubAllGlobals();
  });

  it("previews terminal history before confirming cleanup", async () => {
    const onCleanup = vi.fn(() => true);
    await act(async () => {
      root.render(
        createElement(OrganizationHistoryControl, {
          jobs: [
            job("dismissed", "dismissed"),
            job("failed", "failed"),
            job("cancelled", "cancelled"),
            job("ready", "ready"),
          ],
          onCleanup,
        }),
      );
    });

    expect(host.textContent).toContain("已保存 4 / 1000 条");
    const open = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("清理 3 条记录"),
    )!;
    await act(async () => open.click());

    const dialog = host.querySelector("dialog");
    expect(dialog?.hasAttribute("open")).toBe(true);
    expect(dialog?.textContent).toContain("清理后保留 1 条记录");
    expect(dialog?.textContent).toContain("已收起1 条");
    expect(dialog?.textContent).toContain("未完成1 条");
    expect(dialog?.textContent).toContain("已停止1 条");
    expect(dialog?.textContent).toContain("资料分析 2 条 · 知识页更新 1 条");

    const confirm = Array.from(dialog!.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "清理 3 条记录",
    )!;
    await act(async () => confirm.click());

    expect(onCleanup).toHaveBeenCalledOnce();
    expect(host.querySelector("dialog")).toBeNull();
  });

  it("does not offer cleanup when only active or reviewable records remain", async () => {
    await act(async () => {
      root.render(
        createElement(OrganizationHistoryControl, {
          jobs: [job("queued", "queued"), job("running", "running"), job("ready", "ready")],
          onCleanup: vi.fn(() => true),
        }),
      );
    });

    const button = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((item) =>
      item.textContent?.includes("暂无可清理记录"),
    );
    expect(button?.disabled).toBe(true);
  });
});
