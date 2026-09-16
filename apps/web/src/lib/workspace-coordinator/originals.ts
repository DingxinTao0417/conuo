import { getSourceVersion } from "../source-versions";
import type { Source, WorkspaceData } from "../types";
import { OriginalSyncError } from "./errors";

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
