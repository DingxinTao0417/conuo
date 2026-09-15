// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEBIBYTE } from "@/lib/import-quota";
import type { Source, SourceVersion } from "@/lib/types";
import StorageUsagePanel from "./storage-usage-panel";

const now = "2026-09-14T08:00:00.000Z";

function historical(id: string, size: number): SourceVersion {
  return {
    versionId: id,
    title: id,
    filename: `${id}.pdf`,
    kind: "pdf",
    mime: "application/pdf",
    size,
    hash: `${id}-hash`,
    status: "ready",
    text: "正文",
    chunks: [],
    createdAt: now,
    archivedAt: now,
  };
}

function source(id: string, size: number, patch: Partial<Source> = {}): Source {
  return {
    id,
    versionId: `${id}-current`,
    title: id,
    filename: `${id}.pdf`,
    kind: "pdf",
    mime: "application/pdf",
    size,
    hash: `${id}-hash`,
    spaceIds: [],
    tags: [],
    status: "ready",
    text: "正文",
    chunks: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    aiAllowed: false,
    starred: false,
    ...patch,
  };
}

describe("StorageUsagePanel", () => {
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
    vi.unstubAllGlobals();
  });

  it("separates current, historical, and recycle-bin originals without presenting a cloud quota", async () => {
    const onOpenRecycleBin = vi.fn();
    await act(async () =>
      root.render(
        createElement(StorageUsagePanel, {
          sources: [
            source("active", 20 * MEBIBYTE, {
              versions: [historical("active-old", 5 * MEBIBYTE)],
            }),
            source("recycled", 3 * MEBIBYTE, { deletedAt: now }),
          ],
          onOpenRecycleBin,
        }),
      ),
    );

    expect(host.textContent).toContain("28 MiB/ 512 MiB");
    expect(host.textContent).toContain("当前资料1 份原件20 MiB");
    expect(host.textContent).toContain("历史版本1 份原件5 MiB");
    expect(host.textContent).toContain("回收站1 份原件3 MiB");
    expect(host.textContent).toContain("不代表浏览器、Supabase 或未来套餐的实际容量");

    const progress = host.querySelector('[role="progressbar"]');
    expect(progress?.getAttribute("aria-valuenow")).toBe(String(28 * MEBIBYTE));
    expect(progress?.getAttribute("aria-valuetext")).toBe("还可导入 484 MiB 原件");

    const recycleButton = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "查看回收站",
    );
    expect(recycleButton).toBeInstanceOf(HTMLButtonElement);
    await act(async () => recycleButton!.click());
    expect(onOpenRecycleBin).toHaveBeenCalledOnce();
  });
});
