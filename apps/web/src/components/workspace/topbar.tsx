"use client";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Cloud,
  History,
  ListChecks,
  Loader2,
  Menu,
  PanelLeft,
  Search,
} from "lucide-react";
import type { Note, Source, Space } from "@/lib/types";
import { labels, type Section } from "./navigation";
import type { WorkspaceStore, WorkspaceUser } from "./types";

export type WorkspaceTopbarProps = {
  user: WorkspaceUser;
  status: WorkspaceStore["status"];
  cloudConfigured: boolean;
  cloudReadOnly: boolean;
  saveLabel: string;
  section: Section;
  isLibraryWorkspace: boolean;
  isCollectionHome: boolean;
  libraryTitle: string;
  activeSpace: Space | undefined;
  currentSource: Source | undefined;
  currentNote: Note | undefined;
  /** Import and AI-organization work still running, shown as a task badge. */
  activeTaskCount: number;
  setSidebar: (open: boolean) => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  openCollectionHome: () => void;
  openAllSourcesSearch: () => void;
  navigate: (section: "tasks") => void;
  openAccountSettings: () => void;
};

export default function WorkspaceTopbar({
  user,
  status,
  cloudConfigured,
  cloudReadOnly,
  saveLabel,
  section,
  isLibraryWorkspace,
  isCollectionHome,
  libraryTitle,
  activeSpace,
  currentSource,
  currentNote,
  activeTaskCount,
  setSidebar,
  sidebarCollapsed,
  onToggleSidebar,
  openCollectionHome,
  openAllSourcesSearch,
  navigate,
  openAccountSettings,
}: WorkspaceTopbarProps) {
  return (
    <header className="topbar">
      <button
        className="icon-btn mobile-menu"
        aria-label="打开导航"
        onClick={() => setSidebar(true)}
      >
        <Menu size={19} />
      </button>
      <button
        type="button"
        className="icon-btn sidebar-toggle"
        aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
        title={sidebarCollapsed ? "展开侧栏（Ctrl+\\）" : "收起侧栏（Ctrl+\\）"}
        aria-pressed={sidebarCollapsed}
        onClick={onToggleSidebar}
      >
        <PanelLeft size={18} />
      </button>
      {isLibraryWorkspace ? (
        <>
          {section === "library" && !isCollectionHome && (
            <button
              className="icon-btn library-back"
              aria-label="返回全部知识库"
              title="返回全部知识库"
              onClick={openCollectionHome}
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <h1
            className="collection-home-title"
            title={section === "library" ? libraryTitle : labels[section]}
          >
            {section === "library" ? libraryTitle : labels[section]}
          </h1>
        </>
      ) : (
        <div className="breadcrumbs">
          <span>{activeSpace?.name || "我的知识库"}</span>
          <ChevronRight size={13} />
          <b>{currentSource?.title || currentNote?.title || labels[section]}</b>
        </div>
      )}
      <div className="topbar-end">
        <button
          className="topbar-search-trigger"
          onClick={openAllSourcesSearch}
          aria-label={activeSpace ? `搜索当前空间：${activeSpace.name}` : "搜索资料"}
          title={activeSpace ? `搜索当前空间：${activeSpace.name}` : "搜索资料"}
        >
          <Search size={16} />
          <span>{activeSpace ? "搜索当前空间" : "搜索资料"}</span>
          <kbd>Ctrl K</kbd>
        </button>
        <span className={`save-status save-${cloudReadOnly ? "readonly" : status}`} role="status">
          {status === "saving" || status === "loading" ? (
            <Loader2 size={14} className="spin" />
          ) : status === "cloud" || cloudReadOnly ? (
            <Cloud size={14} />
          ) : status === "local" ? (
            <Check size={14} />
          ) : (
            <History size={14} />
          )}
          <span>{saveLabel}</span>
        </span>
        <button
          type="button"
          className={`topbar-tasks${activeTaskCount ? " has-pending" : ""}`}
          onClick={() => navigate("tasks")}
          aria-label={activeTaskCount ? `任务中心，${activeTaskCount} 项正在进行` : "任务中心"}
          title="任务中心"
        >
          <ListChecks size={16} />
          {activeTaskCount > 0 && <span className="topbar-task-count">{activeTaskCount}</span>}
        </button>
        <button
          className="topbar-account"
          onClick={openAccountSettings}
          aria-current={
            section === "settings" && !currentSource && !currentNote ? "page" : undefined
          }
          aria-label={user && cloudConfigured ? `账号与设置：${user.email}` : "账号与设置"}
          title="账号与设置"
        >
          <span className="topbar-avatar">{user?.email.slice(0, 1).toUpperCase() || "C"}</span>
          <span className="topbar-account-label">
            {user && cloudConfigured ? user.email : cloudConfigured ? "登录" : "本机"}
          </span>
        </button>
      </div>
    </header>
  );
}
