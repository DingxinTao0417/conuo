import { describe, expect, it, vi } from "vitest";
import {
  MAX_KNOWLEDGE_UPDATE_DRAFT_ACCOUNTS,
  MAX_KNOWLEDGE_UPDATE_DRAFTS_PER_ACCOUNT,
  type KnowledgeUpdateDraftSession,
  type StoredKnowledgeUpdateReviewDraft,
} from "./knowledge-update-review-drafts";
import { createWebReviewDraftStore } from "./web-review-draft-store";

function entry(
  accountId = "account-a",
  noteId = "note-a",
  jobId = "job-a",
): StoredKnowledgeUpdateReviewDraft {
  return {
    accountId,
    noteId,
    jobId,
    contract: "immutable-contract",
    draft: { selectedChangeIds: ["change-a"], editedTexts: { "change-a": "人工编辑" } },
  };
}

describe("web memory review drafts", () => {
  it("does not access IndexedDB or persistent browser storage", async () => {
    const unavailable = () => {
      throw new Error("persistent storage must not be accessed");
    };
    const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, get: unavailable });
    vi.stubGlobal("localStorage", new Proxy({}, { get: unavailable }));
    vi.stubGlobal("sessionStorage", new Proxy({}, { get: unavailable }));
    try {
      const store = createWebReviewDraftStore();
      const session = await store.load("account-a");
      await store.save(session, "note-a", "job-a", entry());
      expect((await store.load("account-a")).drafts).toEqual([entry()]);
      await store.clear("account-a");
      expect((await store.load("account-a")).drafts).toEqual([]);
    } finally {
      if (original) Object.defineProperty(globalThis, "indexedDB", original);
      else Reflect.deleteProperty(globalThis, "indexedDB");
      vi.unstubAllGlobals();
    }
  });

  it("keeps accounts and exact note/job targets isolated", async () => {
    const store = createWebReviewDraftStore();
    const a = await store.load("account-a");
    const b = await store.load("account-b");
    await Promise.all([
      store.save(a, "note-a", "job-a", entry()),
      store.save(a, "note-a", "job-b", entry("account-a", "note-a", "job-b")),
      store.save(b, "note-a", "job-a", entry("account-b")),
    ]);
    await store.save(a, "note-a", "job-a", null);
    expect((await store.load("account-a")).drafts).toEqual([entry("account-a", "note-a", "job-b")]);
    expect((await store.load("account-b")).drafts).toEqual([entry("account-b")]);
    await store.clear("account-a");
    expect((await store.load("account-b")).drafts).toEqual([entry("account-b")]);
  });

  it.each([
    ["account-b", "note-a", "job-a"],
    ["account-a", "note-b", "job-a"],
    ["account-a", "note-a", "job-b"],
  ])("rejects an entry for another identity: %s/%s/%s", async (account, note, job) => {
    const store = createWebReviewDraftStore();
    const session = await store.load("account-a");
    await store.save(session, "note-a", "job-a", entry());
    await expect(store.save(session, "note-a", "job-a", entry(account, note, job))).rejects.toThrow(
      "身份",
    );
    expect((await store.load("account-a")).drafts).toEqual([entry()]);
  });

  it("fences old callbacks synchronously and permits a fresh ordinary session", async () => {
    const store = createWebReviewDraftStore();
    const old = await store.load("account-a");
    await store.save(old, "note-a", "job-a", entry());
    const clear = store.clear("account-a");
    const stale = store.save(old, "note-a", "job-a", entry());
    await expect(stale).rejects.toThrow("清理");
    await clear;
    const current = await store.load("account-a");
    expect(current.generation).not.toBe(old.generation);
    expect(current.epoch).toBeGreaterThan(old.epoch);
    expect(current.drafts).toEqual([]);
    await expect(store.save(old, "note-a", "job-a", entry())).rejects.toThrow("清理");
    await store.save(current, "note-a", "job-a", entry());
    expect((await store.load("account-a")).drafts).toEqual([entry()]);
  });

  it("does not reload a deleted account even after ordinary cleanup", async () => {
    const store = createWebReviewDraftStore();
    const a = await store.load("account-a");
    const b = await store.load("account-b");
    await store.save(b, "note-a", "job-a", entry("account-b"));
    await store.clear("account-a", { blockReload: true });
    await expect(store.load("account-a")).rejects.toThrow("注销");
    await expect(store.save(a, "note-a", "job-a", entry())).rejects.toThrow("注销");
    await store.clear("account-a");
    await expect(store.load("account-a")).rejects.toThrow("注销");
    expect((await store.load("account-b")).drafts).toEqual([entry("account-b")]);
  });

  it("rejects guessed or cross-store generations", async () => {
    const store = createWebReviewDraftStore();
    const other = createWebReviewDraftStore();
    const a = await store.load("account-a");
    const otherA = await other.load("account-a");
    await expect(
      store.save({ ...a, generation: "wrong" }, "note-a", "job-a", entry()),
    ).rejects.toThrow("清理");
    await expect(store.save(otherA, "note-a", "job-a", entry())).rejects.toThrow("清理");
    expect((await store.load("account-a")).drafts).toEqual([]);
  });

  it("clones save inputs and loaded output so editor mutations cannot escape a transaction", async () => {
    const store = createWebReviewDraftStore();
    const a = await store.load("account-a");
    const draft = entry();
    await store.save(a, "note-a", "job-a", draft);
    draft.draft.editedTexts["change-a"] = "mutated input";
    const loaded = await store.load("account-a");
    loaded.drafts[0].draft.editedTexts["change-a"] = "mutated output";
    expect((await store.load("account-a")).drafts).toEqual([entry()]);
  });

  it("starts empty in a new web page store instead of restoring persistent drafts", async () => {
    const store = createWebReviewDraftStore();
    const a = await store.load("account-a");
    await store.save(a, "note-a", "job-a", entry());
    expect((await createWebReviewDraftStore().load("account-a")).drafts).toEqual([]);
  });

  it("rejects malformed draft edits without replacing a valid entry", async () => {
    const store = createWebReviewDraftStore();
    const a = await store.load("account-a");
    await store.save(a, "note-a", "job-a", entry());
    await expect(
      store.save(a, "note-a", "job-a", {
        ...entry(),
        draft: { selectedChangeIds: ["change-a", "change-a"], editedTexts: {} },
      }),
    ).rejects.toThrow();
    await expect(
      store.save(a, "note-a", "job-a", {
        ...entry(),
        draft: { selectedChangeIds: [], editedTexts: { "change-a": "x".repeat(6001) } },
      }),
    ).rejects.toThrow();
    expect((await store.load("account-a")).drafts).toEqual([entry()]);
  });

  it.each(["", " account-a", "account-a ", "x".repeat(201)])(
    "rejects invalid account identity without allocating a record: %s",
    async (accountId) => {
      const store = createWebReviewDraftStore();
      await expect(store.load(accountId)).rejects.toThrow("身份");
      await expect(store.clear(accountId)).rejects.toThrow("身份");
    },
  );

  it("bounds drafts per account while allowing replacement and removal at capacity", async () => {
    const store = createWebReviewDraftStore();
    const a = await store.load("account-a");
    for (let index = 0; index < MAX_KNOWLEDGE_UPDATE_DRAFTS_PER_ACCOUNT; index++)
      await store.save(a, `note-${index}`, "job-a", entry("account-a", `note-${index}`));
    await expect(
      store.save(a, "note-extra", "job-a", entry("account-a", "note-extra")),
    ).rejects.toThrow("容量");
    const replacement = { ...entry("account-a", "note-0"), contract: "updated-contract" };
    await store.save(a, "note-0", "job-a", replacement);
    await store.save(a, "note-1", "job-a", null);
    await store.save(a, "note-extra", "job-a", entry("account-a", "note-extra"));
    const drafts = (await store.load("account-a")).drafts;
    expect(drafts).toHaveLength(MAX_KNOWLEDGE_UPDATE_DRAFTS_PER_ACCOUNT);
    expect(drafts).toContainEqual(replacement);
    expect(drafts.some((item) => item.noteId === "note-1")).toBe(false);
  });

  it("bounds live accounts and reclaims ordinary cleared records", async () => {
    const store = createWebReviewDraftStore();
    for (let index = 0; index < MAX_KNOWLEDGE_UPDATE_DRAFT_ACCOUNTS; index++)
      await store.load(`account-${index}`);
    await expect(store.load("account-extra")).rejects.toThrow("容量");
    await store.clear("account-0");
    await expect(store.load("account-extra")).resolves.toMatchObject({ drafts: [] });
  });

  it("bounds total draft text without losing already accepted edits", async () => {
    const store = createWebReviewDraftStore();
    const a = await store.load("account-a");
    for (let index = 0; index < 3; index++)
      await store.save(a, `note-${index}`, "job-a", {
        ...entry("account-a", `note-${index}`),
        contract: "x".repeat(1_000_000),
      });
    await expect(
      store.save(a, "note-extra", "job-a", {
        ...entry("account-a", "note-extra"),
        contract: "x".repeat(1_000_000),
      }),
    ).rejects.toThrow("容量");
    expect((await store.load("account-a")).drafts).toHaveLength(3);
  });

  it("rejects an invalid session epoch before any write", async () => {
    const store = createWebReviewDraftStore();
    const a = await store.load("account-a");
    for (const epoch of [-1, Number.NaN, 0.5])
      await expect(
        store.save({ ...a, epoch } as KnowledgeUpdateDraftSession, "note-a", "job-a", entry()),
      ).rejects.toThrow();
    expect((await store.load("account-a")).drafts).toEqual([]);
  });
});
