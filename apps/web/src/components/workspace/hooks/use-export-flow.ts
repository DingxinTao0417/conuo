import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { exportWorkspace, type ExportIssue, type ExportProgress } from "@/lib/export";
import { workspaceExportFingerprint, type WorkspaceExportScope } from "@/lib/export-scope";
import type { WorkspaceData } from "@/lib/types";
import type { WorkspaceModal, WorkspaceStorageMode, WorkspaceStore } from "../types";

type ExportContext = {
  token: number;
  userId: string | null;
  localCacheMode: WorkspaceStore["localCacheMode"];
  ready: boolean;
  data: WorkspaceData;
};

export type UseExportFlowParams = {
  data: WorkspaceData;
  store: WorkspaceStore;
  userId: string | null;
  localCacheMode: WorkspaceStore["localCacheMode"];
  ready: boolean;
  storageMode: WorkspaceStorageMode;
  setModal: Dispatch<SetStateAction<WorkspaceModal>>;
  setToast: (message: string) => void;
};

/**
 * Owns the backup-export transaction: scope selection, progress, unresolved
 * original-file issues, and the account/workspace context guard that aborts a
 * download when the signed-in account or workspace token changes mid-flight.
 */
export function useExportFlow({
  data,
  store,
  userId,
  localCacheMode,
  ready,
  storageMode,
  setModal,
  setToast,
}: UseExportFlowParams) {
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [exportIssues, setExportIssues] = useState<ExportIssue[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportScope, setExportScope] = useState<WorkspaceExportScope>({ kind: "workspace" });
  const exportOperation = useRef<object | null>(null);
  const exportContext = useRef<ExportContext | null>({
    token: store.token,
    userId,
    localCacheMode,
    ready,
    data,
  });

  useLayoutEffect(() => {
    const previous = exportContext.current;
    const contextChanged =
      previous &&
      (previous.token !== store.token ||
        previous.userId !== userId ||
        previous.localCacheMode !== localCacheMode ||
        previous.ready !== ready);
    exportContext.current = { token: store.token, userId, localCacheMode, ready, data };
    if (contextChanged) {
      // Invalidate the old account's external download transaction before paint.
      setModal((current) => (current === "export" || current === "export-result" ? null : current));
      if (exportOperation.current) {
        exportOperation.current = null;
        setBusy(false);
        setExporting(false);
        setExportProgress(null);
      }
      setExportIssues(null);
    }
  }, [store.token, userId, localCacheMode, ready, data, setModal]);
  useLayoutEffect(
    () => () => {
      exportContext.current = null;
      exportOperation.current = null;
    },
    [],
  );

  /** Drop any in-flight export and clear its transient state (account stop, sign-out). */
  const reset = useCallback(() => {
    exportOperation.current = null;
    setExportIssues(null);
    setExportProgress(null);
    setBusy(false);
    setExporting(false);
  }, []);

  function openExport(scope: WorkspaceExportScope = { kind: "workspace" }) {
    if (exportOperation.current) return;
    setExportScope(scope);
    setModal("export");
  }

  async function doExport(
    state: WorkspaceData = data,
    options?: { scope: WorkspaceExportScope; expectedFingerprint: string },
  ): Promise<boolean> {
    if (exportOperation.current) return false;
    const operation = {};
    const owner = { token: store.token, userId, localCacheMode };
    exportOperation.current = operation;
    function isCurrent() {
      const context = exportContext.current;
      return (
        exportOperation.current === operation &&
        context?.ready === true &&
        context.token === owner.token &&
        context.userId === owner.userId &&
        context.localCacheMode === owner.localCacheMode
      );
    }
    function assertCanContinue() {
      if (!isCurrent()) throw new Error("账号或工作区状态已变化，已停止导出，请重新核对范围。");
    }
    try {
      assertCanContinue();
      if (
        options &&
        workspaceExportFingerprint(exportContext.current!.data, options.scope) !==
          options.expectedFingerprint
      ) {
        throw new Error("导出范围已变化，请刷新预览后再下载。");
      }
      setBusy(true);
      setExporting(true);
      setExportProgress(null);
      setExportIssues(null);
      const result = await exportWorkspace(state, store.sourceBlob, {
        ...(options ? { scope: options.scope } : {}),
        assertCanContinue,
        onProgress: (progress) => {
          assertCanContinue();
          setExportProgress(progress);
        },
      });
      assertCanContinue();
      if (result.issues.length) {
        setExportIssues(result.issues);
        setModal("export-result");
        setToast("备份已下载；" + result.issues.length + " 个原文件版本未包含。");
      } else {
        setModal((current) => (current === "export" ? null : current));
        setToast("导出文件已准备好。");
      }
      return storageMode !== "cloud" || result.issues.length === 0;
    } catch (e) {
      if (isCurrent()) setToast(e instanceof Error ? e.message : "导出失败。");
      return false;
    } finally {
      if (exportOperation.current === operation) {
        exportOperation.current = null;
        setBusy(false);
        setExporting(false);
        setExportProgress(null);
      }
    }
  }

  return {
    busy,
    exporting,
    exportProgress,
    exportIssues,
    setExportIssues,
    exportScope,
    openExport,
    doExport,
    reset,
  };
}
