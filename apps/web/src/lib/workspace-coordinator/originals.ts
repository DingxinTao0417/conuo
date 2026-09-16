import { getSourceVersion, replaceFileSource } from "../source-versions";
import type { Source, SourceBlobReadOptions, WorkspaceData } from "../types";
import type { WorkspaceCoordinator } from "./coordinator";
import { errorText, OriginalSyncError } from "./errors";
import { accountKey } from "./io";
import type { Session } from "./types";

// Shared across coordinators in this page; IndexedDB's atomic add handles other tabs.
export const pendingFileKeys = new Set<string>();

export function originalIdentity(
  source: Pick<Source, "kind" | "blobKey" | "hash" | "size">,
): string {
  return JSON.stringify([source.kind, source.blobKey, source.hash, source.size]);
}

export async function verifyOriginal(
  source: Pick<Source, "hash" | "size">,
  blob: Blob,
): Promise<void> {
  if (source.size !== blob.size || !/^[a-f0-9]{64}$/i.test(source.hash))
    throw new OriginalSyncError(
      "原文件大小或内容指纹与已解析版本不符，尚未上传或替换，请重新选择文件。",
    );
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const actual = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (actual !== source.hash.toLowerCase())
    throw new OriginalSyncError("原文件内容与已解析版本不符，尚未上传或替换，请重新选择文件。");
}

/** A completed upload follows its original into history, never another version or changed file. */
export function mergeOriginalPath(
  data: WorkspaceData,
  uploaded: Source,
  storagePath: string,
): WorkspaceData {
  const live = data.sources.find((source) => source.id === uploaded.id);
  if (!live) return data;
  const current = getSourceVersion(live, uploaded.versionId);
  if (!current) return data;
  if (
    originalIdentity(current) !== originalIdentity(uploaded) ||
    (current.storagePath && current.storagePath !== storagePath)
  )
    throw new OriginalSyncError(
      "上传期间原件记录已变化，未将上传结果绑定到其他内容。请检查资料并重试。",
    );
  if (current.storagePath === storagePath) return data;
  return {
    ...data,
    sources: data.sources.map((source) =>
      source.id !== uploaded.id
        ? source
        : source.versionId === uploaded.versionId
          ? { ...source, storagePath }
          : {
              ...source,
              versions: source.versions!.map((version) =>
                version.versionId === uploaded.versionId ? { ...version, storagePath } : version,
              ),
            },
    ),
  };
}

export function originalKeys(source: Source): string[] {
  return [
    ...new Set(
      [source, ...(source.versions ?? [])].flatMap((version) =>
        version.blobKey ? [version.blobKey] : [],
      ),
    ),
  ];
}

/**
 * Owns every read, write and reference check for original bytes. Identity is
 * always re-read from the account's live record: a caller only supplies the
 * immutable source/version pair, never the Blob key it remembered.
 */
export class OriginalsController {
  constructor(private core: WorkspaceCoordinator) {}

  readLocalOriginal(session: Session, key: string): Promise<Blob | undefined> {
    return this.core.io.getAccountBlob
      ? this.core.io.getAccountBlob(key, accountKey(session.user))
      : this.core.io.getBlob(key);
  }

  deleteLocalOriginal(session: Session, key: string): Promise<boolean> {
    return this.core.io.deleteAccountUnreferencedBlob
      ? this.core.io.deleteAccountUnreferencedBlob(key, accountKey(session.user))
      : this.core.io.deleteUnreferencedBlob!(key);
  }

  putLocalOriginal(session: Session, key: string, blob: Blob): Promise<boolean> {
    return this.core.io.putAccountBlobIfAbsent
      ? this.core.io.putAccountBlobIfAbsent(key, blob, accountKey(session.user))
      : this.core.io.putBlobIfAbsent!(key, blob);
  }

  async sourceBlob(
    source: Source,
    token: number,
    options: SourceBlobReadOptions = {},
  ): Promise<Blob | undefined> {
    const session = this.core.active;
    if (!session?.ready || session.token !== token) {
      throw new Error("当前账号或资料版本已改变，请重新打开资料。");
    }
    // Only immutable identity comes from the caller. Originals, including a
    // retained version's handles, must come from this account's live record.
    const sourceId = source.id;
    const versionId = source.versionId;
    const ownedVersion = () => {
      if (!this.core.isActive(session) || !session.ready)
        throw new Error("当前账号已改变，请重新打开资料。");
      const live = session.data.sources.find((item) => item.id === sourceId);
      const version = live && getSourceVersion(live, versionId);
      if (!version) throw new Error("当前账号或资料版本已改变，请重新打开资料。");
      // Deleted records remain readable here for the user's recoverable backup.
      return version;
    };
    const canonical = { ...ownedVersion() };
    const originalKey = (item: Source) =>
      JSON.stringify([item.kind, item.blobKey, item.storagePath, item.hash, item.size]);
    const expectedKey = originalKey(canonical);
    const assertUnchanged = () => {
      if (originalKey(ownedVersion()) !== expectedKey)
        throw new Error("资料原件记录已变化，请重新打开对应版本后重试。");
    };
    try {
      if (!options.preferCloud) {
        const local = canonical.blobKey
          ? await this.readLocalOriginal(session, canonical.blobKey)
          : undefined;
        assertUnchanged();
        if (local) return local;
      }
      if (session.user && canonical.storagePath) {
        const blob = await this.core.io.downloadBlob(canonical, session.user.id);
        assertUnchanged();
        return blob;
      }
      return undefined;
    } catch (cause) {
      // A late failure can contain the old account's object details. Validate
      // the active session before allowing either bytes or that error to escape.
      assertUnchanged();
      throw cause;
    }
  }

  referencesBlob(key: string): boolean {
    const sessions = new Set([
      ...this.core.memory.values(),
      ...(this.core.active ? [this.core.active] : []),
    ]);
    return [...sessions].some((session) =>
      [session.data, session.confirmedCloud, session.recovery].some((data) =>
        data?.sources.some(
          (source) =>
            source.blobKey === key || source.versions?.some((version) => version.blobKey === key),
        ),
      ),
    );
  }

  async replaceFile(
    sourceId: string,
    expectedVersionId: string,
    candidate: Source,
    blob: Blob,
    token: number,
  ): Promise<void> {
    const session = this.core.active;
    if (!session?.ready || session.token !== token)
      throw new Error("当前账号已改变，请重新打开文件替换面板。");
    this.core.assertWorkspaceWritable(session);
    const prepared = structuredClone(candidate);
    const validate = () => {
      if (!this.core.isActive(session) || !session.ready)
        throw new Error("当前账号已改变，请重新打开文件替换面板。");
      return replaceFileSource(session.data, sourceId, expectedVersionId, prepared);
    };
    validate();
    const key = prepared.blobKey!;
    if (!this.core.io.putBlobIfAbsent || !this.core.io.deleteUnreferencedBlob)
      throw new Error("当前环境无法安全保存替换原件，请重新载入后重试。原资料未修改。");
    if (pendingFileKeys.has(key)) throw new Error("这个文件正在保存，请等待完成，勿重复提交。");
    if (this.referencesBlob(key))
      throw new Error("新文件原件标识已被使用，请重新选择文件，避免覆盖已有原件。");
    pendingFileKeys.add(key);
    let created = false;
    let applied = false;
    let attemptedWrite = false;
    try {
      await verifyOriginal(prepared, blob);
      validate();
      attemptedWrite = true;
      created = await this.putLocalOriginal(session, key, blob);
      if (!created) {
        const existing = await this.readLocalOriginal(session, key);
        if (existing) await verifyOriginal(prepared, existing);
        throw new Error("这个原件标识已经存在，请重新选择文件生成新预览。已有原件未被覆盖。");
      }
      // Read back the immutable reservation before publishing a workspace that
      // depends on it. A failed write must never create a dangling current page.
      const persisted = await this.readLocalOriginal(session, key);
      if (!persisted) throw new Error("替换原件尚未确认保存在此浏览器，原资料未修改。");
      await verifyOriginal(prepared, persisted);
      validate();
      // Saving and reading back the immutable original can take long enough for
      // another tab to commit a newer workspace. Recheck that boundary before
      // publishing replacement metadata from this page's now-stale snapshot.
      this.core.assertWorkspaceWritable(session);
      const durableWrite = this.core.updateDurably(
        (data) => replaceFileSource(data, sourceId, expectedVersionId, prepared),
        token,
      );
      // updateDurably applies synchronously before awaiting IndexedDB. Read the
      // live references now so a later local-write failure keeps an original
      // already adopted by the in-memory recovery snapshot.
      applied = this.referencesBlob(key);
      if (!(await durableWrite))
        throw new Error(session.error || "当前资料正在解析或账号已改变，原资料未修改。");
      // A successful replacement promise now means its metadata is durable in
      // IndexedDB. Cloud upload still follows the ordinary background status.
    } catch (cause) {
      let cleanup = "";
      if (!applied && created) {
        try {
          const stored = await this.readLocalOriginal(session, key);
          if (stored) await verifyOriginal(prepared, stored);
          if (this.referencesBlob(key) || !(await this.deleteLocalOriginal(session, key)))
            cleanup = " 暂存原件可能仍被引用，已保留，未清理。";
        } catch {
          cleanup = " 无法确认暂存原件可安全删除，已保留，未清理。";
        }
      } else if (!applied && attemptedWrite && !created) {
        cleanup = " 未确认由本次操作创建的原件均未清理。";
      }
      const message =
        !this.core.isActive(session) || !session.ready
          ? "当前账号已改变，未将此次文件替换写入新账号。"
          : errorText(cause);
      throw new Error(message + cleanup);
    } finally {
      pendingFileKeys.delete(key);
    }
  }
}
