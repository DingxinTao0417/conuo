import "fake-indexeddb/auto";
import { IDBFactory, IDBObjectStore as FakeIDBObjectStore } from "fake-indexeddb";
import { deleteDB, openDB } from "idb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAccountKnowledgeUpdateReviewDrafts,
  KNOWLEDGE_UPDATE_DRAFT_DATABASE,
  loadKnowledgeUpdateReviewDrafts,
  MAX_KNOWLEDGE_UPDATE_DRAFTS_PER_ACCOUNT,
  saveKnowledgeUpdateReviewDraft,
  type KnowledgeUpdateReviewDraft,
  type StoredKnowledgeUpdateReviewDraft,
} from "./knowledge-update-review-drafts";
import {
  clearAccountLocalCache,
  getBlob,
  loadLocalWorkspace,
  LocalAccountDeletedError,
  putBlobIfAbsent,
  saveLocalWorkspace,
} from "./local-store";
import { createEmptyWorkspace } from "./seed";

function entry(
  accountId = "account-a",
  noteId = "note-one",
  jobId = "job-one",
): StoredKnowledgeUpdateReviewDraft {
  return {
    accountId,
    noteId,
    jobId,
    contract: "exact-input-and-result-contract",
    draft: { selectedChangeIds: ["change-one"], editedTexts: { "change-one": "我核对后的解释。" } },
  };
}

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(async () => {
  vi.restoreAllMocks();
  await deleteDB(KNOWLEDGE_UPDATE_DRAFT_DATABASE);
  await deleteDB("conuo-web");
  vi.unstubAllGlobals();
});

describe("knowledge review draft local storage", () => {
  it("merges exact tasks and isolates authenticated accounts and the local workspace", async () => {
    const accountA = await loadKnowledgeUpdateReviewDrafts("account-a");
    const accountB = await loadKnowledgeUpdateReviewDrafts("account-b");
    const local = await loadKnowledgeUpdateReviewDrafts("local");
    await Promise.all([
      saveKnowledgeUpdateReviewDraft(accountA, "note-one", "job-one", entry()),
      saveKnowledgeUpdateReviewDraft(
        accountA,
        "note-two",
        "job-two",
        entry("account-a", "note-two", "job-two"),
      ),
      saveKnowledgeUpdateReviewDraft(accountB, "note-one", "job-one", entry("account-b")),
      saveKnowledgeUpdateReviewDraft(local, "note-one", "job-one", entry("local")),
    ]);
    expect((await loadKnowledgeUpdateReviewDrafts("account-a")).drafts).toHaveLength(2);
    await saveKnowledgeUpdateReviewDraft(accountA, "note-one", "job-one", null);
    expect((await loadKnowledgeUpdateReviewDrafts("account-a")).drafts).toEqual([
      entry("account-a", "note-two", "job-two"),
    ]);
    expect((await loadKnowledgeUpdateReviewDrafts("account-b")).drafts).toEqual([
      entry("account-b"),
    ]);
    expect((await loadKnowledgeUpdateReviewDrafts("local")).drafts).toEqual([entry("local")]);
  });

  it("rejects malformed or oversized edits without overwriting the saved draft", async () => {
    const session = await loadKnowledgeUpdateReviewDrafts("account-a");
    await saveKnowledgeUpdateReviewDraft(session, "note-one", "job-one", entry());
    for (const draft of [
      { selectedChangeIds: ["change-one", "change-one"], editedTexts: {} },
      { selectedChangeIds: [], editedTexts: { "change-one": "x".repeat(6001) } },
      { selectedChangeIds: [], editedTexts: {}, hiddenImage: "must-not-persist" },
    ]) {
      await expect(
        saveKnowledgeUpdateReviewDraft(session, "note-one", "job-one", {
          ...entry(),
          draft: draft as KnowledgeUpdateReviewDraft,
        }),
      ).rejects.toThrow();
    }
    expect((await loadKnowledgeUpdateReviewDrafts("account-a")).drafts).toEqual([entry()]);
  });

  it("fails closed on foreign or unknown account records and leaves their bytes intact", async () => {
    await loadKnowledgeUpdateReviewDrafts("account-a");
    const db = await openDB(KNOWLEDGE_UPDATE_DRAFT_DATABASE, 1);
    try {
      const key = JSON.stringify(["account", "account-a"]);
      for (const bad of [
        null,
        { schemaVersion: 2 },
        { schemaVersion: 1, accountId: "account-b", generation: "wrong-owner", drafts: [] },
      ]) {
        await db.put("accounts", bad, key);
        await expect(loadKnowledgeUpdateReviewDrafts("account-a")).rejects.toThrow("格式无效");
        expect(await db.get("accounts", key)).toEqual(bad);
      }
    } finally {
      db.close();
    }
  });

  it("bounds the number of drafts without evicting a different task", async () => {
    const session = await loadKnowledgeUpdateReviewDrafts("account-a");
    for (let index = 0; index < MAX_KNOWLEDGE_UPDATE_DRAFTS_PER_ACCOUNT; index++) {
      const id = `job-${index}`;
      await saveKnowledgeUpdateReviewDraft(
        session,
        "note-one",
        id,
        entry("account-a", "note-one", id),
      );
    }
    await expect(
      saveKnowledgeUpdateReviewDraft(
        session,
        "note-one",
        "job-overflow",
        entry("account-a", "note-one", "job-overflow"),
      ),
    ).rejects.toThrow();
    expect((await loadKnowledgeUpdateReviewDrafts("account-a")).drafts).toHaveLength(
      MAX_KNOWLEDGE_UPDATE_DRAFTS_PER_ACCOUNT,
    );
  });

  it("bounds total persisted characters without dropping earlier drafts", async () => {
    const session = await loadKnowledgeUpdateReviewDrafts("account-a");
    for (let index = 0; index < 3; index++) {
      const id = `large-${index}`;
      await saveKnowledgeUpdateReviewDraft(session, "note-one", id, {
        ...entry("account-a", "note-one", id),
        contract: "x".repeat(1_000_000),
      });
    }
    await expect(
      saveKnowledgeUpdateReviewDraft(session, "note-one", "large-overflow", {
        ...entry("account-a", "note-one", "large-overflow"),
        contract: "x".repeat(1_000_000),
      }),
    ).rejects.toThrow("保存容量");
    expect((await loadKnowledgeUpdateReviewDrafts("account-a")).drafts).toHaveLength(3);
  });

  it("clears only the account and fences old writers even after the account is initialized again", async () => {
    const oldSession = await loadKnowledgeUpdateReviewDrafts("account-a");
    const accountB = await loadKnowledgeUpdateReviewDrafts("account-b");
    await saveKnowledgeUpdateReviewDraft(oldSession, "note-one", "job-one", entry());
    await saveKnowledgeUpdateReviewDraft(accountB, "note-one", "job-one", entry("account-b"));
    await clearAccountKnowledgeUpdateReviewDrafts("account-a");
    const fresh = await loadKnowledgeUpdateReviewDrafts("account-a");
    expect(fresh.drafts).toEqual([]);
    expect(fresh.generation).not.toBe(oldSession.generation);
    await expect(
      saveKnowledgeUpdateReviewDraft(oldSession, "note-one", "job-one", entry()),
    ).rejects.toThrow("账号已切换");
    // The persistent token also fences a foreign-tab session with a current
    // in-memory epoch but a generation from before deletion.
    await expect(
      saveKnowledgeUpdateReviewDraft(
        { ...oldSession, epoch: fresh.epoch },
        "note-one",
        "job-one",
        entry(),
      ),
    ).rejects.toThrow("未重新创建");
    expect((await loadKnowledgeUpdateReviewDrafts("account-a")).drafts).toEqual([]);
    expect((await loadKnowledgeUpdateReviewDrafts("account-b")).drafts).toEqual([
      entry("account-b"),
    ]);
  });

  it("includes draft cleanup in account cache deletion and reports a real cleanup failure", async () => {
    await saveLocalWorkspace(createEmptyWorkspace(), "account-a");
    await saveLocalWorkspace(createEmptyWorkspace(), "account-b");
    await putBlobIfAbsent("account-a-original", new Blob(["A_PRIVATE_BYTES"]), "account-a");
    await putBlobIfAbsent("account-b-original", new Blob(["B_PRIVATE_BYTES"]), "account-b");
    const session = await loadKnowledgeUpdateReviewDrafts("account-a");
    await saveKnowledgeUpdateReviewDraft(session, "note-one", "job-one", entry());
    const originalPut = FakeIDBObjectStore.prototype.put;
    vi.spyOn(FakeIDBObjectStore.prototype, "put").mockImplementation(function (
      this: InstanceType<typeof FakeIDBObjectStore>,
      value,
      key,
    ) {
      if (this.transaction.db.name === KNOWLEDGE_UPDATE_DRAFT_DATABASE)
        throw new Error("disk denied deletion fence");
      return originalPut.call(this, value, key);
    });
    await expect(clearAccountLocalCache("account-a")).rejects.toThrow("审核草稿未能清理");
    await expect(loadLocalWorkspace("account-a")).rejects.toBeInstanceOf(LocalAccountDeletedError);
    await expect(getBlob("account-a-original", "account-a")).rejects.toBeInstanceOf(
      LocalAccountDeletedError,
    );
    await expect(
      saveKnowledgeUpdateReviewDraft(session, "note-one", "job-one", entry()),
    ).rejects.toThrow("账号已切换");
    const main = await openDB("conuo-web");
    try {
      expect(await main.get("workspaces", "account:account-a:workspace")).toBeUndefined();
      expect(await main.get("accountDeletions", "account-a")).toEqual({
        schemaVersion: 1,
        accountId: "account-a",
        blocked: true,
      });
      expect(await main.get("blobs", "account-a-original")).toBeUndefined();
    } finally {
      main.close();
    }
    // The failed independent transaction keeps its exact draft; the durable
    // main marker still prevents the deleted account from opening its workspace.
    const drafts = await openDB(KNOWLEDGE_UPDATE_DRAFT_DATABASE, 1);
    try {
      expect(await drafts.get("accounts", JSON.stringify(["account", "account-a"]))).toMatchObject({
        accountId: "account-a",
        drafts: [entry()],
      });
    } finally {
      drafts.close();
    }
    expect(await (await getBlob("account-b-original", "account-b"))!.text()).toBe(
      "B_PRIVATE_BYTES",
    );
    expect(await loadLocalWorkspace("account-b")).not.toBeNull();
    vi.restoreAllMocks();
    await clearAccountLocalCache("account-a");
    await expect(loadLocalWorkspace("account-a")).rejects.toBeInstanceOf(LocalAccountDeletedError);
    await expect(loadKnowledgeUpdateReviewDrafts("account-a")).rejects.toThrow("已注销");
    expect(await loadLocalWorkspace("account-b")).not.toBeNull();
    expect(await (await getBlob("account-b-original", "account-b"))!.text()).toBe(
      "B_PRIVATE_BYTES",
    );
  });

  it("blocks old saves and new loads after deletion, including ordinary later account cleanup", async () => {
    const oldSession = await loadKnowledgeUpdateReviewDrafts("account-a");
    await saveKnowledgeUpdateReviewDraft(oldSession, "note-one", "job-one", entry());
    await clearAccountKnowledgeUpdateReviewDrafts("account-a", { blockReload: true });
    await expect(
      saveKnowledgeUpdateReviewDraft(oldSession, "note-one", "job-one", entry()),
    ).rejects.toThrow();
    await expect(loadKnowledgeUpdateReviewDrafts("account-a")).rejects.toThrow("已注销");
    await clearAccountKnowledgeUpdateReviewDrafts("account-a");
    await expect(loadKnowledgeUpdateReviewDrafts("account-a")).rejects.toThrow("已注销");
    const db = await openDB(KNOWLEDGE_UPDATE_DRAFT_DATABASE, 1);
    try {
      const record = await db.get("accounts", JSON.stringify(["account", "account-a"]));
      expect(record).toMatchObject({ accountId: "account-a", blocked: true, drafts: [] });
      expect(JSON.stringify(record)).not.toContain("我核对后的解释");
    } finally {
      db.close();
    }
  });
});
