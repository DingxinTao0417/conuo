import { BookOpen, History, LayoutGrid, Library, Sparkles, StickyNote, Tag } from "lucide-react";

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

/** Primary sidebar navigation entries, in display order. */
export const sections = [
  ["home", "学习概览", LayoutGrid],
  ["library", "资料库", Library],
  ["questions", "我的问答", Sparkles],
  ["notes", "我的笔记", StickyNote],
  ["knowledge", "知识页", BookOpen],
  ["organize", "AI 整理", Tag],
  ["tasks", "任务中心", History],
] as const;

export const labels: Record<Section, string> = {
  home: "学习概览",
  library: "资料库",
  notes: "我的笔记",
  knowledge: "知识页",
  organize: "AI 整理",
  questions: "我的问答",
  tasks: "任务中心",
  trash: "回收站",
  settings: "设置",
};
