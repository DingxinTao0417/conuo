// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import type { WorkspaceData } from "@/lib/types";

let workspaceStore: Record<string, unknown>;

vi.mock("next/dynamic", () => ({
  default: (() => {
    let index = 0;
    return () => {
      index += 1;
      if (index === 3)
        return function OrganizationProbe(props: { initialSourceIds?: string[]; spaceId: string }) {
          return createElement("output", {
            "aria-label": "批量操作审核入口",
            "data-source-ids": JSON.stringify(props.initialSourceIds || []),
            "data-space-id": props.spaceId,
          });
        };
      return () => null;
    };
  })(),
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/use-workspace", () => ({ useWorkspace: () => workspaceStore }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signOut: vi.fn() } }),
}));
vi.mock("@/lib/cloud", () => ({
  isCloudConfigured: () => false,
  previewAccountDeletion: vi.fn(),
  requestAccountDeletion: vi.fn(),
}));
vi.mock("@/lib/use-knowledge-update-review-drafts", () => ({
  useKnowledgeUpdateReviewDrafts: () => ({
    draftsFor: () => ({}),
    change: vi.fn(),
    removeChanges: vi.fn(),
    retry: vi.fn(),
    status: { kind: "idle", message: "" },
  }),
}));
vi.mock("./collection-library", () => ({ default: () => null, CollectionActions: () => null }));
vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./workspace-search", () => ({ default: () => null }));
vi.mock("./indexing-panel", () => ({ default: () => null }));
vi.mock("./web-import-form", () => ({ default: () => null }));

import Workspace from "./workspace";

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("Workspace bulk association and recycling durable acknowledgements", () => {
  let host: HTMLDivElement, root: Root, data: WorkspaceData, persisted: WorkspaceData;
  let beforeReduce: ReturnType<typeof deferred> | undefined;
  let ack: ReturnType<typeof deferred> | undefined;
  let saveError: Error | undefined;
  let submissions: { current: WorkspaceData; next: WorkspaceData }[];
  let durable: ReturnType<
    typeof vi.fn<(updater: (current: WorkspaceData) => WorkspaceData) => Promise<boolean>>
  >;
  let mounted: boolean;
  let dialogDescriptors: { show?: PropertyDescriptor; close?: PropertyDescriptor };

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    dialogDescriptors = {
      show: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal"),
      close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close"),
    };
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: vi.fn(),
    });
    beforeReduce = undefined;
    ack = undefined;
    saveError = undefined;
    submissions = [];
    data = createDemoWorkspace();
    data.spaces.push({
      ...data.spaces[0]!,
      id: "review-space",
      name: "算法复习",
      goal: "标签审核",
    });
    data.sources.forEach((source, index) => {
      source.title = `批量操作资料${index + 1}`;
      source.spaceIds = [];
    });
    persisted = structuredClone(data);
    durable = vi.fn(async (updater) => {
      const reduceGate = beforeReduce,
        ackGate = ack,
        failure = saveError;
      if (reduceGate) await reduceGate.promise;
      const current = data,
        next = updater(current);
      submissions.push({ current, next });
      // The real coordinator admits a new snapshot, not an unchanged reference.
      if (next === current) return false;
      data = next;
      workspaceStore = { ...workspaceStore, data };
      if (mounted) root.render(createElement(Workspace));
      if (ackGate) await ackGate.promise;
      if (failure) throw failure;
      persisted = structuredClone(next);
      return true;
    });
    workspaceStore = {
      token: 1,
      data,
      updateDurably: durable,
      getCurrentWorkspaceData: () => data,
      update: vi.fn((updater: (current: WorkspaceData) => WorkspaceData) => {
        data = updater(data);
        workspaceStore = { ...workspaceStore, data };
        return true;
      }),
      ready: true,
      status: "cloud",
      localCacheMode: "normal",
      user: { id: "account-a", email: "account-a@example.test" },
      anonymousMigration: { kind: "none", canMigrate: false },
      signOut: vi.fn(),
      signOutState: { kind: "ready", canSync: false, canKeepLocalDraft: false },
      ask: vi.fn(),
      cancelImport: vi.fn(),
      checkOrganization: vi.fn(),
      discardAccount: vi.fn(),
      error: "",
      importFile: vi.fn(),
      organize: vi.fn(),
      previewSourcePurge: vi.fn(),
      purgeSource: vi.fn(),
      purging: false,
      refreshOrganizationStatus: vi.fn(),
      replaceFile: vi.fn(),
      resolveNoteConflicts: vi.fn(),
      restoreBackup: vi.fn(),
      retry: vi.fn(),
      retryImport: vi.fn(),
      retryOrganization: vi.fn(),
      sourceBlob: vi.fn(async () => undefined),
      stopOrganization: vi.fn(),
      useRemote: vi.fn(),
    };
    window.history.replaceState(null, "", "#library/inbox");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    mounted = true;
    await render();
  });

  afterEach(async () => {
    if (mounted) await act(async () => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
    for (const [name, descriptor] of [
      ["showModal", dialogDescriptors.show],
      ["close", dialogDescriptors.close],
    ] as const)
      if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
      else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    vi.unstubAllGlobals();
  });

  async function render(patch: Record<string, unknown> = {}) {
    workspaceStore = { ...workspaceStore, data, ...patch };
    await act(async () => root.render(createElement(Workspace)));
  }

  function button(text: string, scope: ParentNode = host) {
    const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent?.replace(/\s+/gu, "") === text.replace(/\s+/gu, ""),
    );
    expect(match, `button ${text}`).toBeInstanceOf(HTMLButtonElement);
    return match!;
  }

  function modal(kind: "spaces" | "recycle") {
    const node = host.querySelector<HTMLDialogElement>(
      `dialog:has(.bulk-${kind === "spaces" ? "space" : "recycle"}-modal)`,
    );
    expect(node, `${kind} modal`).not.toBeNull();
    return node!;
  }

  async function select(index: number) {
    const checkbox = host.querySelector<HTMLInputElement>(
      `input[aria-label="选择 ${data.sources[index]!.title}"]`,
    );
    expect(checkbox).toBeInstanceOf(HTMLInputElement);
    if (!checkbox!.checked) await act(async () => checkbox!.click());
  }

  async function open(kind: "spaces" | "recycle", indices = [0, 1]) {
    for (const index of indices) await select(index);
    await act(async () => button(kind === "spaces" ? "关联空间" : "移入回收站").click());
    modal(kind);
    if (kind === "spaces") await chooseSpace("算法复习");
  }

  async function chooseSpace(name: string) {
    const checkbox = [
      ...modal("spaces").querySelectorAll<HTMLLabelElement>(".bulk-space-list label"),
    ]
      .find((label) => label.textContent?.includes(name))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).toBeInstanceOf(HTMLInputElement);
    await act(async () => checkbox!.click());
  }

  function result(kind: "spaces" | "recycle") {
    return host.querySelector(
      `[aria-label="${kind === "spaces" ? "关联结果" : "移入回收站结果"}"]`,
    );
  }

  function submit(kind: "spaces" | "recycle", count = kind === "spaces" ? 1 : 2) {
    return button(
      kind === "spaces" ? `关联到所选空间（${count}）` : `移入回收站（${count}）`,
      modal(kind),
    );
  }

  it("does not publish association success or allow handoff before durable acknowledgement, including a same-tick double click", async () => {
    await open("spaces");
    ack = deferred();
    const initialDisk = structuredClone(persisted);
    const action = submit("spaces");
    await act(async () => {
      action.click();
      action.click();
    });
    expect(durable).toHaveBeenCalledOnce();
    expect(data.sources.map((source) => source.spaceIds)).toEqual([
      ["review-space"],
      ["review-space"],
    ]);
    expect(persisted).toEqual(initialDisk);
    expect(result("spaces")).toBeNull();
    const handoff = [...modal("spaces").querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent?.includes("审核标签建议"),
    );
    expect(!handoff || handoff.disabled).toBe(true);
    expect(modal("spaces").textContent).toContain("正在保存到本机");
    await act(async () => ack!.resolve());
    expect(result("spaces")?.textContent).toContain("本机保存已确认");
    expect(result("spaces")?.textContent).toContain("已关联 2 份资料");
    expect(persisted.sources.every((source) => source.spaceIds.includes("review-space"))).toBe(
      true,
    );
    await act(async () => button("审核标签建议", modal("spaces")).click());
    const probe = host.querySelector<HTMLOutputElement>('[aria-label="批量操作审核入口"]');
    expect(probe?.dataset.spaceId).toBe("review-space");
    expect(JSON.parse(probe?.dataset.sourceIds || "[]")).toEqual(
      data.sources.map((source) => source.id),
    );
  });

  it("keeps a recycling disk failure retryable after all selected sources already disappeared from the live list", async () => {
    await open("recycle");
    saveError = new Error("本机磁盘写入失败");
    await act(async () => submit("recycle").click());
    expect(data.sources.every((source) => Boolean(source.deletedAt))).toBe(true);
    expect(persisted.sources.every((source) => source.deletedAt === null)).toBe(true);
    expect(result("recycle")).toBeNull();
    expect(modal("recycle").textContent).toContain("本机磁盘写入失败");
    const retry = button("重试本机保存", modal("recycle"));
    expect(retry.disabled).toBe(false);
    const attempted = structuredClone(data);
    saveError = undefined;
    ack = deferred();
    await act(async () => {
      retry.click();
      retry.click();
    });
    expect(durable).toHaveBeenCalledTimes(2);
    expect(data.sources).toEqual(attempted.sources);
    expect(submissions[1]!.next).not.toBe(submissions[1]!.current);
    expect(result("recycle")).toBeNull();
    await act(async () => ack!.resolve());
    expect(result("recycle")?.textContent).toContain("已移入 2 份资料");
    expect(result("recycle")?.textContent).toContain("本机保存已确认");
    expect(persisted.sources).toEqual(attempted.sources);
  });

  it("preserves the first accepted association IDs through a disk retry instead of replacing them with now-noop IDs", async () => {
    await open("spaces");
    const acceptedId = data.sources[0]!.id,
      skippedId = data.sources[1]!.id;
    data.sources[1]!.spaceIds = ["review-space"];
    saveError = new Error("关联尚未写入本机磁盘");
    await act(async () => submit("spaces").click());
    expect(result("spaces")).toBeNull();
    expect(data.sources.every((source) => source.spaceIds.includes("review-space"))).toBe(true);
    expect(modal("spaces").textContent).toContain("关联尚未写入本机磁盘");
    saveError = undefined;
    await act(async () => button("重试本机保存", modal("spaces")).click());
    expect(durable).toHaveBeenCalledTimes(2);
    expect(submissions[1]!.next).not.toBe(submissions[1]!.current);
    expect(result("spaces")?.textContent).toContain("已关联 1 份资料");
    await act(async () => button("审核标签建议", modal("spaces")).click());
    const probe = host.querySelector<HTMLOutputElement>('[aria-label="批量操作审核入口"]');
    expect(probe?.dataset.spaceId).toBe("review-space");
    expect(JSON.parse(probe?.dataset.sourceIds || "[]")).toEqual([acceptedId]);
    expect(probe?.dataset.sourceIds).not.toContain(skippedId);
  });

  it("retries only a failed association while retaining independently edited successful sources", async () => {
    await open("spaces");
    const firstId = data.sources[0]!.id,
      failedId = data.sources[1]!.id;
    data.sources[1]!.deletedAt = "2026-09-15T10:00:00.000Z";
    await act(async () => submit("spaces").click());
    expect(result("spaces")?.textContent).toContain("已关联 1 份资料");
    expect(result("spaces")?.textContent).toContain(data.sources[1]!.title);
    data = {
      ...data,
      sources: data.sources.map((source) =>
        source.id === firstId
          ? { ...source, tags: ["后来独立编辑"], updatedAt: "2026-09-15T11:00:00.000Z" }
          : { ...source, deletedAt: null },
      ),
    };
    await render();
    const independentSource = structuredClone(data.sources[0]!);
    await act(async () => button("仅重试失败 1 份", modal("spaces")).click());
    expect(durable).toHaveBeenCalledTimes(2);
    expect(data.sources[0]).toEqual(independentSource);
    expect(persisted.sources[0]).toEqual(independentSource);
    expect(data.sources.find((source) => source.id === failedId)?.spaceIds).toContain(
      "review-space",
    );
    await act(async () => button("审核标签建议", modal("spaces")).click());
    const probe = host.querySelector<HTMLOutputElement>('[aria-label="批量操作审核入口"]');
    expect(JSON.parse(probe?.dataset.sourceIds || "[]")).toEqual([firstId, failedId]);
  });

  it.each(["noop", "failed"] as const)(
    "requires a real snapshot acknowledgement for an all-%s association result",
    async (kind) => {
      await open("spaces");
      if (kind === "noop")
        data.sources.forEach((source) => {
          source.spaceIds = ["review-space"];
        });
      else {
        data = { ...data, sources: [] };
        await render();
      }
      ack = deferred();
      await act(async () => submit("spaces").click());
      expect(durable).toHaveBeenCalledOnce();
      expect(submissions).toHaveLength(1);
      expect(submissions[0]!.next).not.toBe(submissions[0]!.current);
      expect(result("spaces")).toBeNull();
      await act(async () => ack!.resolve());
      expect(result("spaces")?.textContent).toContain("本机保存已确认");
      expect(result("spaces")?.textContent).not.toMatch(/已关联\s+[1-9]/u);
      const handoff = [...modal("spaces").querySelectorAll<HTMLButtonElement>("button")].find(
        (node) => node.textContent?.includes("审核标签建议"),
      );
      expect(!handoff || handoff.disabled).toBe(true);
      if (kind === "failed")
        expect(button("仅重试失败 2 份", modal("spaces")).disabled).toBe(false);
      else
        expect(
          [...modal("spaces").querySelectorAll("button")].some((node) =>
            node.textContent?.includes("仅重试失败"),
          ),
        ).toBe(false);
    },
  );

  it.each(["account", "token", "cache"] as const)(
    "rejects a late reducer after %s changes away and back, never reviving the old operation",
    async (kind) => {
      await open("spaces");
      beforeReduce = deferred();
      await act(async () => submit("spaces").click());
      expect(durable).toHaveBeenCalledOnce();
      const original = structuredClone(data);
      await render(
        kind === "account"
          ? { user: { id: "account-b", email: "b@example.test" } }
          : kind === "token"
            ? { token: 2 }
            : { localCacheMode: "cloud-readonly" },
      );
      await render(
        kind === "account"
          ? { user: { id: "account-a", email: "account-a@example.test" } }
          : kind === "token"
            ? { token: 1 }
            : { localCacheMode: "normal" },
      );
      await act(async () => beforeReduce!.resolve());
      expect(submissions).toHaveLength(0);
      expect(data).toEqual(original);
      expect(persisted).toEqual(original);
      expect(result("spaces")).toBeNull();
      expect(host.querySelector(".toast")?.textContent || "").not.toMatch(/已为|已关联/u);
    },
  );

  it("blocks an old reducer after active dismissal and reopening the same association scope", async () => {
    await open("spaces");
    beforeReduce = deferred();
    await act(async () => submit("spaces").click());
    const close = modal("spaces").querySelector<HTMLButtonElement>('[aria-label="关闭"]')!;
    expect(close.disabled).toBe(false);
    await act(async () => close.click());
    expect(host.querySelector(".bulk-space-modal")).toBeNull();
    await open("spaces");
    await act(async () => beforeReduce!.resolve());
    expect(submissions).toHaveLength(0);
    expect(data.sources.every((source) => source.spaceIds.length === 0)).toBe(true);
    expect(result("spaces")).toBeNull();
    expect(modal("spaces").textContent).not.toContain("本机保存已确认");
  });

  it("discards an old recycling acknowledgement after closing and opening a new modal", async () => {
    await open("recycle");
    ack = deferred();
    await act(async () => submit("recycle").click());
    expect(result("recycle")).toBeNull();
    await act(async () =>
      modal("recycle").querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click(),
    );
    data = { ...data, sources: data.sources.map((source) => ({ ...source, deletedAt: null })) };
    await render();
    await open("recycle");
    await act(async () => ack!.resolve());
    expect(result("recycle")).toBeNull();
    expect(modal("recycle").textContent).not.toContain("本机保存已确认");
    expect(host.querySelector(".toast")?.textContent || "").not.toContain("已将");
  });

  it("does not publish a late rejected association write into another account", async () => {
    await open("spaces");
    ack = deferred();
    await act(async () => submit("spaces").click());
    data = {
      ...data,
      sources: data.sources.map((source) => ({
        ...source,
        title: `B账号 ${source.title}`,
        spaceIds: [],
      })),
    };
    await render({ token: 2, user: { id: "account-b", email: "b@example.test" } });
    const otherAccount = structuredClone(data);
    await act(async () => ack!.reject(new Error("A账号旧磁盘错误")));
    expect(data).toEqual(otherAccount);
    expect(result("spaces")).toBeNull();
    expect(host.textContent).not.toContain("A账号旧磁盘错误");
    expect(host.querySelector(".toast")?.textContent || "").not.toMatch(/已为|已关联/u);
  });

  it("invalidates an old reducer when target spaces are changed and restored before it executes", async () => {
    await open("spaces");
    beforeReduce = deferred();
    await act(async () => submit("spaces").click());
    // The controls are disabled while this review is being saved. Dismissal
    // is the supported way to change targets rather than changing a busy form.
    await act(async () =>
      modal("spaces").querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click(),
    );
    await open("spaces");
    await chooseSpace("算法复习");
    await chooseSpace(data.spaces[0]!.name);
    await chooseSpace(data.spaces[0]!.name);
    await chooseSpace("算法复习");
    await act(async () => beforeReduce!.resolve());
    expect(submissions).toHaveLength(0);
    expect(data.sources.every((source) => source.spaceIds.length === 0)).toBe(true);
    expect(result("spaces")).toBeNull();
  });

  it.each(["target", "member"] as const)(
    "rechecks a confirmed association handoff when its %s becomes invalid, without widening or shrinking the review",
    async (kind) => {
      await open("spaces");
      await act(async () => submit("spaces").click());
      expect(result("spaces")?.textContent).toContain("已关联 2 份资料");
      const continueButton = button("审核标签建议", modal("spaces"));
      // Change the authoritative current snapshot before clicking a previously
      // enabled button, so this exercises the operation fence, not just disabled UI.
      if (kind === "target")
        data.spaces.find((space) => space.id === "review-space")!.archived = true;
      else data.sources[1]!.spaceIds = [];
      const originalHash = window.location.hash;
      await act(async () => continueButton.click());
      expect(window.location.hash).toBe(originalHash);
      expect(host.querySelector('[aria-label="批量操作审核入口"]')).toBeNull();
      expect(host.querySelector(".bulk-space-modal")).not.toBeNull();
      expect(modal("spaces").textContent).toMatch(/重新核对|已归档|关联.*改变|不.*属于/u);
    },
  );

  it.each(["target", "member", "version"] as const)(
    "rejects an enabled handoff after an immutable authoritative %s update before React commits it",
    async (kind) => {
      await open("spaces");
      await act(async () => submit("spaces").click());
      expect(result("spaces")?.textContent).toContain("已关联 2 份资料");
      const continueButton = button("审核标签建议", modal("spaces"));
      expect(continueButton.disabled).toBe(false);
      const renderedSnapshot = data;
      // Publish a fresh authoritative snapshot, as WorkspaceCoordinator does,
      // while the mounted button and handlers still belong to the old render.
      data =
        kind === "target"
          ? {
              ...data,
              spaces: data.spaces.map((space) =>
                space.id === "review-space" ? { ...space, archived: true } : space,
              ),
            }
          : {
              ...data,
              sources: data.sources.map((source, index) =>
                index === 1
                  ? kind === "version"
                    ? { ...source, versionId: crypto.randomUUID() }
                    : { ...source, spaceIds: [] }
                  : source,
              ),
            };
      workspaceStore = { ...workspaceStore, data };
      expect(data).not.toBe(renderedSnapshot);
      expect(
        renderedSnapshot.sources.every((source) => source.spaceIds.includes("review-space")),
      ).toBe(true);
      const originalHash = window.location.hash;
      await act(async () => continueButton.click());
      expect(window.location.hash).toBe(originalHash);
      expect(host.querySelector('[aria-label="批量操作审核入口"]')).toBeNull();
      expect(host.querySelector(".bulk-space-modal")).not.toBeNull();
      expect(modal("spaces").textContent).toMatch(/重新核对|已归档|关联.*改变|不.*属于/u);
    },
  );

  it("rejects an old reducer after unmount before any workspace mutation or disk snapshot", async () => {
    await open("recycle");
    beforeReduce = deferred();
    await act(async () => submit("recycle").click());
    const original = structuredClone(data);
    await act(async () => root.unmount());
    mounted = false;
    await act(async () => beforeReduce!.resolve());
    expect(submissions).toHaveLength(0);
    expect(data).toEqual(original);
    expect(persisted).toEqual(original);
    expect(host.childElementCount).toBe(0);
  });

  it.each(["spaces", "recycle"] as const)(
    "rejects the %s receipt when an independent edit reverses its accepted mutation during disk acknowledgement",
    async (kind) => {
      await open(kind);
      ack = deferred();
      await act(async () => submit(kind).click());
      expect(result(kind)).toBeNull();
      data = {
        ...data,
        sources: data.sources.map((source, index) =>
          index !== 0
            ? source
            : kind === "spaces"
              ? { ...source, spaceIds: [], updatedAt: "2026-09-15T12:30:00.000Z" }
              : { ...source, deletedAt: null, updatedAt: "2026-09-15T12:30:00.000Z" },
        ),
      };
      await render();
      const independentEdit = structuredClone(data.sources[0]!);
      await act(async () => ack!.resolve());
      expect(data.sources[0]).toEqual(independentEdit);
      expect(result(kind)).toBeNull();
      expect(modal(kind).textContent).not.toContain("本机保存已确认");
      expect(modal(kind).querySelector('[role="alert"]')).not.toBeNull();
      expect(button("重新核对资料", modal(kind)).disabled).toBe(false);
      expect(host.querySelector('[aria-label="批量操作审核入口"]')).toBeNull();
    },
  );

  it("allows unrelated source tag editing during disk acknowledgement and confirms against the latest live snapshot", async () => {
    await open("spaces");
    ack = deferred();
    await act(async () => submit("spaces").click());
    data = {
      ...data,
      sources: data.sources.map((source, index) =>
        index === 0 ? { ...source, tags: ["ACK等待时的独立编辑"], tagsRevision: 8 } : source,
      ),
    };
    await render();
    const independentSource = structuredClone(data.sources[0]!);
    await act(async () => ack!.resolve());
    expect(data.sources[0]).toEqual(independentSource);
    expect(result("spaces")?.textContent).toContain("本机保存已确认");
    expect(result("spaces")?.textContent).toContain("已关联 2 份资料");
    await act(async () => button("审核标签建议", modal("spaces")).click());
    expect(
      host.querySelector<HTMLOutputElement>('[aria-label="批量操作审核入口"]')?.dataset.spaceId,
    ).toBe("review-space");
    expect(data.sources[0]).toEqual(independentSource);
  });
});
