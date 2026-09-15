"use client";
import InstallAppPanel from "../../../install-app-panel";
import type { WorkspaceUser } from "../../types";

export type AccountPaneProps = {
  user: WorkspaceUser;
  cloudConfigured: boolean;
  setModal: (modal: "account") => void;
};

export default function AccountPane({ user, cloudConfigured, setModal }: AccountPaneProps) {
  return (
    <>
      <div className="settings-card">
        <h2>账号</h2>
        <div className="setting-row">
          <div>
            <b>{user && cloudConfigured ? user.email : "本机工作区"}</b>
            <p>
              {user && cloudConfigured
                ? "已连接账号；当前工作区是否已保存，以服务确认状态为准。"
                : cloudConfigured
                  ? "资料保存在此浏览器；登录后可同步到你的私有空间。"
                  : "云端同步暂不可用。资料仅保存在此浏览器；清除网站数据会删除本机副本，请及时导出。"}
            </p>
          </div>
          <button className="btn" onClick={() => setModal("account")}>
            {user && cloudConfigured ? "管理账号" : cloudConfigured ? "登录账号" : "查看本机工作区"}
          </button>
        </div>
      </div>
      <div className="settings-card">
        <h2>安装与设备</h2>
        <InstallAppPanel />
      </div>
    </>
  );
}
