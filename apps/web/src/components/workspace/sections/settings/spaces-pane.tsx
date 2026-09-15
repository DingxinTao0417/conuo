"use client";
import { Plus } from "lucide-react";
import { renameLearningSpace } from "@/lib/space-lifecycle";
import type { WorkspaceData } from "@/lib/types";
import LearningSpaceNameInput from "../../../learning-space-name-input";
import type { WorkspaceStore, WorkspaceUser } from "../../types";

export type SpacesPaneProps = {
  data: WorkspaceData;
  user: WorkspaceUser;
  update: WorkspaceStore["update"];
  setToast: (message: string) => void;
  setSpaceToDeleteId: (spaceId: string) => void;
  setModal: (modal: "delete-space") => void;
  openSpaceCreation: () => void;
};

export default function SpacesPane({
  data,
  user,
  update,
  setToast,
  setSpaceToDeleteId,
  setModal,
  openSpaceCreation,
}: SpacesPaneProps) {
  return (
    <div className="settings-card">
      <h2>学习空间</h2>
      {data.spaces.map((s) => (
        <div className="setting-row" key={s.id}>
          <div>
            <LearningSpaceNameInput
              key={`${user?.id || "local"}:${s.id}`}
              space={s}
              onRename={(name, expectedName) => {
                let renamed = false;
                try {
                  update((d) => {
                    if (d.spaces.find((item) => item.id === s.id)?.name !== expectedName) return d;
                    const next = renameLearningSpace(d, s.id, name);
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
              aria-label={`学习目标 ${s.name}`}
              className="field space-goal-input"
              placeholder="添加学习目标（可选）"
              value={s.goal}
              onChange={(e) =>
                update((d) => ({
                  ...d,
                  spaces: d.spaces.map((x) => (x.id === s.id ? { ...x, goal: e.target.value } : x)),
                }))
              }
            />
          </div>
          <div className="setting-actions">
            <button
              className="btn"
              onClick={() =>
                update((d) => ({
                  ...d,
                  spaces: d.spaces.map((x) =>
                    x.id === s.id ? { ...x, archived: !x.archived } : x,
                  ),
                }))
              }
            >
              {s.archived ? "恢复空间" : "归档空间"}
            </button>
            <button
              className="btn btn-danger"
              onClick={() => {
                setSpaceToDeleteId(s.id);
                setModal("delete-space");
              }}
            >
              删除空间
            </button>
          </div>
        </div>
      ))}
      <button className="btn" onClick={() => openSpaceCreation()}>
        <Plus size={14} />
        新建学习空间
      </button>
    </div>
  );
}
