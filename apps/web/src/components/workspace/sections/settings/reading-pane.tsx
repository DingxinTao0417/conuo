"use client";

export type ReadingPaneProps = {
  settingsSyncPresentation: { label: string; description: string };
  navigate: (section: "tasks") => void;
};

export default function ReadingPane({ settingsSyncPresentation, navigate }: ReadingPaneProps) {
  return (
    <div className="settings-card">
      <h2>保存与同步</h2>
      <div className="setting-row">
        <div role="status" aria-live="polite" aria-label="当前工作区保存状态">
          <b>当前工作区保存状态：{settingsSyncPresentation.label}</b>
          <p>{settingsSyncPresentation.description}</p>
        </div>
        <button className="btn" onClick={() => navigate("tasks")}>
          查看同步与任务
        </button>
      </div>
    </div>
  );
}
