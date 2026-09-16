import type { WorkspaceData } from "../types";
import type { WorkspaceCoordinator } from "./coordinator";
import { errorText } from "./errors";
import { unpack } from "./io";
import {
  anonymousMigrationSummary,
  hasMeaningfulWorkspaceContent,
  noAnonymousWorkspaceMigration,
  sameData,
  withoutAnonymousCloudPaths,
} from "./merge";
import type { RemoteWorkspace, Session } from "./types";

/**
 * Owns the one explicit decision a signed-in account must make about this
 * browser's anonymous library. A pending or in-progress decision is a write
 * barrier: nothing may upload a freshly generated empty workspace before the
 * user has chosen. Migration only ever copies; the `local` workspace is never
 * deleted or rewritten.
 */
export class MigrationController {
  constructor(private core: WorkspaceCoordinator) {}

  /**
   * Looks for a meaningful anonymous library only after this account's local
   * and cloud copies have both been reconciled. A read failure is deliberately
   * non-destructive: the account keeps its own normal load path and no
   * anonymous data is inferred from a failed IndexedDB read.
   */
  async discoverAnonymousWorkspaceMigration(session: Session): Promise<void> {
    if (this.core.cloudOnly) return;
    if (!session.user || !this.core.isActive(session)) return;
    try {
      const anonymous = unpack(await this.core.io.loadLocal("local")).data;
      if (!this.core.isActive(session)) return;
      if (!anonymous || !hasMeaningfulWorkspaceContent(anonymous)) return;

      if (!session.knownRevision || session.blocked) {
        session.anonymousMigration = anonymousMigrationSummary(
          "unavailable",
          anonymous,
          "当前账号的云端状态尚未确认，未迁移此浏览器中的匿名资料。请先重新连接，或导出后再恢复。",
        );
        return;
      }
      if (hasMeaningfulWorkspaceContent(session.data)) {
        // A successful migration deliberately leaves the anonymous local copy
        // intact. On a later reload, recognize only an exact normalized match
        // (cloud object paths excluded) as that same copied library. Any edit
        // on either side falls through to the conservative export/recovery
        // state instead of making a new overwrite decision automatically.
        if (
          sameData(withoutAnonymousCloudPaths(session.data), withoutAnonymousCloudPaths(anonymous))
        ) {
          session.anonymousMigration = anonymousMigrationSummary(
            "migrated",
            anonymous,
            "当前账号已包含与此浏览器匿名副本一致的资料；匿名副本仍保留在本机。",
          );
          return;
        }
        session.anonymousMigration = anonymousMigrationSummary(
          "requires-export",
          anonymous,
          "当前账号已有资料，匿名资料不会自动覆盖。请先导出匿名副本，或恢复到空账号后再迁移。",
        );
        return;
      }

      session.anonymousWorkspace = structuredClone(anonymous);
      session.anonymousMigration = anonymousMigrationSummary(
        "pending",
        anonymous,
        "发现此浏览器中的匿名资料。迁移会复制到当前账号，匿名副本仍会保留在本机。",
        true,
      );
    } catch (cause) {
      if (!this.core.isActive(session)) return;
      session.anonymousWorkspace = null;
      session.anonymousMigration = {
        kind: "unavailable",
        canMigrate: false,
        message: "无法读取此浏览器中的匿名资料，未进行迁移：" + errorText(cause),
      };
    }
  }

  migrationChoiceBlocksWrites(session: Session): boolean {
    return (
      session.anonymousMigration.kind === "pending" ||
      session.anonymousMigration.kind === "migrating"
    );
  }

  /**
   * Explicitly copies the anonymous browser workspace into an otherwise empty
   * signed-in account. This never deletes or rewrites the `local` workspace.
   */
  async migrateAnonymousWorkspace(token: number): Promise<void> {
    const session = this.core.active;
    if (
      !session?.user ||
      !session.ready ||
      session.token !== token ||
      session.anonymousMigration.kind !== "pending"
    )
      throw new Error("当前账号或匿名资料已改变，请重新检查迁移提示。");
    this.core.assertWritable(session);
    const userId = session.user.id;
    const initial = {
      data: session.data,
      revision: session.revision,
      knownRevision: session.knownRevision,
      localDirty: session.localDirty,
      cloudDirty: session.cloudDirty,
      blocked: session.blocked,
      recovery: session.recovery,
      recoveryRevision: session.recoveryRevision,
      confirmedCloud: session.confirmedCloud,
      status: session.status,
      error: session.error,
    };
    const pending = session.anonymousMigration;
    const restorePending = (message: string) => {
      if (!this.core.isActive(session) || session.user?.id !== userId || session.token !== token)
        return;
      session.data = initial.data;
      session.revision = initial.revision;
      session.knownRevision = initial.knownRevision;
      session.localDirty = initial.localDirty;
      session.cloudDirty = initial.cloudDirty;
      session.blocked = initial.blocked;
      session.recovery = initial.recovery;
      session.recoveryRevision = initial.recoveryRevision;
      session.confirmedCloud = initial.confirmedCloud;
      session.ready = true;
      session.status = "error";
      session.error = message;
      session.anonymousMigration = {
        ...pending,
        kind: "pending",
        canMigrate: true,
        message: "匿名资料仍保留在本机；迁移前检查未完成，可在问题解决后重新尝试。",
      };
      this.core.remember(session);
      this.core.publish(session);
    };

    // Freeze ordinary writes before reading the current account again. The
    // rechecks below are intentionally fresh: the discovery result alone is
    // never permission to overwrite a library changed in another tab/device.
    session.ready = false;
    session.status = "saving";
    session.error = "";
    session.anonymousMigration = { ...pending, kind: "migrating", canMigrate: false };
    this.core.publish(session);

    let targetLocal: WorkspaceData | null;
    let remote: RemoteWorkspace;
    let anonymous: WorkspaceData | null;
    try {
      const [localStored, loadedRemote, anonymousStored] = await Promise.all([
        this.core.io.loadLocal(userId),
        this.core.io.loadCloud(userId),
        this.core.io.loadLocal("local"),
      ]);
      targetLocal = unpack(localStored).data;
      remote = loadedRemote;
      anonymous = unpack(anonymousStored).data;
    } catch (cause) {
      if (!this.core.isActive(session) || session.user?.id !== userId || session.token !== token)
        return;
      const message = "迁移前无法确认本机或云端副本：" + errorText(cause) + "。未迁移任何资料。";
      restorePending(message);
      throw new Error(message);
    }
    if (!this.core.isActive(session) || session.user?.id !== userId || session.token !== token)
      return;

    if (!anonymous || !hasMeaningfulWorkspaceContent(anonymous)) {
      session.ready = true;
      session.anonymousWorkspace = null;
      session.anonymousMigration = noAnonymousWorkspaceMigration();
      session.status = initial.status;
      session.error = "";
      this.core.remember(session);
      this.core.publish(session);
      await this.core.pump(session);
      throw new Error("此浏览器中的匿名资料已不可用，未迁移任何资料。");
    }

    if (
      hasMeaningfulWorkspaceContent(session.data) ||
      (!!targetLocal && hasMeaningfulWorkspaceContent(targetLocal)) ||
      (!!remote.data && hasMeaningfulWorkspaceContent(remote.data))
    ) {
      session.ready = true;
      session.anonymousWorkspace = structuredClone(anonymous);
      session.anonymousMigration = anonymousMigrationSummary(
        "requires-export",
        anonymous,
        "当前账号已有资料，匿名资料不会自动覆盖。请先导出匿名副本，或恢复到空账号后再迁移。",
      );
      session.status = "error";
      session.error = "当前账号已有资料，未迁移匿名副本。";
      this.core.remember(session);
      this.core.publish(session);
      throw new Error(session.error);
    }

    // Only this explicit local-library action can share local-owner originals.
    // Cloud references and ordinary account snapshots cannot grant this access.
    if (this.core.io.shareAnonymousOriginals) {
      try {
        await this.core.io.shareAnonymousOriginals(
          userId,
          anonymous.sources.flatMap((source) =>
            [source, ...(source.versions ?? [])].flatMap((version) =>
              version.blobKey ? [version.blobKey] : [],
            ),
          ),
        );
      } catch (cause) {
        if (!this.core.isActive(session) || session.user?.id !== userId || session.token !== token)
          return;
        const message =
          "匿名原件迁移未得到本机确认：" + errorText(cause) + "。匿名副本仍保留，可重试。";
        restorePending(message);
        throw new Error(message);
      }
      if (!this.core.isActive(session) || session.user?.id !== userId || session.token !== token)
        return;
    }
    const migrated = withoutAnonymousCloudPaths(anonymous);
    session.data = migrated;
    session.revision = remote.revision;
    session.knownRevision = true;
    session.localDirty = true;
    session.cloudDirty = true;
    session.blocked = null;
    session.recovery = null;
    session.recoveryRevision = null;
    session.confirmedCloud = remote.data ? structuredClone(remote.data) : null;
    try {
      await this.core.persist(session);
    } catch (cause) {
      if (!this.core.isActive(session) || session.user?.id !== userId || session.token !== token)
        return;
      const message =
        "匿名资料副本尚未确认保存在当前账号：" + errorText(cause) + "。未开始云端同步。";
      restorePending(message);
      throw new Error(message);
    }
    if (!this.core.isActive(session) || session.user?.id !== userId || session.token !== token)
      return;

    session.ready = true;
    session.status = "saving";
    session.error = "";
    session.anonymousWorkspace = null;
    session.anonymousMigration = {
      ...anonymousMigrationSummary(
        "migrated",
        migrated,
        "匿名资料已复制到当前账号的本机副本，正在等待云端确认。匿名副本仍保留在此浏览器。",
      ),
      pendingCloudConfirmation: true,
    };
    this.core.organization.recoverOrganizationJobs(session);
    this.core.imports.recoverImportJobs(session);
    this.core.remember(session);
    this.core.publish(session);
    await this.core.pump(session);
  }

  /** Keeps the anonymous copy untouched and resumes normal empty-account setup. */
  async skipAnonymousWorkspaceMigration(token: number): Promise<void> {
    const session = this.core.active;
    if (!session?.user || !session.ready || session.token !== token)
      throw new Error("当前账号已改变，请重新检查匿名资料迁移提示。");
    this.core.assertWritable(session);
    if (session.anonymousMigration.kind !== "pending") return;
    session.anonymousWorkspace = null;
    session.anonymousMigration = {
      ...session.anonymousMigration,
      kind: "dismissed",
      canMigrate: false,
      message: "已暂不迁移。匿名资料仍保留在此浏览器，之后重新登录时可再次处理。",
    };
    this.core.remember(session);
    this.core.publish(session);
    await this.core.pump(session);
  }
}
