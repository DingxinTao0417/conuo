import { openDB, type DBSchema } from "idb";
import { z } from "zod";
import { knowledgeUpdateReviewReason } from "./knowledge-update";
import type { OrganizationJob } from "./organization-types";
import type { WorkspaceData } from "./types";

export interface KnowledgeUpdateReviewDraft {
  selectedChangeIds: string[];
  editedTexts: Record<string, string>;
}

export interface StoredKnowledgeUpdateReviewDraft {
  accountId: string;
  noteId: string;
  jobId: string;
  /** Exact immutable input and suggestion contract, without mutable review history. */
  contract: string;
  draft: KnowledgeUpdateReviewDraft;
}

export interface KnowledgeUpdateDraftSession {
  accountId: string;
  generation: string;
  epoch: number;
  drafts: StoredKnowledgeUpdateReviewDraft[];
}

export const KNOWLEDGE_UPDATE_DRAFT_DATABASE = "conuo-knowledge-review-drafts";
export const MAX_KNOWLEDGE_UPDATE_DRAFTS_PER_ACCOUNT = 32;
export const MAX_KNOWLEDGE_UPDATE_DRAFT_ACCOUNTS = 32;
export const MAX_KNOWLEDGE_UPDATE_DRAFT_DELETION_FENCES = 256;
export const MAX_KNOWLEDGE_UPDATE_DRAFT_CHARACTERS = 4_000_000;

const accountIdSchema = z.string().trim().min(1).max(200);
const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const knowledgeUpdateReviewDraftSchema: z.ZodType<KnowledgeUpdateReviewDraft> = z
  .object({
    selectedChangeIds: z.array(idSchema).max(12),
    editedTexts: z.record(idSchema, z.string().max(6000)),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.selectedChangeIds).size !== value.selectedChangeIds.length)
      ctx.addIssue({ code: "custom", message: "审核草稿包含重复建议。" });
    if (Object.keys(value.editedTexts).length > 12)
      ctx.addIssue({ code: "custom", message: "审核草稿包含过多编辑项。" });
  });

const storedDraftSchema: z.ZodType<StoredKnowledgeUpdateReviewDraft> = z
  .object({
    accountId: accountIdSchema,
    noteId: idSchema,
    jobId: idSchema,
    contract: z.string().min(1).max(1_000_000),
    draft: knowledgeUpdateReviewDraftSchema,
  })
  .strict();

const accountDraftsSchema = z
  .object({
    schemaVersion: z.literal(1),
    accountId: accountIdSchema,
    generation: z.string().min(1).max(100),
    /** Account-deletion fence only; a blocked record contains no draft text. */
    blocked: z.literal(true).optional(),
    drafts: z.array(storedDraftSchema).max(MAX_KNOWLEDGE_UPDATE_DRAFTS_PER_ACCOUNT),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = value.drafts.map((draft) => JSON.stringify([draft.noteId, draft.jobId]));
    if (
      new Set(keys).size !== keys.length ||
      value.drafts.some((draft) => draft.accountId !== value.accountId) ||
      (value.blocked && value.drafts.length > 0)
    )
      ctx.addIssue({ code: "custom", message: "审核草稿的账号或任务身份不一致。" });
  });
type AccountDrafts = z.infer<typeof accountDraftsSchema>;

interface DraftDatabase extends DBSchema {
  accounts: { key: string; value: AccountDrafts };
}

const accountEpochs = new Map<string, number>();

function checkedAccountId(accountId: string): string {
  const parsed = accountIdSchema.safeParse(accountId);
  if (!parsed.success || parsed.data !== accountId) throw new Error("本机审核草稿的账号身份无效。");
  return parsed.data;
}

function accountKey(accountId: string): string {
  return JSON.stringify(["account", checkedAccountId(accountId)]);
}

function epochFor(accountId: string): number {
  return accountEpochs.get(accountId) ?? 0;
}

function database() {
  if (typeof indexedDB === "undefined") throw new Error("此浏览器无法保存本机审核草稿。");
  return openDB<DraftDatabase>(KNOWLEDGE_UPDATE_DRAFT_DATABASE, 1, {
    upgrade(db) {
      db.createObjectStore("accounts");
    },
  });
}

function checkedRecord(value: unknown, accountId: string): AccountDrafts {
  const parsed = accountDraftsSchema.safeParse(value);
  if (!parsed.success || parsed.data.accountId !== accountId)
    throw new Error("本机审核草稿格式无效，未覆盖已保存的记录。");
  return parsed.data;
}

function generation(): string {
  // A compare token, not a credential. The account record must already exist
  // before a save can use this token; deletion therefore fences old writers.
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function capacityError(): Error {
  return new Error("本机审核草稿已达到保存容量，当前编辑仍保留在页面中。");
}

async function enforceCapacity(
  store: { getAll: () => Promise<AccountDrafts[]> },
  next: AccountDrafts,
): Promise<void> {
  const records = await store.getAll();
  const others = records.filter((record) => record.accountId !== next.accountId);
  const activeAccounts = [next, ...others].filter((record) => !record.blocked).length;
  const deletionFences = [next, ...others].filter((record) => record.blocked).length;
  if (
    activeAccounts > MAX_KNOWLEDGE_UPDATE_DRAFT_ACCOUNTS ||
    deletionFences > MAX_KNOWLEDGE_UPDATE_DRAFT_DELETION_FENCES
  )
    throw capacityError();
  const characters = [next, ...others].reduce(
    (total, record) => total + JSON.stringify(record).length,
    0,
  );
  if (characters > MAX_KNOWLEDGE_UPDATE_DRAFT_CHARACTERS) throw capacityError();
}

/** Creates a local generation before returning. Old generations cannot recreate cleared records. */
export async function loadKnowledgeUpdateReviewDrafts(
  accountId: string,
): Promise<KnowledgeUpdateDraftSession> {
  const key = accountKey(accountId);
  const epoch = epochFor(accountId);
  const db = await database();
  const tx = db.transaction("accounts", "readwrite");
  try {
    const stored = await tx.store.get(key);
    if (epoch !== epochFor(accountId)) throw new Error("账号已切换，停止读取旧审核草稿。");
    const record =
      stored !== undefined
        ? checkedRecord(stored, accountId)
        : { schemaVersion: 1 as const, accountId, generation: generation(), drafts: [] };
    if ("blocked" in record && record.blocked)
      throw new Error("该账号已注销，本机审核草稿不能重新读取或创建。");
    if (stored === undefined) {
      await enforceCapacity(tx.store, record);
      await tx.store.put(record, key);
    }
    await tx.done;
    return { accountId, generation: record.generation, epoch, drafts: record.drafts };
  } catch (cause) {
    try {
      tx.abort();
    } catch {
      // A failed request may already have aborted the transaction.
    }
    await tx.done.catch(() => {});
    throw cause;
  } finally {
    db.close();
  }
}

/** Merges one exact task in a serialized transaction; never overwrites another account or task. */
export async function saveKnowledgeUpdateReviewDraft(
  session: KnowledgeUpdateDraftSession,
  noteId: string,
  jobId: string,
  entry: StoredKnowledgeUpdateReviewDraft | null,
): Promise<void> {
  const key = accountKey(session.accountId);
  idSchema.parse(noteId);
  idSchema.parse(jobId);
  const snapshot = entry ? storedDraftSchema.parse(structuredClone(entry)) : null;
  if (
    snapshot &&
    (snapshot.accountId !== session.accountId ||
      snapshot.noteId !== noteId ||
      snapshot.jobId !== jobId)
  )
    throw new Error("审核草稿的目标身份不一致。");
  if (session.epoch !== epochFor(session.accountId))
    throw new Error("账号已切换，未保存旧审核草稿。");
  const db = await database();
  const tx = db.transaction("accounts", "readwrite");
  try {
    const stored = await tx.store.get(key);
    if (stored?.blocked) throw new Error("该账号已注销，本机审核草稿不能重新保存。");
    if (
      !stored ||
      stored.generation !== session.generation ||
      session.epoch !== epochFor(session.accountId)
    )
      throw new Error("本机审核草稿已被清理，未重新创建旧记录。");
    const current = checkedRecord(stored, session.accountId);
    const drafts = current.drafts.filter(
      (draft) => draft.noteId !== noteId || draft.jobId !== jobId,
    );
    if (snapshot) drafts.push(snapshot);
    const next = accountDraftsSchema.parse({ ...current, drafts });
    if (snapshot) await enforceCapacity(tx.store, next);
    if (session.epoch !== epochFor(session.accountId))
      throw new Error("账号已切换，未保存旧审核草稿。");
    await tx.store.put(next, key);
    await tx.done;
  } catch (cause) {
    try {
      tx.abort();
    } catch {
      // A failed request may already have aborted the transaction.
    }
    await tx.done.catch(() => {});
    throw cause;
  } finally {
    db.close();
  }
}

/** Synchronously invalidates local callbacks, then deletes only this account's draft record. */
export async function clearAccountKnowledgeUpdateReviewDrafts(
  accountId: string,
  options: { blockReload?: boolean } = {},
): Promise<void> {
  const key = accountKey(accountId);
  accountEpochs.set(accountId, epochFor(accountId) + 1);
  const db = await database();
  const tx = db.transaction("accounts", "readwrite");
  try {
    const stored = await tx.store.get(key);
    if (options.blockReload) {
      const fence: AccountDrafts = {
        schemaVersion: 1,
        accountId,
        generation: generation(),
        blocked: true,
        drafts: [],
      };
      await enforceCapacity(tx.store, fence);
      await tx.store.put(fence, key);
    } else if (!stored?.blocked) {
      await tx.store.delete(key);
    }
    await tx.done;
  } catch (cause) {
    try {
      tx.abort();
    } catch {
      /* The failed request may already have aborted. */
    }
    await tx.done.catch(() => {});
    throw new Error("本机审核草稿未能清理，请重试本机数据清理。", { cause });
  } finally {
    db.close();
  }
}

export function knowledgeUpdateDraftKey(accountId: string, noteId: string, jobId: string): string {
  return JSON.stringify([accountId, noteId, jobId]);
}

export function knowledgeUpdateDraftContract(job: OrganizationJob): string {
  return JSON.stringify([job.createdAt, job.request, job.result], (_key, value: unknown) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const fields = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(fields)
          .sort()
          .map((key) => [key, fields[key]]),
      );
    }
    return value;
  });
}

/** Current review validity plus an exact contract prevents edits crossing reused job IDs. */
export function currentKnowledgeUpdateReviewDraft(
  data: WorkspaceData,
  entry: StoredKnowledgeUpdateReviewDraft,
  accountId: string,
): StoredKnowledgeUpdateReviewDraft | null {
  if (entry.accountId !== accountId) return null;
  const job = data.organizationJobs?.find((item) => item.id === entry.jobId);
  if (
    !job ||
    job.status !== "ready" ||
    job.request.kind !== "update" ||
    job.request.targetNote?.id !== entry.noteId ||
    job.result?.kind !== "update" ||
    job.result.target.id !== entry.noteId ||
    knowledgeUpdateDraftContract(job) !== entry.contract ||
    knowledgeUpdateReviewReason(data, job)
  )
    return null;
  const reviewed = new Set([
    ...(job.updateReview?.applied.map((change) => change.changeId) ?? []),
    ...(job.updateReview?.ignored ?? []),
  ]);
  const ids = new Set(
    job.result.changes.filter((change) => !reviewed.has(change.id)).map((change) => change.id),
  );
  const draft = knowledgeUpdateReviewDraftSchema.safeParse(entry.draft);
  if (!draft.success) return null;
  const selectedChangeIds = draft.data.selectedChangeIds.filter((id) => ids.has(id));
  const editedTexts = Object.fromEntries(
    Object.entries(draft.data.editedTexts).filter(([id]) => ids.has(id)),
  );
  if (!selectedChangeIds.length && !Object.keys(editedTexts).length) return null;
  return { ...entry, draft: { selectedChangeIds, editedTexts } };
}
