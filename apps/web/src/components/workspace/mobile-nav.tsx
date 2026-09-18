"use client";
import { BookOpen, LayoutGrid, Library, Sparkles } from "lucide-react";
import type { Section } from "./navigation";

const items = [
  ["home", "首页", LayoutGrid],
  ["library", "资料", Library],
  ["knowledge", "知识", BookOpen],
  ["questions", "问答", Sparkles],
] as const;

export type WorkspaceMobileNavProps = {
  section: Section;
  spaceId?: string;
  navigate: (section: Section) => void;
  openCollectionHome: () => void;
};

/**
 * Phone-only bottom navigation. It carries the four content areas the product
 * requirement names for phones; the reader hides it so its own reading and
 * ask-AI tabs stay the only bottom controls.
 *
 * `notes` shares the knowledge slot: both list saved writing rather than
 * imported sources, and phones have no room for a fifth destination.
 */
export default function WorkspaceMobileNav({
  section,
  spaceId = "all",
  navigate,
  openCollectionHome,
}: WorkspaceMobileNavProps) {
  return (
    <nav className="workspace-mobile-nav" aria-label="主要内容导航">
      {items.map(([key, label, Icon]) => {
        const active =
          spaceId === "all" &&
          (key === "knowledge" ? section === "knowledge" || section === "notes" : section === key);
        return (
          <button
            key={key}
            type="button"
            className={active ? "active" : ""}
            aria-current={active ? "page" : undefined}
            onClick={() => (key === "library" ? openCollectionHome() : navigate(key))}
          >
            <Icon size={18} aria-hidden="true" />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
