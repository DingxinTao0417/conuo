"use client";
import { ArrowDownToLine } from "lucide-react";
import type { WorkspaceExportScope } from "@/lib/export-scope";
import { renameLearningSpace } from "@/lib/space-lifecycle";
import type { Space } from "@/lib/types";
import LearningSpaceNameInput from "../../learning-space-name-input";
import type { WorkspaceStore, WorkspaceUser } from "../types";

export type SpaceSettingsCardProps = {
  space: Space;
  user: WorkspaceUser;
  busy: boolean;
  update: WorkspaceStore["update"];
  setToast: (message: string) => void;
  ensureCanActivateSpace?: (additional?: number) => Promise<boolean>;
  openExport: (scope: WorkspaceExportScope) => void;
  setSpaceToDeleteId: (spaceId: string) => void;
  setModal: (modal: "delete-space") => void;
};

/**
 * Manages the learning space a learner is currently inside. Settings keeps only
 * space creation and the archived list, so an active space has exactly one
 * place to be renamed, re-aimed, exported, archived, or deleted.
 */
export default function SpaceSettingsCard({
  space,
  user,
  busy,
  update,
  setToast,
  ensureCanActivateSpace,
  openExport,
  setSpaceToDeleteId,
  setModal,
}: SpaceSettingsCardProps) {
  return (
    <div className="settings-card space-settings-card">
      <h2>空间设置</h2>
      <div className="setting-row">
        <div>
          <LearningSpaceNameInput
            key={`${user?.id || "local"}:${space.id}`}
            space={space}
            onRename={(name, expectedName) => {
              let renamed = false;
              try {
                update((d) => {
                  if (d.spaces.find((item) => item.id === space.id)?.name !== expectedName)
                    return d;
                  const next = renameLearningSpace(d, space.id, name);
                  renamed = true;
                  return next;
                });
                if (!renamed) setToast("空间名称又有变化，输入仍保留，请重新确认。");
              } catch (cause) {
                renamed = false;
                setToast(cause instanceof Error ? cause.message : "空间名称未保存，输入仍保留。");
              }
              return renamed;
            }}
            onInvalid={() => setToast("学习空间名称不能为空，已保留原名称。")}
          />
          <input
            aria-label={`学习目标 ${space.name}`}
            className="field space-goal-input"
            placeholder="添加学习目标（可选）"
            value={space.goal}
            onChange={(e) =>
              update((d) => ({
                ...d,
                spaces: d.spaces.map((x) =>
                  x.id === space.id ? { ...x, goal: e.target.value } : x,
                ),
              }))
            }
          />
        </div>
        <div className="setting-actions">
          <button
            className="btn"
            disabled={busy}
            onClick={() => openExport({ kind: "space", spaceId: space.id })}
          >
            <ArrowDownToLine size={15} aria-hidden="true" />
            导出此知识库
          </button>
          <button
            className="btn"
            onClick={async () => {
              if (space.archived && ensureCanActivateSpace && !(await ensureCanActivateSpace(1)))
                return;
              if (
                !update((d) => ({
                  ...d,
                  spaces: d.spaces.map((x) =>
                    x.id === space.id ? { ...x, archived: !x.archived } : x,
                  ),
                }))
              )
                setToast("空间状态未保存，请稍后重试；当前内容仍然保留。");
            }}
          >
            {space.archived ? "恢复空间" : "归档空间"}
          </button>
          <button
            className="btn btn-danger"
            onClick={() => {
              setSpaceToDeleteId(space.id);
              setModal("delete-space");
            }}
          >
            删除空间
          </button>
        </div>
      </div>
      <p className="muted space-settings-note">
        改名与学习目标会立即保存；归档后空间从侧边栏收起，资料仍保留。删除空间前会先展示影响。
      </p>
    </div>
  );
}
