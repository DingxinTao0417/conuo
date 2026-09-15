// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoWorkspace } from "@/lib/seed";

let workspaceStore: Record<string, unknown>;

vi.mock("next/dynamic", () => ({
  default: (() => {
    let dynamicComponentIndex = 0;
    return () => {
      dynamicComponentIndex += 1;
      // Reader is the sixth dynamic component declared by Workspace.
      if (dynamicComponentIndex === 6) {
        return function ReaderProbe(props: {
          source: { id: string; versionId: string };
          backLabel?: string;
          onBack: () => void;
        }) {
          return createElement(
            "section",
            {
              "aria-label": "阅读器探针",
              "data-source-id": props.source.id,
              "data-version-id": props.source.versionId,
            },
            createElement(
              "button",
              {
                type: "button",
                "aria-label": props.backLabel || "返回资料库",
                onClick: props.onBack,
              },
              props.backLabel || "返回资料库",
            ),
          );
        };
      }
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
  subscribeSession: (listener: (user: null) => void) => {
    listener(null);
    return () => {};
  },
  previewAccountDeletion: vi.fn(),
  requestAccountDeletion: vi.fn(),
}));
vi.mock("./collection-library", () => ({
  default: () => null,
  CollectionActions: () => null,
}));
vi.mock("./model-status", () => ({ default: () => null }));
vi.mock("./workspace-search", () => ({ default: () => null }));
vi.mock("./indexing-panel", () => ({ default: () => null }));
vi.mock("./web-import-form", () => ({ default: () => null }));

import Workspace from "./workspace";

describe("Workspace space tabs", () => {
  let host: HTMLDivElement;
  let root: Root;
  let spaceId: string;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: vi.fn(),
    });

    const data = createDemoWorkspace();
    const now = "2026-09-13T12:00:00.000Z";
    spaceId = data.spaces[0]!.id;
    data.notes.push({
      id: "knowledge-page",
      spaceId,
      title: "梯度下降知识页",
      content: "<p>知识页正文</p>",
      kind: "knowledge",
      status: "accepted",
      citations: [],
      versions: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    data.notes.push({
      id: "knowledge-draft",
      spaceId,
      title: "学习率待审核知识页",
      content: "<p>学习率过高时，训练损失可能振荡。</p>",
      kind: "knowledge",
      aiGenerated: true,
      status: "draft",
      citations: [],
      versions: [],
      createdAt: now,
      updatedAt: "2026-09-14T12:00:00.000Z",
      deletedAt: null,
    });
    data.conversations.push({
      id: "space-question",
      spaceId,
      title: "为什么学习率过高会振荡？",
      scope: "space",
      sourceIds: data.sources.map((source) => source.id),
      messages: [],
      resolved: false,
      updatedAt: now,
    });
    workspaceStore = {
      token: 1,
      data,
      update: vi.fn(),
      ready: true,
      status: "local",
      localCacheMode: "normal",
      user: undefined,
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
    window.history.replaceState(null, "", `#library/${spaceId}`);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(Workspace)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function tab(label: string) {
    const navigation = host.querySelector<HTMLElement>(`[aria-label$="的空间导航"]`);
    expect(navigation).toBeInstanceOf(HTMLElement);
    const button = [...navigation!.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === label,
    );
    expect(button, `space tab ${label}`).toBeInstanceOf(HTMLButtonElement);
    return button as HTMLButtonElement;
  }

  function buttonByText(label: string) {
    const button = [...host.querySelectorAll("button")].find(
      (item) => item.textContent?.replace(/\s+/g, "").trim() === label.replace(/\s+/g, ""),
    );
    expect(button, `button ${label}`).toBeInstanceOf(HTMLButtonElement);
    return button as HTMLButtonElement;
  }

  it("keeps Overview, Materials, Knowledge, and Questions in the current learning space", async () => {
    expect(host.textContent).toContain("库内资料");
    expect(tab("资料").getAttribute("aria-current")).toBe("page");

    await act(async () => tab("知识").click());
    expect(window.location.hash).toBe(`#knowledge?space=${spaceId}`);
    expect(host.textContent).toContain("梯度下降知识页");
    expect(tab("知识").getAttribute("aria-current")).toBe("page");

    await act(async () => tab("问答").click());
    expect(window.location.hash).toBe(`#questions?space=${spaceId}&status=all`);
    expect(host.textContent).toContain("为什么学习率过高会振荡？");

    await act(async () => tab("概览").click());
    expect(window.location.hash).toBe(`#home?space=${spaceId}`);
    expect(host.textContent).toContain("继续学习");
  });

  it("restores the knowledge search and review filter after opening a page", async () => {
    await act(async () => {
      window.history.replaceState(
        null,
        "",
        `#knowledge?space=${spaceId}&q=%E5%AD%A6%E4%B9%A0%E7%8E%87&status=pending`,
      );
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    const search = host.querySelector<HTMLInputElement>('[aria-label="搜索知识页"]');
    const pending = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.replace(/\s+/g, "") === "待审核1",
    );
    expect(search?.value).toBe("学习率");
    expect(pending?.getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toContain("学习率待审核知识页");
    expect(host.textContent).toContain("AI 草稿");
    expect(host.textContent).toContain("尚未关联资料");
    expect(host.textContent).not.toContain("自由笔记");

    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[aria-label^="打开知识页 学习率待审核知识页"]')!
        .click(),
    );
    expect(window.location.hash).toBe("#note/knowledge-draft");

    await act(async () => buttonByText("返回").click());
    expect(window.location.hash).toBe(
      `#knowledge?space=${spaceId}&q=%E5%AD%A6%E4%B9%A0%E7%8E%87&status=pending`,
    );
    expect(host.querySelector<HTMLInputElement>('[aria-label="搜索知识页"]')?.value).toBe("学习率");
  });

  it("separates knowledge review state from the visible autosave destination", async () => {
    await act(async () => {
      window.history.replaceState(null, "", "#note/knowledge-page");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    const toolbarBadge = host.querySelector(".content-toolbar .badge");
    const autosave = host.querySelector(".note-save-status");
    expect(toolbarBadge?.textContent?.trim()).toBe("已接受");
    expect(autosave?.getAttribute("role")).toBe("status");
    expect(autosave?.getAttribute("aria-live")).toBe("polite");
    expect(autosave?.textContent?.replace(/\s+/g, "").trim()).toBe("自动保存：已保存在此浏览器");
  });

  it("does not show space navigation for all libraries, inbox, or the reader", async () => {
    const navigate = async (hash: string) => {
      await act(async () => {
        window.history.replaceState(null, "", hash);
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
    };

    await navigate("#library");
    expect(host.querySelector('[aria-label$="的空间导航"]')).toBeNull();

    await navigate("#library/inbox");
    expect(host.querySelector('[aria-label$="的空间导航"]')).toBeNull();

    await navigate(
      `#source/${(workspaceStore.data as ReturnType<typeof createDemoWorkspace>).sources[0]!.id}`,
    );
    expect(host.querySelector('[aria-label$="的空间导航"]')).toBeNull();
  });

  it("opens the exact recognized source version and returns to the same recognized-content task", async () => {
    const source = (workspaceStore.data as ReturnType<typeof createDemoWorkspace>).sources.find(
      (item) => item.spaceIds.includes(spaceId),
    )!;
    const manage = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === `管理 ${source.title}`,
    );
    expect(manage).toBeInstanceOf(HTMLButtonElement);

    await act(async () => manage!.click());
    await act(async () => buttonByText("查看已识别内容").click());

    expect(host.textContent).toContain("资料可用范围");
    expect(host.textContent).toContain("原文已识别");
    expect(host.textContent).toContain("已识别内容");
    expect(host.textContent).toContain(source.chunks[0]!.section);
    expect(host.textContent).not.toContain(source.chunks[0]!.id);

    const chunkButton = [
      ...host.querySelectorAll<HTMLButtonElement>(".recognized-content-chunk"),
    ].find((button) => button.textContent?.includes(source.chunks[0]!.section));
    expect(chunkButton).toBeInstanceOf(HTMLButtonElement);
    await act(async () => chunkButton!.click());

    expect(window.location.hash).toBe(`#source/${source.id}/version/${source.versionId}`);
    expect(host.querySelector('[aria-label="阅读器探针"]')).toBeInstanceOf(HTMLElement);
    expect(host.querySelector('[aria-label="返回已识别内容"]')).toBeInstanceOf(HTMLButtonElement);

    const popstate = new Promise<void>((resolve) =>
      window.addEventListener("popstate", () => resolve(), { once: true }),
    );
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="返回已识别内容"]')!.click();
      await popstate;
    });

    expect(window.location.hash).toBe(`#library/${spaceId}`);
    expect(host.querySelector('[aria-label="阅读器探针"]')).toBeNull();
    expect(host.textContent).toContain("资料可用范围");
    expect(host.textContent).toContain("已识别内容");
    expect(host.textContent).toContain(source.chunks[0]!.section);
  });

  it("restores the recognized-content task when the browser Back action is used", async () => {
    const source = (workspaceStore.data as ReturnType<typeof createDemoWorkspace>).sources.find(
      (item) => item.spaceIds.includes(spaceId),
    )!;
    const manage = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === `管理 ${source.title}`,
    )!;

    await act(async () => manage.click());
    await act(async () => buttonByText("查看已识别内容").click());
    await act(async () =>
      host.querySelector<HTMLButtonElement>(".recognized-content-chunk")!.click(),
    );

    const popstate = new Promise<void>((resolve) =>
      window.addEventListener("popstate", () => resolve(), { once: true }),
    );
    await act(async () => {
      window.history.back();
      await popstate;
    });

    expect(window.location.hash).toBe(`#library/${spaceId}`);
    expect(host.querySelector('[aria-label="阅读器探针"]')).toBeNull();
    expect(host.textContent).toContain("资料可用范围");
    expect(host.textContent).toContain(source.chunks[0]!.section);
  });

  it("does not reopen recognized content after the source version changes", async () => {
    const source = (workspaceStore.data as ReturnType<typeof createDemoWorkspace>).sources.find(
      (item) => item.spaceIds.includes(spaceId),
    )!;
    const originalVersionId = source.versionId;
    const manage = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === `管理 ${source.title}`,
    )!;

    await act(async () => manage.click());
    await act(async () => buttonByText("查看已识别内容").click());
    await act(async () =>
      host.querySelector<HTMLButtonElement>(".recognized-content-chunk")!.click(),
    );
    expect(window.location.hash).toBe(`#source/${source.id}/version/${originalVersionId}`);

    // Simulate a same-account update arriving after the reader opened but
    // before its return handler runs. The handler must re-read the live object.
    source.versionId = "replacement-version";
    const popstate = new Promise<void>((resolve) =>
      window.addEventListener("popstate", () => resolve(), { once: true }),
    );
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="返回已识别内容"]')!.click();
      await popstate;
    });

    expect(window.location.hash).toBe(`#library/${spaceId}`);
    expect(host.textContent).toContain("这份资料已有新版本");
    expect(host.textContent).toContain("资料详情");
    expect(host.textContent).not.toContain("资料可用范围");
  });

  it("returns safely to the library when the recognized source is no longer available", async () => {
    const data = workspaceStore.data as ReturnType<typeof createDemoWorkspace>;
    const source = data.sources.find((item) => item.spaceIds.includes(spaceId))!;
    const manage = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === `管理 ${source.title}`,
    )!;

    await act(async () => manage.click());
    await act(async () => buttonByText("查看已识别内容").click());
    await act(async () =>
      host.querySelector<HTMLButtonElement>(".recognized-content-chunk")!.click(),
    );
    expect(window.location.hash).toBe(`#source/${source.id}/version/${source.versionId}`);
    expect(host.querySelector('[aria-label="阅读器探针"]')).toBeInstanceOf(HTMLElement);

    const nextData = {
      ...data,
      sources: data.sources.filter((item) => item.id !== source.id),
    };
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");
    const back = vi.spyOn(window.history, "back");
    workspaceStore = { ...workspaceStore, data: nextData };
    await act(async () => {
      root.render(createElement(Workspace));
    });

    expect(window.location.hash).toBe(`#library/${spaceId}`);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith(null, "", `#library/${spaceId}`);
    expect(pushState).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
    expect(host.textContent).toContain("这份资料已删除或不可用");
    expect(host.querySelector('[aria-label="阅读器探针"]')).toBeNull();
    expect(host.textContent).not.toContain("资料可用范围");

    await act(async () => root.render(createElement(Workspace)));
    expect(window.location.hash).toBe(`#library/${spaceId}`);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain("资料可用范围");
  });

  it("replaces an unavailable source deep link with a clean library route", async () => {
    await act(async () => root.unmount());
    window.history.replaceState(null, "", "#source/source-that-is-not-in-this-workspace");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");
    const back = vi.spyOn(window.history, "back");
    root = createRoot(host);
    await act(async () => root.render(createElement(Workspace)));

    expect(window.location.hash).toBe("#library");
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith(null, "", "#library");
    expect(pushState).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
    expect(host.textContent).toContain("这份资料已删除、不存在或当前账号无权访问");
    expect(host.querySelector('[aria-label="阅读器探针"]')).toBeNull();

    await act(async () => root.render(createElement(Workspace)));
    expect(window.location.hash).toBe("#library");
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it("preserves the current knowledge library when an ordinary reader source disappears", async () => {
    const data = workspaceStore.data as ReturnType<typeof createDemoWorkspace>;
    const source = data.sources.find((item) => item.spaceIds.includes(spaceId))!;
    const openSource = [...host.querySelectorAll<HTMLButtonElement>(".source-open")].find(
      (button) => button.textContent?.includes(source.title),
    );
    expect(openSource).toBeInstanceOf(HTMLButtonElement);

    await act(async () => openSource!.click());
    expect(window.location.hash).toBe(`#source/${source.id}`);
    expect(host.querySelector('[aria-label="阅读器探针"]')).toBeInstanceOf(HTMLElement);

    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");
    const back = vi.spyOn(window.history, "back");
    workspaceStore = {
      ...workspaceStore,
      data: {
        ...data,
        sources: data.sources.filter((item) => item.id !== source.id),
      },
    };
    await act(async () => root.render(createElement(Workspace)));

    expect(window.location.hash).toBe(`#library/${spaceId}`);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith(null, "", `#library/${spaceId}`);
    expect(pushState).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
    expect(host.textContent).toContain("这份资料已删除、不存在或当前账号无权访问");
    expect(host.querySelector('[aria-label="阅读器探针"]')).toBeNull();
  });

  it("shows complete source metadata without conflating AI consent and readiness", async () => {
    const data = workspaceStore.data as ReturnType<typeof createDemoWorkspace>;
    const source = data.sources.find((item) => item.spaceIds.includes(spaceId))!;
    source.kind = "pdf";
    source.pageCount = 12;
    source.readPage = 4;
    source.lastReadAt = "2026-09-13T12:00:00.000Z";
    source.createdAt = "2026-09-12T10:30:00.000Z";
    source.status = "ready";
    source.aiAllowed = true;
    workspaceStore = { ...workspaceStore, data };
    await act(async () => root.render(createElement(Workspace)));

    const manage = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === `管理 ${source.title}`,
    );
    await act(async () => manage!.click());

    const metadata = host.querySelector<HTMLElement>('[aria-label="资料元数据"]');
    expect(metadata).toBeInstanceOf(HTMLElement);
    expect(metadata!.textContent).toContain("资料类型PDF");
    expect(metadata!.textContent).toContain("导入来源本机文件上传");
    expect(metadata!.textContent).toContain("导入时间");
    expect(metadata!.textContent).toContain("2026");
    expect(metadata!.textContent).toContain("阅读状态上次读到第 4 / 12 页");
    expect(metadata!.textContent).toContain("AI 状态已允许，可用于问答与整理");
    expect(host.textContent).toContain("资料名称由你维护，AI 整理不会自动改名");
  });

  it("keeps partial parsing and an AI opt-out separate from usable original text", async () => {
    const data = workspaceStore.data as ReturnType<typeof createDemoWorkspace>;
    const source = data.sources.find((item) => item.spaceIds.includes(spaceId))!;
    source.status = "partial";
    source.aiAllowed = false;
    source.coverage = {
      captureScope: "full",
      parseState: "partial",
      unavailablePageRanges: [{ start: 2, end: 3 }],
    };
    workspaceStore = { ...workspaceStore, data };
    await act(async () => root.render(createElement(Workspace)));

    const manage = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === `管理 ${source.title}`,
    );
    expect(manage).toBeInstanceOf(HTMLButtonElement);
    await act(async () => manage!.click());
    await act(async () => buttonByText("查看已识别内容").click());

    expect(host.textContent).toContain("部分原文已识别");
    expect(host.textContent).toContain("AI 使用已关闭");
    expect(host.textContent).toContain("原文件第 2–3 页未能解析");
    expect(host.textContent).toContain("当前显示");

    source.status = "failed";
    source.aiAllowed = true;
    source.text = "";
    source.chunks = [];
    source.coverage = { captureScope: "full", parseState: "failed" };
    workspaceStore = { ...workspaceStore, data };
    await act(async () => root.render(createElement(Workspace)));
    expect(host.textContent).toContain("未提取到可检索正文");
    expect(host.textContent).toContain("当前没有可定位的已识别原文");

    source.kind = "web";
    source.status = "link-only";
    source.coverage = { captureScope: "link", parseState: "not-requested" };
    workspaceStore = { ...workspaceStore, data };
    await act(async () => root.render(createElement(Workspace)));
    expect(host.textContent).toContain("仅保存了链接");
    expect(host.textContent).toContain("没有保存可检索正文");
  });

  it("asks for an explicit anonymous-workspace migration choice after login", async () => {
    const migrateAnonymousWorkspace = vi.fn(async () => {});
    const skipAnonymousWorkspaceMigration = vi.fn(async () => {});
    workspaceStore = {
      ...workspaceStore,
      user: { id: "owner-a", email: "reader@example.test" },
      anonymousMigration: {
        kind: "pending",
        canMigrate: true,
        message: "当前账号还没有资料，可以安全复制本机副本。",
        sourceCount: 2,
        noteCount: 1,
      },
      error: "迁移前检查未完成。",
      migrateAnonymousWorkspace,
      skipAnonymousWorkspaceMigration,
    };

    await act(async () => root.render(createElement(Workspace)));

    expect(host.textContent).toContain("发现此浏览器中的本机资料");
    expect(host.textContent).toContain("2 份资料、1 篇笔记");
    expect(host.querySelector('[aria-label="本机资料迁移"]')?.getAttribute("role")).toBe("status");
    expect(
      [...host.querySelectorAll("button")].some(
        (button) => button.textContent?.replace(/\s+/g, "").trim() === "重新连接",
      ),
    ).toBe(false);

    await act(async () => buttonByText("迁移到当前账号").click());
    expect(migrateAnonymousWorkspace).toHaveBeenCalledTimes(1);

    await act(async () => buttonByText("暂不迁移").click());
    expect(skipAnonymousWorkspaceMigration).toHaveBeenCalledTimes(1);
  });

  it("keeps divergent-copy guidance compact until the learner asks for the recovery steps", async () => {
    workspaceStore = {
      ...workspaceStore,
      user: { id: "owner-a", email: "reader@example.test" },
      anonymousMigration: {
        kind: "requires-export",
        canMigrate: false,
        message: "当前账号已有资料，匿名资料不会自动覆盖。",
        sourceCount: 2,
        noteCount: 1,
      },
    };

    await act(async () => root.render(createElement(Workspace)));

    expect(host.textContent).toContain("资料副本存在差异");
    expect(host.textContent).toContain("2 份资料 · 1 篇笔记");
    const details = host.querySelector<HTMLElement>("#anonymous-workspace-migration-details");
    const toggle = buttonByText("查看处理方法");
    expect(details?.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(host.textContent).not.toContain("匿名资料尚未迁移");

    await act(async () => toggle.click());

    expect(details?.hidden).toBe(false);
    expect(host.textContent).toContain("系统没有自动合并");
    expect(buttonByText("收起").getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps divergent-copy guidance compact in the reader until recovery steps are opened", async () => {
    const source = (workspaceStore.data as ReturnType<typeof createDemoWorkspace>).sources[0]!;
    workspaceStore = {
      ...workspaceStore,
      user: { id: "owner-a", email: "reader@example.test" },
      anonymousMigration: {
        kind: "requires-export",
        canMigrate: false,
        message: "当前账号已有资料，匿名资料不会自动覆盖。",
        sourceCount: 2,
        noteCount: 1,
      },
    };

    await act(async () => root.render(createElement(Workspace)));
    await act(async () => {
      window.history.replaceState(null, "", `#source/${source.id}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    const notice = host.querySelector<HTMLElement>('[aria-label="本机资料迁移"]');
    const details = host.querySelector<HTMLElement>("#anonymous-workspace-migration-details");
    expect(notice?.classList.contains("is-compact")).toBe(true);
    expect(details?.hidden).toBe(true);
    expect(buttonByText("查看处理方法").getAttribute("aria-expanded")).toBe("false");

    await act(async () => buttonByText("查看处理方法").click());

    expect(notice?.classList.contains("is-compact")).toBe(false);
    expect(details?.hidden).toBe(false);
    expect(host.textContent).toContain("系统没有自动合并");
  });

  it("does not compact an in-progress migration decision in the reader", async () => {
    const source = (workspaceStore.data as ReturnType<typeof createDemoWorkspace>).sources[0]!;
    workspaceStore = {
      ...workspaceStore,
      user: { id: "owner-a", email: "reader@example.test" },
      anonymousMigration: {
        kind: "pending",
        canMigrate: true,
        message: "当前账号还没有资料，可以安全复制本机副本。",
        sourceCount: 2,
        noteCount: 1,
      },
    };

    await act(async () => root.render(createElement(Workspace)));
    await act(async () => {
      window.history.replaceState(null, "", `#source/${source.id}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    const notice = host.querySelector<HTMLElement>('[aria-label="本机资料迁移"]');
    const details = host.querySelector<HTMLElement>("#anonymous-workspace-migration-details");
    expect(notice?.classList.contains("is-compact")).toBe(false);
    expect(details?.hidden).toBe(false);
    expect(buttonByText("迁移到当前账号")).toBeInstanceOf(HTMLButtonElement);
    expect(buttonByText("暂不迁移")).toBeInstanceOf(HTMLButtonElement);
  });

  it("explains that confirmed cloud data is read-only when the account cache cannot open", async () => {
    const retry = vi.fn();
    workspaceStore = {
      ...workspaceStore,
      user: { id: "owner-a", email: "reader@example.test" },
      localCacheMode: "cloud-readonly",
      status: "error",
      error: "此浏览器中的账号资料暂时无法读取。",
      retry,
    };

    await act(async () => root.render(createElement(Workspace)));

    expect(host.querySelector('[aria-label="云端资料只读恢复"]')?.getAttribute("role")).toBe(
      "status",
    );
    expect(host.textContent).toContain("正在以只读方式查看云端资料");
    expect(host.textContent).toContain("编辑、导入、问答与整理会在重新连接成功后恢复");
    expect(host.querySelector(".save-status")?.textContent).toContain("仅可查看云端资料");

    await act(async () => buttonByText("重新连接").click());
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
