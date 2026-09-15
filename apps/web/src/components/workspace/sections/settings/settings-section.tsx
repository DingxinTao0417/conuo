"use client";
import type { ExportProgress } from "@/lib/export";
import type { WorkspaceData } from "@/lib/types";
import { settingsPanes, type SettingsPane } from "../../navigation";
import type { WorkspaceStorageMode, WorkspaceStore, WorkspaceUser } from "../../types";
import AccountPane from "./account-pane";
import AiPane from "./ai-pane";
import ReadingPane from "./reading-pane";
import SpacesPane from "./spaces-pane";
import StoragePane from "./storage-pane";

export type SettingsSectionProps = {
  data: WorkspaceData;
  store: WorkspaceStore;
  user: WorkspaceUser;
  update: WorkspaceStore["update"];
  ready: boolean;
  status: WorkspaceStore["status"];
  storageMode: WorkspaceStorageMode;
  cloudConfigured: boolean;
  durableProcessorEnabled: boolean;
  settingsSyncPresentation: { label: string; description: string };
  busy: boolean;
  exporting: boolean;
  exportProgress: ExportProgress | null;
  settingsPane: SettingsPane;
  openSettingsPane: (pane: SettingsPane) => void;
  navigate: (section: "tasks" | "trash") => void;
  setModal: (modal: "account" | "restore" | "legacy-recovery" | "delete-space") => void;
  setToast: (message: string) => void;
  setSpaceToDeleteId: (spaceId: string) => void;
  openExport: () => void;
  openSpaceCreation: () => void;
  chooseSpace: (spaceId: string) => void;
};

export default function SettingsSection({
  data,
  store,
  user,
  update,
  ready,
  status,
  storageMode,
  cloudConfigured,
  durableProcessorEnabled,
  settingsSyncPresentation,
  busy,
  exporting,
  exportProgress,
  settingsPane,
  openSettingsPane,
  navigate,
  setModal,
  setToast,
  setSpaceToDeleteId,
  openExport,
  openSpaceCreation,
  chooseSpace,
}: SettingsSectionProps) {
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">按你的方式学习</p>
          <h1>设置</h1>
          <p>控制资料的保存位置与检索权限。</p>
        </div>
      </div>
      <nav className="settings-panes" aria-label="设置分组">
        {settingsPanes.map(([pane, label]) => (
          <button
            key={pane}
            type="button"
            className={settingsPane === pane ? "active" : ""}
            aria-current={settingsPane === pane ? "page" : undefined}
            onClick={() => openSettingsPane(pane)}
          >
            {label}
          </button>
        ))}
      </nav>
      {settingsPane === "account" && (
        <AccountPane user={user} cloudConfigured={cloudConfigured} setModal={setModal} />
      )}
      {settingsPane === "ai" && (
        <AiPane
          data={data}
          store={store}
          user={user}
          update={update}
          durableProcessorEnabled={durableProcessorEnabled}
          setToast={setToast}
        />
      )}
      {settingsPane === "storage" && (
        <StoragePane
          data={data}
          ready={ready}
          status={status}
          storageMode={storageMode}
          busy={busy}
          exporting={exporting}
          exportProgress={exportProgress}
          navigate={navigate}
          setModal={setModal}
          openExport={openExport}
        />
      )}
      {settingsPane === "reading" && (
        <ReadingPane settingsSyncPresentation={settingsSyncPresentation} navigate={navigate} />
      )}
      {settingsPane === "spaces" && (
        <SpacesPane
          data={data}
          update={update}
          setSpaceToDeleteId={setSpaceToDeleteId}
          setModal={setModal}
          openSpaceCreation={openSpaceCreation}
          chooseSpace={chooseSpace}
        />
      )}
    </>
  );
}
