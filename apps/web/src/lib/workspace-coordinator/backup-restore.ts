import { mergeBackupRestore } from "../backup-restore";
import type { RestorePlan } from "../backup-types";
import { getSourceVersion } from "../source-versions";
import type { WorkspaceCoordinator } from "./coordinator";
import { BackupRestoreContextError, errorText } from "./errors";
import { pendingFileKeys, verifyOriginal } from "./originals";
import type { Session } from "./types";

/**
 * Owns restoring a backup into the current workspace. A restore only ever
 * adds a copy: every original is verified and read back before the merged
 * snapshot is published, and the plan is keyed by session token plus plan id
 * so a repeated confirmation resolves on the first attempt instead of
 * duplicating it.
 */
export class BackupRestoreController {
  private pendingBackupRestores = new Map<
    string,
    { fingerprint: string; promise: Promise<void> }
  >();

  constructor(private core: WorkspaceCoordinator) {}

  hasSession(session: Session): boolean {
    return [...this.pendingBackupRestores.keys()].some((key) =>
      key.startsWith(`[${session.token},`),
    );
  }

  redactSession(session: Session): void {
    for (const key of this.pendingBackupRestores.keys()) {
      if (key.startsWith(`[${session.token},`)) this.pendingBackupRestores.delete(key);
    }
  }

  /** Resolves after the added copy is persisted locally; cloud sync keeps its usual status. */
  async restoreBackup(plan: RestorePlan, token: number): Promise<void> {
    const session = this.core.active;
    if (!session?.ready || session.token !== token)
      throw new Error("当前账号已改变，请重新打开备份恢复面板。");
    this.core.assertWorkspaceWritable(session);
    const key = JSON.stringify([session.token, plan.id]);
    const pending = this.pendingBackupRestores.get(key);
    if (pending) {
      if (pending.fingerprint !== plan.fingerprint)
        throw new Error("备份确认内容已改变，请重新选择备份文件。");
      return pending.promise;
    }
    const prepared = structuredClone(plan);
    const promise = (async () => {
      await this.commitBackupRestore(prepared, session);
      if (this.core.cloudOnly) {
        await this.core.confirmWebCloudSave(session);
        if (
          !session.confirmedCloud ||
          mergeBackupRestore(session.confirmedCloud, prepared) !== session.confirmedCloud
        )
          throw new Error("恢复副本尚未得到云端确认，请保留旧版备份并重试当前恢复计划。");
      }
    })();
    this.pendingBackupRestores.set(key, { fingerprint: prepared.fingerprint, promise });
    try {
      await promise;
    } finally {
      if (this.pendingBackupRestores.get(key)?.promise === promise)
        this.pendingBackupRestores.delete(key);
    }
  }

  private async commitBackupRestore(plan: RestorePlan, session: Session): Promise<void> {
    const validate = () => {
      if (!this.core.isActive(session) || !session.ready)
        throw new Error("当前账号已改变，未将备份副本写入新账号。");
      this.core.assertWorkspaceWritable(session);
      return mergeBackupRestore(session.data, plan);
    };
    const confirmPresent = () => {
      if (validate() !== session.data)
        throw new BackupRestoreContextError(
          "恢复副本已从当前工作区移出，无法确认本次恢复完成；请检查当前副本或重新恢复。已保存原件不会被清理。",
        );
    };
    if (
      plan.data.sources.some((source) => source.aiAllowed) ||
      plan.data.organizationJobs?.some((job) => ["queued", "running"].includes(job.status))
    )
      throw new Error("备份副本不能继承 AI 授权或正在执行的任务，请重新生成恢复预览。");
    const versions = plan.data.sources.flatMap((source) =>
      [source, ...(source.versions ?? [])].map((version) => ({ source, version })),
    );
    const entries = plan.blobs.map((entry) => {
      const source = plan.data.sources.find((item) => item.id === entry.sourceId);
      const version = source && getSourceVersion(source, entry.versionId);
      if (
        !version ||
        entry.key !== version.blobKey ||
        entry.key !== `original:${entry.sourceId}:${entry.versionId}`
      )
        throw new Error("备份原件与恢复版本不一致，请重新选择备份文件。");
      return { ...entry, version };
    });
    if (
      new Set(entries.map((entry) => entry.key)).size !== entries.length ||
      versions.some(
        ({ source, version }) =>
          version.storagePath !== undefined ||
          (version.blobKey &&
            !entries.some(
              (entry) =>
                entry.sourceId === source.id &&
                entry.versionId === version.versionId &&
                entry.key === version.blobKey,
            )),
      )
    )
      throw new Error("备份包含未重映射的云路径或缺失的原件，请重新生成恢复预览。");
    const initial = validate();
    if (initial === session.data) {
      // A previous attempt may have published the copy but failed its local write.
      // The pure merge preserves subsequent edits and detects partial ID collisions.
      await this.confirmBackupLocal(session);
      confirmPresent();
      void this.core.pump(session);
      return;
    }
    if (entries.length && (!this.core.io.putBlobIfAbsent || !this.core.io.deleteUnreferencedBlob))
      throw new Error("当前环境无法安全保存备份原件，请重新载入后重试。现有资料未修改。");
    if (
      entries.some(
        (entry) => pendingFileKeys.has(entry.key) || this.core.originals.referencesBlob(entry.key),
      )
    )
      throw new Error("恢复原件标识正在使用，请重新生成恢复预览。已有原件未被覆盖。");
    const created = new Set<string>();
    const attempted = new Set<string>();
    let applied = false;
    entries.forEach((entry) => pendingFileKeys.add(entry.key));
    try {
      // Verify all bytes before the first write; ZIP parsing itself never persists files.
      for (const entry of entries) {
        await verifyOriginal(entry.version, entry.blob);
        validate();
      }
      for (const entry of entries) {
        attempted.add(entry.key);
        const added = await this.core.originals.putLocalOriginal(session, entry.key, entry.blob);
        if (!added) throw new Error("恢复原件标识已经存在，请重新生成恢复预览。已有原件未被覆盖。");
        created.add(entry.key);
        validate();
        const stored = await this.core.originals.readLocalOriginal(session, entry.key);
        if (!stored) throw new Error("备份原件尚未确认保存在此浏览器，现有资料未修改。");
        await verifyOriginal(entry.version, stored);
        validate();
      }
      // Hashing and IndexedDB may have yielded to an editor or another import.
      // Recheck capacity and append to the latest data, never the preview snapshot.
      applied = this.core.update((current) => mergeBackupRestore(current, plan), session.token);
      if (!applied) throw new Error("当前账号已改变，未将备份副本写入新账号。");
      await this.confirmBackupLocal(session);
      confirmPresent();
      void this.core.pump(session);
    } catch (cause) {
      let cleanup = "";
      if (!applied) {
        if (attempted.size > created.size)
          cleanup = " 未确认由本次操作创建的原件均已保留，未清理。";
        for (const entry of entries) {
          if (!created.has(entry.key)) continue;
          try {
            const stored = await this.core.originals.readLocalOriginal(session, entry.key);
            if (stored) await verifyOriginal(entry.version, stored);
            if (
              this.core.originals.referencesBlob(entry.key) ||
              !(await this.core.originals.deleteLocalOriginal(session, entry.key))
            )
              cleanup = " 无法确认可安全清理的暂存原件已保留。";
          } catch {
            cleanup = " 无法确认可安全清理的暂存原件已保留。";
          }
        }
      }
      const message =
        cause instanceof BackupRestoreContextError
          ? cause.message
          : !this.core.isActive(session) || !session.ready
            ? "当前账号已改变，未将备份副本写入新账号；已加入原账号的副本仍按原保存队列保留。"
            : applied
              ? "备份副本已加入，但本机保存尚未确认，请重试。原件和当前修改仍然保留。 " +
                errorText(cause)
              : errorText(cause);
      throw new Error(message + cleanup);
    } finally {
      entries.forEach((entry) => pendingFileKeys.delete(entry.key));
    }
  }

  private async confirmBackupLocal(session: Session): Promise<void> {
    try {
      await this.core.persist(session);
    } catch (cause) {
      if (this.core.isActive(session)) {
        session.status = session.blocked || "error";
        session.error =
          "备份副本尚未确认保存在此浏览器，请重试；原件和当前修改仍然保留。 " + errorText(cause);
        this.core.publish(session);
      }
      throw cause;
    }
  }
}
