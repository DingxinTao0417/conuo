"use client";
import { Plus } from "lucide-react";
import type { WorkspaceData } from "@/lib/types";
import type { WorkspaceStore } from "../../types";

export type SpacesPaneProps = {
  data: WorkspaceData;
  update: WorkspaceStore["update"];
  setSpaceToDeleteId: (spaceId: string) => void;
  setModal: (modal: "delete-space") => void;
  openSpaceCreation: () => void;
  chooseSpace: (spaceId: string) => void;
};

/**
 * Settings owns only the workspace-wide space operations: creating one, and
 * reaching archived spaces that the sidebar hides. An active space is renamed,
 * re-aimed, exported, archived, or deleted from its own overview page.
 */
export default function SpacesPane({
  data,
  update,
  setSpaceToDeleteId,
  setModal,
  openSpaceCreation,
  chooseSpace,
}: SpacesPaneProps) {
  const active = data.spaces.filter((space) => !space.archived);
  const archived = data.spaces.filter((space) => space.archived);
  return (
    <>
      <div className="settings-card">
        <h2>学习空间</h2>
        <div className="setting-row">
          <div>
            <b>新建学习空间</b>
            <p>
              按主题创建一个空间，让相关资料聚在一起。名称、学习目标、导出与删除在该空间的概览页管理。
            </p>
          </div>
          <button className="btn" onClick={() => openSpaceCreation()}>
            <Plus size={14} />
            新建学习空间
          </button>
        </div>
        {active.length > 0 && (
          <div className="setting-row">
            <div>
              <b>使用中的空间（{active.length}）</b>
              <p>{active.map((space) => space.name).join("、")}</p>
            </div>
            <button className="btn" onClick={() => chooseSpace(active[0]!.id)}>
              打开空间
            </button>
          </div>
        )}
      </div>
      <div className="settings-card">
        <h2>已归档空间</h2>
        {archived.length ? (
          archived.map((space) => (
            <div className="setting-row" key={space.id}>
              <div>
                <b>{space.name}</b>
                <p>{space.goal || "已归档；资料仍保留，恢复后会重新出现在侧边栏。"}</p>
              </div>
              <div className="setting-actions">
                <button
                  className="btn"
                  onClick={() =>
                    update((d) => ({
                      ...d,
                      spaces: d.spaces.map((x) =>
                        x.id === space.id ? { ...x, archived: false } : x,
                      ),
                    }))
                  }
                >
                  恢复空间
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
          ))
        ) : (
          <p className="muted">还没有归档的学习空间。</p>
        )}
      </div>
    </>
  );
}
