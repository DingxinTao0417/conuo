"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { OnAnswerProgress } from "./answer-stream-types";
import type { RestorePlan } from "./backup-types";
import {
  isCloudConfigured,
  subscribeSession,
  type SourcePurgePreview,
  type SourceVersionPurgePreview,
} from "./cloud";
import { startForegroundCloudUpdateChecks } from "./foreground-cloud-updates";
import {
  isLocalDevelopmentOrganizationRunnerEnabled,
  isOrganizationProcessorEnabled,
  localDevelopmentOrganizationRunnerStateFromEnvironment,
  organizationProcessorStateFromEnvironment,
} from "./organization-processor-capability";
import { OrganizationRunner, type OrganizationInput } from "./organization-runner";
import type { PermanentSourceDeletionSelection } from "./permanent-deletion";
import type { AnswerRequest, Source, SourceBlobReadOptions, WorkspaceData } from "./types";
import { WorkspaceCoordinator } from "./workspace-coordinator/coordinator";
import {
  accountKey,
  createWebCloudWorkspaceIO,
  defaultImportPipeline,
  defaultIO,
} from "./workspace-coordinator/io";
import type {
  NoteSyncConflictSelection,
  ReadingProgressSyncSelection,
  User,
} from "./workspace-coordinator/types";

export { WorkspaceCoordinator } from "./workspace-coordinator/coordinator";
export { createWebCloudWorkspaceIO } from "./workspace-coordinator/io";
export type {
  AnonymousWorkspaceMigrationState,
  ImportPipeline,
  ImportStartResult,
  LocalCacheMode,
  NoteSyncConflictSelection,
  ReadingProgressSyncSelection,
  WorkspaceIO,
  WorkspaceSignOutState,
} from "./workspace-coordinator/types";
export function useWorkspace(options: { storageMode?: "hybrid" | "cloud" } = {}) {
  const storageMode = options.storageMode ?? "hybrid";
  const organizationProcessorState = organizationProcessorStateFromEnvironment();
  const durableOrganizationProcessorEnabled = isOrganizationProcessorEnabled(
    organizationProcessorState,
  );
  const localDevelopmentOrganizationRunnerEnabled =
    !durableOrganizationProcessorEnabled &&
    isLocalDevelopmentOrganizationRunnerEnabled(
      localDevelopmentOrganizationRunnerStateFromEnvironment(),
    );
  const [coordinator] = useState(
    () =>
      new WorkspaceCoordinator(
        storageMode === "cloud" ? createWebCloudWorkspaceIO() : defaultIO,
        defaultImportPipeline,
        {
          storageMode,
          durableOrganizationProcessorEnabled,
          localDevelopmentOrganizationRunnerEnabled,
        },
      ),
  );
  const [organizationRunner] = useState(
    () => new OrganizationRunner(coordinator, durableOrganizationProcessorEnabled),
  );
  const acceptedSessionKey = useRef<string | undefined>(undefined);
  const view = useSyncExternalStore(
    coordinator.subscribe,
    coordinator.getSnapshot,
    coordinator.getSnapshot,
  );
  const cloudAccountId = view.user?.id;
  const activate = useCallback(
    (user: User | null) => {
      const key = accountKey(user);
      if (key === acceptedSessionKey.current) return Promise.resolve();
      acceptedSessionKey.current = key;
      return coordinator.activate(user);
    },
    [coordinator],
  );
  useEffect(() => {
    const accept = (user: User | null) => {
      void activate(user);
    };
    let unsubscribe = () => {};
    if (!isCloudConfigured()) {
      accept(null);
    } else {
      unsubscribe = subscribeSession(accept);
    }
    return () => {
      unsubscribe();
      acceptedSessionKey.current = undefined;
      coordinator.dispose();
    };
  }, [activate, coordinator]);
  useEffect(() => {
    organizationRunner.start();
    const stop = () => {
      organizationRunner.stop();
      coordinator.stopOrganizations();
    };
    const resume = () => organizationRunner.start();
    window.addEventListener("pagehide", stop);
    window.addEventListener("pageshow", resume);
    return () => {
      window.removeEventListener("pagehide", stop);
      window.removeEventListener("pageshow", resume);
      stop();
    };
  }, [coordinator, organizationRunner]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (coordinator.hasUnsavedLocalChanges()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [coordinator]);
  useEffect(() => {
    if (!cloudAccountId || !view.ready) return;
    const token = view.token;
    return startForegroundCloudUpdateChecks((signal) =>
      coordinator.checkCloudUpdates(token, signal),
    );
  }, [coordinator, cloudAccountId, view.ready, view.token]);
  const update = useCallback(
    (updater: (data: WorkspaceData) => WorkspaceData) => coordinator.update(updater, view.token),
    [coordinator, view.token],
  );
  const updateDurably = useCallback(
    (updater: (data: WorkspaceData) => WorkspaceData) =>
      coordinator.updateDurably(updater, view.token),
    [coordinator, view.token],
  );
  const getCurrentWorkspaceData = useCallback(
    () => coordinator.readCurrentData(view.token, view.user?.id ?? null, view.localCacheMode),
    [coordinator, view.token, view.user?.id, view.localCacheMode],
  );
  const retry = useCallback(() => coordinator.retry(view.token), [coordinator, view.token]);
  const useRemote = useCallback(
    (preserveCurrent?: (snapshot: WorkspaceData) => Promise<boolean>) =>
      coordinator.useRemote(view.token, preserveCurrent),
    [coordinator, view.token],
  );
  const loadLatestLocal = useCallback(
    (preserveLocalChanges?: (snapshot: WorkspaceData) => Promise<boolean>) =>
      coordinator.loadLatestLocal(view.token, preserveLocalChanges),
    [coordinator, view.token],
  );
  const checkCloudUpdates = useCallback(
    () => coordinator.checkCloudUpdates(view.token),
    [coordinator, view.token],
  );
  const loadCloudUpdate = useCallback(
    () => coordinator.loadCloudUpdate(view.token),
    [coordinator, view.token],
  );
  const setPendingReadingPosition = useCallback(
    (readerKey: string, pending: boolean) =>
      coordinator.setPendingReadingPosition(view.token, readerKey, pending),
    [coordinator, view.token],
  );
  const migrateAnonymousWorkspace = useCallback(
    () => coordinator.migrateAnonymousWorkspace(view.token),
    [coordinator, view.token],
  );
  const skipAnonymousWorkspaceMigration = useCallback(
    () => coordinator.skipAnonymousWorkspaceMigration(view.token),
    [coordinator, view.token],
  );
  const resolveNoteConflicts = useCallback(
    (selections: readonly NoteSyncConflictSelection[]) =>
      coordinator.resolveNoteConflicts(selections, view.token),
    [coordinator, view.token],
  );
  const resolveReadingProgressConflicts = useCallback(
    (selections: readonly ReadingProgressSyncSelection[]) =>
      coordinator.resolveReadingProgressConflicts(selections, view.token),
    [coordinator, view.token],
  );
  const previewSourcePurge = useCallback(
    (sourceId: string, selection?: PermanentSourceDeletionSelection, signal?: AbortSignal) =>
      coordinator.previewSourcePurge(sourceId, view.token, selection, signal),
    [coordinator, view.token],
  );
  const purgeSource = useCallback(
    (sourceId: string, preview: SourcePurgePreview) =>
      coordinator.purgeSource(sourceId, preview, view.token),
    [coordinator, view.token],
  );
  const previewSourceVersionPurge = useCallback(
    (sourceId: string, versionId: string) =>
      coordinator.previewSourceVersionPurge(sourceId, versionId, view.token),
    [coordinator, view.token],
  );
  const purgeSourceVersion = useCallback(
    (sourceId: string, versionId: string, preview: SourceVersionPurgePreview) =>
      coordinator.purgeSourceVersion(sourceId, versionId, preview, view.token),
    [coordinator, view.token],
  );
  const sourceBlob = useCallback(
    (source: Source, options?: SourceBlobReadOptions) =>
      coordinator.sourceBlob(source, view.token, options),
    [coordinator, view.token],
  );
  const replaceFile = useCallback(
    (sourceId: string, expectedVersionId: string, candidate: Source, blob: Blob) =>
      coordinator.replaceFile(sourceId, expectedVersionId, candidate, blob, view.token),
    [coordinator, view.token],
  );
  const importFile = useCallback(
    (file: File, spaceId: string, keepDuplicate = false, aiAllowed = false) =>
      coordinator.importFile(file, spaceId, view.token, keepDuplicate, aiAllowed),
    [coordinator, view.token],
  );
  const retryImport = useCallback(
    (jobId: string) => coordinator.retryImport(jobId, view.token),
    [coordinator, view.token],
  );
  const cancelImport = useCallback(
    (jobId: string) => coordinator.cancelImport(jobId, view.token),
    [coordinator, view.token],
  );
  const restoreBackup = useCallback(
    (plan: RestorePlan) => coordinator.restoreBackup(plan, view.token),
    [coordinator, view.token],
  );
  const ask = useCallback(
    (request: AnswerRequest, signal: AbortSignal, onProgress?: OnAnswerProgress) =>
      coordinator.ask(request, signal, view.token, onProgress),
    [coordinator, view.token],
  );
  const organize = useCallback(
    (input: OrganizationInput, signal?: AbortSignal) =>
      coordinator.organize(input, signal, view.token),
    [coordinator, view.token],
  );
  const stopOrganization = useCallback(
    (id: string) => coordinator.stopOrganization(id, view.token),
    [coordinator, view.token],
  );
  const checkOrganization = useCallback(
    (id: string) => coordinator.checkOrganization(id, view.token),
    [coordinator, view.token],
  );
  const retryOrganization = useCallback(
    (id: string) => coordinator.retryOrganization(id, view.token),
    [coordinator, view.token],
  );
  const refreshOrganizationStatus = useCallback(
    () => organizationRunner.refresh(),
    [organizationRunner],
  );
  const discardAccount = useCallback(
    (accountId: string) => coordinator.discardAccount(accountId),
    [coordinator],
  );
  const retryAccountLocalDeletion = useCallback(
    () => coordinator.retryAccountLocalDeletion(),
    [coordinator],
  );
  const signOut = useCallback(
    async (strategy: "direct" | "sync" | "local", completeLocalSignOut: () => Promise<void>) => {
      await coordinator.signOut(view.token, strategy, completeLocalSignOut);
      // Auth normally emits SIGNED_OUT, but moving the coordinator explicitly
      // also clears the frozen account view if that event is delivered late.
      await activate(null);
    },
    [activate, coordinator, view.token],
  );
  return {
    ...view,
    update,
    updateDurably,
    getCurrentWorkspaceData,
    retry,
    useRemote,
    loadLatestLocal,
    checkCloudUpdates,
    loadCloudUpdate,
    setPendingReadingPosition,
    migrateAnonymousWorkspace,
    skipAnonymousWorkspaceMigration,
    resolveNoteConflicts,
    resolveReadingProgressConflicts,
    previewSourcePurge,
    purgeSource,
    previewSourceVersionPurge,
    purgeSourceVersion,
    sourceBlob,
    replaceFile,
    importFile,
    retryImport,
    cancelImport,
    restoreBackup,
    ask,
    organize,
    stopOrganization,
    checkOrganization,
    retryOrganization,
    refreshOrganizationStatus,
    discardAccount,
    retryAccountLocalDeletion,
    signOut,
  };
}
