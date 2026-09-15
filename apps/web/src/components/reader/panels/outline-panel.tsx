"use client";
import { X } from "lucide-react";
import type { ReaderOutlineItem } from "../../reader-outline";

export type OutlinePanelProps = {
  outlineItems: ReaderOutlineItem[];
  closeOutline: () => void;
  jumpToOutlineItem: (item: ReaderOutlineItem) => void;
};

export default function OutlinePanel({
  outlineItems,
  closeOutline,
  jumpToOutlineItem,
}: OutlinePanelProps) {
  return (
    <nav className="reader-outline" id="reader-outline-panel" aria-label="资料目录">
      <header className="reader-outline-header">
        <div>
          <strong>目录</strong>
          <span>{outlineItems.length} 个已解析章节</span>
        </div>
        <button type="button" className="icon-btn" aria-label="关闭资料目录" onClick={closeOutline}>
          <X size={15} />
        </button>
      </header>
      <div className="reader-outline-list">
        {outlineItems.map((item) => (
          <button
            type="button"
            className={`reader-outline-item reader-outline-level-${item.level}`}
            data-reader-outline-item={item.id}
            key={item.id}
            title={item.title}
            aria-label={`跳转到章节：${item.title}`}
            onClick={() => jumpToOutlineItem(item)}
          >
            {item.title}
          </button>
        ))}
      </div>
    </nav>
  );
}
