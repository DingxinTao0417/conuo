import type { SourcePurgePreview, SourceVersionPurgePreview } from "../cloud";
import {
  previewPermanentSourceDeletionContent,
  type PermanentSourceDeletionSelection,
} from "../permanent-deletion";
import { sameSourcePurgeSelection, sourcePurgeSelectionSchema } from "../source-purge-contract";
import type { Source } from "../types";
import type { WorkspaceCoordinator } from "./coordinator";
import { errorText, PurgeLocalPersistenceError } from "./errors";
import { sameData } from "./merge";
import { originalKeys } from "./originals";
import type { Session } from "./types";

/**
 * Owns permanent deletion of a source or one of its historical versions. The
 * server performs the metadata transaction and returns the committed snapshot;
 * this controller only persists exactly that snapshot and, once it is durable,
 * removes originals no remaining session still references.
 */
export class PurgeController {
  constructor(private core: WorkspaceCoordinator) {}

  private assertPurgeReady(session: Session, sourceId: string, token: number): Source {
    this.core.assertWorkspaceWritable(session);
    if (!this.core.isActive(session) || !session.user || !session.ready || session.token !== token)
      throw new Error("当前账号已改变，请重新打开回收站后再操作。");
    if (session.purging) throw new Error("这份资料正在彻底删除，请等待当前操作完成后再继续。");
    if (
      session.pumping ||
      session.checking ||
      session.localDirty ||
      session.cloudDirty ||
      session.blocked ||
      !session.knownRevision ||
      !session.confirmedCloud ||
      !sameData(session.data, session.confirmedCloud)
    )
      throw new Error("请等待当前资料同步完成，再查看彻底删除的影响范围。");
    if (this.core.aiBusy(token) || this.core.imports.hasSession(session))
      throw new Error("请等待当前问答、整理或导入结束后再彻底删除资料。");
    const source = session.data.sources.find((item) => item.id === sourceId);
    if (!source?.deletedAt) throw new Error("请先将资料移入回收站，再执行彻底删除。");
    return source;
  }

  private assertSourceVersionPurgeReady(
    session: Session,
    sourceId: string,
    versionId: string,
    token: number,
  ): { source: Source; version: NonNullable<Source["versions"]>[number] } {
    this.core.assertWorkspaceWritable(session);
    if (!this.core.isActive(session) || !session.user || !session.ready || session.token !== token)
      throw new Error("当前账号已改变，请重新打开版本记录后再操作。");
    if (session.purging) throw new Error("正在清理资料版本，请等待当前操作完成后再继续。");
    if (
      session.pumping ||
      session.checking ||
      session.localDirty ||
      session.cloudDirty ||
      session.blocked ||
      !session.knownRevision ||
      !session.confirmedCloud ||
      !sameData(session.data, session.confirmedCloud)
    )
      throw new Error("请等待资料同步完成，再查看历史版本清理的影响范围。");
    if (this.core.aiBusy(token) || this.core.imports.hasSession(session))
      throw new Error("请等待当前问答、整理或导入结束后再清理历史版本。");
    const source = session.data.sources.find((item) => item.id === sourceId);
    if (!source || source.deletedAt) throw new Error("这份资料已不可用，请返回资料库检查。");
    if (source.versionId === versionId)
      throw new Error("当前版本不能单独清理，请先恢复其他版本或彻底删除资料。");
    const versions = source.versions?.filter((item) => item.versionId === versionId) ?? [];
    if (versions.length !== 1) throw new Error("这个历史版本已改变，请刷新版本记录后重试。");
    return { source, version: versions[0] };
  }

  /** The server owns the preview so browser state cannot omit a dependency. */
  async previewSourcePurge(
    sourceId: string,
    token: number,
    selection?: PermanentSourceDeletionSelection,
    signal?: AbortSignal,
  ): Promise<SourcePurgePreview> {
    const session = this.core.active;
    if (!session) throw new Error("当前账号已改变，请重新打开回收站后再操作。");
    const source = this.assertPurgeReady(session, sourceId, token);
    if (signal?.aborted) throw new Error("删除范围核对已停止，请重新核对后再确认。");
    const choices =
      selection === undefined
        ? undefined
        : previewPermanentSourceDeletionContent(session.data, sourceId, selection).selection;
    if (!this.core.io.previewSourcePurge)
      throw new Error("当前云端尚未支持彻底删除，请完成数据库迁移后重试。");
    const snapshot = session.data;
    const revision = session.revision;
    const preview =
      choices === undefined && signal === undefined
        ? await this.core.io.previewSourcePurge(source.id, session.user!.id)
        : await this.core.io.previewSourcePurge(source.id, session.user!.id, choices, signal);
    if (signal?.aborted) throw new Error("删除范围核对已停止，请重新核对后再确认。");
    if (
      !this.core.isActive(session) ||
      session.data !== snapshot ||
      session.revision !== revision ||
      session.purging
    )
      throw new Error("资料或账号已改变，请重新查看彻底删除的影响范围。");
    if (preview.revision !== revision || preview.impact.source.id !== source.id)
      throw new Error("云端资料已变化，请重新查看彻底删除的影响范围。");
    if (
      choices &&
      (!preview.contentSelection ||
        !sameSourcePurgeSelection(preview.contentSelection.selection, choices))
    )
      throw new Error("云端核对范围与删除选择不一致，请重新查看后再确认。");
    if (
      !choices &&
      preview.contentSelection &&
      (preview.contentSelection.selection.noteIds.length ||
        preview.contentSelection.selection.conversationIds.length)
    )
      throw new Error("默认预览不能预选另存内容，请重新核对删除范围。");
    return preview;
  }

  /**
   * Do not route this through the regular snapshot pump. The database makes
   * the metadata change atomically, then this coordinator persists exactly
   * that returned snapshot before it considers any local original removable.
   */
  async purgeSource(sourceId: string, preview: SourcePurgePreview, token: number): Promise<void> {
    const session = this.core.active;
    if (!session) throw new Error("当前账号已改变，请重新打开回收站后再操作。");
    const source = this.assertPurgeReady(session, sourceId, token);
    if (!this.core.io.requestSourcePurge)
      throw new Error("当前云端尚未支持彻底删除，请完成数据库迁移后重试。");
    if (preview.revision !== session.revision || preview.impact.source.id !== source.id)
      throw new Error("删除影响范围已过期，请重新查看后再确认。");
    if (preview.blockers.annotations.length || preview.blockers.conceptRelations.length)
      throw new Error("所选范围仍有需要另存或明确删除的批注／手工关系，请先处理后重新核对。");
    let choices: PermanentSourceDeletionSelection | undefined;
    if (preview.contentSelection) {
      const parsed = sourcePurgeSelectionSchema.safeParse(preview.contentSelection.selection);
      if (!parsed.success) throw new Error("删除选择格式已改变，请重新核对影响范围。");
      choices = previewPermanentSourceDeletionContent(
        session.data,
        sourceId,
        parsed.data,
      ).selection;
    }
    const userId = session.user!.id;
    const localKeys = originalKeys(source);
    session.purging = true;
    session.ready = false;
    session.status = "saving";
    session.error = "";
    this.core.remember(session);
    // A disabled session rejects late import/AI writes while the server holds
    // its deletion transaction. We only enter this state when no regular pump
    // or async write is already in flight.
    this.core.publish(session);
    try {
      const args = [source.id, session.revision, preview.fingerprint, userId] as const;
      const result = choices
        ? await this.core.io.requestSourcePurge(...args, structuredClone(choices))
        : await this.core.io.requestSourcePurge(...args);
      if (!this.core.isActive(session) || session.user?.id !== userId)
        throw new Error("账号已改变，云端资料已刷新；请重新打开当前账号的资料库。");
      if (result.data.sources.some((item) => item.id === source.id))
        throw new Error("云端彻底删除结果不完整，已暂停同步，请刷新资料库后重试。");
      if (
        result.revision <= session.revision ||
        (choices &&
          (choices.noteIds.some((id) => result.data.notes.some((note) => note.id === id)) ||
            choices.conversationIds.some((id) =>
              result.data.conversations.some((conversation) => conversation.id === id),
            )))
      )
        throw new Error("云端所选内容的删除结果尚未确认，已暂停同步，请刷新资料库后重试。");
      session.data = result.data;
      session.confirmedCloud = structuredClone(result.data);
      session.revision = result.revision;
      session.knownRevision = true;
      session.localDirty = true;
      session.cloudDirty = false;
      session.blocked = null;
      session.recovery = null;
      session.recoveryRevision = null;
      this.core.remember(session);
      try {
        // Keeping ready=false here prevents a late editor callback from writing
        // the former source while IndexedDB still contains the old snapshot.
        await this.core.persist(session);
      } catch (cause) {
        if (!this.core.isActive(session) || session.user?.id !== userId)
          throw new PurgeLocalPersistenceError(
            "账号已改变；云端已完成彻底删除，但原账号新的本机副本未能确认保存：" +
              errorText(cause) +
              "。请重新打开原账号核对并重试保存。",
          );
        session.purging = false;
        session.ready = true;
        session.blocked = "error";
        session.status = "error";
        session.error =
          "云端已完成彻底删除，但新的本地副本尚未保存：" +
          errorText(cause) +
          "。已暂停同步，请先重试保存。";
        this.core.remember(session);
        this.core.publish(session);
        throw new PurgeLocalPersistenceError(session.error);
      }
      if (!this.core.isActive(session) || session.user?.id !== userId)
        throw new Error("账号已改变，云端已完成彻底删除；请重新打开原账号查看结果。");
      session.purging = false;
      session.ready = true;
      session.status = "cloud";
      session.error = result.cleanupPending
        ? "资料元数据已彻底删除；云端原件正在后台清理。"
        : "资料已彻底删除。";
      this.core.remember(session);
      this.core.publish(session);
      for (const key of localKeys) {
        if (this.core.originals.referencesBlob(key) || !this.core.io.deleteUnreferencedBlob)
          continue;
        try {
          await this.core.originals.deleteLocalOriginal(session, key);
        } catch {
          // The deletion is already durable. A future reference-safe cleanup
          // may retry; never report a physical local cleanup we cannot prove.
        }
        if (!this.core.isActive(session) || session.user?.id !== userId)
          throw new Error("账号已改变，云端已完成彻底删除；请重新打开原账号查看结果。");
      }
      if (!this.core.isActive(session) || session.user?.id !== userId)
        throw new Error("账号已改变，云端已完成彻底删除；请重新打开原账号查看结果。");
    } catch (cause) {
      if (!this.core.isActive(session)) throw cause;
      // The server has already returned its committed snapshot. Preserve the
      // more precise local-persistence state instead of downgrading it to an
      // ambiguous network outcome.
      if (cause instanceof PurgeLocalPersistenceError) throw cause;
      session.purging = false;
      session.ready = true;
      session.blocked = "error";
      session.status = "error";
      session.error =
        "无法确认云端是否已完成彻底删除，已暂停同步。" +
        errorText(cause) +
        " 请刷新资料库后再继续。";
      this.core.remember(session);
      this.core.publish(session);
      throw cause;
    }
  }

  /**
   * The server owns the exact dependency preview. A historical version cannot be
   * removed locally because its normalized chunks and Storage object must follow the
   * same transaction and cleanup outbox as the browser snapshot.
   */
  async previewSourceVersionPurge(
    sourceId: string,
    versionId: string,
    token: number,
  ): Promise<SourceVersionPurgePreview> {
    const session = this.core.active;
    if (!session) throw new Error("当前账号已改变，请重新打开版本记录后再操作。");
    const target = this.assertSourceVersionPurgeReady(session, sourceId, versionId, token);
    if (!this.core.io.previewSourceVersionPurge)
      throw new Error("当前云端尚未支持历史版本清理，请完成数据库迁移后重试。");
    const snapshot = session.data;
    const revision = session.revision;
    const preview = await this.core.io.previewSourceVersionPurge(
      target.source.id,
      target.version.versionId,
      session.user!.id,
    );
    if (
      !this.core.isActive(session) ||
      session.data !== snapshot ||
      session.revision !== revision ||
      session.purging
    )
      throw new Error("资料版本或账号已改变，请重新查看历史版本清理的影响范围。");
    if (
      preview.revision !== revision ||
      preview.impact.source.id !== target.source.id ||
      preview.impact.version.versionId !== target.version.versionId
    )
      throw new Error("云端资料版本已变化，请重新查看历史版本清理的影响范围。");
    return preview;
  }

  async purgeSourceVersion(
    sourceId: string,
    versionId: string,
    preview: SourceVersionPurgePreview,
    token: number,
  ): Promise<void> {
    const session = this.core.active;
    if (!session) throw new Error("当前账号已改变，请重新打开版本记录后再操作。");
    const target = this.assertSourceVersionPurgeReady(session, sourceId, versionId, token);
    if (!this.core.io.requestSourceVersionPurge)
      throw new Error("当前云端尚未支持历史版本清理，请完成数据库迁移后重试。");
    if (
      preview.revision !== session.revision ||
      preview.impact.source.id !== target.source.id ||
      preview.impact.version.versionId !== target.version.versionId
    )
      throw new Error("历史版本清理影响范围已过期，请重新查看后再确认。");
    const userId = session.user!.id;
    const localKeys = target.version.blobKey ? [target.version.blobKey] : [];
    session.purging = true;
    session.ready = false;
    session.status = "saving";
    session.error = "";
    this.core.remember(session);
    this.core.publish(session);
    try {
      const result = await this.core.io.requestSourceVersionPurge(
        target.source.id,
        target.version.versionId,
        session.revision,
        preview.fingerprint,
        userId,
      );
      if (!this.core.isActive(session) || session.user?.id !== userId)
        throw new Error("账号已改变，云端资料已刷新；请重新打开当前账号的资料库。");
      const source = result.data.sources.find((item) => item.id === target.source.id);
      if (
        !source ||
        source.versionId !== target.source.versionId ||
        source.versions?.some((item) => item.versionId === target.version.versionId)
      )
        throw new Error("云端历史版本清理结果不完整，已暂停同步，请刷新资料库后重试。");
      session.data = result.data;
      session.confirmedCloud = structuredClone(result.data);
      session.revision = result.revision;
      session.knownRevision = true;
      session.localDirty = true;
      session.cloudDirty = false;
      session.blocked = null;
      session.recovery = null;
      session.recoveryRevision = null;
      this.core.remember(session);
      try {
        await this.core.persist(session);
      } catch (cause) {
        // Report the unconfirmed local copy even when the account moved on, the
        // way a full source purge does. Returning quietly here would resolve as
        // success and hide that this account still has to retry its save.
        if (!this.core.isActive(session) || session.user?.id !== userId)
          throw new PurgeLocalPersistenceError(
            "账号已改变；云端已完成历史版本清理，但原账号新的本机副本未能确认保存：" +
              errorText(cause) +
              "。请重新打开原账号核对并重试保存。",
          );
        session.purging = false;
        session.ready = true;
        session.blocked = "error";
        session.status = "error";
        session.error =
          "云端已完成历史版本清理，但新的本地副本尚未保存：" +
          errorText(cause) +
          "。已暂停同步，请先重试保存。";
        this.core.remember(session);
        this.core.publish(session);
        throw new PurgeLocalPersistenceError(session.error);
      }
      if (!this.core.isActive(session) || session.user?.id !== userId)
        throw new Error("账号已改变，云端已完成历史版本清理；请重新打开原账号查看结果。");
      session.purging = false;
      session.ready = true;
      session.status = "cloud";
      session.error = result.cleanupPending
        ? "历史版本元数据已清理；云端原件正在后台清理。"
        : "历史版本已清理。";
      this.core.remember(session);
      this.core.publish(session);
      for (const key of localKeys) {
        if (this.core.originals.referencesBlob(key) || !this.core.io.deleteUnreferencedBlob)
          continue;
        try {
          await this.core.originals.deleteLocalOriginal(session, key);
        } catch {
          // The cloud metadata is durable. A later reference-safe cleanup may retry.
        }
      }
    } catch (cause) {
      if (!this.core.isActive(session)) throw cause;
      if (cause instanceof PurgeLocalPersistenceError) throw cause;
      session.purging = false;
      session.ready = true;
      session.blocked = "error";
      session.status = "error";
      session.error =
        "无法确认云端是否已完成历史版本清理，已暂停同步。" +
        errorText(cause) +
        " 请刷新资料库后再继续。";
      this.core.remember(session);
      this.core.publish(session);
      throw cause;
    }
  }
}
