// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  configured: vi.fn(),
  subscribe: vi.fn(),
  preview: vi.fn(),
  request: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/lib/cloud", () => ({
  isCloudConfigured: mock.configured,
  subscribeSession: mock.subscribe,
  previewAccountDeletion: mock.preview,
  requestAccountDeletion: mock.request,
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signOut: mock.signOut } }),
}));

import AccountPanel, { type AccountSignOutControl } from "./account-panel";

const user = { id: "owner-a", email: "reader@example.test" };
const preview = {
  state: null,
  allowed: true,
  sources: 2,
  versions: 3,
  notes: 4,
  conversations: 5,
  annotations: 6,
  spaces: 1,
  currentStorageObjects: 2,
  pendingSourcePurgeObjects: 1,
  totalStorageObjects: 3,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("AccountPanel account deletion", () => {
  let host: HTMLDivElement;
  let root: Root;
  let listener!: (value: typeof user | null) => void;
  let identityHint!: (accountId: string | null) => void;
  let onSessionChange: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;
  let onAccountDeletion: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    mock.configured.mockReturnValue(true);
    mock.subscribe.mockImplementation(
      (next: (value: typeof user | null) => void, hint: typeof identityHint) => {
        listener = next;
        identityHint = hint;
        next(user);
        return vi.fn();
      },
    );
    mock.preview.mockResolvedValue(preview);
    mock.request.mockResolvedValue({
      deletionId: "11111111-1111-4111-8111-111111111111",
      state: "storage_pending",
      storageObjects: 3,
      readyForAuthDeletion: false,
    });
    mock.signOut.mockResolvedValue({ error: null });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    onSessionChange = vi.fn();
    onClose = vi.fn();
    onAccountDeletion = vi.fn().mockResolvedValue(undefined);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  async function render(signOutControl?: AccountSignOutControl) {
    await act(async () => {
      root.render(
        createElement(AccountPanel, {
          onSessionChange: onSessionChange as (value: typeof user | null) => void,
          onClose: onClose as () => void,
          onAccountDeletion: onAccountDeletion as (accountId: string) => Promise<void>,
          signOutControl,
        }),
      );
    });
  }

  function exitControl(
    state: AccountSignOutControl["state"],
    actions: Partial<Omit<AccountSignOutControl, "state">> = {},
  ): AccountSignOutControl {
    return {
      state,
      signOut: vi.fn(async () => {}),
      syncAndSignOut: vi.fn(async () => {}),
      keepLocalDraftAndSignOut: vi.fn(async () => {}),
      ...actions,
    };
  }
  function button(label: string) {
    const found = [...host.querySelectorAll("button")].filter(
      (item) => item.textContent?.replace(/\s+/g, "") === label.replace(/\s+/g, ""),
    );
    expect(found, `button ${label}`).toHaveLength(1);
    return found[0]!;
  }
  async function click(label: string) {
    await act(async () => button(label).click());
  }
  async function input(selector: string, value: string) {
    const element = host.querySelector<HTMLInputElement>(selector)!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(element, value);
    await act(async () => element.dispatchEvent(new Event("input", { bubbles: true })));
  }

  async function confirmDeletion() {
    await render();
    await click("注销账号");
    await input('input[type="email"]', user.email);
    await input('input[type="password"]', "current-password");
    await input('input[type="text"]', "DELETE");
  }

  it("cleans the captured account after a late accepted request without signing out account B", async () => {
    const pending = deferred<unknown>();
    mock.request.mockReturnValue(pending.promise);
    await confirmDeletion();
    await click("确认注销账号");
    await act(async () => listener({ id: "owner-b", email: "second@example.test" }));
    await act(async () =>
      pending.resolve({ state: "storage_pending", readyForAuthDeletion: false }),
    );
    expect(onAccountDeletion).toHaveBeenCalledExactlyOnceWith(user.id);
    expect(mock.signOut).not.toHaveBeenCalled();
    expect(onSessionChange).toHaveBeenLastCalledWith({
      id: "owner-b",
      email: "second@example.test",
    });
    expect(host.textContent).toContain("second@example.test");
    expect(host.textContent).not.toContain("注销请求已提交");
  });

  it("still cleans accepted account A after unmount while a replacement panel belongs to B", async () => {
    const pending = deferred<unknown>();
    mock.request.mockReturnValue(pending.promise);
    await confirmDeletion();
    await click("确认注销账号");
    await act(async () => root.render(null));
    mock.subscribe.mockImplementation((next: (value: typeof user | null) => void) => {
      listener = next;
      next({ id: "owner-b", email: "second@example.test" });
      return vi.fn();
    });
    await render();
    await act(async () =>
      pending.resolve({ state: "storage_pending", readyForAuthDeletion: false }),
    );
    expect(onAccountDeletion).toHaveBeenCalledExactlyOnceWith(user.id);
    expect(mock.signOut).not.toHaveBeenCalled();
    expect(onSessionChange).toHaveBeenLastCalledWith({
      id: "owner-b",
      email: "second@example.test",
    });
    expect(host.textContent).toContain("second@example.test");
  });

  it("fences a confirmed pending preview even when the preview arrives after switching accounts", async () => {
    const pending = deferred<unknown>();
    mock.preview.mockReturnValue(pending.promise);
    await render();
    await click("注销账号");
    await act(async () => listener({ id: "owner-b", email: "second@example.test" }));
    await act(async () =>
      pending.resolve({ ...preview, state: "storage_processing", allowed: false }),
    );
    expect(onAccountDeletion).toHaveBeenCalledExactlyOnceWith(user.id);
    expect(mock.signOut).not.toHaveBeenCalled();
    expect(host.textContent).toContain("second@example.test");
    expect(host.textContent).not.toContain("注销正在处理中");
  });

  it("stops local access for an exact authenticated pending error without destructive resubmission", async () => {
    mock.preview.mockRejectedValue({ status: 423, code: "ACCOUNT_DELETION_PENDING" });
    await render();
    await click("注销账号");
    expect(onAccountDeletion).toHaveBeenCalledExactlyOnceWith(user.id);
    expect(mock.request).not.toHaveBeenCalled();
    expect(mock.signOut).not.toHaveBeenCalled();
    expect(host.textContent).toContain("账号注销正在处理中");
  });

  it.each([
    { status: 401, code: "ACCOUNT_DELETION_PENDING" },
    { status: 423, code: "UNKNOWN_STATE" },
    new Error("network unavailable"),
  ])("does not infer deletion from an unconfirmed preview failure %j", async (failure) => {
    mock.preview.mockRejectedValue(failure);
    await render();
    await click("注销账号");
    expect(onAccountDeletion).not.toHaveBeenCalled();
    expect(mock.signOut).not.toHaveBeenCalled();
  });

  it("submits only once when two confirmations occur in the same React event batch", async () => {
    const pending = deferred<unknown>();
    mock.request.mockReturnValue(pending.promise);
    await confirmDeletion();
    await act(() => {
      const submit = button("确认注销账号");
      submit.click();
      submit.click();
    });
    expect(mock.request).toHaveBeenCalledTimes(1);
    await act(async () => pending.reject({ code: "ACCOUNT_DELETION_CONFIRMATION_FAILED" }));
    expect(onAccountDeletion).not.toHaveBeenCalled();
  });

  it("does not publish a late cleanup failure or local Auth exit into switched account B", async () => {
    const pending = deferred<void>();
    onAccountDeletion.mockReturnValue(pending.promise);
    await confirmDeletion();
    await click("确认注销账号");
    expect(onAccountDeletion).toHaveBeenCalledExactlyOnceWith(user.id);
    await act(async () => listener({ id: "owner-b", email: "second@example.test" }));
    await act(async () => pending.reject(new Error("IndexedDB rejected cleanup")));
    expect(mock.signOut).not.toHaveBeenCalled();
    expect(host.textContent).toContain("second@example.test");
    expect(host.textContent).not.toContain("本机缓存未能完全清理");
  });

  it("invalidates A before deferred Auth verification can publish signed-in account B", async () => {
    const pending = deferred<void>();
    onAccountDeletion.mockReturnValue(pending.promise);
    await confirmDeletion();
    await click("确认注销账号");
    expect(onAccountDeletion).toHaveBeenCalledExactlyOnceWith(user.id);
    expect(identityHint).toBeTypeOf("function");
    await act(async () => identityHint("owner-b"));
    await act(async () => pending.resolve());
    expect(mock.signOut).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain(user.email);
    expect(host.textContent).not.toContain("second@example.test");
    await act(async () => listener({ id: "owner-b", email: "second@example.test" }));
    expect(host.textContent).toContain("second@example.test");
    expect(onSessionChange).toHaveBeenLastCalledWith({
      id: "owner-b",
      email: "second@example.test",
    });
  });

  it("loads and renders a counts-only server preview before showing the irreversible form", async () => {
    await render();
    await click("注销账号");
    expect(mock.preview).toHaveBeenCalledExactlyOnceWith(user.id, expect.any(AbortSignal));
    expect(host.textContent).toContain("2 份资料");
    expect(host.textContent).toContain("3 个版本");
    expect(host.textContent).toContain("3 个云端原件");
    expect(host.textContent).toContain("已在资料回收站清理队列中");
    expect(button("确认注销账号").disabled).toBe(true);
  });

  it("shows an honest browser-only workspace state when cloud sync is unavailable", async () => {
    mock.configured.mockReturnValue(false);
    mock.subscribe.mockImplementation((next: (value: typeof user | null) => void) => {
      listener = next;
      next(null);
      return vi.fn();
    });

    await render();

    expect(host.textContent).toContain("本机工作区");
    expect(host.textContent).toContain("云端同步暂不可用");
    expect(host.textContent).not.toContain("Supabase");
    expect(host.textContent).not.toContain("登录以连接云端");
    expect(host.querySelector("form")).toBeNull();
    await click("继续使用本机工作区");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("requires email, password and DELETE, then signs out locally only after the request succeeds", async () => {
    await render();
    await click("注销账号");
    await input('input[type="email"]', user.email);
    await input('input[type="password"]', "current-password");
    const textInputs = [...host.querySelectorAll<HTMLInputElement>('input[type="text"]')];
    expect(textInputs).toHaveLength(1);
    await input('input[type="text"]', "DELETE");
    expect(button("确认注销账号").disabled).toBe(false);
    await click("确认注销账号");
    expect(mock.request).toHaveBeenCalledExactlyOnceWith(
      { email: user.email, password: "current-password", confirmation: "DELETE" },
      user.id,
    );
    expect(onAccountDeletion).toHaveBeenCalledExactlyOnceWith(user.id);
    expect(onAccountDeletion.mock.invocationCallOrder[0]).toBeLessThan(
      mock.signOut.mock.invocationCallOrder[0]!,
    );
    expect(mock.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
    expect(onSessionChange).toHaveBeenLastCalledWith(null);
    expect(host.textContent).toContain("账号注销请求已提交");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not let a late preview from a previous account overwrite the current session", async () => {
    const pending = deferred<typeof preview>();
    mock.preview.mockReturnValue(pending.promise);
    await render();
    await click("注销账号");
    await act(async () => listener({ id: "owner-b", email: "second@example.test" }));
    await act(async () => pending.resolve(preview));
    expect(host.textContent).not.toContain("2 份资料");
    expect(host.textContent).toContain("second@example.test");
    expect(mock.request).not.toHaveBeenCalled();
    expect(onAccountDeletion).not.toHaveBeenCalled();
  });

  it("shows a pending deletion state without offering another destructive submission", async () => {
    mock.preview.mockResolvedValue({ ...preview, state: "storage_processing", allowed: false });
    await render();
    await click("注销账号");
    expect(host.textContent).toContain("账号注销正在处理中");
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(host.querySelectorAll("button").length).toBeGreaterThan(0);
    expect(mock.request).not.toHaveBeenCalled();
    expect(onAccountDeletion).toHaveBeenCalledExactlyOnceWith(user.id);
  });

  it("keeps the account signed in when the confirmation request fails", async () => {
    mock.request.mockRejectedValue({ code: "ACCOUNT_DELETION_CONFIRMATION_FAILED" });
    await render();
    await click("注销账号");
    await input('input[type="email"]', user.email);
    await input('input[type="password"]', "wrong-password");
    await input('input[type="text"]', "DELETE");
    await click("确认注销账号");
    expect(mock.signOut).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("邮箱或密码不正确");
    expect(host.textContent).toContain(user.email);
  });

  it("still signs out after a durable deletion when local cache cleanup fails", async () => {
    onAccountDeletion.mockRejectedValue(new Error("IndexedDB quota"));
    await render();
    await click("注销账号");
    await input('input[type="email"]', user.email);
    await input('input[type="password"]', "current-password");
    await input('input[type="text"]', "DELETE");
    await click("确认注销账号");
    expect(mock.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
    expect(host.textContent).toContain("本机缓存未能完全清理");
  });

  it("keeps the existing direct Auth exit when no workspace exit control is supplied", async () => {
    await render();
    await click("退出当前账号");
    expect(mock.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
    expect(host.querySelector('[aria-label="退出保护"]')).toBeNull();
  });

  it("delegates a ready workspace exit to the supplied direct action", async () => {
    const control = exitControl({
      kind: "ready",
      canSync: false,
      canKeepLocalDraft: false,
    });
    await render(control);
    await click("退出当前账号");
    expect(control.signOut).toHaveBeenCalledExactlyOnceWith();
    expect(control.syncAndSignOut).not.toHaveBeenCalled();
    expect(control.keepLocalDraftAndSignOut).not.toHaveBeenCalled();
    expect(mock.signOut).not.toHaveBeenCalled();
  });

  it("directly exits a confirmed cloud-readonly view without protected-exit choices", async () => {
    const control = exitControl({
      kind: "ready",
      message: "当前仅可查看已确认的云端资料；本机副本暂时无法读取。",
      canSync: false,
      canKeepLocalDraft: false,
    });
    await render(control);

    await click("退出当前账号");

    expect(control.signOut).toHaveBeenCalledExactlyOnceWith();
    expect(control.syncAndSignOut).not.toHaveBeenCalled();
    expect(control.keepLocalDraftAndSignOut).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="退出保护"]')).toBeNull();
    expect(mock.signOut).not.toHaveBeenCalled();
  });

  it("starts only one direct exit from two immediate clicks and unlocks after a failed attempt", async () => {
    const firstAttempt = deferred<void>();
    let attempts = 0;
    const signOut = vi.fn(() => {
      attempts += 1;
      return attempts === 1 ? firstAttempt.promise : Promise.resolve();
    });
    const control = exitControl(
      { kind: "ready", canSync: false, canKeepLocalDraft: false },
      { signOut },
    );
    await render(control);

    await act(() => {
      const exitButton = button("退出当前账号");
      exitButton.click();
      exitButton.click();
    });
    expect(signOut).toHaveBeenCalledExactlyOnceWith();

    await act(async () => {
      firstAttempt.reject(new Error("network unavailable"));
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("退出未完成");
    });

    await click("退出当前账号");
    expect(signOut).toHaveBeenCalledTimes(2);
  });

  it("asks for an explicit protected-exit choice when content is not yet synchronized", async () => {
    const control = exitControl({
      kind: "unsynced",
      message: "有 2 项修改尚未保存到云端。",
      canSync: true,
      canKeepLocalDraft: true,
    });
    await render(control);
    await click("退出当前账号");
    expect(host.querySelector('[aria-label="退出保护"]')?.textContent).toContain(
      "有 2 项修改尚未保存到云端。",
    );
    expect(control.signOut).not.toHaveBeenCalled();
    expect(control.syncAndSignOut).not.toHaveBeenCalled();
    expect(control.keepLocalDraftAndSignOut).not.toHaveBeenCalled();
    expect(mock.signOut).not.toHaveBeenCalled();
    await click("取消");
    expect(host.querySelector('[aria-label="退出保护"]')).toBeNull();
    expect(control.signOut).not.toHaveBeenCalled();
  });

  it("runs only the chosen synchronized or protected-local exit action", async () => {
    const synchronize = exitControl({
      kind: "syncing",
      canSync: true,
      canKeepLocalDraft: true,
    });
    await render(synchronize);
    await click("退出当前账号");
    await click("等待同步后退出");
    expect(synchronize.syncAndSignOut).toHaveBeenCalledExactlyOnceWith();
    expect(synchronize.signOut).not.toHaveBeenCalled();
    expect(synchronize.keepLocalDraftAndSignOut).not.toHaveBeenCalled();
    expect(mock.signOut).not.toHaveBeenCalled();

    const localDraft = exitControl({
      kind: "conflict",
      canSync: false,
      canKeepLocalDraft: true,
    });
    await render(localDraft);
    await click("退出当前账号");
    expect(
      [...host.querySelectorAll("button")].some(
        (item) => item.textContent?.replace(/\s+/g, "") === "等待同步后退出",
      ),
    ).toBe(false);
    await click("保留本机草稿后退出");
    expect(localDraft.keepLocalDraftAndSignOut).toHaveBeenCalledExactlyOnceWith();
    expect(localDraft.signOut).not.toHaveBeenCalled();
    expect(localDraft.syncAndSignOut).not.toHaveBeenCalled();
    expect(mock.signOut).not.toHaveBeenCalled();
  });

  it("keeps the account panel open when protected local persistence fails", async () => {
    const control = exitControl(
      { kind: "local-error", canSync: false, canKeepLocalDraft: true },
      { keepLocalDraftAndSignOut: vi.fn(async () => Promise.reject(new Error("disk full"))) },
    );
    await render(control);
    await click("退出当前账号");
    await click("保留本机草稿后退出");
    await vi.waitFor(() => {
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("本机草稿尚未安全保存");
    });
    expect(host.querySelector('[aria-label="退出保护"]')).not.toBeNull();
    expect(mock.signOut).not.toHaveBeenCalled();
  });
});
