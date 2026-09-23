import type { Snapshot, Source, Workspace } from "./contracts.ts";
import { blankWorkspace } from "./contracts.ts";
import { assertPdfWorkspaceCapacity } from "./pdf-import.ts";

type PdfImportApi = {
  load: (owner: string) => Promise<Snapshot>;
  save: (owner: string, snapshot: Snapshot, data: Workspace) => Promise<Snapshot>;
};

export async function saveImportedPdfWithCAS(input: {
  owner: string;
  source: Source;
  spaceId: string;
  initial: Snapshot;
  api: PdfImportApi;
  isCurrent: () => boolean;
  isAuthenticationError?: (cause: unknown) => boolean;
  onSnapshot?: (snapshot: Snapshot) => void;
}) {
  let base = input.initial;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!input.isCurrent()) throw new Error("账号已改变，已停止保存这份 PDF。");
    const data = base.data ?? blankWorkspace();
    const duplicate = data.sources.find(
      (item) => !item.deletedAt && item.kind === "pdf" && item.hash === input.source.hash,
    );
    if (
      duplicate &&
      duplicate.id !== input.source.id &&
      !duplicate.storagePath &&
      input.source.storagePath
    )
      throw new Error(
        "另一台设备刚导入了相同 PDF，但原件尚未确认。请再次选择这份文件完成原件恢复。",
      );

    const merged = assertPdfWorkspaceCapacity(
      data,
      duplicate?.id === input.source.id ? input.source : duplicate ?? input.source,
      input.spaceId,
    );
    if (!merged.changed) {
      input.onSnapshot?.(base);
      return { source: merged.source, duplicate: !!duplicate, snapshot: base };
    }

    try {
      const saved = await input.api.save(input.owner, base, merged.workspace);
      if (!input.isCurrent()) throw new Error("账号已改变，已忽略这次 PDF 保存结果。");
      input.onSnapshot?.(saved);
      return { source: merged.source, duplicate: !!duplicate, snapshot: saved };
    } catch (cause) {
      if (!input.isCurrent()) throw new Error("账号已改变，已停止核对这份 PDF。");
      const status =
        cause && typeof cause === "object" && "status" in cause &&
        typeof cause.status === "number"
          ? cause.status
          : null;
      if (status !== null && status >= 400 && status < 500 && status !== 409) throw cause;

      let fresh: Snapshot;
      try {
        fresh = await input.api.load(input.owner);
      } catch (readError) {
        if (input.isAuthenticationError?.(readError)) throw readError;
        throw new Error(
          "原件已上传，但资料库是否保存尚未确认。请保留源文件，重新选择同一 PDF 后重试核对。",
        );
      }
      if (!input.isCurrent()) throw new Error("账号已改变，已停止核对这份 PDF。");
      const confirmed = fresh.data?.sources.find(
        (item) => item.id === input.source.id && item.versionId === input.source.versionId,
      );
      input.onSnapshot?.(fresh);
      if (confirmed) return { source: confirmed, duplicate: false, snapshot: fresh };
      base = fresh;
    }
  }
  throw new Error(
    "资料库持续发生并发修改；原件仍未显示为已保存。请重新选择同一 PDF 后重试核对。",
  );
}
