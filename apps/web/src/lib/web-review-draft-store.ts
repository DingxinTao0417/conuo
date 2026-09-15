import { z } from "zod";
import {
  MAX_KNOWLEDGE_UPDATE_DRAFT_ACCOUNTS,
  MAX_KNOWLEDGE_UPDATE_DRAFT_CHARACTERS,
  MAX_KNOWLEDGE_UPDATE_DRAFT_DELETION_FENCES,
  MAX_KNOWLEDGE_UPDATE_DRAFTS_PER_ACCOUNT,
  knowledgeUpdateDraftKey,
  knowledgeUpdateReviewDraftSchema,
  type clearAccountKnowledgeUpdateReviewDrafts,
  type loadKnowledgeUpdateReviewDrafts,
  type saveKnowledgeUpdateReviewDraft,
  type StoredKnowledgeUpdateReviewDraft,
} from "./knowledge-update-review-drafts";

/** Drafts are transient UI state; accepted knowledge changes still use the cloud workspace. */
export interface KnowledgeUpdateReviewDraftStore {
  load: typeof loadKnowledgeUpdateReviewDrafts;
  save: typeof saveKnowledgeUpdateReviewDraft;
  clear: typeof clearAccountKnowledgeUpdateReviewDrafts;
}

interface AccountDrafts {
  accountId: string;
  generation: string;
  blocked?: boolean;
  drafts: StoredKnowledgeUpdateReviewDraft[];
}

const accountIdSchema = z.string().trim().min(1).max(200);
const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const storedDraftSchema: z.ZodType<StoredKnowledgeUpdateReviewDraft> = z
  .object({
    accountId: accountIdSchema,
    noteId: idSchema,
    jobId: idSchema,
    contract: z.string().min(1).max(1_000_000),
    draft: knowledgeUpdateReviewDraftSchema,
  })
  .strict();

function checkedAccountId(accountId: string): string {
  const parsed = accountIdSchema.safeParse(accountId);
  if (!parsed.success || parsed.data !== accountId) throw new Error("审核草稿的账号身份无效。");
  return parsed.data;
}

function accountKey(accountId: string): string {
  return JSON.stringify(["account", checkedAccountId(accountId)]);
}

function generation(): string {
  // Compare tokens fence stale callbacks. They grant no external account access.
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function capacityError(): Error {
  return new Error("当前页面的审核草稿已达到容量，已有编辑仍保留在页面中。");
}

/** One page's store: no IndexedDB, localStorage, sessionStorage, filesystem, or network access. */
export function createWebReviewDraftStore(): KnowledgeUpdateReviewDraftStore {
  const accounts = new Map<string, AccountDrafts>();
  const epochs = new Map<string, number>();

  function epochFor(accountId: string): number {
    return epochs.get(accountId) ?? 0;
  }

  function assertCapacity(key: string, next: AccountDrafts): void {
    const records = [
      next,
      ...[...accounts.entries()].filter(([id]) => id !== key).map(([, record]) => record),
    ];
    if (
      next.drafts.length > MAX_KNOWLEDGE_UPDATE_DRAFTS_PER_ACCOUNT ||
      records.filter((record) => !record.blocked).length > MAX_KNOWLEDGE_UPDATE_DRAFT_ACCOUNTS ||
      records.filter((record) => record.blocked).length >
        MAX_KNOWLEDGE_UPDATE_DRAFT_DELETION_FENCES ||
      records.reduce((total, record) => total + JSON.stringify(record).length, 0) >
        MAX_KNOWLEDGE_UPDATE_DRAFT_CHARACTERS
    )
      throw capacityError();
  }

  const store: KnowledgeUpdateReviewDraftStore = {
    async load(accountId) {
      const key = accountKey(accountId);
      let record = accounts.get(key);
      if (record?.blocked) throw new Error("该账号已注销，审核草稿不能重新读取或创建。");
      if (!record) {
        record = { accountId, generation: generation(), drafts: [] };
        assertCapacity(key, record);
        accounts.set(key, record);
      }
      return {
        accountId,
        generation: record.generation,
        epoch: epochFor(accountId),
        drafts: structuredClone(record.drafts),
      };
    },

    async save(session, noteId, jobId, entry) {
      const key = accountKey(session.accountId);
      idSchema.parse(noteId);
      idSchema.parse(jobId);
      if (!Number.isSafeInteger(session.epoch) || session.epoch < 0)
        throw new Error("审核草稿会话身份无效。");
      const snapshot = entry ? storedDraftSchema.parse(structuredClone(entry)) : null;
      if (
        snapshot &&
        (snapshot.accountId !== session.accountId ||
          snapshot.noteId !== noteId ||
          snapshot.jobId !== jobId)
      )
        throw new Error("审核草稿的目标身份不一致。");
      const record = accounts.get(key);
      if (record?.blocked) throw new Error("该账号已注销，审核草稿不能重新保存。");
      if (
        !record ||
        record.generation !== session.generation ||
        session.epoch !== epochFor(session.accountId)
      )
        throw new Error("审核草稿已被清理，未重新创建旧记录。");
      const target = knowledgeUpdateDraftKey(session.accountId, noteId, jobId);
      const drafts = record.drafts.filter(
        (draft) => knowledgeUpdateDraftKey(draft.accountId, draft.noteId, draft.jobId) !== target,
      );
      if (snapshot) drafts.push(snapshot);
      const next = { ...record, drafts };
      assertCapacity(key, next);
      // No await inside the operation: validation, merge, and publication are one atomic page turn.
      accounts.set(key, next);
    },

    async clear(accountId, options = {}) {
      const key = accountKey(accountId);
      epochs.set(accountId, epochFor(accountId) + 1);
      const record = accounts.get(key);
      if (options.blockReload) {
        const fence: AccountDrafts = {
          accountId,
          generation: generation(),
          blocked: true,
          drafts: [],
        };
        assertCapacity(key, fence);
        accounts.set(key, fence);
      } else if (!record?.blocked) {
        accounts.delete(key);
      }
    },
  };
  return store;
}

export const webReviewDraftStore = createWebReviewDraftStore();
