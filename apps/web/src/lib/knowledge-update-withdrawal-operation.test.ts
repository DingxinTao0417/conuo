import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyWorkspace } from "./seed";
import {
  persistKnowledgeUpdateWithdrawal,
  type KnowledgeUpdateWithdrawalOperationContext,
  type PersistKnowledgeUpdateWithdrawalInput,
} from "./knowledge-update-withdrawal-operation";
import type { PreparedKnowledgeUpdateWithdrawal } from "./knowledge-update-withdrawal";

const domain = vi.hoisted(() => ({ prepare: vi.fn(), commit: vi.fn() }));
vi.mock("./knowledge-update-withdrawal", () => ({
  prepareKnowledgeUpdateWithdrawal: domain.prepare,
  commitKnowledgeUpdateWithdrawal: domain.commit,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  let context: KnowledgeUpdateWithdrawalOperationContext | null = {
    token: 7,
    userId: "owner-a",
    localCacheMode: "normal",
    ready: true,
    noteId: "knowledge-a",
    data: createEmptyWorkspace(),
  };
  const prepared: PreparedKnowledgeUpdateWithdrawal = {
    jobId: "job-a",
    noteId: "knowledge-a",
    fingerprint: "a".repeat(64),
    canonicalBaseKey: "canonical-reviewed-note",
    selections: [],
  };
  domain.prepare.mockResolvedValue(prepared);
  domain.commit.mockImplementation((data) => ({ ...data, autoOrganize: true }));
  const input: PersistKnowledgeUpdateWithdrawalInput = {
    getContext: () => context,
    expectedContext: {
      token: 7,
      userId: "owner-a",
      localCacheMode: "normal",
      noteId: "knowledge-a",
    },
    jobId: "job-a",
    fingerprint: prepared.fingerprint,
    selections: [{ changeId: "change-a", action: "restore" }],
    updateDurably: vi.fn(async (reducer) => {
      context!.data = reducer(context!.data);
      return true;
    }),
  };
  return {
    input,
    prepared,
    get: () => context,
    set: (value: typeof context) => {
      context = value;
    },
  };
}
beforeEach(() => vi.resetAllMocks());

describe("knowledge-update withdrawal operation context and durability", () => {
  it.each([
    { token: 8 },
    { userId: "owner-b" },
    { localCacheMode: "recovery" },
    { ready: false },
    { noteId: "knowledge-b" },
    { noteId: null },
  ])("rejects a changed context before any preparation: %j", async (patch) => {
    const s = setup();
    s.set({ ...s.get()!, ...patch });
    await expect(persistKnowledgeUpdateWithdrawal(s.input)).rejects.toThrow("重新核对");
    expect(domain.prepare).not.toHaveBeenCalled();
    expect(s.input.updateDurably).not.toHaveBeenCalled();
  });

  it("rejects an unmounted context without preparation", async () => {
    const s = setup();
    s.set(null);
    await expect(persistKnowledgeUpdateWithdrawal(s.input)).rejects.toThrow("重新核对");
    expect(domain.prepare).not.toHaveBeenCalled();
  });

  it("rejects A→B→A with a new token while preparation is pending", async () => {
    const s = setup(),
      preparing = deferred<PreparedKnowledgeUpdateWithdrawal>();
    domain.prepare.mockReturnValueOnce(preparing.promise);
    const outcome = persistKnowledgeUpdateWithdrawal(s.input).catch((error: unknown) => error);
    s.set({ ...s.get()!, token: 8, userId: "owner-b" });
    s.set({ ...s.get()!, token: 9, userId: "owner-a" });
    preparing.resolve(s.prepared);
    expect(await outcome).toBeInstanceOf(Error);
    expect(s.input.updateDurably).not.toHaveBeenCalled();
  });

  it("captures reviewed choices and identity without retaining mutable event inputs", async () => {
    const s = setup(),
      preparing = deferred<PreparedKnowledgeUpdateWithdrawal>();
    const originalData = s.get()!.data;
    domain.prepare.mockReturnValueOnce(preparing.promise);
    const pending = persistKnowledgeUpdateWithdrawal(s.input);
    s.input.selections[0].action = "keep";
    s.input.expectedContext.token = 999;
    originalData.autoOrganize = false;
    expect(domain.prepare.mock.calls[0][0]).not.toBe(originalData);
    expect(domain.prepare.mock.calls[0][0].autoOrganize).toBeUndefined();
    expect(domain.prepare.mock.calls[0][3]).toEqual([{ changeId: "change-a", action: "restore" }]);
    preparing.resolve(s.prepared);
    await expect(pending).resolves.toBeUndefined();
  });

  it("checks identity inside the reducer and passes latest data to canonical commit", async () => {
    const s = setup();
    s.input.updateDurably = vi.fn(async (reducer) => {
      const latest = { ...s.get()!.data, autoOrganize: false };
      reducer(latest);
      expect(domain.commit).toHaveBeenCalledWith(latest, s.prepared);
      return true;
    });
    await persistKnowledgeUpdateWithdrawal(s.input);
    domain.commit.mockClear();
    s.input.updateDurably = vi.fn(async (reducer) => {
      s.set({ ...s.get()!, localCacheMode: "recovery" });
      reducer(s.get()!.data);
      return true;
    });
    await expect(persistKnowledgeUpdateWithdrawal(s.input)).rejects.toThrow("缓存模式");
    expect(domain.commit).not.toHaveBeenCalled();
  });

  it.each(["owner", "cache", "ready", "note", "unmount"])(
    "does not confirm local resolution after %s changes",
    async (kind) => {
      const s = setup(),
        saving = deferred<boolean>();
      s.input.updateDurably = vi.fn(async (reducer) => {
        reducer(s.get()!.data);
        return saving.promise;
      });
      const outcome = persistKnowledgeUpdateWithdrawal(s.input).catch((error: unknown) => error);
      await vi.waitFor(() => expect(domain.commit).toHaveBeenCalledOnce());
      const current = s.get()!;
      s.set(
        kind === "unmount"
          ? null
          : {
              ...current,
              ...(kind === "owner" ? { userId: "owner-b", token: 8 } : {}),
              ...(kind === "cache" ? { localCacheMode: "recovery" } : {}),
              ...(kind === "ready" ? { ready: false } : {}),
              ...(kind === "note" ? { noteId: "knowledge-b" } : {}),
            },
      );
      saving.resolve(true);
      expect(await outcome).toBeInstanceOf(Error);
    },
  );

  it("rejects unavailable mutations and propagates local save failure", async () => {
    const s = setup();
    s.input.updateDurably = vi.fn(async () => false);
    await expect(persistKnowledgeUpdateWithdrawal(s.input)).rejects.toThrow("撤回未应用");
    s.input.updateDurably = vi.fn(async () => {
      throw new Error("IndexedDB quota");
    });
    await expect(persistKnowledgeUpdateWithdrawal(s.input)).rejects.toThrow("IndexedDB quota");
  });

  it.each(["prepare", "local save"])(
    "discards a late %s error belonging to the previous identity",
    async (phase) => {
      const s = setup();
      const preparing = deferred<PreparedKnowledgeUpdateWithdrawal>();
      const saving = deferred<boolean>();
      if (phase === "prepare") domain.prepare.mockReturnValueOnce(preparing.promise);
      else s.input.updateDurably = vi.fn(async () => saving.promise);
      const outcome = persistKnowledgeUpdateWithdrawal(s.input).catch((error: unknown) => error);
      if (phase === "local save")
        await vi.waitFor(() => expect(s.input.updateDurably).toHaveBeenCalledOnce());
      s.set({ ...s.get()!, token: 8, userId: "owner-b" });
      const oldError = new Error("previous account quota error");
      if (phase === "prepare") preparing.reject(oldError);
      else saving.reject(oldError);
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("当前账号");
      expect(error).not.toBe(oldError);
    },
  );

  it("rejects a prepared plan belonging to another note", async () => {
    const s = setup();
    domain.prepare.mockResolvedValueOnce({ ...s.prepared, noteId: "other" });
    await expect(persistKnowledgeUpdateWithdrawal(s.input)).rejects.toThrow("范围与已核对");
    expect(s.input.updateDurably).not.toHaveBeenCalled();
  });
});
