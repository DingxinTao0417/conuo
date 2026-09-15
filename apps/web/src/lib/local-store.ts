import { openDB, type DBSchema } from "idb";
import { workspaceSchema } from "./supabase/validation";
import type { WorkspaceData } from "./types";
import { clearAccountKnowledgeUpdateReviewDrafts } from "./knowledge-update-review-drafts";

interface ConuoDatabase extends DBSchema {
  workspaces: { key: string; value: StoredLocalWorkspace };
  blobs: { key: string; value: Blob | OwnedOriginal };
  accountDeletions: { key: string; value: LocalAccountDeletionMarker };
}

type LocalAccountDeletionMarker = { schemaVersion: 1; accountId: string; blocked: true };

type AccountDeletionStore = { get: (key: string) => Promise<unknown> };
type LocalTransaction = { abort: () => void; done: Promise<void> };

export class LocalAccountDeletedError extends Error {
  readonly code = "LOCAL_ACCOUNT_DELETED";
  constructor() {
    super("该账号已提交注销，本机资料已停止访问，不能重新创建或保存。");
    this.name = "LocalAccountDeletedError";
  }
}

function deletionAccountId(accountId: string): string {
  if (
    !accountId ||
    accountId.trim() !== accountId ||
    accountId === "local" ||
    accountId.startsWith("recovery:")
  )
    throw new Error("清理失败：账户身份无效。");
  return accountId;
}

/** Recovery IDs encode owner, timestamp, and token; owner IDs themselves may contain colons. */
function workspaceOwner(accountId: string): string {
  if (!accountId.startsWith("recovery:")) {
    if (accountId === "local") return accountId;
    return deletionAccountId(accountId);
  }
  const parts = accountId.slice("recovery:".length);
  const tokenSeparator = parts.lastIndexOf(":");
  const timestampSeparator = parts.lastIndexOf(":", tokenSeparator - 1);
  if (
    timestampSeparator < 1 ||
    tokenSeparator === parts.length - 1 ||
    tokenSeparator <= timestampSeparator + 1
  )
    throw new Error("恢复副本的所属账号无效，不能读取或保存。");
  return deletionAccountId(parts.slice(0, timestampSeparator));
}

function checkedDeletionMarker(value: unknown, accountId: string): boolean {
  if (value === undefined) return false;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("|") !== "accountId|blocked|schemaVersion" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("accountId" in value) ||
    value.accountId !== accountId ||
    !("blocked" in value) ||
    value.blocked !== true
  )
    throw new Error("本机账号注销标记无效，已停止读取和写入，请检查本站存储。");
  return true;
}

async function assertAccountAvailable(
  store: AccountDeletionStore,
  accountId: string,
): Promise<void> {
  const owner = workspaceOwner(accountId);
  if (owner !== "local" && checkedDeletionMarker(await store.get(owner), owner))
    throw new LocalAccountDeletedError();
}

async function abortAndObserve(tx: LocalTransaction): Promise<void> {
  try {
    tx.abort();
  } catch {
    /* A failed request may already have aborted. */
  }
  await tx.done.catch(() => undefined);
}

/** Provenance is written with bytes by a local admission, never inferred from cloud JSON. */
type OwnedOriginal = { schemaVersion: 1; blob: Blob; ownerIds: string[] };

function originalOwner(accountId: string): string {
  if (!accountId.trim() || accountId.startsWith("recovery:"))
    throw new Error("原件读取失败：缺少有效的所属账号。");
  return accountId;
}

function ownedOriginal(value: Blob | OwnedOriginal | undefined): value is OwnedOriginal {
  return (
    !!value &&
    !(value instanceof Blob) &&
    value.schemaVersion === 1 &&
    value.blob instanceof Blob &&
    Array.isArray(value.ownerIds) &&
    value.ownerIds.every((owner) => typeof owner === "string" && !!owner.trim())
  );
}

/**
 * The account save coordinator stores its sync fence beside the workspace. The
 * local-store boundary deliberately does not interpret that metadata, but an
 * atomic read/merge/write must preserve the exact persisted record supplied by
 * the caller instead of silently stripping it.
 */
export type StoredLocalWorkspace = WorkspaceData & {
  _conuoSync?: unknown;
  /** IndexedDB-only compare-and-swap fence; never enters business data or cloud payloads. */
  _conuoLocalRevision?: number;
};

export interface LocalImportCommitPlan<TResult> {
  /** Exact record to persist, including any caller-owned persistence metadata. */
  workspace: StoredLocalWorkspace;
  /** Whether this transaction must reserve the supplied immutable original. */
  storeBlob: boolean;
  /** Domain result returned only after the whole IndexedDB transaction commits. */
  result: TResult;
}

export interface LocalImportCommitResult<TResult> {
  workspace: StoredLocalWorkspace;
  localRevision: number;
  blobStored: boolean;
  result: TResult;
}

export type LocalImportMerger<TResult> = (
  latest: StoredLocalWorkspace | null,
) => LocalImportCommitPlan<TResult>;

/**
 * A small invalidation signal for other tabs. Workspace contents deliberately
 * never cross this channel; consumers reload the committed IndexedDB record.
 */
export interface LocalWorkspaceCommitEvent {
  accountId: string;
  localRevision: number;
  writerId: string;
}

export type LocalWorkspaceCommitListener = (event: LocalWorkspaceCommitEvent) => void;

const LOCAL_WORKSPACE_COMMIT_CHANNEL = "conuo-local-workspace-commits-v1";
let localWorkspaceWriterId: string | undefined;

function currentLocalWorkspaceWriterId(): string {
  if (localWorkspaceWriterId) return localWorkspaceWriterId;
  try {
    localWorkspaceWriterId = window.crypto.randomUUID();
  } catch {
    // The ID only distinguishes same-origin writers; it is not a credential.
    localWorkspaceWriterId = `writer-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2)}`;
  }
  return localWorkspaceWriterId;
}

function openLocalWorkspaceCommitChannel(): BroadcastChannel | null {
  // Referencing the browser constructor through window avoids accidentally
  // opening Node's BroadcastChannel during SSR or unit tests.
  if (typeof window === "undefined" || typeof window.BroadcastChannel !== "function") return null;
  try {
    return new window.BroadcastChannel(LOCAL_WORKSPACE_COMMIT_CHANNEL);
  } catch {
    return null;
  }
}

function parseLocalWorkspaceCommitEvent(value: unknown): LocalWorkspaceCommitEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = Object.keys(value).sort();
  if (
    fields.length !== 3 ||
    fields[0] !== "accountId" ||
    fields[1] !== "localRevision" ||
    fields[2] !== "writerId"
  )
    return null;
  const event = value as Record<string, unknown>;
  if (
    typeof event.accountId !== "string" ||
    !event.accountId.trim() ||
    !Number.isSafeInteger(event.localRevision) ||
    Number(event.localRevision) <= 0 ||
    typeof event.writerId !== "string" ||
    !event.writerId.trim()
  )
    return null;
  return {
    accountId: event.accountId,
    localRevision: Number(event.localRevision),
    writerId: event.writerId,
  };
}

function publishLocalWorkspaceCommit(accountId: string, localRevision: number): void {
  const channel = openLocalWorkspaceCommitChannel();
  if (!channel) return;
  try {
    channel.postMessage({
      accountId,
      localRevision,
      writerId: currentLocalWorkspaceWriterId(),
    } satisfies LocalWorkspaceCommitEvent);
  } catch {
    // Cross-tab invalidation is best effort. IndexedDB CAS remains authoritative.
  } finally {
    try {
      channel.close();
    } catch {
      // A broken channel must not turn a committed save into a reported failure.
    }
  }
}

/**
 * Subscribes to committed writes for one exact account from other writers.
 * Revisions are intentionally not ordered or deduplicated here so consumers
 * can compare them with the revision of the workspace they currently hold.
 */
export function subscribeLocalWorkspaceCommits(
  accountId: string,
  listener: LocalWorkspaceCommitListener,
): () => void {
  if (!accountId.trim()) throw new Error("订阅失败：缺少工作区身份。");
  if (typeof listener !== "function") throw new TypeError("订阅失败：缺少事件处理函数。");
  const channel = openLocalWorkspaceCommitChannel();
  if (!channel) return () => undefined;
  const writerId = currentLocalWorkspaceWriterId();
  let closed = false;
  const onMessage = (message: MessageEvent<unknown>) => {
    const event = parseLocalWorkspaceCommitEvent(message.data);
    if (!event || event.accountId !== accountId || event.writerId === writerId) return;
    listener(event);
  };
  try {
    channel.addEventListener("message", onMessage);
  } catch {
    try {
      channel.close();
    } catch {
      // The unsupported channel has no remaining usable resources to release.
    }
    return () => undefined;
  }
  return () => {
    if (closed) return;
    closed = true;
    try {
      channel.removeEventListener("message", onMessage);
    } catch {
      // Closing below still releases a partially broken channel.
    } finally {
      try {
        channel.close();
      } catch {
        // Cleanup is idempotent even for partially broken implementations.
      }
    }
  };
}

// Account IDs are part of every workspace key. A cloud account never loads the
// anonymous local workspace, even when both are used in the same browser.
function workspaceKey(accountId: string): string {
  if (!accountId.trim()) throw new Error("保存失败：缺少工作区身份。");
  return accountId === "local" ? "local:workspace" : `account:${accountId}:workspace`;
}

function accountWorkspaceKey(accountId: string): string {
  // Account deletion must never be able to target the anonymous workspace or
  // an explicit recovery copy. Recovery snapshots are cleared only through
  // their owning account's current workspace key.
  return workspaceKey(deletionAccountId(accountId));
}

function isAccountRecoveryWorkspaceKey(key: string, accountId: string): boolean {
  const prefix = "account:recovery:";
  const suffix = ":workspace";
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) return false;
  const recoveryParts = key.slice(prefix.length, -suffix.length);
  const tokenSeparator = recoveryParts.lastIndexOf(":");
  const timestampSeparator = recoveryParts.lastIndexOf(":", tokenSeparator - 1);
  return timestampSeparator >= 0 && recoveryParts.slice(0, timestampSeparator) === accountId;
}

function parseStoredWorkspace(value: unknown) {
  // Cloud, recovery and IndexedDB records can carry these persistence-only
  // fields. Keep the business schema strict for every other unexpected field.
  if (!value || typeof value !== "object" || Array.isArray(value))
    return workspaceSchema.safeParse(value);
  const workspace = { ...(value as Record<string, unknown>) };
  delete workspace._conuoSync;
  delete workspace._conuoLocalRevision;
  return workspaceSchema.safeParse(workspace);
}

function storedLocalRevision(value: unknown): number {
  if (!value || typeof value !== "object" || !("_conuoLocalRevision" in value)) return 0;
  const revision = value._conuoLocalRevision;
  if (!Number.isSafeInteger(revision) || Number(revision) < 0)
    throw new Error("本机工作区版本无效，无法安全保存。请先导出备份并重新载入。");
  return Number(revision);
}

export class LocalWorkspaceConflictError extends Error {
  readonly code = "LOCAL_WORKSPACE_CONFLICT";
  constructor() {
    super("另一个标签页已更新本机工作区，未覆盖较新的资料。请重新载入后继续。");
    this.name = "LocalWorkspaceConflictError";
  }
}

function referencedBlobKeys(data: WorkspaceData): Set<string> {
  const keys = new Set<string>();
  for (const source of data.sources) {
    if (source.blobKey) keys.add(source.blobKey);
    for (const version of source.versions ?? []) {
      if (version.blobKey) keys.add(version.blobKey);
    }
  }
  return keys;
}

function database() {
  if (typeof indexedDB === "undefined") {
    throw new Error("此浏览器无法使用本地存储。请允许网站保存数据后重试。");
  }
  return openDB<ConuoDatabase>("conuo-web", 2, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore("workspaces");
        db.createObjectStore("blobs");
      }
      if (oldVersion < 2) db.createObjectStore("accountDeletions");
    },
  });
}

const LOCAL_ACCOUNT_DELETION_CHANNEL = "conuo-local-account-deletions-v1";

function openLocalAccountDeletionChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof window.BroadcastChannel !== "function") return null;
  try {
    return new window.BroadcastChannel(LOCAL_ACCOUNT_DELETION_CHANNEL);
  } catch {
    return null;
  }
}

function publishLocalAccountDeletion(accountId: string): void {
  const channel = openLocalAccountDeletionChannel();
  if (!channel) return;
  try {
    channel.postMessage({ schemaVersion: 1, accountId, writerId: currentLocalWorkspaceWriterId() });
  } catch {
    // Notifications are hints; the committed marker remains authoritative.
  } finally {
    try {
      channel.close();
    } catch {
      /* Do not turn a durable marker into a false failure. */
    }
  }
}

/** Reading errors and damaged records reject; only an absent marker means available. */
export async function isAccountLocallyDeleted(accountId: string): Promise<boolean> {
  if (accountId === "local") return false;
  const owner = deletionAccountId(accountId);
  const db = await database();
  try {
    return checkedDeletionMarker(await db.get("accountDeletions", owner), owner);
  } finally {
    db.close();
  }
}

/** Idempotent identity-only fence; every admission checks this store in its own transaction. */
export async function markAccountLocalDeletion(accountId: string): Promise<void> {
  const owner = deletionAccountId(accountId);
  const db = await database();
  const tx = db.transaction("accountDeletions", "readwrite");
  try {
    const exists = checkedDeletionMarker(await tx.store.get(owner), owner);
    if (!exists) await tx.store.put({ schemaVersion: 1, accountId: owner, blocked: true }, owner);
    await tx.done;
    publishLocalAccountDeletion(owner);
  } catch (cause) {
    await abortAndObserve(tx);
    throw cause;
  } finally {
    db.close();
  }
}

/** A message alone never authorizes redaction: verify the exact owner's durable marker first. */
export function subscribeLocalAccountDeletions(
  accountId: string,
  listener: () => void,
): () => void {
  if (accountId === "local") return () => undefined;
  const owner = deletionAccountId(accountId);
  if (typeof listener !== "function") throw new TypeError("订阅失败：缺少事件处理函数。");
  const channel = openLocalAccountDeletionChannel();
  if (!channel) return () => undefined;
  let closed = false;
  const onMessage = (message: MessageEvent<unknown>) => {
    const value = message.data;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join("|") !== "accountId|schemaVersion|writerId" ||
      !("schemaVersion" in value) ||
      value.schemaVersion !== 1 ||
      !("accountId" in value) ||
      value.accountId !== owner ||
      !("writerId" in value) ||
      typeof value.writerId !== "string" ||
      !value.writerId.trim()
    )
      return;
    void isAccountLocallyDeleted(owner)
      .then((blocked) => {
        if (!closed && blocked) listener();
      })
      .catch(() => {
        // Failed verification cannot upgrade an unauthoritative message into deletion.
      });
  };
  try {
    channel.addEventListener("message", onMessage);
  } catch {
    try {
      channel.close();
    } catch {
      /* A broken channel is no longer usable. */
    }
    return () => undefined;
  }
  return () => {
    if (closed) return;
    closed = true;
    try {
      channel.removeEventListener("message", onMessage);
    } catch {
      /* Close still releases it. */
    }
    try {
      channel.close();
    } catch {
      /* Cleanup remains idempotent. */
    }
  };
}

export async function loadLocalWorkspaceRecord(
  accountId = "local",
): Promise<StoredLocalWorkspace | null> {
  const key = workspaceKey(accountId);
  const db = await database();
  const tx = db.transaction(["workspaces", "accountDeletions"], "readonly");
  try {
    await assertAccountAvailable(tx.objectStore("accountDeletions"), accountId);
    const result = await tx.objectStore("workspaces").get(key);
    if (!result) {
      await tx.done;
      return null;
    }
    if (result.schemaVersion !== 1) throw new Error("本地资料格式暂不受支持，请先导出备份。");
    storedLocalRevision(result);
    await tx.done;
    return result;
  } catch (cause) {
    await abortAndObserve(tx);
    throw cause;
  } finally {
    db.close();
  }
}

export async function loadLocalWorkspace(accountId = "local"): Promise<WorkspaceData | null> {
  const result = await loadLocalWorkspaceRecord(accountId);
  if (!result) return null;
  const workspace = { ...result };
  delete workspace._conuoLocalRevision;
  return workspace;
}

export async function saveLocalWorkspace(
  data: WorkspaceData,
  accountId = "local",
  expectedLocalRevision?: number,
): Promise<number> {
  if (
    expectedLocalRevision !== undefined &&
    (!Number.isSafeInteger(expectedLocalRevision) || expectedLocalRevision < 0)
  )
    throw new Error("保存失败：本机工作区预期版本无效。");
  const key = workspaceKey(accountId);
  // Snapshot before awaiting IndexedDB: subsequent React edits must not change
  // the contents of an already requested save.
  const snapshot = structuredClone(data) as StoredLocalWorkspace;
  delete snapshot._conuoLocalRevision;
  const db = await database();
  const tx = db.transaction(["workspaces", "accountDeletions"], "readwrite");
  try {
    await assertAccountAvailable(tx.objectStore("accountDeletions"), accountId);
    const workspaces = tx.objectStore("workspaces");
    const current = await workspaces.get(key);
    const currentRevision = storedLocalRevision(current);
    if (expectedLocalRevision !== undefined && expectedLocalRevision !== currentRevision) {
      tx.abort();
      try {
        await tx.done;
      } catch {
        // The domain conflict below is the useful result.
      }
      throw new LocalWorkspaceConflictError();
    }
    const localRevision = currentRevision + 1;
    await workspaces.put({ ...snapshot, _conuoLocalRevision: localRevision }, key);
    await tx.done;
    publishLocalWorkspaceCommit(accountId, localRevision);
    return localRevision;
  } catch (cause) {
    await abortAndObserve(tx);
    throw cause;
  } finally {
    db.close();
  }
}

function checkedImportWorkspace(value: unknown, phase: "current" | "next"): StoredLocalWorkspace {
  const parsed = parseStoredWorkspace(value);
  if (parsed.success) return value as StoredLocalWorkspace;
  if (phase === "current")
    throw new Error("本机工作区格式无效，无法安全合并导入。请先导出备份并重新载入。");
  throw new Error("导入合并结果格式无效，未保存原文件或工作区。");
}

function constraintError(cause: unknown): boolean {
  return (
    !!cause && typeof cause === "object" && "name" in cause && cause.name === "ConstraintError"
  );
}

/**
 * Commits one prepared local import against the newest account snapshot.
 *
 * IndexedDB serializes readwrite transactions whose object-store scopes
 * overlap, so separate tabs cannot both make their duplicate/quota decision
 * from the same stale workspace. `merge` must be synchronous: it rechecks the
 * prepared import against `latest` and returns the exact persistence record,
 * including caller-owned `_conuoSync` metadata. Throwing rejects the admission.
 *
 * When `storeBlob` is true, the immutable original and workspace reference are
 * written in this same transaction. A blob collision or workspace write error
 * aborts both writes, so this operation cannot leave a newly orphaned original.
 */
export async function commitLocalImport<TResult>(
  accountId: string,
  blobKey: string,
  blob: Blob,
  merge: LocalImportMerger<TResult>,
): Promise<LocalImportCommitResult<TResult>> {
  const key = workspaceKey(accountId);
  if (!blobKey) throw new Error("保存原文件失败：缺少文件标识。");
  if (typeof merge !== "function") throw new TypeError("缺少本机导入合并函数。");

  const db = await database();
  const tx = db.transaction(["blobs", "workspaces", "accountDeletions"], "readwrite");
  const done = tx.done;
  try {
    await assertAccountAvailable(tx.objectStore("accountDeletions"), accountId);
    const workspaces = tx.objectStore("workspaces");
    const blobs = tx.objectStore("blobs");
    const stored = await workspaces.get(key);
    const latest = stored === undefined ? null : checkedImportWorkspace(stored, "current");
    const currentLocalRevision = storedLocalRevision(stored);
    const plan = merge(latest);
    if (
      !plan ||
      typeof plan !== "object" ||
      typeof plan.storeBlob !== "boolean" ||
      !("workspace" in plan)
    )
      throw new TypeError("本机导入合并函数返回了无效结果。");
    const storeBlob = plan.storeBlob;
    const result = plan.result;

    // Clone before issuing either write. Besides freezing the exact return
    // value, this also surfaces most non-cloneable persistence metadata while
    // the transaction can still be explicitly aborted.
    const next = structuredClone(plan.workspace);
    const localRevision = currentLocalRevision + 1;
    next._conuoLocalRevision = localRevision;
    const parsedNext = parseStoredWorkspace(next);
    if (!parsedNext.success) checkedImportWorkspace(next, "next");
    const referencesOriginal =
      parsedNext.success && referencedBlobKeys(parsedNext.data).has(blobKey);
    if (storeBlob && !referencesOriginal)
      throw new Error("导入工作区没有引用待保存的原文件，已取消整次写入。");

    if (storeBlob) {
      try {
        await blobs.add({ schemaVersion: 1, blob, ownerIds: [originalOwner(accountId)] }, blobKey);
      } catch (cause) {
        if (constraintError(cause)) throw new Error("原文件标识已存在，已有原件和工作区均未修改。");
        throw cause;
      }
    } else if (referencesOriginal && (await blobs.getKey(blobKey)) === undefined) {
      throw new Error("导入工作区引用的原文件不存在，已取消整次写入。");
    }

    await workspaces.put(next, key);
    await done;
    publishLocalWorkspaceCommit(accountId, localRevision);
    return { workspace: next, localRevision, blobStored: storeBlob, result };
  } catch (cause) {
    // Preserve the domain error even if aborting an already-failed transaction
    // itself throws. Observing `done` also prevents an unhandled rejection.
    try {
      tx.abort();
    } catch {
      // The request may already have caused an automatic abort.
    }
    try {
      await done;
    } catch {
      // The original request/callback error is more useful to the caller.
    }
    throw cause;
  } finally {
    db.close();
  }
}

/**
 * Removes an authenticated account's current browser workspace, its recovery
 * snapshots, and every original whose admission proves that account's ownership.
 * `retainedBlobs` counts existing candidate blobs kept because another record
 * owns them or cannot be read.
 */
export async function clearAccountLocalCache(
  accountId: string,
): Promise<{ deletedBlobs: number; retainedBlobs: number }> {
  const key = accountWorkspaceKey(accountId);
  // Make the fence durable before any cleanup that could fail. Main-cache and
  // independent review-draft cleanup are both attempted; neither hides failure.
  await markAccountLocalDeletion(accountId);
  const [main, drafts, legacy] = await Promise.allSettled([
    clearAccountWorkspaceAndOriginals(accountId, key),
    clearAccountKnowledgeUpdateReviewDrafts(accountId, { blockReload: true }),
    clearLegacyAccountSyncCache(accountId),
  ]);
  const failures = [main, drafts, legacy].flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 1)
    throw new AggregateError(failures, "本机缓存与审核草稿未能完全清理，请检查本站存储。");
  if (failures.length === 1) throw failures[0];
  if (main.status === "rejected") throw main.reason;
  return main.value;
}

async function clearLegacyAccountSyncCache(accountId: string): Promise<void> {
  // Older clients may have stored an entire dirty base under this exact key.
  // Do not enumerate/delete another account's legacy data or site preferences.
  const storage = typeof window === "undefined" ? null : window.localStorage;
  storage?.removeItem("conuo.sync." + accountId);
}

async function clearAccountWorkspaceAndOriginals(
  accountId: string,
  key: string,
): Promise<{ deletedBlobs: number; retainedBlobs: number }> {
  const db = await database();
  const tx = db.transaction(["blobs", "workspaces", "accountDeletions"], "readwrite");
  try {
    // The cleanup shares the same scope as every guarded read/write admission.
    if (!checkedDeletionMarker(await tx.objectStore("accountDeletions").get(accountId), accountId))
      throw new Error("清理失败：账号注销标记缺失。");
    const workspaces = tx.objectStore("workspaces");
    const workspaceKeys = await workspaces.getAllKeys();
    const targetKeys = workspaceKeys.filter(
      (workspaceKey) =>
        workspaceKey === key || isAccountRecoveryWorkspaceKey(workspaceKey, accountId),
    );
    const candidates = new Set<string>();
    const blobs = tx.objectStore("blobs");
    const existingKeys = await blobs.getAllKeys();
    const originals = new Map<string, Blob | OwnedOriginal>();
    for (const blobKey of existingKeys) {
      const original = await blobs.get(blobKey);
      if (original === undefined) continue;
      originals.set(blobKey, original);
      if (ownedOriginal(original) && original.ownerIds.includes(accountId)) candidates.add(blobKey);
    }
    for (const targetKey of targetKeys) {
      const target = await workspaces.get(targetKey);
      // A damaged target can still be removed, but it cannot safely nominate
      // any blob for deletion.
      const parsedTarget = parseStoredWorkspace(target);
      if (parsedTarget.success) {
        for (const blobKey of referencedBlobKeys(parsedTarget.data)) candidates.add(blobKey);
      }
      await workspaces.delete(targetKey);
    }
    // Read after removing the target so every record below is an independent
    // owner. Recovery records use ordinary workspace storage and are included.
    const remaining = await workspaces.getAll();
    let unreadableRecord = false;
    const referenced = new Set<string>();
    for (const workspace of remaining) {
      const parsed = parseStoredWorkspace(workspace);
      if (!parsed.success) {
        unreadableRecord = true;
        break;
      }
      for (const blobKey of referencedBlobKeys(parsed.data)) {
        if (candidates.has(blobKey)) referenced.add(blobKey);
      }
    }

    let deletedBlobs = 0;
    let retainedBlobs = 0;
    for (const blobKey of candidates) {
      const original = originals.get(blobKey);
      if (original === undefined) continue;
      if (!ownedOriginal(original) || !original.ownerIds.includes(accountId)) {
        retainedBlobs += 1;
        continue;
      }
      const remainingOwners = original.ownerIds.filter((owner) => owner !== accountId);
      if (unreadableRecord || referenced.has(blobKey) || remainingOwners.length > 0) {
        await blobs.put({ ...original, ownerIds: remainingOwners }, blobKey);
        retainedBlobs += 1;
        continue;
      }
      await blobs.delete(blobKey);
      deletedBlobs += 1;
    }
    await tx.done;
    return { deletedBlobs, retainedBlobs };
  } catch (cause) {
    await abortAndObserve(tx);
    throw cause;
  } finally {
    db.close();
  }
}

export async function putBlob(key: string, blob: Blob, accountId = "local"): Promise<void> {
  if (!(await putBlobIfAbsent(key, blob, accountId)))
    throw new Error("原文件标识已存在，已有原件和所属账号均未修改。");
}

/** Immutable original reservation, atomic across browser tabs. */
export async function putBlobIfAbsent(
  key: string,
  blob: Blob,
  accountId = "local",
): Promise<boolean> {
  if (!key) throw new Error("保存原文件失败：缺少文件标识。");
  const owner = originalOwner(accountId);
  const db = await database();
  const tx = db.transaction(["blobs", "accountDeletions"], "readwrite");
  try {
    await assertAccountAvailable(tx.objectStore("accountDeletions"), owner);
    await tx.objectStore("blobs").add({ schemaVersion: 1, blob, ownerIds: [owner] }, key);
    await tx.done;
    return true;
  } catch (cause) {
    await abortAndObserve(tx);
    if (cause instanceof DOMException && cause.name === "ConstraintError") return false;
    throw cause;
  } finally {
    db.close();
  }
}

/** Only for an uncommitted original created by this operation. Callers also check live memory. */
export async function deleteUnreferencedBlob(key: string, accountId = "local"): Promise<boolean> {
  if (!key) throw new Error("清理原文件失败：缺少文件标识。");
  const owner = originalOwner(accountId);
  const db = await database();
  const tx = db.transaction(["blobs", "workspaces", "accountDeletions"], "readwrite");
  try {
    await assertAccountAvailable(tx.objectStore("accountDeletions"), owner);
    const original = await tx.objectStore("blobs").get(key);
    if (
      original !== undefined &&
      (!ownedOriginal(original) || !original.ownerIds.includes(owner))
    ) {
      await tx.done;
      return false;
    }
    const saved = await tx.objectStore("workspaces").getAll();
    const referenced = saved.some((workspace) => {
      // Unknown or damaged records may still own originals. Never infer absence
      // of a reference from a format this version of the app cannot read.
      const parsed = parseStoredWorkspace(workspace);
      if (!parsed.success) return true;
      return referencedBlobKeys(parsed.data).has(key);
    });
    if (referenced) {
      await tx.done;
      return false;
    }
    if (ownedOriginal(original) && original.ownerIds.some((item) => item !== owner)) {
      await tx
        .objectStore("blobs")
        .put({ ...original, ownerIds: original.ownerIds.filter((item) => item !== owner) }, key);
      await tx.done;
      return false;
    }
    await tx.objectStore("blobs").delete(key);
    await tx.done;
    return true;
  } catch (cause) {
    await abortAndObserve(tx);
    throw cause;
  } finally {
    db.close();
  }
}

export async function getBlob(key: string, accountId = "local"): Promise<Blob | undefined> {
  const owner = originalOwner(accountId);
  const db = await database();
  const tx = db.transaction(["blobs", "accountDeletions"], "readonly");
  try {
    await assertAccountAvailable(tx.objectStore("accountDeletions"), owner);
    const original = await tx.objectStore("blobs").get(key);
    await tx.done;
    // Legacy unowned bytes stay intact. A workspace reference cannot establish ownership.
    return ownedOriginal(original) && original.ownerIds.includes(owner) ? original.blob : undefined;
  } catch (cause) {
    await abortAndObserve(tx);
    throw cause;
  } finally {
    db.close();
  }
}

/** The explicit anonymous-library action can share locally admitted bytes with its chosen account. */
export async function shareAnonymousOriginals(
  accountId: string,
  keys: readonly string[],
): Promise<void> {
  const owner = originalOwner(accountId);
  if (owner === "local") throw new Error("迁移原件失败：请选择登录账号。");
  const db = await database();
  const tx = db.transaction(["blobs", "accountDeletions"], "readwrite");
  try {
    await assertAccountAvailable(tx.objectStore("accountDeletions"), owner);
    const blobs = tx.objectStore("blobs");
    for (const key of new Set(keys)) {
      const original = await blobs.get(key);
      // Missing/legacy originals are preserved and remain unavailable; never manufacture a grant.
      if (!ownedOriginal(original) || !original.ownerIds.includes("local")) continue;
      if (!original.ownerIds.includes(owner))
        await blobs.put({ ...original, ownerIds: [...original.ownerIds, owner] }, key);
    }
    await tx.done;
  } catch (cause) {
    try {
      tx.abort();
    } catch {
      /* Preserve the transaction failure. */
    }
    await tx.done.catch(() => undefined);
    throw cause;
  } finally {
    db.close();
  }
}

export async function deleteBlob(key: string, accountId = "local"): Promise<void> {
  const owner = originalOwner(accountId);
  const db = await database();
  const tx = db.transaction(["blobs", "accountDeletions"], "readwrite");
  try {
    await assertAccountAvailable(tx.objectStore("accountDeletions"), owner);
    const blobs = tx.objectStore("blobs");
    const original = await blobs.get(key);
    if (ownedOriginal(original) && original.ownerIds.includes(owner)) {
      const ownerIds = original.ownerIds.filter((item) => item !== owner);
      if (ownerIds.length) await blobs.put({ ...original, ownerIds }, key);
      else await blobs.delete(key);
    }
    await tx.done;
  } catch (cause) {
    await abortAndObserve(tx);
    throw cause;
  } finally {
    db.close();
  }
}
