"use client";
import Image from "next/image";
import { ChevronRight, FileText, Inbox, Plus, Settings2, ShieldCheck, Trash2 } from "lucide-react";
import type { Note, Source, WorkspaceData } from "@/lib/types";
import { sections, type Section } from "./navigation";
import type { WorkspaceStore, WorkspaceUser } from "./types";

export type WorkspaceSidebarProps = {
  data: WorkspaceData;
  user: WorkspaceUser;
  status: WorkspaceStore["status"];
  cloudConfigured: boolean;
  sidebar: boolean;
  setSidebar: (open: boolean) => void;
  section: Section;
  spaceId: string;
  sourceId: string | null;
  currentSource: Source | undefined;
  currentNote: Note | undefined;
  pinnedSources: Source[];
  navigate: (section: Section) => void;
  openCollectionHome: () => void;
  chooseSpace: (id: string) => void;
  openSource: (id: string) => void;
  openSpaceCreation: () => void;
  setModal: (modal: "account") => void;
};

export default function WorkspaceSidebar({
  data,
  user,
  status,
  cloudConfigured,
  sidebar,
  setSidebar,
  section,
  spaceId,
  sourceId,
  currentSource,
  currentNote,
  pinnedSources,
  navigate,
  openCollectionHome,
  chooseSpace,
  openSource,
  openSpaceCreation,
  setModal,
}: WorkspaceSidebarProps) {
  return (
    <>
      {sidebar && (
        <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setSidebar(false)} />
      )}
      <aside className={`sidebar ${sidebar ? "sidebar-open" : ""}`}>
        <button className="brand" onClick={() => navigate("home")} aria-label="Conuo 学习概览">
          <Image src="/conuo-logo.png" alt="" width={34} height={34} priority />
          <span>
            Conuo <small>可诺</small>
          </span>
        </button>
        <nav aria-label="主导航">
          {sections.map(([key, label, Icon]) => (
            <button
              key={key}
              className={`nav-item ${section === key && !currentSource && !currentNote ? "active" : ""}`}
              aria-label={label}
              title={label}
              onClick={() => {
                if (key === "library") {
                  openCollectionHome();
                } else {
                  navigate(key);
                }
              }}
            >
              <Icon size={17} />
              <span className="nav-item-label">{label}</span>
              {key === "library" && (
                <span className="nav-count">{data.sources.filter((s) => !s.deletedAt).length}</span>
              )}
            </button>
          ))}
        </nav>
        <section className="pinned-source-section" aria-labelledby="pinned-source-title">
          <div className="nav-heading">
            <span id="pinned-source-title">置顶资料</span>
          </div>
          {pinnedSources.length > 0 && (
            <div className="pinned-source-list">
              {pinnedSources.map((source) => (
                <button
                  key={source.id}
                  className={`nav-item ${sourceId === source.id ? "active" : ""}`}
                  aria-label={`打开置顶资料 ${source.title}`}
                  title={source.title}
                  onClick={() => openSource(source.id)}
                >
                  <FileText size={16} />
                  <span className="nav-item-label">{source.title}</span>
                </button>
              ))}
            </div>
          )}
        </section>
        <div className="nav-heading">
          <span>我的知识库</span>
          <button className="icon-btn" aria-label="新建知识库" onClick={() => openSpaceCreation()}>
            <Plus size={15} />
          </button>
        </div>
        <div className="space-list">
          {data.spaces
            .filter((s) => !s.archived)
            .map((s) => (
              <button
                key={s.id}
                className={`nav-item ${spaceId === s.id ? "space-active" : ""}`}
                aria-label={s.name}
                title={s.name}
                onClick={() => chooseSpace(s.id)}
              >
                <span className="space-dot" style={{ background: s.color }} />
                <span className="nav-item-label">{s.name}</span>
              </button>
            ))}
          <button
            className="nav-item"
            onClick={() => chooseSpace("inbox")}
            aria-label="收件箱"
            title="收件箱"
          >
            <Inbox size={16} />
            <span className="nav-item-label">收件箱</span>
            <span className="nav-count">
              {data.sources.filter((s) => !s.deletedAt && !s.spaceIds.length).length || ""}
            </span>
          </button>
        </div>
        <div className="sidebar-bottom">
          <div className="local-hint">
            <ShieldCheck size={15} />
            <span>
              {user ? "私有学习空间" : "本机工作区"}
              <small>
                {user
                  ? "仅你可以访问"
                  : cloudConfigured
                    ? "资料保存在当前浏览器"
                    : "云端同步暂不可用"}
              </small>
            </span>
          </div>
          <button
            className={`nav-item ${section === "trash" ? "active" : ""}`}
            onClick={() => navigate("trash")}
            aria-label="回收站"
            title="回收站"
          >
            <Trash2 size={16} />
            <span className="nav-item-label">回收站</span>
          </button>
          <button
            className={`nav-item ${section === "settings" ? "active" : ""}`}
            onClick={() => navigate("settings")}
            aria-label="设置"
            title="设置"
          >
            <Settings2 size={16} />
            <span className="nav-item-label">设置</span>
          </button>
          <button
            className="user-button"
            onClick={() => setModal("account")}
            disabled={status === "saving"}
            aria-label={
              user && cloudConfigured
                ? `账号与云端保存：${user.email}`
                : cloudConfigured
                  ? "登录以连接云端"
                  : "本机工作区"
            }
            title={
              user && cloudConfigured
                ? "账号与云端保存"
                : cloudConfigured
                  ? "登录以连接云端"
                  : "本机工作区"
            }
          >
            <span className="avatar">{user?.email.slice(0, 1).toUpperCase() || "C"}</span>
            <span>
              <b>
                {user && cloudConfigured
                  ? user.email
                  : cloudConfigured
                    ? "开始你的学习之旅"
                    : "本机工作区"}
              </b>
              <small>
                {user && cloudConfigured
                  ? "账号与云端保存"
                  : cloudConfigured
                    ? "登录以连接云端"
                    : "云端同步暂不可用"}
              </small>
            </span>
            <ChevronRight size={15} />
          </button>
        </div>
      </aside>
    </>
  );
}
