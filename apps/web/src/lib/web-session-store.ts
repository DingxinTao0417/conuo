import { assertWorkspaceOwner, workspaceSchema } from "./supabase/validation";
import type {
  LocalImportCommitResult,
  LocalImportMerger,
  StoredLocalWorkspace,
} from "./local-store";
import type { WorkspaceData } from "./types";

/** A compatibility error code for the coordinator's existing save queue. */
export class WebSessionWorkspaceConflictError extends Error {
  readonly code = "LOCAL_WORKSPACE_CONFLICT";
  constructor() {
    super("当前会话的资料已更新，未覆盖较新的内容。请重新载入后继续。");
    this.name = "WebSessionWorkspaceConflictError";
  }
}

export class WebSessionAccountDeletedError extends Error {
  readonly code = "LOCAL_ACCOUNT_DELETED";
  constructor() {
    super("该账号已提交注销，当前会话不能继续读取或保存资料。");
    this.name = "WebSessionAccountDeletedError";
  }
}

type Original = { ownerId: string; blob: Blob };

function accountOwner(accountId: string | undefined): string {
  if (
    !accountId ||
    accountId.trim() !== accountId ||
    accountId === "local" ||
    accountId.startsWith("recovery:")
  )
    throw new Error("网页版资料仅供登录账号使用，请先登录。");
  return accountId;
}

/** Recovery names identify snapshots only, and never authorize an original read. */
function snapshotOwner(accountId: string | undefined): string {
  if (!accountId?.startsWith("recovery:")) return accountOwner(accountId);
  const parts = accountId.slice("recovery:".length);
  const tokenSeparator = parts.lastIndexOf(":");
  const timestampSeparator = parts.lastIndexOf(":", tokenSeparator - 1);
  if (
    timestampSeparator < 1 ||
    !/^\d+$/u.test(parts.slice(timestampSeparator + 1, tokenSeparator)) ||
    !/^[a-zA-Z0-9_-]+$/u.test(parts.slice(tokenSeparator + 1))
  )
    throw new Error("恢复副本的所属账号无效，不能读取或保存。");
  return accountOwner(parts.slice(0, timestampSeparator));
}

function revisionOf(value: StoredLocalWorkspace | undefined): number {
  const revision = value?._conuoLocalRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new Error("会话资料版本无效，无法安全保存。");
  return revision;
}

function nextRevision(current: number): number {
  if (!Number.isSafeInteger(current + 1)) throw new Error("会话资料版本已超出安全范围。");
  return current + 1;
}

function checkedSnapshot(value: unknown, ownerId: string): StoredLocalWorkspace {
  const snapshot = structuredClone(value);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
    throw new Error("会话资料格式无效，未保存原文件或资料。");
  const {
    _conuoSync: sync,
    _conuoLocalRevision: revision,
    ...data
  } = snapshot as Record<string, unknown>;
  const parsed = workspaceSchema.safeParse(data);
  if (!parsed.success) throw new Error("会话资料格式无效，未保存原文件或资料。");
  assertWorkspaceOwner(parsed.data, ownerId);
  if (revision !== undefined && (!Number.isSafeInteger(revision) || Number(revision) < 0))
    throw new Error("会话资料版本无效，无法安全保存。");
  return {
    ...parsed.data,
    ...(sync === undefined ? {} : { _conuoSync: sync }),
    ...(revision === undefined ? {} : { _conuoLocalRevision: Number(revision) }),
  };
}

function referencedKeys(data: WorkspaceData): Set<string> {
  return new Set(
    data.sources.flatMap((source) =>
      [source, ...(source.versions ?? [])].flatMap((version) =>
        version.blobKey ? [version.blobKey] : [],
      ),
    ),
  );
}

/**
 * Temporary memory for the web save coordinator, never a durable workspace.
 * A refresh creates a fresh instance and must fetch the authoritative cloud
 * record. No browser storage, messages, cookies, or network I/O occur here.
 */
export class WebSessionStore {
  private readonly workspaces = new Map<string, StoredLocalWorkspace>();
  private readonly originals = new Map<string, Original>();
  private readonly deletedAccounts = new Set<string>();
  private readonly managedAccounts = new Set<string>();
  private readonly deletionListeners = new Map<string, Set<() => void>>();
  private activeOwner: string | undefined;
  private generation = 0;

  /** Bind only a verified Auth identity, never an identity from workspace JSON. */
  beginSession = (accountId: string): void => {
    const owner = accountOwner(accountId);
    if (this.deletedAccounts.has(owner)) throw new WebSessionAccountDeletedError();
    if (this.activeOwner !== owner) {
      this.workspaces.clear();
      this.originals.clear();
      this.generation += 1;
    }
    this.activeOwner = owner;
    this.managedAccounts.add(owner);
  };

  /** Same-page ownership admission lets confirmed deletion avoid legacy persistence. */
  managesAccount = (accountId: string): boolean => this.managedAccounts.has(accountId);

  private availableOwner(accountId: string | undefined, recovery = false): string {
    const owner = recovery ? snapshotOwner(accountId) : accountOwner(accountId);
    if (this.activeOwner === undefined) throw new Error("网页版资料仅供登录账号使用，请先登录。");
    if (owner !== this.activeOwner) throw new Error("会话资料不属于当前登录账号。");
    if (this.deletedAccounts.has(owner)) throw new WebSessionAccountDeletedError();
    return owner;
  }

  loadLocal = async (accountId?: string): Promise<StoredLocalWorkspace | null> => {
    const owner = this.availableOwner(accountId, true);
    const stored = this.workspaces.get(accountId!);
    return stored === undefined ? null : checkedSnapshot(stored, owner);
  };

  saveLocal = async (
    data: WorkspaceData,
    accountId?: string,
    expectedLocalRevision?: number,
  ): Promise<number> => {
    const owner = this.availableOwner(accountId, true);
    if (
      expectedLocalRevision !== undefined &&
      (!Number.isSafeInteger(expectedLocalRevision) || expectedLocalRevision < 0)
    )
      throw new Error("保存失败：会话资料预期版本无效。");
    const snapshot = checkedSnapshot(data, owner);
    const current = revisionOf(this.workspaces.get(accountId!));
    if (expectedLocalRevision !== undefined && expectedLocalRevision !== current)
      throw new WebSessionWorkspaceConflictError();
    const revision = nextRevision(current);
    this.workspaces.set(accountId!, { ...snapshot, _conuoLocalRevision: revision });
    return revision;
  };

  commitLocalImport = async <TResult>(
    accountId: string,
    blobKey: string,
    blob: Blob,
    merge: LocalImportMerger<TResult>,
  ): Promise<LocalImportCommitResult<TResult>> => {
    const owner = this.availableOwner(accountId);
    if (!blobKey || !(blob instanceof Blob))
      throw new Error("保存原文件失败：文件标识或原件无效。");
    if (typeof merge !== "function") throw new TypeError("缺少会话导入合并函数。");
    const stored = this.workspaces.get(accountId);
    const current = revisionOf(stored);
    const generation = this.generation;
    const latest = stored === undefined ? null : checkedSnapshot(stored, owner);
    const plan = merge(latest);
    if (!plan || typeof plan !== "object" || typeof plan.storeBlob !== "boolean")
      throw new TypeError("会话导入合并函数返回了无效结果。");
    const storeBlob = plan.storeBlob;
    const result = plan.result;
    const next = checkedSnapshot(plan.workspace, owner);
    const references = referencedKeys(next).has(blobKey);
    const existing = this.originals.get(blobKey);
    if (storeBlob && !references)
      throw new Error("导入资料没有引用待保存的原文件，已取消整次写入。");
    if (storeBlob && existing) throw new Error("原文件标识已存在，已有原件和资料均未修改。");
    if (!storeBlob && references && existing?.ownerId !== owner)
      throw new Error("导入资料引用的原文件不存在或不属于当前账号，已取消整次写入。");
    // A synchronous merger must not be able to overwrite a reentrant save.
    this.availableOwner(accountId);
    if (this.generation !== generation || revisionOf(this.workspaces.get(accountId)) !== current)
      throw new WebSessionWorkspaceConflictError();
    const localRevision = nextRevision(current);
    next._conuoLocalRevision = localRevision;
    const returned = structuredClone(next);
    if (storeBlob) this.originals.set(blobKey, { ownerId: owner, blob });
    this.workspaces.set(accountId, next);
    return { workspace: returned, localRevision, blobStored: storeBlob, result };
  };

  getBlob = async (key: string, accountId?: string): Promise<Blob | undefined> => {
    const owner = this.availableOwner(accountId);
    const original = this.originals.get(key);
    return original?.ownerId === owner ? original.blob : undefined;
  };

  putBlobIfAbsent = async (key: string, blob: Blob, accountId?: string): Promise<boolean> => {
    const owner = this.availableOwner(accountId);
    if (!key || !(blob instanceof Blob)) throw new Error("保存原文件失败：文件标识或原件无效。");
    if (this.originals.has(key)) return false;
    this.originals.set(key, { ownerId: owner, blob });
    return true;
  };

  deleteUnreferencedBlob = async (key: string, accountId?: string): Promise<boolean> => {
    const owner = this.availableOwner(accountId);
    if (!key) throw new Error("清理原文件失败：缺少文件标识。");
    const original = this.originals.get(key);
    if (original && original.ownerId !== owner) return false;
    if ([...this.workspaces.values()].some((data) => referencedKeys(data).has(key))) return false;
    this.originals.delete(key);
    return true;
  };

  isAccountLocallyDeleted = async (accountId: string): Promise<boolean> =>
    this.deletedAccounts.has(accountOwner(accountId));

  markAccountLocalDeletion = async (accountId: string): Promise<void> => {
    const owner = accountOwner(accountId);
    if (this.deletedAccounts.has(owner)) return;
    this.deletedAccounts.add(owner);
    for (const listener of [...(this.deletionListeners.get(owner) ?? [])]) {
      try {
        listener();
      } catch {
        // An observer must not revoke an already established deletion fence.
      }
    }
  };

  subscribeLocalAccountDeletions = (accountId: string, listener: () => void): (() => void) => {
    const owner = accountOwner(accountId);
    if (typeof listener !== "function") throw new TypeError("订阅失败：缺少事件处理函数。");
    const listeners = this.deletionListeners.get(owner) ?? new Set<() => void>();
    listeners.add(listener);
    this.deletionListeners.set(owner, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.deletionListeners.delete(owner);
    };
  };

  clearAccountLocalCache = async (
    accountId: string,
  ): Promise<{ deletedBlobs: number; retainedBlobs: number }> => {
    const owner = accountOwner(accountId);
    await this.markAccountLocalDeletion(owner);
    return { deletedBlobs: this.removeOwnerMemory(owner), retainedBlobs: 0 };
  };

  private removeOwnerMemory(owner: string): number {
    for (const key of this.workspaces.keys()) {
      if (snapshotOwner(key) === owner) this.workspaces.delete(key);
    }
    let deleted = 0;
    for (const [key, original] of this.originals) {
      if (original.ownerId !== owner) continue;
      this.originals.delete(key);
      deleted += 1;
    }
    return deleted;
  }

  /** Sign-out releases all bytes and snapshots; deletion fences stay fail-closed. */
  clearSession = (accountId?: string): void => {
    if (accountId === undefined) {
      this.workspaces.clear();
      this.originals.clear();
      this.activeOwner = undefined;
      this.generation += 1;
      return;
    }
    const owner = accountOwner(accountId);
    this.removeOwnerMemory(owner);
    if (this.activeOwner === owner) {
      this.activeOwner = undefined;
      this.generation += 1;
    }
  };

  /** Release all temporary state; only a fresh page/instance can reset deletion fences. */
  reset = (): void => {
    this.clearSession();
    this.deletionListeners.clear();
  };
}

export const webSessionStore = new WebSessionStore();
