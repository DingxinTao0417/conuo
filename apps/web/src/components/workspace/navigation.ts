import { BookOpen, LayoutGrid, Library, Sparkles, StickyNote } from "lucide-react";

/** Top-level workspace views. Everything else (reader, note page, modals) layers on top. */
export type Section =
  | "home"
  | "library"
  | "notes"
  | "knowledge"
  | "organize"
  | "questions"
  | "tasks"
  | "trash"
  | "settings";

/** Tabs shown inside a learning space, in display order. */
export const spaceTabs = [
  ["home", "概览"],
  ["library", "资料"],
  ["knowledge", "知识"],
  ["questions", "问答"],
] as const;
export type SpaceTab = (typeof spaceTabs)[number][0];

/**
 * Primary sidebar navigation entries, in display order.
 *
 * `organize` and `tasks` are deliberately absent: AI organization is reached
 * from the knowledge library's "从资料生成" flow and from the task center, and
 * the task center itself is a topbar action with a pending-work badge. Both
 * still resolve as `#organize` / `#tasks` routes, so existing links keep working.
 */
export const sections = [
  ["home", "学习概览", LayoutGrid],
  ["library", "资料库", Library],
  ["questions", "我的问答", Sparkles],
  ["notes", "我的笔记", StickyNote],
  ["knowledge", "知识页", BookOpen],
] as const;

/**
 * Settings groups, reached from the sidebar account or topbar avatar, in
 * display order following the product requirement's
 * settings outline (account and devices, AI and source processing, cloud data
 * and storage, reading and sync). Each one is a `#settings/<pane>` route so a
 * reload or a shared link reopens the same group.
 *
 * Learning-space management is still listed here; it moves to the space
 * overview once that page exists.
 */
export const settingsPanes = [
  ["account", "账号与设备"],
  ["ai", "AI 与资料处理"],
  ["storage", "云端资料与存储"],
  ["reading", "阅读与同步"],
  ["spaces", "学习空间"],
] as const;
export type SettingsPane = (typeof settingsPanes)[number][0];

export function isSettingsPane(value: string | undefined): value is SettingsPane {
  return settingsPanes.some(([pane]) => pane === value);
}

export const labels: Record<Section, string> = {
  home: "学习概览",
  library: "资料库",
  notes: "我的笔记",
  knowledge: "知识页",
  organize: "AI 整理",
  questions: "我的问答",
  tasks: "任务中心",
  trash: "回收站",
  settings: "账号与设置",
};
