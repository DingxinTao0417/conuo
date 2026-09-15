import "fake-indexeddb/auto";
import { IDBFactory, IDBObjectStore as FakeIDBObjectStore } from "fake-indexeddb";
import { deleteDB } from "idb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  getUser: vi.fn(),
  onAuthStateChange: vi.fn(),
  unsubscribe: vi.fn(),
  config: vi.fn(),
}));
vi.mock("./supabase/config", () => ({ getSupabaseConfig: mock.config }));
vi.mock("./supabase/client", () => ({
  createClient: () => ({
    auth: { getUser: mock.getUser, onAuthStateChange: mock.onAuthStateChange },
  }),
}));
import { askCloud, getModelStatus, subscribeSession } from "./cloud";
import { subscribeConfirmedAccountDeletions } from "./account-deletion-observer";
import {
  isAccountLocallyDeleted,
  saveLocalWorkspace,
  loadLocalWorkspaceRecord,
} from "./local-store";
import { createEmptyWorkspace } from "./seed";
import { KNOWLEDGE_UPDATE_DRAFT_DATABASE } from "./knowledge-update-review-drafts";

let authEvent: (event: string, session: { user: { id: string } } | null) => void;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("indexedDB", new IDBFactory());
  mock.config.mockReturnValue({ url: "https://project.example.test", key: "public-test" });
  mock.getUser.mockResolvedValue({
    data: { user: { id: "A", email: "a@example.test" } },
    error: null,
  });
  mock.onAuthStateChange.mockImplementation((callback: typeof authEvent) => {
    authEvent = callback;
    return { data: { subscription: { unsubscribe: mock.unsubscribe } } };
  });
});
const subscriptions: (() => void)[] = [];
afterEach(async () => {
  for (const stop of subscriptions.splice(0)) stop();
  vi.restoreAllMocks();
  await deleteDB("conuo-web");
  await deleteDB(KNOWLEDGE_UPDATE_DRAFT_DATABASE);
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("common cloud deletion observation", () => {
  it("durably stops the captured account on an explicit 423 even without a browser channel", async () => {
    await saveLocalWorkspace(createEmptyWorkspace(), "A", 0);
    await saveLocalWorkspace(createEmptyWorkspace(), "B", 0);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code: "ACCOUNT_DELETION_PENDING", error: "账号已停止访问。" },
          { status: 423 },
        ),
      ),
    );
    await expect(getModelStatus("A")).rejects.toMatchObject({
      status: 423,
      code: "ACCOUNT_DELETION_PENDING",
    });
    expect(await isAccountLocallyDeleted("A")).toBe(true);
    expect(await isAccountLocallyDeleted("B")).toBe(false);
    expect(await loadLocalWorkspaceRecord("B")).not.toBeNull();
  });

  it("only notifies captured A when a late adapter denial returns after the UI moved to B", async () => {
    await saveLocalWorkspace(createEmptyWorkspace(), "A", 0);
    const b = createEmptyWorkspace();
    b.spaces[0]!.name = "B preserved";
    await saveLocalWorkspace(b, "B", 0);
    const result = deferred<Response>();
    const listener = vi.fn();
    subscriptions.push(subscribeConfirmedAccountDeletions(listener));
    const fetch = vi.fn(() => result.promise);
    vi.stubGlobal("fetch", fetch);
    const request = getModelStatus("A").catch((error) => error);
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/ask",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({ "X-Conuo-User": "A" }),
      }),
    );
    result.resolve(
      Response.json({ code: "ACCOUNT_DELETION_PENDING", error: "A stopped" }, { status: 423 }),
    );
    expect(await request).toMatchObject({
      status: 423,
      code: "ACCOUNT_DELETION_PENDING",
      message: "A stopped",
      localCleanupFailed: false,
    });
    expect(listener).toHaveBeenCalledExactlyOnceWith("A");
    expect((await loadLocalWorkspaceRecord("B"))!.spaces[0]!.name).toBe("B preserved");
  });

  it.each([
    [401, "UNAUTHENTICATED"],
    [401, "ACCOUNT_DELETION_PENDING"],
    [423, "OTHER_LOCK"],
    [503, "CLOUD_ERROR"],
  ])("does not infer deletion from HTTP %s/%s", async (status, code) => {
    await saveLocalWorkspace(createEmptyWorkspace(), "A", 0);
    const listener = vi.fn();
    subscriptions.push(subscribeConfirmedAccountDeletions(listener));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ code, error: "unchanged error" }, { status })),
    );
    await expect(getModelStatus("A")).rejects.toMatchObject({
      status,
      code,
      message: "unchanged error",
      localCleanupFailed: false,
    });
    expect(listener).not.toHaveBeenCalled();
    expect(await isAccountLocallyDeleted("A")).toBe(false);
    expect(await loadLocalWorkspaceRecord("A")).not.toBeNull();
  });

  it("preserves network failure without notifying or clearing the captured actor", async () => {
    await saveLocalWorkspace(createEmptyWorkspace(), "A", 0);
    const error = new TypeError("network failed");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw error;
      }),
    );
    const listener = vi.fn();
    subscriptions.push(subscribeConfirmedAccountDeletions(listener));
    await expect(getModelStatus("A")).rejects.toBe(error);
    expect(listener).not.toHaveBeenCalled();
    expect(await isAccountLocallyDeleted("A")).toBe(false);
  });

  it("preserves the authenticated error and exposes browser cleanup failure without private error details", async () => {
    await saveLocalWorkspace(createEmptyWorkspace(), "A", 0);
    const originalDelete = FakeIDBObjectStore.prototype.delete;
    vi.spyOn(FakeIDBObjectStore.prototype, "delete").mockImplementation(function (
      this: InstanceType<typeof FakeIDBObjectStore>,
      ...args: Parameters<typeof originalDelete>
    ) {
      if (this.transaction.db.name === "conuo-web" && this.name === "workspaces")
        throw new Error("private disk error details");
      return originalDelete.apply(this, args);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ code: "ACCOUNT_DELETION_PENDING", error: "A stopped" }, { status: 423 }),
      ),
    );
    const error = await getModelStatus("A").catch((error) => error);
    expect(error).toMatchObject({
      status: 423,
      code: "ACCOUNT_DELETION_PENDING",
      message: "A stopped",
      localCleanupFailed: true,
    });
    expect(error.message).not.toContain("private disk");
    expect(await isAccountLocallyDeleted("A")).toBe(true);
  });

  it("applies the same observer to a structured ask-stream HTTP error", async () => {
    await saveLocalWorkspace(createEmptyWorkspace(), "A", 0);
    const listener = vi.fn();
    subscriptions.push(subscribeConfirmedAccountDeletions(listener));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ code: "ACCOUNT_DELETION_PENDING", error: "A stopped" }, { status: 423 }),
      ),
    );
    await expect(
      askCloud(
        {
          scope: "document",
          spaceId: "space",
          sourceId: "source",
          sourceIds: [],
          question: "question",
        },
        undefined,
        "A",
      ),
    ).rejects.toMatchObject({
      status: 423,
      code: "ACCOUNT_DELETION_PENDING",
      localCleanupFailed: false,
    });
    expect(listener).toHaveBeenCalledExactlyOnceWith("A");
    expect(await isAccountLocallyDeleted("A")).toBe(true);
  });

  it("provides an identity invalidation hint synchronously before deferred verification can authorize B", async () => {
    const verifying = deferred<unknown>();
    mock.getUser.mockReturnValueOnce(verifying.promise);
    const listener = vi.fn();
    const hint = vi.fn();
    const stop = subscribeSession(listener, hint);
    authEvent("SIGNED_IN", { user: { id: "B" } });
    expect(hint).toHaveBeenCalledExactlyOnceWith("B");
    expect(listener).not.toHaveBeenCalled();
    verifying.resolve({ data: { user: { id: "A", email: "a@example.test" } }, error: null });
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
    stop();
  });

  it("never authorizes INITIAL_SESSION from its cached identity hint", async () => {
    const verifying = deferred<unknown>();
    mock.getUser.mockReturnValueOnce(verifying.promise);
    const listener = vi.fn();
    const hint = vi.fn();
    const stop = subscribeSession(listener, hint);
    authEvent("INITIAL_SESSION", { user: { id: "B" } });
    expect(hint).toHaveBeenCalledExactlyOnceWith("B");
    expect(listener).not.toHaveBeenCalled();
    verifying.resolve({ data: { user: { id: "A", email: "a@example.test" } }, error: null });
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledExactlyOnceWith({ id: "A", email: "a@example.test" }),
    );
    stop();
  });

  it("keeps A unauthorized by a B hint until getUser actually verifies B", async () => {
    const listener = vi.fn();
    const hint = vi.fn();
    const stop = subscribeSession(listener, hint);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    const verifying = deferred<unknown>();
    mock.getUser.mockReturnValueOnce(verifying.promise);
    authEvent("SIGNED_IN", { user: { id: "B" } });
    expect(hint).toHaveBeenCalledExactlyOnceWith("B");
    expect(listener).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(mock.getUser).toHaveBeenCalledTimes(2));
    expect(listener).toHaveBeenCalledTimes(1);
    verifying.resolve({ data: { user: { id: "B", email: "b@example.test" } }, error: null });
    await vi.waitFor(() =>
      expect(listener).toHaveBeenLastCalledWith({ id: "B", email: "b@example.test" }),
    );
    stop();
  });

  it("invalidates sign-out synchronously and suppresses stale verification", async () => {
    const verifying = deferred<unknown>();
    mock.getUser.mockReturnValueOnce(verifying.promise);
    const listener = vi.fn();
    const hint = vi.fn();
    const stop = subscribeSession(listener, hint);
    authEvent("SIGNED_OUT", { user: { id: "B" } });
    expect(hint).toHaveBeenCalledExactlyOnceWith(null);
    expect(listener).toHaveBeenCalledExactlyOnceWith(null);
    verifying.resolve({ data: { user: { id: "A", email: "a@example.test" } }, error: null });
    await Promise.resolve();
    expect(listener).toHaveBeenCalledExactlyOnceWith(null);
    stop();
  });

  it("ignores events and late verification after disposal", async () => {
    const verifying = deferred<unknown>();
    mock.getUser.mockReturnValueOnce(verifying.promise);
    const listener = vi.fn();
    const hint = vi.fn();
    const stop = subscribeSession(listener, hint);
    stop();
    authEvent("SIGNED_IN", { user: { id: "B" } });
    verifying.resolve({ data: { user: { id: "A", email: "a@example.test" } }, error: null });
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
    expect(hint).not.toHaveBeenCalled();
    expect(mock.unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not let a broken invalidation consumer suppress verified identity", async () => {
    const listener = vi.fn();
    const stop = subscribeSession(listener, () => {
      throw new Error("hint failed");
    });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    mock.getUser.mockResolvedValue({
      data: { user: { id: "B", email: "b@example.test" } },
      error: null,
    });
    authEvent("SIGNED_IN", { user: { id: "B" } });
    await vi.waitFor(() =>
      expect(listener).toHaveBeenLastCalledWith({ id: "B", email: "b@example.test" }),
    );
    stop();
  });
});
