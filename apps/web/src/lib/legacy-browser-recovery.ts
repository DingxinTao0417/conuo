import { readWorkspaceBackup } from "./backup-archive";
import { prepareBackupRestore } from "./backup-restore";
import type { RestorePlan } from "./backup-types";
import { buildWorkspaceArchiveResult } from "./export";
import { getBlob, loadLocalWorkspaceRecord } from "./local-store";

export interface LegacyBrowserRecovery {
  plan: RestorePlan;
  archive: Blob;
}

/** Explicit one-time recovery bridge; never reads an account cache or archived cloud URL. */
export async function prepareLegacyBrowserRecovery(
  signal?: AbortSignal,
): Promise<LegacyBrowserRecovery | null> {
  const assertCanContinue = () => {
    if (signal?.aborted) throw new DOMException("旧版资料读取已取消。", "AbortError");
  };
  assertCanContinue();
  const record = await loadLocalWorkspaceRecord("local");
  assertCanContinue();
  if (!record) return null;
  const snapshot = structuredClone(record);
  delete snapshot._conuoLocalRevision;
  delete snapshot._conuoSync;
  if (
    ![
      snapshot.sources,
      snapshot.notes,
      snapshot.annotations,
      snapshot.conversations,
      snapshot.importJobs,
      snapshot.organizationJobs,
      snapshot.conceptRelations,
      snapshot.recoverableDrafts,
      snapshot.resolvedRecoverableDrafts,
    ].some((items) => items?.length)
  )
    return null;
  const result = await buildWorkspaceArchiveResult(snapshot, {
    assertCanContinue,
    resolveBlob: (source) =>
      source.blobKey ? getBlob(source.blobKey, "local") : Promise.resolve(undefined),
  });
  assertCanContinue();
  const archive = new Blob([new Uint8Array(result.bytes)], { type: "application/zip" });
  const backup = await readWorkspaceBackup(archive, { signal });
  assertCanContinue();
  return { archive, plan: prepareBackupRestore(backup) };
}
