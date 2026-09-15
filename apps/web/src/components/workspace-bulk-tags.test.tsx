// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";
import type { WorkspaceData } from "@/lib/types";

let workspaceStore: Record<string, unknown>;
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/use-workspace", () => ({ useWorkspace: () => workspaceStore }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { signOut: vi.fn() } }) }));
vi.mock("@/lib/cloud", () => ({
  isCloudConfigured: () => true,
  subscribeSession: (listener: (user: null) => void) => {
    listener(null);
    return () => {};
  },
  previewAccountDeletion: vi.fn(),
  requestAccountDeletion: vi.fn(),
}));
vi.mock("@/lib/knowledge-update-review-drafts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/knowledge-update-review-drafts")>()),
  loadKnowledgeUpdateReviewDrafts: vi.fn(async (accountId: string) => ({
    accountId,
    epoch: 0,
    generation: "workspace-bulk-tags-isolated",
    drafts: [],
  })),
  clearAccountKnowledgeUpdateReviewDrafts: vi.fn(async () => {}),
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

describe("Workspace batch tag writes and guarded per-item results", () => {
  let host: HTMLDivElement, root: Root, data: WorkspaceData, persisted: WorkspaceData;
  let beforeReduce: ReturnType<typeof deferred> | undefined,
    ack: ReturnType<typeof deferred> | undefined,
    saveError: Error | undefined;
  let submissions: { current: WorkspaceData; next: WorkspaceData }[];
  let durable: ReturnType<
    typeof vi.fn<(updater: (current: WorkspaceData) => WorkspaceData) => Promise<boolean>>
  >;
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
    data.sources.forEach((source, i) => {
      source.title = `批量标签资料${i + 1}`;
      source.tags = [];
      source.spaceIds = [];
    });
    persisted = structuredClone(data);
    durable = vi.fn(async (updater) => {
      if (beforeReduce) await beforeReduce.promise;
      const current = data,
        next = updater(current);
      submissions.push({ current, next });
      if (next === current) return false; // Match the real coordinator's no-op admission rule.
      data = next;
      workspaceStore = { ...workspaceStore, data };
      if (ack) await ack.promise;
      if (saveError) throw saveError;
      persisted = structuredClone(next);
      return true;
    });
    workspaceStore = {
      token: 1,
      data,
      update: vi.fn((updater: (current: WorkspaceData) => WorkspaceData) => {
        data = updater(data);
        workspaceStore = { ...workspaceStore, data };
        return true;
      }),
      updateDurably: durable,
      ready: true,
      status: "cloud",
      localCacheMode: "normal",
      user: { id: "account-a", email: "learner@example.test" },
      anonymousMigration: { kind: "none", canMigrate: false },
      signOut: vi.fn(),
      signOutState: { kind: "ready", canSync: false, canKeepLocalDraft: false },
      ask: vi.fn(),
      cancelImport: vi.fn(),
      checkOrganization: vi.fn(),
      discardAccount: vi.fn(),
      error: "",
      importFile: vi.fn(),
      noteSyncPlan: undefined,
      organizationStatus: undefined,
      organize: vi.fn(),
      previewSourcePurge: vi.fn(),
      purgeSource: vi.fn(),
      purging: false,
      recovery: undefined,
      recoveryRevision: undefined,
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
    await render();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
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
  async function select(index: number) {
    const checkbox = host.querySelector<HTMLInputElement>(
      `input[aria-label="选择 ${data.sources[index].title}"]`,
    );
    expect(checkbox).not.toBeNull();
    await act(async () => checkbox!.click());
  }
  async function open() {
    await select(0);
    await select(1);
    await act(async () => button("添加标签").click());
    expect(panel()).not.toBeNull();
  }
  function panel() {
    return host.querySelector<HTMLElement>(".bulk-source-tags-panel");
  }
  function modal() {
    const node = host.querySelector<HTMLDialogElement>("dialog:has(.bulk-source-tags-panel)");
    expect(node).not.toBeNull();
    return node!;
  }
  function fill(tags: string) {
    const input = panel()?.querySelector<HTMLInputElement>('input[name="tags"]');
    expect(input).not.toBeNull();
    input!.value = tags;
  }
  function submit() {
    const form = panel()?.querySelector("form");
    expect(form).not.toBeNull();
    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }
  function result() {
    return host.querySelector('[aria-label="批量标签结果"]');
  }
  async function close() {
    const closeButton = modal().querySelector<HTMLButtonElement>('button[aria-label="关闭"]');
    expect(closeButton).not.toBeNull();
    await act(async () => closeButton!.click());
    expect(panel()).toBeNull();
  }

  it("retains the dialog until a real local snapshot acknowledgement, suppressing duplicate submission and early success", async () => {
    ack = deferred();
    await open();
    expect(panel()?.textContent).toContain("选中 2 份资料");
    fill("复习");
    await act(async () => {
      submit();
      submit();
    });
    expect(durable).toHaveBeenCalledTimes(1);
    expect(result()).toBeNull();
    expect(panel()).not.toBeNull();
    expect(panel()?.textContent).toContain("正在保存到本机");
    expect(persisted.sources.every((source) => source.tags.length === 0)).toBe(true);
    await act(async () => ack!.resolve());
    expect(result()?.textContent).toContain("已修改 2");
    expect(result()?.textContent).toContain("本机保存已确认");
    expect(panel()).not.toBeNull();
    expect(persisted.sources.every((source) => source.tags.includes("复习"))).toBe(true);
  });
  it("preserves every partial/no-op row and retries only the failed ID against the current workspace", async () => {
    data.sources[0].tags = ["復习"];
    data.sources[1].tags = Array.from({ length: 100 }, (_, i) => `旧-${i}`);
    await render();
    await open();
    fill("復习");
    await act(async () => submit());
    expect(result()?.textContent).toContain("无需修改 1");
    expect(result()?.textContent).toContain("失败 1");
    expect(result()?.querySelectorAll(".bulk-source-tags-item")).toHaveLength(2);
    expect(submissions[0].next).not.toBe(submissions[0].current);
    data = {
      ...data,
      sources: [
        { ...data.sources[0], tags: ["后来独立编辑"], tagsRevision: 9 },
        { ...data.sources[1], tags: [], tagsRevision: 4 },
      ],
    };
    await render();
    expect(durable).toHaveBeenCalledTimes(1);
    await act(async () => button("仅重试失败 1 份", panel()!).click());
    expect(durable).toHaveBeenCalledTimes(2);
    expect(data.sources[0]).toMatchObject({ tags: ["后来独立编辑"], tagsRevision: 9 });
    expect(persisted.sources[1]).toMatchObject({ tags: ["復习"], tagsRevision: 5 });
    expect(result()?.textContent).toContain("失败 0");
    expect(result()?.textContent).toContain("无需修改 1");
  });
  it.each(["noop", "failed"])(
    "requires actual durable snapshot persistence even for an all-%s result",
    async (kind) => {
      data.sources.forEach(
        (source) =>
          (source.tags =
            kind === "noop" ? ["复习"] : Array.from({ length: 100 }, (_, i) => `旧-${i}`)),
      );
      await render();
      ack = deferred();
      await open();
      fill("复习");
      await act(async () => submit());
      expect(submissions).toHaveLength(1);
      expect(submissions[0].next).not.toBe(submissions[0].current);
      expect(result()).toBeNull();
      await act(async () => ack!.resolve());
      expect(result()?.textContent).toContain("本机保存已确认");
      expect(result()?.textContent).toContain(kind === "noop" ? "无需修改 2" : "失败 2");
    },
  );
  it("keeps the input after disk failure and really saves the now-noop in-memory snapshot on an explicit retry", async () => {
    saveError = new Error("磁盘写入失败");
    await open();
    fill("复习");
    await act(async () => submit());
    expect(data.sources.every((source) => source.tags.includes("复习"))).toBe(true);
    expect(persisted.sources.every((source) => !source.tags.includes("复习"))).toBe(true);
    expect(result()).toBeNull();
    expect(panel()?.textContent).toContain("尚未确认本机保存");
    expect(panel()?.querySelector<HTMLInputElement>('input[name="tags"]')?.value).toBe("复习");
    saveError = undefined;
    await render();
    await act(async () => submit());
    expect(durable).toHaveBeenCalledTimes(2);
    expect(submissions[1].next).not.toBe(submissions[1].current);
    expect(persisted.sources.every((source) => source.tags.includes("复习"))).toBe(true);
    expect(result()?.textContent).toContain("无需修改 2");
    expect(data.sources.every((source) => source.tagsRevision === 1)).toBe(true);
  });
  it("blocks a delayed reducer after dismiss and reopen, leaving the new review blank", async () => {
    beforeReduce = deferred();
    await open();
    fill("旧弹窗标签");
    await act(async () => submit());
    await close();
    await open();
    expect(panel()?.querySelector<HTMLInputElement>('input[name="tags"]')?.value).toBe("");
    await act(async () => beforeReduce!.resolve());
    expect(submissions).toHaveLength(0);
    expect(result()).toBeNull();
    expect(panel()?.textContent).not.toContain("旧弹窗标签");
    expect(data.sources.every((source) => source.tags.length === 0)).toBe(true);
  });
  it("does not publish a valid already-started old write acknowledgement into a reopened dialog", async () => {
    ack = deferred();
    await open();
    fill("已进入旧保存队列");
    await act(async () => submit());
    expect(submissions).toHaveLength(1);
    await close();
    await open();
    await act(async () => ack!.resolve());
    expect(result()).toBeNull();
    expect(panel()?.querySelector<HTMLInputElement>('input[name="tags"]')?.value).toBe("");
    expect(data.sources.every((source) => source.tags.includes("已进入旧保存队列"))).toBe(true);
    expect(persisted.sources.every((source) => source.tags.includes("已进入旧保存队列"))).toBe(
      true,
    );
  });
  it.each(["account", "token", "cache"])(
    "rejects a delayed reducer across a %s A→B→A context even if final field values match",
    async (kind) => {
      beforeReduce = deferred();
      await open();
      fill("不可跨上下文标签");
      await act(async () => submit());
      const first =
        kind === "account"
          ? { user: { id: "account-b", email: "b@example.test" } }
          : kind === "token"
            ? { token: 2 }
            : { localCacheMode: "memory-only" };
      const second =
        kind === "account"
          ? { user: { id: "account-a", email: "learner@example.test" } }
          : kind === "token"
            ? { token: 1 }
            : { localCacheMode: "normal" };
      await render(first);
      await render(second);
      await act(async () => beforeReduce!.resolve());
      expect(submissions).toHaveLength(0);
      expect(result()).toBeNull();
      expect(data.sources.every((source) => source.tags.length === 0)).toBe(true);
      expect(host.textContent).not.toContain("不可跨上下文标签");
    },
  );
  it("does not apply an old reducer after the selection changes away and back", async () => {
    beforeReduce = deferred();
    await open();
    fill("旧选择标签");
    await act(async () => submit());
    await select(1);
    await select(1);
    await act(async () => beforeReduce!.resolve());
    expect(submissions).toHaveLength(0);
    expect(result()).toBeNull();
    expect(data.sources.every((source) => source.tags.length === 0)).toBe(true);
  });
  it("does not publish an old successful acknowledgement into the active other account", async () => {
    ack = deferred();
    await open();
    fill("仅属于账号A");
    await act(async () => submit());
    const aSnapshot = structuredClone(data);
    data = {
      ...createDemoWorkspace(),
      sources: data.sources.map((source) => ({ ...source, tags: [], title: source.title })),
    };
    await render({ token: 2, user: { id: "account-b", email: "b@example.test" } });
    await act(async () => ack!.resolve());
    expect(result()).toBeNull();
    expect(data.sources.every((source) => source.tags.length === 0)).toBe(true);
    expect(host.textContent).not.toContain("仅属于账号A");
    expect(persisted).toEqual(aSnapshot);
  });
  it("keeps a rejected old write quiet after switching to another account", async () => {
    ack = deferred();
    await open();
    fill("账号A旧失败标签");
    await act(async () => submit());
    data = { ...data, sources: data.sources.map((source) => ({ ...source, tags: [] })) };
    await render({ token: 2, user: { id: "account-b", email: "b@example.test" } });
    await act(async () => ack!.reject(new Error("账号A旧磁盘错误")));
    expect(result()).toBeNull();
    expect(host.textContent).not.toContain("账号A旧磁盘错误");
    expect(data.sources.every((source) => source.tags.length === 0)).toBe(true);
  });
  it("clears the explicit selection only after the user finishes viewing the acknowledged result", async () => {
    await open();
    fill("复习");
    await act(async () => submit());
    expect(result()).not.toBeNull();
    expect(host.textContent).toContain("已选 2 份");
    await act(async () => button("完成", panel()!).click());
    expect(panel()).toBeNull();
    expect(host.textContent).not.toContain("已选 2 份");
    await open();
    expect(panel()?.querySelector<HTMLInputElement>('input[name="tags"]')?.value).toBe("");
    expect(result()).toBeNull();
  });
});
